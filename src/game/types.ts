export const CELL_MM = 500;
export const UNIT_MM = 1000;
export const LOGIC_HZ = 20;
export const LOGIC_DT_MS = 1000 / LOGIC_HZ; // 50ms

export const enum CellType {
  FLOOR = 0,
  WALL = 1,
  PIT = 2,
  GRASS = 3,
}

export const enum PState {
  FREE = 0,
  THROW = 1,
  THROWN = 2,
  SLASH = 3,
  SLASHED = 4,
  KICK = 5,
  KICKED = 6,
  DASH = 7,
  STUN = 8,
  RECALL = 9,
  DEAD = 10,
}

export const enum DState {
  HAND = 0,
  OUT = 1,
  BACK = 2,
  GROUND = 3,
  RISE = 4,
  GONE = 5,
  CALL = 6,
}

export const enum ActType {
  NONE = 0,
  THROW = 1,
  MELEE = 2,
  DASH = 3,
  RECALL = 4,
}

export const enum CauseType {
  NONE = 0,
  DART = 1,
  SLASH = 2,
  FALL = 3,
}

export interface MapMeta {
  id: string;
  title: string;
  theme: string;
  category: 'standard' | 'large';
  nx: number;
  ny: number;
  desc: string;
  previewGrid: string[];
}

export type RankedMode = 'solo' | 'ffa';
export type MatchMode = 'ranked-solo' | 'ranked-ffa' | 'cricket' | 'custom' | 'training' | 'pvp' | 'team';

export function isRankedMatchMode(mode: MatchMode): boolean {
  return mode === 'ranked-solo' || mode === 'ranked-ffa';
}

export interface RosterEntry {
  id: string;
  seat: string;
  charKey: string;
  name: string;
  shortName: string;
  rank: number | null;
  rating: number | null;
  duelRating: number | null;
  ffaRating: number | null;
  // official = the 13 contest bots (ranked); community = built-in bots outside the contest (fixed ELO shown, never
  // ranked); sparring = practice bots; custom = compiled in the browser by the user (no ELO, never ranked)
  category: 'official' | 'community' | 'sparring' | 'custom';
  color: string;
  avatar: string | null;
  author?: string; // community bots: who wrote it, shown as a small pink "@author" after the name in the lobby
}

export interface SlotConfig {
  kind: 'human' | 'bot';
  botId?: string;
  charKey: string;
  baseName: string;
  displayName: string;
  color: string;
  ringAccent?: string;
  avatar: string | null;
  copyNumber?: number; // 1, 2, 3... when same AI has duplicates
  remote?: boolean; // PvP: the opponent (a human on the other client); "you" styling and audio focus skip it
  /** 5v5 团队赛：0 左队（蓝）/ 1 右队（红） */
  side?: 0 | 1;
  /** 5v5 团队赛：这个 bot 原本属于哪个原版队（Astra 蓝 / Fable 红），玩家没有 */
  origTeam?: 'astra' | 'fable';
}

export interface MatchConfig {
  matchMode: MatchMode;
  mapId: string;
  mapMeta: MapMeta;
  slots: SlotConfig[];
  seed: number;
  spawnSeed?: number; // Independent RNG seed for symmetric circular spawn randomization (radius = see_r)
  bgmSeed?: number; // Independent RNG seed for special BGM selection (re-rolled on Custom restart)
  speed: number; // 0.1 .. 2.0 (fixed 1.0 in ranked)
  cliffGuard: boolean; // Prevent human from walking off cliffs
  dashGuard?: boolean; // Dash-tail 25% cliff save in WASM engine
  meleeAssist?: boolean; // Client-side aim assist (no longer alters WASM dart-block cone)
  humanSlashTicks?: number; // 3 (normal: melee 2f / block 3f) | 2 (strict: melee AI / block 2f) | 0 (AI exact)
  // Online 1v1 only (matchMode 'pvp'): both slots are kind 'human'; mySeat is the local player
  pvp?: { matchId: string; mySeat: 0 | 1 };
  /** 5v5 团队赛（matchMode 'team'）：10 个座位的阵容、战术、布阵；slots 按座位 0～9（左队 0～4、右队 5～9） */
  team?: import('./teamMatch').TeamMatchSetup;
  /**
   * 5v5 联机房间：房主（role host）跑引擎和 bot，按 seats 把别人的操作填进对应座位并把每步动作发出去；
   * 其他人（role guest）按房主发来的动作重放。mySeat 是自己的座位（观战为 -1）。
   */
  teamRoom?: { matchId: string; role: 'host' | 'guest'; mySeat: number; seats: (number | null)[] };
}

/**
 * Generates an independent non-zero 32-bit random seed for per-match spawn randomization,
 * decoupled from legacy `seed` and `bgmSeed` so old replays remain untouched.
 */
export function generateSpawnSeed(): number {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0] || 1;
  }
  return ((Math.imul(Date.now() >>> 0, 2654435761) ^ Math.floor(Math.random() * 0x100000000)) >>> 0) || 1;
}

export interface EngineMapData {
  name: string;
  nx: number;
  ny: number;
  cell: number;
  nwave: number;
  colStart: number;
  colEvery: number;
  colWarn: number;
  steps: number;
  bodyR: number;
  dartR: number;
  range: number;
  slashReach: number;
  dashCd: number;
  recallPre: number;
  cells: number[];
  waves: number[];
  waveSteps: number[];
  spawns: [number, number][];
  /** Optional cell indices (y * nx + x) of WALL cells drawn as trees instead of the theme's rocks (training ground). */
  treeCells?: number[];
  // —— 5v5 团队赛（engine_init_team）才有；单挑 / 混战没有这些字段
  /** 3 歼灭 / 4 占点 / 5 刺王 */
  mode?: 3 | 4 | 5;
  respawn?: number; // 占点：出局后几步复活
  capture?: number; // 占点：站满几步翻点
  kingLives?: number;
  kingInv?: number;
  /** 刺王：左队、右队国王的座位（其他模式 [-1, -1]） */
  kings?: [number, number];
  /** 每个座位的引擎短名（astra / sol2 / player …） */
  names?: string[];
  /** 每个座位的布阵点（毫米，场地坐标；占点里就是复活点） */
  bases?: [number, number][];
  /** 占点：三个点（场上固定名 A/B/C，毫米） */
  points?: { name: string; x: number; y: number; r: number }[];
  /** 左队布阵区（毫米 [x0, y0, x1, y1]）；右队是它绕地图中心转 180 度 */
  deploy?: [number, number, number, number][];
}

export interface PlayerSnapshot {
  alive: number;
  x: number;
  y: number;
  px: number;
  py: number;
  vx: number;
  vy: number;
  face: number; // 0..35999 (0.01 deg)
  st: number;
  timer: number;
  ax: number;
  ay: number;
  cd: number;
  expose: number;
  kills: number;
  kDart: number;
  kSlash: number;
  kFall: number;
  visMask: number;
  deadT: number;
  cause: number;
  killer: number;
  dashing: number;
  kickedBy: number;
  rank: number;
  // —— 5v5 团队赛才有
  team?: number; // 0 左队 / 1 右队
  lives?: number; // 刺王：国王剩几条命（其他人 0）
  inv?: number; // 刺王：国王无敌还剩几步
  revivals?: number; // 占点：复活过几次（出局的人 timer = 还有几步复活）
  kTeam?: number; // 误杀队友次数（kills 里也算了，敌方击杀 = kills - kTeam）
}

export interface DartSnapshot {
  st: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  left: number;
  age: number;
}

export interface GameEvent {
  t: number;
  type: number;
  name: string;
  a: number;
  b: number;
  c: number;
  d: number;
}

export interface TickSnapshot {
  t: number;
  n: number;
  over: boolean;
  winner: number;
  fallen: number;
  warn: number;
  players: PlayerSnapshot[];
  darts: DartSnapshot[];
  events: GameEvent[];
  timestampMs: number;
  // —— 5v5 占点才有意义（其他团队模式也会给，值为 -1 / 0）
  owner?: [number, number, number]; // 每个点归哪队（-1 中立）
  taking?: [number, number, number]; // 正在被哪队翻（-1 没有）
  prog?: [number, number, number]; // 已经连续站了几步（满 capture 步翻点）
  score?: [number, number]; // 两队积分（单位：步；20 个合 1 分）
}

export interface HumanAction {
  mx: number;
  my: number;
  act: ActType;
  ax: number;
  ay: number;
  msg: number;
}
