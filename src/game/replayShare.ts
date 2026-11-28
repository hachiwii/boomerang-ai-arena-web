/**
 * 分享对局：把一局的回放（MatchReplayBundle：摘要 + 地图 + 每一步的完整快照）压成一段文本，传到中转服务器换短链接；
 * 打开短链接时再还原成同一个 bundle 交给回放播放器。
 *
 * 为什么存快照而不是「种子 + 每步动作」：回放播放器本来就只吃快照（不跑引擎、不跑 bot），历史里的老对局也只存了快照；
 * 而动作重放要求引擎一字不差，引擎一改（规则、出生点、人类判定这些设置）旧链接就会悄悄放出另一局。快照不受影响。
 *
 * 格式（v1）：快照按「列」存——每个数值字段（每一步的 t / winner …、每个座位的 x / y / st …、每支镖的 …）是一列，
 * 列里存相邻两步的差值，连续的 0 合并成一个字符串计数（"37" = 37 个 0）。大多数字段大多数步不变，再 gzip 后
 * 一局 4 人对局一般 5～8 KB。编码时会立刻解码回来逐字段比对，对不上（比如以后快照多了不规则的字段）就退回
 * 直接存快照（r 字段），保证还原出的就是原来那一局。timestampMs（本机时钟，回放不用）不存。
 *
 * 解码的数据来自别人：所有字符串都会清洗（名字里的 < > & " ' ` 去掉、颜色只认 #hex、头像只认站内路径或图片 data URL），
 * 数字必须有限、数量有上限，再交给会把名字拼进 innerHTML 的 HUD。
 *
 * 这个文件只有类型导入，node 测试可以直接 import（scripts/test_replay_share.mjs）。
 */
import type { HistoryPlayerSummary, MatchHistorySummary, MatchReplayBundle } from './matchHistory';
import type { EngineMapData, GameEvent, MatchMode, SlotConfig, TickSnapshot } from './types';

export const SHARE_FORMAT_VERSION = 1;
/** 上传文本上限（base64url）；服务器同样限制（server/shares.ts）。 */
export const SHARE_MAX_TEXT_BYTES = 1024 * 1024;
/** 解压后 JSON 上限；服务器同样限制。 */
export const SHARE_MAX_JSON_BYTES = 4 * 1024 * 1024;
/** 短链接 id：10 位小写字母数字（服务器按内容哈希生成）。 */
export const SHARE_ID_RE = /^[0-9a-z]{10}$/;

const MAX_TICKS = 20000;
const MAX_SEATS = 16;
const MAX_DARTS = 64;
const MAX_KEYS = 64;
const MAX_EVENTS = 200000;
const MAX_AVATAR_CHARS = 160 * 1024;
const KEY_RE = /^[a-z][A-Za-z0-9]{0,23}$/;
const EVENT_KEYS = ['t', 'type', 'name', 'a', 'b', 'c', 'd'] as const;
const MATCH_MODES: readonly MatchMode[] = ['ranked-solo', 'ranked-ffa', 'cricket', 'custom', 'training', 'pvp', 'team'];
const TICK_SKIP_KEYS = new Set(['players', 'darts', 'events', 'timestampMs']);

type RleColumn = (number | string)[];

export interface SharedReplayDoc {
  v: 1;
  /** 摘要（MatchHistorySummary，去掉 favorite） */
  s: Record<string, unknown>;
  /** 地图（EngineMapData） */
  m: Record<string, unknown>;
  /** 步数 */
  n: number;
  /** 每步的数值 / 布尔字段名（tb 里的是布尔） */
  tk?: string[];
  tb?: string[];
  /** 每步的定长数组字段：[名字, 长度]（团队赛的 owner / taking / prog / score） */
  ta?: [string, number][];
  /** 座位、镖的字段名 */
  pk?: string[];
  dk?: string[];
  /** 列：tk…、ta 展开…、座位数、座位 0 的 pk…、座位 1 的 pk…、镖数、镖 0 的 dk… */
  c?: RleColumn[];
  /** 事件名表 + 事件：每个事件 8 个数 [距上个事件的步数差, 该步 t - 事件 t, type, 名字序号, a, b, c, d] */
  en?: string[];
  e?: number[];
  /** 兜底：直接存的快照（去掉 timestampMs） */
  r?: unknown[];
}

// ---------------------------------------------------------------------------------------------------------------
// 编码

function rle(deltas: number[]): RleColumn {
  const out: RleColumn = [];
  let zeros = 0;
  const flush = () => {
    if (zeros === 1) out.push(0);
    else if (zeros > 1) out.push(String(zeros));
    zeros = 0;
  };
  for (const d of deltas) {
    if (d === 0) {
      zeros++;
      continue;
    }
    flush();
    out.push(d);
  }
  flush();
  return out;
}

function numOf(v: unknown): number {
  if (typeof v === 'boolean') return v ? 1 : 0;
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function encodeTicks(ticks: TickSnapshot[]): Omit<SharedReplayDoc, 'v' | 's' | 'm' | 'n'> {
  const tk: string[] = [];
  const tb: string[] = [];
  const ta = new Map<string, number>();
  const pk: string[] = [];
  const dk: string[] = [];
  let maxP = 0;
  let maxD = 0;
  const addKey = (list: string[], key: string) => {
    if (!list.includes(key)) list.push(key);
  };
  for (const tick of ticks) {
    for (const [key, value] of Object.entries(tick)) {
      if (TICK_SKIP_KEYS.has(key)) continue;
      if (Array.isArray(value)) ta.set(key, Math.max(ta.get(key) ?? 0, value.length));
      else {
        if (typeof value === 'boolean' && !tk.includes(key)) tb.push(key);
        addKey(tk, key);
      }
    }
    maxP = Math.max(maxP, tick.players.length);
    maxD = Math.max(maxD, tick.darts.length);
    for (const p of tick.players) for (const key of Object.keys(p)) addKey(pk, key);
    for (const d of tick.darts) for (const key of Object.keys(d)) addKey(dk, key);
  }

  const columns: RleColumn[] = [];
  const column = (get: (tick: TickSnapshot) => unknown) => {
    const deltas: number[] = [];
    let prev = 0;
    for (const tick of ticks) {
      const raw = get(tick);
      const v = raw === undefined ? prev : numOf(raw);
      deltas.push(v - prev);
      prev = v;
    }
    columns.push(rle(deltas));
  };
  const rec = (o: unknown) => o as Record<string, unknown>;
  for (const key of tk) column((t) => rec(t)[key]);
  for (const [key, len] of ta) {
    for (let i = 0; i < len; i++) column((t) => (rec(t)[key] as unknown[] | undefined)?.[i]);
  }
  column((t) => t.players.length);
  for (let i = 0; i < maxP; i++) for (const key of pk) column((t) => rec(t.players[i])?.[key]);
  column((t) => t.darts.length);
  for (let i = 0; i < maxD; i++) for (const key of dk) column((t) => rec(t.darts[i])?.[key]);

  const en: string[] = [];
  const e: number[] = [];
  let lastIdx = 0;
  ticks.forEach((tick, idx) => {
    for (const ev of tick.events) {
      let ni = en.indexOf(ev.name);
      if (ni < 0) ni = en.push(ev.name) - 1;
      e.push(idx - lastIdx, numOf(tick.t) - numOf(ev.t), numOf(ev.type), ni, numOf(ev.a), numOf(ev.b), numOf(ev.c), numOf(ev.d));
      lastIdx = idx;
    }
  });
  return { tk, tb, ta: Array.from(ta), pk, dk, c: columns, en, e };
}

function stripTimestamps(ticks: TickSnapshot[]): Record<string, unknown>[] {
  return ticks.map((tick) => {
    const { timestampMs: _drop, ...rest } = tick;
    return rest;
  });
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => deepEqual(v, bb[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual((a as never)[k], (b as never)[k]));
}

/** bundle → 文档（可 JSON 化）。summary / slots 会先清洗，分享出去的就是别人看到的。 */
export function encodeReplayDoc(bundle: MatchReplayBundle): SharedReplayDoc {
  const ticks = bundle.replay.ticks;
  if (!Array.isArray(ticks) || ticks.length === 0) throw new Error('回放数据为空');
  if (ticks.length > MAX_TICKS) throw new Error('对局过长，无法分享');
  const { favorite: _fav, ...summary } = bundle.summary;
  const doc: SharedReplayDoc = {
    v: SHARE_FORMAT_VERSION,
    s: sanitizeSummary(summary, ticks.length) as unknown as Record<string, unknown>,
    m: sanitizeMapData(bundle.replay.mapData) as unknown as Record<string, unknown>,
    n: ticks.length,
    ...encodeTicks(ticks),
  };
  // 立刻解码回来比对；不一致（不规则的快照字段等）就直接存快照
  let same = false;
  try {
    same = deepEqual(decodeTicks(doc), stripTimestamps(ticks));
  } catch {
    same = false;
  }
  if (!same) {
    const { tk: _a, tb: _b, ta: _c, pk: _d, dk: _e, c: _f, en: _g, e: _h, ...rest } = doc;
    return { ...rest, r: stripTimestamps(ticks) };
  }
  return doc;
}

// ---------------------------------------------------------------------------------------------------------------
// 解码 + 清洗（数据来自别人）

function fail(what: string): never {
  throw new Error(`分享数据无效（${what}）`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function finiteNum(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function intIn(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fallback;
}

/** 显示用文本：去掉 HTML 特殊字符和控制字符（HUD 会把名字拼进 innerHTML）。 */
export function cleanText(v: unknown, maxLen: number, fallback = ''): string {
  if (typeof v !== 'string') return fallback;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[<>&"'`\\\u0000-\u001f\u007f\u2028\u2029]/g, '').trim().slice(0, maxLen);
  return s || fallback;
}

function cleanId(v: unknown, maxLen: number, fallback = ''): string {
  return typeof v === 'string' && v.length <= maxLen && /^[A-Za-z0-9_.-]+$/.test(v) && !v.includes('..') ? v : fallback;
}

export function cleanColor(v: unknown, fallback = '#8A97B0'): string {
  return typeof v === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v) ? v : fallback;
}

/** 头像：站内 /assets/ 路径，或图片 data URL（base64 / 百分号编码的 SVG）；其他一律不要。 */
export function cleanAvatar(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > MAX_AVATAR_CHARS) return null;
  if (/^\/assets\/[A-Za-z0-9_./-]+$/.test(v) && !v.includes('..')) return v;
  if (/^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/.test(v)) return v;
  const svg = /^data:image\/svg\+xml;(utf8|charset=utf-8),([A-Za-z0-9%._~!*()'-]*)$/.exec(v);
  // 单引号和括号也转义，放进任何引号里都不会断开
  if (svg) return `data:image/svg+xml;${svg[1]},${svg[2].replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29')}`;
  return null;
}

function cleanSlot(raw: unknown, seat: number): SlotConfig {
  const s = isRecord(raw) ? raw : {};
  const color = cleanColor(s.color);
  const name = cleanText(s.displayName, 40, `P${seat + 1}`);
  const slot: SlotConfig = {
    kind: s.kind === 'human' ? 'human' : 'bot',
    charKey: cleanId(s.charKey, 64, 'demo_red'),
    baseName: cleanText(s.baseName, 40, name),
    displayName: name,
    color,
    avatar: cleanAvatar(s.avatar),
  };
  const botId = cleanId(s.botId, 64);
  if (botId) slot.botId = botId;
  if (s.ringAccent !== undefined) slot.ringAccent = cleanColor(s.ringAccent, color);
  if (s.copyNumber !== undefined) slot.copyNumber = intIn(s.copyNumber, 0, 99, 1);
  if (s.remote === true) slot.remote = true;
  if (s.side === 0 || s.side === 1) slot.side = s.side;
  if (s.origTeam === 'astra' || s.origTeam === 'fable') slot.origTeam = s.origTeam;
  return slot;
}

function cleanPlayer(raw: unknown, seat: number, slot: SlotConfig, nSeats: number): HistoryPlayerSummary {
  const p = isRecord(raw) ? raw : {};
  const out: HistoryPlayerSummary = {
    seat,
    kind: slot.kind,
    displayName: slot.displayName,
    color: slot.color,
    avatar: slot.avatar,
    rank: intIn(p.rank, 0, MAX_SEATS, nSeats),
    kills: intIn(p.kills, 0, 9999, 0),
    alive: p.alive === true,
    cause: intIn(p.cause, 0, 99, 0),
    killer: intIn(p.killer, -1, MAX_SEATS, -1),
  };
  if (slot.botId) out.botId = slot.botId;
  if (slot.ringAccent) out.ringAccent = slot.ringAccent;
  return out;
}

function nullableNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 摘要清洗：只留已知字段，类型不对就用默认值。tickCount 以实际步数为准。 */
export function sanitizeSummary(raw: unknown, tickCount: number): MatchHistorySummary {
  const s = isRecord(raw) ? raw : {};
  const rawSlots = Array.isArray(s.slots) ? s.slots : [];
  if (rawSlots.length < 1 || rawSlots.length > MAX_SEATS) fail('座位数');
  const slots = rawSlots.map(cleanSlot);
  const rawPlayers = Array.isArray(s.players) ? s.players : [];
  const players = slots.map((slot, seat) => cleanPlayer(rawPlayers[seat], seat, slot, slots.length));
  const matchMode = MATCH_MODES.includes(s.matchMode as MatchMode) ? (s.matchMode as MatchMode) : 'custom';
  const speed = finiteNum(s.speed, 1);
  const summary: MatchHistorySummary = {
    id: cleanId(s.id, 64, 'shared'),
    playedAt: intIn(s.playedAt, 0, 8.64e15, 0),
    matchMode,
    mapId: cleanId(s.mapId, 48, 'unknown'),
    mapTitle: cleanText(s.mapTitle, 40, '未知地图'),
    mapTheme: cleanId(s.mapTheme, 48, 'meadow'),
    seed: intIn(s.seed, 0, 0xffffffff, 0),
    speed: speed >= 0.1 && speed <= 2 ? speed : 1,
    durationTicks: intIn(s.durationTicks, 0, 1e7, Math.max(0, tickCount - 1)),
    tickCount,
    humanSeat: intIn(s.humanSeat, -1, slots.length - 1, -1),
    winner: intIn(s.winner, -2, slots.length - 1, -1),
    earlyExit: s.earlyExit === true,
    slots,
    players,
    eloDelta: nullableNum(s.eloDelta),
    eloAfter: nullableNum(s.eloAfter),
    eloOldRank: nullableNum(s.eloOldRank),
    eloNewRank: nullableNum(s.eloNewRank),
  };
  if (s.spawnSeed !== undefined) summary.spawnSeed = intIn(s.spawnSeed, 0, 0xffffffff, 0);
  if (s.bgmSeed !== undefined) summary.bgmSeed = intIn(s.bgmSeed, 0, 0xffffffff, summary.seed);
  if (isRecord(s.pvp) && (s.pvp.mySeat === 0 || s.pvp.mySeat === 1)) {
    summary.pvp = { matchId: cleanId(s.pvp.matchId, 64, 'pvp'), mySeat: s.pvp.mySeat };
  }
  if (matchMode === 'team' && isRecord(s.team) && (s.team.mode === 3 || s.team.mode === 4 || s.team.mode === 5)) {
    const mapId = cleanId(s.team.mapId, 48, '');
    const labels = Array.isArray(s.team.labels) ? s.team.labels : [];
    if (mapId === 'caldera' || mapId === 'piers' || mapId === 'keeps') {
      summary.team = { mapId, mode: s.team.mode, labels: [cleanText(labels[0], 24, '左队'), cleanText(labels[1], 24, '右队')] };
    }
  }
  return summary;
}

/** 地图里可能有的值：数字、短字符串、它们的（嵌套）数组 / 对象。键名必须像普通字段名。 */
function cleanJson(v: unknown, depth: number): unknown {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return cleanText(v, 48);
  if (depth <= 0) return null;
  if (Array.isArray(v)) {
    if (v.length > 100000) fail('地图数组过长');
    return v.map((x) => cleanJson(x, depth - 1));
  }
  if (isRecord(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (KEY_RE.test(k)) out[k] = cleanJson(x, depth - 1);
    return out;
  }
  return null;
}

export function sanitizeMapData(raw: unknown): EngineMapData {
  if (!isRecord(raw)) fail('地图');
  const m = cleanJson(raw, 4) as Record<string, unknown>;
  const nx = intIn(m.nx, 1, 256, 0);
  const ny = intIn(m.ny, 1, 256, 0);
  if (!nx || !ny) fail('地图尺寸');
  const intArray = (v: unknown, maxLen: number) =>
    Array.isArray(v) && v.length <= maxLen && v.every((x) => typeof x === 'number' && Number.isInteger(x));
  if (!intArray(m.cells, nx * ny) || (m.cells as number[]).length !== nx * ny) fail('地图格子');
  for (const key of ['waves', 'waveSteps']) if (!intArray(m[key], nx * ny + 64)) fail('地图塌陷');
  if (m.treeCells !== undefined && !intArray(m.treeCells, nx * ny)) fail('地图树');
  const pairs = (v: unknown) => Array.isArray(v) && v.length <= 64 && v.every((p) => Array.isArray(p) && p.length === 2);
  if (!pairs(m.spawns)) fail('出生点');
  for (const key of ['cell', 'nwave', 'colStart', 'colEvery', 'colWarn', 'steps', 'bodyR', 'dartR', 'range', 'slashReach', 'dashCd', 'recallPre']) {
    m[key] = finiteNum(m[key]);
  }
  if (typeof m.name !== 'string') m.name = '';
  return m as unknown as EngineMapData;
}

function cleanEvent(raw: unknown): GameEvent {
  const e = isRecord(raw) ? raw : {};
  return {
    t: finiteNum(e.t),
    type: finiteNum(e.type),
    name: typeof e.name === 'string' && /^[A-Z0-9_]{1,24}$/.test(e.name) ? e.name : 'UNKNOWN',
    a: finiteNum(e.a),
    b: finiteNum(e.b),
    c: finiteNum(e.c),
    d: finiteNum(e.d),
  };
}

/** 一步的快照：只留合法键名的数字 / 布尔、数字数组，座位 / 镖 / 事件逐个清洗。 */
function sanitizeTick(raw: unknown): TickSnapshot {
  if (!isRecord(raw)) fail('快照');
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (TICK_SKIP_KEYS.has(k) || !KEY_RE.test(k)) continue;
    if (typeof v === 'number') out[k] = Number.isFinite(v) ? v : 0;
    else if (typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v) && v.length <= 16) out[k] = v.map((x) => finiteNum(x));
  }
  const flat = (list: unknown, max: number) => {
    if (!Array.isArray(list) || list.length > max) fail('快照座位');
    return list.map((item) => {
      const o: Record<string, number> = {};
      if (isRecord(item)) for (const [k, v] of Object.entries(item)) if (KEY_RE.test(k)) o[k] = finiteNum(v);
      return o;
    });
  };
  out.players = flat(raw.players, MAX_SEATS);
  out.darts = flat(raw.darts, MAX_DARTS);
  if (!Array.isArray(raw.events) || raw.events.length > 4096) fail('快照事件');
  out.events = raw.events.map(cleanEvent);
  return out as unknown as TickSnapshot;
}

function keyList(v: unknown, what: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > MAX_KEYS || !v.every((k) => typeof k === 'string' && KEY_RE.test(k))) fail(what);
  return v as string[];
}

/** 列式数据 → 快照（不含 timestampMs）。 */
function decodeTicks(doc: SharedReplayDoc): Record<string, unknown>[] {
  const n = doc.n;
  const tk = keyList(doc.tk, '字段');
  const tb = new Set(keyList(doc.tb, '字段'));
  const pk = keyList(doc.pk, '座位字段');
  const dk = keyList(doc.dk, '镖字段');
  const taRaw = doc.ta ?? [];
  if (!Array.isArray(taRaw) || taRaw.length > MAX_KEYS) fail('数组字段');
  const ta = taRaw.map((item) => {
    if (!Array.isArray(item) || typeof item[0] !== 'string' || !KEY_RE.test(item[0])) fail('数组字段');
    return [item[0], intIn(item[1], 0, 16, -1)] as [string, number];
  });
  if (ta.some(([, len]) => len < 0)) fail('数组字段');
  const cols = doc.c;
  if (!Array.isArray(cols)) fail('列');
  let ci = 0;
  const nextColumn = (): number[] => {
    const col = cols[ci++];
    if (!Array.isArray(col)) fail('列数');
    const out = new Array<number>(n);
    let i = 0;
    let acc = 0;
    for (const item of col) {
      if (typeof item === 'string') {
        const run = /^[1-9][0-9]{0,6}$/.test(item) ? Number(item) : 0;
        if (!run || i + run > n) fail('列长度');
        for (let k = 0; k < run; k++) out[i++] = acc;
      } else {
        if (typeof item !== 'number' || !Number.isFinite(item) || i >= n) fail('列数据');
        acc += item;
        out[i++] = acc;
      }
    }
    if (i !== n) fail('列长度');
    return out;
  };

  const ticks: Record<string, unknown>[] = Array.from({ length: n }, () => ({}));
  for (const key of tk) {
    const col = nextColumn();
    const asBool = tb.has(key);
    for (let i = 0; i < n; i++) ticks[i][key] = asBool ? col[i] !== 0 : col[i];
  }
  for (const [key, len] of ta) {
    const parts = Array.from({ length: len }, nextColumn);
    for (let i = 0; i < n; i++) ticks[i][key] = parts.map((col) => col[i]);
  }
  const objects = (field: 'players' | 'darts', keys: string[], max: number) => {
    const lens = nextColumn();
    const maxLen = lens.reduce((a, b) => Math.max(a, b), 0);
    if (lens.some((l) => !Number.isInteger(l) || l < 0) || maxLen > max) fail(field);
    for (let i = 0; i < n; i++) ticks[i][field] = Array.from({ length: lens[i] }, () => ({}));
    for (let j = 0; j < maxLen; j++) {
      for (const key of keys) {
        const col = nextColumn();
        for (let i = 0; i < n; i++) if (j < lens[i]) (ticks[i][field] as Record<string, number>[])[j][key] = col[i];
      }
    }
  };
  objects('players', pk, MAX_SEATS);
  objects('darts', dk, MAX_DARTS);
  if (ci !== cols.length) fail('列数');

  for (const tick of ticks) tick.events = [];
  const en = doc.en ?? [];
  const e = doc.e ?? [];
  if (!Array.isArray(en) || en.length > 256 || !Array.isArray(e) || e.length % 8 !== 0 || e.length / 8 > MAX_EVENTS) fail('事件');
  let idx = 0;
  for (let i = 0; i < e.length; i += 8) {
    const row = e.slice(i, i + 8);
    if (!row.every((x) => typeof x === 'number' && Number.isFinite(x))) fail('事件');
    idx += row[0];
    if (!Number.isInteger(idx) || idx < 0 || idx >= n) fail('事件位置');
    const ev: Record<string, unknown> = {};
    const values = [numOf(ticks[idx].t) - row[1], row[2], en[row[3]], row[4], row[5], row[6], row[7]];
    EVENT_KEYS.forEach((k, j) => (ev[k] = values[j]));
    (ticks[idx].events as unknown[]).push(ev);
  }
  return ticks;
}

/** 文档 → bundle（会清洗）。id 换成 `share-<shareId>`，不进收藏。 */
export function decodeReplayDoc(raw: unknown, shareId = ''): MatchReplayBundle {
  if (!isRecord(raw) || raw.v !== SHARE_FORMAT_VERSION) fail('版本');
  const doc = raw as unknown as SharedReplayDoc;
  const n = intIn(doc.n, 1, MAX_TICKS, 0);
  if (!n) fail('步数');
  let rawTicks: unknown[];
  if (doc.r !== undefined) {
    if (!Array.isArray(doc.r) || doc.r.length !== n) fail('快照');
    rawTicks = doc.r;
  } else {
    rawTicks = decodeTicks({ ...doc, n });
  }
  const ticks = rawTicks.map(sanitizeTick);
  ticks.forEach((tick, i) => {
    tick.timestampMs = i * 50;
  });
  const summary = sanitizeSummary(doc.s, n);
  if (ticks.some((t) => t.players.length !== summary.slots.length)) fail('座位数');
  summary.durationTicks = Math.max(0, finiteNum(ticks[n - 1].t));
  const id = shareId && SHARE_ID_RE.test(shareId) ? `share-${shareId}` : `share-${summary.id}`;
  summary.id = id;
  summary.favorite = false;
  const mapData = sanitizeMapData(doc.m);
  return { summary, replay: { id, mapData, ticks } };
}

// ---------------------------------------------------------------------------------------------------------------
// 文本：JSON → gzip → base64url

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) fail('编码');
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipeBytes(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, maxOut: number): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  void writer.write(bytes as Uint8Array<ArrayBuffer>).then(() => writer.close()).catch(() => undefined);
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxOut) {
      void reader.cancel().catch(() => undefined);
      fail('数据过大');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export function isShareCodecSupported(): boolean {
  return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
}

/** bundle → 上传用的文本（base64url 的 gzip JSON）。 */
export async function packReplay(bundle: MatchReplayBundle): Promise<string> {
  const json = JSON.stringify(encodeReplayDoc(bundle));
  const gz = await pipeBytes(new TextEncoder().encode(json), new CompressionStream('gzip'), SHARE_MAX_TEXT_BYTES);
  const text = bytesToBase64Url(gz);
  if (text.length > SHARE_MAX_TEXT_BYTES) throw new Error('对局数据过大，无法分享');
  return text;
}

/** 下载的文本 → bundle（会清洗）。 */
export async function unpackReplay(text: string, shareId = ''): Promise<MatchReplayBundle> {
  if (text.length > SHARE_MAX_TEXT_BYTES) fail('数据过大');
  const raw = await pipeBytes(base64UrlToBytes(text.trim()), new DecompressionStream('gzip'), SHARE_MAX_JSON_BYTES);
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    fail('JSON');
  }
  return decodeReplayDoc(doc, shareId);
}
