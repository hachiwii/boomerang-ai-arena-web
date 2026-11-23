import { GameRenderer } from '../render/renderer';
import { CinematicDirector, normalizeCinematicOptions } from './killCamDirector';
import { MatchReplayBundle } from './matchHistory';
import { CinematicOptions } from './settings';
import { LOGIC_DT_MS, TickSnapshot } from './types';

export interface ReplayPlaybackState {
  tickIndex: number;
  maxIndex: number;
  paused: boolean;
  finished: boolean;
  speed: number;
}

export interface ReplayCallbacks {
  onLoaded: (bundle: MatchReplayBundle, state: ReplayPlaybackState) => void;
  onTick: (snapshot: TickSnapshot, state: ReplayPlaybackState) => void;
  onStateChange: (state: ReplayPlaybackState) => void;
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
  private active = false;
  private sessionSeq = 0;

  private timerHandle: number | null = null;
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
    };
  }

  private getTickIntervalMs(tickIdx = this.tickIndex): number {
    const scale = this.director?.getSpeedScaleAtSim(tickIdx * (LOGIC_DT_MS / 1000)) ?? 1.0;
    return LOGIC_DT_MS / (this.speed * scale);
  }

  public setCinematicOptions(opts: boolean | Partial<CinematicOptions>) {
    this.cinematicOpts = normalizeCinematicOptions(opts);
    if (!this.active || !this.bundle) return;
    this.director = new CinematicDirector(
      this.bundle.replay.ticks,
      this.bundle.replay.mapData,
      this.cinematicOpts,
    );
    this.renderer.setCinematicDirector(this.director);
    this.renderer.setPlaybackSpeed(this.speed);
    if (!this.paused && !this.finished) {
      this.clearTimer();
      this.nextTickDeadline = performance.now() + this.getTickIntervalMs();
      this.scheduleNextTick();
    }
  }

  public async start(
    bundle: MatchReplayBundle,
    initialSpeed = 1.0,
    cinematicOpts?: boolean | Partial<CinematicOptions>,
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
    this.speed = Math.max(0.25, Math.min(2.0, initialSpeed || 1.0));
    this.tickIndex = 0;
    this.paused = false;
    this.finished = ticks.length <= 1;
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

    this.director = new CinematicDirector(ticks, bundle.replay.mapData, this.cinematicOpts);
    this.renderer.setCinematicDirector(this.director);
    this.renderer.setPlaybackSpeed(this.speed);

    const st = this.getState();
    this.callbacks.onLoaded(bundle, st);
    this.callbacks.onTick(ticks[0], st);

    if (!this.finished) {
      this.nextTickDeadline = performance.now() + 320;
      this.scheduleNextTick();
    }
  }

  public pause() {
    if (!this.active || this.paused) return;
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
    this.speed = Math.max(0.25, Math.min(2.0, nextSpeed || 1.0));
    this.renderer.setPlaybackSpeed(this.speed);
    if (!this.paused && !this.finished) {
      this.clearTimer();
      this.nextTickDeadline = performance.now() + this.getTickIntervalMs();
      this.scheduleNextTick();
    }
    this.callbacks.onStateChange(this.getState());
  }

  public seekTo(index: number) {
    if (!this.active || !this.bundle) return;
    const ticks = this.bundle.replay.ticks;
    const maxIndex = Math.max(0, ticks.length - 1);
    const clamped = Math.max(0, Math.min(maxIndex, Math.round(index)));
    this.clearTimer();

    this.tickIndex = clamped;
    this.finished = clamped >= maxIndex;
    this.renderer.seekToReplayTick(ticks, clamped);
    this.renderer.setPlaybackSpeed(this.speed);

    if (this.finished) {
      this.paused = false;
      this.renderer.setPlaybackPaused(false);
    } else if (this.paused) {
      this.renderer.setPlaybackPaused(true);
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
    this.paused = false;
    this.finished = this.bundle.replay.ticks.length <= 1;
    this.renderer.setPlaybackPaused(false);
    this.seekTo(0);
    if (!this.finished) {
      this.clearTimer();
      this.nextTickDeadline = performance.now() + 260;
      this.scheduleNextTick();
    }
  }

  private scheduleNextTick() {
    if (!this.active || this.paused || this.finished) return;
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
      this.finished = true;
      this.callbacks.onStateChange(this.getState());
      return;
    }

    const prevIdx = this.tickIndex;
    const prev = ticks[prevIdx];
    const intervalMs = this.getTickIntervalMs(prevIdx);
    this.tickIndex++;
    const curr = ticks[this.tickIndex];
    this.renderer.pushTick(prev, curr, intervalMs);

    if (this.tickIndex >= maxIndex) {
      this.finished = true;
      const st = this.getState();
      this.callbacks.onTick(curr, st);
      this.callbacks.onStateChange(st);
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

  public stop() {
    this.sessionSeq++;
    this.clearTimer();
    this.active = false;
    this.paused = false;
    this.finished = false;
    this.bundle = null;
    this.director = null;
    this.tickIndex = 0;
    this.renderer.setCinematicDirector(null);
    this.renderer.setPlaybackPaused(false);
  }
}
