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
export type MatchMode = 'ranked-solo' | 'ranked-ffa' | 'cricket' | 'custom' | 'training' | 'pvp';

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
}

export interface HumanAction {
  mx: number;
  my: number;
  act: ActType;
  ax: number;
  ay: number;
  msg: number;
}
