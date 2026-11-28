// 大厅「团队赛」页：左右两队各五个席位（原版 10 个团队终版 bot + 玩家），每席一个战术按钮，列顶的队名下拉
// （整队换成 Astra 队 / Fable 队）和策略下拉（原版预设 + 布局），右侧地图（三张竖排）、游戏速度和开始按钮。
// 状态按地图分开保存战术和布阵（阵容三张图共用），存在 localStorage。
import { generateBgmSeed } from '../audio/bgm';
import { getSlashJudgmentTicks, SettingsStore } from '../game/settings';
import {
  carryTactic,
  classifyTeam,
  defaultSpawnsFromMap,
  emptyTactic,
  formationProblems,
  loadTeamPresets,
  MapGrid,
  OrigTeam,
  parseMapGrid,
  PlanIssue,
  PointName,
  roundSpawn,
  SIDE_COLOR,
  slotNames,
  SlotTactic,
  SpawnM,
  tacticButtonLabel,
  TEAM_COLOR,
  TEAM_LABEL,
  TEAM_MAPS,
  TEAM_ROSTER,
  teamBot,
  TeamJob,
  teamMap,
  TeamMapId,
  TeamMatchSetup,
  TeamModeNum,
  TeamPresetRound,
  TeamSlotDraft,
  validateAdvanced,
  buildSeatPlans,
  splitPresetPlan,
  ASTRA_CMDS,
  FABLE_KEYS,
} from '../game/teamMatch';
import { generateSpawnSeed, MapMeta, MatchConfig } from '../game/types';
import { clientToLogical, getLogicalViewport, rectToLogical } from '../game/viewport';
import { buildTeamSlotConfigs } from '../game/teamRoomMatch';
import { teamRoom, teamRoomUrl, type TeamRoomSnapshot } from '../net/teamRoomClient';
import { TEAM_ROOM_MAX_MEMBERS, type RoomMatchStart } from '../net/teamRoomProtocol';
import { makeHoodieAvatarDataUrl } from './hoodieAvatar';

const STORE_KEY = 'boomerang_team_lobby_v2';
/** 每张图默认套用的原版预设：同一张图后一回合的正式方案（上游网页版也这样配）。 */
const DEFAULT_ROUND: Record<TeamMapId, number> = { caldera: 2, piers: 4, keeps: 6 };
const HUMAN_AVATAR = makeHoodieAvatarDataUrl('#3B78F0', '#262A33');
const HUMAN_RING = '#E8EEFC';

interface SideMapState {
  tactics: SlotTactic[];
  spawns: SpawnM[];
  /** 当前套用的预设（例如「第 4 回合 · 正式」）；之后改过战术或布局就清空 */
  preset: string | null;
}
interface SideState {
  slots: TeamSlotDraft[];
  maps: Record<TeamMapId, SideMapState>;
}
interface PanelState {
  mapId: TeamMapId;
  speed: number;
  sides: [SideState, SideState];
}

export interface TeamLobbyCallbacks {
  settings: SettingsStore;
  onStartMatch: (config: MatchConfig) => void;
  /** 联机房主点开始：把开局信息交给 main（发给房间并在本机开局） */
  onStartRoomMatch: (start: RoomMatchStart) => void;
  /** 房间里正在打：进去观战（向中转要开局信息和已有的每一步） */
  onWatchRoomMatch: () => void;
  /** 地图变了（或刚进这一页）：大厅背景换成这张图 */
  onPreviewMap: (map: MapMeta) => void;
  /** 空闲时把另外两张团队图的预览先准备好 */
  onPrewarmMaps?: (maps: MapMeta[]) => void;
  isLoading: () => boolean;
}

const teamRoomAvailable = () => teamRoomUrl() !== null;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);
}

const CELL_COLORS: Record<string, Record<string, string>> = {
  caldera: { '.': '#6b4a3a', '"': '#7a5a2e', '#': '#3a2a26', '~': '#ff5a1f', bg: '#2a1410' },
  piers: { '.': '#b58a5a', '"': '#7fae55', '#': '#6e6258', '~': '#2b6fa8', bg: '#173c5e' },
  keeps: { '.': '#a89c86', '"': '#7da35a', '#': '#5d5a5f', '~': '#1c2433', bg: '#121826' },
};

function drawMapCanvas(cvs: HTMLCanvasElement, mapId: TeamMapId, grid: MapGrid, opts?: { deploy?: boolean; points?: boolean }) {
  const ctx = cvs.getContext('2d');
  if (!ctx) return { scale: 1, ox: 0, oy: 0 };
  const pal = CELL_COLORS[mapId];
  const w = cvs.width, h = cvs.height;
  ctx.fillStyle = pal.bg;
  ctx.fillRect(0, 0, w, h);
  const cs = Math.min(w / grid.nx, h / grid.ny);
  const ox = (w - grid.nx * cs) / 2, oy = (h - grid.ny * cs) / 2;
  for (let y = 0; y < grid.ny; y++)
    for (let x = 0; x < grid.nx; x++) {
      const ch = grid.cells[y]?.[x] ?? '~';
      if (ch === '~' && mapId === 'keeps') continue;
      ctx.fillStyle = pal[ch] || pal['.'];
      ctx.fillRect(ox + x * cs, oy + y * cs, Math.ceil(cs), Math.ceil(cs));
    }
  const m = teamMap(mapId);
  const scale = cs * 2; // 像素 / 米（格子 0.5 米）
  if (opts?.deploy) {
    const [x0, y0, x1, y1] = m.deploy;
    ctx.strokeStyle = 'rgba(140, 200, 255, 0.95)';
    ctx.fillStyle = 'rgba(61, 126, 255, 0.16)';
    ctx.lineWidth = Math.max(1.5, cs * 0.25);
    ctx.setLineDash([cs * 0.8, cs * 0.5]);
    ctx.fillRect(ox + x0 * scale, oy + y0 * scale, (x1 - x0) * scale, (y1 - y0) * scale);
    ctx.strokeRect(ox + x0 * scale, oy + y0 * scale, (x1 - x0) * scale, (y1 - y0) * scale);
    ctx.setLineDash([]);
  }
  if (opts?.points && m.mode === 4) {
    const pts: [string, number, number][] = [['A', 16, 3.25], ['B', 16, 10], ['C', 16, 16.75]];
    for (const [nm, px, py] of pts) {
      ctx.strokeStyle = 'rgba(255, 230, 140, 0.9)';
      ctx.lineWidth = Math.max(1.5, cs * 0.2);
      ctx.beginPath();
      ctx.arc(ox + px * scale, oy + py * scale, 2 * scale, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255, 240, 190, 0.95)';
      ctx.font = `800 ${Math.max(10, cs * 2.2)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(nm, ox + px * scale, oy + py * scale);
    }
  }
  return { scale, ox, oy };
}

export class TeamLobbyPanel {
  private state: PanelState | null = null;
  private presets: TeamPresetRound[] = [];
  private mapTexts = new Map<TeamMapId, string>();
  private grids = new Map<TeamMapId, MapGrid>();
  private ready: Promise<void>;
  private host: HTMLElement | null = null;
  private readonly menu: HTMLDivElement;
  private readonly modal: HTMLDivElement;
  private menuOwner: string | null = null;
  /** 进房当客人时把自己本地的配置收起来，退出房间时恢复 */
  private localState: PanelState | null = null;
  private role: 'none' | 'host' | 'guest' = 'none';
  private codeDraft = '';
  private lobbySendTimer: number | null = null;
  /** 在房间里时自己的成员 id（退出房间后快照里的 id 已经清零，收尾时用这个） */
  private lastMe = 0;

  constructor(private readonly cb: TeamLobbyCallbacks) {
    this.menu = document.createElement('div');
    this.menu.className = 'picker-menu team-menu hidden';
    document.body.appendChild(this.menu);
    this.modal = document.createElement('div');
    this.modal.className = 'team-modal-backdrop hidden';
    document.body.appendChild(this.modal);
    this.menu.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => this.closeMenu());
    window.addEventListener('resize', () => this.closeMenu());
    this.ready = this.load();
    teamRoom.onChange((snap) => void this.ready.then(() => this.onRoomChange(snap)));
    teamRoom.onLobby((lobby) => void this.ready.then(() => this.onRoomLobby(lobby)));
    teamRoom.onClaim((c) =>
      void this.ready.then(() => ('unclaim' in c ? this.handleUnclaim(c.from) : this.handleClaim(c.from, c.side, c.slot))),
    );
  }

  // ---------------------------------------------------------------- 联机房间

  private get myId(): number {
    return teamRoom.state.me;
  }

  private memberName(id: number | undefined): string | null {
    return id === undefined ? null : teamRoom.memberName(id);
  }

  private get readOnly(): boolean {
    return this.role === 'guest';
  }

  private onRoomChange(snap: TeamRoomSnapshot) {
    const inRoom = snap.status === 'in-room' && snap.room !== null;
    if (inRoom) this.lastMe = snap.me;
    const nextRole: typeof this.role = !inRoom ? 'none' : snap.room!.hostId === snap.me ? 'host' : 'guest';
    const prevRole = this.role;
    if (nextRole !== prevRole) {
      this.role = nextRole;
      if (prevRole === 'none' && nextRole === 'host') {
        // 自己建的房：本地的玩家席换成「我」，大厅状态发给后进来的人
        this.state!.sides.forEach((side, si) =>
          side.slots.forEach((sl, i) => {
            if (sl.kind === 'human' && sl.member === undefined) side.slots[i] = { kind: 'human', member: snap.me, prev: TEAM_ROSTER[si === 0 ? 'astra' : 'fable'][i] };
          }),
        );
      } else if (prevRole === 'none' && nextRole === 'guest') {
        this.localState = this.state;
      } else if (nextRole === 'none') {
        if (prevRole === 'guest' && this.localState) this.state = this.localState;
        else if (prevRole === 'host') this.leaveRoomSlots();
        this.localState = null;
      }
      // guest → host（原房主走了）：接着用最后收到的那份大厅状态
    }
    if (this.role === 'host') {
      // 有人退出房间：他的席位还给原来的 bot
      const present = new Set(snap.room!.members.map((m) => m.id));
      let changed = false;
      this.state!.sides.forEach((side, si) =>
        side.slots.forEach((sl, i) => {
          if (sl.kind === 'human' && sl.member !== undefined && !present.has(sl.member)) {
            this.releaseSlot(si as 0 | 1, i);
            changed = true;
          }
        }),
      );
      if (changed || nextRole !== prevRole) this.persist();
    }
    if (nextRole !== prevRole) this.render();
    else this.renderRoomBar();
  }

  private onRoomLobby(lobby: unknown) {
    if (this.role === 'host') {
      // 刚接手房主：用最后一份大厅状态
      const st = this.validLobby(lobby);
      if (st && this.state !== st) {
        this.state = st;
        this.persist();
        this.render();
      }
      return;
    }
    if (this.role !== 'guest') return;
    const st = this.validLobby(lobby);
    if (!st) return;
    const mapChanged = st.mapId !== this.state?.mapId;
    this.state = st;
    this.closeMenu();
    this.render();
    if (mapChanged) this.cb.onPreviewMap(this.previewMeta());
  }

  private validLobby(v: unknown): PanelState | null {
    const st = v as PanelState;
    try {
      if (!st || !TEAM_MAPS.some((m) => m.id === st.mapId) || !Array.isArray(st.sides) || st.sides.length !== 2) return null;
      for (const side of st.sides) {
        if (!Array.isArray(side.slots) || side.slots.length !== 5) return null;
        if (!side.slots.every((x) => x && (x.kind === 'human' || (x.kind === 'bot' && teamBot(x.botId!))))) return null;
        for (const m of TEAM_MAPS) {
          const ms = side.maps?.[m.id];
          if (!ms || ms.tactics?.length !== 5 || ms.spawns?.length !== 5) return null;
        }
      }
      st.speed = Math.max(0.1, Math.min(2, Number(st.speed) || 1));
      return st;
    } catch {
      return null;
    }
  }

  /** 一位成员坐进一个 bot 席：记住原来的 bot 和它每张图的战术，交还时原样恢复 */
  private seatMember(sideIdx: 0 | 1, slotIdx: number, member: number) {
    const side = this.state!.sides[sideIdx];
    const cur = side.slots[slotIdx];
    if (cur.kind !== 'bot') return;
    const prevTactics: Partial<Record<TeamMapId, SlotTactic>> = {};
    const next: TeamSlotDraft = { kind: 'human', member, prev: cur.botId, prevTactics };
    for (const m of TEAM_MAPS) {
      const ms = side.maps[m.id];
      prevTactics[m.id] = { ...ms.tactics[slotIdx] };
      ms.tactics[slotIdx] = carryTactic(ms.tactics[slotIdx], cur, next);
      ms.preset = null;
    }
    side.slots[slotIdx] = next;
  }

  /** 真人席交还给原来的 bot（战术也恢复） */
  private releaseSlot(sideIdx: 0 | 1, slotIdx: number) {
    const side = this.state!.sides[sideIdx];
    const cur = side.slots[slotIdx];
    if (cur.kind !== 'human') return;
    const botId = cur.prev && teamBot(cur.prev) ? cur.prev : TEAM_ROSTER[sideIdx === 0 ? 'astra' : 'fable'][slotIdx];
    const next: TeamSlotDraft = { kind: 'bot', botId };
    for (const m of TEAM_MAPS) {
      const ms = side.maps[m.id];
      ms.tactics[slotIdx] = cur.prevTactics?.[m.id] ? { ...cur.prevTactics[m.id]! } : carryTactic(ms.tactics[slotIdx], cur, next);
      ms.preset = null;
    }
    side.slots[slotIdx] = next;
  }

  private releaseMember(member: number) {
    this.state!.sides.forEach((side, si) =>
      side.slots.forEach((sl, i) => {
        if (sl.kind === 'human' && sl.member === member) this.releaseSlot(si as 0 | 1, i);
      }),
    );
  }

  private mySlot(): [0 | 1, number] | null {
    if (!this.state || this.role === 'none') return null;
    for (const [si, side] of this.state.sides.entries()) {
      const i = side.slots.findIndex((x) => x.kind === 'human' && x.member === this.myId);
      if (i >= 0) return [si as 0 | 1, i];
    }
    return null;
  }

  /** 房主退出房间：自己的席位变回本地玩家，别人的还给 bot */
  private leaveRoomSlots() {
    const me = this.lastMe;
    this.state!.sides.forEach((side, si) =>
      side.slots.forEach((sl, i) => {
        if (sl.kind !== 'human' || sl.member === undefined) return;
        if (sl.member === me) side.slots[i] = { kind: 'human' };
        else this.releaseSlot(si as 0 | 1, i);
      }),
    );
    // 没留下自己的席位时也可能还有多个玩家席（不该发生），只留一个
    let seen = false;
    this.state!.sides.forEach((side, si) =>
      side.slots.forEach((sl, i) => {
        if (sl.kind !== 'human') return;
        if (seen) this.releaseSlot(si as 0 | 1, i);
        seen = true;
      }),
    );
    this.persist();
  }

  private handleClaim(from: number, sideIdx: number, slotIdx: number) {
    if (this.role !== 'host' || !this.state) return;
    const target = this.state.sides[sideIdx]?.slots[slotIdx];
    if (!target || target.kind !== 'bot') return;
    this.releaseMember(from);
    this.seatMember(sideIdx as 0 | 1, slotIdx, from);
    this.persist();
    this.render();
  }

  private handleUnclaim(from: number) {
    if (this.role !== 'host' || !this.state) return;
    this.releaseMember(from);
    this.persist();
    this.render();
  }

  private sendLobbySoon() {
    if (this.role !== 'host' || this.lobbySendTimer !== null) return;
    this.lobbySendTimer = window.setTimeout(() => {
      this.lobbySendTimer = null;
      if (this.role === 'host' && this.state) teamRoom.send({ type: 'lobby', lobby: this.state });
    }, 60);
  }

  private renderRoomBar() {
    const bar = this.host?.querySelector<HTMLElement>('#team-room-bar');
    if (!bar) return;
    const snap = teamRoom.state;
    const err = snap.error ? `<span class="trb-err">${esc(snap.error)}</span>` : '';
    if (snap.status === 'in-room' && snap.room) {
      const me = snap.room.members.find((m) => m.id === snap.me);
      const host = snap.room.members.find((m) => m.id === snap.room!.hostId);
      const rtt = snap.rttMs === null ? '--' : `${snap.rttMs}ms`;
      const lvl = snap.rttMs === null ? '' : snap.rttMs <= 80 ? 'good' : snap.rttMs <= 160 ? 'ok' : 'bad';
      bar.className = 'team-room-bar is-in';
      bar.innerHTML = `
        <span class="trb-chip trb-code" title="把房间号发给朋友，他们输入后点「加入房间」">房间 <strong>${snap.room.code}</strong></span>
        <span class="trb-chip">我 <strong>${esc(me?.name ?? '')}</strong>${snap.room.hostId === snap.me ? '<em class="trb-host">房主</em>' : ''}</span>
        <span class="trb-chip" title="${esc(snap.room.members.map((m) => m.name + (m.id === snap.room!.hostId ? '（房主）' : '')).join('、'))}">👥 <strong>${snap.room.members.length}</strong>/${TEAM_ROOM_MAX_MEMBERS}</span>
        <span class="trb-chip trb-rtt ${lvl}">延迟 <strong>${rtt}</strong></span>
        ${snap.match ? `<button type="button" class="trb-btn trb-watch" id="trb-watch">对局进行中 · 进入</button>` : ''}
        <span class="trb-gap"></span>
        ${this.role === 'guest' ? `<span class="trb-hint">房主 ${esc(host?.name ?? '')} 设置阵容；点一个 bot 席位顶替上场</span>` : ''}
        ${err}
        <button type="button" class="trb-btn ghost" id="trb-leave">退出房间</button>`;
      bar.querySelector('#trb-leave')?.addEventListener('click', () => teamRoom.leave());
      bar.querySelector('#trb-watch')?.addEventListener('click', () => this.cb.onWatchRoomMatch());
      return;
    }
    const connecting = snap.status === 'connecting';
    bar.className = 'team-room-bar';
    bar.innerHTML = `
      <span class="trb-title">🌐 联机</span>
      <button type="button" class="trb-btn primary" id="trb-create" ${connecting ? 'disabled' : ''}>创建房间</button>
      <input type="text" class="trb-input" id="trb-code" inputmode="numeric" maxlength="6" placeholder="房间号" autocomplete="off" value="${esc(this.codeDraft)}" ${connecting ? 'disabled' : ''} />
      <button type="button" class="trb-btn" id="trb-join" ${connecting ? 'disabled' : ''}>加入房间</button>
      ${connecting ? '<span class="trb-hint">连接中…</span>' : err || '<span class="trb-hint">最多 20 人；房主设置阵容，其他人点 bot 席位顶替上场</span>'}`;
    const input = bar.querySelector<HTMLInputElement>('#trb-code')!;
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(0, 6);
      this.codeDraft = input.value;
    });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') teamRoom.join(input.value);
    });
    bar.querySelector('#trb-create')?.addEventListener('click', () => teamRoom.create());
    bar.querySelector('#trb-join')?.addEventListener('click', () => teamRoom.join(input.value));
  }

  private async load() {
    const [presets] = await Promise.all([
      loadTeamPresets(),
      ...TEAM_MAPS.map(async (m) => {
        const r = await fetch(`/assets/maps/team/${m.id}.txt?v=${__BUILD_ID__}`);
        const text = await r.text();
        this.mapTexts.set(m.id, text);
        this.grids.set(m.id, parseMapGrid(text));
      }),
    ]);
    this.presets = presets;
    this.state = this.restore() ?? this.defaultState();
  }

  // ---------------------------------------------------------------- 状态

  private defaultSide(team: OrigTeam, humanAt = -1): SideState {
    const slots: TeamSlotDraft[] = TEAM_ROSTER[team].map((id, i) => (i === humanAt ? { kind: 'human' } : { kind: 'bot', botId: id }));
    const side: SideState = { slots, maps: {} as Record<TeamMapId, SideMapState> };
    for (const m of TEAM_MAPS) {
      side.maps[m.id] = { tactics: slots.map(() => emptyTactic()), spawns: this.mapDefaultSpawns(m.id), preset: null };
      this.applyPreset(side, m.id, DEFAULT_ROUND[m.id], 0);
    }
    return side;
  }

  /** 第一次进入：原版 Astra 队对原版 Fable 队，玩家不在其中（观战） */
  private defaultState(): PanelState {
    return { mapId: 'caldera', speed: 1, sides: [this.defaultSide('astra'), this.defaultSide('fable')] };
  }

  private mapDefaultSpawns(mapId: TeamMapId): SpawnM[] {
    return defaultSpawnsFromMap(this.mapTexts.get(mapId) || '', teamMap(mapId).mode);
  }

  private restore(): PanelState | null {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      const st = JSON.parse(raw) as PanelState;
      const okSlot = (s: TeamSlotDraft) => s && (s.kind === 'human' || (s.kind === 'bot' && teamBot(s.botId)));
      if (!st || !TEAM_MAPS.some((m) => m.id === st.mapId) || !Array.isArray(st.sides) || st.sides.length !== 2) return null;
      for (const side of st.sides) {
        if (!Array.isArray(side.slots) || side.slots.length !== 5 || !side.slots.every(okSlot)) return null;
        for (const m of TEAM_MAPS) {
          const ms = side.maps?.[m.id];
          if (!ms || ms.tactics?.length !== 5 || ms.spawns?.length !== 5) return null;
        }
      }
      if (st.sides.flatMap((s) => s.slots).filter((s) => s.kind === 'human').length > 1) return null;
      st.speed = Math.max(0.1, Math.min(2, Number(st.speed) || 1));
      return st;
    } catch {
      return null;
    }
  }

  private persist() {
    if (this.role === 'guest' || !this.state) return;
    if (this.role === 'host') this.sendLobbySoon();
    try {
      // 本地只存一个玩家席：房间里别人的席位存成原来的 bot，自己的存成普通玩家席
      const copy = JSON.parse(JSON.stringify(this.state)) as PanelState;
      copy.sides.forEach((side, si) =>
        side.slots.forEach((sl, i) => {
          if (sl.kind !== 'human' || sl.member === undefined) return;
          if (sl.member === this.lastMe && this.role !== 'none') {
            side.slots[i] = { kind: 'human' };
            return;
          }
          side.slots[i] = { kind: 'bot', botId: sl.prev && teamBot(sl.prev) ? sl.prev : TEAM_ROSTER[si === 0 ? 'astra' : 'fable'][i] };
          for (const m of TEAM_MAPS) if (sl.prevTactics?.[m.id]) side.maps[m.id].tactics[i] = { ...sl.prevTactics[m.id]! };
        }),
      );
      if (copy.sides.flatMap((x) => x.slots).filter((x) => x.kind === 'human').length > 1) return;
      localStorage.setItem(STORE_KEY, JSON.stringify(copy));
    } catch {
      /* private mode */
    }
  }

  private get mode(): TeamModeNum {
    return teamMap(this.state!.mapId).mode;
  }

  /** 套用一套原版预设：按席位的短名取战术和站位；刺王里预设的国王不在第一位时，把他换到第一位。 */
  private applyPreset(side: SideState, mapId: TeamMapId, round: number, variantIdx: number) {
    const cls = classifyTeam(side.slots);
    if (!cls.team) return;
    const rd = this.presets.find((r) => r.round === round);
    const set = rd?.teams[cls.team][variantIdx];
    if (!rd || !set) return;
    if (rd.mode === 5 && set.king) {
      const ki = slotNames(side.slots).findIndex((n) => n.name === set.king);
      if (ki > 0) this.swapSlots(side, 0, ki);
    }
    const names = slotNames(side.slots).map((n) => n.name);
    const ms = side.maps[mapId];
    const split = this.splitFor(cls.team, set.plan, rd.mode, set.king);
    ms.tactics = names.map((nm, i) => {
      const t = split[nm] ? { ...split[nm] } : emptyTactic();
      return side.slots[i].kind === 'human' ? { point: t.point, job: t.job, advanced: '' } : t;
    });
    const def = this.mapDefaultSpawns(mapId);
    ms.spawns = names.map((nm, i) => (set.spawns[nm] ? [set.spawns[nm][0], set.spawns[nm][1]] : def[i]) as SpawnM);
    ms.preset = `第 ${round} 回合 · ${set.variant}`;
  }

  private splitFor(team: OrigTeam, plan: string, mode: TeamModeNum, king: string | null) {
    // splitPresetPlan 按原版短名返回；动态 import 会拖慢首屏，这里直接复用模块函数
    return splitPresetPlanCached(team, plan, mode, king);
  }

  /** 两个席位整体对调（阵容、每张图的战术和站位都跟着人走） */
  private swapSlots(side: SideState, a: number, b: number) {
    [side.slots[a], side.slots[b]] = [side.slots[b], side.slots[a]];
    for (const m of TEAM_MAPS) {
      const ms = side.maps[m.id];
      [ms.tactics[a], ms.tactics[b]] = [ms.tactics[b], ms.tactics[a]];
      [ms.spawns[a], ms.spawns[b]] = [ms.spawns[b], ms.spawns[a]];
      ms.preset = null;
    }
  }

  /** 整队换成一个原版队：完整覆盖阵容（原来在这一队的玩家也被换掉）、战术和站位 */
  private replaceTeam(sideIdx: 0 | 1, team: OrigTeam) {
    this.state!.sides[sideIdx] = this.defaultSide(team);
  }

  private setSlot(sideIdx: 0 | 1, slotIdx: number, next: TeamSlotDraft, roomSafe = false) {
    const st = this.state!;
    const side = st.sides[sideIdx];
    const prev = side.slots[slotIdx];
    if (next.kind === 'human' && !roomSafe) {
      // 只有一个玩家：已经在别处就挪过来，那一席换成这里原来的 bot
      for (const [si, s] of st.sides.entries()) {
        const hi = s.slots.findIndex((x) => x.kind === 'human');
        if (hi < 0 || (si === sideIdx && hi === slotIdx)) continue;
        for (const m of TEAM_MAPS) {
          const ms = s.maps[m.id];
          ms.tactics[hi] = carryTactic(ms.tactics[hi], { kind: 'human' }, prev);
          ms.preset = null;
        }
        s.slots[hi] = prev.kind === 'bot' ? { ...prev } : { kind: 'bot', botId: TEAM_ROSTER[si === 0 ? 'astra' : 'fable'][hi] };
      }
    }
    for (const m of TEAM_MAPS) {
      const ms = side.maps[m.id];
      ms.tactics[slotIdx] = carryTactic(ms.tactics[slotIdx], prev, next);
      ms.preset = null;
    }
    side.slots[slotIdx] = next;
  }

  // ---------------------------------------------------------------- 渲染

  public async mount(host: HTMLElement) {
    this.host = host;
    host.innerHTML = `<div class="team-loading">加载团队赛地图与原版预设…</div>`;
    await this.ready;
    if (this.host !== host) return;
    this.render();
    this.cb.onPreviewMap(this.previewMeta());
    this.cb.onPrewarmMaps?.(TEAM_MAPS.filter((m) => m.id !== this.state?.mapId).map((m) => this.mapMeta(m.id)));
  }

  public unmount() {
    this.closeMenu();
    this.closeModal();
    this.host = null;
  }

  /** 大厅背景用的 MapMeta（当前选中的团队图） */
  public previewMeta(): MapMeta {
    const id = this.state?.mapId ?? 'caldera';
    return this.mapMeta(id);
  }

  private mapMeta(id: TeamMapId): MapMeta {
    const m = teamMap(id);
    const g = this.grids.get(id);
    return {
      id: m.id,
      title: m.title,
      theme: m.theme,
      category: 'standard',
      nx: g?.nx ?? m.widthM * 2,
      ny: g?.ny ?? m.heightM * 2,
      desc: m.desc,
      previewGrid: g?.cells ?? [],
    };
  }

  private render() {
    const host = this.host;
    const st = this.state;
    if (!host || !st) return;
    const map = teamMap(st.mapId);
    const ro = this.readOnly;
    const inRoom = this.role !== 'none';
    const mine = this.mySlot();
    const startArea = ro
      ? `<div class="team-start-note team-wait-note">等房主开始</div>`
      : `<div class="team-start-note" id="team-start-note"></div>
          <button type="button" class="start-btn team-start-btn" id="team-start">${inRoom ? '开始对局' : this.hasHuman() ? '开始团队赛' : '开始观战'}</button>`;
    host.innerHTML = `
      ${teamRoomAvailable() ? `<div class="team-room-bar" id="team-room-bar"></div>` : ''}
      <div class="team-layout ${ro ? 'is-readonly' : ''} ${inRoom ? 'is-room' : ''}">
        ${this.renderSide(0)}
        ${this.renderSide(1)}
        ${
          inRoom
            ? `<div class="team-room-foot">
                <button type="button" class="team-spectate-btn" id="team-spectate" ${mine ? '' : 'disabled'} title="${mine ? '把席位交还给原来的 bot，自己观战' : '你现在没有上场'}">👁 观战</button>
              </div>`
            : ''
        }
        <aside class="team-aside">
          <div class="team-maps">
            ${TEAM_MAPS.map(
              (m) => `
              <button type="button" class="team-map-tile ${m.id === st.mapId ? 'active' : ''}" data-team-map="${m.id}" ${ro ? 'disabled' : ''}>
                <canvas class="team-map-mini" width="132" height="86" data-team-map-canvas="${m.id}"></canvas>
                <span class="team-map-meta">
                  <span class="team-map-title">${m.title}</span>
                  <span class="team-map-mode m${m.mode}">${m.modeLabel}</span>
                </span>
              </button>`,
            ).join('')}
          </div>
          <p class="team-map-desc">${esc(map.desc)}</p>
          <div class="speed-box team-speed">
            <div class="speed-head">
              <span class="speed-title">游戏速度</span>
              <span class="speed-readout" id="team-speed-readout"><strong>${st.speed.toFixed(1)}x</strong></span>
            </div>
            <input type="range" id="team-speed" class="speed-slider" min="0.1" max="2.0" step="0.1" value="${st.speed.toFixed(1)}"
              style="--speed-pct:${(((st.speed - 0.1) / 1.9) * 100).toFixed(1)}%" ${ro ? 'disabled' : ''} />
          </div>
          ${startArea}
        </aside>
      </div>`;
    for (const m of TEAM_MAPS) {
      const cvs = host.querySelector<HTMLCanvasElement>(`canvas[data-team-map-canvas="${m.id}"]`);
      const g = this.grids.get(m.id);
      if (cvs && g) drawMapCanvas(cvs, m.id, g);
    }
    this.bind();
    this.syncStartNote();
    this.renderRoomBar();
  }

  private hasHuman() {
    return this.state!.sides.some((s) => s.slots.some((x) => x.kind === 'human'));
  }

  private renderSide(sideIdx: 0 | 1): string {
    const st = this.state!;
    const side = st.sides[sideIdx];
    const ms = side.maps[st.mapId];
    const cls = classifyTeam(side.slots);
    const names = slotNames(side.slots);
    const mode = this.mode;
    const headColor = cls.team ? TEAM_COLOR[cls.team] : '#b9c6e4';
    return `
      <section class="team-side side-${sideIdx}" style="--side:${SIDE_COLOR[sideIdx]}">
        <div class="team-side-head">
          <button type="button" class="team-name-btn" data-team-name="${sideIdx}" style="--tc:${headColor}" aria-haspopup="listbox" ${this.readOnly ? 'disabled' : ''}>
            <span class="team-name-dot"></span>
            <span class="team-name-text">${esc(cls.label)}</span>
            <span class="team-chev">▾</span>
          </button>
          <span class="team-side-tag">${sideIdx === 0 ? '左 · 蓝方' : '右 · 红方'}</span>
          ${
            this.readOnly
              ? `<button type="button" class="team-strat-btn" data-team-layout-view="${sideIdx}" title="查看出生点布局（只读）">⌖ 布局</button>`
              : `<button type="button" class="team-strat-btn" data-team-strat="${sideIdx}" aria-haspopup="listbox" title="原版预设与布局">
            策略 <span class="team-chev">▾</span>
          </button>`
          }
        </div>
        <div class="team-side-sub">${ms.preset ? `预设：${esc(ms.preset)}` : cls.kind === 'custom' ? '混编阵容 · 电台由程序翻译' : '已自定义战术 / 布局'}</div>
        <div class="team-slots">
          ${side.slots
            .map((sl, i) => {
              const bot = sl.kind === 'bot' ? teamBot(sl.botId) : undefined;
              const ring = bot ? TEAM_COLOR[bot.team] : HUMAN_RING;
              const isKing = mode === 5 && i === 0;
              const t = ms.tactics[i];
              const showTac = !(sl.kind === 'human' && mode === 3);
              const tacLabel = tacticButtonLabel(t, mode);
              const tacSet = tacLabel !== '战术' || (sl.kind === 'bot' && t.advanced.trim() !== '');
              const nick = sl.kind === 'human' && sl.member !== undefined ? this.memberName(sl.member) : null;
              const isMe = sl.kind === 'human' && (sl.member === undefined || sl.member === this.myId);
              const display = sl.kind === 'human' && sl.member !== undefined ? `${nick ?? '…'}${isMe ? ' (YOU)' : ''}` : names[i].display;
              const sub = bot ? esc(bot.fullName) : sl.member !== undefined && sl.member === teamRoom.state.room?.hostId ? '房主 · 真人参战' : '真人参战';
              const claimable = this.readOnly && sl.kind === 'bot';
              return `
              <div class="team-slot ${sl.kind === 'human' ? 'is-human' : ''} ${isMe && sl.kind === 'human' ? 'is-me' : ''} ${claimable ? 'is-claimable' : ''}">
                <span class="team-seat ${isKing ? 'is-king' : ''}" title="${isKing ? '刺王：第一位是国王' : `${sideIdx === 0 ? '左' : '右'}队第 ${i + 1} 位`}">${isKing ? '👑' : i + 1}</span>
                <button type="button" class="team-pick" data-team-pick="${sideIdx}:${i}" ${this.readOnly ? (claimable ? 'title="顶替这个 bot 上场"' : 'disabled') : 'aria-haspopup="listbox"'}>
                  <img class="team-av" src="${bot ? bot.avatar : HUMAN_AVATAR}" alt="" style="border-color:${ring}" draggable="false" />
                  <span class="team-pick-body">
                    <span class="team-pick-name">${esc(display)}</span>
                    <span class="team-pick-sub">${sub}</span>
                  </span>
                  ${this.readOnly ? (claimable ? '<span class="team-claim">上场</span>' : '') : '<span class="team-chev">▾</span>'}
                </button>
                ${
                  showTac
                    ? `<button type="button" class="team-tac-btn ${tacSet ? 'is-set' : ''}" data-team-tac="${sideIdx}:${i}">${esc(tacLabel)}</button>`
                    : `<span class="team-tac-btn is-empty" aria-hidden="true"></span>`
                }
              </div>`;
            })
            .join('')}
        </div>
      </section>`;
  }

  private syncStartNote() {
    const note = this.host?.querySelector<HTMLElement>('#team-start-note');
    const btn = this.host?.querySelector<HTMLButtonElement>('#team-start');
    if (!note || !btn) return;
    if (this.role === 'host' && teamRoom.state.match) {
      note.textContent = '房间里有一局还没结束';
      note.classList.remove('is-err');
      btn.disabled = true;
      return;
    }
    const problems = this.formationIssues();
    note.textContent = problems.length ? problems[0] : '';
    note.classList.toggle('is-err', problems.length > 0);
    btn.disabled = problems.length > 0 || this.cb.isLoading();
  }

  private formationIssues(): string[] {
    const st = this.state!;
    const grid = this.grids.get(st.mapId);
    if (!grid) return [];
    const out: string[] = [];
    st.sides.forEach((side, s) => {
      const probs = formationProblems(grid, teamMap(st.mapId), side.maps[st.mapId].spawns);
      if (probs.size) out.push(`${s === 0 ? '左' : '右'}队布局有问题：第 ${[...probs.keys()][0] + 1} 位${[...probs.values()][0]}（点「策略 → 布局」调整）`);
    });
    return out;
  }

  private bind() {
    const host = this.host!;
    const st = this.state!;
    host.querySelector('#team-spectate')?.addEventListener('click', () => {
      if (this.role === 'guest') teamRoom.send({ type: 'unclaim' });
      else if (this.role === 'host') {
        this.releaseMember(this.myId);
        this.persist();
        this.render();
      }
    });
    if (this.readOnly) {
      host.querySelectorAll<HTMLButtonElement>('[data-team-pick]').forEach((b) =>
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          const [s, i] = b.dataset.teamPick!.split(':').map(Number);
          if (st.sides[s]?.slots[i]?.kind === 'bot') teamRoom.send({ type: 'claim', side: s, slot: i });
        }),
      );
      host.querySelectorAll<HTMLButtonElement>('[data-team-tac]').forEach((b) =>
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          const [s, i] = b.dataset.teamTac!.split(':').map(Number);
          this.openTactics(s as 0 | 1, i, true);
        }),
      );
      host.querySelectorAll<HTMLButtonElement>('[data-team-layout-view]').forEach((b) =>
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          this.openLayout(Number(b.dataset.teamLayoutView) as 0 | 1, true);
        }),
      );
      return;
    }
    host.querySelectorAll<HTMLButtonElement>('[data-team-map]').forEach((b) =>
      b.addEventListener('click', () => {
        const id = b.dataset.teamMap as TeamMapId;
        if (id === st.mapId) return;
        st.mapId = id;
        this.persist();
        this.render();
        this.cb.onPreviewMap(this.previewMeta());
      }),
    );
    const slider = host.querySelector<HTMLInputElement>('#team-speed');
    slider?.addEventListener('input', () => {
      const v = Math.round(Math.max(0.1, Math.min(2, Number(slider.value))) * 10) / 10;
      st.speed = v;
      slider.style.setProperty('--speed-pct', `${(((v - 0.1) / 1.9) * 100).toFixed(1)}%`);
      const ro = host.querySelector('#team-speed-readout');
      if (ro) ro.innerHTML = `<strong>${v.toFixed(1)}x</strong>`;
      this.persist();
    });
    host.querySelector('#team-start')?.addEventListener('click', () => this.start());
    host.querySelectorAll<HTMLButtonElement>('[data-team-pick]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const [s, i] = b.dataset.teamPick!.split(':').map(Number);
        this.openSlotMenu(s as 0 | 1, i, b);
      }),
    );
    host.querySelectorAll<HTMLButtonElement>('[data-team-name]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.openTeamMenu(Number(b.dataset.teamName) as 0 | 1, b);
      }),
    );
    host.querySelectorAll<HTMLButtonElement>('[data-team-strat]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.openStrategyMenu(Number(b.dataset.teamStrat) as 0 | 1, b);
      }),
    );
    host.querySelectorAll<HTMLButtonElement>('[data-team-tac]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const [s, i] = b.dataset.teamTac!.split(':').map(Number);
        this.openTactics(s as 0 | 1, i);
      }),
    );
  }

  // ---------------------------------------------------------------- 下拉菜单

  private closeMenu() {
    if (this.menu.classList.contains('hidden')) return;
    this.menu.classList.add('hidden');
    this.menuOwner = null;
    this.host?.querySelectorAll('.is-open').forEach((el) => el.classList.remove('is-open'));
  }

  private showMenu(owner: string, anchor: HTMLElement, html: string, minWidth = 260) {
    if (this.menuOwner === owner) {
      this.closeMenu();
      return;
    }
    this.closeMenu();
    this.menuOwner = owner;
    anchor.classList.add('is-open');
    this.menu.innerHTML = html;
    const rect = rectToLogical(anchor.getBoundingClientRect());
    const vp = getLogicalViewport();
    const pad = 10;
    const width = Math.min(vp.width - pad * 2, Math.max(rect.width, minWidth));
    const left = Math.max(pad, Math.min(rect.left, vp.width - width - pad));
    const below = vp.height - rect.bottom - pad, above = rect.top - pad;
    const up = below < 300 && above > below;
    const maxH = Math.max(160, Math.min(420, (up ? above : below) - 6));
    Object.assign(this.menu.style, {
      width: `${Math.round(width)}px`,
      maxHeight: `${Math.round(maxH)}px`,
      left: `${Math.round(left)}px`,
      top: up ? 'auto' : `${Math.round(rect.bottom + 6)}px`,
      bottom: up ? `${Math.round(vp.height - rect.top + 6)}px` : 'auto',
    });
    this.menu.classList.toggle('open-up', up);
    this.menu.classList.remove('hidden');
  }

  private openSlotMenu(sideIdx: 0 | 1, slotIdx: number, anchor: HTMLElement) {
    const st = this.state!;
    const cur = st.sides[sideIdx].slots[slotIdx];
    let humanAt = '';
    st.sides.forEach((s, si) =>
      s.slots.forEach((x, i) => {
        if (x.kind === 'human' && !(si === sideIdx && i === slotIdx)) humanAt = `${si === 0 ? '左' : '右'} ${i + 1}`;
      }),
    );
    const item = (kind: 'human' | 'bot', id: string, avatar: string, ring: string, title: string, sub: string, chip: string) => {
      const sel = kind === 'human' ? cur.kind === 'human' && (this.role === 'none' || cur.member === this.myId) : cur.kind === 'bot' && cur.botId === id;
      return `
        <button type="button" class="pm-item ${sel ? 'is-selected' : ''}" data-pick="${kind}:${id}" role="option" aria-selected="${sel}">
          <img class="pm-avatar" src="${avatar}" alt="" style="border-color:${ring}" />
          <div class="pm-main"><div class="pm-name-row">${chip}<span class="pm-name">${esc(title)}</span>${sub}</div></div>
          <span class="pm-check">${sel ? '✓' : ''}</span>
        </button>`;
    };
    const group = (team: OrigTeam) =>
      `<div class="pm-section-label" style="color:${TEAM_COLOR[team]}">${TEAM_LABEL[team]}</div>` +
      TEAM_ROSTER[team]
        .map((id) => {
          const b = teamBot(id)!;
          return item('bot', id, b.avatar, TEAM_COLOR[team], b.fullName, '', `<span class="pm-rank team-chip" style="--tc:${TEAM_COLOR[team]}">${b.captain ? '队长' : '队员'}</span>`);
        })
        .join('');
    const roomMe = this.role === 'host' ? this.memberName(this.myId) : null;
    if (roomMe) {
      humanAt = '';
      const m = this.mySlot();
      if (m && !(m[0] === sideIdx && m[1] === slotIdx)) humanAt = `${m[0] === 0 ? '左' : '右'} ${m[1] + 1}`;
    }
    const held = cur.kind === 'human' && cur.member !== undefined && cur.member !== this.myId ? this.memberName(cur.member) : null;
    const html =
      (held ? `<div class="team-menu-note">${esc(held)} 在这一席；换成 bot 后他改为观战</div>` : '') +
      `<div class="pm-section-label">玩家</div>` +
      item('human', 'human', HUMAN_AVATAR, HUMAN_RING, roomMe ? `我（${roomMe}）` : '玩家 (YOU)', humanAt ? `<span class="pm-taken-pill">从${humanAt}换过来</span>` : '', '<span class="pm-rank pm-rank-human">真人</span>') +
      group('astra') +
      group('fable');
    this.showMenu(`slot:${sideIdx}:${slotIdx}`, anchor, html, 300);
    this.menu.querySelectorAll<HTMLButtonElement>('[data-pick]').forEach((b) =>
      b.addEventListener('click', () => {
        const [kind, id] = b.dataset.pick!.split(':');
        this.closeMenu();
        if (this.role === 'host') {
          // 房间里：「我」坐到这一席（从别处挪过来）；选 bot 时这一席原来的人改为观战
          if (kind === 'human') {
            if (cur.kind === 'human' && cur.member === this.myId) return;
            this.releaseMember(this.myId);
            if (cur.kind === 'human') this.setSlot(sideIdx, slotIdx, { kind: 'bot', botId: cur.prev ?? TEAM_ROSTER[sideIdx === 0 ? 'astra' : 'fable'][slotIdx] }, true);
            this.seatMember(sideIdx, slotIdx, this.myId);
          } else {
            if (cur.kind === 'bot' && cur.botId === id) return;
            this.setSlot(sideIdx, slotIdx, { kind: 'bot', botId: id }, true);
          }
          this.persist();
          this.render();
          return;
        }
        const next: TeamSlotDraft = kind === 'human' ? { kind: 'human' } : { kind: 'bot', botId: id };
        if (next.kind === cur.kind && next.botId === cur.botId) return;
        this.setSlot(sideIdx, slotIdx, next);
        this.persist();
        this.render();
      }),
    );
    this.menu.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' });
  }

  private openTeamMenu(sideIdx: 0 | 1, anchor: HTMLElement) {
    const cls = classifyTeam(this.state!.sides[sideIdx].slots);
    const html = (['astra', 'fable'] as OrigTeam[])
      .map((team) => {
        const sel = cls.kind === 'original' && cls.team === team;
        return `
        <button type="button" class="pm-item ${sel ? 'is-selected' : ''}" data-team="${team}">
          <span class="team-menu-dot" style="background:${TEAM_COLOR[team]}"></span>
          <div class="pm-main"><div class="pm-name-row"><span class="pm-name">${TEAM_LABEL[team]}</span>
            <span class="team-menu-sub">${TEAM_ROSTER[team].map((id) => teamBot(id)!.display).join(' · ')}</span></div></div>
          <span class="pm-check">${sel ? '✓' : ''}</span>
        </button>`;
      })
      .join('');
    this.showMenu(`team:${sideIdx}`, anchor, `<div class="pm-section-label">整队换成</div>${html}`, 280);
    this.menu.querySelectorAll<HTMLButtonElement>('[data-team]').forEach((b) =>
      b.addEventListener('click', () => {
        this.closeMenu();
        this.replaceTeam(sideIdx, b.dataset.team as OrigTeam);
        this.persist();
        this.render();
      }),
    );
  }

  private openStrategyMenu(sideIdx: 0 | 1, anchor: HTMLElement) {
    const st = this.state!;
    const side = st.sides[sideIdx];
    const cls = classifyTeam(side.slots);
    const ms = side.maps[st.mapId];
    let html = '';
    if (cls.team) {
      const rounds = this.presets.filter((r) => r.map === st.mapId);
      html += rounds
        .map(
          (rd) =>
            `<div class="pm-section-label">第 ${rd.round} 回合 · 原版 ${TEAM_LABEL[cls.team!]}</div>` +
            rd.teams[cls.team!]
              .map((set, vi) => {
                const label = `第 ${rd.round} 回合 · ${set.variant}`;
                const sel = ms.preset === label;
                const king = rd.mode === 5 && set.king ? `国王 ${teamBot(TEAM_ROSTER[cls.team!].find((id) => teamBot(id)!.name === set.king))?.display ?? set.king}` : '';
                return `
                <button type="button" class="pm-item ${sel ? 'is-selected' : ''}" data-preset="${rd.round}:${vi}">
                  <div class="pm-main"><div class="pm-name-row"><span class="pm-name">${set.variant}</span>
                    <span class="team-menu-sub">${king || (set.plan ? `${set.plan.split('\n').length} 行战术` : '无战术单')}</span></div></div>
                  <span class="pm-check">${sel ? '✓' : ''}</span>
                </button>`;
              })
              .join(''),
        )
        .join('');
      html += `<div class="team-menu-note">套用后覆盖全队战术和出生点</div>`;
    } else {
      html += `<div class="team-menu-note">混编阵容没有原版预设</div>`;
    }
    html += `<button type="button" class="pm-item team-layout-item" data-layout="1"><span class="team-layout-ico">⌖</span><div class="pm-main"><div class="pm-name-row"><span class="pm-name">布局…</span><span class="team-menu-sub">在地图上拖动调整出生点</span></div></div></button>`;
    this.showMenu(`strat:${sideIdx}`, anchor, html, 280);
    this.menu.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((b) =>
      b.addEventListener('click', () => {
        const [round, vi] = b.dataset.preset!.split(':').map(Number);
        this.closeMenu();
        this.applyPreset(side, st.mapId, round, vi);
        this.persist();
        this.render();
      }),
    );
    this.menu.querySelector('[data-layout]')?.addEventListener('click', () => {
      this.closeMenu();
      this.openLayout(sideIdx);
    });
  }

  // ---------------------------------------------------------------- 弹窗

  private closeModal() {
    this.modal.classList.add('hidden');
    this.modal.innerHTML = '';
  }

  private openModal(html: string, cls: string) {
    this.closeMenu();
    this.modal.innerHTML = `<div class="team-modal ${cls}" role="dialog" aria-modal="true">${html}</div>`;
    this.modal.classList.remove('hidden');
    this.modal.onclick = (e) => {
      if (e.target === this.modal) this.closeModal();
    };
  }

  // 战术面板 ---------------------------------------------------------------

  private openTactics(sideIdx: 0 | 1, slotIdx: number, readOnly = false) {
    const st = this.state!;
    const side = st.sides[sideIdx];
    const sl = side.slots[slotIdx];
    const bot = sl.kind === 'bot' ? teamBot(sl.botId)! : null;
    const names = slotNames(side.slots);
    const mode = this.mode;
    const map = teamMap(st.mapId);
    const isKing = mode === 5 && slotIdx === 0;
    const draft: SlotTactic = { ...side.maps[st.mapId].tactics[slotIdx] };
    const dialect = bot?.team ?? null;
    const seg = <T extends string>(key: string, items: [T | '', string][], cur: T | null) =>
      `<div class="team-seg" data-seg="${key}">${items
        .map(([v, l]) => `<button type="button" class="${(cur ?? '') === v ? 'active' : ''}" data-v="${v}" ${readOnly ? 'disabled' : ''}>${l}</button>`)
        .join('')}</div>`;
    const basic =
      mode === 4
        ? `<div class="team-field"><span class="team-field-label">点</span>${seg<PointName>('point', [['A', 'A'], ['B', 'B'], ['C', 'C'], ['', '不指定']], draft.point)}</div>
           <div class="team-field"><span class="team-field-label">职责</span>${seg<TeamJob>('job', [['guard', '守卫'], ['roam', '游走'], ['', '不指定']], draft.job)}</div>`
        : mode === 5
          ? `<div class="team-field"><span class="team-field-label">职责</span>${seg<TeamJob>('job', [['guard', isKing ? '守卫（国王保命）' : '守卫（护王）'], ['hunt', isKing ? '进攻（国王参战）' : '进攻（抓王）'], ['', '不指定']], draft.job)}</div>`
          : `<p class="team-hint">歼灭模式没有基础选项，需要时用下面的高级指令。</p>`;
    const cmds = dialect === 'astra' ? ASTRA_CMDS : dialect === 'fable' ? FABLE_KEYS : null;
    const ref = cmds
      ? Object.entries(cmds)
          .filter(([, d]) => d.modes.includes(mode))
          .map(
            ([k, d]) =>
              `<div class="team-ref-row ${d.captain && !bot!.captain ? 'is-dim' : ''}"><code>${k}</code><span>${esc(d.desc)}${d.captain ? `（只有${dialect === 'astra' ? ' Astra' : ' Fable'} 本人认）` : ''}${'values' in d && d.values ? ` <em>${d.values.join(' / ')}</em>` : ''}</span></div>`,
          )
          .join('')
      : '';
    const placeholder =
      dialect === 'astra'
        ? '每行一条：指令 值（省略名字 = 这个 bot 自己），例如\nwing N\nrally 0,85,4.1,8.4\npace ALL BAL'
        : '每行一组 键=值（省略名字 = 这个 bot 自己），例如\ngo=4,8.5 until=380\nall job=hunt';
    this.openModal(
      `
      <div class="team-modal-head">
        <img class="team-av" src="${bot ? bot.avatar : HUMAN_AVATAR}" alt="" style="border-color:${bot ? TEAM_COLOR[bot.team] : HUMAN_RING}" />
        <div class="team-modal-title">
          <strong>${esc(names[slotIdx].display)} 的战术</strong>
          <span>${map.title} · ${map.modeLabel}${isKing ? ' · 国王' : ''}</span>
        </div>
        <button type="button" class="team-modal-x" data-close aria-label="关闭">✕</button>
      </div>
      <div class="team-modal-body">
        ${basic}
        ${
          bot
            ? `<div class="team-adv-head">
                 <span class="team-field-label">高级指令</span>
                 <span class="team-dialect" style="--tc:${TEAM_COLOR[bot.team]}">使用 ${TEAM_LABEL[bot.team]}语法</span>
               </div>
               <textarea class="team-adv" id="team-adv" rows="5" spellcheck="false" placeholder="${esc(readOnly ? '（没有高级指令）' : placeholder)}" ${readOnly ? 'readonly' : ''}>${esc(draft.advanced)}</textarea>
               <div class="team-issues" id="team-issues"></div>
               <details class="team-ref"><summary>本模式可用的指令</summary>${ref}</details>
               <details class="team-ref team-final"><summary>最终交给 ${esc(names[slotIdx].name)} 的战术单</summary><pre id="team-final"></pre></details>`
            : `<p class="team-hint">真人不读战术单；这里的选择只告诉队友你打算去哪（Astra 会据此分工）。</p>`
        }
      </div>
      <div class="team-modal-foot">
        ${
          readOnly
            ? `<span class="team-readonly-tag">只读 · 战术由房主设置</span><span class="team-foot-gap"></span><button type="button" class="team-btn ghost" data-close>关闭</button>`
            : `<button type="button" class="team-btn ghost" data-close>取消</button>
        <button type="button" class="team-btn primary" id="team-tac-save">保存</button>`
        }
      </div>`,
      'team-tac-modal',
    );
    const root = this.modal;
    root.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => this.closeModal()));
    root.querySelectorAll<HTMLElement>('.team-seg').forEach((segEl) =>
      segEl.querySelectorAll<HTMLButtonElement>('button').forEach((b) =>
        b.addEventListener('click', () => {
          segEl.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
          const v = b.dataset.v || null;
          if (segEl.dataset.seg === 'point') draft.point = v as PointName | null;
          else draft.job = v as TeamJob | null;
          refresh();
        }),
      ),
    );
    const ta = root.querySelector<HTMLTextAreaElement>('#team-adv');
    const saveBtn = root.querySelector<HTMLButtonElement>('#team-tac-save') ?? document.createElement('button');
    const refresh = () => {
      if (!bot) return;
      draft.advanced = ta?.value ?? '';
      const res = validateAdvanced(draft.advanced, bot, names[slotIdx].name, mode, map);
      const issuesEl = root.querySelector('#team-issues');
      if (issuesEl)
        issuesEl.innerHTML = res.issues
          .map((i: PlanIssue) => `<div class="team-issue ${i.level}">第 ${i.line} 行：${esc(i.text)}</div>`)
          .join('');
      saveBtn.disabled = res.issues.some((i) => i.level === 'error');
      const tactics = side.maps[st.mapId].tactics.map((t, i) => (i === slotIdx ? draft : t));
      const finalEl = root.querySelector('#team-final');
      if (finalEl) finalEl.textContent = buildSeatPlans({ slots: side.slots, tactics }, mode, map)[slotIdx] || '（空）';
    };
    ta?.addEventListener('input', refresh);
    refresh();
    saveBtn.addEventListener('click', () => {
      if (ta) draft.advanced = ta.value.replace(/\r/g, '').trim();
      const ms = side.maps[st.mapId];
      ms.tactics[slotIdx] = { ...draft };
      ms.preset = null;
      this.persist();
      this.closeModal();
      this.render();
    });
  }

  // 布局编辑器 -------------------------------------------------------------

  private openLayout(sideIdx: 0 | 1, readOnly = false) {
    const st = this.state!;
    const side = st.sides[sideIdx];
    const grid = this.grids.get(st.mapId)!;
    const map = teamMap(st.mapId);
    const names = slotNames(side.slots);
    const spawns: SpawnM[] = side.maps[st.mapId].spawns.map((p) => [p[0], p[1]] as SpawnM);
    const avatars = side.slots.map((s) => (s.kind === 'bot' ? teamBot(s.botId)!.avatar : HUMAN_AVATAR));
    const vp = getLogicalViewport();
    const maxW = Math.min(900, vp.width - 40), maxH = Math.min(560, vp.height - 150);
    const aspect = grid.nx / grid.ny;
    const cw = Math.round(Math.min(maxW, maxH * aspect)), ch = Math.round(cw / aspect);
    this.openModal(
      `
      <div class="team-modal-head">
        <div class="team-modal-title">
          <strong>${sideIdx === 0 ? '左队' : '右队'}布局 · ${map.title}</strong>
          <span>${readOnly ? '出生点布局（只读，由房主设置）' : '拖动头像调整出生点'}${map.mode === 4 ? '（占点里也是复活点）' : ''}；按本队在左边摆，坐右边时整体转 180 度</span>
        </div>
        <button type="button" class="team-modal-x" data-close aria-label="关闭">✕</button>
      </div>
      <div class="team-layout-stage" style="width:${cw}px;height:${ch}px">
        <canvas id="team-layout-canvas" width="${cw * 2}" height="${ch * 2}" style="width:${cw}px;height:${ch}px"></canvas>
        ${spawns
          .map(
            (_, i) => `
          <div class="team-marker" data-marker="${i}" style="--mc:${SIDE_COLOR[sideIdx]}">
            <img src="${avatars[i]}" alt="" draggable="false" />
            <span class="team-marker-n">${map.mode === 5 && i === 0 ? '👑' : i + 1}</span>
          </div>`,
          )
          .join('')}
      </div>
      <div class="team-layout-status" id="team-layout-status"></div>
      <div class="team-modal-foot">
        ${
          readOnly
            ? `<span class="team-readonly-tag">只读</span><span class="team-foot-gap"></span><button type="button" class="team-btn ghost" data-close>关闭</button>`
            : `<button type="button" class="team-btn ghost" id="team-layout-reset">地图默认</button>
        <span class="team-foot-gap"></span>
        <button type="button" class="team-btn ghost" data-close>取消</button>
        <button type="button" class="team-btn primary" id="team-layout-save">保存</button>`
        }
      </div>`,
      `team-layout-modal ${readOnly ? 'is-readonly' : ''}`,
    );
    const root = this.modal;
    const cvs = root.querySelector<HTMLCanvasElement>('#team-layout-canvas')!;
    const geo = drawMapCanvas(cvs, st.mapId, grid, { deploy: true, points: true });
    const pxPerM = geo.scale / 2, ox = geo.ox / 2, oy = geo.oy / 2;
    const markers = [...root.querySelectorAll<HTMLElement>('[data-marker]')];
    const status = root.querySelector<HTMLElement>('#team-layout-status')!;
    const saveBtn = root.querySelector<HTMLButtonElement>('#team-layout-save') ?? document.createElement('button');
    const markerSize = Math.max(22, Math.min(40, pxPerM * 0.8 + 10));
    const place = () => {
      const probs = formationProblems(grid, map, spawns);
      markers.forEach((el, i) => {
        el.style.left = `${ox + spawns[i][0] * pxPerM}px`;
        el.style.top = `${oy + spawns[i][1] * pxPerM}px`;
        el.style.width = el.style.height = `${markerSize}px`;
        el.classList.toggle('is-bad', probs.has(i));
        el.title = `${names[i].display} (${spawns[i][0].toFixed(1)}, ${spawns[i][1].toFixed(1)})${probs.has(i) ? ` · ${probs.get(i)}` : ''}`;
      });
      status.innerHTML = probs.size
        ? [...probs].map(([i, why]) => `<span class="is-err">${esc(names[i].display)}：${esc(why)}</span>`).join('')
        : `<span class="is-ok">布局合法：都在布阵区内、站得住、两两相距至少 1 米</span>`;
      saveBtn.disabled = probs.size > 0;
    };
    place();
    const stage = root.querySelector<HTMLElement>('.team-layout-stage')!;
    markers.forEach((el, i) => {
      if (readOnly) return;
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        el.classList.add('is-drag');
        const move = (ev: PointerEvent) => {
          const r = rectToLogical(stage.getBoundingClientRect());
          const [lx, ly] = clientToLogical(ev.clientX, ev.clientY);
          const x = roundSpawn(Math.max(0, Math.min(map.widthM, (lx - r.left - ox) / pxPerM)));
          const y = roundSpawn(Math.max(0, Math.min(map.heightM, (ly - r.top - oy) / pxPerM)));
          spawns[i] = [x, y];
          place();
        };
        const up = () => {
          el.classList.remove('is-drag');
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
      });
    });
    root.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => this.closeModal()));
    root.querySelector('#team-layout-reset')?.addEventListener('click', () => {
      this.mapDefaultSpawns(st.mapId).forEach((p, i) => (spawns[i] = [p[0], p[1]]));
      place();
    });
    saveBtn.addEventListener('click', () => {
      const ms = side.maps[st.mapId];
      ms.spawns = spawns.map((p) => [p[0], p[1]] as SpawnM);
      ms.preset = null;
      this.persist();
      this.closeModal();
      this.render();
    });
  }

  // ---------------------------------------------------------------- 开局

  private start() {
    const st = this.state!;
    if (this.cb.isLoading() || this.formationIssues().length) return;
    const map = teamMap(st.mapId);
    const setup: TeamMatchSetup = {
      mapId: st.mapId,
      mode: map.mode,
      sides: st.sides.map((side) => ({
        slots: side.slots.map((s) => ({ ...s })),
        tactics: side.maps[st.mapId].tactics.map((t) => ({ ...t })),
        spawns: side.maps[st.mapId].spawns.map((p) => [p[0], p[1]] as SpawnM),
        label: classifyTeam(side.slots).label,
      })) as TeamMatchSetup['sides'],
    };
    if (this.role === 'host') {
      if (teamRoom.state.match) return;
      // 联机：只发座位上是谁（成员 id + 昵称），每台机器按同一份开局信息拼配置
      const seats = setup.sides.flatMap((side) => side.slots.map((sl) => (sl.kind === 'human' && sl.member !== undefined ? sl.member : null)));
      const plain: TeamMatchSetup = {
        ...setup,
        sides: setup.sides.map((side) => ({
          ...side,
          slots: side.slots.map((sl) => (sl.kind === 'human' ? { kind: 'human' } : { kind: 'bot', botId: sl.botId })),
        })) as TeamMatchSetup['sides'],
      };
      this.cb.onStartRoomMatch({
        matchId: `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
        mapId: st.mapId,
        seed: generateSpawnSeed(),
        spawnSeed: generateSpawnSeed(),
        bgmSeed: generateBgmSeed(),
        speed: st.speed,
        setup: plain,
        seats,
        names: seats.map((id) => (id === null ? null : this.memberName(id))),
      });
      return;
    }
    const slots = buildTeamSlotConfigs(setup, setup.sides.flatMap((x) => x.slots).findIndex((x) => x.kind === 'human'));
    const s = this.cb.settings.get();
    this.cb.onStartMatch({
      matchMode: 'team',
      mapId: st.mapId,
      mapMeta: this.mapMeta(st.mapId),
      slots,
      seed: generateSpawnSeed(),
      spawnSeed: generateSpawnSeed(),
      bgmSeed: generateBgmSeed(),
      speed: st.speed,
      cliffGuard: s.cliffGuard,
      dashGuard: s.dashGuard,
      meleeAssist: s.meleeAssist,
      humanSlashTicks: getSlashJudgmentTicks(s.slashJudgment),
      team: setup,
    });
  }

  /** 大厅 loading 状态变化时刷新开始按钮 */
  public syncLoading() {
    this.syncStartNote();
  }
}

// splitPresetPlan 的薄包装（同一套预设反复套用时省一次解析）
const splitCache = new Map<string, Record<string, SlotTactic>>();
function splitPresetPlanCached(team: OrigTeam, plan: string, mode: TeamModeNum, king: string | null) {
  const key = `${team}|${mode}|${king}|${plan}`;
  let v = splitCache.get(key);
  if (!v) {
    v = splitPresetPlan(team, plan, mode, king);
    splitCache.set(key, v);
  }
  const out: Record<string, SlotTactic> = {};
  for (const [k, t] of Object.entries(v)) out[k] = { ...t };
  return out;
}

