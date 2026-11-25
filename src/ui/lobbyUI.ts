import Sortable from 'sortablejs';
import { generateBgmSeed } from '../audio/bgm';
import { CricketFormat, CricketStore, CricketTier } from '../game/cricketStore';
import { LeaderboardStore } from '../game/leaderboard';
import { formatDashSummary, formatMoveSummary, formatPrimaryBind, getSlashJudgmentTicks, SettingsStore } from '../game/settings';
import { generateSpawnSeed, MapMeta, MatchConfig, RankedMode, RosterEntry, SlotConfig } from '../game/types';
import { clientToLogical, getLogicalViewport, isForcedLandscape, rectToLogical } from '../game/viewport';
import { getTheme } from '../render/themes';
import { makeHoodieAvatarDataUrl } from './hoodieAvatar';
import { ICON_DESKTOP, ICON_FULLSCREEN, ICON_FULLSCREEN_EXIT, ICON_PHONE } from './icons';
import { LeaderboardPanel } from './leaderboardUI';

const DUP_RING_ACCENTS = ['#FF4D6D', '#2EC4B6', '#FFB703', '#8338EC'];
const MAP_POOLS_STORAGE_KEY = 'boomerang_arena_map_pools_v1';
const RECENT_MAPS_STORAGE_KEY = 'boomerang_arena_recent_maps_v1';
/** The Cricket board was laid out for the 16 bundled bots; beyond that the 抽签 / 落选 zones become fixed-size scroll areas. */
const CRICKET_BOARD_DESIGN_CAP = 16;
/** Mobile 16-bot layout: 抽签 + 落选 never need more than 5 card columns between them (4 rows each). */
const CRICKET_MOBILE_ZONE_COLS = 5;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);
}

interface DraftSlot {
  kind: 'human' | 'bot';
  botId: string;
}

export interface LobbyCallbacks {
  onSelectMap: (map: MapMeta) => void;
  onStartMatch: (config: MatchConfig) => void;
  onStartCricketBatch?: (count: number) => void;
  onOpenHistory: () => void;
  onOpenSettings: () => void;
  /** Enters the training ground (训练场). */
  onStartTraining?: () => void;
  /** Desktop only: opens the custom bot manager (upload / compile / configure user bots). */
  onOpenBotManager?: () => void;
  /** PC / mobile presentation state for the header toggle + fullscreen buttons. */
  getPlatformState?: () => { mobile: boolean; fullscreen: boolean; fullscreenSupported: boolean };
  onTogglePlatform?: () => void;
  onToggleFullscreen?: () => void;
}

export type LobbyTab = 'ranked' | 'cricket' | 'custom';

export { makeHoodieAvatarDataUrl };

export function resolveSlots(drafts: DraftSlot[], roster: RosterEntry[]): SlotConfig[] {
  const byId = new Map(roster.map((r) => [r.id, r]));
  const counts = new Map<string, number>();
  for (const d of drafts) {
    if (d.kind === 'bot') {
      counts.set(d.botId, (counts.get(d.botId) || 0) + 1);
    }
  }
  const seen = new Map<string, number>();

  return drafts.map((d, idx) => {
    if (d.kind === 'human') {
      return {
        kind: 'human',
        charKey: 'demo_blue',
        baseName: '玩家',
        displayName: '玩家 (YOU)',
        color: '#3D7EFF',
        ringAccent: '#3D7EFF',
        avatar: makeHoodieAvatarDataUrl('#3B78F0', '#262A33'),
      };
    }
    const entry = byId.get(d.botId) || roster[0];
    const total = counts.get(entry.id) || 1;
    const copyNum = (seen.get(entry.id) || 0) + 1;
    seen.set(entry.id, copyNum);

    const displayName = total > 1 ? `${entry.shortName} ${copyNum}` : entry.shortName;
    const ringAccent = total > 1 ? DUP_RING_ACCENTS[(copyNum - 1) % DUP_RING_ACCENTS.length] : entry.color;

    let avatar = entry.avatar;
    if (!avatar) {
      if (entry.charKey === 'demo_red') avatar = makeHoodieAvatarDataUrl('#E8483D', '#4A3328');
      else if (entry.charKey === 'sparring_mid') avatar = makeHoodieAvatarDataUrl('#E89A2E', '#3D3028');
      else avatar = makeHoodieAvatarDataUrl('#4AB87A', '#4D423A');
    }

    return {
      kind: 'bot',
      botId: entry.id,
      charKey: entry.charKey,
      baseName: entry.name,
      displayName,
      color: entry.color,
      ringAccent: ringAccent || DUP_RING_ACCENTS[idx % DUP_RING_ACCENTS.length],
      avatar,
      copyNumber: total > 1 ? copyNum : undefined,
    };
  });
}

function drawMiniMap(canvas: HTMLCanvasElement, map: MapMeta) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const T = getTheme(map.theme);
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, T.skyTop);
  grad.addColorStop(1, T.skyBottom);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  const grid = map.previewGrid;
  if (!grid || grid.length === 0) return;
  const rows = grid.length;
  const cols = grid[0].length;
  const pad = 4;
  const cellW = (w - pad * 2) / cols;
  const cellH = (h - pad * 2) / rows;
  const cs = Math.min(cellW, cellH);
  const ox = (w - cols * cs) * 0.5;
  const oy = (h - rows * cs) * 0.5;

  for (let y = 0; y < rows; y++) {
    const row = grid[y];
    for (let x = 0; x < cols; x++) {
      const ch = row[x];
      if (ch === '~') continue;
      if (ch === '.') ctx.fillStyle = T.groundA;
      else if (ch === '"') ctx.fillStyle = T.grassMid;
      else if (ch === '#') ctx.fillStyle = T.wallTop;
      else continue;
      ctx.fillRect(ox + x * cs, oy + y * cs, Math.ceil(cs), Math.ceil(cs));
    }
  }
}

function avatarForBotEntry(entry: RosterEntry): string {
  if (entry.avatar) return entry.avatar;
  if (entry.charKey === 'demo_red') return makeHoodieAvatarDataUrl('#E8483D', '#4A3328');
  if (entry.charKey === 'sparring_mid') return makeHoodieAvatarDataUrl('#E89A2E', '#3D3028');
  return makeHoodieAvatarDataUrl('#4AB87A', '#4D423A');
}

function renderBgmQuickIconSvg(enabled: boolean): string {
  if (enabled) {
    return `
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M9 18V5l12-2v13"/>
        <circle cx="6" cy="18" r="3"/>
        <circle cx="18" cy="16" r="3"/>
      </svg>`;
  }
  return `
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M9 18V9.5"/>
      <path d="M9 5l12-2v11.5"/>
      <circle cx="6" cy="18" r="3"/>
      <circle cx="18" cy="16" r="3"/>
      <line x1="3" y1="3" x2="21" y2="21"/>
    </svg>`;
}

export class LobbyUI {
  private readonly container: HTMLDivElement;
  private readonly dropdownMenu: HTMLDivElement;
  private readonly mapPoolModal: HTMLDivElement;
  private mapPoolCard!: HTMLDivElement;
  private mapPoolTitleEl!: HTMLElement;
  private mapPoolSubEl!: HTMLElement;
  private mapPoolWarnEl!: HTMLElement;
  private mapPoolTiles = new Map<string, { btn: HTMLButtonElement; checkEl: HTMLElement }>();
  private lastRenderedViewKey = '';
  private readonly cricketListScroll = new Map<string, number>();
  private readonly maps: MapMeta[];
  private readonly roster: RosterEntry[];
  private readonly leaderboard: LeaderboardStore;
  private readonly cricket: CricketStore;
  private readonly settings: SettingsStore;
  private readonly leaderboardPanel: LeaderboardPanel;
  private readonly callbacks: LobbyCallbacks;

  private activeTab: LobbyTab = 'ranked';
  private rankedMode: RankedMode = 'solo';
  private showLeaderboard = false;
  private mapPoolOpen = false;
  private mapPoolTarget: 'ranked' | 'cricket' = 'ranked';
  private mapPoolWarnText: string | null = null;

  // Cricket mode transient UI states
  private cricketSortables: Sortable[] = [];
  private cricketDragCleanup: (() => void) | null = null;
  private cricketNotice: { text: string; kind: 'warn' | 'ok' } | null = null;
  private cricketNoticeTimer: number | null = null;
  private cricketConfirmReset = false;
  private cricketConfirmTimer: number | null = null;
  private cricketShakeInvited = false;

  // Separate saved map pools for Ranked SOLO and Ranked FFA (default: all maps enabled)
  private rankedMapPools: Record<RankedMode, Set<string>>;
  // Rolling history of the last 3 played map IDs (for recent-3-map anti-repeat when pool > 3)
  private recentMapIds: string[] = [];

  // Custom game settings
  private selectedMapId: string;
  private randomMap = false;
  private drafts: DraftSlot[];
  private randomizeOrder = true;
  private gameSpeed = 1.0;

  private openSlotIdx: number | null = null;
  private loadingMessage: string | null = null;

  constructor(
    root: HTMLElement,
    maps: MapMeta[],
    roster: RosterEntry[],
    leaderboard: LeaderboardStore,
    cricket: CricketStore,
    settings: SettingsStore,
    callbacks: LobbyCallbacks,
  ) {
    this.maps = maps;
    this.roster = roster;
    this.leaderboard = leaderboard;
    this.cricket = cricket;
    this.settings = settings;
    this.callbacks = callbacks;
    this.selectedMapId = maps[0]?.id || 'twinlakes';

    this.settings.onChange(() => {
      if (!this.container.classList.contains('hidden')) {
        this.syncKeyHintsInPlace();
        this.syncBgmQuickBtnInPlace();
      }
    });

    this.rankedMapPools = this.loadMapPools();
    this.recentMapIds = this.loadRecentMaps();

    this.leaderboardPanel = new LeaderboardPanel(leaderboard, {
      onChanged: () => this.render(),
      onModeChange: (m) => {
        this.rankedMode = m;
      },
      onClose: () => {
        this.showLeaderboard = false;
        this.render();
      },
    });

    // Default custom lineup: Human + 3 official AI bots
    this.drafts = [
      { kind: 'human', botId: 'gpt-6.2-astra' },
      { kind: 'bot', botId: 'gpt-6.2-astra' },
      { kind: 'bot', botId: 'claude-fable-5.2' },
      { kind: 'bot', botId: 'gemini-4-carbon' },
    ];

    this.container = document.createElement('div');
    this.container.className = 'lobby-overlay';
    root.appendChild(this.container);

    // Custom contestant dropdown portal
    this.dropdownMenu = document.createElement('div');
    this.dropdownMenu.className = 'picker-menu hidden';
    this.dropdownMenu.setAttribute('role', 'listbox');
    document.body.appendChild(this.dropdownMenu);

    // Persistent map pool modal portal (built once so clicking inside never replays fadeIn or redraws canvases)
    this.mapPoolModal = document.createElement('div');
    this.mapPoolModal.className = 'mappool-backdrop hidden';
    document.body.appendChild(this.mapPoolModal);
    this.initMapPoolModal();

    window.addEventListener('mousedown', (e) => {
      if (this.openSlotIdx === null) return;
      const target = e.target as Node | null;
      if (target && this.dropdownMenu.contains(target)) return;
      if (target instanceof Element && target.closest('.picker-trigger')) return;
      this.closeDropdown();
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') {
        if (this.mapPoolOpen) {
          this.closeMapPoolModal();
          return;
        }
        if (this.openSlotIdx !== null) {
          this.closeDropdown();
        }
      }
    });
    window.addEventListener('resize', () => {
      if (this.openSlotIdx !== null) this.closeDropdown();
    });

    this.render();
  }

  private loadMapPools(): Record<RankedMode, Set<string>> {
    const validIds = new Set(this.maps.map((m) => m.id));
    const allIds = () => new Set(this.maps.map((m) => m.id));
    try {
      const raw = localStorage.getItem(MAP_POOLS_STORAGE_KEY);
      if (!raw) return { solo: allIds(), ffa: allIds() };
      const parsed = JSON.parse(raw) as Partial<Record<RankedMode, string[]>>;
      const parseSet = (arr?: string[]) => {
        if (!Array.isArray(arr)) return allIds();
        const filtered = arr.filter((id) => validIds.has(id));
        return filtered.length > 0 ? new Set(filtered) : allIds();
      };
      return {
        solo: parseSet(parsed.solo),
        ffa: parseSet(parsed.ffa),
      };
    } catch {
      return { solo: allIds(), ffa: allIds() };
    }
  }

  private saveMapPools() {
    try {
      localStorage.setItem(
        MAP_POOLS_STORAGE_KEY,
        JSON.stringify({
          solo: Array.from(this.rankedMapPools.solo),
          ffa: Array.from(this.rankedMapPools.ffa),
        }),
      );
    } catch {
      // Ignore storage errors
    }
  }

  private loadRecentMaps(): string[] {
    const validIds = new Set(this.maps.map((m) => m.id));
    try {
      const raw = localStorage.getItem(RECENT_MAPS_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((id): id is string => typeof id === 'string' && validIds.has(id)).slice(-3);
    } catch {
      return [];
    }
  }

  private saveRecentMaps() {
    try {
      localStorage.setItem(RECENT_MAPS_STORAGE_KEY, JSON.stringify(this.recentMapIds.slice(-3)));
    } catch {
      // Ignore storage errors
    }
  }

  public recordPlayedMap(mapId: string) {
    this.recentMapIds.push(mapId);
    while (this.recentMapIds.length > 3) {
      this.recentMapIds.shift();
    }
    this.saveRecentMaps();
  }

  private pickRandomMap(pool: MapMeta[]): MapMeta {
    const safePool = pool.length > 0 ? pool : this.maps;
    let candidates = safePool;
    // When map pool has > 3 maps, exclude maps played in the last 3 matches
    if (safePool.length > 3 && this.recentMapIds.length > 0) {
      const recent3 = new Set(this.recentMapIds.slice(-3));
      const filtered = safePool.filter((m) => !recent3.has(m.id));
      if (filtered.length > 0) {
        candidates = filtered;
      }
    }
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  private getRankedPoolMaps(mode: RankedMode): MapMeta[] {
    const set = this.rankedMapPools[mode];
    const pool = this.maps.filter((m) => set.has(m.id));
    return pool.length > 0 ? pool : this.maps;
  }

  public show(
    tab?: LobbyTab,
    opts?: { openLeaderboard?: boolean; rankedMode?: RankedMode },
  ) {
    this.closeDropdown();
    this.closeMapPoolModal();
    this.loadingMessage = null;
    if (tab) this.activeTab = tab;
    if (opts?.rankedMode) this.rankedMode = opts.rankedMode;
    this.showLeaderboard = Boolean(opts?.openLeaderboard);
    this.container.classList.remove('hidden');
    this.render();
  }

  public hide() {
    this.destroyCricketSortables();
    this.closeDropdown();
    this.closeMapPoolModal();
    this.leaderboardPanel.hideTooltip();
    this.container.classList.add('hidden');
  }

  public setLoading(msg: string | null) {
    this.loadingMessage = msg;
    const btn = this.container.querySelector<HTMLButtonElement>('#btn-start-match');
    if (btn) {
      if (msg) {
        btn.disabled = true;
        btn.textContent = msg;
      } else if (this.activeTab === 'ranked') {
        btn.disabled = false;
        btn.textContent = '开始对战';
      } else if (this.activeTab === 'cricket') {
        const ready = this.cricket.canStartMatch();
        btn.disabled = !ready.ok;
        btn.textContent = '🦗 开始斗蛐蛐';
      } else {
        btn.disabled = false;
        btn.textContent = this.hasHuman() ? '开始对战' : '开始 AI 观战';
      }
    }
    const batchBtn = this.container.querySelector<HTMLButtonElement>('#btn-cricket-batch50');
    if (batchBtn && this.activeTab === 'cricket') {
      const ready = this.cricket.canStartMatch();
      batchBtn.disabled = Boolean(msg) || !ready.ok;
    }
  }

  private renderPlatformButtonsHtml(): string {
    const st = this.callbacks.getPlatformState?.();
    if (!st) return '';
    const platformBtn = `
      <button
        type="button"
        class="lobby-platform-btn ${st.mobile ? 'is-mobile' : 'is-desktop'}"
        id="btn-toggle-platform"
        title="${st.mobile ? '当前：移动端（触屏操作）· 点击切换到桌面端' : '当前：桌面端（键鼠操作）· 点击切换到移动端'}"
        aria-label="${st.mobile ? '切换到桌面端' : '切换到移动端'}"
      >${st.mobile ? ICON_DESKTOP : ICON_PHONE}<span>${st.mobile ? '桌面端' : '移动端'}</span></button>`;
    const fsBtn = st.mobile
      ? `<button
          type="button"
          class="lobby-fullscreen-btn"
          id="btn-toggle-fullscreen"
          title="${st.fullscreen ? '退出全屏' : st.fullscreenSupported ? '全屏横屏游玩' : '浏览器不支持网页全屏：请用「分享 → 添加到主屏幕」以全屏启动'}"
          aria-label="${st.fullscreen ? '退出全屏' : '进入全屏'}"
        >${st.fullscreen ? ICON_FULLSCREEN_EXIT : ICON_FULLSCREEN}</button>`
      : '';
    return platformBtn + fsBtn;
  }

  /** Re-render header buttons after a desktop/mobile or fullscreen change. */
  public refreshPlatformButtons() {
    if (this.container.classList.contains('hidden')) return;
    if (this.activeTab === 'cricket' && this.roster.length > CRICKET_BOARD_DESIGN_CAP) {
      // Overflowing Cricket board: zone heights and touch drag behaviour differ between desktop and mobile
      this.render();
      return;
    }
    const holder = this.container.querySelector<HTMLElement>('.lobby-header-platform');
    if (!holder) return;
    holder.innerHTML = this.renderPlatformButtonsHtml();
    holder.querySelector('#btn-toggle-platform')?.addEventListener('click', () => {
      this.closeDropdown();
      this.callbacks.onTogglePlatform?.();
    });
    holder.querySelector('#btn-toggle-fullscreen')?.addEventListener('click', () => {
      this.callbacks.onToggleFullscreen?.();
    });
    this.syncKeyHintsInPlace();
  }

  public getSelectedMap(): MapMeta {
    return this.maps.find((m) => m.id === this.selectedMapId) || this.maps[0];
  }

  /**
   * Refresh Lobby / Leaderboard UI in place after external store mutations (e.g. Settings -> 重置排位分数).
   */
  public refreshFromStores() {
    this.syncMapPoolModal();
    if (!this.container.classList.contains('hidden')) {
      this.render();
    }
  }

  /**
   * Reset all Lobby configuration options (Ranked map pools, recent map history, Cricket format/map pool/bot tiers,
   * and Custom map/speed/lineup/random switches) back to factory defaults without touching ELO, stats, or match history.
   */
  public resetLobbyConfig() {
    this.rankedMode = 'solo';
    this.rankedMapPools = {
      solo: new Set(this.maps.map((m) => m.id)),
      ffa: new Set(this.maps.map((m) => m.id)),
    };
    this.saveMapPools();
    this.recentMapIds = [];
    this.saveRecentMaps();

    this.cricket.resetConfigOnly();

    this.selectedMapId = this.maps[0]?.id || 'twinlakes';
    this.randomMap = false;
    this.drafts = [
      { kind: 'human', botId: 'gpt-6.2-astra' },
      { kind: 'bot', botId: 'gpt-6.2-astra' },
      { kind: 'bot', botId: 'claude-fable-5.2' },
      { kind: 'bot', botId: 'gemini-4-carbon' },
    ];
    this.randomizeOrder = true;
    this.gameSpeed = 1.0;

    this.closeDropdown();
    this.syncMapPoolModal();
    if (!this.container.classList.contains('hidden')) {
      this.render();
      this.callbacks.onSelectMap(this.getSelectedMap());
    }
  }

  /**
   * Build a fresh Ranked match config using the player's LATEST Elo score,
   * nearest 4 (SOLO) / 6 (FFA) ranked opponents, and the mode's saved map pool
   * (with recent-3-map exclusion when pool > 3).
   */
  public createRankedMatchConfig(mode: RankedMode, avoidBotIds?: string[]): MatchConfig {
    const pool = this.getRankedPoolMaps(mode);
    const mapMeta = this.pickRandomMap(pool);
    this.recordPlayedMap(mapMeta.id);

    const opponents = this.leaderboard.pickRankedOpponents(mode, avoidBotIds);
    const drafts: DraftSlot[] = [
      { kind: 'human', botId: '' },
      ...opponents.map((b) => ({ kind: 'bot' as const, botId: b.id })),
    ];
    const slots = resolveSlots(drafts, this.roster);
    // Randomize spawn seats in ranked matches
    for (let i = slots.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [slots[i], slots[j]] = [slots[j], slots[i]];
    }
    const seed = Math.floor(Math.random() * 900000) + 1;
    const s = this.settings.get();

    return {
      matchMode: mode === 'solo' ? 'ranked-solo' : 'ranked-ffa',
      mapId: mapMeta.id,
      mapMeta,
      slots,
      seed,
      spawnSeed: generateSpawnSeed(),
      bgmSeed: generateBgmSeed(),
      speed: 1.0, // Fixed standard speed in Ranked
      cliffGuard: s.cliffGuard,
      dashGuard: s.dashGuard,
      meleeAssist: s.meleeAssist,
      humanSlashTicks: getSlashJudgmentTicks(s.slashJudgment),
    };
  }

  private startRankedMatch() {
    if (this.loadingMessage) return;
    const cfg = this.createRankedMatchConfig(this.rankedMode);
    this.callbacks.onStartMatch(cfg);
  }

  /**
   * Build a fresh Cricket ("斗蛐蛐") match config from the current map pool and bot pool:
   * - Draw 1 map from the Cricket map pool
   * - Include ALL invited bots + random draw from lottery to fill 2 (1v1) or 4 (4P FFA) seats
   * - Randomize spawn seats
   */
  public createCricketMatchConfig(): MatchConfig | null {
    const check = this.cricket.canStartMatch();
    if (!check.ok) return null;

    const pool = this.cricket.getMapPoolMetas();
    const mapMeta = this.pickRandomMap(pool);
    this.recordPlayedMap(mapMeta.id);

    const botIds = this.cricket.drawMatchBotIds();
    const drafts: DraftSlot[] = botIds.map((botId) => ({ kind: 'bot', botId }));
    const slots = resolveSlots(drafts, this.roster);
    const seed = (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0;

    return {
      matchMode: 'cricket',
      mapId: mapMeta.id,
      mapMeta,
      slots,
      seed: seed || 1,
      spawnSeed: generateSpawnSeed(),
      bgmSeed: generateBgmSeed(),
      speed: 1.0,
      cliffGuard: false,
      dashGuard: false,
    };
  }

  private startCricketMatch() {
    if (this.loadingMessage) return;
    const check = this.cricket.canStartMatch();
    if (!check.ok) {
      this.showCricketNotice(check.reason || '当前配置无法开局', 'warn');
      return;
    }
    const cfg = this.createCricketMatchConfig();
    if (!cfg) return;
    this.callbacks.onStartMatch(cfg);
  }

  private startCricketBatch(count: number) {
    if (this.loadingMessage) return;
    const check = this.cricket.canStartMatch();
    if (!check.ok) {
      this.showCricketNotice(check.reason || '当前配置无法开局', 'warn');
      return;
    }
    this.callbacks.onStartCricketBatch?.(count);
  }

  private showCricketNotice(text: string, kind: 'warn' | 'ok') {
    this.cricketNotice = { text, kind };
    if (this.cricketNoticeTimer !== null) window.clearTimeout(this.cricketNoticeTimer);
    this.cricketNoticeTimer = window.setTimeout(() => {
      this.cricketNotice = null;
      this.cricketNoticeTimer = null;
      if (this.activeTab === 'cricket' && !this.container.classList.contains('hidden')) {
        this.syncCricketNoticeInPlace();
      }
    }, 2800);
    this.syncCricketNoticeInPlace();
  }

  private renderCricketNoticeHtml(): string {
    const ready = this.cricket.canStartMatch();
    if (this.cricketNotice) {
      return `<div class="cricket-notice is-${this.cricketNotice.kind}">${this.cricketNotice.text}</div>`;
    }
    if (!ready.ok && ready.reason) {
      return `<div class="cricket-notice is-warn">${ready.reason}</div>`;
    }
    return '';
  }

  private syncCricketNoticeInPlace() {
    const slot = this.container.querySelector<HTMLElement>('#cricket-notice-slot');
    if (slot) {
      const html = this.renderCricketNoticeHtml();
      slot.innerHTML = html;
      slot.classList.toggle('hidden', !html);
    } else if (this.activeTab === 'cricket' && !this.container.classList.contains('hidden')) {
      this.render();
    }
  }

  private controlsLegendInnerHtml(): string {
    if (this.callbacks.getPlatformState?.().mobile) {
      return `
        <div><kbd>左摇杆</kbd> 移动</div>
        <div><kbd>按住右摇杆</kbd> 0.1x 瞄准 · 松手扔镖</div>
        <div><kbd>长按右摇杆</kbd> 召回 · <kbd>挥砍键</kbd> 挥砍 / 踢人</div>
        <div><kbd>冲刺键</kbd> 冲刺越坑</div>
      `;
    }
    const kb = this.settings.get().keybindings;
    const mv = formatMoveSummary(kb);
    const thr = formatPrimaryBind(kb.throwRecall);
    const mel = formatPrimaryBind(kb.melee);
    const dsh = formatDashSummary(kb);
    return `
        <div><kbd>${mv}</kbd> 移动</div>
        <div><kbd>${thr}</kbd> 扔镖 / <kbd>长按</kbd> 召回</div>
        <div><kbd>${mel}</kbd> 挥砍 / 空手踢人</div>
        <div><kbd>${dsh}</kbd> 冲刺越坑</div>
      `;
  }

  private syncKeyHintsInPlace() {
    const kb = this.settings.get().keybindings;
    const legendEl = this.container.querySelector<HTMLElement>('.controls-legend');
    if (legendEl) {
      legendEl.innerHTML = this.controlsLegendInnerHtml();
    }
    const rstEl = this.container.querySelector<HTMLElement>('#cricket-rst-kbd');
    if (rstEl) {
      rstEl.textContent = formatPrimaryBind(kb.quickRestart, 'R');
    }
  }

  private syncBgmQuickBtnInPlace() {
    const btn = this.container.querySelector<HTMLButtonElement>('#btn-toggle-bgm');
    if (!btn) return;
    const bgmOn = this.settings.get().bgmEnabled;
    btn.classList.toggle('is-on', bgmOn);
    btn.classList.toggle('is-off', !bgmOn);
    btn.setAttribute('aria-checked', String(bgmOn));
    btn.title = bgmOn ? '背景音乐：已开启（点击关闭）' : '背景音乐：已关闭（点击开启）';
    btn.setAttribute('aria-label', bgmOn ? '关闭背景音乐' : '开启背景音乐');
    btn.innerHTML = renderBgmQuickIconSvg(bgmOn);
  }

  private startCustomMatch() {
    if (this.loadingMessage) return;
    const mapMeta = this.randomMap ? this.pickRandomMap(this.maps) : this.getSelectedMap();
    this.recordPlayedMap(mapMeta.id);
    const slots = resolveSlots(this.drafts, this.roster);
    if (this.randomizeOrder) {
      for (let i = slots.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [slots[i], slots[j]] = [slots[j], slots[i]];
      }
    }
    const seed = Math.floor(Math.random() * 900000) + 1;
    const s = this.settings.get();
    this.callbacks.onStartMatch({
      matchMode: 'custom',
      mapId: mapMeta.id,
      mapMeta,
      slots,
      seed,
      spawnSeed: generateSpawnSeed(),
      bgmSeed: generateBgmSeed(),
      speed: this.gameSpeed,
      cliffGuard: s.cliffGuard,
      dashGuard: s.dashGuard,
      meleeAssist: s.meleeAssist,
      humanSlashTicks: getSlashJudgmentTicks(s.slashJudgment),
    });
  }

  private closeDropdown() {
    if (this.openSlotIdx === null && this.dropdownMenu.classList.contains('hidden')) return;
    this.openSlotIdx = null;
    this.dropdownMenu.classList.add('hidden');
    this.container.querySelectorAll('.picker-trigger.open').forEach((el) => el.classList.remove('open'));
  }

  private officialBotScoreForCustom(b: RosterEntry): number | null {
    if (b.category !== 'official') return null;
    if (this.drafts.length === 2) return b.duelRating ?? b.rating;
    if (this.drafts.length === 4) return b.ffaRating ?? b.rating;
    return b.rating;
  }

  private openDropdown(slotIdx: number, triggerEl: HTMLElement) {
    if (this.openSlotIdx === slotIdx) {
      this.closeDropdown();
      return;
    }
    this.closeDropdown();
    this.openSlotIdx = slotIdx;
    triggerEl.classList.add('open');

    const currentDraft = this.drafts[slotIdx];
    const humanSlotIdx = this.drafts.findIndex((d) => d.kind === 'human');
    const humanTakenElsewhere = humanSlotIdx >= 0 && humanSlotIdx !== slotIdx;
    const humanSelectedHere = currentDraft.kind === 'human';
    const humanAvatar = makeHoodieAvatarDataUrl('#3B78F0', '#262A33');

    const officialBots = this.roster.filter((r) => r.category === 'official');
    const sparringBots = this.roster.filter((r) => r.category === 'sparring');
    const customBots = this.roster.filter((r) => r.category === 'custom');

    const renderBotItem = (b: RosterEntry) => {
      const selected = currentDraft.kind === 'bot' && currentDraft.botId === b.id;
      const isOfficial = b.category === 'official';
      const rankChip =
        isOfficial && b.rank !== null
          ? `<span class="pm-rank">#${b.rank}</span>`
          : b.category === 'custom'
            ? `<span class="pm-rank pm-rank-custom">自定义</span>`
            : `<span class="pm-rank pm-rank-sp">陪练</span>`;
      const score = isOfficial ? this.officialBotScoreForCustom(b) : null;
      const scoreHtml = score !== null ? `<span class="pm-score elo-zero">${score}</span>` : '';
      return `
        <button type="button" class="pm-item ${selected ? 'is-selected' : ''}" data-pick-kind="bot" data-pick-id="${b.id}" role="option" aria-selected="${selected}">
          <img class="pm-avatar" src="${avatarForBotEntry(b)}" alt="" style="border-color:${b.color}" />
          <div class="pm-main">
            <div class="pm-name-row">
              ${rankChip}
              <span class="pm-name">${escapeHtml(b.name)}</span>
            </div>
          </div>
          ${scoreHtml}
          <span class="pm-check">${selected ? '✓' : ''}</span>
        </button>`;
    };

    this.dropdownMenu.innerHTML = `
      <div class="pm-section-label">玩家</div>
      <button
        type="button"
        class="pm-item pm-item-human ${humanSelectedHere ? 'is-selected' : ''} ${humanTakenElsewhere ? 'is-disabled' : ''}"
        data-pick-kind="human"
        data-pick-id="human"
        role="option"
        aria-selected="${humanSelectedHere}"
        aria-disabled="${humanTakenElsewhere}"
        ${humanTakenElsewhere ? 'disabled' : ''}
      >
        <img class="pm-avatar" src="${humanAvatar}" alt="" style="border-color:#3D7EFF" />
        <div class="pm-main">
          <div class="pm-name-row">
            <span class="pm-rank pm-rank-human">真人</span>
            <span class="pm-name">玩家 (YOU)</span>
            ${humanTakenElsewhere ? `<span class="pm-taken-pill">已在 P${humanSlotIdx + 1}</span>` : ''}
          </div>
        </div>
        <span class="pm-check">${humanSelectedHere ? '✓' : ''}</span>
      </button>

      <div class="pm-section-label">官方 AI</div>
      ${officialBots.map(renderBotItem).join('')}

      <div class="pm-section-label">陪练</div>
      ${sparringBots.map(renderBotItem).join('')}
      ${customBots.length > 0 ? `<div class="pm-section-label">自定义 Bot</div>${customBots.map(renderBotItem).join('')}` : ''}
    `;

    const rect = rectToLogical(triggerEl.getBoundingClientRect());
    const vp = getLogicalViewport();
    const pad = 12;
    const width = Math.max(rect.width, 320);
    const left = Math.max(pad, Math.min(rect.left, vp.width - width - pad));
    const spaceBelow = vp.height - rect.bottom - pad;
    const spaceAbove = rect.top - pad;
    const openUpward = spaceBelow < 340 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(180, Math.min(390, (openUpward ? spaceAbove : spaceBelow) - 8));

    this.dropdownMenu.style.width = `${Math.round(width)}px`;
    this.dropdownMenu.style.maxHeight = `${Math.round(maxHeight)}px`;
    this.dropdownMenu.style.left = `${Math.round(left)}px`;
    if (openUpward) {
      this.dropdownMenu.style.top = 'auto';
      this.dropdownMenu.style.bottom = `${Math.round(vp.height - rect.top + 6)}px`;
      this.dropdownMenu.classList.add('open-up');
    } else {
      this.dropdownMenu.style.bottom = 'auto';
      this.dropdownMenu.style.top = `${Math.round(rect.bottom + 6)}px`;
      this.dropdownMenu.classList.remove('open-up');
    }

    this.dropdownMenu.classList.remove('hidden');

    const activeItem = this.dropdownMenu.querySelector<HTMLElement>('.pm-item.is-selected');
    if (activeItem) activeItem.scrollIntoView({ block: 'nearest' });

    this.dropdownMenu.querySelectorAll<HTMLButtonElement>('.pm-item').forEach((item) => {
      item.addEventListener('click', () => {
        if (item.disabled || item.classList.contains('is-disabled')) return;
        const pickKind = item.dataset.pickKind as 'human' | 'bot';
        const pickId = item.dataset.pickId!;

        if (pickKind === 'human') {
          const existingHuman = this.drafts.findIndex((d) => d.kind === 'human');
          if (existingHuman >= 0 && existingHuman !== slotIdx) return;
          this.drafts[slotIdx] = { kind: 'human', botId: this.drafts[slotIdx].botId };
        } else {
          this.drafts[slotIdx] = { kind: 'bot', botId: pickId };
        }
        this.closeDropdown();
        this.render();
      });
    });
  }

  private initMapPoolModal() {
    this.mapPoolModal.innerHTML = `
      <div class="mappool-card" role="dialog" aria-label="地图池">
        <div class="mappool-head">
          <div>
            <h3 id="mp-title"></h3>
            <p class="mappool-sub" id="mp-sub"></p>
          </div>
          <div class="mappool-head-actions">
            <button type="button" class="mappool-quick-btn" id="mp-select-all">全选</button>
            <button type="button" class="mappool-quick-btn" id="mp-select-std">仅标准图</button>
            <button type="button" class="mappool-quick-btn" id="mp-select-large">仅大图</button>
            <button type="button" class="mappool-close-btn" id="mp-close">完成</button>
          </div>
        </div>
        <div class="mappool-warn hidden" id="mp-warn"></div>
        <div class="mappool-grid">
          ${this.maps
            .map(
              (m) => `
              <button type="button" class="map-tile mappool-tile" data-pool-map="${m.id}" aria-pressed="false">
                <span class="mappool-check"></span>
                <canvas class="map-mini" width="120" height="76" data-pool-canvas="${m.id}"></canvas>
                <div class="map-tile-meta">
                  <span class="map-tile-title">${m.title}</span>
                  <span class="map-tile-tag">${m.category === 'standard' ? '标准' : '大图'}</span>
                </div>
              </button>`,
            )
            .join('')}
        </div>
      </div>
    `;

    this.mapPoolCard = this.mapPoolModal.querySelector<HTMLDivElement>('.mappool-card')!;
    this.mapPoolTitleEl = this.mapPoolModal.querySelector<HTMLElement>('#mp-title')!;
    this.mapPoolSubEl = this.mapPoolModal.querySelector<HTMLElement>('#mp-sub')!;
    this.mapPoolWarnEl = this.mapPoolModal.querySelector<HTMLElement>('#mp-warn')!;
    this.mapPoolTiles.clear();

    for (const m of this.maps) {
      const cvs = this.mapPoolModal.querySelector<HTMLCanvasElement>(`canvas[data-pool-canvas="${m.id}"]`);
      if (cvs) drawMiniMap(cvs, m);
      const btn = this.mapPoolModal.querySelector<HTMLButtonElement>(`[data-pool-map="${m.id}"]`);
      const checkEl = btn?.querySelector<HTMLElement>('.mappool-check');
      if (btn && checkEl) {
        this.mapPoolTiles.set(m.id, { btn, checkEl });
      }
    }

    // Bind all modal interactions ONCE on the persistent DOM shell (zero flicker / zero canvas redraw)
    this.mapPoolModal.addEventListener('click', (e) => {
      if (e.target === this.mapPoolModal) {
        this.closeMapPoolModal();
      }
    });

    this.mapPoolModal.querySelector('#mp-close')?.addEventListener('click', () => {
      this.closeMapPoolModal();
    });

    const applyPoolIds = (ids: string[]) => {
      if (ids.length === 0) return;
      if (this.mapPoolTarget === 'cricket') {
        this.cricket.setMapPool(ids);
      } else {
        this.rankedMapPools[this.rankedMode] = new Set(ids);
        this.saveMapPools();
      }
      this.mapPoolWarnText = null;
      this.syncMapPoolModal();
      this.syncLobbyMapPoolCount();
    };

    this.mapPoolModal.querySelector('#mp-select-all')?.addEventListener('click', () => {
      applyPoolIds(this.maps.map((m) => m.id));
    });

    this.mapPoolModal.querySelector('#mp-select-std')?.addEventListener('click', () => {
      applyPoolIds(this.maps.filter((m) => m.category === 'standard').map((m) => m.id));
    });

    this.mapPoolModal.querySelector('#mp-select-large')?.addEventListener('click', () => {
      applyPoolIds(this.maps.filter((m) => m.category === 'large').map((m) => m.id));
    });

    this.mapPoolTiles.forEach(({ btn }, id) => {
      btn.addEventListener('click', () => {
        if (this.mapPoolTarget === 'cricket') {
          if (!this.cricket.toggleMap(id)) {
            this.mapPoolWarnText = '图池内至少保留 1 张地图';
            this.syncMapPoolModal();
            return;
          }
        } else {
          const set = this.rankedMapPools[this.rankedMode];
          if (set.has(id)) {
            if (set.size <= 1) {
              this.mapPoolWarnText = '图池内至少保留 1 张地图';
              this.syncMapPoolModal();
              return;
            }
            set.delete(id);
          } else {
            set.add(id);
          }
          this.saveMapPools();
        }
        this.mapPoolWarnText = null;
        this.syncMapPoolModal();
        this.syncLobbyMapPoolCount();
      });
    });
  }

  private openMapPoolModal(target: 'ranked' | 'cricket' = 'ranked') {
    this.mapPoolTarget = target;
    this.mapPoolOpen = true;
    this.mapPoolWarnText = null;
    this.syncMapPoolModal();
    this.mapPoolModal.classList.remove('hidden');
    this.mapPoolCard.scrollTop = 0;
  }

  private closeMapPoolModal() {
    if (!this.mapPoolOpen && this.mapPoolModal.classList.contains('hidden')) return;
    this.mapPoolOpen = false;
    this.mapPoolWarnText = null;
    this.mapPoolModal.classList.add('hidden');
  }

  private syncMapPoolModal() {
    const isCricket = this.mapPoolTarget === 'cricket';
    const mode = this.rankedMode;
    const poolSet = isCricket ? this.cricket.getMapPoolSet() : this.rankedMapPools[mode];
    const titleName = isCricket ? '斗蛐蛐图池' : `${mode === 'solo' ? 'SOLO' : '四人混战'} 地图池`;

    this.mapPoolCard.setAttribute('aria-label', titleName);
    this.mapPoolTitleEl.textContent = titleName;
    this.mapPoolSubEl.innerHTML = `已选 <strong>${poolSet.size}</strong> / ${this.maps.length} 张地图${poolSet.size > 3 ? ' · 最近 3 场不重复' : ''}`;

    if (this.mapPoolWarnText) {
      this.mapPoolWarnEl.textContent = this.mapPoolWarnText;
      this.mapPoolWarnEl.classList.remove('hidden');
    } else {
      this.mapPoolWarnEl.textContent = '';
      this.mapPoolWarnEl.classList.add('hidden');
    }

    this.mapPoolTiles.forEach(({ btn, checkEl }, id) => {
      const checked = poolSet.has(id);
      btn.classList.toggle('active', checked);
      btn.setAttribute('aria-pressed', String(checked));
      checkEl.textContent = checked ? '✓' : '';
    });
  }

  private syncLobbyMapPoolCount() {
    const rankedBadge = this.container.querySelector<HTMLElement>('#mappool-count-badge');
    if (rankedBadge) {
      rankedBadge.textContent = `${this.getRankedPoolMaps(this.rankedMode).length} / ${this.maps.length}`;
    }
    const cricketBadge = this.container.querySelector<HTMLElement>('#cricket-mappool-count');
    if (cricketBadge) {
      cricketBadge.textContent = `${this.cricket.getMapPoolMetas().length} / ${this.maps.length}`;
    }
  }

  private hasHuman(): boolean {
    return this.drafts.some((d) => d.kind === 'human');
  }

  private toggleHumanMode() {
    if (this.hasHuman()) {
      this.drafts = this.drafts.map((d) =>
        d.kind === 'human' ? { kind: 'bot', botId: 'claude-opus-5.5' } : d,
      );
    } else {
      this.drafts[0] = { kind: 'human', botId: this.drafts[0].botId };
    }
    this.render();
  }

  private setPlayerCount(count: number) {
    const target = Math.max(2, Math.min(4, count));
    const defaults = ['gpt-6.2-astra', 'claude-fable-5.2', 'claude-opus-5.5', 'gemini-4-carbon'];
    while (this.drafts.length < target) {
      this.drafts.push({ kind: 'bot', botId: defaults[this.drafts.length % defaults.length] });
    }
    while (this.drafts.length > target) {
      this.drafts.pop();
    }
    this.render();
  }

  private renderControlsLegend(extraClass = ''): string {
    return `
      <div class="controls-legend ${extraClass}">${this.controlsLegendInnerHtml()}</div>
    `;
  }

  private renderRankedBody(): string {
    if (this.showLeaderboard) {
      return `<div id="leaderboard-mount"></div>`;
    }

    const mode = this.rankedMode;
    const elo = this.leaderboard.getHumanRating(mode);
    const rk = this.leaderboard.getHumanRank(mode);
    const peak = this.leaderboard.getHumanPeak(mode);
    const poolCount = this.getRankedPoolMaps(mode).length;
    const modeLabel = mode === 'solo' ? 'SOLO' : '四人混战';

    return `
      <div class="ranked-panel">
        <div class="ranked-mode-switch" role="tablist">
          <button type="button" class="ranked-mode-btn ${mode === 'solo' ? 'active' : ''}" data-ranked-mode="solo">
            <span class="rm-icon">⚔️</span>
            <span class="rm-text">SOLO</span>
            <span class="rm-tag">1v1</span>
          </button>
          <button type="button" class="ranked-mode-btn ${mode === 'ffa' ? 'active' : ''}" data-ranked-mode="ffa">
            <span class="rm-icon">👑</span>
            <span class="rm-text">四人混战</span>
            <span class="rm-tag">4P</span>
          </button>
        </div>

        <button type="button" class="ranked-hero-card" id="btn-open-leaderboard" title="点击查看完整排行榜">
          <div class="rh-top-row">
            <span class="rh-mode-badge">${modeLabel} 排位</span>
            <span class="rh-lb-link">🏆 查看排行榜 →</span>
          </div>
          <div class="rh-metrics">
            <div class="rh-metric">
              <div class="rh-metric-label">当前 ELO</div>
              <div class="rh-elo-num" id="ranked-elo-val">${elo}</div>
              <div class="rh-rank-sub" id="ranked-rank-val">当前名次 <strong>#${rk.rank}</strong><span> / ${rk.total}</span></div>
            </div>
            <div class="rh-divider"></div>
            <div class="rh-metric">
              <div class="rh-metric-label">历史最高 ELO</div>
              <div class="rh-elo-num rh-peak-num" id="ranked-peak-elo-val">${peak.rating}</div>
              <div class="rh-rank-sub" id="ranked-peak-rank-val">最高名次 <strong>#${peak.rank}</strong><span> / ${peak.total}</span></div>
            </div>
          </div>
        </button>

        <div class="ranked-controls-bar">
          <button type="button" class="mappool-trigger-btn" id="btn-open-map-pool">
            <span class="mpt-icon">🗺️</span>
            <span>地图选择</span>
            <span class="mpt-count" id="mappool-count-badge">${poolCount} / ${this.maps.length}</span>
          </button>
        </div>

        <button class="start-btn ranked-start-btn" id="btn-start-match" ${this.loadingMessage ? 'disabled' : ''}>
          ${this.loadingMessage || '开始对战'}
        </button>

        ${this.renderControlsLegend('ranked-controls-legend')}
      </div>
    `;
  }

  private renderCricketCard(entry: RosterEntry, tier: CricketTier): string {
    const elo = this.cricket.getFixedElo(entry);
    const st = this.cricket.getBotStats(entry.id);
    const hasGames = st.matches > 0;
    const winPct = hasGames ? `${Math.round((st.wins / st.matches) * 100)}%` : '--';
    const kdNum = st.deaths === 0 ? st.kills : st.kills / st.deaths;
    const kdStr = hasGames ? kdNum.toFixed(2) : '--';
    const isCustom = entry.category === 'custom';
    const eloHtml =
      elo !== null
        ? `<span class="cc-elo" title="固定 ELO 分数">${elo}</span>`
        : isCustom
          ? `<span class="cc-elo is-custom" title="自定义 Bot（没有 ELO 分数）">自定义</span>`
          : `<span class="cc-elo is-sparring" title="陪练角色">陪练</span>`;
    const tooltip = `${escapeHtml(entry.name)}${elo !== null ? ` · 固定 ELO ${elo}` : isCustom ? ' · 自定义 Bot' : ' · 陪练'}${hasGames ? ` · ${st.wins}胜/${st.matches}场 · ${st.kills}杀/${st.deaths}死` : ' · 暂无斗蛐蛐战绩'}`;

    return `
      <div
        class="cricket-card is-tier-${tier}"
        data-bot-id="${entry.id}"
        data-bot-tier="${tier}"
        title="${tooltip}"
      >
        <div class="cc-top">
          <img class="cc-avatar" src="${avatarForBotEntry(entry)}" alt="${escapeHtml(entry.shortName)}" style="border-color:${entry.color}" draggable="false" />
          <div class="cc-name-wrap">
            <span class="cc-name">${escapeHtml(entry.shortName)}</span>
          </div>
          ${eloHtml}
        </div>
        <div class="cc-metrics">
          <span class="cc-metric ${hasGames ? '' : 'is-empty'}">胜率 <strong>${winPct}</strong></span>
          <span class="cc-metric ${hasGames ? '' : 'is-empty'}">KD <strong>${kdStr}</strong></span>
        </div>
      </div>
    `;
  }

  private renderCricketBody(): string {
    const fmt = this.cricket.getFormat();
    const maxP = this.cricket.getMaxPlayers();
    const poolCount = this.cricket.getMapPoolMetas().length;
    const invitedIds = this.cricket.getTierIds('invited');
    const lotteryIds = this.cricket.getTierIds('lottery');
    const excludedIds = this.cricket.getTierIds('excluded');
    const rosterById = new Map(this.roster.map((r) => [r.id, r]));
    const ready = this.cricket.canStartMatch();
    const remainDraw = Math.max(0, maxP - invitedIds.length);
    const rstKey = formatPrimaryBind(this.settings.get().keybindings.quickRestart, 'R');

    const renderList = (ids: string[], tier: CricketTier) =>
      ids
        .map((id) => rosterById.get(id))
        .filter((e): e is RosterEntry => Boolean(e))
        .map((e) => this.renderCricketCard(e, tier))
        .join('');

    const emptyInvitedSlots = Array.from({ length: remainDraw }, (_, i) => `
      <div class="cricket-empty-slot ${i === remainDraw - 1 ? 'is-last-empty' : ''}" aria-hidden="true">
        <span>+ 拖拽角色设为直邀 (${invitedIds.length + i + 1}/${maxP})</span>
      </div>
    `).join('');

    const noticeHtml = this.renderCricketNoticeHtml();
    const overflow = this.roster.length > CRICKET_BOARD_DESIGN_CAP;
    let mLotteryCols = Math.min(4, Math.max(1, Math.ceil(lotteryIds.length / 4)));
    let mExcludedCols = Math.min(4, Math.max(1, Math.ceil(excludedIds.length / 4)));
    if (overflow) {
      // More bots than the board was designed for: keep the 16-bot column budget (cards never get narrower)
      // and let each zone scroll vertically instead of adding columns.
      const total = lotteryIds.length + excludedIds.length;
      mLotteryCols =
        excludedIds.length === 0
          ? 4
          : lotteryIds.length === 0
            ? 1
            : Math.min(4, Math.max(1, Math.round((CRICKET_MOBILE_ZONE_COLS * lotteryIds.length) / Math.max(1, total))));
      mExcludedCols = Math.min(4, Math.max(1, CRICKET_MOBILE_ZONE_COLS - mLotteryCols));
    }

    return `
      <div class="cricket-panel">
        <div class="cricket-toolbar">
          <div class="cricket-toolbar-left">
            <div class="cricket-format-seg" role="tablist" aria-label="斗蛐蛐赛制">
              <button type="button" class="cricket-fmt-btn ${fmt === '1v1' ? 'active' : ''}" data-cricket-format="1v1">
                ⚔️ 1v1 <span>2人</span>
              </button>
              <button type="button" class="cricket-fmt-btn ${fmt === 'ffa4' ? 'active' : ''}" data-cricket-format="ffa4">
                👑 4人混战 <span>4人</span>
              </button>
            </div>
            <button type="button" class="mappool-trigger-btn cricket-mappool-btn" id="btn-open-cricket-mappool">
              <span class="mpt-icon">🗺️</span>
              <span>图池</span>
              <span class="mpt-count" id="cricket-mappool-count">${poolCount} / ${this.maps.length}</span>
            </button>
          </div>
          <div class="cricket-toolbar-right">
            <button
              type="button"
              class="cricket-batch-btn"
              id="btn-cricket-batch50"
              title="按当前规则在后台连续模拟 50 场，自动计入战绩与对局历史并汇总统计"
              ${this.loadingMessage || !ready.ok ? 'disabled' : ''}
            >
              🎲 50 连抽
            </button>
            <button
              type="button"
              class="start-btn cricket-start-btn"
              id="btn-start-match"
              ${this.loadingMessage || !ready.ok ? 'disabled' : ''}
            >
              ${this.loadingMessage || '🦗 开始斗蛐蛐'}
            </button>
          </div>
        </div>

        <div id="cricket-notice-slot" class="${noticeHtml ? '' : 'hidden'}">${noticeHtml}</div>

        <div
          class="cricket-board ${overflow ? 'is-overflow' : ''}"
          style="--m-lottery-cols:${mLotteryCols};--m-excluded-cols:${mExcludedCols};--m-board-cols:minmax(0, 1fr) minmax(0, ${mLotteryCols}fr) minmax(0, ${mExcludedCols}fr)"
        >
          <section
            class="cricket-zone cricket-zone-invited ${invitedIds.length >= maxP ? 'is-at-cap' : ''} ${this.cricketShakeInvited ? 'is-shake' : ''}"
            data-drop-tier="invited"
          >
            <div class="cz-head">
              <div class="cz-title-group">
                <span class="cz-dot"></span>
                <h3>直邀</h3>
                <span class="cz-count">${invitedIds.length} / ${maxP}</span>
              </div>
              <span class="cz-sub">全部出战 · 不可超过总人数</span>
            </div>
            <div class="cricket-invited-row" data-drop-list="invited" style="--max-invited:${maxP}">
              ${renderList(invitedIds, 'invited')}
              ${emptyInvitedSlots}
            </div>
          </section>

          <div class="cricket-bottom-split">
            <section class="cricket-zone cricket-zone-lottery" data-drop-tier="lottery">
              <div class="cz-head">
                <div class="cz-title-group">
                  <span class="cz-dot"></span>
                  <h3>抽签</h3>
                  <span class="cz-count">${lotteryIds.length}</span>
                </div>
                <span class="cz-sub">${remainDraw > 0 ? `随机抽取 ${remainDraw} 名补齐` : '名额已由直邀占满'}</span>
              </div>
              <div class="cricket-card-grid" data-drop-list="lottery">
                ${lotteryIds.length > 0 ? renderList(lotteryIds, 'lottery') : '<div class="cricket-zone-empty">拖拽角色卡到此处加入抽签池</div>'}
              </div>
            </section>

            <section class="cricket-zone cricket-zone-excluded" data-drop-tier="excluded">
              <div class="cz-head">
                <div class="cz-title-group">
                  <span class="cz-dot"></span>
                  <h3>落选</h3>
                  <span class="cz-count">${excludedIds.length}</span>
                </div>
                <span class="cz-sub">不参与本轮抽签</span>
              </div>
              <div class="cricket-card-grid" data-drop-list="excluded">
                ${excludedIds.length > 0 ? renderList(excludedIds, 'excluded') : '<div class="cricket-zone-empty">拖拽角色卡到此处移出本轮</div>'}
              </div>
            </section>
          </div>
        </div>

        <div class="cricket-footer">
          <span class="cricket-footer-hint">拖拽角色卡在三区自由移动 · 随机抽图并随机站位 · 对局中按 <kbd id="cricket-rst-kbd">${rstKey}</kbd> 按相同规则重抽</span>
          <div class="cricket-reset-wrap" id="cricket-reset-wrap">
            ${this.renderCricketResetButtonsHtml()}
          </div>
        </div>
      </div>
    `;
  }

  private renderCricketResetButtonsHtml(): string {
    return this.cricketConfirmReset
      ? `<button type="button" class="cricket-reset-btn confirm" id="btn-cricket-reset-confirm">确认重置胜率/KD？</button>
         <button type="button" class="cricket-reset-cancel" id="btn-cricket-reset-cancel">取消</button>`
      : `<button type="button" class="cricket-reset-btn" id="btn-cricket-reset" title="重置所有角色胜率与 KD，保留固定 ELO 分数">↺ 重置数据</button>`;
  }

  private syncCricketResetInPlace() {
    const wrap = this.container.querySelector<HTMLElement>('#cricket-reset-wrap');
    if (!wrap) return;
    wrap.innerHTML = this.renderCricketResetButtonsHtml();
    this.bindCricketResetButtons();
  }

  private bindCricketResetButtons() {
    this.container.querySelector('#btn-cricket-reset')?.addEventListener('click', () => {
      this.cricketConfirmReset = true;
      if (this.cricketConfirmTimer !== null) window.clearTimeout(this.cricketConfirmTimer);
      this.cricketConfirmTimer = window.setTimeout(() => {
        this.cricketConfirmReset = false;
        this.cricketConfirmTimer = null;
        if (this.activeTab === 'cricket') this.syncCricketResetInPlace();
      }, 5000);
      this.syncCricketResetInPlace();
    });

    this.container.querySelector('#btn-cricket-reset-cancel')?.addEventListener('click', () => {
      this.cricketConfirmReset = false;
      if (this.cricketConfirmTimer !== null) {
        window.clearTimeout(this.cricketConfirmTimer);
        this.cricketConfirmTimer = null;
      }
      this.syncCricketResetInPlace();
    });

    this.container.querySelector('#btn-cricket-reset-confirm')?.addEventListener('click', () => {
      this.cricketConfirmReset = false;
      if (this.cricketConfirmTimer !== null) {
        window.clearTimeout(this.cricketConfirmTimer);
        this.cricketConfirmTimer = null;
      }
      this.cricket.resetStats();
      this.render();
      this.showCricketNotice('已重置战绩数据（固定 ELO 分数已保留）', 'ok');
    });
  }

  private destroyCricketSortables() {
    if (this.cricketDragCleanup) {
      this.cricketDragCleanup();
      this.cricketDragCleanup = null;
    }
    document.body.classList.remove('is-dnd-dragging');
    for (const s of this.cricketSortables) {
      try {
        s.destroy();
      } catch {
        // Ignore teardown errors on detached nodes
      }
    }
    this.cricketSortables = [];
  }

  /**
   * Overflow mode (more bots than the 16 the board was designed for): 抽签 / 落选 become fixed-size scroll areas,
   * so cards moving between zones during a drag never resize anything. Mobile already uses a fixed 4-row grid;
   * desktop gets locked to the height 16 cards would need in one zone.
   */
  private applyCricketOverflowLayout() {
    const board = this.container.querySelector<HTMLElement>('.cricket-board');
    if (!board) return;
    const grids = Array.from(board.querySelectorAll<HTMLElement>('.cricket-card-grid'));
    if (board.classList.contains('is-overflow')) {
      if (!document.body.classList.contains('is-mobile')) {
        const sample = board.querySelector<HTMLElement>('.cricket-card-grid .cricket-card');
        const grid = grids[0];
        if (sample && grid) {
          const cs = getComputedStyle(grid);
          const cols = Math.max(1, cs.gridTemplateColumns.split(' ').filter(Boolean).length);
          const gap = Number.parseFloat(cs.rowGap) || 0;
          const rows = Math.ceil(CRICKET_BOARD_DESIGN_CAP / cols);
          const h = rows * sample.getBoundingClientRect().height + (rows - 1) * gap;
          for (const g of grids) g.style.height = `${Math.ceil(h)}px`;
        }
      }
      const syncMore = (g: HTMLElement) =>
        g.classList.toggle('has-more-below', g.scrollTop + g.clientHeight < g.scrollHeight - 2);
      for (const g of grids) {
        const saved = this.cricketListScroll.get(g.dataset.dropList || '');
        if (saved) g.scrollTop = saved;
        syncMore(g);
        g.addEventListener('scroll', () => syncMore(g), { passive: true });
      }
    }
    this.cricketListScroll.clear();
  }

  /** Custom bots were added / enabled / disabled / renamed / recoloured: drop stale picks and redraw. */
  public handleRosterChanged() {
    const ids = new Set(this.roster.map((r) => r.id));
    const fallback = this.roster.find((r) => r.category === 'official')?.id ?? this.roster[0]?.id ?? '';
    this.drafts = this.drafts.map((d) => (ids.has(d.botId) || !d.botId ? d : { ...d, botId: fallback }));
    this.closeDropdown();
    if (!this.container.classList.contains('hidden')) this.render();
  }

  private bindCricketEvents() {
    this.destroyCricketSortables();

    this.container.querySelectorAll<HTMLButtonElement>('[data-cricket-format]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = btn.dataset.cricketFormat as CricketFormat;
        if (next === this.cricket.getFormat()) return;
        const demoted = this.cricket.setFormat(next);
        this.cricketNotice = null;
        this.render();
        if (demoted > 0) {
          this.showCricketNotice(`切换至 1v1，已将超出的 ${demoted} 名直邀移入抽签池`, 'ok');
        }
      });
    });

    this.container.querySelector('#btn-open-cricket-mappool')?.addEventListener('click', () => {
      this.openMapPoolModal('cricket');
    });

    this.container.querySelector('#btn-cricket-batch50')?.addEventListener('click', () => {
      this.startCricketBatch(50);
    });

    this.container.querySelector('#btn-start-match')?.addEventListener('click', () => {
      this.startCricketMatch();
    });

    this.bindCricketResetButtons();

    const boardEl = this.container.querySelector<HTMLElement>('.cricket-board');
    const panelEl = this.container.querySelector<HTMLElement>('.cricket-panel');
    const invitedZoneEl = this.container.querySelector<HTMLElement>('.cricket-zone-invited');
    const invitedListEl = this.container.querySelector<HTMLElement>('[data-drop-list="invited"]');
    const zoneEls = Array.from(this.container.querySelectorAll<HTMLElement>('.cricket-zone[data-drop-tier]'));
    const listEls = Array.from(this.container.querySelectorAll<HTMLElement>('[data-drop-list]'));
    if (!boardEl || listEls.length === 0) return;

    const extractClientPoint = (ev: Event | null | undefined): [number, number] | null => {
      if (!ev) return null;
      const te = ev as TouchEvent;
      if (te.touches && te.touches.length > 0) {
        return [te.touches[0].clientX, te.touches[0].clientY];
      }
      if (te.changedTouches && te.changedTouches.length > 0) {
        return [te.changedTouches[0].clientX, te.changedTouches[0].clientY];
      }
      const me = ev as MouseEvent;
      if (typeof me.clientX === 'number' && typeof me.clientY === 'number') {
        return [me.clientX, me.clientY];
      }
      return null;
    };

    const findZoneAtPoint = (cx: number, cy: number): HTMLElement | null => {
      for (const z of zoneEls) {
        const r = z.getBoundingClientRect();
        if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
          return z;
        }
      }
      return null;
    };

    const triggerInvitedFullFeedback = () => {
      this.cricketShakeInvited = true;
      const invZone = this.container.querySelector<HTMLElement>('.cricket-zone-invited');
      if (invZone) {
        invZone.classList.remove('is-shake');
        void invZone.offsetWidth;
        invZone.classList.add('is-shake');
      }
      this.showCricketNotice(`直邀数量不能超过比赛总人数（当前上限 ${this.cricket.getMaxPlayers()} 人）`, 'warn');
      window.setTimeout(() => {
        this.cricketShakeInvited = false;
        this.container.querySelector<HTMLElement>('.cricket-zone-invited')?.classList.remove('is-shake');
      }, 420);
    };

    const clearDragVisuals = () => {
      zoneEls.forEach((z) => z.classList.remove('is-drag-over', 'is-drag-full'));
      invitedListEl?.classList.remove('is-receiving-card');
    };

    const syncInvitedReceivingState = (fromTier: CricketTier) => {
      if (!invitedListEl) return;
      const count = invitedListEl.querySelectorAll('.cricket-card').length;
      const baseCount = this.cricket.getTierIds('invited').length;
      invitedListEl.classList.toggle('is-receiving-card', fromTier !== 'invited' && count > baseCount);
    };

    // Track initial press point in logical coordinates so forced-landscape CSS rotation
    // keeps the floating SortableJS fallback clone locked 1:1 under the user's finger.
    let tapClientX = 0;
    let tapClientY = 0;
    const onBoardPress = (ev: Event) => {
      const pt = extractClientPoint(ev);
      if (pt) {
        tapClientX = pt[0];
        tapClientY = pt[1];
      }
    };
    boardEl.addEventListener('pointerdown', onBoardPress, { capture: true, passive: true });
    boardEl.addEventListener('touchstart', onBoardPress, { capture: true, passive: true });

    let activeFromTier: CricketTier | null = null;
    let lastClientX = 0;
    let lastClientY = 0;
    let hasLastPoint = false;
    let tapLogicalX = 0;
    let tapLogicalY = 0;

    const getFallbackEl = () => document.body.querySelector<HTMLElement>('.cricket-drag-fallback');

    const updateHoverVisuals = (cx: number, cy: number) => {
      if (!activeFromTier) return;
      const maxP = this.cricket.getMaxPlayers();
      const invitedAtCap = this.cricket.getTierIds('invited').length >= maxP;
      const hoveredZone = findZoneAtPoint(cx, cy);
      for (const z of zoneEls) {
        if (z !== hoveredZone) {
          z.classList.remove('is-drag-over', 'is-drag-full');
          continue;
        }
        const tier = z.dataset.dropTier as CricketTier;
        const isFull = tier === 'invited' && activeFromTier !== 'invited' && invitedAtCap;
        z.classList.toggle('is-drag-full', isFull);
        z.classList.toggle('is-drag-over', !isFull);
      }
    };

    const onDragPointerMove = (ev: Event) => {
      if (!activeFromTier) return;
      const pt = extractClientPoint(ev);
      if (!pt) return;
      lastClientX = pt[0];
      lastClientY = pt[1];
      hasLastPoint = true;
      updateHoverVisuals(lastClientX, lastClientY);

      if (isForcedLandscape()) {
        const fb = getFallbackEl();
        if (fb) {
          const [lx, ly] = clientToLogical(lastClientX, lastClientY);
          fb.style.transform = `translate3d(${(lx - tapLogicalX).toFixed(1)}px, ${(ly - tapLogicalY).toFixed(1)}px, 0)`;
        }
      }
    };

    const stopActiveDragTracking = () => {
      activeFromTier = null;
      hasLastPoint = false;
      window.removeEventListener('pointermove', onDragPointerMove);
      window.removeEventListener('touchmove', onDragPointerMove);
      window.removeEventListener('mousemove', onDragPointerMove);
      document.body.classList.remove('is-dnd-dragging');
      clearDragVisuals();
    };

    this.cricketDragCleanup = () => {
      boardEl.removeEventListener('pointerdown', onBoardPress, true);
      boardEl.removeEventListener('touchstart', onBoardPress, true);
      stopActiveDragTracking();
    };

    this.applyCricketOverflowLayout();
    const holdToDrag = boardEl.classList.contains('is-overflow') && document.body.classList.contains('is-mobile');

    for (const listEl of listEls) {
      const tier = listEl.dataset.dropList as CricketTier;
      const sortable = Sortable.create(listEl, {
        // Overflowing mobile board: cards allow vertical panning, so a swipe scrolls the zone and a short
        // press-and-hold picks the card up (mouse drags stay immediate)
        ...(holdToDrag ? { delay: 170, delayOnTouchOnly: true, touchStartThreshold: 6 } : {}),
        group: {
          name: 'cricket-roster',
          pull: true,
          put: (_to, from) => {
            if (tier !== 'invited') return true;
            if (from.el === listEl) return true;
            return this.cricket.getTierIds('invited').length < this.cricket.getMaxPlayers();
          },
        },
        draggable: '.cricket-card',
        animation: 150,
        easing: 'cubic-bezier(0.2, 0.9, 0.3, 1)',
        forceFallback: true,
        fallbackOnBody: true,
        fallbackTolerance: 4,
        emptyInsertThreshold: 24,
        ghostClass: 'is-dragging',
        chosenClass: 'is-chosen',
        fallbackClass: 'cricket-drag-fallback',
        onStart: (evt) => {
          activeFromTier = (evt.from.dataset.dropList as CricketTier) || tier;
          document.body.classList.add('is-dnd-dragging');

          const [tlx, tly] = clientToLogical(tapClientX, tapClientY);
          tapLogicalX = tlx;
          tapLogicalY = tly;
          lastClientX = tapClientX;
          lastClientY = tapClientY;
          hasLastPoint = true;

          const fb = getFallbackEl();
          if (fb) {
            const zoomVal = Number.parseFloat(panelEl?.style.zoom || '1') || 1;
            if (Math.abs(zoomVal - 1) > 0.005) {
              fb.style.setProperty('--drag-zoom', zoomVal.toFixed(3));
            }
            if (isForcedLandscape()) {
              const lr = rectToLogical(evt.item.getBoundingClientRect());
              fb.style.left = `${lr.left.toFixed(1)}px`;
              fb.style.top = `${lr.top.toFixed(1)}px`;
              fb.style.width = `${lr.width.toFixed(1)}px`;
              fb.style.height = `${lr.height.toFixed(1)}px`;
              fb.style.transform = 'translate3d(0px, 0px, 0)';
            }
          }

          window.addEventListener('pointermove', onDragPointerMove, { passive: true });
          window.addEventListener('touchmove', onDragPointerMove, { passive: true });
          window.addEventListener('mousemove', onDragPointerMove, { passive: true });
        },
        onChange: () => {
          if (activeFromTier) {
            syncInvitedReceivingState(activeFromTier);
          }
        },
        onAdd: () => {
          if (activeFromTier) {
            syncInvitedReceivingState(activeFromTier);
          }
        },
        onRemove: () => {
          if (activeFromTier) {
            syncInvitedReceivingState(activeFromTier);
          }
        },
        onEnd: (evt) => {
          const fromTier = activeFromTier ?? (evt.from.dataset.dropList as CricketTier);
          const endPt = extractClientPoint((evt as unknown as { originalEvent?: Event }).originalEvent);
          if (endPt) {
            lastClientX = endPt[0];
            lastClientY = endPt[1];
            hasLastPoint = true;
          }
          const finalX = lastClientX;
          const finalY = lastClientY;
          const hadPoint = hasLastPoint;
          stopActiveDragTracking();

          const botId = evt.item.dataset.botId;
          if (!botId) return;

          const toTier = evt.to.dataset.dropList as CricketTier | undefined;
          const nextCardBeforeId = (item: HTMLElement): string | null => {
            let sib = item.nextElementSibling;
            while (sib) {
              if (sib instanceof HTMLElement && sib.classList.contains('cricket-card') && sib.dataset.botId && sib.dataset.botId !== botId) {
                return sib.dataset.botId;
              }
              sib = sib.nextElementSibling;
            }
            return null;
          };

          // Check actual final pointer zone first so fast flicks across an intermediate zone
          // (faster than SortableJS's internal dragover throttle) or drops on zone headers
          // always land in the zone actually under the user's finger/cursor.
          const hoveredZone = hadPoint ? findZoneAtPoint(finalX, finalY) : null;
          const hoveredTier = hoveredZone?.dataset.dropTier as CricketTier | undefined;
          if (hoveredTier && hoveredTier !== toTier) {
            if (
              hoveredTier === 'invited' &&
              fromTier !== 'invited' &&
              invitedZoneEl &&
              this.cricket.getTierIds('invited').length >= this.cricket.getMaxPlayers()
            ) {
              if (evt.to !== evt.from) this.render();
              triggerInvitedFullFeedback();
              return;
            }
            if (hoveredTier !== fromTier) {
              const res = this.cricket.moveBot(botId, hoveredTier, null);
              if (!res.ok && res.reason === 'invited_full') {
                if (evt.to !== evt.from) this.render();
                triggerInvitedFullFeedback();
                return;
              }
              this.cricketNotice = null;
              this.render();
              return;
            }
            // User swept across another zone and returned back to the original zone
            if (evt.to !== evt.from) {
              this.render();
            }
            return;
          }

          // Case 1: SortableJS moved the card across containers
          if (toTier && evt.to !== evt.from) {
            const res = this.cricket.moveBot(botId, toTier, nextCardBeforeId(evt.item));
            if (!res.ok && res.reason === 'invited_full') {
              this.render();
              triggerInvitedFullFeedback();
              return;
            }
            this.cricketNotice = null;
            this.render();
            return;
          }

          // Case 2: Reordered within the same zone
          if (toTier && evt.oldDraggableIndex !== evt.newDraggableIndex) {
            this.cricket.moveBot(botId, toTier, nextCardBeforeId(evt.item));
            this.cricketNotice = null;
            this.render();
          }
        },
      });
      this.cricketSortables.push(sortable);
    }
  }

  private renderCustomBody(): string {
    const selectedMap = this.getSelectedMap();
    const resolved = resolveSlots(this.drafts, this.roster);
    const isHumanPlaying = this.hasHuman();
    const rosterById = new Map(this.roster.map((r) => [r.id, r]));

    return `
      <div class="lobby-grid">
        <section class="lobby-section">
          <div class="section-head">
            <div class="section-title-group">
              <h2>选择地图</h2>
              <button
                type="button"
                class="rand-switch ${this.randomMap ? 'is-on' : ''}"
                id="btn-toggle-random-map"
                role="switch"
                aria-checked="${this.randomMap}"
                title="开启后每次开局随机抽取一张地图；选中任意地图自动关闭随机"
              >
                <span class="rand-track"><span class="rand-thumb"></span></span>
                <span class="rand-label">随机地图</span>
              </button>
            </div>
            <span class="section-hint" id="custom-map-hint">${this.randomMap ? `随机 · 共 ${this.maps.length} 张地图` : `${selectedMap.title} · ${selectedMap.nx * 0.5}×${selectedMap.ny * 0.5}m`}</span>
          </div>
          <div class="map-grid ${this.randomMap ? 'is-random' : ''}" id="map-grid">
            ${this.maps
              .map(
                (m) => `
              <button class="map-tile ${!this.randomMap && m.id === this.selectedMapId ? 'active' : ''}" data-map="${m.id}">
                <canvas class="map-mini" width="120" height="76" data-map-canvas="${m.id}"></canvas>
                <div class="map-tile-meta">
                  <span class="map-tile-title">${m.title}</span>
                  <span class="map-tile-tag">${m.category === 'standard' ? '标准' : '大图'}</span>
                </div>
              </button>`,
              )
              .join('')}
          </div>
          <div class="map-desc-box" id="custom-map-desc">
            ${
              this.randomMap
                ? `<strong>🎲 随机地图已开启</strong>：每次开局将从全部 ${this.maps.length} 张地图中随机抽取一张（最近 3 场不重复）；点击任意地图自动关闭随机。`
                : `<strong>${selectedMap.title}</strong>：${selectedMap.desc}`
            }
          </div>

          <div class="speed-box">
            <div class="speed-head">
              <span class="speed-title">游戏速度</span>
              <span class="speed-readout" id="speed-readout">
                <strong>${this.gameSpeed.toFixed(1)}x</strong> · ${Math.round(this.gameSpeed * 20)} Hz 逻辑 tick
              </span>
            </div>
            <input
              type="range"
              id="speed-slider"
              class="speed-slider"
              min="0.1"
              max="2.0"
              step="0.1"
              value="${this.gameSpeed.toFixed(1)}"
              style="--speed-pct:${(((this.gameSpeed - 0.1) / 1.9) * 100).toFixed(1)}%"
            />
            <div class="speed-ticks">
              ${[0.1, 0.5, 1.0, 1.5, 2.0]
                .map(
                  (v) =>
                    `<button type="button" class="speed-tick ${Math.abs(this.gameSpeed - v) < 0.01 ? 'active' : ''}" data-speed="${v}">${v.toFixed(1)}x</button>`,
                )
                .join('')}
            </div>
          </div>
        </section>

        <section class="lobby-section">
          <div class="section-head">
            <div class="section-title-group">
              <h2>参赛选手 (${this.drafts.length} 人)</h2>
              <button
                type="button"
                class="rand-switch ${this.randomizeOrder ? 'is-on' : ''}"
                id="btn-toggle-random"
                role="switch"
                aria-checked="${this.randomizeOrder}"
                title="开启后大厅顺序不变，进入对局时随机打乱出生站位"
              >
                <span class="rand-track"><span class="rand-thumb"></span></span>
                <span class="rand-label">随机站位</span>
              </button>
            </div>
            <div class="slot-controls">
              <div class="seg-group">
                ${[2, 3, 4]
                  .map(
                    (n) =>
                      `<button class="seg-btn ${this.drafts.length === n ? 'active' : ''}" data-count="${n}">${n}人</button>`,
                  )
                  .join('')}
              </div>
              <button class="mode-toggle ${isHumanPlaying ? 'human-on' : 'spec-on'}" id="btn-toggle-human">
                ${isHumanPlaying ? '真人参战中' : '观战模式 (纯AI)'}
              </button>
            </div>
          </div>

          <div class="slots-list">
            ${resolved
              .map((slot, idx) => {
                const isHuman = slot.kind === 'human';
                const botEntry = !isHuman && slot.botId ? rosterById.get(slot.botId) : undefined;
                const isOfficial = !isHuman && botEntry?.category === 'official';
                const officialScore = isOfficial && botEntry ? this.officialBotScoreForCustom(botEntry) : null;
                const roleChip = isHuman
                  ? `<span class="pk-chip pk-chip-human">真人</span>`
                  : isOfficial && botEntry?.rank !== null && botEntry?.rank !== undefined
                    ? `<span class="pk-chip pk-chip-official">#${botEntry.rank} AI</span>`
                    : botEntry?.category === 'custom'
                      ? `<span class="pk-chip pk-chip-custom">自定义</span>`
                      : `<span class="pk-chip pk-chip-sparring">陪练</span>`;
                const subHtml = isOfficial ? `<div class="pk-sub">${slot.baseName}</div>` : '';
                const scoreHtml =
                  officialScore !== null ? `<span class="pk-score elo-zero">${officialScore}</span>` : '';
                return `
                <div class="slot-row ${isHuman ? 'slot-human' : ''}">
                  <div class="slot-seat" style="background:${slot.ringAccent || slot.color}">P${idx + 1}</div>
                  <button type="button" class="picker-trigger" data-slot-picker="${idx}" aria-haspopup="listbox">
                    <img class="pk-avatar" src="${slot.avatar || ''}" alt="${slot.displayName}" style="border-color:${slot.ringAccent || slot.color}" />
                    <div class="pk-body">
                      <div class="pk-title-line">
                        <span class="pk-name">${slot.displayName}</span>
                        ${slot.copyNumber ? `<span class="dup-pill">副本 #${slot.copyNumber}</span>` : ''}
                        ${roleChip}
                      </div>
                      ${subHtml}
                    </div>
                    <div class="pk-right">
                      ${scoreHtml}
                      <svg class="pk-chevron" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                        <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                      </svg>
                    </div>
                  </button>
                </div>`;
              })
              .join('')}
          </div>

          ${this.renderControlsLegend()}

          <button class="start-btn" id="btn-start-match" ${this.loadingMessage ? 'disabled' : ''}>
            ${this.loadingMessage || (isHumanPlaying ? '开始对战' : '开始 AI 观战')}
          </button>
        </section>
      </div>
    `;
  }

  private render() {
    this.destroyCricketSortables();
    this.closeDropdown();
    const viewKey = `${this.activeTab}:${this.showLeaderboard ? 'lb' : 'main'}`;
    this.cricketListScroll.clear();
    if (viewKey === this.lastRenderedViewKey) {
      this.container.querySelectorAll<HTMLElement>('[data-drop-list]').forEach((el) => {
        if (el.scrollTop > 0) this.cricketListScroll.set(el.dataset.dropList || '', el.scrollTop);
      });
    }
    const prevScrollTop =
      viewKey === this.lastRenderedViewKey
        ? (this.container.querySelector<HTMLElement>('.lobby-card')?.scrollTop ?? 0)
        : 0;
    this.lastRenderedViewKey = viewKey;
    const icpNumber = (import.meta.env.VITE_ICP_NUMBER || '').trim();
    const icpFooterHtml = icpNumber
      ? `<footer class="icp-footer"><a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">${icpNumber.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] || c)}</a></footer>`
      : '';

    const bodyHtml =
      this.activeTab === 'ranked'
        ? this.renderRankedBody()
        : this.activeTab === 'cricket'
          ? this.renderCricketBody()
          : this.renderCustomBody();

    const bgmOn = this.settings.get().bgmEnabled;

    this.container.innerHTML = `
      <div class="lobby-card ${this.activeTab === 'ranked' && !this.showLeaderboard ? 'lobby-card-ranked' : ''} ${this.activeTab === 'cricket' ? 'lobby-card-cricket' : ''}">
        <header class="lobby-header">
          <div class="lobby-title-group">
            <h1>回旋镖大作战</h1>
          </div>
          <div class="lobby-nav-right lobby-nav-row">
            <div class="lobby-tabs">
              <button class="lobby-tab ${this.activeTab === 'ranked' ? 'active' : ''}" id="tab-ranked"><span class="nav-ico">🏆</span> 排位赛</button>
              <button class="lobby-tab ${this.activeTab === 'cricket' ? 'active' : ''}" id="tab-cricket"><span class="nav-ico">🦗</span> 斗蛐蛐</button>
              <button class="lobby-tab ${this.activeTab === 'custom' ? 'active' : ''}" id="tab-custom"><span class="nav-ico">🎛️</span> 自定义</button>
            </div>
            <div class="lobby-nav-actions">
              <button type="button" class="lobby-settings-btn lobby-training-btn" id="btn-start-training" title="训练场：打稻草人、练走位冲刺、练躲镖挡镖（不限时，玩家无敌）"><span class="nav-ico">🎯</span> 训练</button>
              <button type="button" class="lobby-settings-btn lobby-history-btn" id="btn-open-history" title="查看对局历史与观战回放（各模式分别保存最近 50 场）"><span class="nav-ico">📜</span> 对局历史</button>
              <button type="button" class="lobby-settings-btn lobby-bots-btn" id="btn-open-bot-manager" title="上传 C++ 源码在浏览器里编译成自定义 Bot，可在自定义对局和斗蛐蛐中使用">🤖 管理 Bot</button>
              <button type="button" class="lobby-settings-btn" id="btn-open-settings" title="音效、背景音乐、帧率上限与键位设置"><span class="nav-ico">⚙️</span> 设置</button>
              <button
                type="button"
                class="lobby-bgm-btn ${bgmOn ? 'is-on' : 'is-off'}"
                id="btn-toggle-bgm"
                role="switch"
                aria-checked="${bgmOn}"
                title="${bgmOn ? '背景音乐：已开启（点击关闭）' : '背景音乐：已关闭（点击开启）'}"
                aria-label="${bgmOn ? '关闭背景音乐' : '开启背景音乐'}"
              >
                ${renderBgmQuickIconSvg(bgmOn)}
              </button>
              <a
                class="lobby-github-btn"
                id="btn-github-link"
                href="https://github.com/hachiwii/boomerang-ai-arena-web"
                target="_blank"
                rel="noopener noreferrer"
                title="GitHub 开源仓库"
                aria-label="GitHub 开源仓库"
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
                  <path d="M12 0.3C5.37 0.3 0 5.67 0 12.3c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.05-.02-2.06-3.34.73-4.04-1.61-4.04-1.61-.55-1.38-1.33-1.75-1.33-1.75-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.49 1 .11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6.01 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.63-5.48 5.92.43.37.81 1.1.81 2.22 0 1.6-.01 2.9-.01 3.29 0 .32.22.7.82.58C20.57 22.1 24 17.6 24 12.3 24 5.67 18.63.3 12 .3Z"/>
                </svg>
              </a>
            </div>
          </div>
          <div class="lobby-header-platform">
            ${this.renderPlatformButtonsHtml()}
          </div>
        </header>

        ${bodyHtml}
      </div>
      ${icpFooterHtml}
    `;

    const lobbyCardEl = this.container.querySelector<HTMLElement>('.lobby-card');
    if (lobbyCardEl && prevScrollTop > 0) {
      lobbyCardEl.scrollTop = prevScrollTop;
    }

    // PC / mobile toggle & fullscreen
    this.container.querySelector('#btn-toggle-platform')?.addEventListener('click', () => {
      this.closeDropdown();
      this.callbacks.onTogglePlatform?.();
    });
    this.container.querySelector('#btn-toggle-fullscreen')?.addEventListener('click', () => {
      this.callbacks.onToggleFullscreen?.();
    });

    // Bind top tabs, training, history & settings buttons
    this.container.querySelector('#btn-start-training')?.addEventListener('click', () => {
      this.closeDropdown();
      this.callbacks.onStartTraining?.();
    });
    this.container.querySelector('#btn-open-history')?.addEventListener('click', () => {
      this.closeDropdown();
      this.callbacks.onOpenHistory();
    });
    this.container.querySelector('#btn-open-settings')?.addEventListener('click', () => {
      this.closeDropdown();
      this.callbacks.onOpenSettings();
    });
    this.container.querySelector('#btn-open-bot-manager')?.addEventListener('click', () => {
      this.closeDropdown();
      this.callbacks.onOpenBotManager?.();
    });
    this.container.querySelector('#btn-toggle-bgm')?.addEventListener('click', () => {
      this.settings.setBgmEnabled(!this.settings.get().bgmEnabled);
    });
    this.container.querySelector('#tab-ranked')?.addEventListener('click', () => {
      if (this.activeTab === 'ranked' && !this.showLeaderboard) return;
      this.activeTab = 'ranked';
      this.showLeaderboard = false;
      this.closeMapPoolModal();
      this.leaderboardPanel.hideTooltip();
      this.render();
    });
    this.container.querySelector('#tab-cricket')?.addEventListener('click', () => {
      if (this.activeTab === 'cricket') return;
      this.activeTab = 'cricket';
      this.showLeaderboard = false;
      this.closeMapPoolModal();
      this.leaderboardPanel.hideTooltip();
      this.render();
    });
    this.container.querySelector('#tab-custom')?.addEventListener('click', () => {
      if (this.activeTab === 'custom') return;
      this.activeTab = 'custom';
      this.showLeaderboard = false;
      this.closeMapPoolModal();
      this.leaderboardPanel.hideTooltip();
      this.render();
    });

    // Ranked tab bindings
    if (this.activeTab === 'ranked') {
      if (this.showLeaderboard) {
        this.leaderboardPanel.setMode(this.rankedMode);
        const mount = this.container.querySelector<HTMLElement>('#leaderboard-mount');
        if (mount) this.leaderboardPanel.renderInto(mount);
        return;
      }

      this.container.querySelectorAll<HTMLButtonElement>('[data-ranked-mode]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const next = btn.dataset.rankedMode as RankedMode;
          if (next === this.rankedMode) return;
          this.rankedMode = next;
          this.container.querySelectorAll<HTMLButtonElement>('[data-ranked-mode]').forEach((b) => {
            b.classList.toggle('active', b.dataset.rankedMode === next);
          });
          const badge = this.container.querySelector<HTMLElement>('.rh-mode-badge');
          if (badge) badge.textContent = `${next === 'solo' ? 'SOLO' : '四人混战'} 排位`;
          const eloEl = this.container.querySelector<HTMLElement>('#ranked-elo-val');
          if (eloEl) eloEl.textContent = String(this.leaderboard.getHumanRating(next));
          const rk = this.leaderboard.getHumanRank(next);
          const rkEl = this.container.querySelector<HTMLElement>('#ranked-rank-val');
          if (rkEl) rkEl.innerHTML = `当前名次 <strong>#${rk.rank}</strong><span> / ${rk.total}</span>`;
          const peak = this.leaderboard.getHumanPeak(next);
          const peakEloEl = this.container.querySelector<HTMLElement>('#ranked-peak-elo-val');
          if (peakEloEl) peakEloEl.textContent = String(peak.rating);
          const peakRkEl = this.container.querySelector<HTMLElement>('#ranked-peak-rank-val');
          if (peakRkEl) peakRkEl.innerHTML = `最高名次 <strong>#${peak.rank}</strong><span> / ${peak.total}</span>`;
          this.syncLobbyMapPoolCount();
        });
      });

      this.container.querySelector('#btn-open-leaderboard')?.addEventListener('click', () => {
        this.showLeaderboard = true;
        this.render();
      });

      this.container.querySelector('#btn-open-map-pool')?.addEventListener('click', () => {
        this.openMapPoolModal('ranked');
      });

      this.container.querySelector('#btn-start-match')?.addEventListener('click', () => {
        this.startRankedMatch();
      });
      return;
    }

    // Cricket ("斗蛐蛐") tab bindings
    if (this.activeTab === 'cricket') {
      this.bindCricketEvents();
      return;
    }

    // Custom tab bindings
    for (const m of this.maps) {
      const cvs = this.container.querySelector<HTMLCanvasElement>(`canvas[data-map-canvas="${m.id}"]`);
      if (cvs) drawMiniMap(cvs, m);
    }

    const syncCustomMapSelectionUI = () => {
      const selectedMap = this.getSelectedMap();
      const randBtn = this.container.querySelector<HTMLButtonElement>('#btn-toggle-random-map');
      if (randBtn) {
        randBtn.classList.toggle('is-on', this.randomMap);
        randBtn.setAttribute('aria-checked', String(this.randomMap));
      }
      this.container.querySelector<HTMLElement>('#map-grid')?.classList.toggle('is-random', this.randomMap);
      this.container.querySelectorAll<HTMLButtonElement>('#map-grid .map-tile').forEach((tile) => {
        tile.classList.toggle('active', !this.randomMap && tile.dataset.map === this.selectedMapId);
      });
      const hintEl = this.container.querySelector<HTMLElement>('#custom-map-hint');
      if (hintEl) {
        hintEl.textContent = this.randomMap
          ? `随机 · 共 ${this.maps.length} 张地图`
          : `${selectedMap.title} · ${selectedMap.nx * 0.5}×${selectedMap.ny * 0.5}m`;
      }
      const descEl = this.container.querySelector<HTMLElement>('#custom-map-desc');
      if (descEl) {
        descEl.innerHTML = this.randomMap
          ? `<strong>🎲 随机地图已开启</strong>：每次开局将从全部 ${this.maps.length} 张地图中随机抽取一张（最近 3 场不重复）；点击任意地图自动关闭随机。`
          : `<strong>${selectedMap.title}</strong>：${selectedMap.desc}`;
      }
    };

    this.container.querySelector('#btn-toggle-random-map')?.addEventListener('click', () => {
      this.randomMap = !this.randomMap;
      syncCustomMapSelectionUI();
    });

    this.container.querySelectorAll<HTMLButtonElement>('#map-grid .map-tile').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.map!;
        if (!this.randomMap && id === this.selectedMapId) return;
        this.randomMap = false;
        this.selectedMapId = id;
        syncCustomMapSelectionUI();
        this.callbacks.onSelectMap(this.getSelectedMap());
      });
    });

    this.container.querySelectorAll<HTMLButtonElement>('.seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.setPlayerCount(Number(btn.dataset.count));
      });
    });

    this.container.querySelector('#btn-toggle-human')?.addEventListener('click', () => {
      this.toggleHumanMode();
    });

    const randOrderBtn = this.container.querySelector<HTMLButtonElement>('#btn-toggle-random');
    randOrderBtn?.addEventListener('click', () => {
      this.randomizeOrder = !this.randomizeOrder;
      randOrderBtn.classList.toggle('is-on', this.randomizeOrder);
      randOrderBtn.setAttribute('aria-checked', String(this.randomizeOrder));
    });

    const speedSlider = this.container.querySelector<HTMLInputElement>('#speed-slider');
    const speedReadout = this.container.querySelector<HTMLElement>('#speed-readout');
    const syncSpeedUI = (val: number) => {
      const clamped = Math.round(Math.max(0.1, Math.min(2.0, val)) * 10) / 10;
      this.gameSpeed = clamped;
      const pct = ((clamped - 0.1) / 1.9) * 100;
      if (speedSlider) {
        speedSlider.value = clamped.toFixed(1);
        speedSlider.style.setProperty('--speed-pct', `${pct.toFixed(1)}%`);
      }
      if (speedReadout) {
        speedReadout.innerHTML = `<strong>${clamped.toFixed(1)}x</strong> · ${Math.round(clamped * 20)} Hz 逻辑 tick`;
      }
      this.container.querySelectorAll<HTMLButtonElement>('.speed-tick').forEach((tb) => {
        tb.classList.toggle('active', Math.abs(Number(tb.dataset.speed) - clamped) < 0.01);
      });
    };

    speedSlider?.addEventListener('input', () => {
      syncSpeedUI(Number(speedSlider.value));
    });

    this.container.querySelectorAll<HTMLButtonElement>('.speed-tick').forEach((tb) => {
      tb.addEventListener('click', () => {
        syncSpeedUI(Number(tb.dataset.speed));
      });
    });

    this.container.querySelectorAll<HTMLButtonElement>('.picker-trigger').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = Number(btn.dataset.slotPicker);
        this.openDropdown(idx, btn);
      });
    });

    this.container.querySelector('.lobby-card')?.addEventListener('scroll', () => {
      if (this.openSlotIdx !== null) this.closeDropdown();
    });

    this.container.querySelector('#btn-start-match')?.addEventListener('click', () => {
      this.startCustomMatch();
    });
  }
}
