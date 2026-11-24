import { makeHoodieAvatarDataUrl } from '../../ui/hoodieAvatar';
import type { RosterEntry } from '../types';
import type { CustomModelInput } from './customModel';

/**
 * User bots compiled in the browser. Metadata lives in localStorage (read synchronously at startup, so the
 * Cricket store / custom-match drafts can keep their bot ids); the compiled wasm and the uploaded source live
 * in IndexedDB (also readable from the per-seat bot workers).
 */
export interface CustomBotMeta {
  id: string; // 'custom-' + first 16 hex chars of the wasm hash
  name: string;
  color: string; // '#RRGGBB'
  enabled: boolean;
  hash: string; // SHA-256 of the compiled wasm (duplicate detection)
  createdAt: number;
  sourceName: string;
  sourceSize: number;
  wasmSize: number;
  /** Uploaded character model (voxel JSON, stored in IndexedDB by id); absent = dyed hoodie. */
  modelId?: string;
  modelName?: string;
  modelAvatar?: string;
}

export const CUSTOM_BOT_ID_PREFIX = 'custom-';
export const CUSTOM_CHAR_PREFIX = 'custom-';
export const CUSTOM_BOT_NAME_MAX = 16;
const META_KEY = 'boomerang_arena_custom_bots_v1';
const DB_NAME = 'boomerang_custom_bots';
const DB_STORE = 'bots';
const DB_MODELS = 'models';
const HAIR_COLOR = '#4A3328';

export const CUSTOM_BOT_COLORS = [
  '#E8483D', '#F2A332', '#F5D142', '#7BC94A', '#2FB37A', '#2EC4C9', '#3D9BFF', '#5B6CFF',
  '#9B5CF6', '#E055C8', '#FF7AA2', '#A0724E', '#8A97B0', '#F4F4F2', '#3A3F4F', '#C7F25C',
];

/** Bot names end up in HUD / history / lobby markup: keep them plain text. */
export function sanitizeBotName(name: string): string {
  return name
    .replace(/[<>"'&`\\\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, CUSTOM_BOT_NAME_MAX);
}

export function isCustomBotId(id: string | undefined | null): boolean {
  return !!id && id.startsWith(CUSTOM_BOT_ID_PREFIX);
}

export function normalizeHexColor(c: string): string | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  return m ? `#${m[1].toUpperCase()}` : null;
}

/**
 * Character model key for a custom bot: `custom-<rrggbb>` = the generic hoodie dyed in the bot's colour,
 * `custom-<rrggbb>-<modelId>` = an uploaded model (falls back to the dyed hoodie if that model is gone).
 * Self-describing, so replays keep the look without the bot.
 */
export function customCharKey(color: string, modelId?: string): string {
  const base = CUSTOM_CHAR_PREFIX + (normalizeHexColor(color) ?? '#8A97B0').slice(1).toLowerCase();
  return modelId ? `${base}-${modelId}` : base;
}

export function customCharColor(charKey: string): string | null {
  if (!charKey.startsWith(CUSTOM_CHAR_PREFIX)) return null;
  return normalizeHexColor(charKey.slice(CUSTOM_CHAR_PREFIX.length, CUSTOM_CHAR_PREFIX.length + 6));
}

export function customCharModelId(charKey: string): string | null {
  const m = /^custom-[0-9a-f]{6}-([0-9a-f]{16})$/.exec(charKey);
  return m ? m[1] : null;
}

export function customBotAvatar(color: string): string {
  return makeHoodieAvatarDataUrl(normalizeHexColor(color) ?? '#8A97B0', HAIR_COLOR);
}

export function customBotRosterEntry(m: CustomBotMeta): RosterEntry {
  return {
    id: m.id,
    seat: m.id,
    charKey: customCharKey(m.color, m.modelId),
    name: m.name,
    shortName: m.name,
    rank: null,
    rating: null,
    duelRating: null,
    ffaRating: null,
    category: 'custom',
    color: m.color,
    avatar: m.modelAvatar ?? customBotAvatar(m.color),
  };
}

// ---------------------------------------------------------------- IndexedDB (wasm + source)

interface StoredBlob {
  id: string;
  wasm: ArrayBuffer;
  source: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE, { keyPath: 'id' });
      if (!req.result.objectStoreNames.contains(DB_MODELS)) req.result.createObjectStore(DB_MODELS, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
  storeName: string = DB_STORE,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const req = fn(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error ?? req.error ?? new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  } finally {
    db.close();
  }
}

/** Compiled wasm of a custom bot (works in workers too). */
export async function loadCustomBotWasm(id: string): Promise<ArrayBuffer | null> {
  const rec = await withStore<StoredBlob | undefined>('readonly', (s) => s.get(id) as IDBRequest<StoredBlob | undefined>);
  return rec?.wasm ?? null;
}

interface StoredModel {
  id: string;
  json: string;
  name: string;
}

/** Uploaded model JSON by id (null if it was removed). */
export async function loadCustomModelJson(id: string): Promise<string | null> {
  const rec = await withStore<StoredModel | undefined>(
    'readonly',
    (s) => s.get(id) as IDBRequest<StoredModel | undefined>,
    DB_MODELS,
  );
  return rec?.json ?? null;
}

async function putModel(model: CustomModelInput) {
  await withStore('readwrite', (s) => s.put({ id: model.id, json: model.json, name: model.name } satisfies StoredModel), DB_MODELS);
}

// ---------------------------------------------------------------- metadata store

export class CustomBotStore {
  private bots: CustomBotMeta[];
  private listeners = new Set<() => void>();

  constructor() {
    this.bots = this.load();
  }

  private load(): CustomBotMeta[] {
    try {
      const raw = localStorage.getItem(META_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw) as unknown;
      if (!Array.isArray(arr)) return [];
      const out: CustomBotMeta[] = [];
      const seen = new Set<string>();
      for (const it of arr as Partial<CustomBotMeta>[]) {
        if (!it || typeof it.id !== 'string' || !isCustomBotId(it.id) || seen.has(it.id)) continue;
        const color = normalizeHexColor(String(it.color ?? '')) ?? '#8A97B0';
        seen.add(it.id);
        out.push({
          id: it.id,
          name: sanitizeBotName(String(it.name ?? '')) || '自定义 Bot',
          color,
          enabled: it.enabled !== false,
          hash: String(it.hash ?? ''),
          createdAt: Number(it.createdAt) || 0,
          sourceName: String(it.sourceName ?? 'player.cpp'),
          sourceSize: Number(it.sourceSize) || 0,
          wasmSize: Number(it.wasmSize) || 0,
          ...(typeof it.modelId === 'string' && /^[0-9a-f]{16}$/.test(it.modelId)
            ? {
                modelId: it.modelId,
                modelName: String(it.modelName ?? 'model.json'),
                modelAvatar:
                  typeof it.modelAvatar === 'string' && it.modelAvatar.startsWith('data:image/svg+xml')
                    ? it.modelAvatar
                    : undefined,
              }
            : {}),
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  private save() {
    try {
      localStorage.setItem(META_KEY, JSON.stringify(this.bots));
    } catch {
      // quota: metadata is tiny, ignore
    }
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  public onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  public list(): CustomBotMeta[] {
    return this.bots.slice();
  }

  public listEnabled(): CustomBotMeta[] {
    return this.bots.filter((b) => b.enabled);
  }

  public get(id: string): CustomBotMeta | undefined {
    return this.bots.find((b) => b.id === id);
  }

  public findByHash(hash: string): CustomBotMeta | undefined {
    return this.bots.find((b) => b.hash === hash);
  }

  public async add(input: {
    name: string;
    color: string;
    sourceName: string;
    source: string;
    wasm: ArrayBuffer;
    hash: string;
    model?: CustomModelInput | null;
  }): Promise<CustomBotMeta> {
    const dup = this.findByHash(input.hash);
    if (dup) throw new DuplicateBotError(dup);
    const meta: CustomBotMeta = {
      id: CUSTOM_BOT_ID_PREFIX + input.hash.slice(0, 16),
      name: sanitizeBotName(input.name) || '自定义 Bot',
      color: normalizeHexColor(input.color) ?? '#8A97B0',
      enabled: true,
      hash: input.hash,
      createdAt: Date.now(),
      sourceName: input.sourceName,
      sourceSize: input.source.length,
      wasmSize: input.wasm.byteLength,
    };
    if (input.model) {
      await putModel(input.model);
      meta.modelId = input.model.id;
      meta.modelName = input.model.name;
      meta.modelAvatar = input.model.avatar;
    }
    await withStore('readwrite', (s) => s.put({ id: meta.id, wasm: input.wasm, source: input.source } satisfies StoredBlob));
    this.bots.push(meta);
    this.save();
    this.emit();
    return meta;
  }

  /** `model`: undefined = keep, null = back to the dyed hoodie, object = replace with an uploaded model. */
  public async update(
    id: string,
    patch: Partial<Pick<CustomBotMeta, 'name' | 'color' | 'enabled'>> & { model?: CustomModelInput | null },
  ) {
    const b = this.get(id);
    if (!b) return;
    const oldModel = b.modelId;
    if (patch.model) await putModel(patch.model);
    if (patch.name !== undefined) b.name = sanitizeBotName(patch.name) || b.name;
    if (patch.color !== undefined) b.color = normalizeHexColor(patch.color) ?? b.color;
    if (patch.enabled !== undefined) b.enabled = patch.enabled;
    if (patch.model === null) {
      delete b.modelId;
      delete b.modelName;
      delete b.modelAvatar;
    } else if (patch.model) {
      b.modelId = patch.model.id;
      b.modelName = patch.model.name;
      b.modelAvatar = patch.model.avatar;
    }
    this.save();
    this.emit();
    if (oldModel && oldModel !== b.modelId) await this.dropModelIfUnused(oldModel);
  }

  /** Models are shared by id: delete one only once no bot uses it (old replays then show the dyed hoodie). */
  private async dropModelIfUnused(modelId: string) {
    if (this.bots.some((x) => x.modelId === modelId)) return;
    try {
      await withStore('readwrite', (s) => s.delete(modelId), DB_MODELS);
    } catch {
      // harmless leftover
    }
  }

  public async remove(id: string) {
    const idx = this.bots.findIndex((b) => b.id === id);
    if (idx < 0) return;
    const [gone] = this.bots.splice(idx, 1);
    this.save();
    this.emit();
    try {
      await withStore('readwrite', (s) => s.delete(id));
    } catch {
      // metadata is already gone; an orphaned blob is harmless
    }
    if (gone.modelId) await this.dropModelIfUnused(gone.modelId);
  }
}

export class DuplicateBotError extends Error {
  public readonly existing: CustomBotMeta;
  constructor(existing: CustomBotMeta) {
    super(`编译结果与已有的「${existing.name}」完全相同`);
    this.existing = existing;
  }
}
