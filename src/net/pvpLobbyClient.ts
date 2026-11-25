import type {
  PvpChallengeResult, PvpCodeInfo, PvpConnState, PvpLobbyClient, PvpLobbyEventMap, PvpMatchInfo, PvpNetStats,
  PvpRematchState,
} from './pvpTypes';
import type { ClientMessage, MatchMessage, ServerMessage } from './pvpProtocol';
import { PVP_PROTOCOL } from './pvpProtocol';
import { mockPvpMatchLink, type PvpMatchLink } from './pvpMatchLink';
import { PvpLobbyMock } from './pvpLobbyMock';
import { isPvpAvailable, pvpServerUrl } from './pvpConfig';

const TOKEN_KEY = 'boomerang-pvp-token';
const UNAVAILABLE: PvpChallengeResult = { ok: false, reason: 'network' };
const EMPTY_CODE: PvpCodeInfo = { code: null, expiresAt: null };
const EMPTY_STATS: PvpNetStats = { rttMs: null, transport: 'ws' };
const PING_TIMEOUT_MS = 6000;


function storedToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

interface MatchConnection {
  info: PvpMatchInfo;
  listeners: Set<(message: MatchMessage) => void>;
  ready: boolean;
  quit: boolean;
  peerConnected?: boolean;
  hashes: Map<number, string>;
  end?: Extract<ClientMessage, { type: 'end' }>;
  postgameChoice?: 'rematch' | 'left';
}

class RelayPvpLobbyClient implements PvpLobbyClient {
  private state: PvpConnState = 'idle';
  private code = EMPTY_CODE;
  private stats = EMPTY_STATS;
  private token = storedToken();
  private listeners = new Map<keyof PvpLobbyEventMap, Set<(value: unknown) => void>>();
  private socket: WebSocket | null = null;
  private tabOpen = false;
  private mapPool: string[] = [];
  private match: MatchConnection | null = null;
  private postgame: PvpRematchState | null = null;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  private reconnectAttempts = 0;
  private replaced = false;
  private lastPong = 0;
  private lastRtt: number | null = null;
  private clockSamples: { at: number; rtt: number; offset: number }[] = [];
  private offset = Date.now() - performance.now();
  private requestId = 0;
  private requests = new Map<number, (message: ServerMessage | null) => void>();

  constructor() {
    document.addEventListener('visibilitychange', () => this.syncPresence());
    window.addEventListener('pagehide', () => this.leaveRematch());
    window.addEventListener('offline', () => {
      if (this.socket) this.disconnect(this.socket);
    });
    window.addEventListener('online', () => {
      if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.syncPresence();
    });
  }

  getState() { return this.state; }
  getCode() { return this.code; }
  getStats() { return this.stats; }

  setMapPool(mapIds: string[]) {
    const ids = [...new Set(mapIds)].sort();
    if (ids.length === this.mapPool.length && ids.every((id, i) => id === this.mapPool[i])) return;
    this.mapPool = ids;
    this.send({ type: 'mapPool', ids });
  }

  requestRematch() {
    const postgame = this.postgame;
    if (postgame) {
      if (postgame.me === 'undecided' && postgame.opponent !== 'left') {
        this.send({ type: 'rematch', matchId: postgame.matchId, choice: 'rematch' });
      }
    } else if (this.match?.end && this.match.postgameChoice !== 'left') {
      // The local engine can reach its confirmed end before the peer reports.
      this.match.postgameChoice = 'rematch';
    }
  }

  leaveRematch() {
    const postgame = this.postgame;
    if (postgame) {
      this.send({ type: 'rematch', matchId: postgame.matchId, choice: 'left' });
      this.postgame = null;
      this.syncPresence();
    } else if (this.match?.end) {
      this.match.postgameChoice = 'left';
    }
  }

  enter() {
    if (this.tabOpen) return;
    this.replaced = false;
    this.tabOpen = true;
    this.syncPresence();
  }

  leave() {
    if (!this.tabOpen) return;
    this.tabOpen = false;
    this.syncPresence();
  }

  async resetCode(): Promise<string | null> {
    const result = await this.request({ type: 'resetCode', request: ++this.requestId });
    return result?.type === 'code' ? result.code : null;
  }

  async challenge(code: string): Promise<PvpChallengeResult> {
    if (!/^\d{6}$/.test(code)) return { ok: false, reason: 'invalid' };
    if (code === this.code.code) return { ok: false, reason: 'self' };
    const result = await this.request({ type: 'challenge', request: ++this.requestId, code });
    return result?.type === 'challengeResult' ? result.result : UNAVAILABLE;
  }

  on<K extends keyof PvpLobbyEventMap>(event: K, listener: (value: PvpLobbyEventMap[K]) => void): () => void {
    let listeners = this.listeners.get(event);
    if (!listeners) this.listeners.set(event, (listeners = new Set()));
    listeners.add(listener as (value: unknown) => void);
    return () => listeners.delete(listener as (value: unknown) => void);
  }

  matchLink(matchId: string): PvpMatchLink | null {
    const match = this.match;
    if (match?.info.matchId !== matchId) return null;
    const send = (message: ClientMessage) => { if (this.match === match) this.send(message); };
    return {
      serverNow: () => performance.now() + this.offset,
      onMessage: (listener) => {
        match.listeners.add(listener);
        return () => match.listeners.delete(listener);
      },
      ready: () => {
        match.ready = true;
        send({ type: 'ready', matchId });
      },
      input: (frame, action) => send({ type: 'input', matchId, frame, action }),
      hash: (frame, hash) => {
        match.hashes.set(frame, hash);
        send({ type: 'hash', matchId, frame, hash });
      },
      end: (result) => {
        match.end = { type: 'end', matchId, ...result };
        send(match.end);
      },
      quit: () => {
        if (match.quit) return;
        match.quit = true;
        send({ type: 'quit', matchId });
      },
      setRollbackFrames: (frames) => {
        if (this.match === match) this.stats = { ...this.stats, rollbackFrames: frames };
      },
    };
  }

  private emit<K extends keyof PvpLobbyEventMap>(event: K, value: PvpLobbyEventMap[K]) {
    this.listeners.get(event)?.forEach((listener) => listener(value));
  }

  private setState(state: PvpConnState) {
    if (state !== this.state) {
      this.state = state;
      this.emit('state', state);
    }
  }

  private present() {
    return this.tabOpen && !this.match && !this.postgame && document.visibilityState === 'visible';
  }

  private wantsSocket() {
    return !this.replaced && (this.present() || !!this.match || !!this.postgame);
  }

  private syncPresence() {
    if (this.state === 'online') this.send({ type: 'presence', present: this.present() });
    if (this.wantsSocket()) {
      this.connect();
    } else {
      this.stopTimers();
      const socket = this.socket;
      this.socket = null;
      socket?.close();
      this.resolveRequests();
      this.setState('idle');
    }
  }

  private setCode(code: string | null, expiresAt: number) {
    this.code = { code, expiresAt: expiresAt - (performance.now() + this.offset - Date.now()) };
    this.emit('code', this.code);
  }

  private connect() {
    if (this.socket || this.reconnectTimer !== null || !this.wantsSocket()) return;
    const url = pvpServerUrl();
    if (!isPvpAvailable() || !url) return; // PvP switched off in this build (VITE_PVP_ENABLED / VITE_PVP_URL)
    this.setState(this.reconnectAttempts ? 'reconnecting' : 'connecting');
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.lastPong = performance.now();
    this.schedulePing(socket, 500);
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.send({
        type: 'hello', protocol: PVP_PROTOCOL, buildId: __BUILD_ID__, token: this.token, matchId: this.match?.info.matchId,
      }, true);
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket || typeof event.data !== 'string') return;
      let message: ServerMessage;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message && typeof message === 'object') this.receive(message);
    };
    socket.onclose = (event) => this.disconnect(socket, event.code === 4001, event.code === 4003);
  }

  private disconnect(socket: WebSocket, replaced = false, outdated = false) {
    if (this.socket !== socket) return;
    this.socket = null;
    socket.close();
    this.stopTimers();
    this.resolveRequests();
    this.stats = { ...this.stats, rttMs: null, jitterMs: undefined };
    this.emit('stats', this.stats);
    this.lastRtt = null;
    this.clockSamples = [];
    if (this.postgame) {
      const rematch: PvpRematchState = { ...this.postgame, me: 'left' };
      this.postgame = null;
      this.emit('rematch', rematch);
    }
    if (outdated) {
      // The relay speaks another protocol version: reconnecting cannot help, the page must be reloaded
      this.replaced = true;
      this.setState('offline');
      this.emit('notice', '游戏已更新，请刷新页面后再进行 PvP');
      this.endUnavailableMatch();
    } else if (replaced) {
      this.replaced = true;
      this.setState('offline');
      this.emit('notice', 'PvP 会话已在另一个页面打开');
      this.endUnavailableMatch();
    } else if (this.wantsSocket()) {
      if (this.match) this.emit('notice', '连接已断开，正在重连…');
      this.scheduleReconnect();
    } else {
      this.setState('idle');
    }
  }

  private receive(message: ServerMessage) {
    switch (message.type) {
      case 'welcome':
        this.token = message.token;
        try { localStorage.setItem(TOKEN_KEY, message.token); } catch { /* storage unavailable */ }
        this.reconnectAttempts = 0;
        this.setState('online');
        this.setCode(message.code, message.expiresAt);
        if (this.match && this.match.info.matchId !== message.matchId) this.endUnavailableMatch();
        this.send({ type: 'mapPool', ids: this.mapPool });
        this.send({ type: 'presence', present: this.present() });
        this.ping();
        return;
      case 'code':
        this.setCode(message.code, message.expiresAt);
        if (message.request !== undefined) this.requests.get(message.request)?.(message);
        return;
      case 'challengeResult':
        this.requests.get(message.request)?.(message);
        return;
      case 'pong':
        this.onPong(message);
        return;
      case 'rematch':
        if (this.postgame?.matchId === message.matchId) {
          const { matchId, me, opponent } = message;
          this.postgame = { matchId, me, opponent };
          this.emit('rematch', this.postgame);
        }
        return;
      case 'matchStart': {
        const match = this.match;
        if (match?.info.matchId === message.info.matchId) {
          this.emit('notice', '已重新连接');
          // Reports whose socket closed in flight are safe to repeat on resume.
          for (const [frame, hash] of match.hashes) {
            this.send({ type: 'hash', matchId: match.info.matchId, frame, hash });
          }
          if (match.quit) this.send({ type: 'quit', matchId: match.info.matchId });
          else if (match.end) this.send(match.end);
          else if (match.ready) this.send({ type: 'ready', matchId: match.info.matchId });
        } else {
          this.postgame = null;
          this.match = { info: message.info, ready: false, quit: false, listeners: new Set(), hashes: new Map() };
          this.emit('matchStart', message.info);
        }
        return;
      }
    }
    const match = this.match;
    if (!match || match.info.matchId !== message.matchId) return;
    if (message.type === 'go') this.stats = { ...this.stats, inputDelayFrames: message.delay, rollbackFrames: 0 };
    if (message.type === 'peer' && match.peerConnected !== message.connected) {
      if (!message.connected) this.emit('notice', '对方已断开，等待重连…');
      else if (match.peerConnected === false) this.emit('notice', '对方已重连');
      match.peerConnected = message.connected;
    }
    for (const listener of match.listeners) listener(message);
    if (message.type === 'terminal') {
      if (message.reason !== 'cancelled') {
        this.postgame = { matchId: message.matchId, me: 'undecided', opponent: 'undecided' };
      }
      this.releaseMatch();
      if (match.quit || match.postgameChoice === 'left') this.leaveRematch();
      else if (match.postgameChoice === 'rematch') this.requestRematch();
    }
  }

  private releaseMatch() {
    this.match = null;
    const { rttMs, jitterMs } = this.stats;
    this.stats = { rttMs, jitterMs, transport: 'ws' };
    this.syncPresence();
  }

  private endUnavailableMatch() {
    const match = this.match;
    if (!match) return;
    this.emit('notice', '对局连接已结束');
    for (const listener of match.listeners) {
      listener({ type: 'terminal', matchId: match.info.matchId, reason: 'cancelled', through: -1 });
    }
    this.releaseMatch();
  }

  private onPong(message: Extract<ServerMessage, { type: 'pong' }>) {
    const at = performance.now();
    const rtt = Math.max(0, at - message.t);
    this.lastPong = at;
    this.clockSamples = this.clockSamples.filter((sample) => at - sample.at <= 15_000);
    this.clockSamples.push({ at, rtt, offset: message.serverTime - (at + message.t) / 2 });
    this.offset = this.clockSamples.reduce((best, sample) => sample.rtt < best.rtt ? sample : best).offset;
    const smoothed = this.stats.rttMs ?? rtt;
    const jitter = this.stats.jitterMs ?? 0;
    this.stats = {
      ...this.stats,
      rttMs: smoothed + (rtt - smoothed) * 0.2,
      jitterMs: jitter + (Math.abs(rtt - (this.lastRtt ?? rtt)) - jitter) * 0.2,
    };
    this.lastRtt = rtt;
    this.emit('stats', this.stats);
    if (!this.match && this.code.code !== null) this.setCode(this.code.code, message.expiresAt);
  }

  private ping() {
    this.send({
      type: 'ping', t: Math.round(performance.now()),
      rttMs: this.stats.rttMs === null ? undefined : Math.round(this.stats.rttMs),
    });
  }

  private schedulePing(socket: WebSocket, wait: number) {
    this.pingTimer = window.setTimeout(() => {
      this.pingTimer = null;
      if (this.socket !== socket) return;
      if (performance.now() - this.lastPong > PING_TIMEOUT_MS) {
        // A throttled page may run its timer before a queued pong. Probe once on wake.
        const previous = this.lastPong;
        this.ping();
        this.pingTimer = window.setTimeout(() => {
          if (this.socket !== socket) return;
          if (this.lastPong === previous) this.disconnect(socket);
          else this.schedulePing(socket, this.match ? 500 : 1000);
        }, 1500);
        return;
      }
      this.ping();
      this.schedulePing(socket, this.match ? 500 : 1000);
    }, wait);
  }

  private scheduleReconnect() {
    const wait = Math.min(5000, 250 * 2 ** this.reconnectAttempts++);
    this.setState('reconnecting');
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, wait);
  }

  private stopTimers() {
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    if (this.pingTimer !== null) window.clearTimeout(this.pingTimer);
    this.reconnectTimer = null;
    this.pingTimer = null;
  }

  private send(message: ClientMessage, beforeWelcome = false): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || (!beforeWelcome && this.state !== 'online')) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  private request(message: Extract<ClientMessage, { request: number }>): Promise<ServerMessage | null> {
    if (!this.send(message)) return Promise.resolve(null);
    return new Promise((resolve) => {
      const finish = (result: ServerMessage | null) => {
        window.clearTimeout(timer);
        this.requests.delete(message.request);
        resolve(result);
      };
      const timer = window.setTimeout(() => finish(null), 5000);
      this.requests.set(message.request, finish);
    });
  }

  private resolveRequests() {
    for (const finish of this.requests.values()) finish(null);
  }
}

let instance: PvpLobbyClient | null = null;

export function getPvpLobbyClient(): PvpLobbyClient {
  if (!instance) {
    const mock = new URLSearchParams(window.location.search).get('pvpMock') === '1';
    instance = mock ? new PvpLobbyMock() : new RelayPvpLobbyClient();
  }
  return instance;
}

export function getPvpMatchLink(matchId: string): PvpMatchLink | null {
  const client = getPvpLobbyClient();
  return client instanceof RelayPvpLobbyClient ? client.matchLink(matchId) : mockPvpMatchLink(matchId);
}
