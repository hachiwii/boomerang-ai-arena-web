import type { HumanInputController } from './humanInput';
import type { CountdownStage, MatchCallbacks } from './matchController';
import type { EngineMapData, MatchConfig, TickSnapshot } from './types';
import type { PvpSimulationResult } from '../workers/pvpSimulation';
import type { PvpMatchLink } from '../net/pvpMatchLink';
import {
  PVP_MAX_FRAMES, PVP_TICK_MS, type Go, type MatchMessage, type MatchTerminal, type Seat,
} from '../net/pvpProtocol';
import { PvpEventDedup, PvpTimeline, pvpSampleFrame, pvpTargetTick } from '../net/pvpTimeline';
import { PVP_FIXED_RULES } from '../net/pvpTypes';

/** A filled action of ours is re-sent only within this many frames (500 ms); older ones are dropped. */
const REQUEUE_MAX_FRAMES = 10;

interface PvpCallbacks extends MatchCallbacks {
  onNotice: (message: string) => void;
  onCancelled: () => void;
}

export class PvpMatchController {
  private readonly timeline: PvpTimeline;
  private readonly dedup = new PvpEventDedup();
  private readonly unlisten: () => void;
  private worker: Worker | null = null;
  private clockTimer: number | null = null;
  private reqId = 0;
  private pending = new Map<number, (reply?: Record<string, unknown>) => void>();
  private go: Go | null = null;
  private terminal: MatchTerminal | null = null;
  private stage: CountdownStage = null;
  private current: TickSnapshot | null = null;
  private loaded = false;
  private stopped = false;
  private finished = false;
  private quitRequested = false;
  private awaitingTerminal = false;
  private updating = false;
  private inputsChanged = false;
  private targetT = 0;
  private confirmedT = 0;
  private history: TickSnapshot[] = [];
  private resultNote?: string;
  // An action of ours that the relay replaced with a neutral fill (it arrived after its frame's deadline). It is
  // re-sent with the next sampled frame instead of being lost, if that sample has no action of its own.
  private requeued: { frame: number; act: number; ax: number; ay: number } | null = null;

  constructor(
    private readonly input: HumanInputController,
    private readonly config: MatchConfig,
    private readonly seat: Seat,
    private readonly link: PvpMatchLink,
    private readonly callbacks: PvpCallbacks,
  ) {
    this.timeline = new PvpTimeline(seat);
    this.unlisten = link.onMessage((message) => this.receive(message));
  }

  getHumanSeat() { return this.seat; }
  getRecordedTicks() { return this.history; }
  getTickIntervalMs() { return PVP_TICK_MS; }
  isFinished() { return this.finished; }
  isQuitting() { return this.quitRequested; }
  getResultNote() { return this.resultNote; }

  async start() {
    this.callbacks.onStatus?.('加载 PvP 地图与引擎…');
    try {
      const origin = window.location.origin;
      const response = await fetch(`${origin}/assets/maps/${this.config.mapId}.txt?v=${__BUILD_ID__}`);
      if (!response.ok) throw new Error(`无法加载地图 ${this.config.mapId}`);
      const mapText = await response.text();
      if (this.stopped) return;

      const worker = this.worker = new Worker(new URL('../workers/engineWorker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => this.pending.get(data.reqId)?.(data);
      worker.onerror = (event) => this.fail(event.message || 'PvP 引擎停止运行');
      const result = await this.rpc({
        type: 'init', origin, buildId: __BUILD_ID__, mapText,
        nPlayers: 2, seed: this.config.seed, spawnSeed: this.config.spawnSeed ?? 0,
        botSeats: [], humanSeats: 0b11, cliffGuard: PVP_FIXED_RULES.dashGuard,
        walkGuard: PVP_FIXED_RULES.cliffGuard,
        meleeAssist: PVP_FIXED_RULES.meleeAssist, humanSlashTicks: PVP_FIXED_RULES.humanSlashTicks,
      });
      if (this.stopped) return;
      const map = result.mapData as EngineMapData;
      const initial = { ...(result.state as TickSnapshot), timestampMs: performance.now() };
      this.current = initial;
      this.input.reset();
      this.input.setFixedMatchRules(PVP_FIXED_RULES);
      this.input.setMapData(map);
      this.input.setTickIntervalMs(PVP_TICK_MS);
      await this.callbacks.onMapLoaded(map, initial);
      if (this.stopped) return;

      this.loaded = true;
      if (!this.quitRequested) this.input.setInputMode('countdown');
      if (!this.terminal && !this.quitRequested) this.link.ready();
      this.schedule(0);
    } catch (err) {
      if (!this.stopped) this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  requestQuit() {
    if (this.finished || this.stopped || this.quitRequested) return;
    this.quitRequested = true;
    this.input.setInputMode('off');
    this.callbacks.onNotice('正在退出 PvP 对局…');
    this.link.quit();
  }

  stop() {
    this.stopped = true;
    this.unlisten();
    this.stopClock();
    this.terminateWorker();
    this.input.setFixedMatchRules(null);
    this.input.setInputMode('off');
    this.input.setMapData(null);
  }

  private terminateWorker() {
    this.worker?.terminate();
    this.worker = null;
    for (const resolve of this.pending.values()) resolve();
  }

  private fail(err: string) {
    if (this.stopped || this.finished) return;
    this.link.quit();
    this.stop();
    this.callbacks.onError?.(err);
  }

  private rpc(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error('PvP engine stopped'));
    return new Promise((resolve, reject) => {
      const reqId = ++this.reqId;
      const timer = window.setTimeout(() => finish(), 15_000);
      const finish = (reply?: Record<string, unknown>) => {
        window.clearTimeout(timer);
        this.pending.delete(reqId);
        if (!reply || reply.type === 'error') {
          reject(new Error(String(reply?.error ?? 'PvP engine unavailable')));
        } else {
          resolve(reply);
        }
      };
      this.pending.set(reqId, finish);
      worker.postMessage({ ...message, reqId });
    });
  }

  private receive(message: MatchMessage) {
    if (this.stopped || this.finished) return;
    if (message.type === 'go') {
      this.go = message;
    } else if (message.type === 'inputs') {
      this.timeline.accept(message.rows);
      this.inputsChanged = true;
      for (const [frame, seat, action] of message.rows) {
        if (seat !== this.seat || action[2] !== 0) continue;
        const sent = this.timeline.localAt(frame);
        // The relay echoes our accepted inputs unchanged, so an action of ours that comes back as "no action" was filled
        if (sent && sent[2] !== 0) this.requeued = { frame, act: sent[2], ax: sent[3], ay: sent[4] };
      }
    } else if (message.type === 'terminal') {
      this.terminal = message;
      if (message.reason === 'cancelled') {
        this.stop();
        this.callbacks.onNotice('PvP 对局已取消');
        this.callbacks.onCancelled();
        return;
      }
    } else {
      return;
    }
    this.schedule(0);
  }

  private setStage(stage: CountdownStage) {
    if (this.stage === stage) return;
    this.stage = stage;
    this.callbacks.onCountdown?.(stage);
  }

  private stopClock() {
    if (this.clockTimer !== null) window.clearTimeout(this.clockTimer);
    this.clockTimer = null;
    this.setStage(null);
  }

  private schedule(delay: number) {
    if (!this.loaded || this.stopped || this.finished || this.updating) return;
    if (this.clockTimer !== null) window.clearTimeout(this.clockTimer);
    this.clockTimer = window.setTimeout(() => {
      this.clockTimer = null;
      void this.tick();
    }, delay);
  }

  private async tick() {
    const current = this.current;
    if (!current || this.stopped || this.finished) return;
    this.updating = true;
    try {
      const terminal = this.terminal;
      if (this.awaitingTerminal && !terminal) return;
      const terminalT = terminal && terminal.reason !== 'cancelled' ? terminal.through + 1 : undefined;
      const go = this.go;
      const elapsed = go ? this.link.serverNow() - go.startAt : -Infinity;
      if (terminalT === undefined && this.targetT === 0 && elapsed < 0) {
        this.inputsChanged = false; // Countdown rows stay in the timeline until frame zero is due.
        if (go) this.setStage(Math.min(3, Math.ceil(-elapsed / 1000)) as CountdownStage);
        return;
      }
      this.setStage(terminal ? null : elapsed < 600 ? 'GO' : null);
      const targetT = terminalT ?? pvpTargetTick(elapsed, this.targetT);
      const localFrame = go && !terminal && !this.quitRequested ? pvpSampleFrame(this.targetT, targetT, go.delay) : null;
      if (localFrame !== null) {
        if (this.targetT === 0) this.input.setInputMode('active');
        const sampled = this.input.sampleAction(current, this.seat);
        const { mx, my, msg } = sampled;
        let { act, ax, ay } = sampled;
        const lost = this.requeued;
        if (lost) {
          this.requeued = null;
          // Fire the dropped action now (≈ pressed a moment later) unless something newer was pressed or it is stale
          if (act === 0 && localFrame - lost.frame <= REQUEUE_MAX_FRAMES) ({ act, ax, ay } = lost);
        }
        const action = [mx, my, act, ax, ay, msg] as const;
        this.timeline.sample(localFrame, action);
        this.link.input(localFrame, action);
      }
      if (!this.inputsChanged && targetT === this.targetT && !terminal) return;
      this.inputsChanged = false;
      this.targetT = targetT;
      const update = this.timeline.plan(this.confirmedT, current.t, targetT, terminalT);
      if (!update.confirmed.length && !update.prediction && !terminal) return;
      const { result } = await this.rpc({ type: 'pvp_update', update }) as { result: PvpSimulationResult };
      if (this.stopped) return;
      this.confirmedT = result.confirmedT;
      this.timeline.commit(update, result.state.t);
      for (const { frame, hash } of result.hashes) this.link.hash(frame, hash);
      if (result.end) {
        this.awaitingTerminal = true;
        this.input.setInputMode('off');
        this.link.end(result.end);
      }
      if (update.rollbackFrames) this.link.setRollbackFrames(update.rollbackFrames);

      const ended = result.confirmedOver || terminalT !== undefined;
      // The branches can emit the same event in this batch. Deduplicate each
      // independently so matching events across the two branches count once.
      const events = [
        ...this.dedup.take(result.confirmedEvents.flat()),
        ...this.dedup.take(result.predictedEvents.flat().filter((event) => event.name !== 'END')),
      ].sort((a, b) => a.t - b.t);
      let display: TickSnapshot = {
        ...result.state, events, timestampMs: performance.now(),
        over: ended, winner: result.confirmedOver ? result.state.winner : -2,
      };
      if (terminal && !result.confirmedOver) {
        const winner = terminal.reason === 'forfeit' ? terminal.winner : -1;
        display = {
          ...display, winner,
          players: display.players.map((player, seat) => ({ ...player, rank: winner < 0 || winner === seat ? 1 : 2 })),
        };
      }
      this.current = display;
      if (display.t !== current.t || update.prediction || events.length || ended) {
        const previous = display.t <= current.t ? display : current;
        this.callbacks.onTick(previous, display, PVP_TICK_MS, Boolean(update.rollbackFrames));
      }
      if (terminal) {
        // Only the relay knows the final cutoff if a quit races an end report.
        await this.finish(display, result.confirmedOver && terminal?.reason !== 'timeout' ? null : terminal);
      }
    } catch (err) {
      if (!this.stopped) this.fail(err instanceof Error ? err.message : String(err));
    } finally {
      this.updating = false;
      if (this.terminal || (this.inputsChanged && !this.awaitingTerminal)) {
        this.schedule(0);
      } else if (this.go && !this.awaitingTerminal && this.targetT < PVP_MAX_FRAMES) {
        const untilGo = this.go.startAt - this.link.serverNow();
        const untilNext = untilGo > 0 ? (untilGo % 1000 || 1000) : untilGo + this.targetT * PVP_TICK_MS;
        this.schedule(Math.max(0, Math.ceil(untilNext)));
      }
    }
  }

  private async finish(state: TickSnapshot, terminal: MatchTerminal | null) {
    this.stopClock();
    this.input.setInputMode('off');
    const response = await this.rpc({ type: 'pvp_history', throughT: this.confirmedT });
    if (this.stopped) return;
    this.history = response.ticks as TickSnapshot[];
    this.finished = true;
    this.terminateWorker();
    if (terminal?.reason === 'forfeit') {
      const won = terminal.winner === this.seat;
      this.resultNote = terminal.cause === 'disconnect'
        ? (won ? '对方断线超时' : '你断线超时')
        : (won ? '对方已弃权' : '你已弃权');
    } else if (terminal?.reason === 'timeout') {
      this.resultNote = '对局超时';
    }
    if (this.resultNote) this.callbacks.onNotice(this.resultNote);
    this.callbacks.onMatchOver(state);
  }
}
