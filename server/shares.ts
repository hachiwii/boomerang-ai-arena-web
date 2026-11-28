// Shared match replays (分享对局): the page uploads one match as text (base64url of a gzip'd JSON document, see
// src/game/replayShare.ts) and gets a short id back; the share link opens it again. One file per share,
// `<shares dir>/<id>.txt`, where the id is derived from the content (sharing the same match twice gives the same link).
// Retention: a share not uploaded or viewed for the TTL is deleted, and when the directory grows past its byte cap the
// least recently used shares go first. Nothing about the uploader (IP, User-Agent) is stored.
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';

// Keep in step with src/game/replayShare.ts (scripts/test_replay_share.mjs checks).
export const SHARE_FORMAT_VERSION = 1;
export const SHARE_MAX_TEXT_BYTES = 1024 * 1024;
export const SHARE_MAX_JSON_BYTES = 4 * 1024 * 1024;
export const SHARE_ID_RE = /^[0-9a-z]{10}$/;

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const FILE_RE = /^([0-9a-z]{10})\.txt$/;
const TOUCH_EVERY_MS = 24 * 3_600_000; // a view refreshes the share's age at most once a day
const gunzipAsync = promisify(gunzip);
/** Disk space a file of `bytes` takes (4 KiB blocks), so the byte cap matches real usage for these small files. */
export const shareDiskBytes = (bytes: number) => Math.max(1, Math.ceil(bytes / 4096)) * 4096;

export type ShareRejectReason = 'empty' | 'too-large' | 'bad-encoding' | 'bad-gzip' | 'bad-json' | 'bad-doc';

export function shareIdFor(text: string): string {
  const digest = createHash('sha256').update(text).digest();
  let id = '';
  for (let i = 0; id.length < 10; i++) id += ID_ALPHABET[digest[i] % ID_ALPHABET.length];
  return id;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Checks that an upload is a share document (not arbitrary data): base64url → gzip (bounded output) → JSON with the
 * v1 shape. The page re-validates and sanitizes everything when it opens a share; this only keeps the store honest.
 */
export async function validateShareText(text: string): Promise<ShareRejectReason | null> {
  if (!text) return 'empty';
  if (text.length > SHARE_MAX_TEXT_BYTES) return 'too-large';
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return 'bad-encoding';
  let raw: Buffer;
  try {
    raw = await gunzipAsync(Buffer.from(text, 'base64url'), { maxOutputLength: SHARE_MAX_JSON_BYTES });
  } catch {
    return 'bad-gzip';
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw.toString('utf8'));
  } catch {
    return 'bad-json';
  }
  if (
    !isRecord(doc) || doc.v !== SHARE_FORMAT_VERSION ||
    typeof doc.n !== 'number' || !Number.isInteger(doc.n) || doc.n < 1 || doc.n > 20_000 ||
    !isRecord(doc.s) || !Array.isArray(doc.s.slots) || doc.s.slots.length < 1 || doc.s.slots.length > 16 ||
    !isRecord(doc.m) || !(Array.isArray(doc.c) || Array.isArray(doc.r))
  ) return 'bad-doc';
  return null;
}

interface Entry {
  size: number; // disk bytes (4 KiB blocks)
  usedAt: number; // last upload of this content or view (exact, in memory)
  diskAt: number; // the file's mtime: usedAt as of the last write, refreshed at most daily (survives restarts)
}

export interface ShareStoreOptions {
  maxBytes: number;
  ttlMs: number;
}

/**
 * LRU bookkeeping: `entries` is a Map kept in least-recently-used-first order (JavaScript Maps iterate in insertion
 * order; a use deletes and re-inserts the id, O(1)). Expiry and eviction walk it from the front and stop at the
 * first share to keep, so they cost O(removed), never a full scan or sort. The order is rebuilt from file mtimes at
 * start (one sort). Views reach the relay only when the CDN has no copy (it keeps one for a day), which is fine for
 * an age measured in days.
 */
export class ShareStore {
  readonly dir: string;
  private readonly opts: ShareStoreOptions;
  private readonly entries = new Map<string, Entry>();
  private total = 0;
  private readonly ready: Promise<void>;

  constructor(dir: string, opts: ShareStoreOptions) {
    this.dir = dir;
    this.opts = opts;
    this.ready = this.load();
  }

  private file(id: string) {
    return join(this.dir, `${id}.txt`);
  }

  private async load() {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return; // not created yet: the first upload creates it
    }
    const found: [string, Entry][] = [];
    // stat in batches: a full store is ~100 000 files
    for (let i = 0; i < names.length; i += 64) {
      await Promise.all(names.slice(i, i + 64).map(async (name) => {
        const file = join(this.dir, name);
        if (name.endsWith('.tmp')) {
          await unlink(file).catch(() => undefined); // left by a crash mid-write
          return;
        }
        const m = FILE_RE.exec(name);
        if (!m) return;
        try {
          const st = await stat(file);
          found.push([m[1], { size: shareDiskBytes(st.size), usedAt: st.mtimeMs, diskAt: st.mtimeMs }]);
        } catch {
          // Raced with a delete.
        }
      }));
    }
    found.sort((a, b) => a[1].usedAt - b[1].usedAt);
    for (const [id, entry] of found) {
      this.entries.set(id, entry);
      this.total += entry.size;
    }
  }

  async usage(): Promise<{ count: number; bytes: number }> {
    await this.ready;
    return { count: this.entries.size, bytes: this.total };
  }

  private async remove(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.total -= entry.size;
    await unlink(this.file(id)).catch(() => undefined);
  }

  /** Stores a validated share text; the same text always gets the same id. */
  async put(text: string, now = Date.now()): Promise<{ id: string; created: boolean }> {
    await this.ready;
    const id = shareIdFor(text);
    if (this.entries.has(id)) {
      const current = await readFile(this.file(id), 'utf8').catch(() => null);
      if (current === text) {
        await this.touch(id, now, true);
        return { id, created: false };
      }
      if (current !== null) throw new Error('share id collision');
      await this.remove(id); // the file vanished: forget it and write it again
    }
    const size = shareDiskBytes(Buffer.byteLength(text));
    await this.makeRoom(size, now);
    await mkdir(this.dir, { recursive: true });
    const tmp = join(this.dir, `${id}.${randomBytes(6).toString('hex')}.tmp`);
    await writeFile(tmp, text);
    await rename(tmp, this.file(id));
    const prev = this.entries.get(id); // the same text uploaded twice at once
    this.entries.delete(id);
    this.entries.set(id, { size, usedAt: now, diskAt: now });
    this.total += size - (prev?.size ?? 0);
    return { id, created: true };
  }

  /** The share text, or null when the id is unknown (never existed, expired or evicted). */
  async get(id: string, now = Date.now()): Promise<string | null> {
    await this.ready;
    if (!SHARE_ID_RE.test(id) || !this.entries.has(id)) return null;
    let text: string;
    try {
      text = await readFile(this.file(id), 'utf8');
    } catch {
      await this.remove(id);
      return null;
    }
    void this.touch(id, now, false);
    return text;
  }

  /** Marks a use: to the back of the LRU order now; the file's mtime at most once a day (or always when `force`). */
  private async touch(id: string, now: number, force: boolean) {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.usedAt = Math.max(entry.usedAt, now);
    this.entries.delete(id);
    this.entries.set(id, entry);
    if (!force && now - entry.diskAt < TOUCH_EVERY_MS) return;
    entry.diskAt = now;
    const t = new Date(now);
    await utimes(this.file(id), t, t).catch(() => undefined);
  }

  /**
   * Drops shares unused for the TTL, and when the store (plus `incoming` bytes) is over its cap the least recently
   * used ones down to 90% of it (so a full store doesn't evict on every upload). Walks from the oldest and stops at
   * the first share to keep.
   */
  async prune(now = Date.now(), incoming = 0): Promise<number> {
    await this.ready;
    const cutoff = now - this.opts.ttlMs;
    const evictTo = this.total + incoming > this.opts.maxBytes ? this.opts.maxBytes * 0.9 - incoming : Infinity;
    const victims: [string, number][] = [];
    let total = this.total;
    for (const [id, entry] of this.entries) {
      if (entry.usedAt >= cutoff && total <= evictTo) break;
      victims.push([id, entry.usedAt]);
      total -= entry.size;
    }
    let removed = 0;
    for (const [id, usedAt] of victims) {
      if (this.entries.get(id)?.usedAt !== usedAt) continue; // used again meanwhile
      await this.remove(id);
      removed++;
    }
    return removed;
  }

  private async makeRoom(size: number, now: number) {
    if (size > this.opts.maxBytes) throw new Error('share larger than the store');
    if (this.total + size > this.opts.maxBytes) await this.prune(now, size);
  }
}
