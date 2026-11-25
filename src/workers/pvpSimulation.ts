import type { GameEvent, TickSnapshot } from '../game/types.ts';
import type { MatchEnd } from '../net/pvpProtocol.ts';
import { PVP_ROLLBACK_SLOTS, type PvpUpdate } from '../net/pvpTimeline.ts';

interface PvpEngine {
  step(text: string): number;
  state(): string;
  events(): string;
  save(slot: number): number;
  restore(slot: number): number;
  hash(): string;
}

export interface PvpSimulationResult {
  state: TickSnapshot;
  confirmedT: number;
  confirmedOver: boolean;
  confirmedEvents: GameEvent[][];
  predictedEvents: GameEvent[][];
  hashes: Pick<MatchEnd, 'frame' | 'hash'>[];
  end?: MatchEnd;
}

const CONFIRMED = 0;

/**
 * The engine switches branches in the worker. Slot zero holds the canonical
 * checkpoint; the ring holds speculative checkpoints indexed by engine tick.
 * Intermediate speculative steps serialize events only. Canonical ticks stay
 * in the worker until the match needs to export its history.
 */
export class PvpSimulation {
  private readonly history: TickSnapshot[];
  private readonly predictedSlots: number[] = [];
  private predicted: TickSnapshot;

  private readonly engine: PvpEngine;

  constructor(engine: PvpEngine, initial: TickSnapshot) {
    this.engine = engine;
    this.history = [initial];
    this.predicted = initial;
    this.save(CONFIRMED);
    this.savePredicted(0);
  }

  private save(slot: number) {
    if (!this.engine.save(slot)) throw new Error(`Cannot save engine snapshot ${slot}`);
  }

  private restore(slot: number) {
    if (!this.engine.restore(slot)) throw new Error(`Cannot restore engine snapshot ${slot}`);
  }

  private savePredicted(t: number) {
    const index = t % PVP_ROLLBACK_SLOTS;
    this.predictedSlots[index] = t;
    this.save(index + 1);
  }

  private state(): TickSnapshot {
    return JSON.parse(this.engine.state());
  }

  recorded(throughT: number) {
    return this.history.slice(0, throughT + 1);
  }

  update(update: PvpUpdate): PvpSimulationResult {
    let confirmed = this.history[this.history.length - 1];
    const hashes: PvpSimulationResult['hashes'] = [];
    const confirmedEvents: GameEvent[][] = [];
    const predictedEvents: GameEvent[][] = [];
    let end: MatchEnd | undefined;
    if (update.confirmed.length && !confirmed.over) {
      this.restore(CONFIRMED);
      for (const pair of update.confirmed) {
        this.engine.step(pair.map((action) => action.join(' ')).join('\n'));
        confirmed = this.state();
        this.history.push(confirmed);
        confirmedEvents.push(confirmed.events);
        if (confirmed.t % 20 === 0 || confirmed.over) {
          const report = { frame: confirmed.t - 1, hash: this.engine.hash() };
          if (confirmed.t % 20 === 0) hashes.push(report);
          if (confirmed.over) end = { ...report, winner: confirmed.winner };
        }
        if (confirmed.over) break;
      }
      this.save(CONFIRMED);
    }
    if (update.terminalT !== undefined) {
      // Clock estimates may lead the relay by a fraction of a tick. If an
      // administrative end cuts off that tick, use the exact relay cutoff.
      confirmed = this.history[Math.min(confirmed.t, update.terminalT)];
      if (end && end.frame >= confirmed.t) end = undefined;
      this.predicted = confirmed;
    } else if (confirmed.over) {
      this.predicted = confirmed;
    } else if (update.prediction &&
        (update.prediction.from === confirmed.t || update.prediction.from !== this.predicted.t || !this.predicted.over)) {
      const { from, frames } = update.prediction;
      let t = from;
      if (from === confirmed.t) {
        this.restore(CONFIRMED);
        this.savePredicted(t);
      } else {
        const index = t % PVP_ROLLBACK_SLOTS;
        if (this.predictedSlots[index] !== t) throw new Error(`Missing rollback checkpoint for tick ${t}`);
        this.restore(index + 1);
      }
      for (const pair of frames) {
        const running = this.engine.step(pair.map((action) => action.join(' ')).join('\n'));
        predictedEvents.push(JSON.parse(this.engine.events()));
        this.savePredicted(++t);
        if (!running) break;
      }
      this.predicted = this.state();
    }
    return {
      state: this.predicted,
      confirmedT: confirmed.t,
      confirmedOver: confirmed.over,
      confirmedEvents,
      predictedEvents,
      hashes,
      end,
    };
  }
}
