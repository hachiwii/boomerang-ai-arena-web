import {
  CricketBatchBotSummary,
  CricketBatchProgress,
  CricketBatchResult,
  sortBatchBotSummaries,
} from '../game/cricketBatchRunner';
import { CricketFormat } from '../game/cricketStore';

type BatchSortKey = 'winRate' | 'matches' | 'avgRank' | 'kd';

export interface CricketBatchModalCallbacks {
  onOpenCricketHistory: () => void;
  onOpenChange?: (open: boolean) => void;
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c] || c);
}

function formatSec(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export class CricketBatchModal {
  private readonly callbacks: CricketBatchModalCallbacks;
  private readonly backdrop: HTMLDivElement;
  private readonly card: HTMLDivElement;
  private readonly titleEl: HTMLElement;
  private readonly subPillEl: HTMLElement;
  private readonly closeTopBtn: HTMLButtonElement;
  private readonly bodyEl: HTMLDivElement;
  private readonly footerEl: HTMLDivElement;

  private openState = false;
  private running = false;
  private abortController: AbortController | null = null;
  private result: CricketBatchResult | null = null;
  private sortKey: BatchSortKey = 'winRate';
  private sortAsc = false;
  private metaFormat: CricketFormat = '1v1';
  private metaMapPoolCount = 0;
  private metaTotal = 50;

  private readonly handleKeyDown: (e: KeyboardEvent) => void;

  constructor(callbacks: CricketBatchModalCallbacks) {
    this.callbacks = callbacks;

    this.backdrop = document.createElement('div');
    this.backdrop.className = 'cricket-batch-backdrop hidden';

    this.card = document.createElement('div');
    this.card.className = 'cricket-batch-card';
    this.card.setAttribute('role', 'dialog');
    this.card.setAttribute('aria-label', '斗蛐蛐 50 连抽统计');
    this.card.innerHTML = `
      <div class="cbm-head">
        <div class="cbm-head-left">
          <h2 id="cbm-title">🎲 斗蛐蛐 · 50 连抽</h2>
          <span class="cbm-sub-pill" id="cbm-sub-pill"></span>
        </div>
        <button type="button" class="settings-close-btn" id="cbm-close-top">关闭</button>
      </div>
      <div class="cbm-body" id="cbm-body"></div>
      <div class="cbm-footer" id="cbm-footer"></div>
    `;

    this.titleEl = this.card.querySelector<HTMLElement>('#cbm-title')!;
    this.subPillEl = this.card.querySelector<HTMLElement>('#cbm-sub-pill')!;
    this.closeTopBtn = this.card.querySelector<HTMLButtonElement>('#cbm-close-top')!;
    this.bodyEl = this.card.querySelector<HTMLDivElement>('#cbm-body')!;
    this.footerEl = this.card.querySelector<HTMLDivElement>('#cbm-footer')!;

    this.backdrop.appendChild(this.card);
    document.body.appendChild(this.backdrop);

    this.backdrop.addEventListener('click', (e) => {
      if (e.target === this.backdrop && !this.running) {
        this.close();
      }
    });

    this.closeTopBtn.addEventListener('click', () => {
      if (!this.running) this.close();
    });

    this.handleKeyDown = (e: KeyboardEvent) => {
      if (!this.openState) return;
      if (e.code === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (!this.running) this.close();
      }
    };
    window.addEventListener('keydown', this.handleKeyDown);
  }

  public isOpen(): boolean {
    return this.openState;
  }

  public isRunning(): boolean {
    return this.running;
  }

  public openRunning(opts: { total: number; format: CricketFormat; mapPoolCount: number; abortController: AbortController }) {
    this.openState = true;
    this.running = true;
    this.abortController = opts.abortController;
    this.result = null;
    this.metaTotal = opts.total;
    this.metaFormat = opts.format;
    this.metaMapPoolCount = opts.mapPoolCount;
    this.sortKey = 'winRate';
    this.sortAsc = false;

    const fmtLabel = opts.format === '1v1' ? '⚔️ 1v1' : '👑 4人混战';
    this.titleEl.textContent = `🎲 ${opts.total} 连抽模拟中...`;
    this.subPillEl.textContent = `${fmtLabel} · ${opts.mapPoolCount} 张图`;
    this.closeTopBtn.classList.add('hidden');

    this.bodyEl.innerHTML = `
      <div class="cbm-progress-wrap">
        <div class="cbm-progress-top">
          <span class="cbm-progress-count" id="cbm-prog-count">已完成 0 / ${opts.total} 场</span>
          <span class="cbm-progress-pct" id="cbm-prog-pct">0%</span>
        </div>
        <div class="cbm-progress-track">
          <div class="cbm-progress-fill" id="cbm-prog-fill" style="width:0%"></div>
        </div>
        <div class="cbm-progress-meta" id="cbm-prog-meta">正在初始化后台模拟引擎...</div>
      </div>
      <div class="cbm-live-preview" id="cbm-live-preview">
        <div class="cbm-live-hint">后台多路 WASM 并发推演中，每场完整回放将自动写入「对局历史 · 斗蛐蛐」</div>
      </div>
    `;

    this.footerEl.innerHTML = `
      <button type="button" class="cbm-btn cbm-btn-danger" id="cbm-cancel-btn">中止模拟</button>
    `;
    this.footerEl.querySelector<HTMLButtonElement>('#cbm-cancel-btn')?.addEventListener('click', () => {
      const btn = this.footerEl.querySelector<HTMLButtonElement>('#cbm-cancel-btn');
      if (btn) {
        btn.disabled = true;
        btn.textContent = '正在中止并保存已完成对局...';
      }
      this.abortController?.abort();
    });

    this.backdrop.classList.remove('hidden');
    this.callbacks.onOpenChange?.(true);
  }

  public updateProgress(p: CricketBatchProgress) {
    if (!this.openState || !this.running) return;
    const pct = Math.max(0, Math.min(100, Math.round((p.completed / Math.max(1, p.total)) * 100)));
    const countEl = this.bodyEl.querySelector<HTMLElement>('#cbm-prog-count');
    const pctEl = this.bodyEl.querySelector<HTMLElement>('#cbm-prog-pct');
    const fillEl = this.bodyEl.querySelector<HTMLElement>('#cbm-prog-fill');
    const metaEl = this.bodyEl.querySelector<HTMLElement>('#cbm-prog-meta');
    const liveEl = this.bodyEl.querySelector<HTMLElement>('#cbm-live-preview');

    if (countEl) countEl.textContent = `已完成 ${p.completed} / ${p.total} 场`;
    if (pctEl) pctEl.textContent = `${pct}%`;
    if (fillEl) fillEl.style.width = `${pct}%`;
    if (metaEl) {
      const avgPerMatch = p.completed > 0 ? p.elapsedMs / p.completed : 0;
      const remainMs = Math.max(0, avgPerMatch * (p.total - p.completed));
      const latestText = p.latestWinnerName
        ? `最近完成：《${p.latestMapTitle}》 · ${p.latestWinnerName} 胜`
        : `最近完成：《${p.latestMapTitle}》 · 平局`;
      metaEl.textContent = `${latestText} · 已耗时 ${formatSec(p.elapsedMs)}${p.completed < p.total && p.completed >= 2 ? ` · 预计剩余 ${formatSec(remainMs)}` : ''}`;
    }

    if (liveEl && p.bots.length > 0) {
      const top = p.bots.slice(0, 6);
      liveEl.innerHTML = `
        <div class="cbm-live-title">实时胜率领先</div>
        <div class="cbm-live-chips">
          ${top
            .map(
              (b, idx) => `
            <div class="cbm-live-chip">
              <span class="cbm-live-rank">#${idx + 1}</span>
              <img class="cbm-av-sm" src="${b.avatar || ''}" alt="" style="border-color:${b.color}" />
              <span class="cbm-live-name">${escapeHtml(b.displayName)}</span>
              <span class="cbm-live-val">${(b.winRate * 100).toFixed(0)}%</span>
              <span class="cbm-live-sub">${b.wins}/${b.matches}</span>
            </div>`,
            )
            .join('')}
        </div>
      `;
    }
  }

  public showResult(result: CricketBatchResult) {
    this.running = false;
    this.abortController = null;
    this.result = result;
    this.openState = true;
    this.closeTopBtn.classList.remove('hidden');

    const fmtLabel = result.format === '1v1' ? '⚔️ 1v1' : '👑 4人混战';
    this.titleEl.textContent = result.cancelled
      ? `⏹ 已中止 · 完成 ${result.completedMatches} / ${result.requestedTotal} 场`
      : `🏆 ${result.completedMatches} 连抽统计结果`;
    const drawText = result.draws > 0 ? ` · 平局 ${result.draws} 场` : '';
    this.subPillEl.textContent = `${fmtLabel} · ${result.mapPoolCount} 张图${drawText} · 耗时 ${formatSec(result.elapsedMs)}`;

    this.renderResultBody();
    this.footerEl.innerHTML = `
      <span class="cbm-footer-note">已保存全部 ${result.completedMatches} 场回放并更新斗蛐蛐战绩</span>
      <div class="cbm-footer-actions">
        <button type="button" class="cbm-btn cbm-btn-secondary" id="cbm-close-btn">关闭</button>
        <button type="button" class="cbm-btn cbm-btn-primary" id="cbm-go-history-btn">📜 前往对局历史 · 斗蛐蛐</button>
      </div>
    `;

    this.footerEl.querySelector('#cbm-close-btn')?.addEventListener('click', () => {
      this.close();
    });
    this.footerEl.querySelector('#cbm-go-history-btn')?.addEventListener('click', () => {
      this.close();
      this.callbacks.onOpenCricketHistory();
    });

    this.backdrop.classList.remove('hidden');
  }

  public showError(message: string) {
    this.running = false;
    this.abortController = null;
    this.closeTopBtn.classList.remove('hidden');
    const fmtLabel = this.metaFormat === '1v1' ? '⚔️ 1v1' : '👑 4人混战';
    this.titleEl.textContent = `❌ ${this.metaTotal} 连抽模拟失败`;
    this.subPillEl.textContent = `${fmtLabel} · ${this.metaMapPoolCount} 张图`;
    this.bodyEl.innerHTML = `
      <div class="cbm-error-box">${escapeHtml(message)}</div>
    `;
    this.footerEl.innerHTML = `
      <div class="cbm-footer-actions">
        <button type="button" class="cbm-btn cbm-btn-secondary" id="cbm-close-btn">关闭</button>
      </div>
    `;
    this.footerEl.querySelector('#cbm-close-btn')?.addEventListener('click', () => {
      this.close();
    });
  }

  public close() {
    if (!this.openState) return;
    if (this.running) {
      this.abortController?.abort();
      this.running = false;
      this.abortController = null;
    }
    this.openState = false;
    this.backdrop.classList.add('hidden');
    this.callbacks.onOpenChange?.(false);
  }

  private getSortedBots(bots: CricketBatchBotSummary[]): CricketBatchBotSummary[] {
    if (this.sortKey === 'winRate' && !this.sortAsc) {
      return sortBatchBotSummaries(bots);
    }
    const dir = this.sortAsc ? 1 : -1;
    return [...bots].sort((a, b) => {
      let diff = 0;
      if (this.sortKey === 'winRate') diff = a.winRate - b.winRate;
      else if (this.sortKey === 'matches') diff = a.matches - b.matches;
      else if (this.sortKey === 'avgRank') diff = a.avgRank - b.avgRank;
      else if (this.sortKey === 'kd') diff = a.kd - b.kd;
      if (Math.abs(diff) > 1e-9) return diff * dir;
      return b.winRate - a.winRate || a.avgRank - b.avgRank || b.kd - a.kd;
    });
  }

  private renderResultBody() {
    if (!this.result) return;
    const rows = this.getSortedBots(this.result.bots);
    if (rows.length === 0) {
      this.bodyEl.innerHTML = `<div class="cbm-empty">未完成任何对局。</div>`;
      return;
    }

    const th = (key: BatchSortKey, label: string, alignRight = true) => {
      const active = this.sortKey === key;
      const arrow = active ? (this.sortAsc ? ' ▲' : ' ▼') : '';
      return `<th class="${alignRight ? 'num' : ''} is-sortable ${active ? 'is-sorted' : ''}" data-cbm-sort="${key}">${label}<span class="cbm-sort-arrow">${arrow}</span></th>`;
    };

    this.bodyEl.innerHTML = `
      <div class="cbm-table-scroll">
        <table class="cbm-table">
          <thead>
            <tr>
              <th class="col-rank">#</th>
              <th class="col-bot">角色</th>
              ${th('matches', '登场次数')}
              ${th('winRate', '胜率')}
              ${th('avgRank', '平均名次')}
              ${th('kd', 'KD')}
            </tr>
          </thead>
          <tbody>
            ${rows
              .map((b, idx) => {
                const winPct = (b.winRate * 100).toFixed(1);
                const rankCls = idx === 0 ? 'is-gold' : idx === 1 ? 'is-silver' : idx === 2 ? 'is-bronze' : '';
                return `
                  <tr class="cbm-row ${rankCls}">
                    <td class="col-rank"><span class="cbm-rank-badge ${rankCls}">${idx + 1}</span></td>
                    <td class="col-bot">
                      <div class="cbm-bot-cell">
                        <img class="cbm-av" src="${b.avatar || ''}" alt="" style="border-color:${b.color}" />
                        <span class="cbm-bot-name">${escapeHtml(b.displayName)}</span>
                      </div>
                    </td>
                    <td class="num cbm-matches"><strong>${b.matches}</strong> <span class="cbm-sub">场</span></td>
                    <td class="num cbm-winrate">
                      <div class="cbm-wr-wrap">
                        <div class="cbm-wr-top">
                          <strong>${winPct}%</strong>
                          <span class="cbm-sub">${b.wins}胜</span>
                        </div>
                        <div class="cbm-wr-bar"><span style="width:${Math.min(100, Math.round(b.winRate * 100))}%"></span></div>
                      </div>
                    </td>
                    <td class="num cbm-avgrank"><strong>#${b.avgRank.toFixed(2)}</strong></td>
                    <td class="num cbm-kd">
                      <strong>${b.kd.toFixed(2)}</strong>
                      <span class="cbm-sub">${b.kills}/${b.deaths}</span>
                    </td>
                  </tr>`;
              })
              .join('')}
          </tbody>
        </table>
      </div>
    `;

    this.bodyEl.querySelectorAll<HTMLElement>('[data-cbm-sort]').forEach((el) => {
      el.addEventListener('click', () => {
        const key = el.dataset.cbmSort as BatchSortKey;
        if (this.sortKey === key) {
          this.sortAsc = !this.sortAsc;
        } else {
          this.sortKey = key;
          // Average rank defaults to ascending (lower rank is better); all others default descending
          this.sortAsc = key === 'avgRank';
        }
        this.renderResultBody();
      });
    });
  }
}
