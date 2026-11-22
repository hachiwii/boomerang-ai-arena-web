import { LeaderboardRow, LeaderboardStore, ModeRecord } from '../game/leaderboard';
import { makeHoodieAvatarDataUrl } from './lobbyUI';

type SortField = 'rating' | 'wr2' | 'wr3' | 'wr4' | 'kills' | 'deaths' | 'kd';

function fmtElo(v: number): string {
  const r = Math.round(v * 10) / 10;
  if (r > 0) return `+${r.toFixed(1)}`;
  return r.toFixed(1);
}

function fmtWinRate(m: ModeRecord): string {
  if (m.games === 0) return `<span class="lb-empty">—</span>`;
  const pct = ((m.wins + 0.5 * m.draws) / m.games) * 100;
  const sub = m.draws > 0 ? `${m.wins}胜${m.draws}平/${m.games}` : `${m.wins}/${m.games}`;
  return `<span class="lb-wr-pct">${pct.toFixed(1)}%</span><span class="lb-wr-sub">${sub}</span>`;
}

function fmtKd(row: LeaderboardRow): string {
  if (row.kd === null) return `<span class="lb-empty">—</span>`;
  if (row.stats.deaths === 0) {
    return row.stats.kills > 0 ? `<span class="lb-kd-inf">${row.stats.kills.toFixed(2)}</span>` : '0.00';
  }
  return row.kd.toFixed(2);
}

function avatarForRow(row: LeaderboardRow): string {
  if (row.avatar) return row.avatar;
  if (row.id === 'sparring-strong') return makeHoodieAvatarDataUrl('#E8483D', '#4A3328');
  if (row.id === 'sparring-mid') return makeHoodieAvatarDataUrl('#E89A2E', '#3D3028');
  return makeHoodieAvatarDataUrl('#4AB87A', '#4D423A');
}

export class LeaderboardPanel {
  private readonly store: LeaderboardStore;
  private readonly tooltip: HTMLDivElement;
  private sortBy: SortField = 'rating';
  private includeSparring = true;
  private confirmReset = false;
  private confirmTimer: number | null = null;
  private toastText: string | null = null;
  private toastTimer: number | null = null;
  private onChanged?: () => void;

  constructor(store: LeaderboardStore, onChanged?: () => void) {
    this.store = store;
    this.onChanged = onChanged;

    this.tooltip = document.createElement('div');
    this.tooltip.className = 'lb-tooltip hidden';
    document.body.appendChild(this.tooltip);
  }

  public hideTooltip() {
    this.tooltip.classList.add('hidden');
  }

  private showTooltip(row: LeaderboardRow, clientX: number, clientY: number) {
    const s = row.stats;
    const totalGames = s.mode2.games + s.mode3.games + s.mode4.games;
    const refLine =
      row.duelRating !== null && row.ffaRating !== null
        ? `<div class="lb-tt-ref">官方分项 · 1v1 ${fmtElo(row.duelRating)} / 四人局 ${fmtElo(row.ffaRating)}</div>`
        : row.isHuman
          ? `<div class="lb-tt-ref">动态 Elo · 仅人类参战局结算更新</div>`
          : `<div class="lb-tt-ref">陪练基准分 · 固定不变</div>`;

    this.tooltip.innerHTML = `
      <div class="lb-tt-head">
        <img class="lb-tt-av" src="${avatarForRow(row)}" alt="" />
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
        累计 ${totalGames} 场（2人 ${s.mode2.games} · 3人 ${s.mode3.games} · 4人 ${s.mode4.games}）
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
    this.hideTooltip();
    const rows = this.store.getRows(this.sortBy, this.includeSparring);
    const rowById = new Map(rows.map((r) => [r.id, r]));

    const sortHead = (field: SortField, label: string) =>
      `<th class="lb-sortable ${this.sortBy === field ? 'active' : ''}" data-sort="${field}">${label}${this.sortBy === field ? ' ↓' : ''}</th>`;

    container.innerHTML = `
      <div class="lb-wrap">
        <div class="lb-toolbar">
          <div class="lb-note">
            <span>人类初始 <strong>0.0</strong> 分，有人类参战的对局按 Elo (K=32) 更新人类分数；Bot 分数始终固定自官方海选榜。悬停任意行查看详细击杀与坠崖统计。</span>
          </div>
          <div class="lb-toolbar-btns">
            <button class="lb-tool-btn ${this.includeSparring ? 'active' : ''}" id="lb-toggle-sparring">
              ${this.includeSparring ? '显示全部 (含陪练)' : '仅看正式榜 (人类+13 AI)'}
            </button>
            ${
              this.confirmReset
                ? `<button class="lb-reset-btn confirm" id="lb-reset-confirm">确认重置全部战绩？</button>
                   <button class="lb-tool-btn" id="lb-reset-cancel">取消</button>`
                : `<button class="lb-reset-btn" id="lb-reset-btn">重置所有数据（保留 Bot 分数）</button>`
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
                ${sortHead('wr2', '2人胜率')}
                ${sortHead('wr3', '3人胜率')}
                ${sortHead('wr4', '4人胜率')}
                ${sortHead('kills', '总击杀')}
                ${sortHead('deaths', '死亡')}
                ${sortHead('kd', 'KD')}
              </tr>
            </thead>
            <tbody>
              ${rows
                .map((r, idx) => {
                  const rankNum = idx + 1;
                  const rankCls =
                    rankNum === 1 ? 'rk-1' : rankNum === 2 ? 'rk-2' : rankNum === 3 ? 'rk-3' : '';
                  const tagHtml = r.isHuman
                    ? `<span class="lb-tag tag-human">真人</span>`
                    : r.category === 'official'
                      ? `<span class="lb-tag tag-official">官方AI</span>`
                      : `<span class="lb-tag tag-sparring">陪练</span>`;
                  const eloCls = r.rating > 0 ? 'elo-pos' : r.rating < 0 ? 'elo-neg' : 'elo-zero';
                  return `
                  <tr class="lb-row ${r.isHuman ? 'is-human' : ''}" data-row-id="${r.id}">
                    <td class="col-rank"><span class="lb-rank ${rankCls}">#${rankNum}</span></td>
                    <td class="col-name">
                      <div class="lb-player-cell">
                        <img class="lb-avatar" src="${avatarForRow(r)}" alt="" />
                        <span class="lb-pname">${r.name}</span>
                        ${tagHtml}
                      </div>
                    </td>
                    <td class="col-elo">
                      <span class="lb-elo ${eloCls}">${fmtElo(r.rating)}</span>
                      <span class="lb-elo-lock">${r.isHuman ? '动态' : '固定'}</span>
                    </td>
                    <td class="col-wr">${fmtWinRate(r.stats.mode2)}</td>
                    <td class="col-wr">${fmtWinRate(r.stats.mode3)}</td>
                    <td class="col-wr">${fmtWinRate(r.stats.mode4)}</td>
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

    // Bind sorting
    container.querySelectorAll<HTMLElement>('th.lb-sortable').forEach((th) => {
      th.addEventListener('click', () => {
        this.sortBy = th.dataset.sort as SortField;
        this.renderInto(container);
      });
    });

    // Bind filter toggle
    container.querySelector('#lb-toggle-sparring')?.addEventListener('click', () => {
      this.includeSparring = !this.includeSparring;
      this.renderInto(container);
    });

    // Bind 2-step reset button (clears all stats & human Elo back to 0, keeps bot Elo fixed!)
    container.querySelector('#lb-reset-btn')?.addEventListener('click', () => {
      this.confirmReset = true;
      if (this.confirmTimer !== null) window.clearTimeout(this.confirmTimer);
      this.confirmTimer = window.setTimeout(() => {
        this.confirmReset = false;
        this.renderInto(container);
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
      this.store.resetAllStats();
      this.toastText = '已重置所有胜率、击杀、死亡、坠崖记录及人类分数（Bot 分数已保留）';
      if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
      this.toastTimer = window.setTimeout(() => {
        this.toastText = null;
        this.renderInto(container);
      }, 3500);
      this.onChanged?.();
      this.renderInto(container);
    });

    // Bind crisp hover tooltips on every leaderboard row
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
