import {
  NEUTRAL, PVP_COUNTDOWN_MS, PVP_MAX_FRAMES, PVP_TICK_MS, type Action, type InputRow, type MatchEnd, type MatchMessage,
} from './pvpProtocol.ts';

export interface PvpMatchLink {
  serverNow(): number;
  onMessage(listener: (message: MatchMessage) => void): () => void;
  ready(): void;
  input(frame: number, action: Action): void;
  hash(frame: number, hash: string): void;
  end(result: MatchEnd): void;
  quit(): void;
  setRollbackFrames(frames: number): void;
}

/** The lobby mock can exercise the match UI offline using a stationary peer. */
export function mockPvpMatchLink(matchId: string): PvpMatchLink {
  let listener: ((message: MatchMessage) => void) | undefined;
  let timer: number | undefined;
  let startAt = 0;
  let next = 0;
  const delay = 2;
  const local: Action[] = [];
  const serverNow = () => performance.now();
  const stop = () => window.clearInterval(timer);
  const flush = () => {
    const through = Math.min(PVP_MAX_FRAMES - 1, Math.floor((serverNow() - startAt) / PVP_TICK_MS));
    const rows: InputRow[] = [];
    for (; next <= through; next++) {
      rows.push([next, 0, local[next] ?? NEUTRAL], [next, 1, NEUTRAL]);
    }
    if (rows.length) listener?.({ type: 'inputs', matchId, rows });
  };
  return {
    serverNow,
    onMessage: (callback) => {
      listener = callback;
      return () => { listener = undefined; stop(); };
    },
    ready: () => {
      startAt = serverNow() + PVP_COUNTDOWN_MS;
      listener?.({ type: 'go', matchId, startAt, delay });
      timer = window.setInterval(flush, PVP_TICK_MS);
    },
    input: (frame, action) => { local[frame] = action; },
    hash: () => {},
    end: stop,
    quit: () => {
      if (startAt) flush();
      stop();
      listener?.({ type: 'terminal', matchId, reason: 'forfeit', cause: 'quit', winner: 1, through: next - 1 });
    },
    setRollbackFrames: () => {},
  };
}
