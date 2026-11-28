import { CinematicOptions } from './settings';
import { CauseType, CellType, DState, EngineMapData, LOGIC_DT_MS, TickSnapshot } from './types';

export function normalizeCinematicOptions(
  opt: boolean | Partial<CinematicOptions> | undefined,
): CinematicOptions {
  if (typeof opt === 'boolean') {
    return { killCam: opt, finisherCam: opt, winnerCam: opt, killFx: false };
  }
  const killCam = opt?.killCam ?? false;
  return {
    killCam,
    finisherCam: opt?.finisherCam ?? false,
    winnerCam: opt?.winnerCam ?? false,
    // Defensive guard: upstream kill FX (hit-stop + overview impact punch) never runs alongside killCam
    killFx: killCam ? false : (opt?.killFx ?? false),
  };
}

const TICK_SEC = LOGIC_DT_MS / 1000; // 0.05s
const UPSTREAM_FPS = 30;
const HITSTOP_OFFSET_TICKS = 0.6; // Exact peak slice/flash beat in upstream timeline.py:126
const HITSTOP_NORMAL_SEC = 3 / UPSTREAM_FPS; // 3 frames @ 30fps (0.100s)
const HITSTOP_FINAL_SEC = 5 / UPSTREAM_FPS; // 5 frames @ 30fps (0.167s)
const IMPACT_DURATION_FRAMES = 14; // 14 frames @ 30fps (0.467s) in timeline.py:247
const IMPACT_SHAKE_AMP_NORMAL = 0.1; // timeline.py:233
const IMPACT_SHAKE_AMP_FINAL = 0.16; // timeline.py:233
const IMPACT_ZOOM_PUNCH = 0.022; // timeline.py:233
const IMPACT_SHAKE_TAU_FRAMES = 3.2; // timeline.py:248
const IMPACT_PUNCH_TAU_FRAMES = 4.5; // timeline.py:251

const PRE_KILL_SIM_SEC = 0.50; // Slow down the 0.5s before every kill
const POST_KILL_SIM_SEC_FINAL = 0.16; // Final kill impact beat at 0.25x (0.64s real)
const POST_KILL_SIM_SEC_NON_FINAL = 0.22; // Non-final kill impact beat at 0.5x (0.44s real)
const FINAL_KILL_TIME_SCALE = 0.25;
const NON_FINAL_KILL_TIME_SCALE = 0.5;
const MERGE_GAP_SIM_SEC = 0.45;
const CAM_ENTER_REAL_SEC = 0.58; // Smooth ease from overview to eye-level kill shot
const CAM_EXIT_REAL_SEC = 0.68; // Smooth ease back to overview for non-final kills
const WINNER_CELEBRATE_DELAY_SIM = 4 * TICK_SEC; // 0.20s (4 logic frames after final kill before turning/celebrating)
const WINNER_GLIDE_REAL_SEC = 0.78; // Smooth glide from kill shot to winner front close-up
const WINNER_HOLD_REAL_SEC = 1.65; // Hold on smiling front-facing winner

export interface Vec3Tuple {
  x: number;
  y: number;
  z: number;
}

export interface CinematicCameraPose {
  pos: Vec3Tuple;
  lookAt: Vec3Tuple;
  /** 0 = standard overview, 1 = fully inside kill-cam or winner close-up */
  blend: number;
  /** 0..1 blend specifically into the winner front close-up */
  winnerBlend: number;
  /** Target yaw (rad) for the winning rig so it looks directly into the close-up lens */
  winnerFaceYaw: number | null;
  /** Current simulation time-scale factor (0 during hit-stop, 0.25/0.5 during kill slow-mo, 1.0 otherwise) */
  timeScale: number;
  /** True when inside an active slow-motion kill segment */
  inKillSlowMo: boolean;
  /** True when simulation time is frozen inside an upstream kill hit-stop */
  inHitStop: boolean;
  /** Camera distance multiplier from upstream impact zoom punch (1.0 normally, dips to 0.978 on impact) */
  zoomMul: number;
  /** Upstream screen-plane camera shake offsets (meters along camera right & up axes) */
  shakeRight: number;
  shakeUp: number;
}

interface HitStopEvent {
  killTickIdx: number;
  stopSimSec: number;
  durationRealSec: number;
  isFinal: boolean;
  realStartSec: number;
  realEndSec: number;
}

interface KillSegment {
  /** Merged death tick index (latest decisive kill in group) */
  killTickIdx: number;
  killSimSec: number;
  slowStartSim: number;
  slowEndSim: number;
  exitEndSim: number;
  /** Playback speed scale for this kill segment (0.5x for non-final kills, 0.25x for the last kill) */
  timeScale: number;
  cause: CauseType;
  victimSeat: number;
  killerSeat: number;
  isDecisive: boolean;
  /** Precomputed unobstructed camera offset & flight basis */
  camOffX: number;
  camOffZ: number;
  camY: number;
  flightDirX: number;
  flightDirZ: number;
  /** Impact anchor at kill tick */
  impactX: number;
  impactZ: number;
  /** Victim velocity at fall (m/s) for pit-fall tracking */
  fallVx: number;
  fallVz: number;
}

interface WinnerShotPlan {
  seat: number;
  x: number;
  z: number;
  azimuth: number;
  camX: number;
  camY: number;
  camZ: number;
  lookX: number;
  lookY: number;
  lookZ: number;
  glideStartSim: number;
  glideEndSim: number;
}

interface TimeInterval {
  simStart: number;
  simEnd: number;
  realStart: number;
  realEnd: number;
  scale: number; // simSec / realSec
}

function clamp(v: number, lo = 0, hi = 1): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function smootherstep(t: number): number {
  const u = clamp(t);
  return u * u * u * (u * (u * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Deterministic cinematic kill-cam & winner close-up director shared across:
 * - Replay playback (including instant scrubbing & variable speed)
 * - Accelerated pure-AI spectator matches
 * - Offline 60fps MP4 export (with synced audio timestamps)
 * - Offline 24fps 10s GIF clip export
 */
export class CinematicDirector {
  private readonly ticks: TickSnapshot[];
  private readonly mapData: EngineMapData;
  private readonly options: CinematicOptions;
  private readonly simComplete: boolean;
  private readonly enabled: boolean;
  private readonly widthM: number;
  private readonly heightM: number;
  private readonly cellM: number;
  private readonly matchEndSimSec: number;

  private readonly kills: KillSegment[] = [];
  private readonly hitStops: HitStopEvent[] = [];
  private readonly winnerShot: WinnerShotPlan | null = null;
  private readonly timeIntervals: TimeInterval[] = [];

  /**
   * Creates a lightweight post-match director for live matches (human matches, or AI matches
   * with only `winnerCam` / `killFx` enabled): keeps gameplay 100% real-time, then applies
   * optional final-kill hit-stop + impact punch and smoothly glides into the winner close-up.
   */
  public static createWinnerCloseupOnly(
    finalState: TickSnapshot,
    mapData: EngineMapData,
    winnerCamEnabled: boolean,
    killFxEnabled = false,
  ): CinematicDirector | null {
    if (!finalState.over) return null;
    const hasHitKill =
      killFxEnabled &&
      finalState.events.some(
        (ev) => ev.name === 'DEATH' && (ev.b === CauseType.DART || ev.b === CauseType.SLASH),
      );
    const wantWinner = winnerCamEnabled && finalState.winner >= 0;
    if (!wantWinner && !hasHitKill) return null;
    const dir = new CinematicDirector(
      [finalState],
      mapData,
      { killCam: false, finisherCam: false, winnerCam: wantWinner, killFx: hasHitKill },
      finalState,
    );
    return dir.hasWinnerCloseup() || dir.hasKillFx() ? dir : null;
  }

  constructor(
    ticks: TickSnapshot[],
    mapData: EngineMapData,
    optionsOrEnabled: boolean | Partial<CinematicOptions>,
    winnerOnlyFinalState?: TickSnapshot,
    simComplete = true,
  ) {
    this.ticks = ticks;
    this.mapData = mapData;
    this.options = normalizeCinematicOptions(optionsOrEnabled);
    // 5v5 团队赛：winner 是队伍号、10 人同场，慢放击杀、终结与胜者特写都按单人座位设计，只保留击杀顿帧
    if (mapData.mode) this.options = { ...this.options, killCam: false, finisherCam: false, winnerCam: false };
    this.simComplete = simComplete;
    this.cellM = mapData.cell / 1000;
    this.widthM = mapData.nx * this.cellM;
    this.heightM = mapData.ny * this.cellM;

    if (winnerOnlyFinalState) {
      this.enabled = this.options.winnerCam || this.options.killFx;
      this.matchEndSimSec = winnerOnlyFinalState.t * TICK_SEC;
      this.kills = [];
      if (
        this.options.killFx &&
        winnerOnlyFinalState.events.some(
          (ev) => ev.name === 'DEATH' && (ev.b === CauseType.DART || ev.b === CauseType.SLASH),
        )
      ) {
        this.hitStops = [
          {
            killTickIdx: winnerOnlyFinalState.t,
            stopSimSec: (winnerOnlyFinalState.t + HITSTOP_OFFSET_TICKS) * TICK_SEC,
            durationRealSec: HITSTOP_FINAL_SEC,
            isFinal: true,
            realStartSec: 0,
            realEndSec: 0,
          },
        ];
      }
      this.winnerShot = this.options.winnerCam ? this.planWinnerShot(winnerOnlyFinalState, 0.22) : null;
      this.timeIntervals = this.buildTimeIntervals();
      return;
    }

    const anyEnabled =
      this.options.killCam || this.options.finisherCam || this.options.winnerCam || this.options.killFx;
    this.enabled = anyEnabled && ticks.length >= 2;
    this.matchEndSimSec = Math.max(0, ticks.length - 1) * TICK_SEC;

    if (!this.enabled) {
      this.timeIntervals.push({
        simStart: 0,
        simEnd: 1e9,
        realStart: 0,
        realEnd: 1e9,
        scale: 1.0,
      });
      return;
    }

    this.kills = this.detectKillSegments();
    this.hitStops = this.options.killFx ? this.detectHitStopEvents() : [];
    this.winnerShot = this.options.winnerCam ? this.planWinnerShot(undefined, 0.22) : null;
    this.timeIntervals = this.buildTimeIntervals();
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public hasWinnerCloseup(): boolean {
    return this.enabled && this.winnerShot !== null;
  }

  public hasKillCams(): boolean {
    return this.enabled && this.kills.length > 0;
  }

  public hasKillFx(): boolean {
    return this.enabled && this.options.killFx;
  }

  /** Exact 1x real-time duration (s) of stepping across logic tick `[tickIdx, tickIdx + 1]`. */
  public getTickRealDurationSec(tickIdx: number): number {
    const s0 = tickIdx * TICK_SEC;
    const s1 = (tickIdx + 1) * TICK_SEC;
    return Math.max(0.005, this.simToReal(s1) - this.simToReal(s0));
  }

  /**
   * Exact 1x real-time end of the match-ending finisher kill-cam slow-mo beat
   * (or `null` if no finisher kill-cam extends past `matchEndSimSec`).
   */
  public getFinisherEndRealSec(): number | null {
    if (!this.enabled) return null;
    for (let i = this.kills.length - 1; i >= 0; i--) {
      const k = this.kills[i];
      if (k.slowEndSim > this.matchEndSimSec) {
        return this.simToReal(k.slowEndSim);
      }
    }
    return null;
  }

  /** Recommended real-time post-match outro duration (at 1x base speed) so winner close-up shines. */
  public getRecommendedOutroRealSec(fallbackSec: number): number {
    if (!this.enabled) return fallbackSec;
    const endReal = this.simToReal(this.matchEndSimSec);
    const decisive = this.kills.find((k) => k.isDecisive);
    if (this.winnerShot) {
      const glideStartReal = this.simToReal(this.winnerShot.glideStartSim);
      return Math.max(0, glideStartReal - endReal) + WINNER_GLIDE_REAL_SEC + WINNER_HOLD_REAL_SEC;
    }
    if (decisive) {
      const postSlowReal = Math.max(0, this.simToReal(decisive.slowEndSim) - endReal);
      return Math.max(fallbackSec, postSlowReal + 0.85);
    }
    const finalStop = this.hitStops.find((h) => h.stopSimSec >= this.matchEndSimSec);
    if (finalStop) {
      return Math.max(fallbackSec, finalStop.realEndSec - endReal + 0.85);
    }
    return fallbackSec;
  }

  /** Simulation speed scale (0.5x on non-final kills, 0.25x on the final kill, 1.0 otherwise) at `simSec`. */
  public getSpeedScaleAtSim(simSec: number): number {
    if (!this.enabled) return 1.0;
    let scale = 1.0;
    for (let i = 0; i < this.kills.length; i++) {
      const k = this.kills[i];
      if (simSec >= k.slowStartSim && simSec < k.slowEndSim && k.timeScale < scale) {
        scale = k.timeScale;
      }
    }
    return scale;
  }

  /** Exact monotonic map from simulation time (s) to 1x cinematic real/video time (s). */
  public simToReal(simSec: number): number {
    if (!this.enabled || simSec <= 0) return Math.max(0, simSec);
    for (let i = 0; i < this.timeIntervals.length; i++) {
      const iv = this.timeIntervals[i];
      if (iv.scale === 0) {
        if (simSec <= iv.simStart) return iv.realStart;
        continue;
      }
      if (simSec <= iv.simEnd) {
        return iv.realStart + (simSec - iv.simStart) / iv.scale;
      }
    }
    const last = this.timeIntervals[this.timeIntervals.length - 1];
    return last.realEnd + (simSec - last.simEnd);
  }

  /** Exact inverse map from 1x cinematic real/video time (s) to simulation time (s). */
  public realToSim(realSec: number): number {
    if (!this.enabled || realSec <= 0) return Math.max(0, realSec);
    for (let i = 0; i < this.timeIntervals.length; i++) {
      const iv = this.timeIntervals[i];
      if (realSec <= iv.realEnd) {
        return iv.simStart + (realSec - iv.realStart) * iv.scale;
      }
    }
    const last = this.timeIntervals[this.timeIntervals.length - 1];
    return last.simEnd + (realSec - last.realEnd);
  }

  /**
   * Evaluates the smooth cinematic camera pose at continuous simulation time `simSec`
   * (and optional 1x real-time `realSec` so hit-stop camera shake & zoom punch keep animating
   * while `simSec` is frozen), blending cleanly with `(ovPos, ovLookAt)`.
   */
  public evaluate(
    simSec: number,
    ovPos: Vec3Tuple,
    ovLookAt: Vec3Tuple,
    realSec?: number,
  ): CinematicCameraPose {
    const baseTimeScale = this.getSpeedScaleAtSim(simSec);
    const inKillSlowMo = baseTimeScale < 0.99;

    if (!this.enabled) {
      return {
        pos: ovPos,
        lookAt: ovLookAt,
        blend: 0,
        winnerBlend: 0,
        winnerFaceYaw: null,
        timeScale: 1.0,
        inKillSlowMo: false,
        inHitStop: false,
        zoomMul: 1.0,
        shakeRight: 0,
        shakeUp: 0,
      };
    }

    const evalRealSec = realSec ?? this.simToReal(simSec);
    let inHitStop = false;
    let zoomMul = 1.0;
    let shakeRight = 0;
    let shakeUp = 0;
    for (let i = 0; i < this.hitStops.length; i++) {
      const h = this.hitStops[i];
      if (evalRealSec >= h.realStartSec && evalRealSec < h.realEndSec) {
        inHitStop = true;
      }
      const a = (evalRealSec - h.realStartSec) * UPSTREAM_FPS;
      if (a >= 0 && a < IMPACT_DURATION_FRAMES) {
        const f0 = h.realStartSec * UPSTREAM_FPS;
        const amp = h.isFinal ? IMPACT_SHAKE_AMP_FINAL : IMPACT_SHAKE_AMP_NORMAL;
        const e = amp * Math.exp(-a / IMPACT_SHAKE_TAU_FRAMES);
        shakeRight += e * Math.sin(a * 2.9 + f0);
        shakeUp += e * Math.cos(a * 3.7 + f0 * 1.3);
        zoomMul -= IMPACT_ZOOM_PUNCH * Math.exp(-a / IMPACT_PUNCH_TAU_FRAMES);
      }
    }
    const timeScale = inHitStop ? 0 : baseTimeScale;

    // 1. Evaluate active kill segments overlapping simSec (handles even close chain kills smoothly!)
    let totalKillW = 0;
    let maxKillW = 0;
    let sumPosX = 0;
    let sumPosY = 0;
    let sumPosZ = 0;
    let sumLookX = 0;
    let sumLookY = 0;
    let sumLookZ = 0;

    for (let i = 0; i < this.kills.length; i++) {
      const seg = this.kills[i];
      const w = this.computeKillWeight(seg, simSec);
      if (w <= 1e-4) continue;
      const shot = this.evaluateKillShot(seg, simSec);
      sumPosX += shot.pos.x * w;
      sumPosY += shot.pos.y * w;
      sumPosZ += shot.pos.z * w;
      sumLookX += shot.lookAt.x * w;
      sumLookY += shot.lookAt.y * w;
      sumLookZ += shot.lookAt.z * w;
      totalKillW += w;
      if (w > maxKillW) maxKillW = w;
    }

    let curPos: Vec3Tuple = ovPos;
    let curLook: Vec3Tuple = ovLookAt;
    let curBlend = 0;

    if (totalKillW > 1e-4) {
      const kPos: Vec3Tuple = {
        x: sumPosX / totalKillW,
        y: sumPosY / totalKillW,
        z: sumPosZ / totalKillW,
      };
      const kLook: Vec3Tuple = {
        x: sumLookX / totalKillW,
        y: sumLookY / totalKillW,
        z: sumLookZ / totalKillW,
      };
      const b = clamp(maxKillW);
      curPos = {
        x: lerp(ovPos.x, kPos.x, b),
        y: lerp(ovPos.y, kPos.y, b),
        z: lerp(ovPos.z, kPos.z, b),
      };
      curLook = {
        x: lerp(ovLookAt.x, kLook.x, b),
        y: lerp(ovLookAt.y, kLook.y, b),
        z: lerp(ovLookAt.z, kLook.z, b),
      };
      curBlend = b;
    }

    // 2. Smoothly glide into Winner Front Close-Up after decisive kill finishes!
    let winnerBlend = 0;
    let winnerFaceYaw: number | null = null;

    if (this.winnerShot && simSec >= this.winnerShot.glideStartSim) {
      const ws = this.winnerShot;
      const u = (simSec - ws.glideStartSim) / Math.max(0.05, ws.glideEndSim - ws.glideStartSim);
      winnerBlend = smootherstep(u);
      winnerFaceYaw = ws.azimuth;

      curPos = {
        x: lerp(curPos.x, ws.camX, winnerBlend),
        y: lerp(curPos.y, ws.camY, winnerBlend),
        z: lerp(curPos.z, ws.camZ, winnerBlend),
      };
      curLook = {
        x: lerp(curLook.x, ws.lookX, winnerBlend),
        y: lerp(curLook.y, ws.lookY, winnerBlend),
        z: lerp(curLook.z, ws.lookZ, winnerBlend),
      };
      curBlend = Math.max(curBlend, winnerBlend);
    }

    return {
      pos: curPos,
      lookAt: curLook,
      blend: curBlend,
      winnerBlend,
      winnerFaceYaw,
      timeScale,
      inKillSlowMo,
      inHitStop,
      zoomMul,
      shakeRight,
      shakeUp,
    };
  }

  private computeKillWeight(seg: KillSegment, simSec: number): number {
    if (simSec < seg.slowStartSim) return 0;

    // Smooth enter over first ~0.45-0.58s real time (capped to half of pre-kill window so lock-on stays crisp)
    const preSimDur = Math.max(0.08, seg.killSimSec - seg.slowStartSim);
    const enterSimDur = Math.min(preSimDur * 0.5, CAM_ENTER_REAL_SEC * seg.timeScale);
    if (simSec < seg.slowStartSim + enterSimDur) {
      return smootherstep((simSec - seg.slowStartSim) / enterSimDur);
    }

    // Hold full kill-cam until slow-mo impact ends
    if (simSec <= seg.slowEndSim) {
      return 1.0;
    }

    // Decisive kill with winner close-up stays anchored at kill shot while winnerBlend takes over!
    if (seg.isDecisive && this.winnerShot) {
      return 1.0;
    }

    // Non-decisive kill (or draw): smoothly return to overview
    if (simSec < seg.exitEndSim) {
      const u = (simSec - seg.slowEndSim) / Math.max(0.05, seg.exitEndSim - seg.slowEndSim);
      return 1.0 - smootherstep(u);
    }

    return 0;
  }

  private evaluateKillShot(seg: KillSegment, simSec: number): { pos: Vec3Tuple; lookAt: Vec3Tuple } {
    const clampedSim = Math.min(simSec, this.matchEndSimSec);
    const uPre = clamp((simSec - seg.slowStartSim) / Math.max(0.05, seg.killSimSec - seg.slowStartSim));
    const postSec = Math.max(0, simSec - seg.killSimSec);

    if (seg.cause === CauseType.DART) {
      // Follow the flying boomerang smoothly into the victim!
      let ax: number;
      let az: number;
      const ay = 0.66;

      if (simSec <= seg.killSimSec) {
        const dPos = this.sampleDartPos(seg.killerSeat, clampedSim);
        const vPos = this.samplePlayerPos(seg.victimSeat, clampedSim);
        // Track dart primarily, gently bringing victim center-frame as dart closes in
        const victimPull = 0.22 + 0.36 * smootherstep(uPre);
        ax = lerp(dPos.x, vPos.x, victimPull);
        az = lerp(dPos.z, vPos.z, victimPull);
      } else {
        // Hold smoothly on the slicing impact with a slight forward follow-through
        const drift = Math.min(0.35, postSec * 1.4);
        ax = seg.impactX + seg.flightDirX * drift;
        az = seg.impactZ + seg.flightDirZ * drift;
      }

      return {
        pos: { x: ax + seg.camOffX, y: seg.camY, z: az + seg.camOffZ },
        lookAt: { x: ax, y: ay, z: az },
      };
    }

    if (seg.cause === CauseType.SLASH) {
      // Melee slash: frame both attacker and victim side-by-side at eye level with gentle orbit
      const vPos = this.samplePlayerPos(seg.victimSeat, Math.min(clampedSim, seg.killSimSec));
      const kPos =
        seg.killerSeat >= 0
          ? this.samplePlayerPos(seg.killerSeat, Math.min(clampedSim, seg.killSimSec))
          : vPos;
      const pull = 0.48 + 0.24 * smootherstep(uPre);
      const ax = lerp(kPos.x, vPos.x, pull);
      const az = lerp(kPos.z, vPos.z, pull);

      // Subtle cinematic 7-degree orbit across the kill window
      const orbitRad = (uPre - 0.5) * 0.12 + Math.min(0.06, postSec * 0.15);
      const cosA = Math.cos(orbitRad);
      const sinA = Math.sin(orbitRad);
      const ox = seg.camOffX * cosA - seg.camOffZ * sinA;
      const oz = seg.camOffX * sinA + seg.camOffZ * cosA;

      return {
        pos: { x: ax + ox, y: seg.camY, z: az + oz },
        lookAt: { x: ax, y: 0.68, z: az },
      };
    }

    // CauseType.FALL (pit / cliff fall — kicked off or collapsed edge)
    let ax: number;
    let ay = 0.62;
    let az: number;

    if (simSec <= seg.killSimSec) {
      const vPos = this.samplePlayerPos(seg.victimSeat, clampedSim);
      if (seg.killerSeat >= 0) {
        const kPos = this.samplePlayerPos(seg.killerSeat, clampedSim);
        const dist = Math.hypot(kPos.x - vPos.x, kPos.z - vPos.z);
        const kPull = dist < 4.5 ? 0.30 * (1 - 0.5 * uPre) : 0;
        ax = lerp(vPos.x, kPos.x, kPull);
        az = lerp(vPos.z, kPos.z, kPull);
      } else {
        ax = vPos.x;
        az = vPos.z;
      }
    } else {
      // Track victim tumbling off the cliff downward slightly
      const fallT = Math.min(0.55, postSec);
      ax = seg.impactX + seg.fallVx * fallT * 0.45;
      az = seg.impactZ + seg.fallVz * fallT * 0.45;
      const drop = 4.2 * fallT * fallT;
      ay = Math.max(-0.9, 0.62 - drop * 0.48);
    }

    return {
      pos: { x: ax + seg.camOffX, y: seg.camY, z: az + seg.camOffZ },
      lookAt: { x: ax, y: ay, z: az },
    };
  }

  private detectKillSegments(): KillSegment[] {
    interface RawKill {
      tickIdx: number;
      simSec: number;
      victim: number;
      cause: CauseType;
      killer: number;
      isMatchOver: boolean;
      winner: number;
    }

    const raw: RawKill[] = [];
    for (let i = 1; i < this.ticks.length; i++) {
      const snap = this.ticks[i];
      for (const ev of snap.events) {
        if (ev.name === 'DEATH') {
          raw.push({
            tickIdx: i,
            simSec: i * TICK_SEC,
            victim: ev.a,
            cause: ev.b as CauseType,
            killer: ev.c,
            isMatchOver: Boolean(snap.over),
            winner: snap.winner,
          });
        }
      }
    }

    if (raw.length === 0) return [];

    // Group near-simultaneous kills (e.g. double kill within 0.45s) into one coherent slow-mo segment
    const groups: RawKill[][] = [];
    for (const rk of raw) {
      const prevGrp = groups[groups.length - 1];
      if (prevGrp && rk.simSec - prevGrp[prevGrp.length - 1].simSec <= MERGE_GAP_SIM_SEC) {
        prevGrp.push(rk);
      } else {
        groups.push([rk]);
      }
    }

    const segments: KillSegment[] = [];
    for (let gIdx = 0; gIdx < groups.length; gIdx++) {
      const grp = groups[gIdx];
      const first = grp[0];
      const last = grp[grp.length - 1];
      // While background AI simulation is still running, only a match-ending kill (`last.isMatchOver`)
      // counts as the final kill so mid-match kills never temporarily flip between 0.25x and 0.5x.
      const isLastKill = this.simComplete ? gIdx === groups.length - 1 : last.isMatchOver;

      // Non-final kills controlled by `killCam`; final kill controlled by `finisherCam`
      if (isLastKill && !this.options.finisherCam) continue;
      if (!isLastKill && !this.options.killCam) continue;

      const timeScale = isLastKill ? FINAL_KILL_TIME_SCALE : NON_FINAL_KILL_TIME_SCALE;
      const postKillSim = isLastKill ? POST_KILL_SIM_SEC_FINAL : POST_KILL_SIM_SEC_NON_FINAL;

      // Prefer decisive kill or boomerang kill as the primary camera subject
      const primary =
        grp.find((g) => g.isMatchOver && g.winner >= 0) ||
        grp.find((g) => g.cause === CauseType.DART) ||
        last;

      const slowStartSim = Math.max(0, first.simSec - PRE_KILL_SIM_SEC);
      const slowEndSim = last.simSec + postKillSim;
      const isDecisive = last.isMatchOver && last.winner >= 0;
      const exitEndSim = isDecisive && this.options.winnerCam ? slowEndSim : slowEndSim + CAM_EXIT_REAL_SEC;

      const seg = this.buildKillSegmentGeometry(
        primary.tickIdx,
        primary.simSec,
        slowStartSim,
        slowEndSim,
        exitEndSim,
        timeScale,
        primary.cause,
        primary.victim,
        primary.killer,
        isDecisive,
      );
      segments.push(seg);
    }

    return segments;
  }

  private buildKillSegmentGeometry(
    killTickIdx: number,
    killSimSec: number,
    slowStartSim: number,
    slowEndSim: number,
    exitEndSim: number,
    timeScale: number,
    cause: CauseType,
    victimSeat: number,
    killerSeat: number,
    isDecisive: boolean,
  ): KillSegment {
    const killSnap = this.ticks[killTickIdx];
    const prevSnap = this.ticks[Math.max(0, killTickIdx - 1)];
    const vp = killSnap.players[victimSeat];
    const vpPrev = prevSnap.players[victimSeat];
    const impactX = vp ? vp.x / 1000 : this.widthM * 0.5;
    const impactZ = vp ? vp.y / 1000 : this.heightM * 0.5;
    const fallVx = vp && vpPrev ? (vp.x - vpPrev.x) / 1000 / TICK_SEC : 0;
    const fallVz = vp && vpPrev ? (vp.y - vpPrev.y) / 1000 / TICK_SEC : 0;

    let flightDirX = 1;
    let flightDirZ = 0;

    if (cause === CauseType.DART && killerSeat >= 0) {
      const lookBackIdx = Math.max(0, killTickIdx - 5);
      const dBack = this.sampleDartPos(killerSeat, lookBackIdx * TICK_SEC);
      let dx = impactX - dBack.x;
      let dz = impactZ - dBack.z;
      const len = Math.hypot(dx, dz);
      if (len > 0.15) {
        flightDirX = dx / len;
        flightDirZ = dz / len;
      } else {
        const kp = killSnap.players[killerSeat];
        if (kp) {
          dx = impactX - kp.x / 1000;
          dz = impactZ - kp.y / 1000;
          const kl = Math.hypot(dx, dz) || 1;
          flightDirX = dx / kl;
          flightDirZ = dz / kl;
        }
      }

      const sideX = -flightDirZ;
      const sideZ = flightDirX;
      // Side-rear 3/4 eye-level chase camera candidates (FOV=26 -> dist ~7.6m frames dart + killer/victim cleanly)
      const candidates: [number, number][] = [
        [-flightDirX * 2.8 + sideX * 7.1, -flightDirZ * 2.8 + sideZ * 7.1],
        [-flightDirX * 2.8 - sideX * 7.1, -flightDirZ * 2.8 - sideZ * 7.1],
        [-flightDirX * 5.0 + sideX * 5.8, -flightDirZ * 5.0 + sideZ * 5.8],
        [-flightDirX * 5.0 - sideX * 5.8, -flightDirZ * 5.0 - sideZ * 5.8],
        [0, 7.6],
      ];
      const chosen = this.pickBestCameraOffset(impactX, impactZ, killTickIdx, candidates, 2.65, 3.5);
      return {
        killTickIdx,
        killSimSec,
        slowStartSim,
        slowEndSim,
        exitEndSim,
        timeScale,
        cause,
        victimSeat,
        killerSeat,
        isDecisive,
        camOffX: chosen.ox,
        camOffZ: chosen.oz,
        camY: chosen.camY,
        flightDirX,
        flightDirZ,
        impactX,
        impactZ,
        fallVx,
        fallVz,
      };
    }

    if (cause === CauseType.SLASH) {
      const kp = killerSeat >= 0 ? killSnap.players[killerSeat] : null;
      let ax = 1;
      let az = 0;
      if (kp) {
        const dx = impactX - kp.x / 1000;
        const dz = impactZ - kp.y / 1000;
        const len = Math.hypot(dx, dz);
        if (len > 0.05) {
          ax = dx / len;
          az = dz / len;
        }
      }
      const perpX = -az;
      const perpZ = ax;
      const dist = 7.3;
      const candidates: [number, number][] = [
        [perpX * dist, perpZ * dist],
        [-perpX * dist, -perpZ * dist],
        [(perpX * 0.78 + ax * 0.62) * dist, (perpZ * 0.78 + az * 0.62) * dist],
        [(-perpX * 0.78 + ax * 0.62) * dist, (-perpZ * 0.78 + az * 0.62) * dist],
        [(perpX * 0.78 - ax * 0.62) * dist, (perpZ * 0.78 - az * 0.62) * dist],
        [(-perpX * 0.78 - ax * 0.62) * dist, (-perpZ * 0.78 - az * 0.62) * dist],
        [0, dist],
      ];
      const chosen = this.pickBestCameraOffset(impactX, impactZ, killTickIdx, candidates, 2.7, 3.55);
      return {
        killTickIdx,
        killSimSec,
        slowStartSim,
        slowEndSim,
        exitEndSim,
        timeScale,
        cause,
        victimSeat,
        killerSeat,
        isDecisive,
        camOffX: chosen.ox,
        camOffZ: chosen.oz,
        camY: chosen.camY,
        flightDirX: ax,
        flightDirZ: az,
        impactX,
        impactZ,
        fallVx,
        fallVz,
      };
    }

    // CauseType.FALL: place camera over open sky / cliffside looking back at the falling edge
    const cx = this.widthM * 0.5;
    const cz = this.heightM * 0.5;
    let outX = impactX - cx;
    let outZ = impactZ - cz;
    const outLen = Math.hypot(outX, outZ);
    if (outLen > 0.2) {
      outX /= outLen;
      outZ /= outLen;
    } else {
      outX = 0;
      outZ = 1;
    }
    const baseAngle = Math.atan2(outX, outZ);
    const dist = 7.4;
    const angleOffsets = [0.45, -0.45, 0, 0.85, -0.85, 1.3, -1.3];
    const candidates: [number, number][] = angleOffsets.map((da) => [
      Math.sin(baseAngle + da) * dist,
      Math.cos(baseAngle + da) * dist,
    ]);
    const chosen = this.pickBestCameraOffset(impactX, impactZ, killTickIdx, candidates, 2.85, 3.6);
    return {
      killTickIdx,
      killSimSec,
      slowStartSim,
      slowEndSim,
      exitEndSim,
      timeScale,
      cause,
      victimSeat,
      killerSeat,
      isDecisive,
      camOffX: chosen.ox,
      camOffZ: chosen.oz,
      camY: chosen.camY,
      flightDirX: outX,
      flightDirZ: outZ,
      impactX,
      impactZ,
      fallVx,
      fallVz,
    };
  }

  private planWinnerShot(explicitFinal?: TickSnapshot, glideDelaySim = 0): WinnerShotPlan | null {
    const finalSnap = explicitFinal ?? this.ticks[this.ticks.length - 1];
    if (!finalSnap || !finalSnap.over || finalSnap.winner < 0) return null;

    const seat = finalSnap.winner;
    const wp = finalSnap.players[seat];
    if (!wp || !wp.alive) return null;

    const wx = wp.x / 1000;
    const wz = wp.y / 1000;
    const finalTick = finalSnap.t;

    // Match reference portrait framing (CAM_FOV=26 -> 5.45m horizontal, ~20.8° slight downward eye-level,
    // leaving clean headroom below top-center HUD pill and above bottom victory banner during jumps!)
    const horizDist = 5.45;
    const camYBase = 2.75;
    const lookY = 0.68;

    // Prefer straight front (+Z, azimuth = 0), falling back to slight side angles only if blocked by a wall/tree
    const candidateAzimuths = [0, 0.34, -0.34, 0.65, -0.65, 1.0, -1.0, 1.45, -1.45, 2.1, -2.1, Math.PI];
    let bestAz = 0;
    let bestScore = Infinity;

    for (let i = 0; i < candidateAzimuths.length; i++) {
      const az = candidateAzimuths[i];
      const ox = Math.sin(az) * horizDist;
      const oz = Math.cos(az) * horizDist;
      const occ = this.measureWallOcclusion(wx, wz, wx + ox, wz + oz, finalTick);
      const score = occ * 12 + i * 0.15;
      if (score < bestScore) {
        bestScore = score;
        bestAz = az;
      }
      if (occ === 0) break;
    }

    const bestOx = Math.sin(bestAz) * horizDist;
    const bestOz = Math.cos(bestAz) * horizDist;
    const stillOccluded = this.measureWallOcclusion(wx, wz, wx + bestOx, wz + bestOz, finalTick) > 0;

    // Glide starts only after BOTH decisive slow-mo AND the 4-frame post-kill beat finish!
    const decisive = this.kills.find((k) => k.isDecisive);
    const minCelebrateSim = this.matchEndSimSec + WINNER_CELEBRATE_DELAY_SIM;
    const baseGlideStartSim = decisive ? decisive.slowEndSim : this.matchEndSimSec + glideDelaySim;
    const glideStartSim = Math.max(baseGlideStartSim, minCelebrateSim);
    const glideEndSim = glideStartSim + WINNER_GLIDE_REAL_SEC;

    return {
      seat,
      x: wx,
      z: wz,
      azimuth: bestAz,
      camX: wx + bestOx,
      camY: stillOccluded ? 3.25 : camYBase,
      camZ: wz + bestOz,
      lookX: wx,
      lookY,
      lookZ: wz,
      glideStartSim,
      glideEndSim,
    };
  }

  private pickBestCameraOffset(
    anchorX: number,
    anchorZ: number,
    tick: number,
    candidates: [number, number][],
    baseCamY: number,
    elevatedCamY: number,
  ): { ox: number; oz: number; camY: number } {
    let best = candidates[0];
    let bestScore = Infinity;
    let bestOcc = Infinity;

    for (let i = 0; i < candidates.length; i++) {
      const [ox, oz] = candidates[i];
      const occ = this.measureWallOcclusion(anchorX, anchorZ, anchorX + ox, anchorZ + oz, tick);
      // Strongly avoid walls; gently prefer +Z (front hemisphere) so spatial orientation feels natural
      const backPenalty = oz < -0.5 ? 1.8 : 0;
      const score = occ * 10 + backPenalty + i * 0.08;
      if (score < bestScore) {
        bestScore = score;
        bestOcc = occ;
        best = candidates[i];
      }
    }

    return {
      ox: best[0],
      oz: best[1],
      camY: bestOcc > 0.35 ? elevatedCamY : baseCamY,
    };
  }

  private measureWallOcclusion(x0: number, z0: number, x1: number, z1: number, tick: number): number {
    const { nx, ny, cells, waves, waveSteps } = this.mapData;
    const samples = 10;
    let occ = 0;
    for (let s = 1; s <= samples; s++) {
      const u = s / samples;
      const x = x0 + (x1 - x0) * u;
      const z = z0 + (z1 - z0) * u;
      const gx = Math.floor(x / this.cellM);
      const gy = Math.floor(z / this.cellM);
      if (gx < 0 || gy < 0 || gx >= nx || gy >= ny) continue;
      const idx = gy * nx + gx;
      if (cells[idx] !== CellType.WALL) continue;
      const w = waves[idx];
      if (w >= 0 && w < waveSteps.length && tick >= waveSteps[w]) continue;
      // Walls closer to the anchor or right in front of the lens block more of the shot
      occ += u >= 0.75 ? 1.4 : 1.0;
    }
    return occ;
  }

  private detectHitStopEvents(): HitStopEvent[] {
    // Exact port of upstream timeline.py:117-126:
    // Dart (1) & Slash (2) kills freeze at td + 0.6 ticks (3 frames @ 30fps normal, 5 frames @ 30fps final kill).
    const byTick = new Map<number, HitStopEvent>();
    for (let i = 1; i < this.ticks.length; i++) {
      const snap = this.ticks[i];
      for (const ev of snap.events) {
        if (ev.name !== 'DEATH') continue;
        const cause = ev.b as CauseType;
        if (cause !== CauseType.DART && cause !== CauseType.SLASH) continue;
        const isFinal = Boolean(snap.over);
        const dur = isFinal ? HITSTOP_FINAL_SEC : HITSTOP_NORMAL_SEC;
        const existing = byTick.get(i);
        if (existing) {
          if (isFinal) existing.isFinal = true;
          if (dur > existing.durationRealSec) existing.durationRealSec = dur;
        } else {
          byTick.set(i, {
            killTickIdx: i,
            stopSimSec: (i + HITSTOP_OFFSET_TICKS) * TICK_SEC,
            durationRealSec: dur,
            isFinal,
            realStartSec: 0,
            realEndSec: 0,
          });
        }
      }
    }
    return Array.from(byTick.values()).sort((a, b) => a.stopSimSec - b.stopSimSec);
  }

  private buildTimeIntervals(): TimeInterval[] {
    // Partition timeline by all slow-mo start/end breakpoints AND hit-stop pause moments
    // so mixed 0.5x / 0.25x slow-mo segments and 0x hit-stop freezes map monotonically & exactly!
    const points = new Set<number>([0]);
    for (const k of this.kills) {
      points.add(Math.max(0, k.slowStartSim));
      points.add(Math.max(0, k.slowEndSim));
    }
    const stopBySim = new Map<number, HitStopEvent>();
    for (const h of this.hitStops) {
      points.add(h.stopSimSec);
      stopBySim.set(h.stopSimSec, h);
    }
    const sorted = Array.from(points).sort((a, b) => a - b);

    const intervals: TimeInterval[] = [];
    let realCursor = 0;

    const emitPauseAt = (simPoint: number) => {
      const h = stopBySim.get(simPoint);
      if (!h) return;
      h.realStartSec = realCursor;
      h.realEndSec = realCursor + h.durationRealSec;
      intervals.push({
        simStart: simPoint,
        simEnd: simPoint,
        realStart: h.realStartSec,
        realEnd: h.realEndSec,
        scale: 0,
      });
      realCursor = h.realEndSec;
    };

    emitPauseAt(0);
    for (let i = 0; i < sorted.length - 1; i++) {
      const s0 = sorted[i];
      const s1 = sorted[i + 1];
      if (s1 - s0 > 1e-6) {
        const scale = this.getSpeedScaleAtSim((s0 + s1) * 0.5);
        const realDur = (s1 - s0) / scale;
        const prev = intervals[intervals.length - 1];
        if (prev && prev.scale > 0 && Math.abs(prev.scale - scale) < 1e-6 && Math.abs(prev.simEnd - s0) < 1e-6) {
          prev.simEnd = s1;
          prev.realEnd += realDur;
        } else {
          intervals.push({
            simStart: s0,
            simEnd: s1,
            realStart: realCursor,
            realEnd: realCursor + realDur,
            scale,
          });
        }
        realCursor += realDur;
      }
      emitPauseAt(s1);
    }

    const tailSim = sorted[sorted.length - 1] ?? 0;
    intervals.push({
      simStart: tailSim,
      simEnd: 1e9,
      realStart: realCursor,
      realEnd: realCursor + (1e9 - tailSim),
      scale: 1.0,
    });

    return intervals;
  }

  private samplePlayerPos(seat: number, simSec: number): { x: number; z: number } {
    const maxIdx = this.ticks.length - 1;
    const fIdx = clamp(simSec / TICK_SEC, 0, maxIdx);
    const i0 = Math.floor(fIdx);
    const i1 = Math.min(maxIdx, i0 + 1);
    const alpha = fIdx - i0;
    const p0 = this.ticks[i0].players[seat];
    const p1 = this.ticks[i1].players[seat];
    if (!p0 || !p1) return { x: this.widthM * 0.5, z: this.heightM * 0.5 };
    return {
      x: lerp(p0.x, p1.x, alpha) / 1000,
      z: lerp(p0.y, p1.y, alpha) / 1000,
    };
  }

  private sampleDartPos(seat: number, simSec: number): { x: number; z: number } {
    const maxIdx = this.ticks.length - 1;
    const fIdx = clamp(simSec / TICK_SEC, 0, maxIdx);
    const i0 = Math.floor(fIdx);
    const i1 = Math.min(maxIdx, i0 + 1);
    const alpha = fIdx - i0;
    const d0 = this.ticks[i0].darts[seat];
    const d1 = this.ticks[i1].darts[seat];
    const p0 = this.ticks[i0].players[seat];
    const p1 = this.ticks[i1].players[seat];

    const getPt = (d: typeof d0, p: typeof p0) => {
      if (d && d.st !== DState.HAND && d.st !== DState.GONE) {
        return { x: d.x / 1000, z: d.y / 1000 };
      }
      if (p) return { x: p.x / 1000, z: p.y / 1000 };
      return { x: this.widthM * 0.5, z: this.heightM * 0.5 };
    };

    const a = getPt(d0, p0);
    const b = getPt(d1, p1);
    return {
      x: lerp(a.x, b.x, alpha),
      z: lerp(a.z, b.z, alpha),
    };
  }
}
