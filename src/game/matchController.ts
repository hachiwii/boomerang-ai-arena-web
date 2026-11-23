import { HumanInputController } from './humanInput';
import { CinematicDirector, normalizeCinematicOptions } from './killCamDirector';
import { CinematicOptions } from './settings';
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

export interface StreamingAiCallbacks {
  onStatus?: (msg: string) => void;
  onInit: (mapData: EngineMapData, ticks: TickSnapshot[], simComplete: boolean) => Promise<void> | void;
  onProgress: (ticks: TickSnapshot[], simComplete: boolean) => void;
  onError?: (err: string) => void;
}

export interface MatchCallbacks {
  onMapLoaded: (
    mapData: EngineMapData,
    initialState: TickSnapshot,
    director?: CinematicDirector | null,
  ) => Promise<void> | void;
  onTick: (prevState: TickSnapshot, nextState: TickSnapshot, tickDurationMs: number) => void;
  onMatchOver: (finalState: TickSnapshot, director?: CinematicDirector | null) => void;
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
  private simSessionSeq = 0;

  private currentState: TickSnapshot | null = null;
  private recordedTicks: TickSnapshot[] = [];
  private precomputedTicks: TickSnapshot[] | null = null;
  private precomputedIndex = 0;
  private mapDataCache: EngineMapData | null = null;
  private cinematicDirector: CinematicDirector | null = null;
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

  public getRecordedTicks(): TickSnapshot[] {
    return this.recordedTicks;
  }

  public isRunning(): boolean {
    return this.running;
  }

  public getCinematicDirector(): CinematicDirector | null {
    return this.cinematicDirector;
  }

  public setCinematicOptions(opts: boolean | Partial<CinematicOptions>): CinematicDirector | null {
    if (!this.precomputedTicks || !this.mapDataCache) return null;
    this.cinematicDirector = new CinematicDirector(
      this.precomputedTicks,
      this.mapDataCache,
      normalizeCinematicOptions(opts),
    );
    return this.cinematicDirector;
  }

  public setCliffGuard(enabled: boolean) {
    this.input.setCliffGuard(enabled);
    if (this.config) {
      this.config.cliffGuard = enabled;
    }
  }

  public setDashGuard(enabled: boolean) {
    if (this.config) {
      this.config.dashGuard = enabled;
    }
    this.engineWorker?.postMessage({ type: 'set_cliff_guard', enabled });
  }

  public setHumanSlashTicks(ticks: number) {
    if (this.config) {
      this.config.humanSlashTicks = ticks;
    }
    this.engineWorker?.postMessage({ type: 'set_slash_ticks', ticks });
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

  public async start(config: MatchConfig, opts?: { cinematic?: Partial<CinematicOptions> }): Promise<void> {
    this.stop();
    this.stopped = false;
    this.config = config;
    this.gameSpeed = Math.max(0.1, Math.min(2.0, config.speed || 1.0));
    this.tickIntervalMs = LOGIC_DT_MS / this.gameSpeed;
    this.tickTimes = [];
    this.actualLogicHz = LOGIC_HZ * this.gameSpeed;
    this.lastBotMaxMs = 0;
    this.precomputedTicks = null;
    this.precomputedIndex = 0;
    this.mapDataCache = null;
    this.cinematicDirector = null;

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
      cliffGuard: config.dashGuard ?? config.cliffGuard,
      humanSlashTicks: config.humanSlashTicks ?? 5,
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

    this.mapDataCache = mapData;
    const cinematicCfg = normalizeCinematicOptions(opts?.cinematic);
    // Pure AI match needs accelerated pre-simulation only when pre-kill slow-mo (killCam or finisherCam) is enabled;
    // if only winnerCam is enabled, it runs live and glides to winner close-up on match end!
    const useAcceleratedKillCam = this.humanSeat < 0 && (cinematicCfg.killCam || cinematicCfg.finisherCam);

    if (useAcceleratedKillCam) {
      // Pure AI spectator match with kill-cam enabled: accelerate full WASM simulation first
      // so we know every upcoming kill 0.5s in advance for slow-mo eye-level camera choreography!
      this.callbacks.onStatus?.('⚡ 高速推演 AI 对局中...');
      const allTicks: TickSnapshot[] = [initialState];
      let curObs = initialObs;
      let curSnap = initialState;
      const n = config.slots.length;
      let lastYieldMs = performance.now();

      while (!curSnap.over) {
        if (this.stopped || !this.engineWorker) return;

        this.dispatchBots(curObs);
        const botResults = await Promise.all(
          this.pendingBots.map(async (p) => ({ seat: p.seat, ...(await p.promise) })),
        );
        if (this.stopped || !this.engineWorker) return;

        let maxMs = 0;
        const actionLines: string[] = new Array(n).fill('0 0 0 0 0 0');
        for (const r of botResults) {
          actionLines[r.seat] = r.action;
          if (r.ms > maxMs) maxMs = r.ms;
        }
        this.lastBotMaxMs = maxMs;

        const stepRes = await this.rpc(this.engineWorker, {
          type: 'step',
          actionsText: actionLines.join('\n'),
          botSeats: this.botSeats,
          dashTarget: null,
        });
        if (this.stopped) return;

        curSnap = stepRes.state as TickSnapshot;
        curObs = stepRes.obs as Record<number, string>;
        allTicks.push(curSnap);

        const now = performance.now();
        if (now - lastYieldMs >= 35) {
          lastYieldMs = now;
          this.callbacks.onStatus?.(`⚡ 高速推演 AI 对局中... (${(curSnap.t / 20).toFixed(1)}s)`);
          await new Promise((r) => window.setTimeout(r, 0));
        }
      }
      if (this.stopped) return;

      // Free WASM workers immediately once simulation is complete!
      this.terminateWorkers();

      this.precomputedTicks = allTicks;
      this.precomputedIndex = 0;
      this.currentState = allTicks[0];
      this.recordedTicks = allTicks;
      this.cinematicDirector = new CinematicDirector(allTicks, mapData, cinematicCfg);

      await this.callbacks.onMapLoaded(mapData, allTicks[0], this.cinematicDirector);
      if (this.stopped) return;

      this.input.reset();
      this.input.setInputMode('off');

      if (allTicks.length <= 1) {
        this.callbacks.onCountdown?.(null);
        this.running = false;
        this.callbacks.onMatchOver(allTicks[0], this.cinematicDirector);
        return;
      }

      this.startPreMatchCountdown(() => {
        this.running = true;
        this.nextTickDeadline = performance.now();
        this.scheduleNextTick();
      });
      return;
    }

    this.currentState = initialState;
    this.recordedTicks = [initialState];
    await this.callbacks.onMapLoaded(mapData, initialState, null);
    if (this.stopped) return;

    // Configure human input timing & pre-dispatch tick 0 bot decisions immediately
    this.input.reset();
    this.input.setMapData(mapData);
    this.input.setCliffGuard(config.cliffGuard);
    this.input.setTickIntervalMs(this.tickIntervalMs);
    this.dispatchBots(initialObs);

    // 3-second real-time pre-match countdown (3 -> 2 -> 1 -> GO!) for both human & pure-AI matches
    this.input.setInputMode(this.humanSeat >= 0 ? 'countdown' : 'off');
    this.startPreMatchCountdown(() => {
      if (this.humanSeat >= 0) {
        this.input.setInputMode('active');
      }
      this.running = true;
      this.nextTickDeadline = performance.now();
      this.scheduleNextTick();
    });
  }

  private startPreMatchCountdown(onGo: () => void) {
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
      this.callbacks.onCountdown?.('GO');
      onGo();
    });
    scheduleStep(3550, () => {
      this.callbacks.onCountdown?.(null);
    });
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
      if (this.precomputedTicks) {
        this.executePrecomputedTick();
      } else {
        void this.executeTick();
      }
    }, wait);
  }

  private getPrecomputedTickIntervalMs(tickIdx: number): number {
    const scale = this.cinematicDirector?.getSpeedScaleAtSim(tickIdx * (LOGIC_DT_MS / 1000)) ?? 1.0;
    return LOGIC_DT_MS / (this.gameSpeed * scale);
  }

  private executePrecomputedTick() {
    if (!this.running || this.stopped || !this.precomputedTicks) return;
    const ticks = this.precomputedTicks;
    const maxIdx = ticks.length - 1;
    if (this.precomputedIndex >= maxIdx) {
      this.running = false;
      this.callbacks.onMatchOver(ticks[maxIdx], this.cinematicDirector);
      return;
    }

    const prevIdx = this.precomputedIndex;
    const prev = ticks[prevIdx];
    const intervalMs = this.getPrecomputedTickIntervalMs(prevIdx);
    this.precomputedIndex++;
    const curr = ticks[this.precomputedIndex];
    const tickNow = performance.now();
    curr.timestampMs = tickNow;

    const scale = this.cinematicDirector?.getSpeedScaleAtSim(prevIdx * (LOGIC_DT_MS / 1000)) ?? 1.0;
    this.actualLogicHz = LOGIC_HZ * this.gameSpeed * scale;
    this.currentState = curr;
    this.callbacks.onTick(prev, curr, intervalMs);

    if (this.precomputedIndex >= maxIdx || curr.over) {
      this.running = false;
      this.callbacks.onMatchOver(curr, this.cinematicDirector);
      return;
    }

    this.nextTickDeadline += intervalMs;
    const maxLag = Math.max(250, intervalMs * 3);
    if (tickNow - this.nextTickDeadline > maxLag) {
      this.nextTickDeadline = tickNow + intervalMs;
    }
    this.scheduleNextTick();
  }

  private terminateWorkers() {
    if (this.engineWorker) {
      this.engineWorker.terminate();
      this.engineWorker = null;
    }
    for (const w of this.botWorkers.values()) {
      w.terminate();
    }
    this.botWorkers.clear();
    this.pendingBots = [];
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
      let dashTarget: [number, number] | null = null;
      if (this.humanSeat >= 0) {
        const ha = this.input.sampleAction(prevState, this.humanSeat);
        actionLines[this.humanSeat] = `${ha.mx} ${ha.my} ${ha.act} ${ha.ax} ${ha.ay} ${ha.msg}`;
        if (ha.act === 3 && typeof ha.dashTargetX === 'number' && typeof ha.dashTargetY === 'number') {
          dashTarget = [ha.dashTargetX, ha.dashTargetY];
        }
      }

      const stepRes = await this.rpc(this.engineWorker, {
        type: 'step',
        actionsText: actionLines.join('\n'),
        botSeats: this.botSeats,
        dashTarget,
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
      this.recordedTicks.push(nextState);
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

  /**
   * Starts a custom pure-AI match in streaming replay mode:
   * enters playback immediately after a tiny initial lookahead buffer (~0.7s) while
   * WASM engine + bot workers keep simulating ahead at max speed in the background,
   * extending `ticks[]` live so the Replay HUD timeline max grows in real time!
   */
  public async startStreamingAiSim(config: MatchConfig, cb: StreamingAiCallbacks): Promise<void> {
    this.stop();
    const mySeq = ++this.simSessionSeq;
    this.stopped = false;
    this.config = config;
    this.gameSpeed = Math.max(0.1, Math.min(2.0, config.speed || 1.0));
    this.humanSeat = -1;
    this.botSeats = [];
    config.slots.forEach((s, i) => {
      if (s.kind === 'bot') this.botSeats.push(i);
    });

    const origin = window.location.origin;

    cb.onStatus?.('加载地图与引擎 WASM...');
    const mapResp = await fetch(`${origin}/assets/maps/${config.mapId}.txt?v=${__BUILD_ID__}`);
    if (!mapResp.ok) throw new Error(`无法加载地图 ${config.mapId}`);
    const mapText = await mapResp.text();
    if (this.stopped || this.simSessionSeq !== mySeq) return;

    this.engineWorker = new Worker(new URL('../workers/engineWorker.ts', import.meta.url), { type: 'module' });
    const initRes = await this.rpc(this.engineWorker, {
      type: 'init',
      origin,
      buildId: __BUILD_ID__,
      mapText,
      nPlayers: config.slots.length,
      seed: config.seed,
      botSeats: this.botSeats,
      humanSeat: -1,
      cliffGuard: config.cliffGuard,
    });
    if (this.stopped || this.simSessionSeq !== mySeq) return;

    const mapData = initRes.mapData as EngineMapData;
    const initialState = initRes.state as TickSnapshot;
    initialState.timestampMs = performance.now();
    const headers = initRes.headers as Record<number, string>;
    let curObs = initRes.obs as Record<number, string>;

    if (this.botSeats.length > 0) {
      cb.onStatus?.(`启动 ${this.botSeats.length} 个 AI WASM 实例...`);
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
    if (this.stopped || this.simSessionSeq !== mySeq) return;

    const allTicks: TickSnapshot[] = [initialState];
    this.recordedTicks = allTicks;
    this.mapDataCache = mapData;
    let curSnap = initialState;
    const n = config.slots.length;

    const stepOne = async (): Promise<boolean> => {
      if (this.stopped || this.simSessionSeq !== mySeq || !this.engineWorker || curSnap.over) {
        return false;
      }
      this.dispatchBots(curObs);
      const botResults = await Promise.all(
        this.pendingBots.map(async (p) => ({ seat: p.seat, ...(await p.promise) })),
      );
      if (this.stopped || this.simSessionSeq !== mySeq || !this.engineWorker) return false;

      let maxMs = 0;
      const actionLines: string[] = new Array(n).fill('0 0 0 0 0 0');
      for (const r of botResults) {
        actionLines[r.seat] = r.action;
        if (r.ms > maxMs) maxMs = r.ms;
      }
      this.lastBotMaxMs = maxMs;

      const stepRes = await this.rpc(this.engineWorker, {
        type: 'step',
        actionsText: actionLines.join('\n'),
        botSeats: this.botSeats,
        dashTarget: null,
      });
      if (this.stopped || this.simSessionSeq !== mySeq) return false;

      curSnap = stepRes.state as TickSnapshot;
      curObs = stepRes.obs as Record<number, string>;
      allTicks.push(curSnap);
      return true;
    };

    // Tiny initial warm-up burst (~14 ticks = 0.70s) so even early kills have 0.5s lookahead ready
    const INITIAL_BUFFER_TICKS = 14;
    while (!curSnap.over && allTicks.length <= INITIAL_BUFFER_TICKS) {
      const ok = await stepOne();
      if (!ok) return;
    }
    if (this.stopped || this.simSessionSeq !== mySeq) return;

    const alreadyComplete = Boolean(curSnap.over);
    if (alreadyComplete) {
      this.terminateWorkers();
    }

    await cb.onInit(mapData, allTicks, alreadyComplete);
    if (alreadyComplete || this.stopped || this.simSessionSeq !== mySeq) return;

    // Continue computing remaining match ticks asynchronously in the background without blocking rendering!
    void (async () => {
      let lastYieldMs = performance.now();
      let lastNotifyMs = lastYieldMs;
      let dirtySinceNotify = false;
      try {
        while (!curSnap.over) {
          const ok = await stepOne();
          if (!ok || this.stopped || this.simSessionSeq !== mySeq) return;
          dirtySinceNotify = true;

          const hasDeath = curSnap.events.some((ev) => ev.name === 'DEATH');
          const now = performance.now();
          if (hasDeath || now - lastNotifyMs >= 45) {
            lastNotifyMs = now;
            dirtySinceNotify = false;
            cb.onProgress(allTicks, Boolean(curSnap.over));
          }
          if (now - lastYieldMs >= 10) {
            lastYieldMs = now;
            await new Promise((r) => window.setTimeout(r, 0));
          }
        }
        if (this.stopped || this.simSessionSeq !== mySeq) return;
        this.terminateWorkers();
        if (dirtySinceNotify || curSnap.over) {
          cb.onProgress(allTicks, true);
        }
      } catch (err) {
        if (!this.stopped && this.simSessionSeq === mySeq) {
          this.terminateWorkers();
          cb.onError?.(err instanceof Error ? err.message : String(err));
        }
      }
    })();
  }

  public stop() {
    this.simSessionSeq++;
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
    this.terminateWorkers();
    this.currentState = null;
    this.recordedTicks = [];
    this.precomputedTicks = null;
    this.precomputedIndex = 0;
    this.mapDataCache = null;
    this.cinematicDirector = null;
  }
}
