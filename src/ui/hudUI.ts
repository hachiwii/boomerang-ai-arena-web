import { CauseType, DState, MatchConfig, PState, SlotConfig, TickSnapshot } from '../game/types';

export interface HudCallbacks {
  onReturnToLobby: () => void;
  onToggleMute: () => boolean;
  onToggleUncap: () => boolean;
}

function causeLabel(cause: number, killerName?: string): string {
  if (cause === CauseType.DART) return killerName ? `被 ${killerName} 飞镖命中` : '被飞镖命中';
  if (cause === CauseType.SLASH) return killerName ? `被 ${killerName} 挥砍出局` : '被挥砍出局';
  if (cause === CauseType.FALL) return killerName ? `被 ${killerName} 踢入深渊` : '跌落浮岛';
  return '存活';
}

function dartBadge(st: number): { text: string; cls: string } {
  switch (st) {
    case DState.HAND:
      return { text: '持镖', cls: 'st-hand' };
    case DState.OUT:
    case DState.BACK:
    case DState.CALL:
      return { text: '飞行', cls: 'st-fly' };
    case DState.GROUND:
      return { text: '落地', cls: 'st-ground' };
    case DState.RISE:
      return { text: '召回', cls: 'st-recall' };
    default:
      return { text: '无镖', cls: 'st-gone' };
  }
}

export class HudUI {
  private readonly root: HTMLDivElement;
  public readonly nameplateLayer: HTMLDivElement;
  private readonly topBar: HTMLDivElement;
  private readonly bottomBar: HTMLDivElement;
  private readonly resultOverlay: HTMLDivElement;
  private readonly callbacks: HudCallbacks;

  private slots: SlotConfig[] = [];
  private humanSeat = -1;
  private muted = false;
  private uncapped = true;
  private autoReturnTimer: number | null = null;
  private countdownInterval: number | null = null;

  // Cached DOM references for ultra-fast HUD updates (no full innerHTML rebuild per tick!)
  private timerEl: HTMLElement | null = null;
  private collapseEl: HTMLElement | null = null;
  private perfEl: HTMLElement | null = null;
  private cardEls: {
    card: HTMLElement;
    kills: HTMLElement;
    dart: HTMLElement;
    cdBar: HTMLElement;
  }[] = [];
  private humanHintLeft: HTMLElement | null = null;
  private humanHintRight: HTMLElement | null = null;
  private humanHintShift: HTMLElement | null = null;

  constructor(parent: HTMLElement, callbacks: HudCallbacks) {
    this.callbacks = callbacks;

    this.nameplateLayer = document.createElement('div');
    this.nameplateLayer.className = 'nameplate-layer';
    parent.appendChild(this.nameplateLayer);

    this.root = document.createElement('div');
    this.root.className = 'hud-root hidden';
    parent.appendChild(this.root);

    this.topBar = document.createElement('div');
    this.topBar.className = 'hud-top';
    this.root.appendChild(this.topBar);

    this.bottomBar = document.createElement('div');
    this.bottomBar.className = 'hud-bottom';
    this.root.appendChild(this.bottomBar);

    this.resultOverlay = document.createElement('div');
    this.resultOverlay.className = 'result-overlay hidden';
    this.root.appendChild(this.resultOverlay);
  }

  public showMatch(config: MatchConfig, humanSeat: number) {
    this.clearTimers();
    this.slots = config.slots;
    this.humanSeat = humanSeat;
    this.resultOverlay.classList.add('hidden');
    this.root.classList.remove('hidden');

    this.topBar.innerHTML = `
      <div class="hud-players">
        ${config.slots
          .map(
            (s, i) => `
          <div class="hud-pcard ${s.kind === 'human' ? 'is-human' : ''}" data-pcard="${i}" style="--pcol:${s.ringAccent || s.color}">
            <img class="hud-avatar" src="${s.avatar || ''}" alt="" />
            <div class="hud-pmeta">
              <div class="hud-pname">${s.displayName}</div>
              <div class="hud-pstats">
                <span class="hud-dart st-hand" data-pdart="${i}">持镖</span>
                <span class="hud-kills" data-pkills="${i}">0 击杀</span>
              </div>
              <div class="hud-cd-track"><div class="hud-cd-fill" data-pcd="${i}"></div></div>
            </div>
          </div>`,
          )
          .join('')}
      </div>

      <div class="hud-center-pill">
        <div class="hud-map-label">${config.mapMeta.title} ${humanSeat < 0 ? '· 观战' : ''}</div>
        <div class="hud-timer" id="hud-timer">40.0s</div>
        <div class="hud-collapse" id="hud-collapse">塌陷倒计时 12s</div>
      </div>

      <div class="hud-actions">
        <div class="hud-perf" id="hud-perf">20Hz · --Hz</div>
        <button class="hud-btn ${this.uncapped ? 'active' : ''}" id="hud-uncap" title="切换 VSync / 240Hz+ 解锁帧率">
          ${this.uncapped ? '240Hz+ 解锁' : '高刷 VSync'}
        </button>
        <button class="hud-btn" id="hud-mute">${this.muted ? '静音' : '音效开'}</button>
        <button class="hud-btn hud-exit" id="hud-exit">主界面 (ESC)</button>
      </div>
    `;

    this.timerEl = this.topBar.querySelector('#hud-timer');
    this.collapseEl = this.topBar.querySelector('#hud-collapse');
    this.perfEl = this.topBar.querySelector('#hud-perf');
    this.cardEls = config.slots.map((_, i) => ({
      card: this.topBar.querySelector(`[data-pcard="${i}"]`)!,
      kills: this.topBar.querySelector(`[data-pkills="${i}"]`)!,
      dart: this.topBar.querySelector(`[data-pdart="${i}"]`)!,
      cdBar: this.topBar.querySelector(`[data-pcd="${i}"]`)!,
    }));

    this.topBar.querySelector('#hud-exit')?.addEventListener('click', () => {
      this.clearTimers();
      this.callbacks.onReturnToLobby();
    });
    this.topBar.querySelector('#hud-mute')?.addEventListener('click', (e) => {
      this.muted = this.callbacks.onToggleMute();
      (e.currentTarget as HTMLButtonElement).textContent = this.muted ? '静音' : '音效开';
    });
    this.topBar.querySelector('#hud-uncap')?.addEventListener('click', (e) => {
      this.uncapped = this.callbacks.onToggleUncap();
      const btn = e.currentTarget as HTMLButtonElement;
      btn.classList.toggle('active', this.uncapped);
      btn.textContent = this.uncapped ? '240Hz+ 解锁' : '高刷 VSync';
    });

    if (humanSeat >= 0) {
      this.bottomBar.innerHTML = `
        <div class="action-pill"><kbd>WASD</kbd> 移动</div>
        <div class="action-pill" id="hint-left"><kbd>左键</kbd> 向鼠标扔镖</div>
        <div class="action-pill" id="hint-right"><kbd>右键</kbd> 挥砍 / 挡镖</div>
        <div class="action-pill" id="hint-shift"><kbd>Shift</kbd> 冲刺就绪</div>
      `;
      this.humanHintLeft = this.bottomBar.querySelector('#hint-left');
      this.humanHintRight = this.bottomBar.querySelector('#hint-right');
      this.humanHintShift = this.bottomBar.querySelector('#hint-shift');
    } else {
      this.bottomBar.innerHTML = `<div class="action-pill spectate-pill">AI 观战模式 · 实时 20Hz WASM 对决中</div>`;
      this.humanHintLeft = null;
      this.humanHintRight = null;
      this.humanHintShift = null;
    }
  }

  public updateTick(state: TickSnapshot, colStart = 240, colEvery = 30) {
    const remSec = Math.max(0, (800 - state.t) / 20);
    if (this.timerEl) {
      this.timerEl.textContent = `${remSec.toFixed(1)}s`;
      this.timerEl.classList.toggle('urgent', remSec < 10);
    }

    if (this.collapseEl) {
      if (state.warn >= 0) {
        this.collapseEl.textContent = `⚠ 第 ${state.warn + 1} 波即将塌陷!`;
        this.collapseEl.classList.add('warn');
      } else if (state.t < colStart) {
        const s = Math.ceil((colStart - state.t) / 20);
        this.collapseEl.textContent = `塌陷倒计时 ${s}s`;
        this.collapseEl.classList.remove('warn');
      } else {
        this.collapseEl.textContent = `已塌陷 ${state.fallen} 波`;
        this.collapseEl.classList.remove('warn');
      }
      void colEvery;
    }

    for (let i = 0; i < state.n && i < this.cardEls.length; i++) {
      const p = state.players[i];
      const d = state.darts[i];
      const el = this.cardEls[i];
      el.card.classList.toggle('is-dead', !p.alive);
      el.kills.textContent = `${p.kills} 击杀`;
      const db = dartBadge(d.st);
      el.dart.textContent = p.alive ? db.text : '出局';
      el.dart.className = `hud-dart ${p.alive ? db.cls : 'st-dead'}`;
      const readyPct = p.alive ? Math.max(0, Math.min(100, (1 - p.cd / 20) * 100)) : 0;
      el.cdBar.style.width = `${readyPct}%`;
    }

    if (this.humanSeat >= 0 && state.players[this.humanSeat]) {
      const me = state.players[this.humanSeat];
      const md = state.darts[this.humanSeat];
      if (!me.alive) {
        if (this.humanHintLeft) this.humanHintLeft.innerHTML = `已出局 · 正在观战剩余对手`;
        if (this.humanHintRight) this.humanHintRight.style.display = 'none';
        if (this.humanHintShift) this.humanHintShift.style.display = 'none';
      } else {
        if (this.humanHintRight) this.humanHintRight.style.display = '';
        if (this.humanHintShift) this.humanHintShift.style.display = '';
        if (this.humanHintLeft) {
          if (md.st === DState.HAND) this.humanHintLeft.innerHTML = `<kbd>左键</kbd> 向鼠标扔镖`;
          else if (md.st === DState.GROUND) this.humanHintLeft.innerHTML = `<kbd>长按左键</kbd> 召回落地镖`;
          else if (md.st === DState.RISE) this.humanHintLeft.innerHTML = `<kbd>按住中</kbd> 召回引导 ${Math.round((1 - me.timer / 12) * 100)}%`;
          else this.humanHintLeft.innerHTML = `<kbd>左键</kbd> 飞镖飞行中`;
        }
        if (this.humanHintRight) {
          this.humanHintRight.innerHTML =
            md.st === DState.HAND ? `<kbd>右键</kbd> 挥砍 / 挡镖` : `<kbd>右键</kbd> 踢人击退`;
        }
        if (this.humanHintShift) {
          this.humanHintShift.innerHTML =
            me.cd === 0
              ? `<kbd>Shift</kbd> 冲刺就绪`
              : `<kbd>Shift</kbd> 冷却 ${(me.cd / 20).toFixed(1)}s`;
          this.humanHintShift.classList.toggle('ready', me.cd === 0);
        }
      }
    }
  }

  public updateTelemetry(logicHz: number, renderHz: number, frameWorkMs: number, botMaxMs: number) {
    if (!this.perfEl) return;
    const capHz = frameWorkMs > 0.05 ? Math.min(999, Math.round(1000 / frameWorkMs)) : 999;
    this.perfEl.textContent = `逻辑 ${logicHz.toFixed(0)}Hz · 渲染 ${Math.round(renderHz)}Hz (${frameWorkMs.toFixed(1)}ms, 峰值~${capHz}Hz · AI ${botMaxMs.toFixed(1)}ms)`;
  }

  public showMatchResult(finalState: TickSnapshot) {
    this.clearTimers();
    const winner = finalState.winner >= 0 ? this.slots[finalState.winner] : null;
    const rows = finalState.players
      .map((p, idx) => ({
        idx,
        slot: this.slots[idx],
        p,
      }))
      .sort((a, b) => a.p.rank - b.p.rank || b.p.kills - a.p.kills);

    let remainSec = 4;
    this.resultOverlay.innerHTML = `
      <div class="result-card">
        <div class="result-kicker">${winner ? '本局胜者' : '平局结束'}</div>
        ${
          winner
            ? `<div class="result-winner">
                <img src="${winner.avatar || ''}" class="result-avatar" alt="" />
                <div class="result-wname" style="color:${winner.ringAccent || winner.color}">${winner.displayName}</div>
              </div>`
            : `<div class="result-wname">平局 (Draw)</div>`
        }
        <div class="result-table">
          ${rows
            .map(({ slot, p }) => {
              const killerName = p.killer >= 0 && this.slots[p.killer] ? this.slots[p.killer].displayName : undefined;
              return `
              <div class="result-row ${p.rank === 1 && winner ? 'is-first' : ''}">
                <span class="r-rank">#${p.rank}</span>
                <img class="r-av" src="${slot.avatar || ''}" alt="" />
                <span class="r-name">${slot.displayName}</span>
                <span class="r-kills">${p.kills} 击杀</span>
                <span class="r-cause">${p.alive ? '存活至终场' : causeLabel(p.cause, killerName)}</span>
              </div>`;
            })
            .join('')}
        </div>
        <button class="start-btn result-back-btn" id="btn-result-back">返回主界面 (${remainSec}s)</button>
      </div>
    `;
    this.resultOverlay.classList.remove('hidden');

    const backBtn = this.resultOverlay.querySelector<HTMLButtonElement>('#btn-result-back');
    backBtn?.addEventListener('click', () => {
      this.clearTimers();
      this.callbacks.onReturnToLobby();
    });

    this.countdownInterval = window.setInterval(() => {
      remainSec--;
      if (backBtn && remainSec > 0) {
        backBtn.textContent = `返回主界面 (${remainSec}s)`;
      }
    }, 1000);

    this.autoReturnTimer = window.setTimeout(() => {
      this.clearTimers();
      this.callbacks.onReturnToLobby();
    }, 4000);
  }

  public hide() {
    this.clearTimers();
    this.root.classList.add('hidden');
    this.resultOverlay.classList.add('hidden');
  }

  private clearTimers() {
    if (this.autoReturnTimer !== null) {
      window.clearTimeout(this.autoReturnTimer);
      this.autoReturnTimer = null;
    }
    if (this.countdownInterval !== null) {
      window.clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
  }
}
