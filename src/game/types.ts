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

export interface RosterEntry {
  id: string;
  seat: string;
  charKey: string;
  name: string;
  shortName: string;
  rank: number | null;
  rating: number;
  duelRating?: number | null;
  ffaRating?: number | null;
  category: 'official' | 'sparring';
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
}

export interface MatchConfig {
  mapId: string;
  mapMeta: MapMeta;
  slots: SlotConfig[];
  seed: number;
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
