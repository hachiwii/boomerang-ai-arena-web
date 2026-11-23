import { CricketFormat, CricketStore, CricketTier } from '../game/cricketStore';
import { LeaderboardStore } from '../game/leaderboard';
import { formatDashSummary, formatMoveSummary, formatPrimaryBind, SettingsStore } from '../game/settings';
import { MapMeta, MatchConfig, RankedMode, RosterEntry, SlotConfig } from '../game/types';
import { getTheme } from '../render/themes';
import { LeaderboardPanel } from './leaderboardUI';

const DUP_RING_ACCENTS = ['#FF4D6D', '#2EC4B6', '#FFB703', '#8338EC'];
const MAP_POOLS_STORAGE_KEY = 'boomerang_arena_map_pools_v1';
const RECENT_MAPS_STORAGE_KEY = 'boomerang_arena_recent_maps_v1';

interface DraftSlot {
  kind: 'human' | 'bot';
  botId: string;
}

export interface LobbyCallbacks {
  onSelectMap: (map: MapMeta) => void;
  onStartMatch: (config: MatchConfig) => void;
  onOpenHistory: () => void;
  onOpenSettings: () => void;
}

export type LobbyTab = 'ranked' | 'cricket' | 'custom';

/**
 * Generates an inline SVG avatar for the built-in generic humanoid (Human & Sparring hoodies)
 * so every contestant card has a crisp square icon.
 */
export function makeHoodieAvatarDataUrl(hoodColor: string, hairColor: string, label?: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
    <rect x="14" y="10" width="36" height="28" rx="4" fill="${hairColor}" stroke="#2E2238" stroke-width="3"/>
    <rect x="20" y="20" width="24" height="16" fill="#FFDCC2"/>
    <rect x="24" y="23" width="4" height="7" fill="#2B3550"/>
    <rect x="36" y="23" width="4" height="7" fill="#2B3550"/>
    <rect x="25" y="23" width="2" height="2" fill="#FFFFFF"/>
    <rect x="37" y="23" width="2" height="2" fill="#FFFFFF"/>
    <rect x="20" y="32" width="4" height="3" fill="#FF9FA8"/>
    <rect x="40" y="32" width="4" height="3" fill="#FF9FA8"/>
    <rect x="18" y="38" width="28" height="20" rx="3" fill="${hoodColor}" stroke="#2E2238" stroke-width="3"/>
    <rect x="27" y="39" width="2" height="10" fill="#FFFFFF"/>
    <rect x="35" y="39" width="2" height="10" fill="#FFFFFF"/>
    ${label ? `<text x="32" y="55" font-size="9" font-weight="800" fill="#fff" text-anchor="middle" font-family="sans-serif">${label}</text>` : ''}
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

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

export class LobbyUI {
  private readonly container: HTMLDivElement;
  private readonly dropdownMenu: HTMLDivElement;
  private readonly mapPoolModal: HTMLDivElement;
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
  private draggingBotId: string | null = null;
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
  private cliffGuard = true;
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
        this.render();
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

    // Ranked map pool modal portal
    this.mapPoolModal = document.createElement('div');
    this.mapPoolModal.className = 'mappool-backdrop hidden';
    document.body.appendChild(this.mapPoolModal);

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
  }

  public getSelectedMap(): MapMeta {
    return this.maps.find((m) => m.id === this.selectedMapId) || this.maps[0];
  }

  public setCliffGuard(enabled: boolean) {
    this.cliffGuard = enabled;
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

    return {
      matchMode: mode === 'solo' ? 'ranked-solo' : 'ranked-ffa',
      mapId: mapMeta.id,
      mapMeta,
      slots,
      seed,
      speed: 1.0, // Fixed standard speed in Ranked
      cliffGuard: this.cliffGuard,
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
      speed: 1.0,
      cliffGuard: false,
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

  private showCricketNotice(text: string, kind: 'warn' | 'ok') {
    this.cricketNotice = { text, kind };
    if (this.cricketNoticeTimer !== null) window.clearTimeout(this.cricketNoticeTimer);
    this.cricketNoticeTimer = window.setTimeout(() => {
      this.cricketNotice = null;
      this.cricketNoticeTimer = null;
      if (this.activeTab === 'cricket' && !this.container.classList.contains('hidden')) {
        this.render();
      }
    }, 2800);
    this.render();
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
    this.callbacks.onStartMatch({
      matchMode: 'custom',
      mapId: mapMeta.id,
      mapMeta,
      slots,
      seed,
      speed: this.gameSpeed,
      cliffGuard: this.cliffGuard,
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

    const renderBotItem = (b: RosterEntry) => {
      const selected = currentDraft.kind === 'bot' && currentDraft.botId === b.id;
      const isOfficial = b.category === 'official';
      const rankChip =
        isOfficial && b.rank !== null
          ? `<span class="pm-rank">#${b.rank}</span>`
          : `<span class="pm-rank pm-rank-sp">陪练</span>`;
      const score = isOfficial ? this.officialBotScoreForCustom(b) : null;
      const scoreHtml = score !== null ? `<span class="pm-score elo-zero">${score}</span>` : '';
      return `
        <button type="button" class="pm-item ${selected ? 'is-selected' : ''}" data-pick-kind="bot" data-pick-id="${b.id}" role="option" aria-selected="${selected}">
          <img class="pm-avatar" src="${avatarForBotEntry(b)}" alt="" style="border-color:${b.color}" />
          <div class="pm-main">
            <div class="pm-name-row">
              ${rankChip}
              <span class="pm-name">${b.name}</span>
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
    `;

    const rect = triggerEl.getBoundingClientRect();
    const pad = 12;
    const width = Math.max(rect.width, 320);
    const left = Math.max(pad, Math.min(rect.left, window.innerWidth - width - pad));
    const spaceBelow = window.innerHeight - rect.bottom - pad;
    const spaceAbove = rect.top - pad;
    const openUpward = spaceBelow < 340 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(180, Math.min(390, (openUpward ? spaceAbove : spaceBelow) - 8));

    this.dropdownMenu.style.width = `${Math.round(width)}px`;
    this.dropdownMenu.style.maxHeight = `${Math.round(maxHeight)}px`;
    this.dropdownMenu.style.left = `${Math.round(left)}px`;
    if (openUpward) {
      this.dropdownMenu.style.top = 'auto';
      this.dropdownMenu.style.bottom = `${Math.round(window.innerHeight - rect.top + 6)}px`;
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

  private openMapPoolModal(target: 'ranked' | 'cricket' = 'ranked') {
    this.mapPoolTarget = target;
    this.mapPoolOpen = true;
    this.mapPoolWarnText = null;
    this.renderMapPoolModal();
    this.mapPoolModal.classList.remove('hidden');
  }

  private closeMapPoolModal() {
    if (!this.mapPoolOpen && this.mapPoolModal.classList.contains('hidden')) return;
    this.mapPoolOpen = false;
    this.mapPoolWarnText = null;
    this.mapPoolModal.classList.add('hidden');
  }

  private renderMapPoolModal() {
    const isCricket = this.mapPoolTarget === 'cricket';
    const mode = this.rankedMode;
    const poolSet = isCricket ? this.cricket.getMapPoolSet() : this.rankedMapPools[mode];
    const titleName = isCricket ? '斗蛐蛐图池' : `${mode === 'solo' ? 'SOLO' : '四人混战'} 地图池`;

    this.mapPoolModal.innerHTML = `
      <div class="mappool-card" role="dialog" aria-label="${titleName}">
        <div class="mappool-head">
          <div>
            <h3>${titleName}</h3>
            <p class="mappool-sub">已选 <strong>${poolSet.size}</strong> / ${this.maps.length} 张地图${poolSet.size > 3 ? ' · 最近 3 场不重复' : ''}</p>
          </div>
          <div class="mappool-head-actions">
            <button type="button" class="mappool-quick-btn" id="mp-select-all">全选</button>
            <button type="button" class="mappool-quick-btn" id="mp-select-std">仅标准图</button>
            <button type="button" class="mappool-quick-btn" id="mp-select-large">仅大图</button>
            <button type="button" class="mappool-close-btn" id="mp-close">完成</button>
          </div>
        </div>
        ${this.mapPoolWarnText ? `<div class="mappool-warn">${this.mapPoolWarnText}</div>` : ''}
        <div class="mappool-grid">
          ${this.maps
            .map((m) => {
              const checked = poolSet.has(m.id);
              return `
              <button type="button" class="map-tile mappool-tile ${checked ? 'active' : ''}" data-pool-map="${m.id}" aria-pressed="${checked}">
                <span class="mappool-check">${checked ? '✓' : ''}</span>
                <canvas class="map-mini" width="120" height="76" data-pool-canvas="${m.id}"></canvas>
                <div class="map-tile-meta">
                  <span class="map-tile-title">${m.title}</span>
                  <span class="map-tile-tag">${m.category === 'standard' ? '标准' : '大图'}</span>
                </div>
              </button>`;
            })
            .join('')}
        </div>
      </div>
    `;

    for (const m of this.maps) {
      const cvs = this.mapPoolModal.querySelector<HTMLCanvasElement>(`canvas[data-pool-canvas="${m.id}"]`);
      if (cvs) drawMiniMap(cvs, m);
    }

    this.mapPoolModal.onclick = (e) => {
      if (e.target === this.mapPoolModal) {
        this.closeMapPoolModal();
        this.render();
      }
    };

    this.mapPoolModal.querySelector('#mp-close')?.addEventListener('click', () => {
      this.closeMapPoolModal();
      this.render();
    });

    const applyPoolIds = (ids: string[]) => {
      if (ids.length === 0) return;
      if (isCricket) {
        this.cricket.setMapPool(ids);
      } else {
        this.rankedMapPools[mode] = new Set(ids);
        this.saveMapPools();
      }
      this.mapPoolWarnText = null;
      this.renderMapPoolModal();
      this.render();
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

    this.mapPoolModal.querySelectorAll<HTMLButtonElement>('[data-pool-map]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.poolMap!;
        if (isCricket) {
          if (!this.cricket.toggleMap(id)) {
            this.mapPoolWarnText = '图池内至少保留 1 张地图';
            this.renderMapPoolModal();
            return;
          }
        } else {
          const set = this.rankedMapPools[mode];
          if (set.has(id)) {
            if (set.size <= 1) {
              this.mapPoolWarnText = '图池内至少保留 1 张地图';
              this.renderMapPoolModal();
              return;
            }
            set.delete(id);
          } else {
            set.add(id);
          }
          this.saveMapPools();
        }
        this.mapPoolWarnText = null;
        this.renderMapPoolModal();
        this.render();
      });
    });
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
    const kb = this.settings.get().keybindings;
    const mv = formatMoveSummary(kb);
    const thr = formatPrimaryBind(kb.throwRecall);
    const mel = formatPrimaryBind(kb.melee);
    const dsh = formatDashSummary(kb);
    return `
      <div class="controls-legend ${extraClass}">
        <div><kbd>${mv}</kbd> 移动</div>
        <div><kbd>${thr}</kbd> 扔镖 / <kbd>长按</kbd> 召回</div>
        <div><kbd>${mel}</kbd> 挥砍 / 空手踢人</div>
        <div><kbd>${dsh}</kbd> 冲刺越坑</div>
      </div>
    `;
  }

  private renderRankedBody(): string {
    if (this.showLeaderboard) {
      return `<div id="leaderboard-mount"></div>`;
    }

    const mode = this.rankedMode;
    const elo = this.leaderboard.getHumanRating(mode);
    const rk = this.leaderboard.getHumanRank(mode);
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
            </div>
            <div class="rh-divider"></div>
            <div class="rh-metric">
              <div class="rh-metric-label">当前名次</div>
              <div class="rh-rank-num" id="ranked-rank-val">#${rk.rank}<span> / ${rk.total}</span></div>
            </div>
          </div>
        </button>

        <div class="ranked-controls-bar">
          <button type="button" class="mappool-trigger-btn" id="btn-open-map-pool">
            <span class="mpt-icon">🗺️</span>
            <span>地图选择</span>
            <span class="mpt-count" id="mappool-count-badge">${poolCount} / ${this.maps.length}</span>
          </button>

          <button
            type="button"
            class="rand-switch cg-switch ${this.cliffGuard ? 'is-on' : ''}"
            id="btn-toggle-cliff-guard"
            role="switch"
            aria-checked="${this.cliffGuard}"
            title="开启时人类不会走路坠崖；冲刺末尾 25% 若有安全落点会自动停在最远安全点"
          >
            <span class="rand-track"><span class="rand-thumb"></span></span>
            <span class="rand-label">🛡️ 跌落防护</span>
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
    const eloHtml =
      elo !== null
        ? `<span class="cc-elo" title="固定 ELO 分数">${elo}</span>`
        : `<span class="cc-elo is-sparring" title="陪练角色">陪练</span>`;
    const tooltip = `${entry.name}${elo !== null ? ` · 固定 ELO ${elo}` : ' · 陪练'}${hasGames ? ` · ${st.wins}胜/${st.matches}场 · ${st.kills}杀/${st.deaths}死` : ' · 暂无斗蛐蛐战绩'}`;

    return `
      <div
        class="cricket-card is-tier-${tier}"
        draggable="true"
        data-bot-id="${entry.id}"
        data-bot-tier="${tier}"
        title="${tooltip}"
      >
        <div class="cc-top">
          <img class="cc-avatar" src="${avatarForBotEntry(entry)}" alt="${entry.shortName}" style="border-color:${entry.color}" draggable="false" />
          <div class="cc-name-wrap">
            <span class="cc-name">${entry.shortName}</span>
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
      <div class="cricket-empty-slot" aria-hidden="true">
        <span>+ 拖拽角色设为直邀 (${invitedIds.length + i + 1}/${maxP})</span>
      </div>
    `).join('');

    const noticeHtml = this.cricketNotice
      ? `<div class="cricket-notice is-${this.cricketNotice.kind}">${this.cricketNotice.text}</div>`
      : !ready.ok && ready.reason
        ? `<div class="cricket-notice is-warn">${ready.reason}</div>`
        : '';

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
              <span class="mpt-count">${poolCount} / ${this.maps.length}</span>
            </button>
          </div>
          <div class="cricket-toolbar-right">
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

        ${noticeHtml}

        <div class="cricket-board">
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
            <div class="cricket-invited-row" style="--max-invited:${maxP}">
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
              <div class="cricket-card-grid">
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
              <div class="cricket-card-grid">
                ${excludedIds.length > 0 ? renderList(excludedIds, 'excluded') : '<div class="cricket-zone-empty">拖拽角色卡到此处移出本轮</div>'}
              </div>
            </section>
          </div>
        </div>

        <div class="cricket-footer">
          <span class="cricket-footer-hint">拖拽角色卡在三区自由移动 · 随机抽图并随机站位 · 对局中按 <kbd>${rstKey}</kbd> 按相同规则重抽</span>
          <div class="cricket-reset-wrap">
            ${
              this.cricketConfirmReset
                ? `<button type="button" class="cricket-reset-btn confirm" id="btn-cricket-reset-confirm">确认重置胜率/KD？</button>
                   <button type="button" class="cricket-reset-cancel" id="btn-cricket-reset-cancel">取消</button>`
                : `<button type="button" class="cricket-reset-btn" id="btn-cricket-reset" title="重置所有角色胜率与 KD，保留固定 ELO 分数">↺ 重置数据</button>`
            }
          </div>
        </div>
      </div>
    `;
  }

  private bindCricketEvents() {
    this.container.querySelectorAll<HTMLButtonElement>('[data-cricket-format]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = btn.dataset.cricketFormat as CricketFormat;
        if (next === this.cricket.getFormat()) return;
        const demoted = this.cricket.setFormat(next);
        if (demoted > 0) {
          this.showCricketNotice(`切换至 1v1，已将超出的 ${demoted} 名直邀移入抽签池`, 'ok');
        } else {
          this.cricketNotice = null;
          this.render();
        }
      });
    });

    this.container.querySelector('#btn-open-cricket-mappool')?.addEventListener('click', () => {
      this.openMapPoolModal('cricket');
    });

    this.container.querySelector('#btn-start-match')?.addEventListener('click', () => {
      this.startCricketMatch();
    });

    this.container.querySelector('#btn-cricket-reset')?.addEventListener('click', () => {
      this.cricketConfirmReset = true;
      if (this.cricketConfirmTimer !== null) window.clearTimeout(this.cricketConfirmTimer);
      this.cricketConfirmTimer = window.setTimeout(() => {
        this.cricketConfirmReset = false;
        this.cricketConfirmTimer = null;
        if (this.activeTab === 'cricket') this.render();
      }, 5000);
      this.render();
    });

    this.container.querySelector('#btn-cricket-reset-cancel')?.addEventListener('click', () => {
      this.cricketConfirmReset = false;
      if (this.cricketConfirmTimer !== null) {
        window.clearTimeout(this.cricketConfirmTimer);
        this.cricketConfirmTimer = null;
      }
      this.render();
    });

    this.container.querySelector('#btn-cricket-reset-confirm')?.addEventListener('click', () => {
      this.cricketConfirmReset = false;
      if (this.cricketConfirmTimer !== null) {
        window.clearTimeout(this.cricketConfirmTimer);
        this.cricketConfirmTimer = null;
      }
      this.cricket.resetStats();
      this.showCricketNotice('已重置战绩数据（固定 ELO 分数已保留）', 'ok');
    });

    const clearDragVisuals = () => {
      this.container.querySelectorAll('.cricket-zone').forEach((z) => {
        z.classList.remove('is-drag-over', 'is-drag-full');
      });
      this.container.querySelectorAll('.cricket-card').forEach((c) => {
        c.classList.remove('is-dragging', 'is-drop-before');
      });
    };

    this.container.querySelectorAll<HTMLElement>('.cricket-card').forEach((card) => {
      card.addEventListener('dragstart', (e) => {
        const botId = card.dataset.botId;
        if (!botId) return;
        this.draggingBotId = botId;
        if (e.dataTransfer) {
          e.dataTransfer.setData('text/plain', botId);
          e.dataTransfer.effectAllowed = 'move';
        }
        window.requestAnimationFrame(() => card.classList.add('is-dragging'));
      });

      card.addEventListener('dragend', () => {
        this.draggingBotId = null;
        clearDragVisuals();
      });
    });

    this.container.querySelectorAll<HTMLElement>('.cricket-zone').forEach((zoneEl) => {
      const targetTier = zoneEl.dataset.dropTier as CricketTier;

      zoneEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        const botId = this.draggingBotId;
        const maxP = this.cricket.getMaxPlayers();
        const isFull =
          targetTier === 'invited' &&
          this.cricket.getTierIds('invited').length >= maxP &&
          (!botId || this.cricket.getBotTier(botId) !== 'invited');

        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = 'move';
        }
        zoneEl.classList.toggle('is-drag-full', isFull);
        zoneEl.classList.toggle('is-drag-over', !isFull);

        this.container.querySelectorAll('.cricket-card.is-drop-before').forEach((c) => {
          c.classList.remove('is-drop-before');
        });
        if (!isFull) {
          const overCard = (e.target as Element | null)?.closest<HTMLElement>('.cricket-card');
          if (overCard && overCard.dataset.botId && overCard.dataset.botId !== botId) {
            overCard.classList.add('is-drop-before');
          }
        }
      });

      zoneEl.addEventListener('dragleave', (e) => {
        const rel = e.relatedTarget as Node | null;
        if (rel && zoneEl.contains(rel)) return;
        zoneEl.classList.remove('is-drag-over', 'is-drag-full');
        zoneEl.querySelectorAll('.cricket-card.is-drop-before').forEach((c) => {
          c.classList.remove('is-drop-before');
        });
      });

      zoneEl.addEventListener('drop', (e) => {
        e.preventDefault();
        const botId = this.draggingBotId || e.dataTransfer?.getData('text/plain') || '';
        this.draggingBotId = null;
        clearDragVisuals();
        if (!botId) return;

        const overCard = (e.target as Element | null)?.closest<HTMLElement>('.cricket-card');
        const beforeId = overCard && overCard.dataset.botId !== botId ? overCard.dataset.botId : null;
        const res = this.cricket.moveBot(botId, targetTier, beforeId);
        if (!res.ok && res.reason === 'invited_full') {
          this.cricketShakeInvited = true;
          this.showCricketNotice(`直邀数量不能超过比赛总人数（当前上限 ${this.cricket.getMaxPlayers()} 人）`, 'warn');
          window.setTimeout(() => {
            this.cricketShakeInvited = false;
          }, 420);
          return;
        }
        this.cricketNotice = null;
        this.render();
      });
    });
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
            <span class="section-hint">${this.randomMap ? `随机 · 共 ${this.maps.length} 张地图` : `${selectedMap.title} · ${selectedMap.nx * 0.5}×${selectedMap.ny * 0.5}m`}</span>
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
          <div class="map-desc-box">
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

          <div class="cliff-guard-bar ${isHumanPlaying ? '' : 'is-spectate'}">
            <div class="cg-meta">
              <span class="cg-title">🛡️ 跌落防护</span>
              <span class="cg-desc">${isHumanPlaying ? '防走路坠崖 · 冲刺/塌陷/被踢不受影响' : '仅真人参战生效 · 防走路坠崖'}</span>
            </div>
            <button
              type="button"
              class="rand-switch cg-switch ${this.cliffGuard ? 'is-on' : ''}"
              id="btn-toggle-cliff-guard"
              role="switch"
              aria-checked="${this.cliffGuard}"
              title="开启时人类不会走路坠崖；冲刺末尾 25% 若有安全落点会自动停在最远安全点"
            >
              <span class="rand-track"><span class="rand-thumb"></span></span>
              <span class="rand-label">${this.cliffGuard ? '已开启' : '已关闭'}</span>
            </button>
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
    this.closeDropdown();
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

    this.container.innerHTML = `
      <div class="lobby-card ${this.activeTab === 'ranked' && !this.showLeaderboard ? 'lobby-card-ranked' : ''} ${this.activeTab === 'cricket' ? 'lobby-card-cricket' : ''}">
        <header class="lobby-header">
          <div class="lobby-title-group">
            <h1>回旋镖大作战</h1>
          </div>
          <div class="lobby-nav-right lobby-nav-row">
            <div class="lobby-tabs">
              <button class="lobby-tab ${this.activeTab === 'ranked' ? 'active' : ''}" id="tab-ranked">🏆 排位赛</button>
              <button class="lobby-tab ${this.activeTab === 'cricket' ? 'active' : ''}" id="tab-cricket">🦗 斗蛐蛐</button>
              <button class="lobby-tab ${this.activeTab === 'custom' ? 'active' : ''}" id="tab-custom">🎛️ 自定义对局</button>
            </div>
            <button type="button" class="lobby-settings-btn lobby-history-btn" id="btn-open-history" title="查看最近 50 场对局历史与观战回放">📜 对局历史</button>
            <button type="button" class="lobby-settings-btn" id="btn-open-settings" title="音效、帧率上限与键位设置">⚙️ 设置</button>
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
        </header>

        ${bodyHtml}
      </div>
      ${icpFooterHtml}
    `;

    // Bind top tabs, history & settings buttons
    this.container.querySelector('#btn-open-history')?.addEventListener('click', () => {
      this.closeDropdown();
      this.callbacks.onOpenHistory();
    });
    this.container.querySelector('#btn-open-settings')?.addEventListener('click', () => {
      this.closeDropdown();
      this.callbacks.onOpenSettings();
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
          this.render();
        });
      });

      this.container.querySelector('#btn-open-leaderboard')?.addEventListener('click', () => {
        this.showLeaderboard = true;
        this.render();
      });

      this.container.querySelector('#btn-open-map-pool')?.addEventListener('click', () => {
        this.openMapPoolModal('ranked');
      });

      this.container.querySelector('#btn-toggle-cliff-guard')?.addEventListener('click', () => {
        this.cliffGuard = !this.cliffGuard;
        this.render();
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

    this.container.querySelector('#btn-toggle-random-map')?.addEventListener('click', () => {
      this.randomMap = !this.randomMap;
      this.render();
    });

    this.container.querySelectorAll<HTMLButtonElement>('.map-tile').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.map!;
        if (!this.randomMap && id === this.selectedMapId) return;
        this.randomMap = false;
        this.selectedMapId = id;
        this.render();
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

    this.container.querySelector('#btn-toggle-random')?.addEventListener('click', () => {
      this.randomizeOrder = !this.randomizeOrder;
      this.render();
    });

    this.container.querySelector('#btn-toggle-cliff-guard')?.addEventListener('click', () => {
      this.cliffGuard = !this.cliffGuard;
      this.render();
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
