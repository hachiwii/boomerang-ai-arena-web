// 全球统计: a lobby panel with the live online count, all-time and last-24-hour match counts (per-mode breakdown on
// hover, or on tap on mobile) and a horizontally scrollable table of every ranked bot's record, SOLO / 四人 switchable.
// Data: GET /public-stats on the relay (src/net/publicStats.ts).
import type { RosterEntry } from '../game/types';
import {
  DEATH_CAUSES,
  fetchPublicStats,
  formatCount,
  KILL_CAUSES,
  PUBLIC_MODES,
  sumModes,
  type BotTally,
  type PublicMode,
  type PublicStats,
} from '../net/publicStats';

const MODE_LABEL: Record<PublicMode, string> = {
  'ranked-solo': '排位 SOLO',
  'ranked-ffa': '排位四人',
  cricket: '斗蛐蛐',
  custom: '自定义',
  pvp: 'PvP',
};
const CAUSE_LABEL = { melee: '近战', dart: '飞镖', kick: '踢下悬崖', fall: '自己坠崖', collapse: '坍塌坠落' } as const;
const REFRESH_MS = 30_000;

type RankedMode = 'ranked-solo' | 'ranked-ffa';
type SortKey =
  | 'games' | 'winRate' | 'kd' | 'w' | 'd' | 'l' | 'kills' | 'deaths'
  | `k:${(typeof KILL_CAUSES)[number]}` | `d:${(typeof DEATH_CAUSES)[number]}`;

interface Row {
  id: string;
  name: string;
  fullName: string;
  avatar: string | null;
  color: string;
  t: BotTally;
  games: number;
  kills: number;
  deaths: number;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const fmt = formatCount;
const sumOf = (o: Partial<Record<string, number>>) => Object.values(o).reduce<number>((a, n) => a + (n ?? 0), 0);

function winRate(r: Row): number {
  return r.games ? r.t.w / r.games : -1;
}

function kd(r: Row): number {
  if (r.deaths) return r.kills / r.deaths;
  return r.kills ? Number.POSITIVE_INFINITY : -1;
}

function sortValue(r: Row, key: SortKey): number {
  switch (key) {
    case 'games': return r.games;
    case 'winRate': return winRate(r);
    case 'kd': return kd(r);
    case 'w': case 'd': case 'l': return r.t[key];
    case 'kills': return r.kills;
    case 'deaths': return r.deaths;
    default: {
      const [side, c] = key.split(':') as ['k' | 'd', string];
      return (side === 'k' ? r.t.kills : r.t.deaths)[c as never] ?? 0;
    }
  }
}

/** "2026-11-27" → "2026/11/27" */
const slashDate = (day: string) => day.replace(/-/g, '/');

/** Hour of an ISO time in UTC+8, "HH:00" */
function hourLabel(iso: string): string {
  const d = new Date(Date.parse(iso) + 8 * 3_600_000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:00`;
}

export class GlobalStatsPanel {
  private readonly backdrop: HTMLDivElement;
  private readonly card: HTMLDivElement;
  private readonly bodyEl: HTMLDivElement;
  private openState = false;
  private stats: PublicStats | null = null;
  private error = false;
  private mode: RankedMode = 'ranked-solo';
  private sort: { key: SortKey; desc: boolean } = { key: 'games', desc: true };
  private refreshTimer: number | null = null;
  private abort: AbortController | null = null;
  private openTile: string | null = null;
  private tableScrollLeft = 0;

  constructor(private readonly getRoster: () => RosterEntry[]) {
    this.backdrop = document.createElement('div');
    this.backdrop.className = 'gs-backdrop hidden';
    this.card = document.createElement('div');
    this.card.className = 'gs-card';
    this.card.setAttribute('role', 'dialog');
    this.card.setAttribute('aria-label', '全球统计');
    this.card.innerHTML = `
      <div class="gs-head">
        <h2><span class="gs-head-ico" aria-hidden="true">🌐</span> 全球统计</h2>
        <button type="button" class="settings-close-btn" data-gs-close>返回</button>
      </div>
      <div class="gs-body"></div>
    `;
    this.bodyEl = this.card.querySelector('.gs-body')!;
    this.backdrop.appendChild(this.card);
    document.body.appendChild(this.backdrop);

    this.backdrop.addEventListener('click', (e) => {
      if (e.target === this.backdrop) this.close();
    });
    this.card.querySelector('[data-gs-close]')!.addEventListener('click', () => this.close());
    // Tap a match tile (mobile) toggles its breakdown; tapping anywhere else closes it
    this.card.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const tile = target.closest<HTMLElement>('[data-gs-tile]');
      const seg = target.closest<HTMLElement>('[data-gs-mode]');
      const th = target.closest<HTMLElement>('[data-gs-sort]');
      if (tile) {
        const key = tile.dataset.gsTile!;
        this.openTile = this.openTile === key ? null : key;
        this.syncOpenTile();
        return;
      }
      if (this.openTile) {
        this.openTile = null;
        this.syncOpenTile();
      }
      if (seg) {
        const mode = seg.dataset.gsMode as RankedMode;
        if (mode !== this.mode) {
          this.mode = mode;
          this.tableScrollLeft = 0;
          this.render();
        }
      } else if (th) {
        const key = th.dataset.gsSort as SortKey;
        this.sort = this.sort.key === key ? { key, desc: !this.sort.desc } : { key, desc: true };
        this.render();
      } else if (target.closest('[data-gs-retry]')) {
        void this.load();
      }
    });
    window.addEventListener(
      'keydown',
      (e) => {
        if (this.openState && e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          this.close();
        }
      },
      { capture: true },
    );
  }

  public isOpen(): boolean {
    return this.openState;
  }

  public open() {
    if (this.openState) return;
    this.openState = true;
    this.openTile = null;
    this.backdrop.classList.remove('hidden');
    this.render();
    void this.load();
    this.refreshTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void this.load();
    }, REFRESH_MS);
  }

  public close() {
    if (!this.openState) return;
    this.openState = false;
    this.backdrop.classList.add('hidden');
    if (this.refreshTimer !== null) window.clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    this.abort?.abort();
    this.abort = null;
  }

  private async load() {
    this.abort?.abort();
    const ctrl = (this.abort = new AbortController());
    try {
      const stats = await fetchPublicStats(ctrl.signal);
      if (ctrl.signal.aborted || !this.openState) return;
      this.stats = stats;
      this.error = false;
    } catch {
      if (ctrl.signal.aborted || !this.openState) return;
      this.error = true;
    }
    this.render();
  }

  private syncOpenTile() {
    this.card.querySelectorAll<HTMLElement>('[data-gs-tile]').forEach((el) => {
      const open = el.dataset.gsTile === this.openTile;
      el.classList.toggle('is-open', open);
      el.setAttribute('aria-expanded', String(open));
    });
  }

  private rows(): Row[] {
    const data = this.stats?.bots[this.mode] ?? {};
    const roster = this.getRoster();
    const byId = new Map(roster.map((r) => [r.id, r]));
    // Every ranked bot is listed (no games yet: zeros), plus any other bot that has results
    const ids = new Set([...roster.filter((r) => r.category === 'official').map((r) => r.id), ...Object.keys(data)]);
    const empty: BotTally = { w: 0, d: 0, l: 0, kills: {}, deaths: {} };
    return [...ids].map((id) => {
      const e = byId.get(id);
      const t = data[id] ?? empty;
      return {
        id,
        name: e?.shortName || e?.name || id,
        fullName: e?.name || id,
        avatar: e?.avatar ?? null,
        color: e?.color || '#7f8db3',
        t,
        games: t.w + t.d + t.l,
        kills: sumOf(t.kills),
        deaths: sumOf(t.deaths),
      };
    });
  }

  private tileHtml(key: string, label: string, value: string, sub: string, breakdown?: Record<PublicMode, number>): string {
    if (!breakdown) {
      return `
        <div class="gs-tile gs-tile-online">
          <div class="gs-tile-label"><span class="gs-live-dot" aria-hidden="true"></span>${label}</div>
          <div class="gs-tile-value">${value}</div>
          <div class="gs-tile-sub">${sub}</div>
        </div>`;
    }
    const rows = PUBLIC_MODES.map(
      (m) => `<div class="gs-pop-row"><span>${MODE_LABEL[m]}</span><b>${fmt(breakdown[m] ?? 0)}</b></div>`,
    ).join('');
    return `
      <button type="button" class="gs-tile gs-tile-matches ${this.openTile === key ? 'is-open' : ''}" data-gs-tile="${key}"
        aria-expanded="${this.openTile === key}" aria-label="${label}：${value} 局，查看各模式局数">
        <div class="gs-tile-label">${label}<span class="gs-tile-more" aria-hidden="true">ⓘ</span></div>
        <div class="gs-tile-value">${value}</div>
        <div class="gs-tile-sub">${sub}</div>
        <div class="gs-pop" role="tooltip">${rows}</div>
      </button>`;
  }

  private render() {
    if (!this.openState) return;
    const prevWrap = this.bodyEl.querySelector<HTMLElement>('.gs-table-wrap');
    if (prevWrap) this.tableScrollLeft = prevWrap.scrollLeft;
    const s = this.stats;
    if (!s) {
      this.bodyEl.innerHTML = this.error
        ? `<div class="gs-state">统计数据加载失败 <button type="button" class="gs-retry" data-gs-retry>重试</button></div>`
        : `<div class="gs-state">正在加载统计数据…</div>`;
      return;
    }
    const tiles = [
      this.tileHtml('online', '实时在线', fmt(s.online), '当前在线人数'),
      this.tileHtml('total', '累计对局', fmt(sumModes(s.total)), `自 ${slashDate(s.since)} 起`, s.total),
      this.tileHtml('day', '最近 24 小时', fmt(sumModes(s.last24h.modes)), `每小时更新 · 截至 ${hourLabel(s.last24h.to)}`, s.last24h.modes),
    ].join('');

    const rows = this.rows();
    const { key, desc } = this.sort;
    rows.sort((a, b) => {
      const va = sortValue(a, key);
      const vb = sortValue(b, key);
      if (va !== vb) return desc ? vb - va : va - vb;
      return b.games - a.games || a.name.localeCompare(b.name);
    });
    const th = (k: SortKey, label: string, cls = '', title = '', rows = 1) =>
      `<th class="gs-sortable ${cls} ${key === k ? `is-sorted ${desc ? 'is-desc' : 'is-asc'}` : ''}" data-gs-sort="${k}"${rows > 1 ? ` rowspan="${rows}"` : ''}${title ? ` title="${title}"` : ''}>${label}</th>`;
    const num = (n: number, cls = '') => `<td class="gs-num ${cls} ${n ? '' : 'is-zero'}">${fmt(n)}</td>`;
    const body = rows
      .map((r) => {
        const wr = winRate(r);
        const k = kd(r);
        const kdText = k < 0 ? '—' : Number.isFinite(k) ? k.toFixed(2) : '∞';
        const av = r.avatar
          ? `<img class="gs-av" src="${escapeHtml(r.avatar)}" alt="" />`
          : `<span class="gs-av gs-av-fallback" style="background:${escapeHtml(r.color)}">${escapeHtml(r.name.slice(0, 1))}</span>`;
        return `
          <tr class="${r.games ? '' : 'is-empty'}">
            <th scope="row" class="gs-bot" title="${escapeHtml(r.fullName)}"><div class="gs-bot-in">${av}<span class="gs-bot-name">${escapeHtml(r.name)}</span></div></th>
            ${num(r.games, 'gs-col-games')}
            <td class="gs-num gs-strong">${wr < 0 ? '—' : `${(wr * 100).toFixed(1)}%`}</td>
            <td class="gs-num gs-strong">${kdText}</td>
            <td class="gs-num gs-wdl" title="胜 ${fmt(r.t.w)} · 平 ${fmt(r.t.d)} · 负 ${fmt(r.t.l)}"><span class="w">${fmt(r.t.w)}</span>/<span class="d">${fmt(r.t.d)}</span>/<span class="l">${fmt(r.t.l)}</span></td>
            ${num(r.kills, 'gs-group-start gs-kill gs-strong')}
            ${KILL_CAUSES.map((c) => num(r.t.kills[c] ?? 0, 'gs-kill')).join('')}
            ${num(r.deaths, 'gs-group-start gs-death gs-strong')}
            ${DEATH_CAUSES.map((c) => num(r.t.deaths[c] ?? 0, 'gs-death')).join('')}
          </tr>`;
      })
      .join('');
    const anyGames = rows.some((r) => r.games > 0);

    this.bodyEl.innerHTML = `
      <div class="gs-tiles">${tiles}</div>
      <div class="gs-section-head">
        <div class="gs-section-title">排位 Bot 数据 <span class="gs-section-note">只统计打完的排位局 · 自 ${slashDate(s.since)} 起</span></div>
        <div class="gs-seg" role="tablist" aria-label="排位模式">
          <button type="button" role="tab" class="${this.mode === 'ranked-solo' ? 'active' : ''}" aria-selected="${this.mode === 'ranked-solo'}" data-gs-mode="ranked-solo">SOLO</button>
          <button type="button" role="tab" class="${this.mode === 'ranked-ffa' ? 'active' : ''}" aria-selected="${this.mode === 'ranked-ffa'}" data-gs-mode="ranked-ffa">四人</button>
        </div>
      </div>
      <div class="gs-table-wrap">
        <table class="gs-table">
          <thead>
            <tr>
              <th rowspan="2" class="gs-bot gs-corner">Bot</th>
              ${th('games', '局数', 'gs-col-games', '打完的排位局数', 2)}
              ${th('winRate', '胜率', '', '胜场 ÷ 局数（平局算在局数里）', 2)}
              ${th('kd', 'KD', '', '击杀 ÷ 死亡', 2)}
              ${th('w', '胜/平/负', '', '按胜场排序', 2)}
              <th colspan="${KILL_CAUSES.length + 1}" class="gs-group gs-group-start gs-kill">击杀</th>
              <th colspan="${DEATH_CAUSES.length + 1}" class="gs-group gs-group-start gs-death">死亡</th>
            </tr>
            <tr>
              ${th('kills', '总计', 'gs-group-start gs-kill')}
              ${KILL_CAUSES.map((c) => th(`k:${c}`, CAUSE_LABEL[c], 'gs-kill')).join('')}
              ${th('deaths', '总计', 'gs-group-start gs-death')}
              ${DEATH_CAUSES.map((c) => th(`d:${c}`, CAUSE_LABEL[c], 'gs-death')).join('')}
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>
      ${anyGames ? '' : `<div class="gs-empty-note">${this.mode === 'ranked-solo' ? '排位 SOLO' : '排位四人'}还没有打完的对局数据</div>`}
      ${this.error ? '<div class="gs-stale-note">刷新失败，显示的是上次的数据</div>' : ''}
    `;
    // Rows have a fixed first column: horizontal scroll keeps the bot names in view
    const wrap = this.bodyEl.querySelector<HTMLElement>('.gs-table-wrap');
    if (wrap) wrap.scrollLeft = this.tableScrollLeft;
  }
}
