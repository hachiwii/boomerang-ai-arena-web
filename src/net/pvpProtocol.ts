import type { PvpChallengeResult, PvpMatchInfo } from './pvpTypes.ts';

export const PVP_TICK_MS = 50;
export const PVP_INPUT_GRACE_MS = 125;
export const PVP_MAX_FRAMES = 800;
export const PVP_COUNTDOWN_MS = 3000;

export type Seat = 0 | 1;
export type Action = readonly [mx: number, my: number, act: number, ax: number, ay: number, msg: number];
export type ActionPair = readonly [Action, Action];
export type InputRow = readonly [frame: number, seat: Seat, action: Action];
export const NEUTRAL: Action = [0, 0, 0, 0, 0, 0];

export function withoutAct(action: Action): Action {
  return [action[0], action[1], 0, action[3], action[4], action[5]];
}

export function isAction(value: unknown): value is Action {
  if (!Array.isArray(value) || value.length !== 6 || !value.every(Number.isSafeInteger)) return false;
  const [mx, my, act, ax, ay, msg] = value;
  return Math.abs(mx) <= 1_000_000 && Math.abs(my) <= 1_000_000 &&
    act >= 0 && act <= 4 && Math.abs(ax) <= 1_000_000 && Math.abs(ay) <= 1_000_000 &&
    msg >= 0 && msg <= 65535;
}

export interface Go {
  startAt: number;
  delay: number;
}

export interface MatchEnd {
  frame: number;
  hash: string;
  winner: number;
}

export type MatchTerminal =
  | { reason: 'forfeit'; winner: Seat; through: number; cause?: 'quit' | 'disconnect' }
  | { reason: 'cancelled' | 'timeout' | 'complete'; through: number };

export type ClientMessage =
  | { type: 'hello'; buildId: string; token: string | null; matchId?: string }
  | { type: 'presence'; present: boolean }
  | { type: 'ping'; t: number; rttMs?: number }
  | { type: 'resetCode'; request: number }
  | ({ type: 'challenge'; request: number; code: string } &
      Pick<PvpMatchInfo, 'mapId' | 'seed' | 'spawnSeed' | 'bgmSeed'>)
  | ({ matchId: string } & (
      | { type: 'ready' | 'quit' }
      | { type: 'input'; frame: number; action: Action }
      | { type: 'hash'; frame: number; hash: string }
      | ({ type: 'end' } & MatchEnd)
    ));

export type MatchMessage = { matchId: string } & (
  | ({ type: 'go' } & Go)
  | { type: 'inputs'; rows: InputRow[] }
  | { type: 'peer'; connected: boolean }
  | ({ type: 'terminal' } & MatchTerminal)
);

export type ServerMessage =
  | { type: 'welcome'; token: string; code: string; expiresAt: number; matchId?: string }
  | { type: 'code'; code: string; expiresAt: number; request?: number }
  | { type: 'pong'; t: number; serverTime: number; expiresAt: number }
  | { type: 'challengeResult'; request: number; result: PvpChallengeResult }
  | { type: 'matchStart'; info: PvpMatchInfo }
  | MatchMessage;
