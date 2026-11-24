import { applyCliffGuard } from './cliffGuard';
import { applyMeleeAssist } from './meleeAssist';
import { ActionBindKey, isBoundToAction, SettingsStore } from './settings';
import {
  ActType,
  DartSnapshot,
  DState,
  EngineMapData,
  HumanAction,
  PlayerSnapshot,
  PState,
  TickSnapshot,
} from './types';

/**
 * Human input controller driven by user-editable dual keybindings (keyboard & mouse buttons):
 * - Move Up/Down/Left/Right (2 slots each)
 * - Throw / Hold Recall (2 slots)
 * - Melee: Slash / Kick (2 slots)
 * - Dash (2 slots)
 * Includes responsive input buffering so clicks between logic ticks are never lost!
 */
export type InputMode = 'off' | 'countdown' | 'active';

export class HumanInputController {
  private pressedCodes = new Set<string>();
  private inputMode: InputMode = 'off';
  private paused = false;

  // Screen mouse coordinates (client space)
  public mouseX = window.innerWidth * 0.5;
  public mouseY = window.innerHeight * 0.5;
  public hasMouse = false;

  // Projected world aim point in game mm (updated every frame by renderer AND on-demand via aimProjector)
  public aimWorldMmX = 0;
  public aimWorldMmY = 0;
  private aimProjector: ((clientX: number, clientY: number) => [number, number] | null) | null = null;

  // Throw/recall hold tracking
  private throwConsumed = false;
  private groundSinceMs = -1;

  // Buffered one-shot actions (timestamp in ms)
  private queuedThrowAt = -1;
  private queuedMeleeAt = -1;
  private queuedDashAt = -1;
  private queuedDashToMouseAt = -1;
  private queuedDashTargetX = 0;
  private queuedDashTargetY = 0;
  private queuedDashHasTarget = false;

  // Dash pre-input buffer: retains throw pressed during dash and fires it on the
  // first operable tick after dash completes without interrupting dash (never blocks dash-slash melee).
  private dashBufferedThrowAt = -1;

  private bufferMs = 140;
  private recallHoldDelayMs = 160;
  private mapData: EngineMapData | null = null;
  private cliffGuard = true;
  private canvas: HTMLCanvasElement;
  private settings: SettingsStore;

  // ---------- Mobile virtual controls (touch mode) ----------
  // Screen axes map 1:1 onto world axes (camera never yaws in live matches): +x right, +y down/toward camera.
  private touchMode = false;
  private vMoveX = 0;
  private vMoveY = 0;
  private vAimHeld = false;
  private vThrowAt = -1;
  private vThrowDirX = 0;
  private vThrowDirY = 0;
  private vThrowAfterDash = false;
  private vMeleeAt = -1;
  private vMeleeDirX = 0;
  private vMeleeDirY = 0;
  private vMeleeAfterDash = false;
  private vDashAt = -1;

  constructor(canvas: HTMLCanvasElement, settings: SettingsStore) {
    this.canvas = canvas;
    this.settings = settings;
    this.cliffGuard = settings.get().cliffGuard;
    this.bindEvents();
  }

  public setMapData(mapData: EngineMapData | null) {
    this.mapData = mapData;
  }

  public setCliffGuard(enabled: boolean) {
    this.cliffGuard = enabled;
  }

  public isCliffGuard(): boolean {
    return this.cliffGuard;
  }

  public setTickIntervalMs(tickMs: number) {
    this.bufferMs = Math.max(140, tickMs * 1.15);
    this.recallHoldDelayMs = Math.min(240, Math.max(120, tickMs * 1.1));
  }

  /**
   * Pause gameplay input capture while Settings modal is open mid-match.
   */
  public setPaused(v: boolean) {
    this.paused = v;
    if (v) {
      this.pressedCodes.clear();
      this.throwConsumed = false;
      this.queuedThrowAt = -1;
      this.queuedMeleeAt = -1;
      this.queuedDashAt = -1;
      this.queuedDashToMouseAt = -1;
      this.queuedDashHasTarget = false;
      this.dashBufferedThrowAt = -1;
      this.resetVirtual();
    }
  }

  // ---------- Mobile virtual control API ----------

  public setTouchMode(on: boolean) {
    if (this.touchMode === on) return;
    this.touchMode = on;
    this.resetVirtual();
    if (on) this.hasMouse = false;
  }

  public isTouchMode(): boolean {
    return this.touchMode;
  }

  public getInputMode(): InputMode {
    return this.inputMode;
  }

  private resetVirtual() {
    this.vMoveX = 0;
    this.vMoveY = 0;
    this.vAimHeld = false;
    this.vThrowAt = -1;
    this.vThrowAfterDash = false;
    this.vMeleeAt = -1;
    this.vMeleeAfterDash = false;
    this.vDashAt = -1;
  }

  /** Left stick: analog vector in screen space, magnitude 0..1. */
  public setVirtualMove(x: number, y: number) {
    this.vMoveX = Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0;
    this.vMoveY = Number.isFinite(y) ? Math.max(-1, Math.min(1, y)) : 0;
  }

  /** Right stick held while the dart is NOT in hand → behaves like holding the Throw/Recall key. */
  public setVirtualRecallHeld(held: boolean) {
    if (held && !this.vAimHeld) this.throwConsumed = false;
    this.vAimHeld = held;
    if (!held && !this.isThrowRecallHeld()) this.throwConsumed = false;
  }

  /**
   * Right stick released after aiming: throw toward (dirX, dirY) (screen space, any length;
   * zero = current facing). `afterDash` keeps the throw buffered through a dash so it fires on the
   * first free tick after the dash ends.
   */
  public queueVirtualThrow(dirX: number, dirY: number, afterDash = false) {
    if (this.inputMode !== 'active' || this.paused) return;
    const len = Math.hypot(dirX, dirY);
    this.vThrowDirX = len > 1e-4 ? dirX / len : 0;
    this.vThrowDirY = len > 1e-4 ? dirY / len : 0;
    this.vThrowAt = performance.now();
    this.vThrowAfterDash = afterDash;
  }

  /** Slash button: melee toward the move-stick direction when held, else current facing. */
  public queueVirtualMelee() {
    if (this.inputMode !== 'active' || this.paused) return;
    this.vMeleeAt = performance.now();
    this.vMeleeAfterDash = false;
    const len = Math.hypot(this.vMoveX, this.vMoveY);
    if (len >= 0.2) {
      this.vMeleeDirX = this.vMoveX / len;
      this.vMeleeDirY = this.vMoveY / len;
    } else {
      this.vMeleeDirX = 0;
      this.vMeleeDirY = 0;
    }
  }

  /** Dash button: dash toward the move-stick direction when held, else current facing. */
  public queueVirtualDash() {
    if (this.inputMode !== 'active' || this.paused) return;
    this.vDashAt = performance.now();
  }

  public setAimProjector(fn: ((clientX: number, clientY: number) => [number, number] | null) | null) {
    this.aimProjector = fn;
  }

  private refreshAimFromPointer() {
    if (!this.hasMouse || !this.aimProjector) return;
    const hit = this.aimProjector(this.mouseX, this.mouseY);
    if (hit) {
      this.aimWorldMmX = hit[0];
      this.aimWorldMmY = hit[1];
    }
  }

  public setInputMode(mode: InputMode) {
    const prev = this.inputMode;
    this.inputMode = mode;
    if (mode === 'off' || mode === 'countdown') {
      this.reset();
    } else if (mode === 'active' && prev === 'countdown') {
      // Keep pre-held movement keys from countdown, while clearing any stale action state
      this.throwConsumed = false;
      this.groundSinceMs = -1;
      this.queuedThrowAt = -1;
      this.queuedMeleeAt = -1;
      this.queuedDashAt = -1;
      this.queuedDashToMouseAt = -1;
      this.queuedDashHasTarget = false;
      this.dashBufferedThrowAt = -1;
    }
  }

  public setEnabled(v: boolean) {
    this.setInputMode(v ? 'active' : 'off');
  }

  public reset() {
    this.pressedCodes.clear();
    this.throwConsumed = false;
    this.groundSinceMs = -1;
    this.queuedThrowAt = -1;
    this.queuedMeleeAt = -1;
    this.queuedDashAt = -1;
    this.queuedDashToMouseAt = -1;
    this.queuedDashHasTarget = false;
    this.dashBufferedThrowAt = -1;
    this.resetVirtual();
  }

  private isActionHeld(action: ActionBindKey): boolean {
    const pair = this.settings.get().keybindings[action];
    return (
      (pair[0] !== null && this.pressedCodes.has(pair[0])) ||
      (pair[1] !== null && this.pressedCodes.has(pair[1]))
    );
  }

  public isThrowRecallHeld(): boolean {
    return this.isActionHeld('throwRecall') || (this.touchMode && this.vAimHeld);
  }

  private bindEvents() {
    window.addEventListener('keydown', (e) => {
      if (this.paused || this.inputMode === 'off') return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const code = e.code;
      const kb = this.settings.get().keybindings;

      const isMove =
        isBoundToAction(kb, 'moveUp', code) ||
        isBoundToAction(kb, 'moveDown', code) ||
        isBoundToAction(kb, 'moveLeft', code) ||
        isBoundToAction(kb, 'moveRight', code);

      if (isMove) {
        this.pressedCodes.add(code);
        if (code === 'Space' || code.startsWith('Arrow')) e.preventDefault();
      }

      if (this.inputMode === 'active') {
        const now = performance.now();
        if (isBoundToAction(kb, 'dash', code)) {
          if (code === 'Space') e.preventDefault();
          if (!e.repeat) this.queuedDashAt = now;
          this.pressedCodes.add(code);
        }
        if (isBoundToAction(kb, 'dashToMouse', code)) {
          if (code === 'Space') e.preventDefault();
          if (!e.repeat) {
            this.refreshAimFromPointer();
            this.queuedDashToMouseAt = now;
            this.queuedDashHasTarget = this.hasMouse;
            this.queuedDashTargetX = this.aimWorldMmX;
            this.queuedDashTargetY = this.aimWorldMmY;
          }
          this.pressedCodes.add(code);
        }
        if (isBoundToAction(kb, 'melee', code)) {
          if (code === 'Space') e.preventDefault();
          if (!e.repeat) this.queuedMeleeAt = now;
          this.pressedCodes.add(code);
        }
        if (isBoundToAction(kb, 'throwRecall', code)) {
          if (code === 'Space') e.preventDefault();
          this.pressedCodes.add(code);
          if (!e.repeat) {
            this.throwConsumed = false;
            this.queuedThrowAt = now;
          }
        }
      }
    });

    window.addEventListener('keyup', (e) => {
      this.pressedCodes.delete(e.code);
      if (!this.isThrowRecallHeld()) {
        this.throwConsumed = false;
      }
    });

    window.addEventListener('blur', () => {
      this.pressedCodes.clear();
      this.throwConsumed = false;
    });

    const onRawPointer = (e: PointerEvent) => {
      // Fingers never drive the PC aim cursor (touch controls have their own sticks)
      if (e.pointerType === 'touch' || this.touchMode) return;
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
      this.hasMouse = true;
    };
    if ('onpointerrawupdate' in window) {
      window.addEventListener('pointerrawupdate', onRawPointer as EventListener, { passive: true });
    }
    window.addEventListener('pointermove', onRawPointer, { passive: true });

    this.canvas.addEventListener('mousedown', (e) => {
      if (this.touchMode) return;
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
      this.hasMouse = true;
      this.refreshAimFromPointer();
      if (this.paused || this.inputMode === 'off') return;

      const code = `Mouse${e.button}`;
      const kb = this.settings.get().keybindings;
      const isMove =
        isBoundToAction(kb, 'moveUp', code) ||
        isBoundToAction(kb, 'moveDown', code) ||
        isBoundToAction(kb, 'moveLeft', code) ||
        isBoundToAction(kb, 'moveRight', code);

      if (isMove) {
        this.pressedCodes.add(code);
      }

      if (this.inputMode !== 'active') return;
      const now = performance.now();

      if (isBoundToAction(kb, 'throwRecall', code)) {
        if (e.button !== 0) e.preventDefault();
        this.pressedCodes.add(code);
        this.throwConsumed = false;
        this.queuedThrowAt = now;
      }
      if (isBoundToAction(kb, 'melee', code)) {
        e.preventDefault();
        this.pressedCodes.add(code);
        this.queuedMeleeAt = now;
      }
      if (isBoundToAction(kb, 'dash', code)) {
        e.preventDefault();
        this.pressedCodes.add(code);
        this.queuedDashAt = now;
      }
      if (isBoundToAction(kb, 'dashToMouse', code)) {
        e.preventDefault();
        this.pressedCodes.add(code);
        this.queuedDashToMouseAt = now;
        this.queuedDashHasTarget = this.hasMouse;
        this.queuedDashTargetX = this.aimWorldMmX;
        this.queuedDashTargetY = this.aimWorldMmY;
      }
    });

    window.addEventListener('mouseup', (e) => {
      this.pressedCodes.delete(`Mouse${e.button}`);
      if (!this.isThrowRecallHeld()) {
        this.throwConsumed = false;
      }
    });
  }

  private getMoveVector(): [number, number] {
    let mx = 0;
    let my = 0;
    if (this.isActionHeld('moveLeft')) mx -= 1;
    if (this.isActionHeld('moveRight')) mx += 1;
    if (this.isActionHeld('moveUp')) my -= 1;
    if (this.isActionHeld('moveDown')) my += 1;
    if (mx === 0 && my === 0) return [0, 0];
    const len = Math.hypot(mx, my);
    return [Math.round((mx / len) * 1000), Math.round((my / len) * 1000)];
  }

  private getAimVector(playerX: number, playerY: number, face: number): [number, number] {
    if (this.hasMouse) {
      this.refreshAimFromPointer();
      const dx = this.aimWorldMmX - playerX;
      const dy = this.aimWorldMmY - playerY;
      const len = Math.hypot(dx, dy);
      if (len > 10) {
        return [Math.round((dx / len) * 1000), Math.round((dy / len) * 1000)];
      }
    }
    const rad = (face / 100) * (Math.PI / 180);
    return [Math.round(Math.cos(rad) * 1000), Math.round(Math.sin(rad) * 1000)];
  }

  /**
   * Sample human action at the exact logic tick boundary.
   */
  public sampleAction(state: TickSnapshot | null, seat: number): HumanAction {
    const raw = this.sampleRawAction(state, seat);
    if (this.cliffGuard && this.mapData && state && this.inputMode === 'active' && !this.paused) {
      return applyCliffGuard(this.mapData, state, seat, raw);
    }
    return raw;
  }

  private sampleRawAction(state: TickSnapshot | null, seat: number): HumanAction {
    if (this.paused || this.inputMode !== 'active' || !state || seat < 0 || seat >= state.n) {
      return { mx: 0, my: 0, act: ActType.NONE, ax: 0, ay: 0, msg: 0 };
    }
    const me = state.players[seat];
    const dart = state.darts[seat];
    if (!me || !me.alive) {
      this.dashBufferedThrowAt = -1;
      this.resetVirtualActions();
      return { mx: 0, my: 0, act: ActType.NONE, ax: 0, ay: 0, msg: 0 };
    }

    if (this.touchMode) {
      return this.sampleTouchAction(state, seat, me, dart);
    }

    const now = performance.now();
    const [mx, my] = this.getMoveVector();
    const [aimX, aimY] = this.getAimVector(me.x, me.y, me.face);

    if (dart.st === DState.GROUND) {
      if (this.groundSinceMs < 0) this.groundSinceMs = now;
    } else if (dart.st !== DState.RISE) {
      this.groundSinceMs = -1;
    }

    const dashBufferEnabled = this.settings.get().dashInputBuffer;
    if (!dashBufferEnabled) {
      this.dashBufferedThrowAt = -1;
    }

    const hasBufferedDash = this.queuedDashAt > 0 && now - this.queuedDashAt <= this.bufferMs;
    const hasBufferedDashToMouse = this.queuedDashToMouseAt > 0 && now - this.queuedDashToMouseAt <= this.bufferMs;
    const hasBufferedMelee = this.queuedMeleeAt > 0 && now - this.queuedMeleeAt <= this.bufferMs;
    const hasBufferedThrow = this.queuedThrowAt > 0 && now - this.queuedThrowAt <= this.bufferMs;

    const makeMeleeAction = (): HumanAction => {
      let ax = aimX;
      let ay = aimY;
      if (this.settings.get().meleeAssist && this.mapData) {
        [ax, ay] = applyMeleeAssist(this.mapData, state, seat, aimX, aimY);
      }
      return { mx, my, act: ActType.MELEE, ax, ay, msg: 0 };
    };

    // A. During DASH
    if (me.st === PState.DASH) {
      // Dash-cancel melee ("冲刺斩") ALWAYS works during dash moving ticks (timer 3..6),
      // completely unaffected by dash throw pre-input!
      const canDashMelee = me.timer >= 3 && me.timer <= 6;
      if (hasBufferedMelee && canDashMelee) {
        this.queuedMeleeAt = -1;
        this.dashBufferedThrowAt = -1;
        return makeMeleeAction();
      }
      if (this.queuedMeleeAt > 0 && now - this.queuedMeleeAt > this.bufferMs) {
        this.queuedMeleeAt = -1;
      }

      if (dashBufferEnabled) {
        // Buffer ONLY Throw during dash without interrupting dash
        if (hasBufferedThrow && this.queuedThrowAt >= this.dashBufferedThrowAt) {
          this.dashBufferedThrowAt = this.queuedThrowAt;
        }
        this.queuedThrowAt = -1;
      } else if (this.queuedThrowAt > 0 && now - this.queuedThrowAt > this.bufferMs) {
        this.queuedThrowAt = -1;
      }
      return { mx, my, act: ActType.NONE, ax: 0, ay: 0, msg: 0 };
    }

    // B. First operable tick after DASH completes -> fire buffered Throw (unless a newer Melee was pressed)
    if (dashBufferEnabled && this.dashBufferedThrowAt > 0) {
      if (me.st === PState.FREE) {
        const savedThrowAt = this.dashBufferedThrowAt;
        this.dashBufferedThrowAt = -1;
        if (hasBufferedMelee && this.queuedMeleeAt >= savedThrowAt) {
          this.queuedMeleeAt = -1;
          this.queuedThrowAt = -1;
          return makeMeleeAction();
        }
        this.queuedThrowAt = -1;
        if (dart.st === DState.HAND) {
          this.throwConsumed = true;
          return { mx, my, act: ActType.THROW, ax: aimX, ay: aimY, msg: 0 };
        }
      } else {
        // Exited dash abnormally (e.g. stunned/slashing): discard stale dash throw buffer
        this.dashBufferedThrowAt = -1;
      }
    }

    const canStartNew = me.st === PState.FREE || me.st === PState.RECALL;
    const anyBufferedDash = hasBufferedDash || hasBufferedDashToMouse;
    const latestDashAt = Math.max(
      hasBufferedDash ? this.queuedDashAt : -1,
      hasBufferedDashToMouse ? this.queuedDashToMouseAt : -1,
    );

    // If Dash was pressed strictly BEFORE Melee inside the same inter-tick window,
    // execute Dash first and keep the newer Melee queued so it can dash-slash naturally.
    const dashPrecedesMelee =
      anyBufferedDash &&
      canStartNew &&
      me.cd === 0 &&
      hasBufferedMelee &&
      latestDashAt < this.queuedMeleeAt;

    // 1. Priority: Melee (Slash / Kick)
    if (hasBufferedMelee && canStartNew && !dashPrecedesMelee) {
      this.queuedMeleeAt = -1;
      return makeMeleeAction();
    }

    // 2. Priority: Dash (movement-direction dash or exact-target dash toward mouse cursor)
    if (anyBufferedDash && canStartNew && me.cd === 0) {
      const useMouseDir =
        hasBufferedDashToMouse && (!hasBufferedDash || this.queuedDashToMouseAt >= this.queuedDashAt);
      const hasSnapTarget = useMouseDir && this.queuedDashHasTarget;
      const targetX = this.queuedDashTargetX;
      const targetY = this.queuedDashTargetY;
      this.queuedDashAt = -1;
      this.queuedDashToMouseAt = -1;
      this.queuedDashHasTarget = false;

      if (dashBufferEnabled) {
        // Promote ONLY Throw pressed AFTER Dash in the same tick window into dash pre-input buffer.
        if (hasBufferedThrow && this.queuedThrowAt > latestDashAt) {
          this.dashBufferedThrowAt = this.queuedThrowAt;
        } else {
          this.dashBufferedThrowAt = -1;
        }
        this.queuedThrowAt = -1;
      }

      if (useMouseDir) {
        let dx = aimX;
        let dy = aimY;
        if (hasSnapTarget) {
          const rx = targetX - me.x;
          const ry = targetY - me.y;
          const len = Math.hypot(rx, ry);
          if (len > 10) {
            dx = Math.round((rx / len) * 1000);
            dy = Math.round((ry / len) * 1000);
          }
          return { mx, my, act: ActType.DASH, ax: dx, ay: dy, msg: 0, dashTargetX: targetX, dashTargetY: targetY };
        }
        return { mx, my, act: ActType.DASH, ax: dx, ay: dy, msg: 0 };
      }
      const [dx, dy] = mx !== 0 || my !== 0 ? [mx, my] : [aimX, aimY];
      return { mx, my, act: ActType.DASH, ax: dx, ay: dy, msg: 0 };
    }

    // 3. Priority: Throw when holding dart
    if (hasBufferedThrow && dart.st === DState.HAND && me.st === PState.FREE) {
      this.queuedThrowAt = -1;
      this.throwConsumed = true;
      return { mx, my, act: ActType.THROW, ax: aimX, ay: aimY, msg: 0 };
    }

    // 4. Hold Throw/Recall key -> Recall when dart is on the ground or already rising
    const recallHeld = this.isThrowRecallHeld();
    const wantsRecall =
      recallHeld &&
      (dart.st === DState.RISE ||
        (dart.st === DState.GROUND &&
          (!this.throwConsumed || (this.groundSinceMs > 0 && now - this.groundSinceMs >= this.recallHoldDelayMs))));

    if (wantsRecall && (me.st === PState.FREE || me.st === PState.RECALL)) {
      return { mx: 0, my: 0, act: ActType.RECALL, ax: 0, ay: 0, msg: 0 };
    }

    // Release recall cleanly while stationary
    if (!wantsRecall && me.st === PState.RECALL) {
      const cancelMx = mx !== 0 || my !== 0 ? mx : 1;
      return { mx: cancelMx, my, act: ActType.NONE, ax: 0, ay: 0, msg: 0 };
    }

    if (this.queuedThrowAt > 0 && now - this.queuedThrowAt > this.bufferMs) {
      this.queuedThrowAt = -1;
    }

    return { mx, my, act: ActType.NONE, ax: 0, ay: 0, msg: 0 };
  }

  private resetVirtualActions() {
    this.vThrowAt = -1;
    this.vThrowAfterDash = false;
    this.vMeleeAt = -1;
    this.vMeleeAfterDash = false;
    this.vDashAt = -1;
  }

  /** Analog left stick → engine move vector (|v| ≥ 1000 = full speed, shorter = proportional walk). */
  private getVirtualMoveVector(): [number, number] {
    const m = Math.hypot(this.vMoveX, this.vMoveY);
    if (m < 0.1) return [0, 0];
    const speed = Math.min(1, 0.35 + ((m - 0.1) / 0.45) * 0.65);
    return [Math.round((this.vMoveX / m) * speed * 1000), Math.round((this.vMoveY / m) * speed * 1000)];
  }

  /**
   * Touch-control sampling with explicit dash pre-input:
   * - Slash pressed during a dash → buffered (dash is never cut short) and fired on the first free tick
   *   after it, toward the live move-stick direction (falls back to the stick at press time, then facing).
   * - Throw released while dashing → buffered and fired on the first free tick after the dash.
   * - Otherwise one-shot presses live for `bufferMs`, earliest press executes first.
   */
  private sampleTouchAction(state: TickSnapshot, seat: number, p: PlayerSnapshot, dart: DartSnapshot): HumanAction {
    const now = performance.now();
    const [mx, my] = this.getVirtualMoveVector();
    const faceRad = (p.face / 100) * (Math.PI / 180);
    const faceX = Math.round(Math.cos(faceRad) * 1000);
    const faceY = Math.round(Math.sin(faceRad) * 1000);
    const stickLen = Math.hypot(this.vMoveX, this.vMoveY);
    const stickDir: [number, number] | null =
      stickLen >= 0.2
        ? [Math.round((this.vMoveX / stickLen) * 1000), Math.round((this.vMoveY / stickLen) * 1000)]
        : null;

    if (dart.st === DState.GROUND) {
      if (this.groundSinceMs < 0) this.groundSinceMs = now;
    } else if (dart.st !== DState.RISE) {
      this.groundSinceMs = -1;
    }

    const meleeDir = (): [number, number] => {
      if (stickDir) return stickDir;
      if (this.vMeleeDirX !== 0 || this.vMeleeDirY !== 0) {
        return [Math.round(this.vMeleeDirX * 1000), Math.round(this.vMeleeDirY * 1000)];
      }
      return [faceX, faceY];
    };
    const makeMelee = (): HumanAction => {
      let [ax, ay] = meleeDir();
      if (this.settings.get().meleeAssist && this.mapData) {
        [ax, ay] = applyMeleeAssist(this.mapData, state, seat, ax, ay);
      }
      this.vMeleeAt = -1;
      this.vMeleeAfterDash = false;
      return { mx, my, act: ActType.MELEE, ax, ay, msg: 0 };
    };
    const expired = (at: number, sticky: boolean) => at > 0 && !sticky && now - at > this.bufferMs;

    // A. During DASH: never interrupt it — slash / throw pressed now are held for the first free tick
    if (p.st === PState.DASH) {
      if (this.vMeleeAt > 0) this.vMeleeAfterDash = true;
      if (this.vThrowAt > 0) this.vThrowAfterDash = true;
      if (expired(this.vDashAt, false)) this.vDashAt = -1;
      return { mx, my, act: ActType.NONE, ax: 0, ay: 0, msg: 0 };
    }

    const canStartNew = p.st === PState.FREE || p.st === PState.RECALL;
    // Got hit (stunned / slashed / kicked) before the buffered follow-up could land → drop it
    const interrupted = p.st === PState.STUN || p.st === PState.SLASHED || p.st === PState.KICKED;
    if (interrupted) {
      if (this.vMeleeAfterDash) {
        this.vMeleeAt = -1;
        this.vMeleeAfterDash = false;
      }
      if (this.vThrowAfterDash) {
        this.vThrowAt = -1;
        this.vThrowAfterDash = false;
      }
    }
    if (expired(this.vMeleeAt, this.vMeleeAfterDash)) this.vMeleeAt = -1;
    if (expired(this.vThrowAt, this.vThrowAfterDash)) {
      this.vThrowAt = -1;
    }
    if (expired(this.vDashAt, false)) this.vDashAt = -1;

    if (canStartNew) {
      type Cand = { at: number; run: () => HumanAction | null };
      const cands: Cand[] = [];
      if (this.vMeleeAt > 0) cands.push({ at: this.vMeleeAt, run: makeMelee });
      if (this.vDashAt > 0 && p.cd === 0) {
        cands.push({
          at: this.vDashAt,
          run: () => {
            this.vDashAt = -1;
            const [dx, dy] = stickDir ?? [faceX, faceY];
            return { mx, my, act: ActType.DASH, ax: dx, ay: dy, msg: 0 };
          },
        });
      }
      if (this.vThrowAt > 0) {
        cands.push({
          at: this.vThrowAt,
          run: () => {
            const hasDir = this.vThrowDirX !== 0 || this.vThrowDirY !== 0;
            this.vThrowAt = -1;
            this.vThrowAfterDash = false;
            if (dart.st !== DState.HAND || p.st !== PState.FREE) return null;
            this.throwConsumed = true;
            const ax = hasDir ? Math.round(this.vThrowDirX * 1000) : faceX;
            const ay = hasDir ? Math.round(this.vThrowDirY * 1000) : faceY;
            return { mx, my, act: ActType.THROW, ax, ay, msg: 0 };
          },
        });
      }
      cands.sort((a, b) => a.at - b.at);
      for (const c of cands) {
        const act = c.run();
        if (act) return act;
      }
    }

    // Hold right stick (dart not in hand) → recall, identical rules to holding the Throw/Recall key
    const recallHeld = this.isThrowRecallHeld();
    const wantsRecall =
      recallHeld &&
      (dart.st === DState.RISE ||
        (dart.st === DState.GROUND &&
          (!this.throwConsumed || (this.groundSinceMs > 0 && now - this.groundSinceMs >= this.recallHoldDelayMs))));

    if (wantsRecall && canStartNew) {
      return { mx: 0, my: 0, act: ActType.RECALL, ax: 0, ay: 0, msg: 0 };
    }
    if (!wantsRecall && p.st === PState.RECALL) {
      const cancelMx = mx !== 0 || my !== 0 ? mx : 1;
      return { mx: cancelMx, my, act: ActType.NONE, ax: 0, ay: 0, msg: 0 };
    }

    return { mx, my, act: ActType.NONE, ax: 0, ay: 0, msg: 0 };
  }
}
