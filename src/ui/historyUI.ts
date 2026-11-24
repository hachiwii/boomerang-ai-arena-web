import {
  getHistoryModeBucket,
  MatchHistoryStore,
  MatchHistorySummary,
  MAX_HISTORY_PER_MODE,
} from '../game/matchHistory';
import { Mp4ExportResult } from '../game/mp4Exporter';
import { SettingsStore } from '../game/settings';

type HistoryFilter = 'all' | 'ranked' | 'cricket' | 'custom';

export interface HistoryModalCallbacks {
  onReplay: (matchId: string) => Promise<void> | void;
  onExportMp4: (
    matchId: string,
    signal: AbortSignal,
    onProgress: (progress01: number, phaseText: string) => void,
  ) => Promise<Mp4ExportResult>;
  onOpenSettings: () => void;
  onOpenChange?: (open: boolean) => void;
}

interface ActiveExportState {
  matchId: string;
  mapTitle: string;
  presetLabel: string;
  progress: number;
  phaseText: string;
  controller: AbortController;
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] || c);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
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

function renderFavoriteStarSvg(filled: boolean): string {
  if (filled) {
    return `<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2.5 15.09 8.76 22 9.77 17 14.64 18.18 21.52 12 18.27 5.82 21.52 7 14.64 2 9.77 8.91 8.76 12 2.5"/></svg>`;
  }
  return `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2.5 15.09 8.76 22 9.77 17 14.64 18.18 21.52 12 18.27 5.82 21.52 7 14.64 2 9.77 8.91 8.76 12 2.5"/></svg>`;
}

export class HistoryModal {
  private readonly store: MatchHistoryStore;
  private readonly settings: SettingsStore;
  private readonly callbacks: HistoryModalCallbacks;
  private readonly backdrop: HTMLDivElement;
  private readonly card: HTMLDivElement;
  private readonly countPillEl: HTMLElement;
  private readonly clearAllBtn: HTMLButtonElement;
  private readonly closeBtn: HTMLButtonElement;
  private readonly exportCfgBtn: HTMLButtonElement;
  private readonly filterBtns: HTMLButtonElement[];
  private readonly favOnlyBtn: HTMLButtonElement;
  private readonly favCountEl: HTMLElement;
  private readonly exportSlotEl: HTMLDivElement;
  private readonly noticeSlotEl: HTMLDivElement;
  private readonly bodyEl: HTMLDivElement;

  private openState = false;
  private filter: HistoryFilter = 'all';
  private favoritesOnly = false;
  private suppressStoreRefreshCount = 0;
  private summaries: MatchHistorySummary[] = [];
  private loading = false;
  private loadingReplayId: string | null = null;
  private activeExport: ActiveExportState | null = null;
  private statusNotice: { text: string; kind: 'ok' | 'err' } | null = null;
  private statusTimer: number | null = null;
  private confirmClear = false;
  private confirmTimer: number | null = null;

  private readonly handleKeyDown: (e: KeyboardEvent) => void;

  constructor(store: MatchHistoryStore, settings: SettingsStore, callbacks: HistoryModalCallbacks) {
    this.store = store;
    this.settings = settings;
    this.callbacks = callbacks;

    this.backdrop = document.createElement('div');
    this.backdrop.className = 'history-backdrop hidden';
    this.card = document.createElement('div');
    this.card.className = 'history-card';
    this.card.setAttribute('role', 'dialog');
    this.card.setAttribute('aria-label', '对局历史');

    // Persistent modal shell bound ONCE (header & toolbar never flash or reset focus on interactions)
    this.card.innerHTML = `
      <div class="history-head">
        <div class="history-head-left">
          <h2>📜 对局历史</h2>
          <span class="history-count-pill" id="history-count-pill">已保存 0 场 · 各模式上限 ${MAX_HISTORY_PER_MODE}</span>
        </div>
        <div class="history-head-right">
          <button type="button" class="history-clear-btn hidden" id="history-clear-all">清空历史</button>
          <button type="button" class="settings-close-btn" id="history-close">完成</button>
        </div>
      </div>

      <div class="history-toolbar">
        <div class="history-toolbar-left">
          <div class="history-filter-tabs" role="tablist">
            <button type="button" class="history-filter-btn active" data-hfilter="all">全部 <span data-fcount="all">0</span></button>
            <button type="button" class="history-filter-btn" data-hfilter="ranked">🏆 排位赛 <span data-fcount="ranked">0</span></button>
            <button type="button" class="history-filter-btn" data-hfilter="cricket">🦗 斗蛐蛐 <span data-fcount="cricket">0</span></button>
            <button type="button" class="history-filter-btn" data-hfilter="custom">🎛️ 自定义 <span data-fcount="custom">0</span></button>
          </div>
          <button
            type="button"
            class="history-fav-filter-btn"
            id="history-fav-only"
            role="switch"
            aria-checked="false"
            title="只看已收藏的对局（可与左侧模式筛选同时生效）"
          >
            <span class="hff-star" aria-hidden="true">★</span>
            <span>只看收藏</span>
            <span class="hff-count" id="history-fav-count">0</span>
          </button>
        </div>
        <button
          type="button"
          class="history-export-cfg-btn"
          id="history-open-export-settings"
          title="在设置中调整 MP4 导出分辨率、码率与播放速度"
        ></button>
      </div>

      <div id="history-export-slot" class="hidden"></div>
      <div id="history-notice-slot" class="hidden"></div>
      <div class="history-body" id="history-body"></div>
    `;

    this.countPillEl = this.card.querySelector<HTMLElement>('#history-count-pill')!;
    this.clearAllBtn = this.card.querySelector<HTMLButtonElement>('#history-clear-all')!;
    this.closeBtn = this.card.querySelector<HTMLButtonElement>('#history-close')!;
    this.exportCfgBtn = this.card.querySelector<HTMLButtonElement>('#history-open-export-settings')!;
    this.filterBtns = Array.from(this.card.querySelectorAll<HTMLButtonElement>('[data-hfilter]'));
    this.favOnlyBtn = this.card.querySelector<HTMLButtonElement>('#history-fav-only')!;
    this.favCountEl = this.card.querySelector<HTMLElement>('#history-fav-count')!;
    this.exportSlotEl = this.card.querySelector<HTMLDivElement>('#history-export-slot')!;
    this.noticeSlotEl = this.card.querySelector<HTMLDivElement>('#history-notice-slot')!;
    this.bodyEl = this.card.querySelector<HTMLDivElement>('#history-body')!;

    this.backdrop.appendChild(this.card);
    document.body.appendChild(this.backdrop);

    this.backdrop.addEventListener('click', (e) => {
      if (e.target === this.backdrop && !this.activeExport) {
        this.close();
      }
    });

    this.closeBtn.addEventListener('click', () => {
      if (!this.activeExport) this.close();
    });

    this.exportCfgBtn.addEventListener('click', () => {
      if (this.activeExport) return;
      this.callbacks.onOpenSettings();
    });

    this.clearAllBtn.addEventListener('click', () => {
      if (this.activeExport) return;
      if (!this.confirmClear) {
        this.confirmClear = true;
        this.syncHeaderControls();
        this.confirmTimer = window.setTimeout(() => {
          this.confirmClear = false;
          this.confirmTimer = null;
          if (this.openState) this.syncHeaderControls();
        }, 3500);
        return;
      }
      this.clearConfirmReset();
      void this.store.clearNonFavorites();
    });

    for (const btn of this.filterBtns) {
      btn.addEventListener('click', () => {
        const next = btn.dataset.hfilter as HistoryFilter;
        if (next === this.filter) return;
        this.filter = next;
        this.bodyEl.scrollTop = 0;
        this.render();
      });
    }

    this.favOnlyBtn.addEventListener('click', () => {
      this.favoritesOnly = !this.favoritesOnly;
      this.bodyEl.scrollTop = 0;
      this.render();
    });

    this.store.onChange(() => {
      if (this.suppressStoreRefreshCount > 0) {
        this.suppressStoreRefreshCount--;
        return;
      }
      if (this.openState) {
        void this.refresh();
      }
    });

    this.settings.onChange(() => {
      if (this.openState && !this.activeExport) {
        this.syncExportPresetInPlace();
      }
    });

    this.handleKeyDown = (e: KeyboardEvent) => {
      if (!this.openState) return;
      if (e.code === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (this.activeExport) return; // Don't accidentally abort active export via ESC
        this.close();
      }
    };
    window.addEventListener('keydown', this.handleKeyDown);
  }

  public isOpen(): boolean {
    return this.openState;
  }

  public isExporting(): boolean {
    return this.activeExport !== null;
  }

  public async open() {
    this.openState = true;
    this.loadingReplayId = null;
    this.clearConfirmReset();
    this.callbacks.onOpenChange?.(true);
    try {
      this.summaries = await this.store.listSummaries();
    } catch {
      // Keep existing summaries on error
    }
    if (!this.openState) return;
    this.loading = false;
    this.render();
    this.bodyEl.scrollTop = 0;
    this.backdrop.classList.remove('hidden');
  }

  public close() {
    if (!this.openState) return;
    if (this.activeExport) {
      this.activeExport.controller.abort();
      this.activeExport = null;
    }
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

  private showNotice(text: string, kind: 'ok' | 'err' = 'ok') {
    this.statusNotice = { text, kind };
    if (this.statusTimer !== null) {
      window.clearTimeout(this.statusTimer);
    }
    this.statusTimer = window.setTimeout(() => {
      this.statusNotice = null;
      this.statusTimer = null;
      if (this.openState) this.syncNoticeSlot();
    }, 5000);
    if (this.openState) this.syncNoticeSlot();
  }

  private getExportPresetLabel(): string {
    const s = this.settings.get();
    const spd = s.exportSpeed === 1 ? '1x' : `${s.exportSpeed}x`;
    return `${s.exportResolution} · ${s.exportBitrateMbps} Mbps · ${spd}`;
  }

  private syncExportPresetInPlace() {
    const presetLabel = this.getExportPresetLabel();
    this.exportCfgBtn.textContent = `⚙️ 导出设置：${presetLabel}`;
    this.bodyEl.querySelectorAll<HTMLButtonElement>('[data-export-id]').forEach((btn) => {
      btn.title = `将本局观战回放导出下载为 MP4（当前：${presetLabel}）`;
    });
  }

  private syncNoticeSlot() {
    if (this.statusNotice) {
      this.noticeSlotEl.innerHTML = `<div class="history-notice ${this.statusNotice.kind === 'ok' ? 'is-ok' : 'is-err'}">${escapeHtml(this.statusNotice.text)}</div>`;
      this.noticeSlotEl.classList.remove('hidden');
    } else {
      this.noticeSlotEl.innerHTML = '';
      this.noticeSlotEl.classList.add('hidden');
    }
  }

  private syncHeaderControls() {
    const totalCount = this.summaries.length;
    const favTotal = this.summaries.filter((m) => m.favorite).length;
    const unfavTotal = totalCount - favTotal;
    const busy = this.activeExport !== null;

    if (this.filter === 'all') {
      this.countPillEl.textContent =
        favTotal > 0
          ? `已保存 ${totalCount} 场（含 ${favTotal} 收藏）· 各模式上限 ${MAX_HISTORY_PER_MODE}`
          : `已保存 ${totalCount} 场 · 各模式上限 ${MAX_HISTORY_PER_MODE}`;
    } else {
      const modeName = this.filter === 'ranked' ? '排位赛' : this.filter === 'cricket' ? '斗蛐蛐' : '自定义';
      const modeAll = this.summaries.filter((m) => getHistoryModeBucket(m.matchMode) === this.filter);
      const modeFav = modeAll.filter((m) => m.favorite).length;
      const modeRegular = modeAll.length - modeFav;
      this.countPillEl.textContent =
        modeFav > 0
          ? `${modeName} ${modeRegular}/${MAX_HISTORY_PER_MODE} + ${modeFav} 收藏`
          : `${modeName} ${modeRegular} / ${MAX_HISTORY_PER_MODE} 场`;
    }

    this.clearAllBtn.classList.toggle('hidden', unfavTotal === 0);
    this.clearAllBtn.classList.toggle('confirm', this.confirmClear);
    this.clearAllBtn.textContent = this.confirmClear
      ? favTotal > 0
        ? `清空未收藏？(保留 ${favTotal} 收藏)`
        : '确认清空全部？'
      : '清空历史';
    this.clearAllBtn.disabled = busy;
    this.closeBtn.disabled = busy;
    this.exportCfgBtn.disabled = busy;
  }

  private syncFilterControls() {
    const modePool = this.favoritesOnly ? this.summaries.filter((m) => m.favorite) : this.summaries;
    const filterCounts: Record<HistoryFilter, number> = {
      all: modePool.length,
      ranked: modePool.filter((m) => getHistoryModeBucket(m.matchMode) === 'ranked').length,
      cricket: modePool.filter((m) => getHistoryModeBucket(m.matchMode) === 'cricket').length,
      custom: modePool.filter((m) => getHistoryModeBucket(m.matchMode) === 'custom').length,
    };
    for (const btn of this.filterBtns) {
      const f = btn.dataset.hfilter as HistoryFilter;
      btn.classList.toggle('active', f === this.filter);
      const span = btn.querySelector<HTMLElement>(`[data-fcount="${f}"]`);
      if (span) span.textContent = String(filterCounts[f]);
    }

    const modeScopedFavCount = this.summaries.filter((m) => {
      if (!m.favorite) return false;
      if (this.filter !== 'all' && getHistoryModeBucket(m.matchMode) !== this.filter) return false;
      return true;
    }).length;
    this.favOnlyBtn.classList.toggle('active', this.favoritesOnly);
    this.favOnlyBtn.setAttribute('aria-checked', String(this.favoritesOnly));
    this.favCountEl.textContent = String(modeScopedFavCount);
  }

  private async refresh() {
    this.loading = true;
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
    return this.summaries.filter((m) => {
      if (this.favoritesOnly && !m.favorite) return false;
      if (this.filter !== 'all' && getHistoryModeBucket(m.matchMode) !== this.filter) return false;
      return true;
    });
  }

  private updateExportProgressDom() {
    if (!this.activeExport) return;
    const pct = Math.max(0, Math.min(100, Math.round(this.activeExport.progress * 100)));
    const barFill = this.backdrop.querySelector<HTMLElement>('#history-export-fill');
    const pctEl = this.backdrop.querySelector<HTMLElement>('#history-export-pct');
    const phaseEl = this.backdrop.querySelector<HTMLElement>('#history-export-phase');
    const rowBtn = this.backdrop.querySelector<HTMLButtonElement>(
      `[data-export-id="${CSS.escape(this.activeExport.matchId)}"]`,
    );
    if (barFill) barFill.style.width = `${pct}%`;
    if (pctEl) pctEl.textContent = `${pct}%`;
    if (phaseEl) phaseEl.textContent = this.activeExport.phaseText;
    if (rowBtn) rowBtn.textContent = `导出 ${pct}%`;
  }

  private startExport(summary: MatchHistorySummary) {
    if (this.activeExport || this.loadingReplayId !== null) return;
    const controller = new AbortController();
    const presetLabel = this.getExportPresetLabel();
    this.statusNotice = null;
    this.activeExport = {
      matchId: summary.id,
      mapTitle: summary.mapTitle,
      presetLabel,
      progress: 0.01,
      phaseText: '准备导出...',
      controller,
    };
    this.render();

    void this.callbacks
      .onExportMp4(summary.id, controller.signal, (p01, phaseText) => {
        if (!this.activeExport || this.activeExport.matchId !== summary.id) return;
        this.activeExport.progress = p01;
        this.activeExport.phaseText = phaseText;
        this.updateExportProgressDom();
      })
      .then((res) => {
        this.activeExport = null;
        const audioTag =
          res.hasSfx && res.hasBgm
            ? '含音效与 BGM'
            : res.hasBgm
              ? '含 BGM'
              : res.hasSfx
                ? '含音效'
                : '无音轨';
        this.showNotice(
          `✅ 已下载 ${res.filename}（${formatBytes(res.sizeBytes)} · ${res.width}×${res.height} · ${audioTag}）`,
          'ok',
        );
        if (this.openState) this.render();
      })
      .catch((err) => {
        this.activeExport = null;
        if (err instanceof DOMException && err.name === 'AbortError') {
          this.showNotice('已取消 MP4 导出', 'err');
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          this.showNotice(`导出失败：${msg}`, 'err');
        }
        if (this.openState) this.render();
      });
  }

  private renderRow(m: MatchHistorySummary): string {
    const isRanked = m.matchMode === 'ranked-solo' || m.matchMode === 'ranked-ffa';
    const modeLabel =
      m.matchMode === 'ranked-solo'
        ? '⚔️ SOLO 排位'
        : m.matchMode === 'ranked-ffa'
          ? '👑 混战排位'
          : m.matchMode === 'cricket'
            ? `🦗 斗蛐蛐 ${m.slots.length === 2 ? '1v1' : '4P'}`
            : `🎛️ 自定义${Math.abs((m.speed || 1) - 1) > 0.01 ? ` ${m.speed.toFixed(1)}x` : ''}`;
    const modeCls = isRanked ? 'hm-mode-ranked' : m.matchMode === 'cricket' ? 'hm-mode-cricket' : 'hm-mode-custom';

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
    const isExportingThis = this.activeExport?.matchId === m.id;
    const busy = this.loadingReplayId !== null || this.activeExport !== null;
    const exportPct = isExportingThis ? Math.round((this.activeExport?.progress || 0) * 100) : 0;
    const presetLabel = this.getExportPresetLabel();

    const isFav = Boolean(m.favorite);

    return `
      <div class="history-row ${outcomeCls} ${isFav ? 'is-favorite' : ''}" data-history-id="${escapeHtml(m.id)}">
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
              ${busy ? 'disabled' : ''}
            >
              ${isLoadingThis ? '加载中...' : '▶ 回放'}
            </button>
            <button
              type="button"
              class="hm-export-btn ${isExportingThis ? 'is-exporting' : ''}"
              data-export-id="${escapeHtml(m.id)}"
              title="将本局观战回放导出下载为 MP4（当前：${presetLabel}）"
              ${busy ? 'disabled' : ''}
            >
              ${isExportingThis ? `导出 ${exportPct}%` : '⬇ 导出'}
            </button>
            <button
              type="button"
              class="hm-fav-btn ${isFav ? 'is-fav' : ''}"
              data-fav-id="${escapeHtml(m.id)}"
              aria-pressed="${isFav}"
              title="${isFav ? '取消收藏（取消后若超出 50 场上限，将在下一场同模式对局后移除）' : '收藏此对局（永久保留，不受每模式 50 场上限控制）'}"
              aria-label="${isFav ? '取消收藏此对局' : '收藏此对局'}"
              ${busy ? 'disabled' : ''}
            >
              ${renderFavoriteStarSvg(isFav)}
            </button>
            <button
              type="button"
              class="hm-del-btn"
              data-delete-id="${escapeHtml(m.id)}"
              title="删除此条对局记录"
              aria-label="删除此条对局记录"
              ${busy ? 'disabled' : ''}
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
    const visible = this.filteredSummaries();
    const presetLabel = this.getExportPresetLabel();

    this.syncHeaderControls();
    this.syncFilterControls();
    this.exportCfgBtn.textContent = `⚙️ 导出设置：${presetLabel}`;

    let bodyHtml = '';
    if (this.loading && totalCount === 0) {
      bodyHtml = `<div class="history-empty"><div class="he-title">加载对局历史中...</div></div>`;
    } else if (visible.length === 0) {
      const hasAnyFav = this.summaries.some((m) => m.favorite);
      const emptyIcon = this.favoritesOnly ? '★' : '📜';
      const emptyTitle = this.favoritesOnly ? '暂无收藏的对局' : '暂无对局记录';
      const emptyHint =
        totalCount === 0
          ? `完成任意排位赛、斗蛐蛐或自定义对局后，每个模式各自动保存最近 ${MAX_HISTORY_PER_MODE} 场的完整观战回放。`
          : this.favoritesOnly
            ? hasAnyFav && this.filter !== 'all'
              ? '当前模式下暂无收藏的对局，试试切换到「全部」或关闭「只看收藏」。'
              : `点击对局右侧的星标即可永久收藏，不受每模式 ${MAX_HISTORY_PER_MODE} 场上限限制。`
            : '当前筛选条件下暂无对局记录，试试切换到「全部」。';
      bodyHtml = `
        <div class="history-empty">
          <div class="he-icon">${emptyIcon}</div>
          <div class="he-title">${emptyTitle}</div>
          <div class="he-desc">${emptyHint}</div>
        </div>`;
    } else {
      bodyHtml = `<div class="history-list">${visible.map((m) => this.renderRow(m)).join('')}</div>`;
    }

    this.exportSlotEl.classList.toggle('hidden', !this.activeExport);
    this.exportSlotEl.innerHTML = this.activeExport
      ? `
        <div class="history-export-bar">
          <div class="heb-top">
            <div class="heb-info">
              <span class="heb-title">🎬 正在导出《${escapeHtml(this.activeExport.mapTitle)}》MP4 (${escapeHtml(this.activeExport.presetLabel)})</span>
              <span class="heb-phase" id="history-export-phase">${escapeHtml(this.activeExport.phaseText)}</span>
            </div>
            <div class="heb-right">
              <span class="heb-pct" id="history-export-pct">${Math.round(this.activeExport.progress * 100)}%</span>
              <button type="button" class="heb-cancel-btn" id="history-export-cancel">取消</button>
            </div>
          </div>
          <div class="heb-track">
            <div class="heb-fill" id="history-export-fill" style="width:${Math.round(this.activeExport.progress * 100)}%"></div>
          </div>
        </div>`
      : '';
    this.exportSlotEl.querySelector('#history-export-cancel')?.addEventListener('click', () => {
      this.activeExport?.controller.abort();
    });

    this.syncNoticeSlot();

    const prevScrollTop = this.bodyEl.scrollTop;
    this.bodyEl.innerHTML = bodyHtml;
    this.bodyEl.scrollTop = prevScrollTop;

    this.bodyEl.querySelectorAll<HTMLButtonElement>('[data-replay-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.replayId!;
        if (this.loadingReplayId !== null || this.activeExport !== null) return;
        this.loadingReplayId = id;
        this.render();
        Promise.resolve(this.callbacks.onReplay(id)).catch((err) => {
          console.error('Replay launch failed:', err);
          this.loadingReplayId = null;
          if (this.openState) this.render();
        });
      });
    });

    const summaryById = new Map(this.summaries.map((s) => [s.id, s]));
    this.bodyEl.querySelectorAll<HTMLButtonElement>('[data-export-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.exportId!;
        const s = summaryById.get(id);
        if (!s) return;
        this.startExport(s);
      });
    });

    this.bodyEl.querySelectorAll<HTMLButtonElement>('[data-fav-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (this.activeExport) return;
        const id = btn.dataset.favId!;
        const s = summaryById.get(id);
        if (!s) return;
        const nextFav = !s.favorite;
        s.favorite = nextFav;
        this.suppressStoreRefreshCount++;
        void this.store.setFavorite(id, nextFav).then((updated) => {
          if (!updated && this.suppressStoreRefreshCount > 0) {
            this.suppressStoreRefreshCount--;
          }
        });

        if (this.favoritesOnly && !nextFav) {
          this.render();
          return;
        }

        // Update row, star button, header count pill, and filter badges strictly in-place (zero flicker!)
        btn.classList.toggle('is-fav', nextFav);
        btn.setAttribute('aria-pressed', String(nextFav));
        btn.title = nextFav
          ? '取消收藏（取消后若超出 50 场上限，将在下一场同模式对局后移除）'
          : '收藏此对局（永久保留，不受每模式 50 场上限控制）';
        btn.setAttribute('aria-label', nextFav ? '取消收藏此对局' : '收藏此对局');
        btn.innerHTML = renderFavoriteStarSvg(nextFav);
        btn.closest('.history-row')?.classList.toggle('is-favorite', nextFav);
        this.syncHeaderControls();
        this.syncFilterControls();
      });
    });

    this.bodyEl.querySelectorAll<HTMLButtonElement>('[data-delete-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (this.activeExport) return;
        const id = btn.dataset.deleteId!;
        void this.store.deleteMatch(id);
      });
    });
  }
}
