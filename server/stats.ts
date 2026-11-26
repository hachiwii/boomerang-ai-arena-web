// Per-match latency statistics: one JSON line per finished match in a daily file, plus summaries for the
// loopback /stats endpoint and the stats-report CLI. Privacy: only derived region / client class are kept —
// never an IP address or a raw User-Agent.
import { appendFile, mkdir, readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export type ClientClass = 'desktop' | 'android' | 'ios' | 'wechat' | 'qq' | 'harmony' | 'other';

export interface Region {
  country: string; // ISO code, or 'unknown'
  province?: string; // mainland China only
  isp?: string; // mainland China only (电信 / 移动 / 联通 …)
}

export interface SeatStats {
  client: ClientClass;
  region: Region;
  rtt: number[]; // RTT samples (ms) taken during the match
  fills: number; // frames the relay filled with a neutral input because this seat's input missed the deadline
  lateDropped: number; // inputs that arrived after their frame had already been filled
  lateActions: number; // …of which carried an action (throw / slash / dash / recall); the client re-sends it next frame
  maxLateMs: number; // latest accepted input, relative to its frame's due time (ms, ≥ 0)
  reconnects: number;
}

export interface SeatRecord extends Omit<SeatStats, 'rtt'> {
  samples: number;
  rttMedian: number | null;
  rttP95: number | null;
  rttMax: number | null;
  jitter: number | null; // mean absolute difference between consecutive samples
}

export interface MatchRecord {
  v: 1;
  matchId: string;
  mapId: string;
  startedAt: string; // ISO time the match was created
  endedAt: string;
  reason: string;
  cause?: string;
  frames: number; // game length (frames played)
  delay: number | null; // input delay frames chosen at GO (null if the match never started)
  delayRtt?: number; // the RTT estimate the delay was chosen from (mean of both players' p75)
  rematch: boolean;
  seats: [SeatRecord, SeatRecord];
}

export const MAX_RTT_SAMPLES = 4000;

const quantile = (sorted: number[], q: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1) + 0.5))] : null;

export function newSeatStats(client: ClientClass, region: Region): SeatStats {
  return { client, region, rtt: [], fills: 0, lateDropped: 0, lateActions: 0, maxLateMs: 0, reconnects: 0 };
}

export function addRttSample(seat: SeatStats, rttMs: number) {
  if (rttMs > 0 && rttMs < 10_000 && seat.rtt.length < MAX_RTT_SAMPLES) seat.rtt.push(Math.round(rttMs));
}

export function seatRecord(seat: SeatStats): SeatRecord {
  const { rtt, ...rest } = seat;
  const sorted = [...rtt].sort((a, b) => a - b);
  let jitter: number | null = null;
  if (rtt.length >= 2) {
    let sum = 0;
    for (let i = 1; i < rtt.length; i++) sum += Math.abs(rtt[i] - rtt[i - 1]);
    jitter = Math.round(sum / (rtt.length - 1));
  }
  return {
    ...rest,
    samples: rtt.length,
    rttMedian: quantile(sorted, 0.5),
    rttP95: quantile(sorted, 0.95),
    rttMax: sorted.length ? sorted[sorted.length - 1] : null,
    jitter,
  };
}

/** Coarse client class from a User-Agent; in-app browsers first (they also claim Android / iOS). */
export function classifyClient(ua: string | undefined): ClientClass {
  if (!ua) return 'other';
  if (/MicroMessenger/i.test(ua)) return 'wechat';
  if (/\bQQ\/|MQQBrowser/i.test(ua)) return 'qq';
  if (/OpenHarmony|HarmonyOS|ArkWeb/i.test(ua)) return 'harmony';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  if (/Windows NT|Macintosh|X11|Linux x86_64|CrOS/i.test(ua)) return 'desktop';
  return 'other';
}

export const UNKNOWN_REGION: Region = { country: 'unknown' };

interface LookupResult {
  country?: { code?: string };
  subdivisions?: { name?: string }[];
  isp?: string;
}
interface Lookup {
  lookup(ip: string): LookupResult | null;
}

const trimProvince = (name: string) => name.replace(/(省|市|壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区)$/, '');

/** Offline IP → region (ip2region, IPv4 + IPv6). Loads asynchronously; until it is ready every IP is 'unknown'. */
export class RegionResolver {
  private db: Lookup | null = null;

  get ready(): boolean {
    return this.db !== null;
  }

  async open(): Promise<void> {
    try {
      const { IP2Region } = await import('ip2region/node');
      this.db = await IP2Region.open();
    } catch (err) {
      console.log(JSON.stringify({ time: new Date().toISOString(), event: 'stats-region-db-failed', error: String(err) }));
    }
  }

  /** For tests: plug in any lookup implementation. */
  use(db: Lookup) {
    this.db = db;
  }

  lookup(ip: string): Region {
    if (!this.db || !ip || ip === '?') return UNKNOWN_REGION;
    let address = ip.trim();
    if (address.startsWith('::ffff:') && address.includes('.')) address = address.slice(7);
    try {
      const r = this.db.lookup(address);
      const country = r?.country?.code;
      if (!country) return UNKNOWN_REGION;
      if (country !== 'CN') return { country };
      const province = r.subdivisions?.[0]?.name;
      const isp = r.isp && !/^\d+$/.test(r.isp) ? r.isp : undefined;
      return { country, ...(province ? { province: trimProvince(province) } : {}), ...(isp ? { isp } : {}) };
    } catch {
      return UNKNOWN_REGION; // invalid / private / unsupported address
    }
  }
}

const day = (iso: string) => iso.slice(0, 10);

/** Daily JSONL files in `dir` (one line per match). Write failures never reach the caller. */
export class StatsStore {
  private ready: Promise<void> | null = null;
  private chain: Promise<void> = Promise.resolve();
  readonly dir: string;
  readonly keepDays: number;

  constructor(dir: string, keepDays = 90) {
    this.dir = dir;
    this.keepDays = keepDays;
  }

  private ensureDir() {
    this.ready ??= mkdir(this.dir, { recursive: true }).then(() => undefined);
    return this.ready;
  }

  append(record: MatchRecord): Promise<void> {
    const line = JSON.stringify(record) + '\n';
    this.chain = this.chain
      .then(() => this.ensureDir())
      .then(() => appendFile(join(this.dir, `${day(record.endedAt)}.jsonl`), line))
      .catch((err) => {
        this.ready = null;
        console.log(JSON.stringify({ time: new Date().toISOString(), event: 'stats-write-failed', error: String(err) }));
      });
    return this.chain;
  }

  async prune(nowMs = Date.now()): Promise<void> {
    try {
      const cutoff = day(new Date(nowMs - this.keepDays * 86_400_000).toISOString());
      for (const name of await readdir(this.dir)) {
        if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name.slice(0, 10) < cutoff) await unlink(join(this.dir, name));
      }
    } catch {
      // Missing directory or a race with another prune: nothing to do.
    }
  }

  async read(days: number, nowMs = Date.now()): Promise<MatchRecord[]> {
    const since = day(new Date(nowMs - (Math.max(1, days) - 1) * 86_400_000).toISOString());
    const out: MatchRecord[] = [];
    let names: string[] = [];
    try {
      names = (await readdir(this.dir)).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n) && n.slice(0, 10) >= since).sort();
    } catch {
      return out;
    }
    for (const name of names) {
      for (const line of (await readFile(join(this.dir, name), 'utf8')).split('\n')) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line));
        } catch {
          // Skip a torn line.
        }
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Summaries

export interface GroupSummary {
  key: string;
  matches: number;
  players: number; // seat-records in the group
  rttMedian: number | null; // median of the seats' median RTT
  rttP95: number | null; // 95th percentile of the seats' p95 RTT
  delayShare: Record<'0' | '1' | '2' | 'other', number>; // share of the group's matches per input delay
  fillsPer1000: number | null; // neutral fills per 1000 player-frames
  lateActionsPer1000: number | null; // late (filled) actions per 1000 player-frames
}

export interface Summary {
  days: number;
  matches: number;
  played: number; // matches that reached GO
  reasons: Record<string, number>;
  perDay: Record<string, number>;
  perHour: Record<string, number>; // 'YYYY-MM-DD HH' in UTC+8
  delays: Record<string, number>;
  byRegion: GroupSummary[];
  byProvince: GroupSummary[];
  byClient: GroupSummary[];
}

export const regionKey = (r: Region) => r.country;
export const provinceKey = (r: Region) =>
  r.country === 'CN' ? `CN-${r.province ?? '?'}${r.isp ? `-${r.isp}` : ''}` : r.country;

function group(records: MatchRecord[], keyOf: (seat: SeatRecord) => string): GroupSummary[] {
  const groups = new Map<string, { matches: Set<string>; seats: SeatRecord[]; frames: number; delays: Map<string, Set<string>> }>();
  for (const m of records) {
    if (m.delay === null) continue;
    for (const seat of m.seats) {
      const key = keyOf(seat);
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { matches: new Set(), seats: [], frames: 0, delays: new Map() }));
      g.matches.add(m.matchId);
      g.seats.push(seat);
      g.frames += Math.max(0, m.frames);
      const d = m.delay === 0 || m.delay === 1 || m.delay === 2 ? String(m.delay) : 'other';
      if (!g.delays.has(d)) g.delays.set(d, new Set());
      g.delays.get(d)!.add(m.matchId);
    }
  }
  const out: GroupSummary[] = [];
  for (const [key, g] of groups) {
    const medians = g.seats.map((s) => s.rttMedian).filter((v): v is number => v !== null).sort((a, b) => a - b);
    const p95s = g.seats.map((s) => s.rttP95).filter((v): v is number => v !== null).sort((a, b) => a - b);
    const fills = g.seats.reduce((sum, s) => sum + s.fills, 0);
    const lateActions = g.seats.reduce((sum, s) => sum + (s.lateActions ?? 0), 0);
    const share = (d: '0' | '1' | '2' | 'other') => (g.delays.get(d)?.size ?? 0) / g.matches.size;
    out.push({
      key,
      matches: g.matches.size,
      players: g.seats.length,
      rttMedian: quantile(medians, 0.5),
      rttP95: quantile(p95s, 0.95),
      delayShare: { '0': share('0'), '1': share('1'), '2': share('2'), other: share('other') },
      fillsPer1000: g.frames > 0 ? Math.round((fills / g.frames) * 10_000) / 10 : null,
      lateActionsPer1000: g.frames > 0 ? Math.round((lateActions / g.frames) * 10_000) / 10 : null,
    });
  }
  return out.sort((a, b) => b.players - a.players || a.key.localeCompare(b.key));
}

export function summarize(records: MatchRecord[], days: number): Summary {
  const perDay: Record<string, number> = {};
  const perHour: Record<string, number> = {};
  const reasons: Record<string, number> = {};
  const delays: Record<string, number> = {};
  let played = 0;
  for (const m of records) {
    const cst = new Date(Date.parse(m.startedAt) + 8 * 3_600_000).toISOString();
    perDay[cst.slice(0, 10)] = (perDay[cst.slice(0, 10)] ?? 0) + 1;
    const hour = `${cst.slice(0, 10)} ${cst.slice(11, 13)}`;
    perHour[hour] = (perHour[hour] ?? 0) + 1;
    const reason = m.cause ? `${m.reason}/${m.cause}` : m.reason;
    reasons[reason] = (reasons[reason] ?? 0) + 1;
    if (m.delay !== null) {
      played++;
      delays[String(m.delay)] = (delays[String(m.delay)] ?? 0) + 1;
    }
  }
  return {
    days,
    matches: records.length,
    played,
    reasons,
    perDay,
    perHour,
    delays,
    byRegion: group(records, (s) => regionKey(s.region)),
    byProvince: group(records, (s) => provinceKey(s.region)),
    byClient: group(records, (s) => s.client),
  };
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const ms = (v: number | null) => (v === null ? '-' : `${v}`);

function table(title: string, rows: GroupSummary[], limit = 30): string {
  const lines = [`${title}`, `  ${'key'.padEnd(18)} ${'matches'.padStart(7)} ${'players'.padStart(7)} ${'rtt p50'.padStart(7)} ${'rtt p95'.padStart(7)}  delay 0/1/2       fills/1k  late acts/1k`];
  for (const r of rows.slice(0, limit)) {
    const share = `${pct(r.delayShare['0'])}/${pct(r.delayShare['1'])}/${pct(r.delayShare['2'])}`;
    lines.push(`  ${r.key.padEnd(18)} ${String(r.matches).padStart(7)} ${String(r.players).padStart(7)} ${ms(r.rttMedian).padStart(7)} ${ms(r.rttP95).padStart(7)}  ${share.padEnd(17)} ${String(r.fillsPer1000 ?? '-').padEnd(9)} ${r.lateActionsPer1000 ?? '-'}`);
  }
  if (rows.length > limit) lines.push(`  … ${rows.length - limit} more`);
  return lines.join('\n');
}

export function formatReport(s: Summary): string {
  const out: string[] = [];
  out.push(`PvP stats · last ${s.days} day(s) · ${s.matches} matches (${s.played} played past GO)`);
  out.push(`end reasons: ${Object.entries(s.reasons).map(([k, v]) => `${k} ${v}`).join(', ') || '-'}`);
  out.push(`input delay: ${Object.entries(s.delays).sort().map(([k, v]) => `${k}f ${v}`).join(', ') || '-'}`);
  out.push(`per day (UTC+8): ${Object.entries(s.perDay).sort().map(([k, v]) => `${k} ${v}`).join(', ') || '-'}`);
  const hours = Object.entries(s.perHour).sort().slice(-24);
  out.push(`per hour, last 24 (UTC+8): ${hours.map(([k, v]) => `${k.slice(11)}h ${v}`).join(', ') || '-'}`);
  out.push('');
  out.push(table('by country', s.byRegion));
  out.push('');
  out.push(table('by China province / ISP (others: country)', s.byProvince));
  out.push('');
  out.push(table('by client', s.byClient));
  const worst = [...s.byProvince].filter((r) => r.players >= 3 && r.rttMedian !== null).sort((a, b) => b.rttMedian! - a.rttMedian!).slice(0, 8);
  out.push('');
  out.push(table('worst regions by median RTT (≥ 3 players)', worst));
  return out.join('\n');
}
