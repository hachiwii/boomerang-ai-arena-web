import type {
  PvpChallengeResult,
  PvpCodeInfo,
  PvpConnState,
  PvpLobbyClient,
  PvpLobbyEventMap,
  PvpMatchInfo,
  PvpNetStats,
  PvpRematchChoice,
  PvpRematchState,
} from './pvpTypes';
import { PVP_CODE_TTL_MS } from './pvpTypes';

/** Map ids of public/assets/maps/manifest.json (standard + large) for the mock's draw from an empty pool. */
const MOCK_ALL_MAPS = [
  'twinlakes', 'yinyang', 'stonecircle', 'skybridge', 'ruins', 'icefloes', // standard
  'hourglass', 'canyon', 'oldtown', 'forest', // large
];

function queryParam(name: string): string | null {
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}

function randomSeed(): number {
  return ((Math.random() * 0x7fffffff) | 0) || 1;
}

/**
 * Offline stand-in for the real client (UI development, `?pvpMock=1`).
 *
 * Challenge codes: 000000 → offline, 111111 → busy, 222222 → not_found, 333333 → version, 444444 → network;
 * anything else succeeds and fires matchStart (you are P1, the map comes from the opponent's pool = every map).
 *
 * Query flags:
 * - `pvpMockRtt=<ms>`: pin the simulated latency.
 * - `pvpMockIncoming=<s>`: someone enters your code <s> seconds after you open the PvP tab (you are P2; the map is
 *   drawn from your own PvP pool, as the relay does for the challenged side).
 * - `pvpMockOpp=rematch|left|none` (default rematch): what the opponent picks on the result screen, ~1.5 s after
 *   your own choice — or on its own `pvpMockOppAfter=<s>` seconds after a match starts (to see the
 *   对方想再来一局 / 对方已退出 states before you choose).
 *
 * Dev console: `__pvpMock.opponent('rematch' | 'left')` sets the opponent's choice for the current match.
 */
export class PvpLobbyMock implements PvpLobbyClient {
  private state: PvpConnState = 'idle';
  private code: PvpCodeInfo = { code: null, expiresAt: null };
  private stats: PvpNetStats = { rttMs: null, transport: 'ws' };
  private listeners = new Map<keyof PvpLobbyEventMap, Set<(v: unknown) => void>>();
  private timer: number | null = null;
  private incomingTimer: number | null = null;
  private mapPool: string[] = [];
  private match: PvpMatchInfo | null = null;
  private rematch: PvpRematchState | null = null;
  private opponentTimer: number | null = null;
  private rematchStartTimer: number | null = null;

  constructor() {
    if (import.meta.env.DEV) {
      (window as unknown as { __pvpMock?: unknown }).__pvpMock = {
        client: this,
        opponent: (choice: PvpRematchChoice) => this.setRematchChoice('opponent', choice),
      };
    }
  }

  getState() { return this.state; }
  getCode() { return this.code; }
  getStats() { return this.stats; }

  enter() {
    if (this.timer !== null) return;
    // Like the real client, the socket stays up after leave(): coming back only resumes presence
    if (this.state !== 'online') {
      this.setState('connecting');
      window.setTimeout(() => {
        if (this.timer === null) return;
        this.setState('online');
        if (!this.code.code) this.code = { code: this.randomCode(), expiresAt: Date.now() + PVP_CODE_TTL_MS };
        this.emit('code', this.code);
      }, 400);
    }
    this.timer = window.setInterval(() => {
      if (this.state !== 'online') return;
      this.code = { ...this.code, expiresAt: Date.now() + PVP_CODE_TTL_MS };
      const pinned = Number(queryParam('pvpMockRtt'));
      const rtt = Number.isFinite(pinned) && pinned > 0 ? pinned : 18 + Math.random() * 30;
      this.stats = { rttMs: Math.round(rtt), jitterMs: Math.round(Math.random() * 6), transport: 'ws' };
      this.emit('stats', this.stats);
    }, 1000);
    const incomingSec = Number(queryParam('pvpMockIncoming'));
    if (Number.isFinite(incomingSec) && incomingSec > 0) {
      this.incomingTimer = window.setTimeout(() => {
        this.incomingTimer = null;
        // Only a player who is still on the PvP tab can be challenged
        if (this.timer === null || this.state !== 'online') return;
        this.startMatch({ mySeat: 1, challenger: false });
      }, incomingSec * 1000);
    }
  }

  leave() {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    if (this.incomingTimer !== null) window.clearTimeout(this.incomingTimer);
    this.incomingTimer = null;
  }

  async resetCode() {
    await new Promise((r) => window.setTimeout(r, 300));
    this.code = { code: this.randomCode(), expiresAt: Date.now() + PVP_CODE_TTL_MS };
    this.emit('code', this.code);
    return this.code.code;
  }

  async challenge(code: string): Promise<PvpChallengeResult> {
    await new Promise((r) => window.setTimeout(r, 500));
    if (!/^\d{6}$/.test(code)) return { ok: false, reason: 'invalid' };
    if (code === this.code.code) return { ok: false, reason: 'self' };
    const fixed: Record<string, PvpChallengeResult> = {
      '000000': { ok: false, reason: 'offline' },
      '111111': { ok: false, reason: 'busy' },
      '222222': { ok: false, reason: 'not_found' },
      '333333': { ok: false, reason: 'version' },
      '444444': { ok: false, reason: 'network' },
    };
    if (fixed[code]) return fixed[code];
    this.startMatch({ mySeat: 0, challenger: true });
    return { ok: true };
  }

  setMapPool(mapIds: string[]) {
    this.mapPool = mapIds.slice();
  }

  requestRematch() {
    this.setRematchChoice('me', 'rematch');
  }

  leaveRematch() {
    this.setRematchChoice('me', 'left');
  }

  on<K extends keyof PvpLobbyEventMap>(ev: K, cb: (v: PvpLobbyEventMap[K]) => void): () => void {
    let set = this.listeners.get(ev);
    if (!set) this.listeners.set(ev, (set = new Set()));
    set.add(cb as (v: unknown) => void);
    return () => set!.delete(cb as (v: unknown) => void);
  }

  /** Like the relay: the map comes from the CHALLENGED side's pool (empty = every map), seeds are fresh. */
  private startMatch(seat: { mySeat: 0 | 1; challenger: boolean }, rematchOf?: string) {
    this.clearRematchTimers();
    const pool = seat.challenger ? [] : this.mapPool; // the mock opponent keeps every map in its pool
    const choices = pool.length > 0 ? pool : MOCK_ALL_MAPS;
    const info: PvpMatchInfo = {
      matchId: `mock-${Date.now()}`,
      mySeat: seat.mySeat,
      challenger: seat.challenger,
      mapId: choices[Math.floor(Math.random() * choices.length)],
      seed: randomSeed(),
      spawnSeed: randomSeed(),
      bgmSeed: randomSeed(),
      ...(rematchOf ? { rematchOf } : {}),
    };
    this.match = info;
    this.rematch = { matchId: info.matchId, me: 'undecided', opponent: 'undecided' };
    const afterSec = Number(queryParam('pvpMockOppAfter'));
    if (Number.isFinite(afterSec) && afterSec > 0) {
      this.opponentTimer = window.setTimeout(() => this.opponentDecides(), afterSec * 1000);
    }
    this.emit('matchStart', info);
  }

  private opponentDecides() {
    this.opponentTimer = null;
    const pick = queryParam('pvpMockOpp') ?? 'rematch';
    if (pick === 'rematch' || pick === 'left') this.setRematchChoice('opponent', pick);
  }

  private setRematchChoice(who: 'me' | 'opponent', choice: PvpRematchChoice) {
    const cur = this.rematch;
    const match = this.match;
    if (!cur || !match || cur[who] === 'left' || cur[who] === choice) return;
    // Like the relay: once one side has left, the other cannot ask for a rematch any more
    if (choice === 'rematch' && (cur.me === 'left' || cur.opponent === 'left')) return;
    const next: PvpRematchState = { ...cur, [who]: choice };
    this.rematch = next;
    this.emit('rematch', next);
    if (who === 'me' && next.opponent === 'undecided' && this.opponentTimer === null) {
      this.opponentTimer = window.setTimeout(() => this.opponentDecides(), 1500);
    }
    if (next.me === 'left' || next.opponent === 'left') {
      this.clearRematchTimers();
      if (next.me === 'left') this.match = null;
      return;
    }
    if (next.me === 'rematch' && next.opponent === 'rematch') {
      this.rematchStartTimer = window.setTimeout(() => {
        this.rematchStartTimer = null;
        this.startMatch({ mySeat: match.mySeat, challenger: match.challenger }, match.matchId);
      }, 800);
    }
  }

  private clearRematchTimers() {
    if (this.opponentTimer !== null) window.clearTimeout(this.opponentTimer);
    if (this.rematchStartTimer !== null) window.clearTimeout(this.rematchStartTimer);
    this.opponentTimer = null;
    this.rematchStartTimer = null;
  }

  private emit<K extends keyof PvpLobbyEventMap>(ev: K, v: PvpLobbyEventMap[K]) {
    this.listeners.get(ev)?.forEach((cb) => cb(v));
  }

  private setState(s: PvpConnState) {
    this.state = s;
    this.emit('state', s);
  }

  private randomCode() {
    return String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
  }
}
