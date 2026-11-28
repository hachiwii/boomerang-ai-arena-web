// Site analytics kept by the relay: online visitors, daily unique visitors (UV), visitors per game mode, match counts
// per mode, and each ranked bot's wins / draws / losses, kills and deaths by cause. Pages send a heartbeat every
// minute and an event when a match starts / ends (src/net/analytics.ts; bot results: src/game/botResults.ts).
// Visitors are identified only by a random id their browser generated (localStorage) — never by IP.
// State for the current day (UTC+8) is snapshotted to <dir>/YYYY-MM-DD.json every minute and reloaded on start.
// Days older than keepDays are compacted (visitor ids and per-minute / per-hour samples dropped), never deleted, so
// the all-time totals on the public stats panel (publicStats → GET /public-stats) never go down. The all-time player
// count (browsers that started at least one match, replays aside) keeps its own id list in <dir>/players.json.
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import roster from '../public/assets/chars/roster.json' with { type: 'json' };

export const ONLINE_WINDOW_MS = 150_000; // a visitor counts as online for 2.5 min after its last heartbeat
export const MODES = ['ranked-solo', 'ranked-ffa', 'cricket', 'cricket-batch', 'custom', 'training', 'pvp', 'replay'] as const;
export type Mode = (typeof MODES)[number];
const MODE_SET = new Set<string>(MODES);
export const isMode = (v: unknown): v is Mode => typeof v === 'string' && MODE_SET.has(v);
export const isVisitorId = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{16,64}$/.test(v);

// Ranked bot results. Deaths: melee, dart, kicked into a pit, fell off on its own (walk / dash), ground collapsed.
// Kills are the deaths that have a killer: melee, dart, kick.
export const DEATH_CAUSES = ['melee', 'dart', 'kick', 'fall', 'collapse'] as const;
export type DeathCause = (typeof DEATH_CAUSES)[number];
export const KILL_CAUSES = ['melee', 'dart', 'kick'] as const;
export type KillCause = (typeof KILL_CAUSES)[number];
const DEATH_SET = new Set<string>(DEATH_CAUSES);
const KILL_SET = new Set<string>(KILL_CAUSES);
/** One bot in one match: result, final place, players it knocked out by cause, how it went out (if it did). */
export interface BotResult {
  b: string;
  r: 'w' | 'd' | 'l';
  rank?: number; // final place (1 = first; ties share the best place)
  kills?: Partial<Record<KillCause, number>>;
  death?: DeathCause;
}
export interface BotTally {
  w: number; d: number; l: number;
  rankSum: number; // sum of final places over the `ranked` results that carried one (average place = rankSum / ranked)
  ranked: number;
  kills: Partial<Record<KillCause, number>>;
  deaths: Partial<Record<DeathCause, number>>;
}

/** Result id of the human player in a ranked match (all human players are summed under it). */
export const HUMAN_ID = 'human';
/**
 * Ranked matches only ever pick official bots (src/game/leaderboard.ts pickRankedOpponents), so results are kept only
 * for those and the human: any other id comes from a modified client or a hand-made request. Read from the roster
 * when the relay is built, so a new official bot is counted once the relay is redeployed.
 */
const RANKED_BOT_IDS = new Set((roster as { id: string; category: string }[]).filter((r) => r.category === 'official').map((r) => r.id));
const isResultId = (b: string) => b === HUMAN_ID || RANKED_BOT_IDS.has(b);

/**
 * Validate a client's results for a finished ranked match: its bots plus, under `human`, the human player (pages from
 * before that only send the bots). null if malformed or naming a bot ranked never picks (the finish still counts).
 */
export function parseBotResults(mode: Mode, raw: unknown): BotResult[] | null {
  if (!Array.isArray(raw)) return null;
  const opponents = mode === 'ranked-solo' ? 1 : mode === 'ranked-ffa' ? 3 : 0; // also the most bots in the match
  if (raw.length < 1 || raw.length > opponents + 1) return null;
  const out: BotResult[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const { b, r, rank, kills, death } = item as Record<string, unknown>;
    if (typeof b !== 'string' || !isResultId(b) || (r !== 'w' && r !== 'd' && r !== 'l')) return null;
    const result: BotResult = { b, r };
    if (rank !== undefined) {
      if (!Number.isInteger(rank) || (rank as number) < 1 || (rank as number) > opponents + 1) return null;
      if (r === 'w' && rank !== 1) return null;
      result.rank = rank as number;
    }
    if (kills !== undefined) {
      if (!kills || typeof kills !== 'object' || Array.isArray(kills)) return null;
      let total = 0;
      const k: Partial<Record<KillCause, number>> = {};
      for (const [c, n] of Object.entries(kills)) {
        if (!KILL_SET.has(c) || !Number.isInteger(n) || (n as number) < 1) return null;
        k[c as KillCause] = n as number;
        total += n as number;
      }
      if (total > opponents) return null;
      if (total) result.kills = k;
    }
    if (death !== undefined) {
      if (typeof death !== 'string' || !DEATH_SET.has(death) || r === 'w') return null; // a winner is still alive
      result.death = death as DeathCause;
    }
    out.push(result);
  }
  if (new Set(out.map((x) => x.b)).size < out.length) return null; // one human, distinct bots (as ranked picks them)
  if (out.filter((x) => x.b !== HUMAN_ID).length > opponents) return null; // at most 1 (SOLO) / 3 (四人) bots
  const wins = out.filter((x) => x.r === 'w').length;
  if (wins > 1 || (wins === 1 && out.some((x) => x.r === 'd'))) return null; // one winner, and a win is not a draw
  return out;
}

const newTally = (): BotTally => ({ w: 0, d: 0, l: 0, rankSum: 0, ranked: 0, kills: {}, deaths: {} });

/** UTC+8 calendar day of a timestamp. */
export const dayOf = (ms: number) => new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10);
const minuteOf = (ms: number) => new Date(ms + 8 * 3_600_000).toISOString().slice(11, 16);
const hourOf = (ms: number) => new Date(ms + 8 * 3_600_000).toISOString().slice(11, 13);
const HOUR_MS = 3_600_000;

/** Modes shown on the public stats panel (match counts) and the ranked modes with bot tables. */
export const PUBLIC_MODES = ['ranked-solo', 'ranked-ffa', 'cricket', 'custom', 'pvp'] as const;
export type PublicMode = (typeof PUBLIC_MODES)[number];
export const RANKED_MODES = ['ranked-solo', 'ranked-ffa'] as const;
type RankedMode = (typeof RANKED_MODES)[number];

/** GET /public-stats: aggregates only (no visitor ids). Match counts are matches started. */
export interface PublicStats {
  since: string; // first day with data (UTC+8, YYYY-MM-DD)
  updatedAt: string;
  online: number;
  players: number; // browsers that started at least one match in any mode (replays aside) since `since`
  total: Record<PublicMode, number>;
  /** The current hour so far plus the 23 whole hours before it (UTC+8): `from` is that first hour's start */
  last24h: { from: string; to: string; modes: Record<PublicMode, number> };
  bots: Record<RankedMode, Record<string, BotTally>>;
}

const zeroModes = (): Record<PublicMode, number> => ({ 'ranked-solo': 0, 'ranked-ffa': 0, cricket: 0, custom: 0, pvp: 0 });
const isPublicMode = (m: string): m is PublicMode => (PUBLIC_MODES as readonly string[]).includes(m);

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
  bots?: Record<string, Record<string, BotTally>>; // ranked mode → bot id → results (ranked matches played to the end)
  hours?: Record<string, Record<string, number>>; // HH (UTC+8) → mode → matches started in that hour
  compact?: true; // older than keepDays: ids, online and hours dropped
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
  bots: Map<string, Map<string, BotTally>>;
  hours: Map<string, Map<string, number>>;
}

const newDay = (day: string): Day => ({
  day, ids: new Set(), modeIds: new Map(), started: new Map(), finished: new Map(), online: new Map(),
  peakOnline: 0, peakAt: null, bots: new Map(), hours: new Map(),
});

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v | 0) : 0);
function readTally(raw: unknown): BotTally {
  const t = newTally();
  if (!raw || typeof raw !== 'object') return t;
  const r = raw as Record<string, unknown>;
  t.w = count(r.w);
  t.d = count(r.d);
  t.l = count(r.l);
  t.rankSum = count(r.rankSum);
  t.ranked = count(r.ranked);
  const kills = r.kills as Record<string, unknown> | undefined;
  const deaths = r.deaths as Record<string, unknown> | undefined;
  for (const c of KILL_CAUSES) if (kills && count(kills[c])) t.kills[c] = count(kills[c]);
  for (const c of DEATH_CAUSES) if (deaths && count(deaths[c])) t.deaths[c] = count(deaths[c]);
  return t;
}

function addTally(sum: BotTally, t: BotTally) {
  sum.w += t.w;
  sum.d += t.d;
  sum.l += t.l;
  sum.rankSum += t.rankSum;
  sum.ranked += t.ranked;
  for (const c of KILL_CAUSES) if (t.kills[c]) sum.kills[c] = (sum.kills[c] ?? 0) + t.kills[c]!;
  for (const c of DEATH_CAUSES) if (t.deaths[c]) sum.deaths[c] = (sum.deaths[c] ?? 0) + t.deaths[c]!;
}

export class SiteAnalytics {
  private readonly lastSeen = new Map<string, number>();
  private today: Day;
  private dirty = false;
  private writing: Promise<void> = Promise.resolve();
  private past: { day: string; at: number; data: Promise<PastDays> } | null = null;
  private readonly players = new Set<string>(); // all-time: started at least one match (replays aside)
  private playersDirty = false;
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
      for (const [hour, modes] of Object.entries(snap.hours ?? {})) {
        d.hours.set(hour, new Map(Object.entries(modes ?? {}).map(([m, n]) => [m, count(n)])));
      }
      for (const [mode, bots] of Object.entries(snap.bots ?? {})) {
        d.bots.set(mode, new Map(Object.entries(bots ?? {}).filter(([b]) => isResultId(b)).map(([b, t]) => [b, readTally(t)])));
      }
      d.peakOnline = snap.peakOnline | 0;
      d.peakAt = snap.peakAt ?? null;
      this.today = d;
    } catch {
      // No file for today yet, or unreadable: start empty.
    }
    await this.loadPlayers();
  }

  /** The all-time player list; the first time (no players.json yet) it is rebuilt from the day files' visitor ids. */
  private async loadPlayers(): Promise<void> {
    if (!this.dir) return;
    try {
      const saved = JSON.parse(await readFile(join(this.dir, 'players.json'), 'utf8')) as { v?: number; ids?: unknown[] };
      for (const id of saved.ids ?? []) if (isVisitorId(id)) this.players.add(id);
      return;
    } catch {
      // Not written yet: rebuild below.
    }
    let names: string[] = [];
    try {
      names = (await readdir(this.dir)).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n));
    } catch {
      return;
    }
    for (const name of names) {
      try {
        const snap = JSON.parse(await readFile(join(this.dir, name), 'utf8')) as DaySnapshot;
        for (const [mode, ids] of Object.entries(snap.modeIds ?? {})) {
          if (mode === 'replay') continue;
          for (const id of ids ?? []) if (isVisitorId(id)) this.players.add(id);
        }
      } catch {
        // Skip a torn file.
      }
    }
    for (const [mode, ids] of this.today.modeIds) if (mode !== 'replay') for (const id of ids) this.players.add(id);
    this.playersDirty = true;
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
    if (mode !== 'pvp') this.countStart(mode, now);
    if (mode !== 'replay' && !this.players.has(id)) {
      this.players.add(id);
      this.playersDirty = true;
    }
  }

  /** Called by the relay when a PvP match reaches GO. */
  pvpMatchStarted(now = Date.now()) {
    this.roll(now);
    this.countStart('pvp', now);
    this.dirty = true;
  }

  private countStart(mode: Mode, now: number) {
    const t = this.today;
    t.started.set(mode, (t.started.get(mode) ?? 0) + 1);
    const hour = hourOf(now);
    if (!t.hours.has(hour)) t.hours.set(hour, new Map());
    const h = t.hours.get(hour)!;
    h.set(mode, (h.get(mode) ?? 0) + 1);
  }

  /** Finished single-player matches (PvP finishes are counted once by the relay itself, not per client). */
  matchFinished(id: string, mode: Mode, now = Date.now(), bots: BotResult[] | null = null) {
    this.see(id, now);
    const t = this.today;
    t.finished.set(mode, (t.finished.get(mode) ?? 0) + 1);
    if (!bots?.length) return;
    if (!t.bots.has(mode)) t.bots.set(mode, new Map());
    const byBot = t.bots.get(mode)!;
    for (const { b, r, rank, kills, death } of bots) {
      if (!isResultId(b)) continue;
      let tally = byBot.get(b);
      if (!tally) byBot.set(b, (tally = newTally()));
      const one = newTally();
      one[r] = 1;
      if (rank) {
        one.rankSum = rank;
        one.ranked = 1;
      }
      one.kills = kills ?? {};
      if (death) one.deaths[death] = 1;
      addTally(tally, one);
    }
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
    const bots: Record<string, Record<string, BotTally>> = {};
    for (const [mode, byBot] of t.bots) bots[mode] = Object.fromEntries(byBot);
    const hours: Record<string, Record<string, number>> = {};
    for (const [hour, byMode] of [...t.hours].sort()) hours[hour] = Object.fromEntries(byMode);
    return {
      v: 1, day: t.day, updatedAt: new Date(now).toISOString(), uv: t.ids.size, peakOnline: t.peakOnline, peakAt: t.peakAt,
      online: Object.fromEntries([...t.online].sort()), modes, bots, hours, ids: [...t.ids], modeIds,
    };
  }

  async flush(now = Date.now()): Promise<void> {
    if (!this.dir || (!this.dirty && !this.playersDirty)) return;
    const snap = this.dirty ? this.snapshot(now) : null;
    const players = this.playersDirty ? JSON.stringify({ v: 1, ids: [...this.players] }) : null;
    this.dirty = false;
    this.playersDirty = false;
    const dir = this.dir;
    this.writing = this.writing.then(async () => {
      try {
        await mkdir(dir, { recursive: true });
        const writes: [string, string][] = [];
        if (snap) writes.push([join(dir, `${snap.day}.json`), JSON.stringify(snap)]);
        if (players) writes.push([join(dir, 'players.json'), players]);
        for (const [file, data] of writes) {
          await writeFile(`${file}.tmp`, data);
          await rename(`${file}.tmp`, file);
        }
      } catch (err) {
        console.log(JSON.stringify({ time: new Date().toISOString(), event: 'analytics-write-failed', error: String(err) }));
      }
    });
    return this.writing;
  }

  /** Compact days older than keepDays: keep the per-mode and bot totals, drop visitor ids and the fine samples. */
  async prune(now = Date.now()): Promise<void> {
    if (!this.dir) return;
    try {
      const cutoff = dayOf(now - this.keepDays * 86_400_000);
      for (const name of await readdir(this.dir)) {
        if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(name) || name.slice(0, 10) >= cutoff) continue;
        const file = join(this.dir, name);
        let snap: DaySnapshot | null = null;
        try {
          snap = JSON.parse(await readFile(file, 'utf8')) as DaySnapshot;
        } catch {
          // torn: removed below
        }
        if (!snap || snap.v !== 1 || snap.day !== name.slice(0, 10)) {
          await unlink(file); // not a day snapshot
          continue;
        }
        if (snap.compact) continue;
        const { ids: _ids, modeIds: _modeIds, online: _online, hours: _hours, ...keep } = snap;
        await writeFile(`${file}.tmp`, JSON.stringify({ ...keep, online: {}, ids: [], modeIds: {}, compact: true }));
        await rename(`${file}.tmp`, file);
      }
    } catch {
      // Nothing to prune.
    }
  }

  /** Aggregates for the public stats panel: all days on disk plus today in memory. */
  async publicStats(now = Date.now()): Promise<PublicStats> {
    this.roll(now);
    const today = this.today;
    // Finished days only change when a day rolls over: cache them per day (refreshed every 5 min to pick up the flush
    // of the day that just ended)
    if (!this.past || this.past.day !== today.day || now - this.past.at > 300_000) {
      this.past = { day: today.day, at: now, data: readPastDays(this.dir, today.day) };
    }
    const past = await this.past.data;
    const total = zeroModes();
    for (const m of PUBLIC_MODES) total[m] = (past.total[m] ?? 0) + (today.started.get(m) ?? 0);
    const bots = { 'ranked-solo': {}, 'ranked-ffa': {} } as Record<RankedMode, Record<string, BotTally>>;
    for (const mode of RANKED_MODES) {
      const sum = new Map<string, BotTally>();
      for (const [b, t] of Object.entries(past.bots[mode] ?? {})) sum.set(b, t);
      for (const [b, t] of today.bots.get(mode) ?? []) {
        const acc = sum.get(b) ?? newTally();
        const merged = newTally();
        addTally(merged, acc);
        addTally(merged, t);
        sum.set(b, merged);
      }
      bots[mode] = Object.fromEntries(sum);
    }
    // The current hour so far and the 23 whole hours before it: [current hour − 23 h, now]
    const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS; // UTC+8 is a whole-hour offset
    const last = zeroModes();
    for (let k = 0; k < 24; k++) {
      const at = hourStart - k * HOUR_MS;
      const day = dayOf(at);
      const byMode = day === today.day ? today.hours.get(hourOf(at)) : day === past.yesterday ? past.yesterdayHours.get(hourOf(at)) : undefined;
      for (const [m, n] of byMode ?? []) if (isPublicMode(m)) last[m] += n;
    }
    return {
      since: past.since ?? today.day,
      updatedAt: new Date(now).toISOString(),
      online: this.onlineCount(now),
      players: this.players.size,
      total,
      last24h: { from: new Date(hourStart - 23 * HOUR_MS).toISOString(), to: new Date(now).toISOString(), modes: last },
      bots,
    };
  }
}

interface PastDays {
  since: string | null;
  total: Partial<Record<PublicMode, number>>;
  bots: Partial<Record<RankedMode, Record<string, BotTally>>>;
  yesterday: string;
  yesterdayHours: Map<string, Map<string, number>>;
}

async function readPastDays(dir: string | null, today: string): Promise<PastDays> {
  const yesterday = dayOf(Date.parse(`${today}T12:00:00+08:00`) - 86_400_000);
  const out: PastDays = { since: null, total: {}, bots: {}, yesterday, yesterdayHours: new Map() };
  if (!dir) return out;
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n) && n.slice(0, 10) < today).sort();
  } catch {
    return out;
  }
  const bots = new Map<string, Map<string, BotTally>>();
  for (const name of names) {
    let snap: DaySnapshot;
    try {
      snap = JSON.parse(await readFile(join(dir, name), 'utf8')) as DaySnapshot;
    } catch {
      continue;
    }
    out.since ??= name.slice(0, 10);
    for (const m of PUBLIC_MODES) out.total[m] = (out.total[m] ?? 0) + count(snap.modes?.[m]?.started);
    for (const mode of RANKED_MODES) {
      for (const [b, raw] of Object.entries(snap.bots?.[mode] ?? {})) {
        if (!isResultId(b)) continue;
        if (!bots.has(mode)) bots.set(mode, new Map());
        const acc = bots.get(mode)!.get(b) ?? newTally();
        addTally(acc, readTally(raw));
        bots.get(mode)!.set(b, acc);
      }
    }
    if (name.slice(0, 10) === yesterday) {
      for (const [hour, modes] of Object.entries(snap.hours ?? {})) {
        out.yesterdayHours.set(hour, new Map(Object.entries(modes ?? {}).map(([m, n]) => [m, count(n)])));
      }
    }
  }
  for (const [mode, byBot] of bots) out.bots[mode as RankedMode] = Object.fromEntries(byBot);
  return out;
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

const CAUSE_LABEL: Record<DeathCause, string> = { melee: '近战', dart: '飞镖', kick: '踢下', fall: '自坠', collapse: '塌陷' };

/** Ranked bots: W / D / L per bot and mode, with kills and deaths by cause (summed over `days`). */
export function formatBots(days: DaySummary[]): string {
  const totals = new Map<string, Map<string, BotTally>>();
  for (const d of days) {
    for (const [mode, bots] of Object.entries(d.bots ?? {})) {
      if (!totals.has(mode)) totals.set(mode, new Map());
      const byBot = totals.get(mode)!;
      for (const [b, raw] of Object.entries(bots)) {
        const sum = byBot.get(b) ?? newTally();
        addTally(sum, readTally(raw));
        byBot.set(b, sum);
      }
    }
  }
  const label = (causes: readonly DeathCause[]) => causes.map((c) => CAUSE_LABEL[c]).join('/');
  const out = [
    `ranked bots, last ${days.length} day(s) (matches played to the end)`,
    `  kills by ${label(KILL_CAUSES)} · deaths by ${label(DEATH_CAUSES)}`,
  ];
  if (!totals.size) {
    out.push('  no ranked results yet');
    return out.join('\n');
  }
  const sum = (by: Partial<Record<string, number>>) => Object.values(by).reduce<number>((a, n) => a + (n ?? 0), 0);
  for (const mode of ['ranked-solo', 'ranked-ffa', ...[...totals.keys()].filter((m) => m !== 'ranked-solo' && m !== 'ranked-ffa')]) {
    const byBot = totals.get(mode);
    if (!byBot?.size) continue;
    out.push(`  ${MODE_LABEL[mode] ?? mode}`);
    out.push(`    ${'bot'.padEnd(22)} ${'games'.padStart(5)} ${'W'.padStart(4)} ${'D'.padStart(4)} ${'L'.padStart(4)} ${'win%'.padStart(5)} ${'place'.padStart(5)} ${'kills'.padStart(6)}  ${'by cause'.padEnd(10)} ${'deaths'.padStart(6)}  by cause`);
    const rows = [...byBot].map(([b, t]) => ({ b, t, games: t.w + t.d + t.l }));
    rows.sort((x, y) => y.games - x.games || x.b.localeCompare(y.b));
    for (const { b, t, games } of rows) {
      const pct = games ? `${Math.round((t.w / games) * 100)}%` : '-';
      const kills = KILL_CAUSES.map((c) => t.kills[c] ?? 0).join('/');
      const deaths = DEATH_CAUSES.map((c) => t.deaths[c] ?? 0).join('/');
      const place = t.ranked ? (t.rankSum / t.ranked).toFixed(2) : '-';
      out.push(`    ${b.padEnd(22)} ${String(games).padStart(5)} ${String(t.w).padStart(4)} ${String(t.d).padStart(4)} ${String(t.l).padStart(4)} ${pct.padStart(5)} ${place.padStart(5)} ${String(sum(t.kills)).padStart(6)}  ${kills.padEnd(10)} ${String(sum(t.deaths)).padStart(6)}  ${deaths}`);
    }
  }
  return out.join('\n');
}
