import { applyCliffGuard } from './cliffGuard';
import { applyMeleeAssist, applyMobileMeleeAssist, hasMobileMeleeHitOpportunity } from './meleeAssist';
import { ActionBindKey, getSlashJudgmentTicks, isBoundToAction, SettingsStore } from './settings';
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
 * Supports unified pre-input across all action-locked states (preserving the mouse target
 * captured at press time, keeping only the last command per locked interval, and discarding
 * it if invalid on the unlock tick) as well as dash-cancel melee ("冲刺斩/踢") on both desktop & mobile.
 */
export type InputMode = 'off' | 'countdown' | 'active';

type DesktopPressKind = 'throw' | 'melee' | 'dash' | 'dashToMouse';

interface DesktopPress {
  kind: DesktopPressKind;
  at: number;
  hasTarget: boolean;
  targetX: number;
  targetY: number;
  moveX: number;
  moveY: number;
}

type TouchPressKind = 'throw' | 'melee' | 'dash';

interface TouchPress {
  kind: TouchPressKind;
  at: number;
  dirX: number;
  dirY: number;
}

function isActionLockedState(st: number): boolean {
  return st !== PState.FREE && st !== PState.RECALL;
}

function isDashMovingWindow(p: PlayerSnapshot): boolean {
  return p.st === PState.DASH && p.timer >= 3 && p.timer <= 6;
}

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

  // Desktop FIFO inter-tick press queue + single locked-state pre-input slot
  private pendingPresses: DesktopPress[] = [];
  private lockedPreInput: DesktopPress | null = null;
  private lastSampledLocked = false;

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
  private vAiming = false;
  private touchPendingPresses: TouchPress[] = [];
  private touchLockedPreInput: TouchPress | null = null;
  private touchLastSampledLocked = false;

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
      this.pendingPresses.length = 0;
      this.lockedPreInput = null;
      this.lastSampledLocked = false;
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
    this.vAiming = false;
    this.touchPendingPresses.length = 0;
    this.touchLockedPreInput = null;
    this.touchLastSampledLocked = false;
  }

  /** Left stick: analog vector in screen space, magnitude 0..1. */
  public setVirtualMove(x: number, y: number) {
    this.vMoveX = Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0;
    this.vMoveY = Number.isFinite(y) ? Math.max(-1, Math.min(1, y)) : 0;
  }

  /** Right stick actively aiming a throw: caps walking movement speed to 50% (matching throw_move = 50%). */
  public setVirtualAiming(aiming: boolean) {
    this.vAiming = aiming;
  }

  /** Right stick held while the dart is NOT in hand → behaves like holding the Throw/Recall key. */
  public setVirtualRecallHeld(held: boolean) {
    if (held && !this.vAimHeld) this.throwConsumed = false;
    this.vAimHeld = held;
    if (!held && !this.isThrowRecallHeld()) this.throwConsumed = false;
  }

  /**
   * Right stick released after aiming: throw toward (dirX, dirY) (screen space, any length;
   * zero = current facing). When pre-input is enabled, throws queued during any locked state
   * fire on the first free tick (or discard if invalid on unlock).
   */
  public queueVirtualThrow(dirX: number, dirY: number, _afterDash = false) {
    if (this.inputMode !== 'active' || this.paused) return;
    const len = Math.hypot(dirX, dirY);
    this.touchPendingPresses.push({
      kind: 'throw',
      at: performance.now(),
      dirX: len > 1e-4 ? dirX / len : 0,
      dirY: len > 1e-4 ? dirY / len : 0,
    });
  }

  /** Slash/Kick button: melee toward the move-stick direction when held, else current facing. Supports dash-slash/kick. */
  public queueVirtualMelee() {
    if (this.inputMode !== 'active' || this.paused) return;
    const len = Math.hypot(this.vMoveX, this.vMoveY);
    this.touchPendingPresses.push({
      kind: 'melee',
      at: performance.now(),
      dirX: len >= 0.06 ? this.vMoveX / len : 0,
      dirY: len >= 0.06 ? this.vMoveY / len : 0,
    });
  }

  /** Dash button: dash toward the move-stick direction when held, else current facing. */
  public queueVirtualDash() {
    if (this.inputMode !== 'active' || this.paused) return;
    const len = Math.hypot(this.vMoveX, this.vMoveY);
    this.touchPendingPresses.push({
      kind: 'dash',
      at: performance.now(),
      dirX: len >= 0.06 ? this.vMoveX / len : 0,
      dirY: len >= 0.06 ? this.vMoveY / len : 0,
    });
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

  private recordDesktopPress(kind: DesktopPressKind) {
    this.refreshAimFromPointer();
    const [moveX, moveY] = this.getMoveVector();
    this.pendingPresses.push({
      kind,
      at: performance.now(),
      hasTarget: this.hasMouse,
      targetX: this.aimWorldMmX,
      targetY: this.aimWorldMmY,
      moveX,
      moveY,
    });
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
      this.pendingPresses.length = 0;
      this.lockedPreInput = null;
      this.lastSampledLocked = false;
      this.resetVirtualActions();
    }
  }

  public setEnabled(v: boolean) {
    this.setInputMode(v ? 'active' : 'off');
  }

  public reset() {
    this.pressedCodes.clear();
    this.throwConsumed = false;
    this.groundSinceMs = -1;
    this.pendingPresses.length = 0;
    this.lockedPreInput = null;
    this.lastSampledLocked = false;
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
      } else if (
        code === 'Space' &&
        (isBoundToAction(kb, 'dash', code) ||
          isBoundToAction(kb, 'dashToMouse', code) ||
          isBoundToAction(kb, 'melee', code) ||
          isBoundToAction(kb, 'throwRecall', code))
      ) {
        e.preventDefault();
      }

      if (this.inputMode === 'active') {
        if (isBoundToAction(kb, 'dash', code)) {
          if (code === 'Space') e.preventDefault();
          if (!e.repeat) this.recordDesktopPress('dash');
          this.pressedCodes.add(code);
        }
        if (isBoundToAction(kb, 'dashToMouse', code)) {
          if (code === 'Space') e.preventDefault();
          if (!e.repeat) this.recordDesktopPress('dashToMouse');
          this.pressedCodes.add(code);
        }
        if (isBoundToAction(kb, 'melee', code)) {
          if (code === 'Space') e.preventDefault();
          if (!e.repeat) this.recordDesktopPress('melee');
          this.pressedCodes.add(code);
        }
        if (isBoundToAction(kb, 'throwRecall', code)) {
          if (code === 'Space') e.preventDefault();
          this.pressedCodes.add(code);
          if (!e.repeat) {
            this.throwConsumed = false;
            this.recordDesktopPress('throw');
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

      if (isBoundToAction(kb, 'throwRecall', code)) {
        if (e.button !== 0) e.preventDefault();
        this.pressedCodes.add(code);
        this.throwConsumed = false;
        this.recordDesktopPress('throw');
      }
      if (isBoundToAction(kb, 'melee', code)) {
        e.preventDefault();
        this.pressedCodes.add(code);
        this.recordDesktopPress('melee');
      }
      if (isBoundToAction(kb, 'dash', code)) {
        e.preventDefault();
        this.pressedCodes.add(code);
        this.recordDesktopPress('dash');
      }
      if (isBoundToAction(kb, 'dashToMouse', code)) {
        e.preventDefault();
        this.pressedCodes.add(code);
        this.recordDesktopPress('dashToMouse');
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
   * Computes directional aim from actual release position `(playerX, playerY)` toward the
   * snapshotted mouse world coordinates captured when the command was pressed.
   */
  private getAimVectorForPress(press: DesktopPress, playerX: number, playerY: number, face: number): [number, number] {
    if (press.hasTarget) {
      const dx = press.targetX - playerX;
      const dy = press.targetY - playerY;
      const len = Math.hypot(dx, dy);
      if (len > 10) {
        return [Math.round((dx / len) * 1000), Math.round((dy / len) * 1000)];
      }
    }
    return this.getAimVector(playerX, playerY, face);
  }

  private tryBuildDesktopAction(
    press: DesktopPress,
    state: TickSnapshot,
    seat: number,
    me: PlayerSnapshot,
    dart: DartSnapshot,
    mx: number,
    my: number,
  ): HumanAction | null {
    const canStartNew = !isActionLockedState(me.st);
    const canDashMelee = isDashMovingWindow(me);

    if (press.kind === 'melee') {
      if (!canStartNew && !canDashMelee) return null;
      let [ax, ay] = this.getAimVectorForPress(press, me.x, me.y, me.face);
      if (this.settings.get().meleeAssist && this.mapData) {
        [ax, ay] = applyMeleeAssist(this.mapData, state, seat, ax, ay);
      }
      return { mx, my, act: ActType.MELEE, ax, ay, msg: 0 };
    }

    if (press.kind === 'dash') {
      if (!canStartNew || me.cd > 0) return null;
      let dx: number;
      let dy: number;
      if (mx !== 0 || my !== 0) {
        dx = mx;
        dy = my;
      } else if (press.moveX !== 0 || press.moveY !== 0) {
        dx = press.moveX;
        dy = press.moveY;
      } else {
        [dx, dy] = this.getAimVectorForPress(press, me.x, me.y, me.face);
      }
      return { mx, my, act: ActType.DASH, ax: dx, ay: dy, msg: 0 };
    }

    if (press.kind === 'dashToMouse') {
      if (!canStartNew || me.cd > 0) return null;
      const [dx, dy] = this.getAimVectorForPress(press, me.x, me.y, me.face);
      if (press.hasTarget) {
        return {
          mx,
          my,
          act: ActType.DASH,
          ax: dx,
          ay: dy,
          msg: 0,
          dashTargetX: press.targetX,
          dashTargetY: press.targetY,
        };
      }
      return { mx, my, act: ActType.DASH, ax: dx, ay: dy, msg: 0 };
    }

    // press.kind === 'throw'
    if (me.st !== PState.FREE || dart.st !== DState.HAND) return null;
    const [ax, ay] = this.getAimVectorForPress(press, me.x, me.y, me.face);
    this.throwConsumed = true;
    return { mx, my, act: ActType.THROW, ax, ay, msg: 0 };
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
      this.pendingPresses.length = 0;
      this.lockedPreInput = null;
      this.lastSampledLocked = false;
      this.resetVirtualActions();
      return { mx: 0, my: 0, act: ActType.NONE, ax: 0, ay: 0, msg: 0 };
    }

    if (this.touchMode) {
      return this.sampleTouchAction(state, seat, me, dart);
    }

    const now = performance.now();
    const [mx, my] = this.getMoveVector();

    if (dart.st === DState.GROUND) {
      if (this.groundSinceMs < 0) this.groundSinceMs = now;
    } else if (dart.st !== DState.RISE) {
      this.groundSinceMs = -1;
    }

    const preInputEnabled = this.settings.get().dashInputBuffer;
    if (!preInputEnabled) {
      this.lockedPreInput = null;
    }

    const locked = isActionLockedState(me.st);
    const canDashMelee = isDashMovingWindow(me);

    // 1. Inside any action-locked state (THROW / THROWN / SLASH / SLASHED / KICK / KICKED / DASH / STUN)
    if (locked) {
      this.lastSampledLocked = true;
      if (preInputEnabled) {
        // Retain ONLY the last command pressed during this locked interval
        if (this.pendingPresses.length > 0) {
          this.lockedPreInput = this.pendingPresses[this.pendingPresses.length - 1];
          this.pendingPresses.length = 0;
        }
        // Dash-cancel melee ("冲刺斩/踢"): immediately allowed during dash moving ticks (timer 3..6)
        if (canDashMelee && this.lockedPreInput && this.lockedPreInput.kind === 'melee') {
          const cmd = this.lockedPreInput;
          this.lockedPreInput = null;
          const act = this.tryBuildDesktopAction(cmd, state, seat, me, dart, mx, my);
          if (act) return act;
        }
      } else {
        // Pre-input disabled: allow immediate dash-cancel melee if pressed in moving window; drop everything else
        const fresh = this.pendingPresses.filter((p) => now - p.at <= this.bufferMs);
        this.pendingPresses.length = 0;
        if (canDashMelee) {
          for (let i = fresh.length - 1; i >= 0; i--) {
            if (fresh[i].kind === 'melee') {
              const act = this.tryBuildDesktopAction(fresh[i], state, seat, me, dart, mx, my);
              if (act) return act;
            }
          }
        }
      }
      return { mx, my, act: ActType.NONE, ax: 0, ay: 0, msg: 0 };
    }

    // 2. Unlocked state (FREE or RECALL)
    if (preInputEnabled && this.lastSampledLocked) {
      // Exact unlock tick: any press arriving in the final locked inter-tick window overwrites lockedPreInput
      if (this.pendingPresses.length > 0) {
        this.lockedPreInput = this.pendingPresses[this.pendingPresses.length - 1];
        this.pendingPresses.length = 0;
      }
      this.lastSampledLocked = false;
      if (this.lockedPreInput) {
        const cmd = this.lockedPreInput;
        this.lockedPreInput = null;
        const act = this.tryBuildDesktopAction(cmd, state, seat, me, dart, mx, my);
        if (act) {
          this.lastSampledLocked = true;
          return act;
        }
        // Invalid on the unlock tick (e.g. no dart for throw, or dash on CD) -> discarded cleanly!
      }
    } else {
      this.lastSampledLocked = false;
      this.lockedPreInput = null;
      if (this.pendingPresses.length > 0) {
        const presses = preInputEnabled
          ? this.pendingPresses.slice()
          : this.pendingPresses.filter((p) => now - p.at <= this.bufferMs);
        this.pendingPresses.length = 0;

        for (let i = 0; i < presses.length; i++) {
          const act = this.tryBuildDesktopAction(presses[i], state, seat, me, dart, mx, my);
          if (act) {
            // Multiple commands within one 50ms inter-tick burst while FREE:
            // execute the first valid one now and keep ONLY the last subsequent press as lockedPreInput.
            if (preInputEnabled && i < presses.length - 1) {
              this.lockedPreInput = presses[presses.length - 1];
            }
            this.lastSampledLocked = true;
            return act;
          }
        }
      }
    }

    // 3. Hold Throw/Recall key -> Recall when dart is on the ground or already rising
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

    return { mx, my, act: ActType.NONE, ax: 0, ay: 0, msg: 0 };
  }

  private resetVirtualActions() {
    this.touchPendingPresses.length = 0;
    this.touchLockedPreInput = null;
    this.touchLastSampledLocked = false;
  }

  /**
   * Touch mode: the move vector the NEXT logic tick will send (before cliff guard), or null when
   * touch movement is not live. Used only for render-side prediction — never feeds the engine.
   */
  public getTouchMoveIntent(): [number, number] | null {
    if (!this.touchMode || this.paused || this.inputMode !== 'active') return null;
    return this.getVirtualMoveVector();
  }

  /** Left stick → engine move vector: 6% deadzone, instant full speed beyond (50% while aiming throw). */
  private getVirtualMoveVector(): [number, number] {
    const m = Math.hypot(this.vMoveX, this.vMoveY);
    if (m < 0.06) return [0, 0];
    const scale = this.vAiming ? 500 : 1000;
    return [Math.round((this.vMoveX / m) * scale), Math.round((this.vMoveY / m) * scale)];
  }

  private tryBuildTouchAction(
    press: TouchPress,
    state: TickSnapshot,
    seat: number,
    p: PlayerSnapshot,
    dart: DartSnapshot,
    mx: number,
    my: number,
    stickDir: [number, number] | null,
    faceX: number,
    faceY: number,
  ): HumanAction | null {
    const canStartNew = !isActionLockedState(p.st);
    const canDashMelee = isDashMovingWindow(p);

    if (press.kind === 'melee') {
      if (!canStartNew && !canDashMelee) return null;
      let ax: number;
      let ay: number;
      if (stickDir) {
        [ax, ay] = stickDir;
      } else if (press.dirX !== 0 || press.dirY !== 0) {
        ax = Math.round(press.dirX * 1000);
        ay = Math.round(press.dirY * 1000);
      } else {
        ax = faceX;
        ay = faceY;
      }
      if (this.settings.get().meleeAssist && this.mapData) {
        // Touch: 360° auto-turn toward the first dart entering reach within the slash judgment window
        const ticks = getSlashJudgmentTicks(this.settings.get().slashJudgment);
        [ax, ay] = applyMobileMeleeAssist(this.mapData, state, seat, ax, ay, ticks);
      }
      return { mx, my, act: ActType.MELEE, ax, ay, msg: 0 };
    }

    if (press.kind === 'dash') {
      if (!canStartNew || p.cd > 0) return null;
      let dx: number;
      let dy: number;
      if (stickDir) {
        [dx, dy] = stickDir;
      } else if (press.dirX !== 0 || press.dirY !== 0) {
        dx = Math.round(press.dirX * 1000);
        dy = Math.round(press.dirY * 1000);
      } else {
        dx = faceX;
        dy = faceY;
      }
      return { mx, my, act: ActType.DASH, ax: dx, ay: dy, msg: 0 };
    }

    // press.kind === 'throw'
    if (p.st !== PState.FREE || dart.st !== DState.HAND) return null;
    const hasDir = press.dirX !== 0 || press.dirY !== 0;
    this.throwConsumed = true;
    const ax = hasDir ? Math.round(press.dirX * 1000) : faceX;
    const ay = hasDir ? Math.round(press.dirY * 1000) : faceY;
    return { mx, my, act: ActType.THROW, ax, ay, msg: 0 };
  }

  /**
   * Touch-control sampling with unified pre-input & mobile dash-slash/kick ("冲刺斩/踢"):
   * - Melee during dash moving ticks (timer 3..6) immediately cancels dash into slash/kick.
   * - When pre-input is enabled, commands pressed during any locked state retain only the last one
   *   and execute on the first allowed tick (or are discarded if invalid on unlock).
   */
  private sampleTouchAction(state: TickSnapshot, seat: number, p: PlayerSnapshot, dart: DartSnapshot): HumanAction {
    const now = performance.now();
    const [mx, my] = this.getVirtualMoveVector();
    const faceRad = (p.face / 100) * (Math.PI / 180);
    const faceX = Math.round(Math.cos(faceRad) * 1000);
    const faceY = Math.round(Math.sin(faceRad) * 1000);
    const stickLen = Math.hypot(this.vMoveX, this.vMoveY);
    const stickDir: [number, number] | null =
      stickLen >= 0.06
        ? [Math.round((this.vMoveX / stickLen) * 1000), Math.round((this.vMoveY / stickLen) * 1000)]
        : null;

    if (dart.st === DState.GROUND) {
      if (this.groundSinceMs < 0) this.groundSinceMs = now;
    } else if (dart.st !== DState.RISE) {
      this.groundSinceMs = -1;
    }

    const preInputEnabled = this.settings.get().dashInputBuffer;
    const meleeAssistEnabled = this.settings.get().meleeAssist;
    if (!preInputEnabled) {
      this.touchLockedPreInput = null;
    }

    const locked = isActionLockedState(p.st);
    const canDashMelee = isDashMovingWindow(p);

    // 1. Inside any action-locked state
    if (locked) {
      this.touchLastSampledLocked = true;
      if (preInputEnabled) {
        if (this.touchPendingPresses.length > 0) {
          this.touchLockedPreInput = this.touchPendingPresses[this.touchPendingPresses.length - 1];
          this.touchPendingPresses.length = 0;
        }
        // Mobile dash-slash / dash-kick ("冲刺斩/踢") in moving ticks (timer 3..6):
        // When BOTH pre-input AND melee assist are enabled, auto-trigger on the FIRST moving tick
        // that can hit an enemy or block an incoming dart; if no opportunity arises during the dash,
        // keep dashing cleanly and fire on the first FREE tick after the dash finishes!
        if (canDashMelee && this.touchLockedPreInput && this.touchLockedPreInput.kind === 'melee') {
          const smartWait =
            meleeAssistEnabled &&
            this.mapData !== null &&
            !hasMobileMeleeHitOpportunity(
              this.mapData,
              state,
              seat,
              getSlashJudgmentTicks(this.settings.get().slashJudgment),
            );
          if (!smartWait) {
            const cmd = this.touchLockedPreInput;
            this.touchLockedPreInput = null;
            const act = this.tryBuildTouchAction(cmd, state, seat, p, dart, mx, my, stickDir, faceX, faceY);
            if (act) return act;
          }
        }
      } else {
        const fresh = this.touchPendingPresses.filter((pr) => now - pr.at <= this.bufferMs);
        this.touchPendingPresses.length = 0;
        if (canDashMelee) {
          for (let i = fresh.length - 1; i >= 0; i--) {
            if (fresh[i].kind === 'melee') {
              const act = this.tryBuildTouchAction(fresh[i], state, seat, p, dart, mx, my, stickDir, faceX, faceY);
              if (act) return act;
            }
          }
        }
      }
      return { mx, my, act: ActType.NONE, ax: 0, ay: 0, msg: 0 };
    }

    // 2. Unlocked state (FREE or RECALL)
    if (preInputEnabled && this.touchLastSampledLocked) {
      if (this.touchPendingPresses.length > 0) {
        this.touchLockedPreInput = this.touchPendingPresses[this.touchPendingPresses.length - 1];
        this.touchPendingPresses.length = 0;
      }
      this.touchLastSampledLocked = false;
      if (this.touchLockedPreInput) {
        const cmd = this.touchLockedPreInput;
        this.touchLockedPreInput = null;
        const act = this.tryBuildTouchAction(cmd, state, seat, p, dart, mx, my, stickDir, faceX, faceY);
        if (act) {
          this.touchLastSampledLocked = true;
          return act;
        }
        // Invalid on unlock tick -> discard cleanly
      }
    } else {
      this.touchLastSampledLocked = false;
      this.touchLockedPreInput = null;
      if (this.touchPendingPresses.length > 0) {
        const presses = preInputEnabled
          ? this.touchPendingPresses.slice()
          : this.touchPendingPresses.filter((pr) => now - pr.at <= this.bufferMs);
        this.touchPendingPresses.length = 0;

        for (let i = 0; i < presses.length; i++) {
          const act = this.tryBuildTouchAction(presses[i], state, seat, p, dart, mx, my, stickDir, faceX, faceY);
          if (act) {
            if (preInputEnabled && i < presses.length - 1) {
              this.touchLockedPreInput = presses[presses.length - 1];
            }
            this.touchLastSampledLocked = true;
            return act;
          }
        }
      }
    }

    // 3. Hold right stick (dart not in hand) → recall, identical rules to holding the Throw/Recall key
    const recallHeld = this.isThrowRecallHeld();
    const wantsRecall =
      recallHeld &&
      (dart.st === DState.RISE ||
        (dart.st === DState.GROUND &&
          (!this.throwConsumed || (this.groundSinceMs > 0 && now - this.groundSinceMs >= this.recallHoldDelayMs))));

    if (wantsRecall && (p.st === PState.FREE || p.st === PState.RECALL)) {
      return { mx: 0, my: 0, act: ActType.RECALL, ax: 0, ay: 0, msg: 0 };
    }
    if (!wantsRecall && p.st === PState.RECALL) {
      const cancelMx = mx !== 0 || my !== 0 ? mx : 1;
      return { mx: cancelMx, my, act: ActType.NONE, ax: 0, ay: 0, msg: 0 };
    }

    return { mx, my, act: ActType.NONE, ax: 0, ay: 0, msg: 0 };
  }
}
