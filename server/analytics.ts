// Site analytics kept by the relay: online visitors, daily unique visitors (UV), visitors per game mode and match
// counts per mode. Pages send a heartbeat every minute and an event when a match starts / ends (src/net/analytics.ts).
// Visitors are identified only by a random id their browser generated (localStorage) — never by IP.
// State for the current day (UTC+8) is snapshotted to <dir>/YYYY-MM-DD.json every minute and reloaded on start.
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const ONLINE_WINDOW_MS = 150_000; // a visitor counts as online for 2.5 min after its last heartbeat
export const MODES = ['ranked-solo', 'ranked-ffa', 'cricket', 'cricket-batch', 'custom', 'training', 'pvp', 'replay'] as const;
export type Mode = (typeof MODES)[number];
const MODE_SET = new Set<string>(MODES);
export const isMode = (v: unknown): v is Mode => typeof v === 'string' && MODE_SET.has(v);
export const isVisitorId = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{16,64}$/.test(v);

/** UTC+8 calendar day of a timestamp. */
export const dayOf = (ms: number) => new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10);
const minuteOf = (ms: number) => new Date(ms + 8 * 3_600_000).toISOString().slice(11, 16);

export interface ModeCounts {
  visitors: number; // unique visitors who started at least one match in this mode
  started: number;
  finished: number;
}

export interface DaySnapshot {
  v: 1;
  day: string; // YYYY-MM-DD, UTC+8
  updatedAt: string;
  uv: number;
  peakOnline: number;
  peakAt: string | null; // HH:MM, UTC+8
  online: Record<string, number>; // HH:MM → online visitors sampled that minute
  modes: Record<string, ModeCounts>;
  // Random browser ids seen today (so a restart keeps UV / per-mode visitors exact); dropped from reports
  ids: string[];
  modeIds: Record<string, string[]>;
}

interface Day {
  day: string;
  ids: Set<string>;
  modeIds: Map<string, Set<string>>;
  started: Map<string, number>;
  finished: Map<string, number>;
  online: Map<string, number>;
  peakOnline: number;
  peakAt: string | null;
}

const newDay = (day: string): Day => ({
  day, ids: new Set(), modeIds: new Map(), started: new Map(), finished: new Map(), online: new Map(),
  peakOnline: 0, peakAt: null,
});

export class SiteAnalytics {
  private readonly lastSeen = new Map<string, number>();
  private today: Day;
  private dirty = false;
  private writing: Promise<void> = Promise.resolve();
  readonly dir: string | null;
  readonly keepDays: number;

  constructor(dir: string | null, keepDays = 90, now = Date.now()) {
    this.dir = dir;
    this.keepDays = keepDays;
    this.today = newDay(dayOf(now));
  }

  /** Restore today's state after a restart. */
  async load(now = Date.now()): Promise<void> {
    if (!this.dir) return;
    try {
      const snap = JSON.parse(await readFile(join(this.dir, `${dayOf(now)}.json`), 'utf8')) as DaySnapshot;
      if (snap.v !== 1 || snap.day !== dayOf(now)) return;
      const d = newDay(snap.day);
      for (const id of snap.ids ?? []) if (isVisitorId(id)) d.ids.add(id);
      for (const [mode, ids] of Object.entries(snap.modeIds ?? {})) d.modeIds.set(mode, new Set(ids.filter(isVisitorId)));
      for (const [mode, c] of Object.entries(snap.modes ?? {})) {
        d.started.set(mode, c.started | 0);
        d.finished.set(mode, c.finished | 0);
      }
      for (const [minute, n] of Object.entries(snap.online ?? {})) d.online.set(minute, n | 0);
      d.peakOnline = snap.peakOnline | 0;
      d.peakAt = snap.peakAt ?? null;
      this.today = d;
    } catch {
      // No file for today yet, or unreadable: start empty.
    }
  }

  private roll(now: number) {
    const day = dayOf(now);
    if (day === this.today.day) return;
    void this.flush(now); // persist the finished day before starting a new one
    this.today = newDay(day);
  }

  private see(id: string, now: number) {
    this.roll(now);
    this.lastSeen.set(id, now);
    this.today.ids.add(id);
    this.dirty = true;
  }

  heartbeat(id: string, now = Date.now()) {
    this.see(id, now);
  }

  /** A visitor left (page hidden / closed): stop counting it as online right away. */
  leave(id: string) {
    this.lastSeen.delete(id);
  }

  /** A visitor started a match. PvP starts only mark the visitor (the relay counts each PvP match once). */
  matchStarted(id: string, mode: Mode, now = Date.now()) {
    this.see(id, now);
    const t = this.today;
    if (!t.modeIds.has(mode)) t.modeIds.set(mode, new Set());
    t.modeIds.get(mode)!.add(id);
    if (mode !== 'pvp') t.started.set(mode, (t.started.get(mode) ?? 0) + 1);
  }

  /** Called by the relay when a PvP match reaches GO. */
  pvpMatchStarted(now = Date.now()) {
    this.roll(now);
    const t = this.today;
    t.started.set('pvp', (t.started.get('pvp') ?? 0) + 1);
    this.dirty = true;
  }

  /** Finished single-player matches (PvP finishes are counted once by the relay itself, not per client). */
  matchFinished(id: string, mode: Mode, now = Date.now()) {
    this.see(id, now);
    const t = this.today;
    t.finished.set(mode, (t.finished.get(mode) ?? 0) + 1);
  }

  /** Called by the relay when a PvP match ends past GO. */
  pvpMatchFinished(now = Date.now()) {
    this.roll(now);
    const t = this.today;
    t.finished.set('pvp', (t.finished.get('pvp') ?? 0) + 1);
    this.dirty = true;
  }

  onlineCount(now = Date.now()): number {
    let n = 0;
    for (const [id, at] of this.lastSeen) {
      if (now - at <= ONLINE_WINDOW_MS) n++;
      else this.lastSeen.delete(id);
    }
    return n;
  }

  /** Once a minute: sample the online count (peak tracking) and persist today's snapshot. */
  async tick(now = Date.now()): Promise<void> {
    this.roll(now);
    const online = this.onlineCount(now);
    const t = this.today;
    const minute = minuteOf(now);
    t.online.set(minute, Math.max(online, t.online.get(minute) ?? 0));
    if (online > t.peakOnline) {
      t.peakOnline = online;
      t.peakAt = minute;
    }
    this.dirty = true;
    await this.flush(now);
  }

  snapshot(now = Date.now()): DaySnapshot {
    const t = this.today;
    const modes: Record<string, ModeCounts> = {};
    for (const mode of new Set([...t.modeIds.keys(), ...t.started.keys(), ...t.finished.keys()])) {
      modes[mode] = { visitors: t.modeIds.get(mode)?.size ?? 0, started: t.started.get(mode) ?? 0, finished: t.finished.get(mode) ?? 0 };
    }
    const modeIds: Record<string, string[]> = {};
    for (const [mode, ids] of t.modeIds) modeIds[mode] = [...ids];
    return {
      v: 1, day: t.day, updatedAt: new Date(now).toISOString(), uv: t.ids.size, peakOnline: t.peakOnline, peakAt: t.peakAt,
      online: Object.fromEntries([...t.online].sort()), modes, ids: [...t.ids], modeIds,
    };
  }

  async flush(now = Date.now()): Promise<void> {
    if (!this.dir || !this.dirty) return;
    this.dirty = false;
    const snap = this.snapshot(now);
    const dir = this.dir;
    this.writing = this.writing.then(async () => {
      try {
        await mkdir(dir, { recursive: true });
        const file = join(dir, `${snap.day}.json`);
        await writeFile(`${file}.tmp`, JSON.stringify(snap));
        await rename(`${file}.tmp`, file);
      } catch (err) {
        console.log(JSON.stringify({ time: new Date().toISOString(), event: 'analytics-write-failed', error: String(err) }));
      }
    });
    return this.writing;
  }

  async prune(now = Date.now()): Promise<void> {
    if (!this.dir) return;
    try {
      const cutoff = dayOf(now - this.keepDays * 86_400_000);
      for (const name of await readdir(this.dir)) {
        if (/^\d{4}-\d{2}-\d{2}\.json$/.test(name) && name.slice(0, 10) < cutoff) await unlink(join(this.dir, name));
      }
    } catch {
      // Nothing to prune.
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Reading (report / loopback /stats)

export type DaySummary = Omit<DaySnapshot, 'ids' | 'modeIds' | 'online'> & { onlineNow?: number; lastMinute?: string };

export async function readDays(dir: string, days: number, now = Date.now()): Promise<DaySummary[]> {
  const since = dayOf(now - (Math.max(1, days) - 1) * 86_400_000);
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n) && n.slice(0, 10) >= since).sort();
  } catch {
    return [];
  }
  const out: DaySummary[] = [];
  for (const name of names) {
    try {
      const { ids: _ids, modeIds: _modeIds, online, ...rest } = JSON.parse(await readFile(join(dir, name), 'utf8')) as DaySnapshot;
      const minutes = Object.keys(online ?? {}).sort();
      const lastMinute = minutes.at(-1);
      out.push({ ...rest, ...(lastMinute ? { lastMinute, onlineNow: online[lastMinute] } : {}) });
    } catch {
      // Skip a torn file.
    }
  }
  return out;
}

const MODE_LABEL: Record<string, string> = {
  'ranked-solo': '排位 SOLO', 'ranked-ffa': '排位 四人', cricket: '斗蛐蛐', 'cricket-batch': '斗蛐蛐 批量', custom: '自定义',
  training: '训练场', pvp: 'PvP', replay: '回放',
};

export function formatVisitors(days: DaySummary[]): string {
  if (!days.length) return 'visitors: no data yet';
  const out: string[] = [];
  const last = days.at(-1)!;
  out.push(`visitors (UTC+8) · online now ${last.onlineNow ?? 0} (as of ${last.day} ${last.lastMinute ?? '-'})`);
  out.push(`  ${'day'.padEnd(10)} ${'UV'.padStart(6)} ${'peak online'.padStart(12)}`);
  for (const d of days) out.push(`  ${d.day} ${String(d.uv).padStart(6)} ${`${d.peakOnline} @${d.peakAt ?? '-'}`.padStart(12)}`);
  out.push('');
  out.push(`modes, last ${days.length} day(s): visitors per day summed / matches started / finished`);
  const totals = new Map<string, ModeCounts>();
  for (const d of days) {
    for (const [mode, c] of Object.entries(d.modes)) {
      const t = totals.get(mode) ?? { visitors: 0, started: 0, finished: 0 };
      t.visitors += c.visitors;
      t.started += c.started;
      t.finished += c.finished;
      totals.set(mode, t);
    }
  }
  for (const mode of [...MODES, ...[...totals.keys()].filter((m) => !MODE_SET.has(m))]) {
    const t = totals.get(mode);
    if (!t) continue;
    out.push(`  ${(MODE_LABEL[mode] ?? mode).padEnd(12)} ${String(t.visitors).padStart(6)} visitors ${String(t.started).padStart(6)} started ${String(t.finished).padStart(6)} finished`);
  }
  if (days.length > 1) {
    out.push('');
    out.push(`  per day: ${days.map((d) => `${d.day.slice(5)} ${Object.entries(d.modes).map(([m, c]) => `${MODE_LABEL[m] ?? m} ${c.visitors}人/${c.finished || c.started}局`).join(' · ')}`).join('\n           ')}`);
  }
  return out.join('\n');
}
