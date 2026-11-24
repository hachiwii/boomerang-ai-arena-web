import { applyCliffGuard } from './cliffGuard';
import { applyMeleeAssist } from './meleeAssist';
import { ActionBindKey, isBoundToAction, SettingsStore } from './settings';
import { ActType, DState, EngineMapData, HumanAction, PState, TickSnapshot } from './types';

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
    }
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
  }

  private isActionHeld(action: ActionBindKey): boolean {
    const pair = this.settings.get().keybindings[action];
    return (
      (pair[0] !== null && this.pressedCodes.has(pair[0])) ||
      (pair[1] !== null && this.pressedCodes.has(pair[1]))
    );
  }

  public isThrowRecallHeld(): boolean {
    return this.isActionHeld('throwRecall');
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
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
      this.hasMouse = true;
    };
    if ('onpointerrawupdate' in window) {
      window.addEventListener('pointerrawupdate', onRawPointer as EventListener, { passive: true });
    }
    window.addEventListener('pointermove', onRawPointer, { passive: true });

    this.canvas.addEventListener('mousedown', (e) => {
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
      return { mx: 0, my: 0, act: ActType.NONE, ax: 0, ay: 0, msg: 0 };
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
}
