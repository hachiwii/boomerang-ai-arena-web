import { EloUpdateResult, LadderEntrySnap } from '../game/leaderboard';
import { CountdownStage } from '../game/matchController';
import { formatDashSummary, formatMoveSummary, formatPrimaryBind, SettingsStore } from '../game/settings';
import { CauseType, DState, MatchConfig, MatchMode, PState, RankedMode, SlotConfig, TickSnapshot } from '../game/types';

export interface HudCallbacks {
  onReturnToLobby: (opts?: { openLeaderboard?: boolean; rankedMode?: RankedMode }) => void;
  onRestartMatch: () => void;
  onOpenSettings: () => void;
  onToggleCliffGuard: () => boolean;
  onRankCue?: (kind: 'up' | 'down') => void;
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
  private readonly eloToastEl: HTMLDivElement;
  private readonly countdownOverlay: HTMLDivElement;
  private readonly resultOverlay: HTMLDivElement;
  private readonly settings: SettingsStore;
  private readonly callbacks: HudCallbacks;

  private slots: SlotConfig[] = [];
  private matchMode: MatchMode = 'custom';
  private humanSeat = -1;
  private cliffGuard = true;
  private lastTickState: TickSnapshot | null = null;
  private autoReturnTimer: number | null = null;
  private countdownInterval: number | null = null;
  private eloToastTimer: number | null = null;
  private rankAnimTimers: number[] = [];
  private rankAnimRaf: number | null = null;

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
  private humanHintMove: HTMLElement | null = null;
  private humanHintLeft: HTMLElement | null = null;
  private humanHintRight: HTMLElement | null = null;
  private humanHintShift: HTMLElement | null = null;

  constructor(parent: HTMLElement, settings: SettingsStore, callbacks: HudCallbacks) {
    this.settings = settings;
    this.callbacks = callbacks;

    this.settings.onChange(() => {
      this.refreshKeyHints();
    });

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

    this.eloToastEl = document.createElement('div');
    this.eloToastEl.className = 'hud-elo-toast hidden';
    this.root.appendChild(this.eloToastEl);

    this.countdownOverlay = document.createElement('div');
    this.countdownOverlay.className = 'countdown-overlay hidden';
    this.root.appendChild(this.countdownOverlay);

    this.resultOverlay = document.createElement('div');
    this.resultOverlay.className = 'result-overlay hidden';
    this.root.appendChild(this.resultOverlay);
  }

  public setCountdown(stage: CountdownStage) {
    if (stage === null) {
      this.countdownOverlay.classList.add('hidden');
      this.countdownOverlay.innerHTML = '';
      return;
    }

    if (stage === 'GO') {
      this.countdownOverlay.innerHTML = `
        <div class="cd-stage cd-go">
          <div class="cd-ring cd-ring-go"></div>
          <div class="cd-value">GO!</div>
        </div>
      `;
    } else {
      const humanSlot = this.humanSeat >= 0 ? this.slots[this.humanSeat] : null;
      const accent = humanSlot ? humanSlot.ringAccent || humanSlot.color : '#6bb8ff';
      const subHtml = humanSlot
        ? `<div class="cd-sub"><span class="cd-dot" style="background:${accent}"></span>你在 <strong>P${this.humanSeat + 1}</strong> 位置 · 准备开战</div>`
        : '';
      this.countdownOverlay.innerHTML = `
        <div class="cd-stage cd-num cd-n${stage}">
          <div class="cd-ring"></div>
          <div class="cd-value">${stage}</div>
          ${subHtml}
        </div>
      `;
    }
    this.countdownOverlay.classList.remove('hidden');
  }

  public showMatch(config: MatchConfig, humanSeat: number) {
    this.clearTimers();
    this.slots = config.slots;
    this.matchMode = config.matchMode;
    this.humanSeat = humanSeat;
    this.cliffGuard = config.cliffGuard;
    this.setCountdown(null);
    this.resultOverlay.classList.add('hidden');
    this.nameplateLayer.classList.remove('hidden');
    this.root.classList.remove('hidden');

    const mapTag =
      config.matchMode === 'ranked-solo'
        ? `${config.mapMeta.title} · SOLO 排位`
        : config.matchMode === 'ranked-ffa'
          ? `${config.mapMeta.title} · 混战排位`
          : `${config.mapMeta.title}${humanSeat < 0 ? ' · 观战' : ''}${Math.abs((config.speed || 1) - 1) > 0.01 ? ` · ${config.speed.toFixed(1)}x` : ''}`;

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
        <div class="hud-map-label">${mapTag}</div>
        <div class="hud-timer" id="hud-timer">40.0s</div>
        <div class="hud-collapse" id="hud-collapse">塌陷倒计时 12s</div>
      </div>

      <div class="hud-actions">
        <div class="hud-perf" id="hud-perf">20Hz · --Hz</div>
        ${
          humanSeat >= 0
            ? `<button class="hud-btn ${this.cliffGuard ? 'active' : ''}" id="hud-cliff-guard" title="跌落防护：开启时不会走路坠崖；冲刺末尾 25% 若有安全落点会自动停在最远安全点">🛡️ 跌落防护: ${this.cliffGuard ? '开' : '关'}</button>`
            : ''
        }
        <button class="hud-btn" id="hud-settings" title="音效、帧率上限与键位设置">⚙️ 设置</button>
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
    this.topBar.querySelector('#hud-settings')?.addEventListener('click', () => {
      this.callbacks.onOpenSettings();
    });
    this.topBar.querySelector('#hud-cliff-guard')?.addEventListener('click', (e) => {
      this.cliffGuard = this.callbacks.onToggleCliffGuard();
      const btn = e.currentTarget as HTMLButtonElement;
      btn.classList.toggle('active', this.cliffGuard);
      btn.textContent = `🛡️ 跌落防护: ${this.cliffGuard ? '开' : '关'}`;
    });

    this.lastTickState = null;
    this.renderBottomHints(humanSeat);
  }

  private renderBottomHints(humanSeat: number) {
    const kb = this.settings.get().keybindings;
    const mv = formatMoveSummary(kb);
    const thr = formatPrimaryBind(kb.throwRecall);
    const mel = formatPrimaryBind(kb.melee);
    const dsh = formatDashSummary(kb);
    const rst = formatPrimaryBind(kb.quickRestart);

    if (humanSeat >= 0) {
      this.bottomBar.innerHTML = `
        <div class="action-pill" id="hint-move"><kbd>${mv}</kbd> 移动</div>
        <div class="action-pill" id="hint-left"><kbd>${thr}</kbd> 向鼠标扔镖</div>
        <div class="action-pill" id="hint-right"><kbd>${mel}</kbd> 挥砍 / 挡镖</div>
        <div class="action-pill" id="hint-shift"><kbd>${dsh}</kbd> 冲刺就绪</div>
      `;
      this.humanHintMove = this.bottomBar.querySelector('#hint-move');
      this.humanHintLeft = this.bottomBar.querySelector('#hint-left');
      this.humanHintRight = this.bottomBar.querySelector('#hint-right');
      this.humanHintShift = this.bottomBar.querySelector('#hint-shift');
    } else {
      this.bottomBar.innerHTML = `<div class="action-pill spectate-pill">AI 观战模式 · 按 <kbd>${rst}</kbd> 立即原配置重开</div>`;
      this.humanHintMove = null;
      this.humanHintLeft = null;
      this.humanHintRight = null;
      this.humanHintShift = null;
    }
  }

  public refreshKeyHints() {
    if (this.root.classList.contains('hidden')) return;
    this.renderBottomHints(this.humanSeat);
    if (this.lastTickState) {
      this.updateHumanActionHints(this.lastTickState);
    }
    // Also refresh shortcut keycap on open result overlay if present
    const rst = formatPrimaryBind(this.settings.get().keybindings.quickRestart);
    const kbdEl = this.resultOverlay.querySelector<HTMLElement>('.rr-btn-kbd');
    if (kbdEl) kbdEl.textContent = rst;
    const customRstBtn = this.resultOverlay.querySelector<HTMLElement>('#btn-result-restart');
    if (customRstBtn) customRstBtn.textContent = `↻ 重开 (${rst})`;
  }

  public updateTick(state: TickSnapshot, colStart = 240, colEvery = 30) {
    this.lastTickState = state;
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

    this.updateHumanActionHints(state);
  }

  private updateHumanActionHints(state: TickSnapshot) {
    if (this.humanSeat < 0 || !state.players[this.humanSeat]) return;
    const kb = this.settings.get().keybindings;
    const thr = formatPrimaryBind(kb.throwRecall);
    const mel = formatPrimaryBind(kb.melee);
    const dsh = formatDashSummary(kb);
    const rst = formatPrimaryBind(kb.quickRestart);

    const me = state.players[this.humanSeat];
    const md = state.darts[this.humanSeat];
    if (!me.alive) {
      if (this.humanHintMove) this.humanHintMove.style.display = 'none';
      if (this.humanHintLeft) {
        this.humanHintLeft.innerHTML =
          this.matchMode !== 'custom'
            ? `已出局观战中 · 按 <kbd>${rst}</kbd> 重新匹配下一局`
            : `已出局观战中 · 按 <kbd>${rst}</kbd> 立即原配置重开`;
        this.humanHintLeft.classList.add('spectate-pill');
      }
      if (this.humanHintRight) this.humanHintRight.style.display = 'none';
      if (this.humanHintShift) this.humanHintShift.style.display = 'none';
    } else {
      if (this.humanHintMove) this.humanHintMove.style.display = '';
      if (this.humanHintLeft) this.humanHintLeft.classList.remove('spectate-pill');
      if (this.humanHintRight) this.humanHintRight.style.display = '';
      if (this.humanHintShift) this.humanHintShift.style.display = '';
      if (this.humanHintLeft) {
        if (md.st === DState.HAND) this.humanHintLeft.innerHTML = `<kbd>${thr}</kbd> 向鼠标扔镖`;
        else if (md.st === DState.GROUND) this.humanHintLeft.innerHTML = `<kbd>长按 ${thr}</kbd> 召回落地镖`;
        else if (md.st === DState.RISE) this.humanHintLeft.innerHTML = `<kbd>按住中</kbd> 召回引导 ${Math.round((1 - me.timer / 12) * 100)}%`;
        else this.humanHintLeft.innerHTML = `<kbd>${thr}</kbd> 飞镖飞行中`;
      }
      if (this.humanHintRight) {
        this.humanHintRight.innerHTML =
          md.st === DState.HAND ? `<kbd>${mel}</kbd> 挥砍 / 挡镖` : `<kbd>${mel}</kbd> 踢人击退`;
      }
      if (this.humanHintShift) {
        this.humanHintShift.innerHTML =
          me.cd === 0
            ? `<kbd>${dsh}</kbd> 冲刺就绪`
            : `<kbd>${dsh}</kbd> 冷却 ${(me.cd / 20).toFixed(1)}s`;
        this.humanHintShift.classList.toggle('ready', me.cd === 0);
      }
    }
  }

  public updateTelemetry(logicHz: number, renderHz: number, frameWorkMs: number, botMaxMs: number, speed = 1.0) {
    if (!this.perfEl) return;
    const capHz = frameWorkMs > 0.05 ? Math.min(999, Math.round(1000 / frameWorkMs)) : 999;
    const logicStr = logicHz < 10 ? logicHz.toFixed(1) : logicHz.toFixed(0);
    const spdTag = Math.abs(speed - 1) > 0.01 ? ` (${speed.toFixed(1)}x)` : '';
    this.perfEl.textContent = `逻辑 ${logicStr}Hz${spdTag} · 渲染 ${Math.round(renderHz)}Hz (${frameWorkMs.toFixed(1)}ms, 峰值~${capHz}Hz · AI ${botMaxMs.toFixed(1)}ms)`;
  }

  public showMatchResult(finalState: TickSnapshot, eloResult: EloUpdateResult | null = null) {
    this.clearTimers();
    const isRanked = this.matchMode !== 'custom';
    if (isRanked && eloResult) {
      this.showRankedMatchResult(finalState, eloResult);
      return;
    }

    const winner = finalState.winner >= 0 ? this.slots[finalState.winner] : null;
    const rows = finalState.players
      .map((p, idx) => ({
        idx,
        slot: this.slots[idx],
        p,
      }))
      .sort((a, b) => a.p.rank - b.p.rank || b.p.kills - a.p.kills);

    const canRestart = this.humanSeat < 0 || !(finalState.players[this.humanSeat]?.alive);
    const rstKey = formatPrimaryBind(this.settings.get().keybindings.quickRestart);

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
        <div class="result-btn-row">
          ${canRestart ? `<button class="result-restart-btn" id="btn-result-restart">↻ 重开 (${rstKey})</button>` : ''}
          <button class="start-btn result-back-btn" id="btn-result-back">返回主界面 (${remainSec}s)</button>
        </div>
      </div>
    `;
    this.nameplateLayer.classList.add('hidden');
    this.resultOverlay.classList.remove('hidden');

    const backBtn = this.resultOverlay.querySelector<HTMLButtonElement>('#btn-result-back');
    backBtn?.addEventListener('click', () => {
      this.clearTimers();
      this.callbacks.onReturnToLobby();
    });

    this.resultOverlay.querySelector<HTMLButtonElement>('#btn-result-restart')?.addEventListener('click', () => {
      this.clearTimers();
      this.callbacks.onRestartMatch();
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

  private showRankedMatchResult(finalState: TickSnapshot, elo: EloUpdateResult) {
    const modeLabel = elo.mode === 'solo' ? 'SOLO 排位' : '四人混战排位';
    const humanP = this.humanSeat >= 0 ? finalState.players[this.humanSeat] : null;
    const humanWon = finalState.winner >= 0 && finalState.winner === this.humanSeat;
    const isDraw = finalState.winner === -1 && humanP?.rank === 1;

    const outcomeText = humanWon
      ? '🏆 本局胜利'
      : isDraw
        ? '🤝 平局'
        : humanP
          ? `第 #${humanP.rank} 名`
          : '对局结束';
    const outcomeCls = humanWon ? 'is-win' : isDraw ? 'is-draw' : 'is-loss';

    const matchRows = finalState.players
      .map((p, idx) => ({ idx, slot: this.slots[idx], p }))
      .sort((a, b) => a.p.rank - b.p.rank || b.p.kills - a.p.kills);

    // Build focused animated mini-ladder slice around oldRank & newRank
    const total = elo.afterLadder.length;
    const oldIdx = Math.max(0, elo.oldRank - 1);
    const newIdx = Math.max(0, elo.newRank - 1);
    const minIdx = Math.min(oldIdx, newIdx);
    const maxIdx = Math.max(oldIdx, newIdx);
    let winStart = Math.max(0, minIdx - 1);
    let winEnd = Math.min(total - 1, maxIdx + 1);
    while (winEnd - winStart + 1 < 4 && (winStart > 0 || winEnd < total - 1)) {
      if (winStart > 0) winStart--;
      if (winEnd - winStart + 1 < 4 && winEnd < total - 1) winEnd++;
    }
    const visibleCount = winEnd - winStart + 1;
    const ROW_STRIDE = 48; // 42px row + 6px gap
    const viewportHeight = visibleCount * ROW_STRIDE - 6;

    const beforePos = new Map(elo.beforeLadder.map((e, i) => [e.id, i]));
    const afterPos = new Map(elo.afterLadder.map((e, i) => [e.id, i]));
    const afterById = new Map(elo.afterLadder.map((e) => [e.id, e]));
    const beforeById = new Map(elo.beforeLadder.map((e) => [e.id, e]));

    const involvedIds = new Set<string>();
    for (let i = winStart; i <= winEnd; i++) {
      if (elo.beforeLadder[i]) involvedIds.add(elo.beforeLadder[i].id);
      if (elo.afterLadder[i]) involvedIds.add(elo.afterLadder[i].id);
    }

    const overtookIds = new Set(elo.overtook.map((e) => e.id));
    const overtakenByIds = new Set(elo.overtakenBy.map((e) => e.id));

    interface AnimRowSpec {
      id: string;
      entry: LadderEntrySnap;
      startSlot: number;
      endSlot: number;
      beforeRank: number;
      afterRank: number;
    }

    const animRows: AnimRowSpec[] = [];
    for (const id of involvedIds) {
      const bEntry = beforeById.get(id);
      const aEntry = afterById.get(id);
      if (!bEntry || !aEntry) continue;
      const bIdx = beforePos.get(id) ?? 0;
      const aIdx = afterPos.get(id) ?? 0;
      // Clamp offscreen entry/exit distance to 1 row outside viewport for clean slide-in/out
      const startSlot = Math.max(-1, Math.min(visibleCount, bIdx - winStart));
      const endSlot = Math.max(-1, Math.min(visibleCount, aIdx - winStart));
      animRows.push({
        id,
        entry: aEntry,
        startSlot,
        endSlot,
        beforeRank: bEntry.rank,
        afterRank: aEntry.rank,
      });
    }

    const renderMiniChips = (list: LadderEntrySnap[]) =>
      list
        .map(
          (e) => `
        <span class="rr-pass-chip">
          <img src="${e.avatar || ''}" alt="" />
          <span>${e.shortName}</span>
          <em>${e.rating}</em>
        </span>`,
        )
        .join('');

    let passBannerCls = 'is-flat';
    let passBannerHtml = '';
    if (elo.overtook.length > 0) {
      passBannerCls = 'is-up';
      passBannerHtml = `<span class="rr-pass-tag">🚀 超过了</span><span class="rr-pass-chips">${renderMiniChips(elo.overtook)}</span>`;
    } else if (elo.overtakenBy.length > 0) {
      passBannerCls = 'is-down';
      passBannerHtml = `<span class="rr-pass-tag">⚠️ 被</span><span class="rr-pass-chips">${renderMiniChips(elo.overtakenBy)}</span><span class="rr-pass-tag">超过</span>`;
    } else if (elo.newRank === 1) {
      passBannerCls = 'is-top';
      passBannerHtml = `<span class="rr-pass-tag">👑 稳居榜首！</span>`;
    } else {
      const above = elo.afterLadder[newIdx - 1];
      if (above) {
        const gap = Math.max(0, above.rating - elo.newRating);
        passBannerHtml = `<span class="rr-pass-tag">距离超越</span><span class="rr-pass-chips">${renderMiniChips([above])}</span><span class="rr-pass-tag">还差 <strong>${gap}</strong> 分</span>`;
      }
    }

    const deltaSign = elo.delta > 0 ? `+${elo.delta}` : `${elo.delta}`;
    const deltaCls = elo.delta > 0 ? 'elo-up' : elo.delta < 0 ? 'elo-down' : 'elo-flat';
    const rankDiff = elo.oldRank - elo.newRank; // > 0 means climbed up
    const rankDeltaText =
      rankDiff > 0 ? `▲ 上升 ${rankDiff} 名` : rankDiff < 0 ? `▼ 下降 ${Math.abs(rankDiff)} 名` : '名次不变';
    const rankDeltaCls = rankDiff > 0 ? 'rk-up' : rankDiff < 0 ? 'rk-down' : 'rk-flat';

    this.resultOverlay.innerHTML = `
      <div class="result-card ranked-result-card">
        <div class="rr-head">
          <div class="rr-head-left">
            <span class="rr-mode-pill">${modeLabel}</span>
            <span class="rr-outcome ${outcomeCls}">${outcomeText}</span>
          </div>
          <button type="button" class="rr-lb-mini-btn" id="btn-result-lb">🏆 完整榜单</button>
        </div>

        <div class="rr-hero">
          <div class="rr-hero-block">
            <div class="rr-hero-label">ELO 分数</div>
            <div class="rr-elo-line">
              <span class="rr-elo-num ${deltaCls}" id="rr-elo-num">${elo.oldRating}</span>
              <span class="rr-delta-pill ${deltaCls}" id="rr-delta-pill">${deltaSign}</span>
            </div>
          </div>
          <div class="rr-hero-sep"></div>
          <div class="rr-hero-block">
            <div class="rr-hero-label">当前排名</div>
            <div class="rr-rank-line">
              <span class="rr-rank-num" id="rr-rank-num">#${elo.oldRank}</span>
              <span class="rr-rank-total">/ ${elo.totalRanked}</span>
            </div>
            <div class="rr-rank-delta ${rankDeltaCls}" id="rr-rank-delta">${rankDeltaText}</div>
          </div>
        </div>

        <div class="rr-ladder-wrap">
          <div class="rr-ladder-viewport" style="height:${viewportHeight}px">
            ${animRows
              .map((r) => {
                const startVisible = r.startSlot >= 0 && r.startSlot < visibleCount;
                const initY = r.startSlot * ROW_STRIDE;
                const initScore = r.entry.isHuman ? elo.oldRating : r.entry.rating;
                return `
                <div
                  class="rr-lrow ${r.entry.isHuman ? 'is-human' : ''}"
                  data-lrow-id="${r.id}"
                  style="transform:translate3d(0, ${initY}px, 0); opacity:${startVisible ? 1 : 0};"
                >
                  <span class="rr-lr-rank" data-lrow-rank="${r.id}">#${r.beforeRank}</span>
                  <img class="rr-lr-av" src="${r.entry.avatar || ''}" alt="" />
                  <span class="rr-lr-name">${r.entry.name}</span>
                  <span class="rr-lr-score" ${r.entry.isHuman ? 'id="rr-human-row-elo"' : ''}>${initScore}</span>
                </div>`;
              })
              .join('')}
          </div>
        </div>

        <div class="rr-pass-banner ${passBannerCls}" id="rr-pass-banner">
          ${passBannerHtml}
        </div>

        <div class="result-table rr-match-table">
          ${matchRows
            .map(({ slot, p }) => {
              const killerName = p.killer >= 0 && this.slots[p.killer] ? this.slots[p.killer].displayName : undefined;
              return `
              <div class="result-row ${slot.kind === 'human' ? 'is-human-row' : ''} ${p.rank === 1 && finalState.winner >= 0 ? 'is-first' : ''}">
                <span class="r-rank">#${p.rank}</span>
                <img class="r-av" src="${slot.avatar || ''}" alt="" />
                <span class="r-name">${slot.displayName}</span>
                <span class="r-kills">${p.kills} 击杀</span>
                <span class="r-cause">${p.alive ? '存活至终场' : causeLabel(p.cause, killerName)}</span>
              </div>`;
            })
            .join('')}
        </div>

        <div class="rr-btn-row">
          <button type="button" class="rr-back-btn" id="btn-result-back">返回主界面</button>
          <button type="button" class="start-btn rr-primary-btn" id="btn-result-new-match">⚔️ 重新匹配 <kbd class="rr-btn-kbd">${formatPrimaryBind(this.settings.get().keybindings.quickRestart)}</kbd></button>
        </div>
      </div>
    `;

    this.nameplateLayer.classList.add('hidden');
    this.resultOverlay.classList.remove('hidden');

    // Bind buttons
    this.resultOverlay.querySelector<HTMLButtonElement>('#btn-result-back')?.addEventListener('click', () => {
      this.clearTimers();
      this.callbacks.onReturnToLobby();
    });
    this.resultOverlay.querySelector<HTMLButtonElement>('#btn-result-new-match')?.addEventListener('click', () => {
      this.clearTimers();
      this.callbacks.onRestartMatch();
    });
    this.resultOverlay.querySelector<HTMLButtonElement>('#btn-result-lb')?.addEventListener('click', () => {
      this.clearTimers();
      this.callbacks.onReturnToLobby({ openLeaderboard: true, rankedMode: elo.mode });
    });

    // Choreographed score count-up + ladder row-swap + overtake reveal animation
    const eloNumEl = this.resultOverlay.querySelector<HTMLElement>('#rr-elo-num');
    const humanRowEloEl = this.resultOverlay.querySelector<HTMLElement>('#rr-human-row-elo');
    const deltaPillEl = this.resultOverlay.querySelector<HTMLElement>('#rr-delta-pill');
    const rankNumEl = this.resultOverlay.querySelector<HTMLElement>('#rr-rank-num');
    const rankDeltaEl = this.resultOverlay.querySelector<HTMLElement>('#rr-rank-delta');
    const passBannerEl = this.resultOverlay.querySelector<HTMLElement>('#rr-pass-banner');

    const scheduleAnim = (delayMs: number, fn: () => void) => {
      const h = window.setTimeout(fn, delayMs);
      this.rankAnimTimers.push(h);
    };

    // Beat 1 -> Beat 2: Smoothly roll ELO score and glide ladder rows
    scheduleAnim(260, () => {
      deltaPillEl?.classList.add('is-shown');

      const durMs = elo.delta === 0 ? 220 : 820;
      const tStart = performance.now();
      const stepNum = (now: number) => {
        const u = Math.min(1, (now - tStart) / durMs);
        const eased = 1 - Math.pow(1 - u, 3);
        const cur = Math.round(elo.oldRating + (elo.newRating - elo.oldRating) * eased);
        if (eloNumEl) eloNumEl.textContent = String(cur);
        if (humanRowEloEl) humanRowEloEl.textContent = String(cur);
        if (u < 1) {
          this.rankAnimRaf = requestAnimationFrame(stepNum);
        } else {
          this.rankAnimRaf = null;
        }
      };
      this.rankAnimRaf = requestAnimationFrame(stepNum);
    });

    // Beat 2: Swap ladder rows smoothly
    scheduleAnim(360, () => {
      for (const r of animRows) {
        const rowEl = this.resultOverlay.querySelector<HTMLElement>(`[data-lrow-id="${r.id}"]`);
        const rkEl = this.resultOverlay.querySelector<HTMLElement>(`[data-lrow-rank="${r.id}"]`);
        if (!rowEl) continue;
        const endVisible = r.endSlot >= 0 && r.endSlot < visibleCount;
        const endY = r.endSlot * ROW_STRIDE;
        if (r.entry.isHuman) {
          rowEl.classList.add(rankDiff > 0 ? 'is-climbing' : rankDiff < 0 ? 'is-dropping' : 'is-pulsing');
        } else if (overtookIds.has(r.id)) {
          rowEl.classList.add('is-overtaken');
        } else if (overtakenByIds.has(r.id)) {
          rowEl.classList.add('is-overtaking');
        }
        rowEl.style.transform = `translate3d(0, ${endY}px, 0)`;
        rowEl.style.opacity = endVisible ? '1' : '0';
        if (rkEl) rkEl.textContent = `#${r.afterRank}`;
      }
    });

    // Beat 3: Pop new rank, reveal "超过了 XXX / 被 XXX 超过" banner, and trigger audio cue
    scheduleAnim(880, () => {
      if (rankNumEl) {
        rankNumEl.textContent = `#${elo.newRank}`;
        if (rankDiff !== 0) {
          rankNumEl.classList.add(rankDiff > 0 ? 'pop-up' : 'pop-down');
        }
      }
      rankDeltaEl?.classList.add('is-shown');
      passBannerEl?.classList.add('is-shown');
      if (elo.overtook.length > 0) {
        this.callbacks.onRankCue?.('up');
      } else if (elo.overtakenBy.length > 0) {
        this.callbacks.onRankCue?.('down');
      }
    });

    // Settle human row lift after glide finishes
    scheduleAnim(1220, () => {
      const humanEl = this.resultOverlay.querySelector<HTMLElement>('.rr-lrow.is-human');
      humanEl?.classList.remove('is-climbing', 'is-dropping', 'is-pulsing');
    });
  }

  public showEloToast(rank: number, eloResult: EloUpdateResult) {
    if (this.eloToastTimer !== null) {
      window.clearTimeout(this.eloToastTimer);
      this.eloToastTimer = null;
    }
    const modeLabel = eloResult.mode === 'solo' ? 'SOLO' : '混战';
    const deltaStr = `${eloResult.delta >= 0 ? '+' : ''}${eloResult.delta}`;
    const cls = eloResult.delta > 0 ? 'elo-up' : eloResult.delta < 0 ? 'elo-down' : '';
    this.eloToastEl.className = `hud-elo-toast ${cls}`;
    this.eloToastEl.innerHTML = `上局第 <strong>#${rank}</strong> 名 · ${modeLabel} ELO ${eloResult.oldRating} → <strong>${eloResult.newRating}</strong> <span class="het-delta">(${deltaStr})</span>`;
    this.eloToastTimer = window.setTimeout(() => {
      this.eloToastTimer = null;
      this.eloToastEl.classList.add('hidden');
    }, 2600);
  }

  public cancelResultOverlay(restarting = false, isRanked = false) {
    this.clearTimers();
    this.setCountdown(null);
    this.resultOverlay.classList.add('hidden');
    this.nameplateLayer.classList.remove('hidden');
    if (restarting) {
      this.bottomBar.innerHTML = `<div class="action-pill spectate-pill">${isRanked ? '正在按最新 ELO 重新匹配对手与地图...' : '正在按原配置与站位重开...'}</div>`;
    }
  }

  public hide() {
    this.clearTimers();
    if (this.eloToastTimer !== null) {
      window.clearTimeout(this.eloToastTimer);
      this.eloToastTimer = null;
    }
    this.eloToastEl.classList.add('hidden');
    this.setCountdown(null);
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
    for (const h of this.rankAnimTimers) {
      window.clearTimeout(h);
    }
    this.rankAnimTimers = [];
    if (this.rankAnimRaf !== null) {
      cancelAnimationFrame(this.rankAnimRaf);
      this.rankAnimRaf = null;
    }
  }
}
