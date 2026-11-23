import { applyCliffGuard } from './cliffGuard';
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

  // Projected world aim point in game mm (updated every frame by renderer)
  public aimWorldMmX = 0;
  public aimWorldMmY = 0;

  // Throw/recall hold tracking
  private throwConsumed = false;
  private groundSinceMs = -1;

  // Buffered one-shot actions (timestamp in ms)
  private queuedThrowAt = -1;
  private queuedMeleeAt = -1;
  private queuedDashAt = -1;

  private bufferMs = 140;
  private recallHoldDelayMs = 160;
  private mapData: EngineMapData | null = null;
  private cliffGuard = true;
  private canvas: HTMLCanvasElement;
  private settings: SettingsStore;

  constructor(canvas: HTMLCanvasElement, settings: SettingsStore) {
    this.canvas = canvas;
    this.settings = settings;
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

    this.canvas.addEventListener('mousemove', (e) => {
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
      this.hasMouse = true;
    });

    this.canvas.addEventListener('mousedown', (e) => {
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
      this.hasMouse = true;
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

    const hasBufferedDash = this.queuedDashAt > 0 && now - this.queuedDashAt <= this.bufferMs;
    const hasBufferedMelee = this.queuedMeleeAt > 0 && now - this.queuedMeleeAt <= this.bufferMs;
    const hasBufferedThrow = this.queuedThrowAt > 0 && now - this.queuedThrowAt <= this.bufferMs;

    const canStartNew = me.st === PState.FREE || me.st === PState.RECALL;
    const canDashMelee = me.st === PState.DASH && me.timer >= 3 && me.timer <= 6;

    // 1. Priority: Melee (Slash / Kick)
    if (hasBufferedMelee && (canStartNew || canDashMelee)) {
      this.queuedMeleeAt = -1;
      return { mx, my, act: ActType.MELEE, ax: aimX, ay: aimY, msg: 0 };
    }

    // 2. Priority: Dash
    if (hasBufferedDash && canStartNew && me.cd === 0) {
      this.queuedDashAt = -1;
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
