import { ActType, DState, HumanAction, PState, TickSnapshot } from './types';

/**
 * Human input controller:
 * - WASD / Arrow keys: move
 * - Mouse position (projected onto arena ground plane in meters): aim direction
 * - Left Click: throw boomerang toward mouse (when holding dart)
 * - Hold Left Click: recall boomerang when dart is on the ground (releasing cancels recall)
 * - Right Click: slash (holding dart) / kick (empty-handed) toward mouse, also triggers Dash-Slash/Dash-Kick
 * - Shift: dash (in WASD direction if moving, otherwise toward mouse)
 * Includes responsive input buffering so clicks between 20Hz ticks are never lost!
 */
export class HumanInputController {
  private keys = new Set<string>();
  private enabled = false;

  // Screen mouse coordinates (client space)
  public mouseX = window.innerWidth * 0.5;
  public mouseY = window.innerHeight * 0.5;
  public hasMouse = false;

  // Projected world aim point in game mm (updated every frame by renderer)
  public aimWorldMmX = 0;
  public aimWorldMmY = 0;

  // Mouse button states
  private leftDown = false;
  private leftDownTime = 0;
  private leftThrowConsumed = false;
  private groundSinceMs = -1;
  private wasHoldingRecall = false;

  // Buffered one-shot actions (timestamp in ms, expires after ~140ms so actions feel snappy)
  private queuedThrowAt = -1;
  private queuedMeleeAt = -1;
  private queuedDashAt = -1;

  private bufferMs = 140;
  private recallHoldDelayMs = 160;
  private canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.bindEvents();
  }

  public setTickIntervalMs(tickMs: number) {
    // Ensure clicks between slow-motion ticks (e.g. 500ms at 0.1x) never expire before the next tick!
    this.bufferMs = Math.max(140, tickMs * 1.15);
    this.recallHoldDelayMs = Math.min(240, Math.max(120, tickMs * 1.1));
  }

  public setEnabled(v: boolean) {
    this.enabled = v;
    if (!v) {
      this.reset();
    }
  }

  public reset() {
    this.keys.clear();
    this.leftDown = false;
    this.leftThrowConsumed = false;
    this.groundSinceMs = -1;
    this.wasHoldingRecall = false;
    this.queuedThrowAt = -1;
    this.queuedMeleeAt = -1;
    this.queuedDashAt = -1;
  }

  public isLeftHeld(): boolean {
    return this.leftDown;
  }

  private bindEvents() {
    window.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      const code = e.code;
      if (
        code === 'KeyW' || code === 'KeyA' || code === 'KeyS' || code === 'KeyD' ||
        code === 'ArrowUp' || code === 'ArrowDown' || code === 'ArrowLeft' || code === 'ArrowRight'
      ) {
        this.keys.add(code);
      } else if (code === 'ShiftLeft' || code === 'ShiftRight') {
        if (!e.repeat) {
          this.queuedDashAt = performance.now();
        }
        this.keys.add(code);
      }
    });

    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
    });

    window.addEventListener('blur', () => {
      this.keys.clear();
      this.leftDown = false;
    });

    this.canvas.addEventListener('mousemove', (e) => {
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
      this.hasMouse = true;
    });

    this.canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
      this.hasMouse = true;
      const now = performance.now();

      if (e.button === 0) {
        this.leftDown = true;
        this.leftDownTime = now;
        this.leftThrowConsumed = false;
        this.queuedThrowAt = now;
      } else if (e.button === 2) {
        e.preventDefault();
        this.queuedMeleeAt = now;
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) {
        this.leftDown = false;
        this.leftThrowConsumed = false;
      }
    });

    this.canvas.addEventListener('contextmenu', (e) => {
      if (this.enabled) e.preventDefault();
    });
  }

  private getMoveVector(): [number, number] {
    let mx = 0;
    let my = 0;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) mx -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) mx += 1;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) my -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) my += 1;
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
   * Sample human action at the exact 20Hz logic tick boundary.
   */
  public sampleAction(state: TickSnapshot | null, seat: number): HumanAction {
    if (!this.enabled || !state || seat < 0 || seat >= state.n) {
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

    // Track how long dart has been on ground (to distinguish throw-click-and-hold vs deliberate recall hold)
    if (dart.st === DState.GROUND) {
      if (this.groundSinceMs < 0) this.groundSinceMs = now;
    } else if (dart.st !== DState.RISE) {
      this.groundSinceMs = -1;
    }

    const hasBufferedDash = this.queuedDashAt > 0 && now - this.queuedDashAt <= this.bufferMs;
    const hasBufferedMelee = this.queuedMeleeAt > 0 && now - this.queuedMeleeAt <= this.bufferMs;
    const hasBufferedThrow = this.queuedThrowAt > 0 && now - this.queuedThrowAt <= this.bufferMs;

    const canStartNew = me.st === PState.FREE || me.st === PState.RECALL;
    // Dash-slash/kick window: S_DASH and timer in [3..6] (dash_post+1 .. dash_t+dash_post)
    const canDashMelee = me.st === PState.DASH && me.timer >= 3 && me.timer <= 6;

    // 1. Priority: Melee (Right Click) - supports Dash-Slash / Dash-Kick and cancels recall!
    if (hasBufferedMelee && (canStartNew || canDashMelee)) {
      this.queuedMeleeAt = -1;
      this.wasHoldingRecall = false;
      return { mx, my, act: ActType.MELEE, ax: aimX, ay: aimY, msg: 0 };
    }

    // 2. Priority: Dash (Shift) - cancels recall; dashes in WASD direction if held, else mouse aim
    if (hasBufferedDash && canStartNew && me.cd === 0) {
      this.queuedDashAt = -1;
      this.wasHoldingRecall = false;
      const [dx, dy] = (mx !== 0 || my !== 0) ? [mx, my] : [aimX, aimY];
      return { mx, my, act: ActType.DASH, ax: dx, ay: dy, msg: 0 };
    }

    // 3. Priority: Throw (Left Click) when holding dart
    if (hasBufferedThrow && dart.st === DState.HAND && me.st === PState.FREE) {
      this.queuedThrowAt = -1;
      this.leftThrowConsumed = true;
      this.wasHoldingRecall = false;
      return { mx, my, act: ActType.THROW, ax: aimX, ay: aimY, msg: 0 };
    }

    // 4. Hold Left Click -> Recall when dart is on the ground or already rising
    const wantsRecall =
      this.leftDown &&
      (dart.st === DState.RISE ||
        (dart.st === DState.GROUND &&
          (!this.leftThrowConsumed || (this.groundSinceMs > 0 && now - this.groundSinceMs >= this.recallHoldDelayMs))));

    if (wantsRecall && (me.st === PState.FREE || me.st === PState.RECALL)) {
      // Must send mx=0, my=0 to keep recall channeling without cancelling!
      this.wasHoldingRecall = true;
      return { mx: 0, my: 0, act: ActType.RECALL, ax: 0, ay: 0, msg: 0 };
    }

    // If user released Left Click while channeling recall and isn't pressing WASD,
    // send mx=1 (speed=0 because rdiv(250*1, 1000)=0) to cleanly cancel S_RECALL immediately!
    if (!wantsRecall && me.st === PState.RECALL) {
      this.wasHoldingRecall = false;
      const cancelMx = mx !== 0 || my !== 0 ? mx : 1;
      return { mx: cancelMx, my, act: ActType.NONE, ax: 0, ay: 0, msg: 0 };
    }

    // Expire old throw click if dart wasn't in hand
    if (this.queuedThrowAt > 0 && now - this.queuedThrowAt > this.bufferMs) {
      this.queuedThrowAt = -1;
    }

    this.wasHoldingRecall = false;
    return { mx, my, act: ActType.NONE, ax: 0, ay: 0, msg: 0 };
  }
}
