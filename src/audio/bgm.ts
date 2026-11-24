import { MatchMode, SlotConfig, TickSnapshot } from '../game/types';

export type BgmTrackId = 'main' | 'boss' | 'astra_solo' | 'astra_win';

export const FABLE_BOT_ID = 'claude-fable-5.2';
export const ASTRA_BOT_ID = 'gpt-6.2-astra';

/** Crossfade duration between any two BGM tracks (seconds). */
export const BGM_FADE_SEC = 0.5;

/**
 * bgm_main.mp3 contains [2*L - 0.5s, 3*L + 0.5s] of the exact periodic loop
 * (L = 3,836,345 samples at 48 kHz = 79.9238541667s). Because both loopStart
 * and loopEnd sit 0.5s inside the periodic region, any MP3 decoder priming
 * offset shifts both points equally, yielding 100% click-free gapless looping
 * across Chrome, Safari, Firefox, and Edge.
 */
export const MAIN_LOOP_PAD_SEC = 0.5;
export const MAIN_LOOP_PERIOD_SEC = 3836345 / 48000;

export const BGM_TRACK_URLS: Record<BgmTrackId, string> = {
  main: '/assets/audio/bgm_main.mp3',
  boss: '/assets/audio/bgm_boss.mp3',
  astra_solo: '/assets/audio/bgm_astra_solo.mp3',
  astra_win: '/assets/audio/bgm_astra_win.mp3',
};

/** Probability (in percent) of triggering Astra's special SOLO BGM. */
export const ASTRA_SOLO_SPECIAL_BGM_PCT = 33;

export interface BgmMatchContext {
  matchMode: MatchMode;
  bgmSeed: number;
  slots: SlotConfig[];
}

/**
 * Generates an independent 32-bit random seed exclusively for BGM selection,
 * decoupled from the game simulation seed (and freshly re-rolled on Custom restart).
 */
export function generateBgmSeed(): number {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0] || 1;
  }
  return ((Math.imul(Date.now() >>> 0, 2654435761) ^ Math.floor(Math.random() * 0x100000000)) >>> 0) || 1;
}

export function isBossSlot(slot: SlotConfig | undefined): boolean {
  return !!slot && slot.kind === 'bot' && (slot.botId === FABLE_BOT_ID || slot.botId === ASTRA_BOT_ID);
}

export function isAstraSlot(slot: SlotConfig | undefined): boolean {
  return !!slot && slot.kind === 'bot' && slot.botId === ASTRA_BOT_ID;
}

/**
 * Deterministic 32-bit MurmurHash3 finalizer over the BGM seed so live matches
 * and all subsequent replays of the same match always select identical BGM.
 */
export function hashMatchSeed(seed: number): number {
  let h = (seed >>> 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h;
}

/** Exact 33% deterministic roll for any Human vs Astra 1v1 SOLO special BGM. */
export function shouldUseAstraSoloSpecialBgm(bgmSeed: number): boolean {
  return (hashMatchSeed(bgmSeed) % 100) < ASTRA_SOLO_SPECIAL_BGM_PCT;
}

export function isAstraSoloSpecialContext(ctx: BgmMatchContext): boolean {
  if (ctx.slots.length !== 2) return false;
  const humanSeat = ctx.slots.findIndex((s) => s.kind === 'human');
  const astraSeat = ctx.slots.findIndex((s) => isAstraSlot(s));
  return humanSeat >= 0 && astraSeat >= 0 && shouldUseAstraSoloSpecialBgm(ctx.bgmSeed);
}

/**
 * Predicts which BGM track a match will start with on tick 0 / countdown.
 */
export function predictInitialMatchTrack(ctx: BgmMatchContext, bossMusicEnabled: boolean): BgmTrackId {
  if (!bossMusicEnabled) return 'main';
  if (isAstraSoloSpecialContext(ctx)) return 'astra_solo';
  if (ctx.slots.length === 2 && ctx.slots.some((s) => isBossSlot(s))) {
    return 'boss';
  }
  return 'main';
}

/**
 * Lists any special BGM tracks that could possibly trigger during this match,
 * so BgmManager can prefetch & decode them in the background for zero-latency switches.
 */
export function getPrefetchTracksForMatch(ctx: BgmMatchContext, bossMusicEnabled: boolean): BgmTrackId[] {
  if (!bossMusicEnabled) return [];
  if (isAstraSoloSpecialContext(ctx)) {
    return ['astra_solo', 'astra_win'];
  }
  if (ctx.slots.length >= 2 && ctx.slots.some((s) => isBossSlot(s))) {
    return ['boss'];
  }
  return [];
}

export type BossDuelStatus = 'idle' | 'active' | 'challenger_won' | 'challenger_dead';
export type AstraSoloStatus = 'active' | 'human_won' | 'astra_won' | 'draw';

/**
 * Pure, deterministic BGM rule engine shared by live matches, live AI spectators,
 * and saved history replays (including arbitrary timeline seeking).
 */
export class BgmRuleEngine {
  public mode: 'lobby' | 'match' = 'lobby';
  public ctx: BgmMatchContext | null = null;
  public isAstraSoloSpecial = false;
  public humanSeat = -1;
  public astraSeat = -1;
  public astraSoloStatus: AstraSoloStatus = 'active';
  public bossDuelStatus: BossDuelStatus = 'idle';
  public bossDuelChallengerSeat = -1;
  public bossDuelBossSeat = -1;
  public bossDuelSecondBossSeat = -1;
  public bossDuelIsBossVsBoss = false;

  public enterLobby() {
    this.mode = 'lobby';
    this.ctx = null;
    this.isAstraSoloSpecial = false;
    this.humanSeat = -1;
    this.astraSeat = -1;
    this.astraSoloStatus = 'active';
    this.bossDuelStatus = 'idle';
    this.bossDuelChallengerSeat = -1;
    this.bossDuelBossSeat = -1;
    this.bossDuelSecondBossSeat = -1;
    this.bossDuelIsBossVsBoss = false;
  }

  public beginMatch(ctx: BgmMatchContext, initialSnapshot?: TickSnapshot | null) {
    this.mode = 'match';
    this.ctx = ctx;
    this.humanSeat = ctx.slots.findIndex((s) => s.kind === 'human');
    this.astraSeat = ctx.slots.findIndex((s) => isAstraSlot(s));
    this.isAstraSoloSpecial = isAstraSoloSpecialContext(ctx);
    this.astraSoloStatus = 'active';
    this.bossDuelStatus = 'idle';
    this.bossDuelChallengerSeat = -1;
    this.bossDuelBossSeat = -1;
    this.bossDuelSecondBossSeat = -1;
    this.bossDuelIsBossVsBoss = false;

    if (initialSnapshot) {
      this.updateTick(initialSnapshot);
    } else if (!this.isAstraSoloSpecial && ctx.slots.length === 2) {
      const bossSeats: number[] = [];
      const nonBossSeats: number[] = [];
      for (let i = 0; i < ctx.slots.length; i++) {
        if (isBossSlot(ctx.slots[i])) bossSeats.push(i);
        else nonBossSeats.push(i);
      }
      if (bossSeats.length === 1 && nonBossSeats.length === 1) {
        this.bossDuelStatus = 'active';
        this.bossDuelIsBossVsBoss = false;
        this.bossDuelBossSeat = bossSeats[0];
        this.bossDuelSecondBossSeat = -1;
        this.bossDuelChallengerSeat = nonBossSeats[0];
      } else if (bossSeats.length === 2) {
        this.bossDuelStatus = 'active';
        this.bossDuelIsBossVsBoss = true;
        this.bossDuelBossSeat = bossSeats[0];
        this.bossDuelSecondBossSeat = bossSeats[1];
        this.bossDuelChallengerSeat = -1;
      }
    }
  }

  public updateTick(snapshot: TickSnapshot) {
    if (this.mode !== 'match' || !this.ctx) return;

    if (this.isAstraSoloSpecial) {
      const hp = snapshot.players[this.humanSeat];
      const ap = snapshot.players[this.astraSeat];
      const humanAlive = !!hp && hp.alive === 1;
      const astraAlive = !!ap && ap.alive === 1;

      if (snapshot.over) {
        if (snapshot.winner === this.humanSeat) {
          this.astraSoloStatus = 'human_won';
        } else if (snapshot.winner === this.astraSeat) {
          this.astraSoloStatus = 'astra_won';
        } else if (humanAlive && !astraAlive) {
          this.astraSoloStatus = 'human_won';
        } else if (astraAlive && !humanAlive) {
          this.astraSoloStatus = 'astra_won';
        } else {
          this.astraSoloStatus = 'draw';
        }
      } else {
        if (humanAlive && !astraAlive) {
          this.astraSoloStatus = 'human_won';
        } else if (astraAlive && !humanAlive) {
          this.astraSoloStatus = 'astra_won';
        } else if (!humanAlive && !astraAlive) {
          this.astraSoloStatus = 'draw';
        } else {
          this.astraSoloStatus = 'active';
        }
      }
      return;
    }

    // General Boss BGM rule: exactly 2 alive AND at least 1 of them is Fable or Astra
    if (this.bossDuelStatus === 'idle') {
      if (!snapshot.over) {
        const aliveSeats: number[] = [];
        for (let i = 0; i < snapshot.players.length; i++) {
          if (snapshot.players[i]?.alive === 1) aliveSeats.push(i);
        }
        if (aliveSeats.length === 2) {
          const aliveBoss = aliveSeats.filter((seat) => isBossSlot(this.ctx!.slots[seat]));
          const aliveNonBoss = aliveSeats.filter((seat) => !isBossSlot(this.ctx!.slots[seat]));
          if (aliveBoss.length === 1 && aliveNonBoss.length === 1) {
            this.bossDuelStatus = 'active';
            this.bossDuelIsBossVsBoss = false;
            this.bossDuelBossSeat = aliveBoss[0];
            this.bossDuelSecondBossSeat = -1;
            this.bossDuelChallengerSeat = aliveNonBoss[0];
          } else if (aliveBoss.length === 2) {
            this.bossDuelStatus = 'active';
            this.bossDuelIsBossVsBoss = true;
            this.bossDuelBossSeat = aliveBoss[0];
            this.bossDuelSecondBossSeat = aliveBoss[1];
            this.bossDuelChallengerSeat = -1;
          }
        }
      }
      return;
    }

    if (this.bossDuelStatus === 'active') {
      if (this.bossDuelIsBossVsBoss) {
        const bossA = snapshot.players[this.bossDuelBossSeat];
        const bossB = snapshot.players[this.bossDuelSecondBossSeat];
        const aAlive = !!bossA && bossA.alive === 1;
        const bAlive = !!bossB && bossB.alive === 1;

        if (!aAlive && !bAlive) {
          // Mutual kill draw: stop Boss BGM immediately.
          this.bossDuelStatus = 'challenger_dead';
        } else if (aAlive !== bAlive) {
          // One boss defeated the other: keep playing Boss BGM through celebration until lobby / next match / EOF!
          this.bossDuelStatus = 'challenger_won';
        } else if (snapshot.over) {
          if (
            snapshot.winner === this.bossDuelBossSeat ||
            snapshot.winner === this.bossDuelSecondBossSeat
          ) {
            this.bossDuelStatus = 'challenger_won';
          } else {
            // Timeout draw with both alive.
            this.bossDuelStatus = 'challenger_dead';
          }
        }
        return;
      }

      const challenger = snapshot.players[this.bossDuelChallengerSeat];
      const boss = snapshot.players[this.bossDuelBossSeat];
      const challengerAlive = !!challenger && challenger.alive === 1;
      const bossAlive = !!boss && boss.alive === 1;

      if (!challengerAlive) {
        // Non-Fable/Astra side died (including mutual kill): stop Boss BGM immediately.
        this.bossDuelStatus = 'challenger_dead';
      } else if ((snapshot.over && snapshot.winner === this.bossDuelChallengerSeat) || !bossAlive) {
        // Non-Fable/Astra side defeated Fable/Astra: keep playing Boss BGM until lobby / next match / EOF!
        this.bossDuelStatus = 'challenger_won';
      } else if (snapshot.over) {
        // Match ended without challenger winning (e.g., timeout draw with both alive).
        this.bossDuelStatus = 'challenger_dead';
      }
    }
  }

  /**
   * Re-evaluates the exact BGM state at an arbitrary replay tick index (for scrubbing/restart).
   */
  public syncReplayAtIndex(ticks: TickSnapshot[], tickIndex: number) {
    if (this.mode !== 'match' || !this.ctx || ticks.length === 0) return;
    const clamped = Math.max(0, Math.min(ticks.length - 1, Math.round(tickIndex)));
    this.astraSoloStatus = 'active';
    this.bossDuelStatus = 'idle';
    this.bossDuelChallengerSeat = -1;
    this.bossDuelBossSeat = -1;
    this.bossDuelSecondBossSeat = -1;
    this.bossDuelIsBossVsBoss = false;
    for (let i = 0; i <= clamped; i++) {
      this.updateTick(ticks[i]);
    }
  }

  public getDesiredTrack(bossMusicEnabled: boolean): BgmTrackId {
    if (!bossMusicEnabled || this.mode !== 'match' || !this.ctx) {
      return 'main';
    }
    if (this.isAstraSoloSpecial) {
      if (this.astraSoloStatus === 'human_won') return 'astra_win';
      if (this.astraSoloStatus === 'active' || this.astraSoloStatus === 'astra_won') return 'astra_solo';
      return 'main';
    }
    if (this.bossDuelStatus === 'active' || this.bossDuelStatus === 'challenger_won') {
      return 'boss';
    }
    return 'main';
  }
}

interface ActiveVoice {
  trackId: BgmTrackId;
  sessionId: number;
  source: AudioBufferSourceNode;
  gain: GainNode;
  fadingOut: boolean;
  stopped: boolean;
  stopTimer: number | null;
}

const BGM_MAX_GAIN = 0.56;

export function bgmVolumePctToGain(volumePct: number): number {
  const norm = Math.max(0, Math.min(1, volumePct / 100));
  if (norm <= 0.0001) return 0;
  return Math.pow(norm, 1.35) * BGM_MAX_GAIN;
}

/**
 * Web Audio BGM engine with sample-accurate gapless main-theme looping,
 * 0.5s crossfades, lazy background prefetching, autoplay gesture unlock,
 * and deterministic Boss / Astra SOLO special music playback.
 */
export class BgmManager {
  private readonly rules = new BgmRuleEngine();
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private unlocked = false;
  private unlockListenersBound = false;
  private pageHidden = typeof document !== 'undefined' ? document.hidden : false;

  private bgmEnabled = true;
  private volumePct = 70;
  private bossMusicEnabled = true;

  private matchSessionId = 0;
  private transitionSeq = 0;
  private pendingTrackKey: string | null = null;
  private activeVoice: ActiveVoice | null = null;
  private fadingVoices = new Set<ActiveVoice>();
  private endedTrackKeys = new Set<string>();

  private rawCache = new Map<BgmTrackId, ArrayBuffer>();
  private rawInflight = new Map<BgmTrackId, Promise<ArrayBuffer | null>>();
  private bufferCache = new Map<BgmTrackId, AudioBuffer>();
  private decodeInflight = new Map<BgmTrackId, Promise<AudioBuffer | null>>();

  private readonly handleUnlockGesture: () => void;

  constructor() {
    this.handleUnlockGesture = () => {
      this.unlock();
    };
    this.bindUnlockListeners();
  }

  private bindUnlockListeners() {
    if (this.unlockListenersBound || typeof window === 'undefined') return;
    this.unlockListenersBound = true;
    window.addEventListener('pointerdown', this.handleUnlockGesture, { capture: true, passive: true });
    window.addEventListener('keydown', this.handleUnlockGesture, { capture: true, passive: true });
    window.addEventListener('touchstart', this.handleUnlockGesture, { capture: true, passive: true });
  }

  private unbindUnlockListeners() {
    if (!this.unlockListenersBound || typeof window === 'undefined') return;
    this.unlockListenersBound = false;
    window.removeEventListener('pointerdown', this.handleUnlockGesture, { capture: true });
    window.removeEventListener('keydown', this.handleUnlockGesture, { capture: true });
    window.removeEventListener('touchstart', this.handleUnlockGesture, { capture: true });
  }

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx;
    if (typeof window === 'undefined') return null;
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    this.ctx = new AC();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.setValueAtTime(
      this.bgmEnabled ? bgmVolumePctToGain(this.volumePct) : 0,
      this.ctx.currentTime,
    );
    this.masterGain.connect(this.ctx.destination);
    if (this.ctx.state === 'running') {
      this.unlocked = true;
      this.unbindUnlockListeners();
    }
    return this.ctx;
  }

  public unlock() {
    if (this.pageHidden) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    if (ctx.state === 'running') {
      this.unlocked = true;
      this.unbindUnlockListeners();
      this.syncPlayback();
      return;
    }
    void ctx
      .resume()
      .then(() => {
        if (this.ctx && this.ctx.state === 'running') {
          this.unlocked = true;
          this.unbindUnlockListeners();
          if (!this.pageHidden) {
            this.syncPlayback();
          }
        }
      })
      .catch(() => {
        // Still awaiting user gesture
      });
  }

  /**
   * Automatically suspends audio when the browser tab leaves the foreground
   * and seamlessly resumes from the exact paused position upon returning.
   */
  public setPageHidden(hidden: boolean) {
    if (this.pageHidden === hidden) return;
    this.pageHidden = hidden;
    if (hidden) {
      if (this.ctx && this.ctx.state === 'running') {
        void this.ctx.suspend().catch(() => {});
      }
      return;
    }
    if (!this.bgmEnabled) return;
    if (this.ctx && this.ctx.state === 'suspended' && this.unlocked) {
      void this.ctx
        .resume()
        .then(() => {
          if (!this.pageHidden) {
            this.syncPlayback();
          }
        })
        .catch(() => {});
    } else if (this.unlocked) {
      this.syncPlayback();
    }
  }

  public applySettings(bgmEnabled: boolean, bgmVolumePct: number, bossMusicEnabled: boolean) {
    const prevEnabled = this.bgmEnabled;
    const prevBoss = this.bossMusicEnabled;
    this.bgmEnabled = bgmEnabled;
    this.volumePct = Math.max(0, Math.min(100, Math.round(bgmVolumePct)));
    this.bossMusicEnabled = bossMusicEnabled;

    if (this.ctx && this.masterGain) {
      const now = this.ctx.currentTime;
      const target = this.bgmEnabled ? bgmVolumePctToGain(this.volumePct) : 0;
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setTargetAtTime(target, now, 0.035);
    }

    if (!this.bgmEnabled) {
      if (prevEnabled) {
        this.transitionSeq++;
        this.pendingTrackKey = null;
        this.fadeOutActiveVoice(0.25);
      }
      return;
    }

    if (!prevEnabled || prevBoss !== this.bossMusicEnabled) {
      if (this.rules.mode === 'match' && this.rules.ctx) {
        this.prefetchTracks(getPrefetchTracksForMatch(this.rules.ctx, this.bossMusicEnabled));
      }
      this.syncPlayback();
    }
  }

  public enterLobby() {
    this.rules.enterLobby();
    this.matchSessionId++;
    this.endedTrackKeys.clear();
    this.prefetchTracks(['main']);
    this.syncPlayback();
  }

  /**
   * Called when launching a new match/replay (before WASM/map finishes loading):
   * immediately prefetches needed special BGM tracks and, if the upcoming match
   * starts on normal BGM while a previous match's special BGM is still playing,
   * fades back to main BGM right away.
   */
  public prepareMatchLaunch(ctx: BgmMatchContext) {
    this.prefetchTracks(['main', ...getPrefetchTracksForMatch(ctx, this.bossMusicEnabled)]);
    const predicted = predictInitialMatchTrack(ctx, this.bossMusicEnabled);
    if (predicted === 'main' && this.activeVoice && this.activeVoice.trackId !== 'main') {
      this.rules.enterLobby();
      this.matchSessionId++;
      this.endedTrackKeys.clear();
      this.syncPlayback();
    }
  }

  /**
   * Begins a live match or replay BGM session (called right as countdown starts
   * for live matches / live AI spectators, or tick 0 for saved replays).
   */
  public beginMatch(ctx: BgmMatchContext, initialSnapshot?: TickSnapshot | null) {
    this.matchSessionId++;
    this.endedTrackKeys.clear();
    this.rules.beginMatch(ctx, initialSnapshot);
    this.prefetchTracks(['main', ...getPrefetchTracksForMatch(ctx, this.bossMusicEnabled)]);
    this.syncPlayback();
  }

  public updateMatchTick(snapshot: TickSnapshot) {
    this.rules.updateTick(snapshot);
    this.syncPlayback();
  }

  public syncReplaySeek(ticks: TickSnapshot[], tickIndex: number) {
    this.rules.syncReplayAtIndex(ticks, tickIndex);
    this.syncPlayback();
  }

  public restartReplay(ticks: TickSnapshot[]) {
    this.matchSessionId++;
    this.endedTrackKeys.clear();
    this.rules.syncReplayAtIndex(ticks, 0);
    this.syncPlayback();
  }

  public getDebugState() {
    const effective = this.resolveEffectiveTarget();
    return {
      bgmEnabled: this.bgmEnabled,
      volumePct: this.volumePct,
      bossMusicEnabled: this.bossMusicEnabled,
      mode: this.rules.mode,
      desiredTrack: effective.trackId,
      activeTrack: this.activeVoice?.trackId ?? null,
      audioState: this.ctx?.state ?? 'uninitialized',
      unlocked: this.unlocked,
      pageHidden: this.pageHidden,
      matchSessionId: this.matchSessionId,
      isAstraSoloSpecial: this.rules.isAstraSoloSpecial,
      astraSoloStatus: this.rules.astraSoloStatus,
      bossDuelStatus: this.rules.bossDuelStatus,
    };
  }

  /**
   * Fetches (reusing in-memory cache when available) and decodes a BGM track
   * directly into an arbitrary BaseAudioContext (e.g. OfflineAudioContext for MP4 export).
   */
  public async decodeTrackForContext(
    trackId: BgmTrackId,
    targetCtx: BaseAudioContext,
  ): Promise<AudioBuffer | null> {
    const raw = await this.fetchRaw(trackId);
    if (!raw) return null;
    try {
      return await targetCtx.decodeAudioData(raw.slice(0));
    } catch (err) {
      console.warn(`[BGM] Failed to decode ${trackId} for offline context:`, err);
      return null;
    }
  }

  private prefetchTracks(tracks: BgmTrackId[]) {
    if (!this.bgmEnabled) return;
    for (const id of tracks) {
      void this.fetchRaw(id).then(() => {
        if (this.ctx && !this.bufferCache.has(id)) {
          void this.loadBuffer(id);
        }
      });
    }
  }

  private fetchRaw(trackId: BgmTrackId): Promise<ArrayBuffer | null> {
    const cached = this.rawCache.get(trackId);
    if (cached) return Promise.resolve(cached);
    const inflight = this.rawInflight.get(trackId);
    if (inflight) return inflight;

    const url = `${BGM_TRACK_URLS[trackId]}?v=${typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev'}`;
    const p = fetch(url)
      .then((resp) => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status} loading ${url}`);
        return resp.arrayBuffer();
      })
      .then((ab) => {
        this.rawCache.set(trackId, ab);
        return ab;
      })
      .catch((err) => {
        console.warn(`[BGM] Failed to fetch ${trackId}:`, err);
        return null;
      })
      .finally(() => {
        this.rawInflight.delete(trackId);
      });

    this.rawInflight.set(trackId, p);
    return p;
  }

  private async loadBuffer(trackId: BgmTrackId): Promise<AudioBuffer | null> {
    const cached = this.bufferCache.get(trackId);
    if (cached) return cached;
    const inflight = this.decodeInflight.get(trackId);
    if (inflight) return inflight;

    const ctx = this.ensureContext();
    if (!ctx) return null;

    const p = (async () => {
      const raw = await this.fetchRaw(trackId);
      if (!raw) return null;
      try {
        // Always slice() before decodeAudioData because it detaches the ArrayBuffer!
        const decoded = await ctx.decodeAudioData(raw.slice(0));
        this.bufferCache.set(trackId, decoded);
        return decoded;
      } catch (err) {
        console.warn(`[BGM] Failed to decode ${trackId}:`, err);
        return null;
      }
    })().finally(() => {
      this.decodeInflight.delete(trackId);
    });

    this.decodeInflight.set(trackId, p);
    return p;
  }

  private fadeOutVoice(voice: ActiveVoice, fadeSec: number) {
    if (voice.stopped) return;
    if (voice.stopTimer !== null) {
      window.clearTimeout(voice.stopTimer);
      voice.stopTimer = null;
    }
    voice.fadingOut = true;
    this.fadingVoices.add(voice);

    const ctx = this.ctx;
    if (!ctx || fadeSec <= 0.005) {
      this.hardStopVoice(voice);
      return;
    }

    const now = ctx.currentTime;
    const g = voice.gain.gain;
    const curVal = Number.isFinite(g.value) ? Math.max(0, Math.min(1, g.value)) : 1;
    g.cancelScheduledValues(now);
    g.setValueAtTime(curVal, now);
    g.linearRampToValueAtTime(0, now + fadeSec);

    voice.stopTimer = window.setTimeout(() => {
      voice.stopTimer = null;
      this.hardStopVoice(voice);
    }, Math.ceil(fadeSec * 1000) + 80);
  }

  private hardStopVoice(voice: ActiveVoice) {
    if (voice.stopped) return;
    voice.stopped = true;
    if (voice.stopTimer !== null) {
      window.clearTimeout(voice.stopTimer);
      voice.stopTimer = null;
    }
    try {
      voice.source.onended = null;
      voice.source.stop();
    } catch {
      // Ignore already-stopped source
    }
    try {
      voice.source.disconnect();
      voice.gain.disconnect();
    } catch {
      // Ignore disconnect errors
    }
    this.fadingVoices.delete(voice);
    if (this.activeVoice === voice) {
      this.activeVoice = null;
    }
  }

  private fadeOutActiveVoice(fadeSec: number) {
    const cur = this.activeVoice;
    if (!cur) return;
    this.activeVoice = null;
    this.fadeOutVoice(cur, fadeSec);
  }

  private resolveEffectiveTarget(): { trackId: BgmTrackId; sessionId: number } {
    const rawDesired = this.rules.getDesiredTrack(this.bossMusicEnabled);
    if (rawDesired !== 'main') {
      const endedKey = `${this.matchSessionId}:${rawDesired}`;
      // Once a non-looping special track plays to natural completion, fall back to looping main BGM.
      if (this.endedTrackKeys.has(endedKey)) {
        return { trackId: 'main', sessionId: 0 };
      }
      return { trackId: rawDesired, sessionId: this.matchSessionId };
    }
    return { trackId: 'main', sessionId: 0 };
  }

  private syncPlayback() {
    if (!this.bgmEnabled || this.pageHidden) return;

    const { trackId: desired, sessionId: desiredSessionId } = this.resolveEffectiveTarget();
    const targetKey = `${desiredSessionId}:${desired}`;

    // Already playing the exact desired track (and session for special tracks) -> keep going uninterrupted!
    if (
      this.activeVoice &&
      !this.activeVoice.fadingOut &&
      !this.activeVoice.stopped &&
      this.activeVoice.trackId === desired &&
      this.activeVoice.sessionId === desiredSessionId
    ) {
      this.pendingTrackKey = null;
      return;
    }

    // Always kick off network fetch immediately even before AudioContext unlocks
    void this.fetchRaw(desired);

    if (!this.unlocked) {
      const ctx = this.ensureContext();
      if (!ctx || ctx.state !== 'running') {
        return;
      }
      this.unlocked = true;
      this.unbindUnlockListeners();
    }

    // Already loading/transitioning to this exact desired (session, track) -> avoid churning at 20Hz
    if (this.pendingTrackKey === targetKey) {
      return;
    }

    this.pendingTrackKey = targetKey;
    const seq = ++this.transitionSeq;
    void this.loadBuffer(desired).then((buffer) => {
      if (seq !== this.transitionSeq) return;
      this.pendingTrackKey = null;
      if (!buffer) return;
      if (!this.bgmEnabled || this.pageHidden || !this.ctx || !this.masterGain || this.ctx.state !== 'running') return;

      const latest = this.resolveEffectiveTarget();
      if (latest.trackId !== desired || latest.sessionId !== desiredSessionId) return;

      this.startCrossfadeVoice(desired, desiredSessionId, buffer, BGM_FADE_SEC);
    });
  }

  private startCrossfadeVoice(
    trackId: BgmTrackId,
    sessionId: number,
    buffer: AudioBuffer,
    fadeSec: number,
  ) {
    const ctx = this.ctx;
    const masterGain = this.masterGain;
    if (!ctx || !masterGain) return;

    // Crossfade out the previous active voice over the exact same 0.5s window
    this.fadeOutActiveVoice(fadeSec);

    const now = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + fadeSec);

    source.connect(gain);
    gain.connect(masterGain);

    const voice: ActiveVoice = {
      trackId,
      sessionId,
      source,
      gain,
      fadingOut: false,
      stopped: false,
      stopTimer: null,
    };

    source.onended = () => {
      if (voice.stopped || voice.fadingOut) return;
      voice.stopped = true;
      try {
        source.disconnect();
        gain.disconnect();
      } catch {
        // Ignore
      }
      if (this.activeVoice === voice) {
        this.activeVoice = null;
        if (trackId !== 'main') {
          this.endedTrackKeys.add(`${sessionId}:${trackId}`);
          // Automatically transition back to the looping default BGM (0.5s fade-in).
          this.syncPlayback();
        }
      }
    };

    if (trackId === 'main') {
      source.loop = true;
      source.loopStart = MAIN_LOOP_PAD_SEC;
      source.loopEnd = Math.min(buffer.duration - 0.05, MAIN_LOOP_PAD_SEC + MAIN_LOOP_PERIOD_SEC);
      source.start(now, MAIN_LOOP_PAD_SEC);
    } else {
      source.loop = false;
      source.start(now, 0);
    }

    this.activeVoice = voice;
  }
}
