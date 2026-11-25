import type {
  PvpChallengeResult,
  PvpCodeInfo,
  PvpConnState,
  PvpLobbyClient,
  PvpLobbyEventMap,
  PvpNetStats,
} from './pvpTypes';
import { PVP_CODE_TTL_MS } from './pvpTypes';

/**
 * Offline stand-in for the real client (UI development, `?pvpMock=1`). Codes: 000000 → offline, 111111 → busy,
 * 222222 → not_found, 333333 → version, 444444 → network; anything else succeeds and fires matchStart.
 */
export class PvpLobbyMock implements PvpLobbyClient {
  private state: PvpConnState = 'idle';
  private code: PvpCodeInfo = { code: null, expiresAt: null };
  private stats: PvpNetStats = { rttMs: null, transport: 'ws' };
  private listeners = new Map<keyof PvpLobbyEventMap, Set<(v: unknown) => void>>();
  private timer: number | null = null;

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
      // ?pvpMockRtt=180 pins the simulated latency (UI colour checks)
      const pinned = Number(new URLSearchParams(location.search).get('pvpMockRtt'));
      const rtt = Number.isFinite(pinned) && pinned > 0 ? pinned : 18 + Math.random() * 30;
      this.stats = { rttMs: Math.round(rtt), jitterMs: Math.round(Math.random() * 6), transport: 'ws' };
      this.emit('stats', this.stats);
    }, 1000);
  }

  leave() {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
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
    this.emit('matchStart', {
      matchId: `mock-${Date.now()}`,
      mySeat: 0,
      challenger: true,
      mapId: 'twinlakes',
      seed: (Math.random() * 0x7fffffff) | 0,
      spawnSeed: ((Math.random() * 0x7fffffff) | 0) || 1,
      bgmSeed: (Math.random() * 0x7fffffff) | 0,
    });
    return { ok: true };
  }

  on<K extends keyof PvpLobbyEventMap>(ev: K, cb: (v: PvpLobbyEventMap[K]) => void): () => void {
    let set = this.listeners.get(ev);
    if (!set) this.listeners.set(ev, (set = new Set()));
    set.add(cb as (v: unknown) => void);
    return () => set!.delete(cb as (v: unknown) => void);
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
