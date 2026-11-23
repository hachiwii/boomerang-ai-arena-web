import { GameRenderer } from '../render/renderer';
import { CinematicDirector, normalizeCinematicOptions } from './killCamDirector';
import { CountdownStage } from './matchController';
import { MatchReplayBundle } from './matchHistory';
import { CinematicOptions } from './settings';
import { LOGIC_DT_MS, TickSnapshot } from './types';

export interface ReplayPlaybackState {
  tickIndex: number;
  maxIndex: number;
  paused: boolean;
  finished: boolean;
  speed: number;
  computing: boolean;
}

export interface ReplayCallbacks {
  onLoaded: (bundle: MatchReplayBundle, state: ReplayPlaybackState) => void;
  onTick: (snapshot: TickSnapshot, state: ReplayPlaybackState) => void;
  onStateChange: (state: ReplayPlaybackState) => void;
  onTimelineExtended?: (bundle: MatchReplayBundle, state: ReplayPlaybackState) => void;
  onCountdown?: (stage: CountdownStage) => void;
}

/**
 * Pure spectator-perspective match replay driver.
 * Plays back recorded TickSnapshots directly into GameRenderer with humanSeat = -1
 * (full visibility, zero WASM/bot overhead, instant timeline scrubbing, pause & speed control).
 */
export class ReplayController {
  private readonly renderer: GameRenderer;
  private readonly callbacks: ReplayCallbacks;

  private bundle: MatchReplayBundle | null = null;
  private director: CinematicDirector | null = null;
  private cinematicOpts: CinematicOptions = { killCam: true, finisherCam: true, winnerCam: true };
  private tickIndex = 0;
  private speed = 1.0;
  private paused = false;
  private finished = false;
  private simComplete = true;
  private waitingForSim = false;
  private scannedTicks = 0;
  private knownDeathCount = 0;
  private active = false;
  private inCountdown = false;
  private sessionSeq = 0;

  private timerHandle: number | null = null;
  private countdownTimers: number[] = [];
  private nextTickDeadline = 0;

  constructor(renderer: GameRenderer, callbacks: ReplayCallbacks) {
    this.renderer = renderer;
    this.callbacks = callbacks;
  }

  public isActive(): boolean {
    return this.active;
  }

  public getBundle(): MatchReplayBundle | null {
    return this.bundle;
  }

  public getSpeed(): number {
    return this.speed;
  }

  public getState(): ReplayPlaybackState {
    const maxIndex = this.bundle ? Math.max(0, this.bundle.replay.ticks.length - 1) : 0;
    return {
      tickIndex: this.tickIndex,
      maxIndex,
      paused: this.paused,
      finished: this.finished,
      speed: this.speed,
      computing: !this.simComplete,
    };
  }

  private getTickIntervalMs(tickIdx = this.tickIndex): number {
    const scale = this.director?.getSpeedScaleAtSim(tickIdx * (LOGIC_DT_MS / 1000)) ?? 1.0;
    return LOGIC_DT_MS / (this.speed * scale);
  }

  private scanNewDeaths(ticks: TickSnapshot[]): number {
    let added = 0;
    const start = Math.max(1, this.scannedTicks);
    for (let i = start; i < ticks.length; i++) {
      const evs = ticks[i].events;
      for (let j = 0; j < evs.length; j++) {
        if (evs[j].name === 'DEATH') added++;
      }
    }
    this.scannedTicks = ticks.length;
    this.knownDeathCount += added;
    return added;
  }

  public setCinematicOptions(opts: boolean | Partial<CinematicOptions>) {
    this.cinematicOpts = normalizeCinematicOptions(opts);
    if (!this.active || !this.bundle) return;
    this.director = new CinematicDirector(
      this.bundle.replay.ticks,
      this.bundle.replay.mapData,
      this.cinematicOpts,
      undefined,
      this.simComplete,
    );
    this.renderer.setCinematicDirector(this.director);
    this.renderer.setPlaybackSpeed(this.speed);
    if (!this.paused && !this.finished && !this.waitingForSim && !this.inCountdown) {
      this.clearTimer();
      this.nextTickDeadline = performance.now() + this.getTickIntervalMs();
      this.scheduleNextTick();
    }
  }

  public async start(
    bundle: MatchReplayBundle,
    initialSpeed = 1.0,
    cinematicOpts?: boolean | Partial<CinematicOptions>,
    simComplete = true,
    opts?: { countdown?: boolean },
  ): Promise<void> {
    this.stop();
    const mySeq = ++this.sessionSeq;
    const ticks = bundle.replay.ticks;
    if (!ticks || ticks.length === 0) {
      throw new Error('回放数据为空');
    }

    if (cinematicOpts !== undefined) {
      this.cinematicOpts = normalizeCinematicOptions(cinematicOpts);
    }
    this.bundle = bundle;
    this.speed = Math.max(0.1, Math.min(2.0, initialSpeed || 1.0));
    this.tickIndex = 0;
    this.paused = false;
    this.simComplete = simComplete;
    this.waitingForSim = !simComplete && ticks.length <= 1;
    this.finished = simComplete && ticks.length <= 1;
    this.scannedTicks = 0;
    this.knownDeathCount = 0;
    this.scanNewDeaths(ticks);
    this.active = true;

    // Spectator perspective: humanSeat = -1 (full map visibility, no aim cursor/reticle)
    await this.renderer.setupMatch(
      bundle.replay.mapData,
      bundle.summary.mapTheme,
      bundle.summary.slots,
      ticks[0],
      -1,
      this.speed,
    );
    if (this.sessionSeq !== mySeq || !this.active) return;

    this.director = new CinematicDirector(
      ticks,
      bundle.replay.mapData,
      this.cinematicOpts,
      undefined,
      this.simComplete,
    );
    this.renderer.setCinematicDirector(this.director);
    this.renderer.setPlaybackSpeed(this.speed);

    const st = this.getState();
    this.callbacks.onLoaded(bundle, st);
    this.callbacks.onTick(ticks[0], st);

    if (this.finished) return;

    if (opts?.countdown) {
      this.inCountdown = true;
      this.clearCountdownTimers();
      this.callbacks.onCountdown?.(3);

      const scheduleStep = (delayMs: number, fn: () => void) => {
        const h = window.setTimeout(() => {
          if (this.sessionSeq !== mySeq || !this.active || !this.inCountdown) return;
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
        this.inCountdown = false;
        this.callbacks.onCountdown?.('GO');
        if (!this.paused && !this.finished && !this.waitingForSim) {
          this.nextTickDeadline = performance.now();
          this.scheduleNextTick();
        }
      });
      const hideGoTimer = window.setTimeout(() => {
        if (this.sessionSeq !== mySeq || !this.active) return;
        this.callbacks.onCountdown?.(null);
      }, 3550);
      this.countdownTimers.push(hideGoTimer);
    } else if (!this.waitingForSim) {
      this.nextTickDeadline = performance.now() + 320;
      this.scheduleNextTick();
    }
  }

  /**
   * Called as background AI simulation appends newly computed ticks into `bundle.replay.ticks`.
   * Dynamically extends the timeline limit, refreshes kill-cam metadata when kills appear,
   * and resumes playback seamlessly if the playhead had caught up to the computation frontier.
   */
  public notifyTicksExtended(simComplete: boolean) {
    if (!this.active || !this.bundle) return;
    const ticks = this.bundle.replay.ticks;
    const prevComplete = this.simComplete;
    if (simComplete) this.simComplete = true;

    const newDeaths = this.scanNewDeaths(ticks);
    if (newDeaths > 0 || (!prevComplete && this.simComplete)) {
      this.director = new CinematicDirector(
        ticks,
        this.bundle.replay.mapData,
        this.cinematicOpts,
        undefined,
        this.simComplete,
      );
      this.renderer.setCinematicDirector(this.director);
      this.renderer.setPlaybackSpeed(this.speed);
    }

    const maxIndex = Math.max(0, ticks.length - 1);
    if (this.simComplete && this.tickIndex >= maxIndex && !this.finished) {
      this.finished = true;
      this.waitingForSim = false;
      this.callbacks.onStateChange(this.getState());
    } else if (this.waitingForSim && !this.paused && !this.finished && this.tickIndex < maxIndex) {
      this.waitingForSim = false;
      if (!this.inCountdown) {
        this.nextTickDeadline = performance.now();
        this.scheduleNextTick();
      }
    }

    this.callbacks.onTimelineExtended?.(this.bundle, this.getState());
  }

  public pause() {
    if (!this.active || this.paused) return;
    this.cancelCountdown();
    this.paused = true;
    this.clearTimer();
    this.renderer.setPlaybackPaused(true);
    this.callbacks.onStateChange(this.getState());
  }

  public resume() {
    if (!this.active || !this.bundle) return;
    if (this.finished) {
      this.restart();
      return;
    }
    if (!this.paused) return;
    this.paused = false;
    this.renderer.setPlaybackPaused(false);
    this.nextTickDeadline = performance.now() + this.getTickIntervalMs();
    this.scheduleNextTick();
    this.callbacks.onStateChange(this.getState());
  }

  public togglePause() {
    if (!this.active) return;
    if (this.finished) {
      this.restart();
    } else if (this.paused) {
      this.resume();
    } else {
      this.pause();
    }
  }

  public setSpeed(nextSpeed: number) {
    if (!this.active) return;
    this.speed = Math.max(0.1, Math.min(2.0, nextSpeed || 1.0));
    this.renderer.setPlaybackSpeed(this.speed);
    if (!this.paused && !this.finished && !this.waitingForSim && !this.inCountdown) {
      this.clearTimer();
      this.nextTickDeadline = performance.now() + this.getTickIntervalMs();
      this.scheduleNextTick();
    }
    this.callbacks.onStateChange(this.getState());
  }

  public seekTo(index: number) {
    if (!this.active || !this.bundle) return;
    this.cancelCountdown();
    const ticks = this.bundle.replay.ticks;
    const maxIndex = Math.max(0, ticks.length - 1);
    const clamped = Math.max(0, Math.min(maxIndex, Math.round(index)));
    this.clearTimer();

    this.tickIndex = clamped;
    this.finished = this.simComplete && clamped >= maxIndex;
    this.waitingForSim = !this.simComplete && clamped >= maxIndex && !this.paused;
    this.renderer.seekToReplayTick(ticks, clamped);
    this.renderer.setPlaybackSpeed(this.speed);

    if (this.finished) {
      this.paused = false;
      this.renderer.setPlaybackPaused(false);
    } else if (this.paused) {
      this.renderer.setPlaybackPaused(true);
    } else if (this.waitingForSim) {
      this.renderer.setPlaybackPaused(false);
    } else {
      this.renderer.setPlaybackPaused(false);
      this.nextTickDeadline = performance.now() + this.getTickIntervalMs();
      this.scheduleNextTick();
    }

    const st = this.getState();
    this.callbacks.onTick(ticks[clamped], st);
    this.callbacks.onStateChange(st);
  }

  public restart() {
    if (!this.active || !this.bundle) return;
    this.cancelCountdown();
    this.paused = false;
    this.finished = this.simComplete && this.bundle.replay.ticks.length <= 1;
    this.waitingForSim = !this.simComplete && this.bundle.replay.ticks.length <= 1;
    this.renderer.setPlaybackPaused(false);
    this.seekTo(0);
    if (!this.finished && !this.waitingForSim) {
      this.clearTimer();
      this.nextTickDeadline = performance.now() + 260;
      this.scheduleNextTick();
    }
  }

  private scheduleNextTick() {
    if (!this.active || this.paused || this.finished || this.waitingForSim || this.inCountdown) return;
    this.clearTimer();
    const wait = Math.max(0, this.nextTickDeadline - performance.now());
    this.timerHandle = window.setTimeout(() => {
      this.timerHandle = null;
      this.stepForward();
    }, wait);
  }

  private stepForward() {
    if (!this.active || this.paused || this.finished || !this.bundle) return;
    const ticks = this.bundle.replay.ticks;
    const maxIndex = ticks.length - 1;
    if (this.tickIndex >= maxIndex) {
      if (this.simComplete) {
        this.finished = true;
        this.waitingForSim = false;
        this.callbacks.onStateChange(this.getState());
      } else {
        this.waitingForSim = true;
      }
      return;
    }

    const prevIdx = this.tickIndex;
    const prev = ticks[prevIdx];
    const intervalMs = this.getTickIntervalMs(prevIdx);
    this.tickIndex++;
    const curr = ticks[this.tickIndex];
    this.renderer.pushTick(prev, curr, intervalMs);

    if (this.tickIndex >= maxIndex) {
      if (this.simComplete) {
        this.finished = true;
        this.waitingForSim = false;
        const st = this.getState();
        this.callbacks.onTick(curr, st);
        this.callbacks.onStateChange(st);
      } else {
        this.waitingForSim = true;
        this.callbacks.onTick(curr, this.getState());
      }
      return;
    }

    const now = performance.now();
    this.nextTickDeadline += intervalMs;
    if (now - this.nextTickDeadline > Math.max(250, intervalMs * 3)) {
      this.nextTickDeadline = now + intervalMs;
    }

    this.callbacks.onTick(curr, this.getState());
    this.scheduleNextTick();
  }

  private clearTimer() {
    if (this.timerHandle !== null) {
      window.clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
  }

  private clearCountdownTimers() {
    for (const h of this.countdownTimers) {
      window.clearTimeout(h);
    }
    this.countdownTimers = [];
  }

  private cancelCountdown() {
    if (!this.inCountdown && this.countdownTimers.length === 0) return;
    this.inCountdown = false;
    this.clearCountdownTimers();
    this.callbacks.onCountdown?.(null);
  }

  public stop() {
    this.sessionSeq++;
    this.clearTimer();
    this.inCountdown = false;
    this.clearCountdownTimers();
    this.callbacks.onCountdown?.(null);
    this.active = false;
    this.paused = false;
    this.finished = false;
    this.simComplete = true;
    this.waitingForSim = false;
    this.scannedTicks = 0;
    this.knownDeathCount = 0;
    this.bundle = null;
    this.director = null;
    this.tickIndex = 0;
    this.renderer.setCinematicDirector(null);
    this.renderer.setPlaybackPaused(false);
  }
}
