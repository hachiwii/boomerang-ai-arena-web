import { HumanInputController } from '../game/humanInput';
import {
  cloneDefaultMobileLayout,
  MOBILE_CONTROL_KEYS,
  MOBILE_CONTROL_LABELS,
  MOBILE_CONTROL_SIZE_LIMITS,
  MobileControlKey,
  MobileControlSpot,
  MobileLayout,
  SettingsStore,
} from '../game/settings';
import { DState, EngineMapData, PState, TickSnapshot } from '../game/types';
import { getLogicalViewport, localPoint } from '../game/viewport';
import {
  ICON_BOOMERANG,
  ICON_DASH,
  ICON_EXIT,
  ICON_KICK,
  ICON_RECALL,
  ICON_RESTART,
  ICON_SETTINGS,
  ICON_SWORD,
} from './icons';

export interface SpotPx {
  cx: number;
  cy: number;
  d: number;
}

/** Layout spot (viewport-height units, edge anchored) → pixel center & diameter inside a w×h box. */
export function spotToPx(spot: MobileControlSpot, w: number, h: number): SpotPx {
  const d = spot.s * h;
  const cx = spot.side === 'l' ? spot.x * h : w - spot.x * h;
  const cy = h - spot.y * h;
  return { cx, cy, d };
}

/** Pixel center & diameter → layout spot, re-anchoring to whichever half of the screen it sits in. */
export function pxToSpot(px: SpotPx, w: number, h: number): MobileControlSpot {
  const side: 'l' | 'r' = px.cx < w / 2 ? 'l' : 'r';
  return {
    side,
    x: (side === 'l' ? px.cx : w - px.cx) / h,
    y: (h - px.cy) / h,
    s: px.d / h,
  };
}

function buildControlEl(key: MobileControlKey): HTMLDivElement {
  const el = document.createElement('div');
  el.className = `m-ctl m-${key} ${key === 'move' || key === 'aim' ? 'm-stick' : 'm-btn'}`;
  el.dataset.ctl = key;
  if (key === 'move') {
    el.innerHTML = `<div class="m-stick-ring"></div><div class="m-knob"></div>`;
  } else if (key === 'aim') {
    el.innerHTML = `<div class="m-aim-fill"></div><div class="m-ctl-icon">${ICON_BOOMERANG}</div><div class="m-knob m-aim-knob"></div>`;
  } else if (key === 'slash') {
    el.innerHTML = `<div class="m-ctl-icon">${ICON_SWORD}</div>`;
  } else {
    el.innerHTML = `<div class="m-cd"></div><div class="m-ctl-icon">${ICON_DASH}</div><span class="m-cd-text"></span>`;
  }
  return el;
}

function safeCapture(el: HTMLElement, pointerId: number) {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    // Pointer already released / synthetic — moves still bubble to the element
  }
}

function placeControl(el: HTMLElement, px: SpotPx) {
  el.style.width = `${px.d.toFixed(1)}px`;
  el.style.height = `${px.d.toFixed(1)}px`;
  el.style.left = `${(px.cx - px.d / 2).toFixed(1)}px`;
  el.style.top = `${(px.cy - px.d / 2).toFixed(1)}px`;
}

export interface MobileControlsCallbacks {
  /** Right stick pressed with the dart in hand → pin the match to 0.1x (and back on release). */
  onAimSlowmo: (active: boolean) => void;
  /** Skillshot indicator direction in screen/world axes, or null to hide it; `cancel` tints it red. */
  onAimIndicator: (dir: [number, number] | null, cancel?: boolean) => void;
}

type AimPhase = 'idle' | 'pending' | 'aiming' | 'recall';

const AIM_DEADZONE = 0.22;

/**
 * Mobile touch controls for live matches:
 * - Left stick: analog movement (floating: a touch anywhere in its half re-centers the stick there).
 * - Right stick: dart in hand → hold to aim at 0.1x slow-mo with a skillshot indicator, release to throw;
 *   dart away → hold to recall (inner disc fills outward with the channel progress).
 *   Pressing it mid-dash waits for the dash to end before entering slow-mo aim.
 * - Slash & Dash buttons around the aim stick (icons follow the current function, dash shows cooldown).
 */
export class MobileControls {
  private readonly layer: HTMLDivElement;
  private readonly moveZone: HTMLDivElement;
  private readonly els: Record<MobileControlKey, HTMLDivElement>;
  private readonly moveKnob: HTMLElement;
  private readonly aimKnob: HTMLElement;
  private readonly aimFill: HTMLElement;
  private readonly aimIcon: HTMLElement;
  private readonly slashIcon: HTMLElement;
  private readonly dashCd: HTMLElement;
  private readonly dashCdText: HTMLElement;
  private readonly aimCancel: HTMLDivElement;
  private cancelPx: SpotPx = { cx: 0, cy: 0, d: 0 };
  private cancelHot = false;

  private readonly input: HumanInputController;
  private readonly settings: SettingsStore;
  private readonly callbacks: MobileControlsCallbacks;

  private visible = false;
  private humanSeat = -1;
  private mapData: EngineMapData | null = null;
  private lastState: TickSnapshot | null = null;
  private px: Record<MobileControlKey, SpotPx> = {
    move: { cx: 0, cy: 0, d: 0 },
    aim: { cx: 0, cy: 0, d: 0 },
    slash: { cx: 0, cy: 0, d: 0 },
    dash: { cx: 0, cy: 0, d: 0 },
  };

  private movePointer: number | null = null;
  private moveCenterX = 0;
  private moveCenterY = 0;

  private aimPointer: number | null = null;
  private aimPhase: AimPhase = 'idle';
  private aimVecX = 0;
  private aimVecY = 0;
  private slowmoOn = false;

  private aimIconKey = '';
  private slashIconKey = '';

  constructor(
    parent: HTMLElement,
    input: HumanInputController,
    settings: SettingsStore,
    callbacks: MobileControlsCallbacks,
  ) {
    this.input = input;
    this.settings = settings;
    this.callbacks = callbacks;

    this.layer = document.createElement('div');
    this.layer.className = 'm-controls hidden';
    this.moveZone = document.createElement('div');
    this.moveZone.className = 'm-move-zone';
    this.layer.appendChild(this.moveZone);

    this.els = {
      move: buildControlEl('move'),
      aim: buildControlEl('aim'),
      slash: buildControlEl('slash'),
      dash: buildControlEl('dash'),
    };
    for (const k of MOBILE_CONTROL_KEYS) this.layer.appendChild(this.els[k]);
    // Red "cancel throw" target that appears next to the aim stick while aiming
    this.aimCancel = document.createElement('div');
    this.aimCancel.className = 'm-aim-cancel hidden';
    this.aimCancel.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg><span>取消</span>`;
    this.layer.appendChild(this.aimCancel);
    parent.insertBefore(this.layer, parent.firstChild);

    this.moveKnob = this.els.move.querySelector('.m-knob')!;
    this.aimKnob = this.els.aim.querySelector('.m-knob')!;
    this.aimFill = this.els.aim.querySelector('.m-aim-fill')!;
    this.aimIcon = this.els.aim.querySelector('.m-ctl-icon')!;
    this.slashIcon = this.els.slash.querySelector('.m-ctl-icon')!;
    this.dashCd = this.els.dash.querySelector('.m-cd')!;
    this.dashCdText = this.els.dash.querySelector('.m-cd-text')!;

    this.bindMove();
    this.bindAim();
    this.bindButton('slash', () => this.input.queueVirtualMelee());
    this.bindButton('dash', () => this.input.queueVirtualDash());

    settings.onChange(() => {
      if (this.visible) this.applyLayout();
    });
    window.addEventListener('resize', () => {
      if (this.visible) this.applyLayout();
    });
  }

  // ---------- Lifecycle ----------

  public show(humanSeat: number, mapData: EngineMapData | null) {
    this.humanSeat = humanSeat;
    this.mapData = mapData;
    this.visible = true;
    this.layer.classList.remove('hidden');
    this.aimIconKey = '';
    this.slashIconKey = '';
    this.applyLayout();
    this.cancelAll();
  }

  public hide() {
    this.cancelAll();
    this.visible = false;
    this.layer.classList.add('hidden');
    this.lastState = null;
  }

  public isVisible(): boolean {
    return this.visible;
  }

  public setMapData(mapData: EngineMapData | null) {
    this.mapData = mapData;
  }

  /** Releases every finger, ends slow-mo, hides the indicator (settings opened, match ended, ...). */
  public cancelAll() {
    if (this.movePointer !== null) {
      this.movePointer = null;
      this.resetMoveStick();
    }
    this.input.setVirtualMove(0, 0);
    this.endAim(false);
    this.els.slash.classList.remove('is-pressed');
    this.els.dash.classList.remove('is-pressed');
  }

  private applyLayout() {
    const w = this.layer.clientWidth || getLogicalViewport().width;
    const h = this.layer.clientHeight || getLogicalViewport().height;
    const layout = this.settings.get().mobileLayout;
    for (const k of MOBILE_CONTROL_KEYS) {
      this.px[k] = spotToPx(layout[k], w, h);
      placeControl(this.els[k], this.px[k]);
    }
    const mv = layout.move;
    this.moveZone.classList.toggle('is-right', mv.side === 'r');
    this.placeCancelZone(w, h, layout.aim.side);
  }

  /** Cancel target sits off the aim stick's upper outer corner (mirrored if the stick is on the left). */
  private placeCancelZone(w: number, h: number, side: 'l' | 'r') {
    const a = this.px.aim;
    const r = a.d / 2;
    const d = Math.max(48, Math.min(74, a.d * 0.4));
    const cr = d / 2;
    const dist = r + 12 + cr;
    const ang = (35 * Math.PI) / 180;
    const sgn = side === 'r' ? 1 : -1;
    const cx = Math.max(cr + 6, Math.min(w - cr - 6, a.cx + sgn * Math.cos(ang) * dist));
    const cy = Math.max(cr + 6, Math.min(h - cr - 6, a.cy - Math.sin(ang) * dist));
    this.cancelPx = { cx, cy, d };
    placeControl(this.aimCancel, this.cancelPx);
  }

  private setCancelVisible(visible: boolean) {
    this.aimCancel.classList.toggle('hidden', !visible);
    if (!visible) this.setCancelHot(false);
  }

  private setCancelHot(hot: boolean) {
    if (this.cancelHot === hot) return;
    this.cancelHot = hot;
    this.aimCancel.classList.toggle('is-hot', hot);
    this.els.aim.classList.toggle('is-cancelling', hot);
    if (this.aimPhase === 'aiming') this.pushIndicator();
  }

  // ---------- Per-tick state → icons, recall fill, cooldown ----------

  public onTick(state: TickSnapshot, tickIntervalMs: number) {
    this.lastState = state;
    if (!this.visible || this.humanSeat < 0) return;
    const me = state.players[this.humanSeat];
    const dart = state.darts[this.humanSeat];
    if (!me || !dart) return;
    const alive = me.alive === 1 && !state.over;
    this.layer.classList.toggle('is-inactive', !alive || this.input.getInputMode() !== 'active');
    this.layer.classList.toggle('is-gone', !alive);

    if (!alive) {
      this.cancelAll();
      return;
    }

    // Aim stick phase transitions driven by authoritative state
    if (this.aimPhase === 'pending' && this.input.getInputMode() === 'active') {
      if (dart.st === DState.HAND && me.st === PState.FREE) {
        this.beginAiming();
      } else if (dart.st !== DState.HAND && (me.st === PState.FREE || me.st === PState.RECALL)) {
        this.aimPhase = 'recall';
        this.setCancelVisible(false);
        this.input.setVirtualRecallHeld(true);
      }
    } else if (this.aimPhase === 'aiming' && (dart.st !== DState.HAND || this.input.getInputMode() !== 'active')) {
      this.endAim(false);
    }
    if (this.aimPhase === 'aiming') this.pushIndicator();

    // Aim icon by dart state
    let aimKey: string;
    if (dart.st === DState.HAND) aimKey = 'hand';
    else if (dart.st === DState.GROUND) aimKey = 'ground';
    else if (dart.st === DState.RISE) aimKey = 'rise';
    else if (dart.st === DState.GONE) aimKey = 'gone';
    else aimKey = 'fly';
    if (aimKey !== this.aimIconKey) {
      this.aimIconKey = aimKey;
      this.aimIcon.innerHTML = aimKey === 'hand' || aimKey === 'fly' || aimKey === 'gone' ? ICON_BOOMERANG : ICON_RECALL;
      this.els.aim.dataset.state = aimKey;
    }
    const recallPre = Math.max(1, this.mapData?.recallPre || 12);
    const recallProg =
      me.st === PState.RECALL && dart.st === DState.RISE
        ? Math.max(0, Math.min(1, (recallPre - Math.max(0, me.timer) + 1) / recallPre))
        : dart.st === DState.CALL
          ? 1
          : 0;
    this.aimFill.style.transitionDuration = recallProg > 0 ? `${Math.round(tickIntervalMs)}ms` : '0ms';
    this.aimFill.style.transform = `translate(-50%, -50%) scale(${recallProg.toFixed(3)})`;
    this.els.aim.classList.toggle('is-recalling', recallProg > 0 && dart.st === DState.RISE);

    // Slash icon: sword with dart in hand, kick otherwise
    const slashKey = dart.st === DState.HAND ? 'slash' : 'kick';
    if (slashKey !== this.slashIconKey) {
      this.slashIconKey = slashKey;
      this.slashIcon.innerHTML = slashKey === 'slash' ? ICON_SWORD : ICON_KICK;
      this.els.slash.dataset.state = slashKey;
    }

    // Dash cooldown sweep + seconds
    const dashCd = Math.max(1, this.mapData?.dashCd || 20);
    const cd = Math.max(0, me.cd);
    const ready = cd === 0;
    this.els.dash.classList.toggle('is-cooling', !ready);
    this.dashCd.style.setProperty('--cd', `${((cd / dashCd) * 100).toFixed(1)}%`);
    this.dashCdText.textContent = ready ? '' : (cd / 20).toFixed(1);
  }

  // ---------- Move stick ----------

  private bindMove() {
    const start = (e: PointerEvent) => {
      if (!this.visible || this.movePointer !== null) return;
      e.preventDefault();
      this.movePointer = e.pointerId;
      safeCapture(e.currentTarget as HTMLElement, e.pointerId);
      const base = this.px.move;
      const [lx, ly] = localPoint(this.layer, e.clientX, e.clientY);
      const r = base.d / 2;
      if (Math.hypot(lx - base.cx, ly - base.cy) <= r * 1.1) {
        this.moveCenterX = base.cx;
        this.moveCenterY = base.cy;
      } else {
        // Floating: re-center the stick under the thumb (kept fully on screen)
        this.moveCenterX = Math.max(r, Math.min(this.layer.clientWidth - r, lx));
        this.moveCenterY = Math.max(r, Math.min(this.layer.clientHeight - r, ly));
        const el = this.els.move;
        el.style.left = `${(this.moveCenterX - r).toFixed(1)}px`;
        el.style.top = `${(this.moveCenterY - r).toFixed(1)}px`;
      }
      this.els.move.classList.add('is-active');
      this.updateMove(lx, ly);
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== this.movePointer) return;
      e.preventDefault();
      const [lx, ly] = localPoint(this.layer, e.clientX, e.clientY);
      this.updateMove(lx, ly);
    };
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.movePointer) return;
      this.movePointer = null;
      this.resetMoveStick();
      this.input.setVirtualMove(0, 0);
    };
    for (const el of [this.moveZone, this.els.move]) {
      el.addEventListener('pointerdown', start);
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
      el.addEventListener('lostpointercapture', end);
    }
  }

  private updateMove(lx: number, ly: number) {
    const r = this.px.move.d / 2;
    const maxR = r * 0.62;
    let dx = lx - this.moveCenterX;
    let dy = ly - this.moveCenterY;
    const len = Math.hypot(dx, dy);
    if (len > maxR) {
      dx = (dx / len) * maxR;
      dy = (dy / len) * maxR;
    }
    this.moveKnob.style.transform = `translate(calc(-50% + ${dx.toFixed(1)}px), calc(-50% + ${dy.toFixed(1)}px))`;
    this.input.setVirtualMove(dx / maxR, dy / maxR);
  }

  private resetMoveStick() {
    this.els.move.classList.remove('is-active');
    this.moveKnob.style.transform = 'translate(-50%, -50%)';
    placeControl(this.els.move, this.px.move);
  }

  // ---------- Aim / recall stick ----------

  private bindAim() {
    const el = this.els.aim;
    el.addEventListener('pointerdown', (e) => {
      if (!this.visible || this.aimPointer !== null) return;
      e.preventDefault();
      this.aimPointer = e.pointerId;
      safeCapture(el, e.pointerId);
      el.classList.add('is-pressed');
      this.aimVecX = 0;
      this.aimVecY = 0;
      this.updateAimKnob();
      const st = this.lastState;
      const me = st && this.humanSeat >= 0 ? st.players[this.humanSeat] : null;
      const dart = st && this.humanSeat >= 0 ? st.darts[this.humanSeat] : null;
      if (!me || !dart || me.alive !== 1 || st?.over) {
        this.aimPhase = 'idle';
        return;
      }
      if (dart.st === DState.HAND) {
        if (this.input.getInputMode() !== 'active' || (me.st !== PState.FREE && me.st !== PState.RECALL)) {
          // Countdown / any locked action state: wait to enter slow-mo aim once free, or pre-input throw on release
          this.aimPhase = 'pending';
          this.setCancelVisible(true);
        } else {
          this.beginAiming();
        }
      } else {
        this.aimPhase = 'recall';
        this.input.setVirtualRecallHeld(true);
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.aimPointer) return;
      e.preventDefault();
      const c = this.px.aim;
      const maxR = (c.d / 2) * 0.7;
      const [lx, ly] = localPoint(this.layer, e.clientX, e.clientY);
      if (this.aimPhase === 'aiming' || this.aimPhase === 'pending') {
        const cz = this.cancelPx;
        this.setCancelHot(Math.hypot(lx - cz.cx, ly - cz.cy) <= (cz.d / 2) * 1.3);
      }
      let dx = lx - c.cx;
      let dy = ly - c.cy;
      const len = Math.hypot(dx, dy);
      if (len > maxR) {
        dx = (dx / len) * maxR;
        dy = (dy / len) * maxR;
      }
      this.aimVecX = dx / maxR;
      this.aimVecY = dy / maxR;
      this.updateAimKnob();
      if (this.aimPhase === 'aiming') this.pushIndicator();
    });
    const release = (e: PointerEvent, cancelled: boolean) => {
      if (e.pointerId !== this.aimPointer) return;
      this.aimPointer = null;
      el.classList.remove('is-pressed');
      // Lifting the finger on the red cancel target drops the throw entirely
      this.endAim(!cancelled && !this.cancelHot);
    };
    el.addEventListener('pointerup', (e) => release(e, false));
    el.addEventListener('pointercancel', (e) => release(e, true));
    el.addEventListener('lostpointercapture', (e) => release(e, false));
  }

  private stickAimDir(): [number, number] | null {
    const len = Math.hypot(this.aimVecX, this.aimVecY);
    return len >= AIM_DEADZONE ? [this.aimVecX / len, this.aimVecY / len] : null;
  }

  private faceDir(): [number, number] {
    const me = this.lastState && this.humanSeat >= 0 ? this.lastState.players[this.humanSeat] : null;
    const rad = ((me?.face ?? 0) / 100) * (Math.PI / 180);
    return [Math.cos(rad), Math.sin(rad)];
  }

  private beginAiming() {
    this.aimPhase = 'aiming';
    this.els.aim.classList.add('is-aiming');
    this.setCancelVisible(true);
    if (!this.slowmoOn) {
      this.slowmoOn = true;
      this.callbacks.onAimSlowmo(true);
    }
    this.pushIndicator();
  }

  private pushIndicator() {
    this.callbacks.onAimIndicator(this.stickAimDir() ?? this.faceDir(), this.cancelHot);
  }

  /** Ends whatever the right stick was doing; `commit` = finger lifted normally (throw if aiming). */
  private endAim(commit: boolean) {
    const phase = this.aimPhase;
    this.aimPhase = 'idle';
    if (this.aimPointer !== null && !commit) {
      this.aimPointer = null;
    }
    this.els.aim.classList.remove('is-aiming', 'is-pressed');
    this.setCancelVisible(false);
    if (phase === 'aiming' && commit) {
      const dir = this.stickAimDir();
      this.input.queueVirtualThrow(dir ? dir[0] : 0, dir ? dir[1] : 0, false);
    } else if (phase === 'pending' && commit) {
      const dir = this.stickAimDir();
      this.input.queueVirtualThrow(dir ? dir[0] : 0, dir ? dir[1] : 0, true);
    }
    if (phase === 'recall' || !commit) {
      this.input.setVirtualRecallHeld(false);
    }
    this.callbacks.onAimIndicator(null);
    if (this.slowmoOn) {
      this.slowmoOn = false;
      this.callbacks.onAimSlowmo(false);
    }
    this.aimVecX = 0;
    this.aimVecY = 0;
    this.updateAimKnob();
  }

  private updateAimKnob() {
    const maxR = (this.px.aim.d / 2) * 0.7;
    this.aimKnob.style.transform = `translate(calc(-50% + ${(this.aimVecX * maxR).toFixed(1)}px), calc(-50% + ${(this.aimVecY * maxR).toFixed(1)}px))`;
  }

  // ---------- Small skill buttons ----------

  private bindButton(key: 'slash' | 'dash', fire: () => void) {
    const el = this.els[key];
    let pid: number | null = null;
    el.addEventListener('pointerdown', (e) => {
      if (!this.visible) return;
      e.preventDefault();
      pid = e.pointerId;
      el.classList.add('is-pressed');
      fire();
    });
    const up = (e: PointerEvent) => {
      if (e.pointerId !== pid) return;
      pid = null;
      el.classList.remove('is-pressed');
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', up);
  }
}

// =====================================================================================
// Layout editor: a mock match screen where each control can be dragged and resized.
// =====================================================================================

export class MobileLayoutEditor {
  private readonly settings: SettingsStore;
  private readonly root: HTMLDivElement;
  private readonly stage: HTMLDivElement;
  private readonly handle: HTMLDivElement;
  private readonly frame: HTMLDivElement;
  private readonly els: Record<MobileControlKey, HTMLDivElement>;
  private draft: MobileLayout = cloneDefaultMobileLayout();
  private selected: MobileControlKey | null = null;
  private openState = false;
  private onClose: (() => void) | null = null;
  private drag:
    | { kind: 'move'; key: MobileControlKey; pointerId: number; offX: number; offY: number }
    | { kind: 'resize'; key: MobileControlKey; pointerId: number; startD: number; startDist: number }
    | null = null;

  constructor(settings: SettingsStore) {
    this.settings = settings;
    this.root = document.createElement('div');
    this.root.className = 'm-editor hidden';
    this.root.innerHTML = `
      <div class="m-editor-mock" aria-hidden="true">
        <div class="m-editor-avatars"><span></span><span></span><span></span><span></span></div>
        <div class="m-editor-title">键位调整 · 拖动按钮移动位置，选中后拖动右下角 ⤡ 缩放</div>
        <div class="m-editor-mock-actions"><span>${ICON_RESTART}</span><span>${ICON_SETTINGS}</span><span>${ICON_EXIT}</span></div>
      </div>
      <div class="m-editor-stage"></div>
      <div class="m-editor-corner m-editor-corner-left">
        <button type="button" class="m-editor-btn" data-editor-act="reset">重置键位</button>
      </div>
      <div class="m-editor-corner m-editor-corner-right">
        <button type="button" class="m-editor-btn" data-editor-act="cancel">取消</button>
        <button type="button" class="m-editor-btn is-primary" data-editor-act="save">保存</button>
      </div>
    `;
    this.stage = this.root.querySelector('.m-editor-stage')!;
    this.els = {
      move: buildControlEl('move'),
      aim: buildControlEl('aim'),
      slash: buildControlEl('slash'),
      dash: buildControlEl('dash'),
    };
    for (const k of MOBILE_CONTROL_KEYS) {
      const el = this.els[k];
      el.classList.add('is-editing');
      const lbl = document.createElement('span');
      lbl.className = 'm-editor-label';
      lbl.textContent = MOBILE_CONTROL_LABELS[k];
      el.appendChild(lbl);
      this.stage.appendChild(el);
    }
    // Selection frame (dashed square) + corner resize handle with a diagonal ⤡ arrow
    this.frame = document.createElement('div');
    this.frame.className = 'm-editor-frame hidden';
    this.stage.appendChild(this.frame);
    this.handle = document.createElement('div');
    this.handle.className = 'm-editor-handle hidden';
    this.handle.setAttribute('aria-label', '拖动缩放');
    this.handle.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><path d="M6 12.5V6h6.5M18 11.5V18h-6.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    this.stage.appendChild(this.handle);
    document.body.appendChild(this.root);

    this.root.querySelector('[data-editor-act="reset"]')?.addEventListener('click', () => {
      this.draft = cloneDefaultMobileLayout();
      this.render();
    });
    this.root.querySelector('[data-editor-act="cancel"]')?.addEventListener('click', () => this.close(false));
    this.root.querySelector('[data-editor-act="save"]')?.addEventListener('click', () => this.close(true));

    this.stage.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.stage.addEventListener('pointermove', (e) => this.onPointerMove(e));
    const end = (e: PointerEvent) => {
      if (this.drag && this.drag.pointerId === e.pointerId) this.drag = null;
    };
    this.stage.addEventListener('pointerup', end);
    this.stage.addEventListener('pointercancel', end);
    window.addEventListener('resize', () => {
      if (this.openState) this.render();
    });
  }

  public isOpen(): boolean {
    return this.openState;
  }

  public open(onClose?: () => void) {
    this.onClose = onClose ?? null;
    this.draft = JSON.parse(JSON.stringify(this.settings.get().mobileLayout)) as MobileLayout;
    this.selected = null;
    this.drag = null;
    this.openState = true;
    document.body.classList.add('m-layout-editing');
    this.root.classList.remove('hidden');
    this.render();
  }

  public close(save: boolean) {
    if (!this.openState) return;
    if (save) this.settings.setMobileLayout(this.draft);
    this.openState = false;
    this.drag = null;
    this.root.classList.add('hidden');
    document.body.classList.remove('m-layout-editing');
    const cb = this.onClose;
    this.onClose = null;
    cb?.();
  }

  private stageSize(): { w: number; h: number } {
    return {
      w: this.stage.clientWidth || getLogicalViewport().width,
      h: this.stage.clientHeight || getLogicalViewport().height,
    };
  }

  private render() {
    const { w, h } = this.stageSize();
    for (const k of MOBILE_CONTROL_KEYS) {
      const el = this.els[k];
      placeControl(el, spotToPx(this.draft[k], w, h));
      el.classList.toggle('is-selected', this.selected === k);
    }
    if (this.selected) {
      const p = spotToPx(this.draft[this.selected], w, h);
      const r = p.d / 2;
      const pad = 6;
      this.frame.style.left = `${(p.cx - r - pad).toFixed(1)}px`;
      this.frame.style.top = `${(p.cy - r - pad).toFixed(1)}px`;
      this.frame.style.width = `${(p.d + pad * 2).toFixed(1)}px`;
      this.frame.style.height = `${(p.d + pad * 2).toFixed(1)}px`;
      this.frame.classList.remove('hidden');
      // Handle sits on the frame's bottom-right corner (kept on screen for edge-hugging controls)
      this.handle.style.left = `${Math.min(w - 18, p.cx + r + pad).toFixed(1)}px`;
      this.handle.style.top = `${Math.min(h - 18, p.cy + r + pad).toFixed(1)}px`;
      this.handle.classList.remove('hidden');
    } else {
      this.frame.classList.add('hidden');
      this.handle.classList.add('hidden');
    }
  }

  private localPoint(e: PointerEvent): { x: number; y: number } {
    const [x, y] = localPoint(this.stage, e.clientX, e.clientY);
    return { x, y };
  }

  private onPointerDown(e: PointerEvent) {
    if (this.drag) return;
    e.preventDefault();
    const target = e.target as HTMLElement;
    const { x, y } = this.localPoint(e);
    if (target.closest('.m-editor-handle') && this.selected) {
      const { w, h } = this.stageSize();
      const p = spotToPx(this.draft[this.selected], w, h);
      this.drag = {
        kind: 'resize',
        key: this.selected,
        pointerId: e.pointerId,
        startD: p.d,
        startDist: Math.hypot(x - p.cx, y - p.cy),
      };
      safeCapture(this.stage, e.pointerId);
      return;
    }
    const ctl = target.closest<HTMLElement>('.m-ctl');
    const key = ctl?.dataset.ctl as MobileControlKey | undefined;
    if (!key) {
      this.selected = null;
      this.render();
      return;
    }
    const { w, h } = this.stageSize();
    const p = spotToPx(this.draft[key], w, h);
    this.selected = key;
    this.drag = { kind: 'move', key, pointerId: e.pointerId, offX: x - p.cx, offY: y - p.cy };
    safeCapture(this.stage, e.pointerId);
    this.render();
  }

  private onPointerMove(e: PointerEvent) {
    const d = this.drag;
    if (!d || d.pointerId !== e.pointerId) return;
    e.preventDefault();
    const { w, h } = this.stageSize();
    const { x, y } = this.localPoint(e);
    const cur = spotToPx(this.draft[d.key], w, h);
    if (d.kind === 'move') {
      const r = cur.d / 2;
      const cx = Math.max(r, Math.min(w - r, x - d.offX));
      const cy = Math.max(r, Math.min(h - r, y - d.offY));
      this.draft[d.key] = pxToSpot({ cx, cy, d: cur.d }, w, h);
    } else {
      const [sMin, sMax] = MOBILE_CONTROL_SIZE_LIMITS[d.key];
      // Corner handle on the diagonal: moving it by Δ along the diagonal changes the diameter by Δ·√2
      const dist = Math.hypot(x - cur.cx, y - cur.cy);
      const nextD = Math.max(sMin * h, Math.min(sMax * h, d.startD + (dist - d.startDist) * Math.SQRT2));
      this.draft[d.key] = pxToSpot({ cx: cur.cx, cy: cur.cy, d: nextD }, w, h);
    }
    this.render();
  }
}
