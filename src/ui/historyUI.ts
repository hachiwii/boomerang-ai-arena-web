import {
  MatchHistoryStore,
  MatchHistorySummary,
  MAX_HISTORY_RECORDS,
} from '../game/matchHistory';

type HistoryFilter = 'all' | 'ranked' | 'custom';

export interface HistoryModalCallbacks {
  onReplay: (matchId: string) => Promise<void> | void;
  onOpenChange?: (open: boolean) => void;
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] || c);
}

function formatPlayedTime(ts: number): { short: string; full: string } {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  const full = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

  const now = Date.now();
  const diffSec = Math.max(0, Math.floor((now - ts) / 1000));
  if (diffSec < 60) return { short: '刚刚', full };
  if (diffSec < 3600) return { short: `${Math.floor(diffSec / 60)} 分钟前`, full };

  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) {
    return { short: `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`, full };
  }
  return { short: `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`, full };
}

export class HistoryModal {
  private readonly store: MatchHistoryStore;
  private readonly callbacks: HistoryModalCallbacks;
  private readonly backdrop: HTMLDivElement;

  private openState = false;
  private filter: HistoryFilter = 'all';
  private summaries: MatchHistorySummary[] = [];
  private loading = false;
  private loadingReplayId: string | null = null;
  private confirmClear = false;
  private confirmTimer: number | null = null;

  private readonly handleKeyDown: (e: KeyboardEvent) => void;

  constructor(store: MatchHistoryStore, callbacks: HistoryModalCallbacks) {
    this.store = store;
    this.callbacks = callbacks;

    this.backdrop = document.createElement('div');
    this.backdrop.className = 'history-backdrop hidden';
    document.body.appendChild(this.backdrop);

    this.store.onChange(() => {
      if (this.openState) {
        void this.refresh();
      }
    });

    this.handleKeyDown = (e: KeyboardEvent) => {
      if (!this.openState) return;
      if (e.code === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    };
    window.addEventListener('keydown', this.handleKeyDown);
  }

  public isOpen(): boolean {
    return this.openState;
  }

  public async open() {
    this.openState = true;
    this.loadingReplayId = null;
    this.clearConfirmReset();
    this.backdrop.classList.remove('hidden');
    this.callbacks.onOpenChange?.(true);
    await this.refresh();
  }

  public close() {
    if (!this.openState) return;
    this.openState = false;
    this.loadingReplayId = null;
    this.clearConfirmReset();
    this.backdrop.classList.add('hidden');
    this.callbacks.onOpenChange?.(false);
  }

  private clearConfirmReset() {
    this.confirmClear = false;
    if (this.confirmTimer !== null) {
      window.clearTimeout(this.confirmTimer);
      this.confirmTimer = null;
    }
  }

  private async refresh() {
    this.loading = true;
    this.render();
    try {
      this.summaries = await this.store.listSummaries();
    } finally {
      this.loading = false;
      if (this.openState) {
        this.render();
      }
    }
  }

  private filteredSummaries(): MatchHistorySummary[] {
    if (this.filter === 'ranked') {
      return this.summaries.filter((m) => m.matchMode !== 'custom');
    }
    if (this.filter === 'custom') {
      return this.summaries.filter((m) => m.matchMode === 'custom');
    }
    return this.summaries;
  }

  private renderRow(m: MatchHistorySummary): string {
    const isRanked = m.matchMode !== 'custom';
    const modeLabel =
      m.matchMode === 'ranked-solo'
        ? '⚔️ SOLO 排位'
        : m.matchMode === 'ranked-ffa'
          ? '👑 混战排位'
          : `🎛️ 自定义${Math.abs((m.speed || 1) - 1) > 0.01 ? ` ${m.speed.toFixed(1)}x` : ''}`;
    const modeCls = isRanked ? 'hm-mode-ranked' : 'hm-mode-custom';

    const humanP = m.humanSeat >= 0 ? m.players[m.humanSeat] : null;
    let outcomeText = '';
    let outcomeCls = 'is-spec';
    if (humanP) {
      if (m.winner >= 0 && m.winner === m.humanSeat) {
        outcomeText = '🏆 胜利';
        outcomeCls = 'is-win';
      } else if (m.winner === -1 && !m.earlyExit && humanP.rank === 1) {
        outcomeText = '🤝 平局';
        outcomeCls = 'is-draw';
      } else {
        outcomeText = `第 #${humanP.rank} 名${m.earlyExit ? ' · 提前结算' : ''}`;
        outcomeCls = 'is-loss';
      }
    } else {
      const winnerP = m.winner >= 0 ? m.players[m.winner] : null;
      outcomeText = winnerP ? `👁️ 观战 · ${escapeHtml(winnerP.displayName)} 胜` : '👁️ 观战 · 平局';
      outcomeCls = 'is-spec';
    }

    let eloHtml = '';
    if (isRanked && m.eloDelta !== null && m.eloAfter !== null) {
      const sign = m.eloDelta > 0 ? `+${m.eloDelta}` : `${m.eloDelta}`;
      const cls = m.eloDelta > 0 ? 'elo-up' : m.eloDelta < 0 ? 'elo-down' : 'elo-flat';
      eloHtml = `<span class="hm-elo-pill ${cls}">ELO ${sign} → ${m.eloAfter}</span>`;
    }

    const durSec = (m.durationTicks / 20).toFixed(1);
    const timeInfo = formatPlayedTime(m.playedAt);
    const orderedPlayers = [...m.players].sort((a, b) => a.rank - b.rank || b.kills - a.kills);
    const isLoadingThis = this.loadingReplayId === m.id;

    return `
      <div class="history-row ${outcomeCls}" data-history-id="${escapeHtml(m.id)}">
        <div class="hm-top">
          <div class="hm-meta-left">
            <span class="hm-outcome ${outcomeCls}">${outcomeText}</span>
            <span class="hm-mode ${modeCls}">${modeLabel}</span>
            <span class="hm-map">🗺️ ${escapeHtml(m.mapTitle)}</span>
            <span class="hm-dur">⏱ ${durSec}s</span>
            ${eloHtml}
          </div>
          <span class="hm-time" title="${timeInfo.full}">${timeInfo.short}</span>
        </div>

        <div class="hm-bottom">
          <div class="hm-players">
            ${orderedPlayers
              .map((p) => {
                const isWinner = m.winner >= 0 && m.winner === p.seat;
                const isHuman = p.kind === 'human';
                const killTag = p.kills > 0 ? `<span class="hm-p-kills">${p.kills}杀</span>` : '';
                return `
                  <span class="hm-pchip ${isHuman ? 'is-human' : ''} ${isWinner ? 'is-winner' : ''}">
                    <span class="hm-p-rank">#${p.rank}</span>
                    <img class="hm-p-av" src="${p.avatar || ''}" alt="" style="border-color:${p.ringAccent || p.color}" />
                    <span class="hm-p-name">${escapeHtml(p.displayName)}</span>
                    ${killTag}
                  </span>`;
              })
              .join('')}
          </div>

          <div class="hm-actions">
            <button
              type="button"
              class="hm-replay-btn"
              data-replay-id="${escapeHtml(m.id)}"
              ${this.loadingReplayId !== null ? 'disabled' : ''}
            >
              ${isLoadingThis ? '加载中...' : '▶ 回放'}
            </button>
            <button
              type="button"
              class="hm-del-btn"
              data-delete-id="${escapeHtml(m.id)}"
              title="删除此条对局记录"
              aria-label="删除此条对局记录"
              ${this.loadingReplayId !== null ? 'disabled' : ''}
            >
              ×
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private render() {
    const totalCount = this.summaries.length;
    const rankedCount = this.summaries.filter((m) => m.matchMode !== 'custom').length;
    const customCount = totalCount - rankedCount;
    const visible = this.filteredSummaries();

    let bodyHtml = '';
    if (this.loading && totalCount === 0) {
      bodyHtml = `<div class="history-empty"><div class="he-title">加载对局历史中...</div></div>`;
    } else if (visible.length === 0) {
      const emptyHint =
        totalCount === 0
          ? `完成任意排位赛或自定义对局后，将自动保存最近 ${MAX_HISTORY_RECORDS} 场的完整观战回放。`
          : '当前筛选条件下暂无对局记录，试试切换到「全部」。';
      bodyHtml = `
        <div class="history-empty">
          <div class="he-icon">📜</div>
          <div class="he-title">暂无对局记录</div>
          <div class="he-desc">${emptyHint}</div>
        </div>`;
    } else {
      bodyHtml = `<div class="history-list">${visible.map((m) => this.renderRow(m)).join('')}</div>`;
    }

    this.backdrop.innerHTML = `
      <div class="history-card" role="dialog" aria-label="对局历史">
        <div class="history-head">
          <div class="history-head-left">
            <h2>📜 对局历史</h2>
            <span class="history-count-pill">已保存 ${totalCount} / ${MAX_HISTORY_RECORDS} 场</span>
          </div>
          <div class="history-head-right">
            ${
              totalCount > 0
                ? `<button type="button" class="history-clear-btn ${this.confirmClear ? 'confirm' : ''}" id="history-clear-all">
                    ${this.confirmClear ? '确认清空全部？' : '清空历史'}
                  </button>`
                : ''
            }
            <button type="button" class="settings-close-btn" id="history-close">完成</button>
          </div>
        </div>

        <div class="history-toolbar">
          <div class="history-filter-tabs" role="tablist">
            <button type="button" class="history-filter-btn ${this.filter === 'all' ? 'active' : ''}" data-hfilter="all">
              全部 <span>${totalCount}</span>
            </button>
            <button type="button" class="history-filter-btn ${this.filter === 'ranked' ? 'active' : ''}" data-hfilter="ranked">
              🏆 排位赛 <span>${rankedCount}</span>
            </button>
            <button type="button" class="history-filter-btn ${this.filter === 'custom' ? 'active' : ''}" data-hfilter="custom">
              🎛️ 自定义 <span>${customCount}</span>
            </button>
          </div>
          <div class="history-tip">点击「▶ 回放」以观战全视野视角重放</div>
        </div>

        <div class="history-body">
          ${bodyHtml}
        </div>
      </div>
    `;

    this.backdrop.onclick = (e) => {
      if (e.target === this.backdrop) {
        this.close();
      }
    };

    this.backdrop.querySelector('#history-close')?.addEventListener('click', () => {
      this.close();
    });

    this.backdrop.querySelector('#history-clear-all')?.addEventListener('click', () => {
      if (!this.confirmClear) {
        this.confirmClear = true;
        this.render();
        this.confirmTimer = window.setTimeout(() => {
          this.confirmClear = false;
          this.confirmTimer = null;
          if (this.openState) this.render();
        }, 3500);
        return;
      }
      this.clearConfirmReset();
      void this.store.clearAll();
    });

    this.backdrop.querySelectorAll<HTMLButtonElement>('[data-hfilter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = btn.dataset.hfilter as HistoryFilter;
        if (next === this.filter) return;
        this.filter = next;
        this.render();
      });
    });

    this.backdrop.querySelectorAll<HTMLButtonElement>('[data-replay-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.replayId!;
        if (this.loadingReplayId !== null) return;
        this.loadingReplayId = id;
        this.render();
        Promise.resolve(this.callbacks.onReplay(id)).catch((err) => {
          console.error('Replay launch failed:', err);
          this.loadingReplayId = null;
          if (this.openState) this.render();
        });
      });
    });

    this.backdrop.querySelectorAll<HTMLButtonElement>('[data-delete-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.deleteId!;
        void this.store.deleteMatch(id);
      });
    });
  }
}
