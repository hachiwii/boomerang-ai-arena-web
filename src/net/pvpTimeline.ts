import { NEUTRAL, PVP_MAX_FRAMES, PVP_TICK_MS, withoutAct, type Action, type ActionPair, type InputRow, type Seat } from './pvpProtocol.ts';

export const PVP_ROLLBACK_SLOTS = 32;

export interface PvpUpdate {
  confirmed: ActionPair[];
  prediction: { from: number; frames: ActionPair[] } | null;
  terminalT?: number;
  rollbackFrames?: number;
}

function equal(a: Action, b: Action) {
  return a.every((v, i) => v === b[i]);
}

function samePair(a: ActionPair, b: ActionPair) {
  return equal(a[0], b[0]) && equal(a[1], b[1]);
}

/** Number of steps due. Frame zero produces tick one at startAt. */
export function pvpTargetTick(elapsedMs: number, previousTarget: number): number {
  return Math.max(previousTarget, Math.min(PVP_MAX_FRAMES, Math.floor(elapsedMs / PVP_TICK_MS) + 1));
}

/** Sample once for the newest due frame, even when catching up several steps. */
export function pvpSampleFrame(previousTarget: number, targetT: number, delay: number): number | null {
  const frame = targetT - 1 + delay;
  return targetT > previousTarget && frame < PVP_MAX_FRAMES ? frame : null;
}

/** Canonical frame f produces the state at tick f + 1. */
export class PvpTimeline {
  private readonly canonical: [Action?, Action?][] = [];
  private readonly local: Action[] = [];
  private readonly used: ActionPair[] = [];

  private readonly mySeat: Seat;

  constructor(mySeat: Seat) {
    this.mySeat = mySeat;
  }

  accept(rows: InputRow[]) {
    for (const [frame, seat, action] of rows) {
      const pair = this.canonical[frame] ?? (this.canonical[frame] = []);
      pair[seat] = action;
    }
  }

  sample(frame: number, action: Action) {
    this.local[frame] = action;
  }

  /** The action this client sampled and sent for `frame` (undefined if none). */
  localAt(frame: number): Action | undefined {
    return this.local[frame];
  }

  plan(confirmedT: number, predictedT: number, targetT: number, terminalT?: number): PvpUpdate {
    const confirmed: ActionPair[] = [];
    let nextConfirmed = confirmedT;
    while (nextConfirmed < targetT) {
      const pair = this.canonical[nextConfirmed];
      if (!pair?.[0] || !pair[1]) break;
      confirmed.push([pair[0], pair[1]]);
      nextConfirmed++;
    }
    if (terminalT !== undefined) return { confirmed, prediction: null, terminalT };

    // Compare against the actions the speculative branch actually used. Also
    // check inherited predictions, which can change when an earlier row arrives.
    const last: [Action, Action] = [NEUTRAL, NEUTRAL];
    for (const seat of [0, 1] as const) {
      for (let f = confirmedT - 1; f >= 0; f--) {
        const action = this.canonical[f]?.[seat];
        if (action) {
          last[seat] = withoutAct(action);
          break;
        }
      }
    }
    const frames: ActionPair[] = [];
    let from = predictedT;
    for (let f = confirmedT; f < Math.max(targetT, predictedT); f++) {
      const row = this.canonical[f];
      const pair: [Action, Action] = [NEUTRAL, NEUTRAL];
      for (const seat of [0, 1] as const) {
        const action = row?.[seat];
        if (action) last[seat] = withoutAct(action);
        pair[seat] = action ?? (seat === this.mySeat ? this.local[f] : undefined) ?? last[seat];
      }
      if (f < predictedT && this.used[f] && !samePair(pair, this.used[f])) from = Math.min(from, f);
      frames.push(pair);
    }
    const rollbackFrames = predictedT - from;
    const corrected = rollbackFrames > 0;
    from = Math.max(from, nextConfirmed);
    // Once a predicted checkpoint rolls out of the ring, use the latest
    // canonical checkpoint and replay the complete remaining suffix.
    if (predictedT - from >= PVP_ROLLBACK_SLOTS) from = nextConfirmed;
    const suffix = frames.slice(from - confirmedT);
    return {
      confirmed,
      rollbackFrames,
      prediction: suffix.length || from !== predictedT || corrected ? { from, frames: suffix } : null,
    };
  }

  commit(update: PvpUpdate, predictedT: number) {
    const prediction = update.prediction;
    if (!prediction) return;
    this.used.length = predictedT;
    for (let f = prediction.from; f < predictedT; f++) {
      this.used[f] = prediction.frames[f - prediction.from];
    }
  }
}

/** The same event can occur more than once in a frame, so preserve multiplicity. */
export class PvpEventDedup {
  private readonly emitted = new Map<string, number>();

  take<T extends { t: number; type: number; a: number; b: number; c: number; d: number }>(events: T[]): T[] {
    const counts = new Map<string, number>();
    return events.filter((event) => {
      const key = [event.t, event.type, event.a, event.b, event.c, event.d].join(':');
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      if (n <= (this.emitted.get(key) ?? 0)) return false;
      this.emitted.set(key, n);
      return true;
    });
  }
}
