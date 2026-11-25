/**
 * Online 1v1 (PvP) — the contract between the lobby/HUD UI and the network layer.
 * See docs/pvp-design.md. UI code only talks to the network through PvpLobbyClient + PvpNetStats.
 */

/** A code stays reserved this long after its owner was last on the PvP tab; while on the tab it keeps renewing. */
export const PVP_CODE_TTL_MS = 30 * 60 * 1000;

/** Assists are fixed for both players in PvP (input pre-buffering still follows each player's local settings). */
export const PVP_FIXED_RULES = {
  humanSlashTicks: 2, // 严格判定
  cliffGuard: true, // 跌落防护
  dashGuard: true, // 冲刺保护
  meleeAssist: true, // 近战吸附
  speed: 1.0,
  bulletTime: false, // 子弹时间禁用
} as const;

export type PvpConnState = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'offline';

export type PvpChallengeFailReason =
  | 'invalid' // not 6 digits
  | 'self' // own code
  | 'not_found' // no such code, or it expired
  | 'offline' // the owner is not on the PvP tab right now (left, tab hidden, closed the page)
  | 'busy' // the owner is in a match or already being matched
  | 'version' // the two clients run different game builds
  | 'rate_limited' // too many attempts
  | 'network'; // we are not connected to the server / timed out

export type PvpChallengeResult = { ok: true } | { ok: false; reason: PvpChallengeFailReason };

export interface PvpCodeInfo {
  code: string | null; // 6 digits, null while connecting
  expiresAt: number | null; // local epoch ms; pushed forward continuously while present
}

export interface PvpMatchInfo {
  matchId: string;
  mySeat: 0 | 1; // seat 0 = P1, seat 1 = P2 (kept across rematches)
  challenger: boolean; // true on the side that entered the code
  // Drawn by the relay at random from the CHALLENGED side's map pool (empty pool = every map), fresh for each rematch
  mapId: string;
  seed: number;
  spawnSeed: number;
  bgmSeed: number;
  rematchOf?: string; // previous matchId when both players chose 再来一局
}

/** Post-match choice on the PvP result screen. A disconnect after the match counts as 'left'. */
export type PvpRematchChoice = 'undecided' | 'rematch' | 'left';

export interface PvpRematchState {
  matchId: string; // the finished match
  me: PvpRematchChoice;
  opponent: PvpRematchChoice;
}

export interface PvpNetStats {
  rttMs: number | null; // smoothed round trip to the relay server
  jitterMs?: number;
  transport?: 'ws' | 'webrtc';
  inputDelayFrames?: number; // in match only
  rollbackFrames?: number; // in match only: frames re-simulated by the latest correction
}

export interface PvpLobbyEventMap {
  state: PvpConnState;
  code: PvpCodeInfo;
  stats: PvpNetStats; // ~1 Hz in the lobby, ~2 Hz in a match
  matchStart: PvpMatchInfo; // both sides; main.ts starts the match on it (also for a rematch, from the result screen)
  rematch: PvpRematchState; // result-screen choices of both players, on every change
  notice: string; // short human-readable message (e.g. 对方已断开)
}

export interface PvpLobbyClient {
  getState(): PvpConnState;
  getCode(): PvpCodeInfo;
  getStats(): PvpNetStats;
  /** The PvP tab is shown: connect if needed, become challengeable, keep renewing the code. */
  enter(): void;
  /** The PvP tab is no longer shown: not challengeable any more; the code stays reserved until it expires. */
  leave(): void;
  /** Drop the current code and get a new one. */
  resetCode(): Promise<string | null>;
  /** Challenge another player's code. On success matchStart fires on both sides. */
  challenge(code: string): Promise<PvpChallengeResult>;
  /** The local PvP map pool (map ids; empty = all maps). Used when this player is the one being challenged. */
  setMapPool(mapIds: string[]): void;
  /** Result screen: 再来一局. When both players asked, matchStart fires again with new seeds. */
  requestRematch(): void;
  /** Result screen: 退出. The opponent's 再来一局 becomes unavailable. */
  leaveRematch(): void;
  on<K extends keyof PvpLobbyEventMap>(ev: K, cb: (v: PvpLobbyEventMap[K]) => void): () => void;
}
