// 团队赛联机房间的浏览器端连接（中转 /team）。整个页面只有一个，切换大厅页签、进出对局都不断开。
import { isPvpAvailable, pvpServerUrl } from './pvpConfig';
import {
  TEAM_ROOM_PROTOCOL,
  type RoomAction,
  type RoomClientMessage,
  type RoomErrorReason,
  type RoomInfo,
  type RoomMatchStart,
  type RoomRematchState,
  type RoomServerMessage,
} from './teamRoomProtocol';

export type TeamRoomStatus = 'idle' | 'connecting' | 'in-room';

export interface TeamRoomSnapshot {
  status: TeamRoomStatus;
  room: RoomInfo | null;
  me: number;
  rttMs: number | null;
  error: string | null;
  /** 房间里正在进行的对局（开局信息），没有为 null */
  match: RoomMatchStart | null;
  rematch: (RoomRematchState & { localDeadline: number | null }) | null;
}

type Listener<T> = (v: T) => void;

const ERROR_TEXT: Record<RoomErrorReason, string> = {
  version: '版本不一致：请双方都刷新页面',
  not_found: '没有这个房间号',
  full: '房间已满（20 人）',
  busy: '服务器房间已满，请稍后再试',
  bad: '房间号是 6 位数字',
  rate_limited: '操作太频繁，请稍后再试',
};

export function teamRoomUrl(): string | null {
  if (!isPvpAvailable()) return null;
  try {
    const url = new URL(pvpServerUrl()!);
    url.pathname = '/team';
    url.search = '';
    return url.toString();
  } catch {
    return null;
  }
}

export class TeamRoomClient {
  private ws: WebSocket | null = null;
  private pending: RoomClientMessage | null = null;
  private pingTimer: number | null = null;
  private snap: TeamRoomSnapshot = { status: 'idle', room: null, me: 0, rttMs: null, error: null, match: null, rematch: null };
  private readonly listeners = new Set<Listener<TeamRoomSnapshot>>();
  private readonly lobbyListeners = new Set<Listener<unknown>>();
  private readonly claimListeners = new Set<Listener<{ from: number; side: number; slot: number } | { from: number; unclaim: true }>>();
  private readonly startListeners = new Set<Listener<RoomMatchStart>>();
  private readonly frameListeners = new Set<Listener<{ matchId: string; from: number; acts: string[] }>>();
  private readonly inputListeners = new Set<Listener<{ from: number; action: RoomAction }>>();
  private readonly endListeners = new Set<Listener<{ matchId: string; aborted: boolean; reason?: string }>>();
  /** 收到最新的大厅状态（房主发的） */
  public lastLobby: unknown = null;

  get state(): TeamRoomSnapshot {
    return this.snap;
  }
  get inRoom(): boolean {
    return this.snap.status === 'in-room' && this.snap.room !== null;
  }
  get isHost(): boolean {
    return this.inRoom && this.snap.room!.hostId === this.snap.me;
  }
  memberName(id: number): string | null {
    return this.snap.room?.members.find((m) => m.id === id)?.name ?? null;
  }

  onChange(fn: Listener<TeamRoomSnapshot>) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  onLobby(fn: Listener<unknown>) { this.lobbyListeners.add(fn); return () => this.lobbyListeners.delete(fn); }
  onClaim(fn: Listener<{ from: number; side: number; slot: number } | { from: number; unclaim: true }>) {
    this.claimListeners.add(fn);
    return () => this.claimListeners.delete(fn);
  }
  onStart(fn: Listener<RoomMatchStart>) { this.startListeners.add(fn); return () => this.startListeners.delete(fn); }
  onFrames(fn: Listener<{ matchId: string; from: number; acts: string[] }>) { this.frameListeners.add(fn); return () => this.frameListeners.delete(fn); }
  onInput(fn: Listener<{ from: number; action: RoomAction }>) { this.inputListeners.add(fn); return () => this.inputListeners.delete(fn); }
  onEnd(fn: Listener<{ matchId: string; aborted: boolean; reason?: string }>) { this.endListeners.add(fn); return () => this.endListeners.delete(fn); }

  private set(patch: Partial<TeamRoomSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn(this.snap);
  }

  create() {
    this.connectThen({ type: 'create' });
  }

  join(code: string) {
    const c = code.trim();
    if (!/^\d{6}$/.test(c)) {
      this.set({ error: ERROR_TEXT.bad });
      return;
    }
    this.connectThen({ type: 'join', code: c });
  }

  leave() {
    this.send({ type: 'leave' });
    this.close();
  }

  send(msg: RoomClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private connectThen(first: RoomClientMessage) {
    const url = teamRoomUrl();
    if (!url) {
      this.set({ error: '联机服务未开启' });
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send(first);
      return;
    }
    this.close(true);
    this.pending = first;
    this.set({ status: 'connecting', error: null });
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.set({ status: 'idle', error: '连不上联机服务器' });
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.send({ type: 'hello', protocol: TEAM_ROOM_PROTOCOL, buildId: __BUILD_ID__ });
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws || typeof ev.data !== 'string') return;
      let msg: RoomServerMessage;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.receive(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      const wasIn = this.snap.status === 'in-room';
      this.close(true);
      this.set({ error: wasIn ? '与联机服务器的连接断开了' : this.snap.error ?? '连不上联机服务器' });
    };
  }

  private receive(msg: RoomServerMessage) {
    switch (msg.type) {
      case 'welcome':
        if (this.pending) {
          this.send(this.pending);
          this.pending = null;
        }
        this.startPing();
        return;
      case 'room': {
        const wasHost = this.isHost;
        this.set({ status: 'in-room', room: msg.room, me: msg.me, error: null });
        // 刚成为房主（原房主走了）：沿用最后一份大厅状态
        if (!wasHost && this.isHost && this.lastLobby) for (const fn of this.lobbyListeners) fn(this.lastLobby);
        return;
      }
      case 'left':
        this.close();
        return;
      case 'error':
        this.set({ error: ERROR_TEXT[msg.reason] ?? '联机出错了' });
        if (this.snap.status !== 'in-room') this.close(true);
        return;
      case 'pong':
        this.set({ rttMs: Math.max(0, Math.round(performance.now() - msg.t)) });
        return;
      case 'lobby':
        this.lastLobby = msg.lobby;
        for (const fn of this.lobbyListeners) fn(msg.lobby);
        return;
      case 'claim':
        for (const fn of this.claimListeners) fn({ from: msg.from, side: msg.side, slot: msg.slot });
        return;
      case 'unclaim':
        for (const fn of this.claimListeners) fn({ from: msg.from, unclaim: true });
        return;
      case 'start':
        this.set({ match: msg.start, rematch: null });
        for (const fn of this.startListeners) fn(msg.start);
        return;
      case 'frames':
        for (const fn of this.frameListeners) fn(msg);
        return;
      case 'input':
        for (const fn of this.inputListeners) fn(msg);
        return;
      case 'end':
        if (this.snap.match?.matchId === msg.matchId) this.set({ match: null });
        for (const fn of this.endListeners) fn(msg);
        return;
      case 'rematch': {
        const { type: _t, serverTime, ...rest } = msg;
        void _t;
        // 倒计时按本机时钟走：服务器时间差 + 半个往返
        const localDeadline =
          rest.countdownUntil === null ? null : performance.now() + (rest.countdownUntil - serverTime) - (this.snap.rttMs ?? 0) / 2;
        this.set({ rematch: { ...rest, localDeadline } });
        return;
      }
    }
  }

  private startPing() {
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    const ping = () => this.send({ type: 'ping', t: Math.round(performance.now()) });
    ping();
    this.pingTimer = window.setInterval(ping, 2000);
  }

  private close(keepError = false) {
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    this.pingTimer = null;
    const ws = this.ws;
    this.ws = null;
    this.pending = null;
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
    this.lastLobby = null;
    this.set({ status: 'idle', room: null, me: 0, rttMs: null, match: null, rematch: null, error: keepError ? this.snap.error : null });
  }
}

export const teamRoom = new TeamRoomClient();
