import { LeaderboardStore } from '../game/leaderboard';
import { MapMeta, MatchConfig, RosterEntry, SlotConfig } from '../game/types';
import { getTheme } from '../render/themes';
import { LeaderboardPanel } from './leaderboardUI';

const DUP_RING_ACCENTS = ['#FF4D6D', '#2EC4B6', '#FFB703', '#8338EC'];

interface DraftSlot {
  kind: 'human' | 'bot';
  botId: string;
}

export interface LobbyCallbacks {
  onSelectMap: (map: MapMeta) => void;
  onStartMatch: (config: MatchConfig) => void;
}

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
  // Count occurrences of each botId to decide duplicate numbering
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

  // Sky backdrop
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

function formatEloScore(v: number): string {
  const r = Math.round(v * 10) / 10;
  return r > 0 ? `+${r.toFixed(1)}` : r.toFixed(1);
}

function eloScoreClass(v: number): string {
  if (v > 0.05) return 'elo-pos';
  if (v < -0.05) return 'elo-neg';
  return 'elo-zero';
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
  private readonly maps: MapMeta[];
  private readonly roster: RosterEntry[];
  private readonly leaderboard: LeaderboardStore;
  private readonly leaderboardPanel: LeaderboardPanel;
  private readonly callbacks: LobbyCallbacks;

  private activeTab: 'play' | 'leaderboard' = 'play';
  private selectedMapId: string;
  private drafts: DraftSlot[];
  private randomizeOrder = true;
  private openSlotIdx: number | null = null;
  private loadingMessage: string | null = null;

  constructor(
    root: HTMLElement,
    maps: MapMeta[],
    roster: RosterEntry[],
    leaderboard: LeaderboardStore,
    callbacks: LobbyCallbacks,
  ) {
    this.maps = maps;
    this.roster = roster;
    this.leaderboard = leaderboard;
    this.callbacks = callbacks;
    this.selectedMapId = maps[0]?.id || 'twinlakes';
    this.leaderboardPanel = new LeaderboardPanel(leaderboard, () => this.updateHeaderElo());

    // Default setup: Human + 3 diverse top AI bots (4-player melee!)
    this.drafts = [
      { kind: 'human', botId: 'gpt-6.2-astra' },
      { kind: 'bot', botId: 'gpt-6.2-astra' },
      { kind: 'bot', botId: 'claude-fable-5.2' },
      { kind: 'bot', botId: 'gemini-4-carbon' },
    ];

    this.container = document.createElement('div');
    this.container.className = 'lobby-overlay';
    root.appendChild(this.container);

    // Portal custom dropdown mounted on body so it never clips inside overflow containers
    this.dropdownMenu = document.createElement('div');
    this.dropdownMenu.className = 'picker-menu hidden';
    this.dropdownMenu.setAttribute('role', 'listbox');
    document.body.appendChild(this.dropdownMenu);

    window.addEventListener('mousedown', (e) => {
      if (this.openSlotIdx === null) return;
      const target = e.target as Node | null;
      if (target && this.dropdownMenu.contains(target)) return;
      if (target instanceof Element && target.closest('.picker-trigger')) return;
      this.closeDropdown();
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this.openSlotIdx !== null) {
        this.closeDropdown();
      }
    });
    window.addEventListener('resize', () => {
      if (this.openSlotIdx !== null) this.closeDropdown();
    });

    this.render();
  }

  public show(tab: 'play' | 'leaderboard' = 'play') {
    this.closeDropdown();
    this.loadingMessage = null;
    this.activeTab = tab;
    this.container.classList.remove('hidden');
    this.render();
  }

  public hide() {
    this.closeDropdown();
    this.leaderboardPanel.hideTooltip();
    this.container.classList.add('hidden');
  }

  private closeDropdown() {
    if (this.openSlotIdx === null && this.dropdownMenu.classList.contains('hidden')) return;
    this.openSlotIdx = null;
    this.dropdownMenu.classList.add('hidden');
    this.container.querySelectorAll('.picker-trigger.open').forEach((el) => el.classList.remove('open'));
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
    const humanElo = this.leaderboard.getHumanRating();
    const humanAvatar = makeHoodieAvatarDataUrl('#3B78F0', '#262A33');

    const officialBots = this.roster.filter((r) => r.category === 'official');
    const sparringBots = this.roster.filter((r) => r.category === 'sparring');

    const renderBotItem = (b: RosterEntry) => {
      const selected = currentDraft.kind === 'bot' && currentDraft.botId === b.id;
      const rankChip = b.rank !== null ? `<span class="pm-rank">#${b.rank}</span>` : `<span class="pm-rank pm-rank-sp">陪练</span>`;
      return `
        <button type="button" class="pm-item ${selected ? 'is-selected' : ''}" data-pick-kind="bot" data-pick-id="${b.id}" role="option" aria-selected="${selected}">
          <img class="pm-avatar" src="${avatarForBotEntry(b)}" alt="" style="border-color:${b.color}" />
          <div class="pm-main">
            <div class="pm-name-row">
              ${rankChip}
              <span class="pm-name">${b.name}</span>
            </div>
          </div>
          <span class="pm-score ${eloScoreClass(b.rating)}">${formatEloScore(b.rating)}</span>
          <span class="pm-check">${selected ? '✓' : ''}</span>
        </button>`;
    };

    this.dropdownMenu.innerHTML = `
      <div class="pm-section-label">真人玩家（全队限 1 名）</div>
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
        <span class="pm-score ${eloScoreClass(humanElo)}">${formatEloScore(humanElo)}</span>
        <span class="pm-check">${humanSelectedHere ? '✓' : ''}</span>
      </button>

      <div class="pm-section-label">正式海选 AI（13 位 · WASM）</div>
      ${officialBots.map(renderBotItem).join('')}

      <div class="pm-section-label">官方陪练（热身推荐）</div>
      ${sparringBots.map(renderBotItem).join('')}
    `;

    // Position cleanly relative to trigger, flipping upward if closer to bottom of viewport
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

    // Scroll active item into view nicely
    const activeItem = this.dropdownMenu.querySelector<HTMLElement>('.pm-item.is-selected');
    if (activeItem) {
      activeItem.scrollIntoView({ block: 'nearest' });
    }

    // Bind item clicks
    this.dropdownMenu.querySelectorAll<HTMLButtonElement>('.pm-item').forEach((item) => {
      item.addEventListener('click', () => {
        if (item.disabled || item.classList.contains('is-disabled')) return;
        const pickKind = item.dataset.pickKind as 'human' | 'bot';
        const pickId = item.dataset.pickId!;

        if (pickKind === 'human') {
          // Guard: never allow duplicate human if another slot is already human
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

  private updateHeaderElo() {
    const pill = this.container.querySelector<HTMLElement>('#header-elo-pill');
    if (!pill) return;
    const elo = this.leaderboard.getHumanRating();
    const rk = this.leaderboard.getHumanRank();
    const fmt = elo > 0 ? `+${elo.toFixed(1)}` : elo.toFixed(1);
    pill.textContent = `玩家 Elo ${fmt} · #${rk.rank}/${rk.total}`;
  }

  public setLoading(msg: string | null) {
    this.loadingMessage = msg;
    const btn = this.container.querySelector<HTMLButtonElement>('#btn-start-match');
    if (btn) {
      btn.disabled = msg !== null;
      btn.textContent = msg ? msg : (this.hasHuman() ? '开始对战' : '开始 AI 观战');
    }
  }

  public getSelectedMap(): MapMeta {
    return this.maps.find((m) => m.id === this.selectedMapId) || this.maps[0];
  }

  private hasHuman(): boolean {
    return this.drafts.some((d) => d.kind === 'human');
  }

  private toggleHumanMode() {
    if (this.hasHuman()) {
      // Switch to pure AI spectator mode: replace human slot with Opus
      this.drafts = this.drafts.map((d) =>
        d.kind === 'human' ? { kind: 'bot', botId: 'claude-opus-5.5' } : d,
      );
    } else {
      // Put human into slot 0
      this.drafts[0] = { kind: 'human', botId: this.drafts[0].botId };
    }
    this.render();
  }

  private applyPreset(preset: 'duel' | 'human4' | 'spectate4' | 'mirror4') {
    if (preset === 'duel') {
      this.drafts = [
        { kind: 'human', botId: 'sparring-mid' },
        { kind: 'bot', botId: 'sparring-mid' },
      ];
    } else if (preset === 'human4') {
      this.drafts = [
        { kind: 'human', botId: 'gpt-6.2-astra' },
        { kind: 'bot', botId: 'gpt-6.2-astra' },
        { kind: 'bot', botId: 'claude-fable-5.2' },
        { kind: 'bot', botId: 'claude-opus-5.5' },
      ];
    } else if (preset === 'spectate4') {
      this.drafts = [
        { kind: 'bot', botId: 'gpt-6.2-astra' },
        { kind: 'bot', botId: 'claude-fable-5.2' },
        { kind: 'bot', botId: 'claude-opus-5.5' },
        { kind: 'bot', botId: 'gemini-4-carbon' },
      ];
    } else if (preset === 'mirror4') {
      this.drafts = [
        { kind: 'bot', botId: 'gpt-6.2-astra' },
        { kind: 'bot', botId: 'gpt-6.2-astra' },
        { kind: 'bot', botId: 'gpt-6.2-astra' },
        { kind: 'bot', botId: 'gpt-6.2-astra' },
      ];
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

  private startMatch() {
    if (this.loadingMessage) return;
    const mapMeta = this.getSelectedMap();
    const slots = resolveSlots(this.drafts, this.roster);
    if (this.randomizeOrder) {
      // Fisher-Yates shuffle spawn order on entry while keeping lobby order intact
      for (let i = slots.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [slots[i], slots[j]] = [slots[j], slots[i]];
      }
    }
    const seed = Math.floor(Math.random() * 900000) + 1;
    this.callbacks.onStartMatch({
      mapId: mapMeta.id,
      mapMeta,
      slots,
      seed,
    });
  }

  private render() {
    this.closeDropdown();
    const selectedMap = this.getSelectedMap();
    const resolved = resolveSlots(this.drafts, this.roster);
    const isHumanPlaying = this.hasHuman();
    const rosterById = new Map(this.roster.map((r) => [r.id, r]));

    const humanElo = this.leaderboard.getHumanRating();
    const humanEloTxt = formatEloScore(humanElo);
    const humanRk = this.leaderboard.getHumanRank();

    this.container.innerHTML = `
      <div class="lobby-card">
        <header class="lobby-header">
          <div class="lobby-title-group">
            <div class="lobby-badge">MEOW AI ARENA · WEB WASM</div>
            <h1>回旋镖大作战</h1>
            <p class="lobby-sub">官方 C++ 引擎 & 16 个 AI Bot 全量 WASM · AI 0.2s 延迟 / 真人零延迟 · 20Hz 逻辑 / 240Hz+ 渲染</p>
          </div>
          <div class="lobby-nav-right">
            <div class="lobby-tabs">
              <button class="lobby-tab ${this.activeTab === 'play' ? 'active' : ''}" id="tab-play">⚔️ 对局配置</button>
              <button class="lobby-tab ${this.activeTab === 'leaderboard' ? 'active' : ''}" id="tab-leaderboard">
                🏆 排行榜
                <span class="tab-elo-pill" id="header-elo-pill">玩家 Elo ${humanEloTxt} · #${humanRk.rank}/${humanRk.total}</span>
              </button>
            </div>
            ${
              this.activeTab === 'play'
                ? `<div class="lobby-presets">
                    <button class="preset-btn" data-preset="duel">人机 1v1</button>
                    <button class="preset-btn" data-preset="human4">真人 4人混战</button>
                    <button class="preset-btn" data-preset="spectate4">AI 巅峰观战</button>
                    <button class="preset-btn" data-preset="mirror4">4×Astra 镜像战</button>
                  </div>`
                : ''
            }
          </div>
        </header>

        ${
          this.activeTab === 'leaderboard'
            ? `<div id="leaderboard-mount"></div>`
            : `<div class="lobby-grid">
          <section class="lobby-section">
            <div class="section-head">
              <h2>选择地图</h2>
              <span class="section-hint">${selectedMap.title} · ${selectedMap.nx * 0.5}×${selectedMap.ny * 0.5}m</span>
            </div>
            <div class="map-grid" id="map-grid">
              ${this.maps
                .map(
                  (m) => `
                <button class="map-tile ${m.id === this.selectedMapId ? 'active' : ''}" data-map="${m.id}">
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
              <strong>${selectedMap.title} (${selectedMap.id})</strong>：${selectedMap.desc}
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
                  const score = isHuman ? humanElo : (botEntry?.rating ?? 0);
                  const roleChip = isHuman
                    ? `<span class="pk-chip pk-chip-human">真人</span>`
                    : botEntry?.rank !== null && botEntry?.rank !== undefined
                      ? `<span class="pk-chip pk-chip-official">#${botEntry.rank} AI</span>`
                      : `<span class="pk-chip pk-chip-sparring">陪练</span>`;
                  const subText = isHuman
                    ? '示范小人 (蓝帽衫) · 零延迟操控'
                    : botEntry?.category === 'official'
                      ? `${slot.baseName} · WASM (0.2s 延迟)`
                      : `${slot.baseName} · 陪练 WASM`;
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
                        <div class="pk-sub">${subText}</div>
                      </div>
                      <div class="pk-right">
                        <span class="pk-score ${eloScoreClass(score)}">${formatEloScore(score)}</span>
                        <svg class="pk-chevron" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                      </div>
                    </button>
                  </div>`;
                })
                .join('')}
            </div>

            <div class="controls-legend">
              <div><kbd>WASD</kbd> 移动</div>
              <div><kbd>左键</kbd> 向鼠标扔镖 / <kbd>长按</kbd> 召回</div>
              <div><kbd>右键</kbd> 挥砍 / 空手踢人</div>
              <div><kbd>Shift</kbd> 冲刺越坑</div>
            </div>

            <button class="start-btn" id="btn-start-match" ${this.loadingMessage ? 'disabled' : ''}>
              ${this.loadingMessage || (isHumanPlaying ? '开始对战' : '开始 AI 观战')}
            </button>
          </section>
        </div>`
        }
      </div>
    `;

    // Bind tabs
    this.container.querySelector('#tab-play')?.addEventListener('click', () => {
      if (this.activeTab === 'play') return;
      this.activeTab = 'play';
      this.leaderboardPanel.hideTooltip();
      this.render();
    });
    this.container.querySelector('#tab-leaderboard')?.addEventListener('click', () => {
      if (this.activeTab === 'leaderboard') return;
      this.activeTab = 'leaderboard';
      this.render();
    });

    if (this.activeTab === 'leaderboard') {
      const mount = this.container.querySelector<HTMLElement>('#leaderboard-mount');
      if (mount) this.leaderboardPanel.renderInto(mount);
      return;
    }

    // Paint minimaps
    for (const m of this.maps) {
      const cvs = this.container.querySelector<HTMLCanvasElement>(`canvas[data-map-canvas="${m.id}"]`);
      if (cvs) drawMiniMap(cvs, m);
    }

    // Bind events
    this.container.querySelectorAll<HTMLButtonElement>('.map-tile').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.map!;
        if (id === this.selectedMapId) return;
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

    this.container.querySelectorAll<HTMLButtonElement>('.preset-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.applyPreset(btn.dataset.preset as 'duel' | 'human4' | 'spectate4' | 'mirror4');
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
      this.startMatch();
    });
  }
}
