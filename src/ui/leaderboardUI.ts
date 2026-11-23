import { LeaderboardRow, LeaderboardStore, ModeStats } from '../game/leaderboard';
import { RankedMode } from '../game/types';

type SortField = 'rating' | 'wr' | 'kills' | 'deaths' | 'kd';

function fmtWinRate(s: ModeStats): string {
  if (s.games === 0) return `<span class="lb-empty">—</span>`;
  const pct = ((s.wins + 0.5 * s.draws) / s.games) * 100;
  const sub = s.draws > 0 ? `${s.wins}胜${s.draws}平/${s.games}` : `${s.wins}/${s.games}`;
  return `<span class="lb-wr-pct">${pct.toFixed(1)}%</span><span class="lb-wr-sub">${sub}</span>`;
}

function fmtKd(row: LeaderboardRow): string {
  if (row.kd === null) return `<span class="lb-empty">—</span>`;
  if (row.stats.deaths === 0) {
    return row.stats.kills > 0 ? `<span class="lb-kd-inf">${row.stats.kills.toFixed(2)}</span>` : '0.00';
  }
  return row.kd.toFixed(2);
}

export class LeaderboardPanel {
  private readonly store: LeaderboardStore;
  private readonly tooltip: HTMLDivElement;
  private activeContainer: HTMLElement | null = null;
  private mode: RankedMode = 'solo';
  private sortBy: SortField = 'rating';
  private confirmReset = false;
  private confirmTimer: number | null = null;
  private toastText: string | null = null;
  private toastTimer: number | null = null;
  private onChanged?: () => void;
  private onModeChange?: (mode: RankedMode) => void;
  private onClose?: () => void;

  constructor(
    store: LeaderboardStore,
    callbacks: {
      onChanged?: () => void;
      onModeChange?: (mode: RankedMode) => void;
      onClose?: () => void;
    } = {},
  ) {
    this.store = store;
    this.onChanged = callbacks.onChanged;
    this.onModeChange = callbacks.onModeChange;
    this.onClose = callbacks.onClose;

    this.tooltip = document.createElement('div');
    this.tooltip.className = 'lb-tooltip hidden';
    document.body.appendChild(this.tooltip);
  }

  public setMode(mode: RankedMode) {
    this.mode = mode;
  }

  public hideTooltip() {
    this.tooltip.classList.add('hidden');
  }

  private showTooltip(row: LeaderboardRow, clientX: number, clientY: number) {
    const s = row.stats;
    const modeLabel = this.mode === 'solo' ? 'SOLO' : '四人混战';
    const refLine = row.isHuman
      ? `<div class="lb-tt-ref">${modeLabel} 排位分 · 初始 500 / 下限 0</div>`
      : `<div class="lb-tt-ref">${modeLabel} 基准分 · 固定不变</div>`;

    this.tooltip.innerHTML = `
      <div class="lb-tt-head">
        <img class="lb-tt-av" src="${row.avatar || ''}" alt="" />
        <div>
          <div class="lb-tt-name">${row.name}</div>
          ${refLine}
        </div>
      </div>
      <div class="lb-tt-grid">
        <div class="lb-tt-item">
          <span class="lb-tt-label">飞镖击杀</span>
          <strong class="lb-tt-val">${s.dartKills}</strong>
        </div>
        <div class="lb-tt-item">
          <span class="lb-tt-label">近战击杀</span>
          <strong class="lb-tt-val">${s.meleeKills}</strong>
        </div>
        <div class="lb-tt-item">
          <span class="lb-tt-label">地形击杀</span>
          <strong class="lb-tt-val">${s.terrainKills}</strong>
        </div>
        <div class="lb-tt-item">
          <span class="lb-tt-label">坠崖次数</span>
          <strong class="lb-tt-val lb-tt-fall">${s.cliffFalls}</strong>
        </div>
      </div>
      <div class="lb-tt-foot">
        ${modeLabel} 累计 ${s.games} 场
      </div>
    `;
    this.tooltip.classList.remove('hidden');
    this.positionTooltip(clientX, clientY);
  }

  private positionTooltip(clientX: number, clientY: number) {
    const pad = 14;
    const rect = this.tooltip.getBoundingClientRect();
    let left = clientX + 16;
    let top = clientY + 14;
    if (left + rect.width > window.innerWidth - pad) {
      left = Math.max(pad, clientX - rect.width - 16);
    }
    if (top + rect.height > window.innerHeight - pad) {
      top = Math.max(pad, clientY - rect.height - 14);
    }
    this.tooltip.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
  }

  public renderInto(container: HTMLElement) {
    this.activeContainer = container;
    this.hideTooltip();
    const prevScrollTop = container.querySelector<HTMLElement>('.lb-table-scroll')?.scrollTop ?? 0;
    const rows = this.store.getRows(this.mode, this.sortBy);
    const rowById = new Map(rows.map((r) => [r.id, r]));

    const sortHead = (field: SortField, label: string) =>
      `<th class="lb-sortable ${this.sortBy === field ? 'active' : ''}" data-sort="${field}">${label}${this.sortBy === field ? ' ↓' : ''}</th>`;

    const wrLabel = this.mode === 'solo' ? 'SOLO 胜率' : '混战胜率';
    const peak = this.store.getHumanPeak(this.mode);

    container.innerHTML = `
      <div class="lb-wrap">
        <div class="lb-toolbar">
          <div class="lb-left-tools">
            ${this.onClose ? `<button type="button" class="lb-back-btn" id="lb-back-btn">← 返回排位</button>` : ''}
            <div class="lb-mode-seg">
              <button type="button" class="lb-mode-btn ${this.mode === 'solo' ? 'active' : ''}" data-lb-mode="solo">⚔️ SOLO 榜</button>
              <button type="button" class="lb-mode-btn ${this.mode === 'ffa' ? 'active' : ''}" data-lb-mode="ffa">👑 四人混战榜</button>
            </div>
            <div class="lb-peak-pill" id="lb-peak-pill" title="当前模式历史最高 ELO 与对应名次">
              <span class="lb-peak-label">🏅 历史最高 ELO</span>
              <strong class="lb-peak-elo">${peak.rating}</strong>
              <span class="lb-peak-sep">·</span>
              <span class="lb-peak-rank">#${peak.rank}<span> / ${peak.total}</span></span>
            </div>
          </div>
          <div class="lb-toolbar-btns">
            ${
              this.confirmReset
                ? `<button class="lb-reset-btn confirm" id="lb-reset-confirm">确认重置统计数据？</button>
                   <button class="lb-tool-btn" id="lb-reset-cancel">取消</button>`
                : `<button class="lb-reset-btn" id="lb-reset-btn">重置统计数据（保留分数）</button>`
            }
          </div>
        </div>

        ${this.toastText ? `<div class="lb-toast">${this.toastText}</div>` : ''}

        <div class="lb-table-scroll">
          <table class="lb-table">
            <thead>
              <tr>
                <th class="col-rank">排名</th>
                <th class="col-name">选手</th>
                ${sortHead('rating', 'Elo 分数')}
                ${sortHead('wr', wrLabel)}
                ${sortHead('kills', '总击杀')}
                ${sortHead('deaths', '死亡')}
                ${sortHead('kd', 'KD')}
              </tr>
            </thead>
            <tbody>
              ${rows
                .map((r, idx) => {
                  const displayRank = this.sortBy === 'rating' ? r.eloRank : idx + 1;
                  const rankCls =
                    displayRank === 1 ? 'rk-1' : displayRank === 2 ? 'rk-2' : displayRank === 3 ? 'rk-3' : '';
                  const tagHtml = r.isHuman
                    ? `<span class="lb-tag tag-human">真人</span>`
                    : `<span class="lb-tag tag-official">AI</span>`;
                  return `
                  <tr class="lb-row ${r.isHuman ? 'is-human' : ''}" data-row-id="${r.id}">
                    <td class="col-rank"><span class="lb-rank ${rankCls}">#${displayRank}</span></td>
                    <td class="col-name">
                      <div class="lb-player-cell">
                        <img class="lb-avatar" src="${r.avatar || ''}" alt="" />
                        <span class="lb-pname">${r.name}</span>
                        ${tagHtml}
                      </div>
                    </td>
                    <td class="col-elo">
                      <span class="lb-elo ${r.isHuman ? 'elo-human' : 'elo-bot'}">${r.rating}</span>
                    </td>
                    <td class="col-wr">${fmtWinRate(r.stats)}</td>
                    <td class="col-num">${r.stats.kills}</td>
                    <td class="col-num">${r.stats.deaths}</td>
                    <td class="col-num col-kd">${fmtKd(r)}</td>
                  </tr>`;
                })
                .join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;

    const scrollEl = container.querySelector<HTMLElement>('.lb-table-scroll');
    if (scrollEl && prevScrollTop > 0) {
      scrollEl.scrollTop = prevScrollTop;
    }

    container.querySelector('#lb-back-btn')?.addEventListener('click', () => {
      this.hideTooltip();
      this.onClose?.();
    });

    container.querySelectorAll<HTMLButtonElement>('.lb-mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const nextMode = btn.dataset.lbMode as RankedMode;
        if (nextMode === this.mode) return;
        this.mode = nextMode;
        this.onModeChange?.(nextMode);
        this.renderInto(container);
      });
    });

    container.querySelectorAll<HTMLElement>('th.lb-sortable').forEach((th) => {
      th.addEventListener('click', () => {
        this.sortBy = th.dataset.sort as SortField;
        this.renderInto(container);
      });
    });

    container.querySelector('#lb-reset-btn')?.addEventListener('click', () => {
      this.confirmReset = true;
      if (this.confirmTimer !== null) window.clearTimeout(this.confirmTimer);
      this.confirmTimer = window.setTimeout(() => {
        this.confirmReset = false;
        this.confirmTimer = null;
        if (this.activeContainer?.isConnected) this.renderInto(this.activeContainer);
      }, 5000);
      this.renderInto(container);
    });

    container.querySelector('#lb-reset-cancel')?.addEventListener('click', () => {
      this.confirmReset = false;
      if (this.confirmTimer !== null) window.clearTimeout(this.confirmTimer);
      this.renderInto(container);
    });

    container.querySelector('#lb-reset-confirm')?.addEventListener('click', () => {
      this.confirmReset = false;
      if (this.confirmTimer !== null) window.clearTimeout(this.confirmTimer);
      this.store.resetStatsOnly();
      this.toastText = '已清空所有胜率与 KD 统计数据（当前及历史最高 ELO 分数已保留）';
      if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
      this.toastTimer = window.setTimeout(() => {
        this.toastText = null;
        this.toastTimer = null;
        if (this.activeContainer?.isConnected) this.renderInto(this.activeContainer);
      }, 3500);
      if (this.onChanged) {
        this.onChanged();
      } else {
        this.renderInto(container);
      }
    });

    container.querySelectorAll<HTMLTableRowElement>('tr.lb-row').forEach((tr) => {
      const id = tr.dataset.rowId!;
      const row = rowById.get(id);
      if (!row) return;
      tr.addEventListener('mouseenter', (ev) => {
        this.showTooltip(row, ev.clientX, ev.clientY);
      });
      tr.addEventListener('mousemove', (ev) => {
        if (!this.tooltip.classList.contains('hidden')) {
          this.positionTooltip(ev.clientX, ev.clientY);
        }
      });
      tr.addEventListener('mouseleave', () => {
        this.hideTooltip();
      });
    });
  }
}
