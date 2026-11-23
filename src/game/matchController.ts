import { HumanInputController } from './humanInput';
import {
  EngineMapData,
  LOGIC_DT_MS,
  LOGIC_HZ,
  MatchConfig,
  TickSnapshot,
} from './types';

interface PendingBotDecision {
  seat: number;
  promise: Promise<{ action: string; ms: number }>;
}

export type CountdownStage = 3 | 2 | 1 | 'GO' | null;

export interface MatchCallbacks {
  onMapLoaded: (mapData: EngineMapData, initialState: TickSnapshot) => Promise<void> | void;
  onTick: (prevState: TickSnapshot, nextState: TickSnapshot, tickDurationMs: number) => void;
  onMatchOver: (finalState: TickSnapshot) => void;
  onCountdown?: (stage: CountdownStage) => void;
  onStatus?: (msg: string) => void;
  onError?: (err: string) => void;
}

/**
 * Coordinates the authoritative WASM engine worker and per-seat WASM bot workers
 * on a rock-solid 20Hz fixed logic clock (50ms/tick) with pipelined bot thinking.
 */
export class MatchController {
  private engineWorker: Worker | null = null;
  private botWorkers = new Map<number, Worker>();
  private reqCounter = 1;

  private config: MatchConfig | null = null;
  private humanSeat = -1;
  private botSeats: number[] = [];
  private running = false;
  private stopped = false;

  private currentState: TickSnapshot | null = null;
  private tickIntervalMs = LOGIC_DT_MS;
  private gameSpeed = 1.0;
  private nextTickDeadline = 0;
  private timerHandle: number | null = null;
  private countdownTimers: number[] = [];
  private pendingBots: PendingBotDecision[] = [];
  private stepping = false;

  // Measured logic tick rate telemetry
  public actualLogicHz = LOGIC_HZ;
  public lastBotMaxMs = 0;
  private tickTimes: number[] = [];

  private input: HumanInputController;
  private callbacks: MatchCallbacks;

  constructor(input: HumanInputController, callbacks: MatchCallbacks) {
    this.input = input;
    this.callbacks = callbacks;
  }

  public getHumanSeat(): number {
    return this.humanSeat;
  }

  public getCurrentState(): TickSnapshot | null {
    return this.currentState;
  }

  public isRunning(): boolean {
    return this.running;
  }

  public setCliffGuard(enabled: boolean) {
    this.input.setCliffGuard(enabled);
    if (this.config) {
      this.config.cliffGuard = enabled;
    }
    this.engineWorker?.postMessage({ type: 'set_cliff_guard', enabled });
  }

  private rpc(worker: Worker, payload: Record<string, unknown>, timeoutMs = 15000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const reqId = this.reqCounter++;
      let done = false;
      const timer = window.setTimeout(() => {
        if (done) return;
        done = true;
        worker.removeEventListener('message', onMsg);
        reject(new Error(`Worker RPC timeout (${String(payload.type)})`));
      }, timeoutMs);

      const onMsg = (ev: MessageEvent) => {
        const d = ev.data;
        if (!d || d.reqId !== reqId) return;
        done = true;
        window.clearTimeout(timer);
        worker.removeEventListener('message', onMsg);
        if (d.type === 'error') {
          reject(new Error(d.error || 'Worker error'));
        } else {
          resolve(d);
        }
      };

      worker.addEventListener('message', onMsg);
      worker.postMessage({ ...payload, reqId });
    });
  }

  public async start(config: MatchConfig): Promise<void> {
    this.stop();
    this.stopped = false;
    this.config = config;
    this.gameSpeed = Math.max(0.1, Math.min(2.0, config.speed || 1.0));
    this.tickIntervalMs = LOGIC_DT_MS / this.gameSpeed;
    this.tickTimes = [];
    this.actualLogicHz = LOGIC_HZ * this.gameSpeed;
    this.lastBotMaxMs = 0;

    this.humanSeat = config.slots.findIndex((s) => s.kind === 'human');
    this.botSeats = [];
    config.slots.forEach((s, i) => {
      if (s.kind === 'bot') this.botSeats.push(i);
    });

    const origin = window.location.origin;

    this.callbacks.onStatus?.('加载地图与引擎 WASM...');
    const mapResp = await fetch(`${origin}/assets/maps/${config.mapId}.txt?v=${__BUILD_ID__}`);
    if (!mapResp.ok) throw new Error(`无法加载地图 ${config.mapId}`);
    const mapText = await mapResp.text();
    if (this.stopped) return;

    this.engineWorker = new Worker(new URL('../workers/engineWorker.ts', import.meta.url), { type: 'module' });
    const initRes = await this.rpc(this.engineWorker, {
      type: 'init',
      origin,
      buildId: __BUILD_ID__,
      mapText,
      nPlayers: config.slots.length,
      seed: config.seed,
      botSeats: this.botSeats,
      humanSeat: this.humanSeat,
      cliffGuard: config.cliffGuard,
    });
    if (this.stopped) return;

    const mapData = initRes.mapData as EngineMapData;
    const initialState = initRes.state as TickSnapshot;
    initialState.timestampMs = performance.now();
    const headers = initRes.headers as Record<number, string>;
    const initialObs = initRes.obs as Record<number, string>;

    // Spawn one isolated Web Worker per bot seat (allows duplicate bots with zero shared memory!)
    if (this.botSeats.length > 0) {
      this.callbacks.onStatus?.(`启动 ${this.botSeats.length} 个 AI WASM 实例...`);
      await Promise.all(
        this.botSeats.map(async (seat) => {
          const slot = config.slots[seat];
          const w = new Worker(new URL('../workers/botWorker.ts', import.meta.url), { type: 'module' });
          this.botWorkers.set(seat, w);
          const res = await this.rpc(w, {
            type: 'init',
            origin,
            buildId: __BUILD_ID__,
            botId: slot.botId!,
            header: headers[seat],
          });
          if (!res.ok) {
            throw new Error(`Bot ${slot.displayName} 初始化失败`);
          }
        }),
      );
    }
    if (this.stopped) return;

    this.currentState = initialState;
    await this.callbacks.onMapLoaded(mapData, initialState);
    if (this.stopped) return;

    // Configure human input timing & pre-dispatch tick 0 bot decisions immediately
    this.input.reset();
    this.input.setMapData(mapData);
    this.input.setCliffGuard(config.cliffGuard);
    this.input.setTickIntervalMs(this.tickIntervalMs);
    this.dispatchBots(initialObs);

    if (this.humanSeat >= 0) {
      // Human match: 3-second real-time pre-match countdown (3 -> 2 -> 1 -> GO!)
      this.input.setInputMode('countdown');
      this.clearCountdownTimers();
      this.callbacks.onCountdown?.(3);

      const scheduleStep = (delayMs: number, fn: () => void) => {
        const h = window.setTimeout(() => {
          if (this.stopped) return;
          fn();
        }, delayMs);
        this.countdownTimers.push(h);
      };

      scheduleStep(1000, () => {
        this.callbacks.onCountdown?.(2);
      });
      scheduleStep(2000, () => {
        this.callbacks.onCountdown?.(1);
      });
      scheduleStep(3000, () => {
        this.input.setInputMode('active');
        this.callbacks.onCountdown?.('GO');
        this.running = true;
        this.nextTickDeadline = performance.now();
        this.scheduleNextTick();
      });
      scheduleStep(3550, () => {
        this.callbacks.onCountdown?.(null);
      });
    } else {
      // Pure AI spectator match: brief 450ms pause without 3-second countdown
      this.input.setInputMode('off');
      this.callbacks.onCountdown?.(null);
      this.running = true;
      this.nextTickDeadline = performance.now() + 450;
      this.scheduleNextTick();
    }
  }

  private clearCountdownTimers() {
    for (const h of this.countdownTimers) {
      window.clearTimeout(h);
    }
    this.countdownTimers = [];
  }

  private dispatchBots(obsMap: Record<number, string>) {
    this.pendingBots = [];
    for (const seat of this.botSeats) {
      const obs = obsMap[seat];
      const w = this.botWorkers.get(seat);
      if (!obs || !w) continue;
      const promise = this.rpc(w, { type: 'decide', obs }, 500)
        .then((res) => ({
          action: String(res.action || '0 0 0 0 0 0'),
          ms: Number(res.ms || 0),
        }))
        .catch(() => ({ action: '0 0 0 0 0 0', ms: 0 }));
      this.pendingBots.push({ seat, promise });
    }
  }

  private scheduleNextTick() {
    if (!this.running || this.stopped) return;
    const now = performance.now();
    const wait = Math.max(0, this.nextTickDeadline - now);
    this.timerHandle = window.setTimeout(() => {
      void this.executeTick();
    }, wait);
  }

  private async executeTick() {
    if (!this.running || this.stopped || this.stepping || !this.engineWorker || !this.currentState || !this.config) {
      return;
    }
    this.stepping = true;
    const prevState = this.currentState;
    const n = this.config.slots.length;

    try {
      // Wait for pipelined bot decisions (usually already resolved in 0ms!)
      const botResults = await Promise.all(
        this.pendingBots.map(async (p) => ({ seat: p.seat, ...(await p.promise) })),
      );
      if (!this.running || this.stopped) return;

      let maxMs = 0;
      const actionLines: string[] = new Array(n).fill('0 0 0 0 0 0');
      for (const r of botResults) {
        actionLines[r.seat] = r.action;
        if (r.ms > maxMs) maxMs = r.ms;
      }
      this.lastBotMaxMs = maxMs;

      // Sample human input right at the tick boundary for minimum latency!
      if (this.humanSeat >= 0) {
        const ha = this.input.sampleAction(prevState, this.humanSeat);
        actionLines[this.humanSeat] = `${ha.mx} ${ha.my} ${ha.act} ${ha.ax} ${ha.ay} ${ha.msg}`;
      }

      const stepRes = await this.rpc(this.engineWorker, {
        type: 'step',
        actionsText: actionLines.join('\n'),
        botSeats: this.botSeats,
      });
      if (!this.running || this.stopped) return;

      const tickNow = performance.now();
      const nextState = stepRes.state as TickSnapshot;
      nextState.timestampMs = tickNow;
      const nextObs = stepRes.obs as Record<number, string>;

      // Update measured logic tick Hz (adaptive rolling window ~1s across 0.1x..2.0x)
      const maxWin = Math.max(4, Math.min(25, Math.round(LOGIC_HZ * this.gameSpeed) + 1));
      this.tickTimes.push(tickNow);
      while (this.tickTimes.length > maxWin) this.tickTimes.shift();
      if (this.tickTimes.length >= 2) {
        const span = this.tickTimes[this.tickTimes.length - 1] - this.tickTimes[0];
        if (span > 0) {
          this.actualLogicHz = ((this.tickTimes.length - 1) * 1000) / span;
        }
      }

      this.currentState = nextState;
      this.callbacks.onTick(prevState, nextState, this.tickIntervalMs);

      if (nextState.over) {
        this.running = false;
        this.input.setEnabled(false);
        this.callbacks.onMatchOver(nextState);
        return;
      }

      // Immediately start bots thinking for next tick while we wait out the tick interval!
      this.dispatchBots(nextObs);

      // Drift-corrected logic clock (resync cleanly if tab was backgrounded)
      this.nextTickDeadline += this.tickIntervalMs;
      const maxLag = Math.max(150, this.tickIntervalMs * 3);
      if (tickNow - this.nextTickDeadline > maxLag) {
        this.nextTickDeadline = tickNow + this.tickIntervalMs;
      }
    } catch (err) {
      if (!this.stopped) {
        this.running = false;
        this.callbacks.onError?.(err instanceof Error ? err.message : String(err));
      }
      return;
    } finally {
      this.stepping = false;
    }

    this.scheduleNextTick();
  }

  public stop() {
    this.stopped = true;
    this.running = false;
    this.stepping = false;
    this.clearCountdownTimers();
    this.callbacks.onCountdown?.(null);
    this.input.setInputMode('off');
    this.input.setMapData(null);
    if (this.timerHandle !== null) {
      window.clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
    if (this.engineWorker) {
      this.engineWorker.terminate();
      this.engineWorker = null;
    }
    for (const w of this.botWorkers.values()) {
      w.terminate();
    }
    this.botWorkers.clear();
    this.pendingBots = [];
    this.currentState = null;
  }
}
