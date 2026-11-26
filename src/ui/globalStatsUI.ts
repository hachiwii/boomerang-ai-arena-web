// 全球统计: a lobby panel with the live online count, all-time and last-24-hour match counts (per-mode breakdown on
// hover, or on tap on mobile) and a horizontally scrollable table of every ranked bot's record, SOLO / 四人 switchable.
// Data: GET /public-stats on the relay (src/net/publicStats.ts).
import type { RosterEntry } from '../game/types';
import { makeHoodieAvatarDataUrl } from './hoodieAvatar';
import {
  DEATH_CAUSES,
  fetchPublicStats,
  formatCount,
  formatTileCount,
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
  | 'elo' | 'games' | 'winRate' | 'avgRank' | 'kd' | 'w' | 'd' | 'l'
  | `k:${(typeof KILL_CAUSES)[number]}` | `d:${(typeof DEATH_CAUSES)[number]}`;

/** Result id the relay sums every human player under (src/game/botResults.ts HUMAN_RESULT_ID) */
const HUMAN_ID = 'human';

interface Row {
  id: string;
  human: boolean;
  name: string;
  fullName: string;
  avatar: string | null;
  color: string;
  elo: number | null; // ranked ELO for the table's mode (SOLO: duel rating, 四人: FFA rating)
  t: BotTally;
  games: number;
  kills: number;
  deaths: number;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const fmt = formatCount; // bot table: 万 / 亿 above 10000
const raw = formatTileCount; // top tiles: the full number (亿 only beyond 9 digits)
const sumOf = (o: Partial<Record<string, number>>) => Object.values(o).reduce<number>((a, n) => a + (n ?? 0), 0);

function winRate(r: Row): number {
  return r.games ? r.t.w / r.games : -1;
}

/** Average final place (1 = first), or null without data */
function avgRank(r: Row): number | null {
  return r.t.ranked ? (r.t.rankSum ?? 0) / r.t.ranked : null;
}

function kd(r: Row): number {
  if (r.deaths) return r.kills / r.deaths;
  return r.kills ? Number.POSITIVE_INFINITY : -1;
}

function sortValue(r: Row, key: SortKey): number {
  switch (key) {
    case 'elo': return r.human ? 0 : (r.elo ?? -1); // Human has no ELO: sorts as 0
    case 'avgRank': {
      const a = avgRank(r); // better (smaller) places sort first when descending
      return a === null ? Number.NEGATIVE_INFINITY : -a;
    }
    case 'games': return r.games;
    case 'winRate': return winRate(r);
    case 'kd': return kd(r);
    case 'w': case 'd': case 'l': return r.t[key];
    default: {
      const [side, c] = key.split(':') as ['k' | 'd', string];
      return (side === 'k' ? r.t.kills : r.t.deaths)[c as never] ?? 0;
    }
  }
}

/** Human row avatar: the human player's blue hoodie (same as in the lobby and leaderboard) */
let humanAvatar: string | null = null;
const humanAvatarUrl = () => (humanAvatar ??= makeHoodieAvatarDataUrl('#3B78F0', '#262A33'));

/** "2026-11-27" → "2026/11/27" */
const slashDate = (day: string) => day.replace(/-/g, '/');

/** An hour's start in UTC+8, "MM/DD HH:00" */
function hourLabel(iso: string): string {
  const d = new Date(Date.parse(iso) + 8 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:00`;
}

export class GlobalStatsPanel {
  private readonly backdrop: HTMLDivElement;
  private readonly card: HTMLDivElement;
  private readonly bodyEl: HTMLDivElement;
  private openState = false;
  private stats: PublicStats | null = null;
  private error = false;
  private mode: RankedMode = 'ranked-solo';
  private sort: { key: SortKey; desc: boolean } = { key: 'winRate', desc: true }; // 四人: avgRank (see renderTable)
  private refreshTimer: number | null = null;
  private abort: AbortController | null = null;
  private openTile: string | null = null;
  private shellBuilt = false; // tiles / switch / table container exist: refreshes update them in place
  private shownSig = ''; // data last drawn (refreshes with nothing new redraw nothing)

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
          // 四人 has 平均名次 where SOLO has 胜率: carry the default sort across
          if (mode === 'ranked-ffa' && this.sort.key === 'winRate') this.sort = { key: 'avgRank', desc: true };
          if (mode === 'ranked-solo' && this.sort.key === 'avgRank') this.sort = { key: 'winRate', desc: true };
          this.renderTable();
          const wrap = this.bodyEl.querySelector<HTMLElement>('.gs-table-wrap');
          if (wrap) wrap.scrollTop = wrap.scrollLeft = 0;
        }
      } else if (th) {
        const key = th.dataset.gsSort as SortKey;
        this.sort = this.sort.key === key ? { key, desc: !this.sort.desc } : { key, desc: true };
        this.renderTable();
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

  /** What the panel shows, minus the timestamp: unchanged data means nothing to redraw. */
  private dataSig(): string {
    if (!this.stats) return `none:${this.error}`;
    const { updatedAt: _t, ...data } = this.stats;
    return JSON.stringify(data);
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
    // Every ranked bot is listed (no games yet: zeros), plus Human (all human players) and any other bot with results
    const ids = new Set([
      ...roster.filter((r) => r.category === 'official').map((r) => r.id),
      HUMAN_ID,
      ...Object.keys(data),
    ]);
    const empty: BotTally = { w: 0, d: 0, l: 0, kills: {}, deaths: {} };
    return [...ids].map((id) => {
      const human = id === HUMAN_ID;
      const e = human ? undefined : byId.get(id);
      const t = data[id] ?? empty;
      const elo = e ? ((this.mode === 'ranked-solo' ? e.duelRating : e.ffaRating) ?? e.rating) : null;
      return {
        id,
        human,
        name: human ? 'Human' : e?.shortName || e?.name || id,
        fullName: human ? '所有人类玩家' : e?.name || id,
        avatar: e?.avatar ?? null,
        color: human ? '#3B78F0' : e?.color || '#7f8db3',
        elo: typeof elo === 'number' ? elo : null,
        t,
        games: t.w + t.d + t.l,
        kills: sumOf(t.kills),
        deaths: sumOf(t.deaths),
      };
    });
  }

  private tileHtml(key: string, label: string, kind: 'live' | 'plain' | 'breakdown', title = ''): string {
    if (kind !== 'breakdown') {
      return `
        <div class="gs-tile ${kind === 'live' ? 'gs-tile-online' : ''}"${title ? ` title="${title}"` : ''}>
          <div class="gs-tile-label">${kind === 'live' ? '<span class="gs-live-dot" aria-hidden="true"></span>' : ''}${label}</div>
          <div class="gs-tile-value" data-gs-val="${key}"></div>
          <div class="gs-tile-sub" data-gs-sub="${key}"></div>
        </div>`;
    }
    const rows = PUBLIC_MODES.map(
      (m) => `<div class="gs-pop-row"><span>${MODE_LABEL[m]}</span><b data-gs-pop="${key}:${m}"></b></div>`,
    ).join('');
    return `
      <button type="button" class="gs-tile gs-tile-matches ${this.openTile === key ? 'is-open' : ''}" data-gs-tile="${key}"
        aria-expanded="${this.openTile === key}">
        <div class="gs-tile-label">${label}<span class="gs-tile-more" aria-hidden="true">ⓘ</span></div>
        <div class="gs-tile-value" data-gs-val="${key}"></div>
        <div class="gs-tile-sub" data-gs-sub="${key}"></div>
        <div class="gs-pop" role="tooltip">${rows}</div>
      </button>`;
  }

  /**
   * Draw the panel. The first time data is there it builds the shell (tiles, switch, table container); after that a
   * refresh only rewrites the numbers in place and the table rows, so the hovered / tapped tile keeps its breakdown
   * and the table keeps its scroll position. A refresh that brings nothing new changes nothing.
   */
  private render() {
    if (!this.openState) return;
    const s = this.stats;
    if (!s) {
      this.shellBuilt = false;
      this.shownSig = '';
      this.bodyEl.innerHTML = this.error
        ? `<div class="gs-state">统计数据加载失败 <button type="button" class="gs-retry" data-gs-retry>重试</button></div>`
        : `<div class="gs-state">正在加载统计数据…</div>`;
      return;
    }
    if (!this.shellBuilt) {
      this.bodyEl.innerHTML = `
        <div class="gs-tiles">
          ${this.tileHtml('online', '实时在线', 'live')}
          ${this.tileHtml('players', '累计玩家', 'plain', '开过至少一局（任意模式）的玩家数')}
          ${this.tileHtml('total', '累计对局', 'breakdown')}
          ${this.tileHtml('day', '最近 24 小时', 'breakdown')}
        </div>
        <div class="gs-section-head">
          <div class="gs-section-title">排位 Bot 数据 <span class="gs-section-note" data-gs-note></span></div>
          <div class="gs-seg" role="tablist" aria-label="排位模式">
            <button type="button" role="tab" data-gs-mode="ranked-solo">SOLO</button>
            <button type="button" role="tab" data-gs-mode="ranked-ffa">四人</button>
          </div>
        </div>
        <div class="gs-table-wrap"></div>
        <div class="gs-notes"></div>
      `;
      this.shellBuilt = true;
      this.shownSig = '';
    }
    const notes = this.bodyEl.querySelector<HTMLElement>('.gs-notes')!;
    const stale = this.error ? '<div class="gs-stale-note">刷新失败，显示的是上次的数据</div>' : '';
    const sig = this.dataSig();
    if (sig === this.shownSig) {
      notes.querySelector('.gs-stale-note')?.remove();
      if (stale) notes.insertAdjacentHTML('beforeend', stale);
      return;
    }
    this.shownSig = sig;
    const set = (sel: string, text: string) => {
      const el = this.bodyEl.querySelector<HTMLElement>(sel);
      if (el && el.textContent !== text) el.textContent = text;
    };
    set('[data-gs-val="online"]', raw(s.online));
    set('[data-gs-sub="online"]', '当前在线人数');
    set('[data-gs-val="players"]', raw(s.players ?? 0));
    set('[data-gs-sub="players"]', `自 ${slashDate(s.since)} 起`);
    set('[data-gs-val="total"]', raw(sumModes(s.total)));
    set('[data-gs-sub="total"]', `自 ${slashDate(s.since)} 起`);
    set('[data-gs-val="day"]', raw(sumModes(s.last24h.modes)));
    set('[data-gs-sub="day"]', `自 ${hourLabel(s.last24h.from)} 起`);
    for (const m of PUBLIC_MODES) {
      set(`[data-gs-pop="total:${m}"]`, raw(s.total[m] ?? 0));
      set(`[data-gs-pop="day:${m}"]`, raw(s.last24h.modes[m] ?? 0));
    }
    this.bodyEl.querySelector('[data-gs-tile="total"]')?.setAttribute('aria-label', `累计对局：${raw(sumModes(s.total))} 局，查看各模式局数`);
    this.bodyEl.querySelector('[data-gs-tile="day"]')?.setAttribute('aria-label', `最近 24 小时：${raw(sumModes(s.last24h.modes))} 局，查看各模式局数`);
    set('[data-gs-note]', `只统计打完的排位局 · 自 ${slashDate(s.since)} 起`);
    this.renderTable();
    notes.querySelector('.gs-stale-note')?.remove();
    if (stale) notes.insertAdjacentHTML('beforeend', stale);
  }

  /** The bot table for the current mode and sort (its scroll container is kept, so the scroll position stays). */
  private renderTable() {
    const s = this.stats;
    const wrap = this.bodyEl.querySelector<HTMLElement>('.gs-table-wrap');
    if (!s || !wrap) return;
    this.bodyEl.querySelectorAll<HTMLElement>('[data-gs-mode]').forEach((b) => {
      const on = b.dataset.gsMode === this.mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
    const rows = this.rows();
    const ffa = this.mode === 'ranked-ffa';
    const { key, desc } = this.sort;
    rows.sort((a, b) => {
      const va = sortValue(a, key);
      const vb = sortValue(b, key);
      if (va !== vb) return desc ? vb - va : va - vb;
      return b.games - a.games || a.name.localeCompare(b.name);
    });
    const th = (k: SortKey, label: string, cls = '', title = '', rowspan = 1) =>
      `<th class="gs-sortable ${cls} ${key === k ? `is-sorted ${desc ? 'is-desc' : 'is-asc'}` : ''}" data-gs-sort="${k}"${rowspan > 1 ? ` rowspan="${rowspan}"` : ''}${title ? ` title="${title}"` : ''}>${label}</th>`;
    const num = (n: number, cls = '') => `<td class="gs-num ${cls} ${n ? '' : 'is-zero'}">${fmt(n)}</td>`;
    const body = rows
      .map((r) => {
        const wr = winRate(r);
        const k = kd(r);
        const kdText = k < 0 ? '—' : Number.isFinite(k) ? k.toFixed(2) : '∞';
        const av = r.human
          ? `<img class="gs-av" src="${humanAvatarUrl()}" alt="" />`
          : r.avatar
            ? `<img class="gs-av" src="${escapeHtml(r.avatar)}" alt="" />`
            : `<span class="gs-av gs-av-fallback" style="background:${escapeHtml(r.color)}">${escapeHtml(r.name.slice(0, 1))}</span>`;
        const ar = avgRank(r);
        const rateCell = ffa
          ? `<td class="gs-num gs-strong">${ar === null ? '—' : ar.toFixed(2)}</td>`
          : `<td class="gs-num gs-strong">${wr < 0 ? '—' : `${(wr * 100).toFixed(1)}%`}</td>`;
        return `
          <tr class="${r.games ? '' : 'is-empty'} ${r.human ? 'is-human' : ''}">
            <th scope="row" class="gs-bot" title="${escapeHtml(r.fullName)}"><div class="gs-bot-in">${av}<span class="gs-bot-name">${escapeHtml(r.name)}</span>${r.elo === null ? '' : `<span class="gs-elo" title="排位 ELO">${r.elo}</span>`}</div></th>
            ${num(r.games, 'gs-col-games')}
            ${rateCell}
            <td class="gs-num gs-strong">${kdText}</td>
            <td class="gs-num gs-wdl" title="胜 ${fmt(r.t.w)} · 平 ${fmt(r.t.d)} · 负 ${fmt(r.t.l)}"><span class="w">${fmt(r.t.w)}</span>/<span class="d">${fmt(r.t.d)}</span>/<span class="l">${fmt(r.t.l)}</span></td>
            ${KILL_CAUSES.map((c, i) => num(r.t.kills[c] ?? 0, `gs-kill ${i ? '' : 'gs-group-start'}`)).join('')}
            ${DEATH_CAUSES.map((c, i) => num(r.t.deaths[c] ?? 0, `gs-death ${i ? '' : 'gs-group-start'}`)).join('')}
          </tr>`;
      })
      .join('');
    const top = wrap.scrollTop;
    const left = wrap.scrollLeft;
    wrap.innerHTML = `
      <table class="gs-table">
        <thead>
          <tr>
            <th rowspan="2" class="gs-bot gs-corner gs-sortable ${key === 'elo' ? `is-sorted ${desc ? 'is-desc' : 'is-asc'}` : ''}" data-gs-sort="elo" title="按排位 ELO 排序">Bot</th>
            ${th('games', '局数', 'gs-col-games', '打完的排位局数', 2)}
            ${ffa
              ? th('avgRank', '平均名次', '', '每局最终名次的平均（1 = 第一，越小越好）', 2)
              : th('winRate', '胜率', '', '胜场 ÷ 局数（平局算在局数里）', 2)}
            ${th('kd', 'KD', '', '击杀 ÷ 死亡', 2)}
            ${th('w', '胜/平/负', '', '按胜场排序', 2)}
            <th colspan="${KILL_CAUSES.length}" class="gs-group gs-group-start gs-kill">击杀</th>
            <th colspan="${DEATH_CAUSES.length}" class="gs-group gs-group-start gs-death">死亡</th>
          </tr>
          <tr>
            ${KILL_CAUSES.map((c, i) => th(`k:${c}`, CAUSE_LABEL[c], `gs-kill ${i ? '' : 'gs-group-start'}`)).join('')}
            ${DEATH_CAUSES.map((c, i) => th(`d:${c}`, CAUSE_LABEL[c], `gs-death ${i ? '' : 'gs-group-start'}`)).join('')}
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>`;
    wrap.scrollTop = top;
    wrap.scrollLeft = left;
    // The second header row sticks right under the first (layout px: offsetHeight ignores the mobile rotation)
    const firstHeadRow = wrap.querySelector<HTMLElement>('thead tr');
    if (firstHeadRow) wrap.style.setProperty('--gs-head-row', `${firstHeadRow.offsetHeight}px`);
    const notes = this.bodyEl.querySelector<HTMLElement>('.gs-notes');
    if (notes) {
      notes.querySelector('.gs-empty-note')?.remove();
      if (!rows.some((r) => r.games > 0)) {
        notes.insertAdjacentHTML('afterbegin', `<div class="gs-empty-note">${this.mode === 'ranked-solo' ? '排位 SOLO' : '排位四人'}还没有打完的对局数据</div>`);
      }
    }
  }
}
