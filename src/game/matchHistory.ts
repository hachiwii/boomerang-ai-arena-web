import { EloUpdateResult } from './leaderboard';
import { EngineMapData, MatchConfig, MatchMode, SlotConfig, TickSnapshot } from './types';

export const MAX_HISTORY_RECORDS = 50;

const DB_NAME = 'boomerang_arena_history_v1';
const DB_VERSION = 1;
const STORE_SUMMARIES = 'summaries';
const STORE_REPLAYS = 'replays';

export interface HistoryPlayerSummary {
  seat: number;
  kind: 'human' | 'bot';
  botId?: string;
  displayName: string;
  color: string;
  ringAccent?: string;
  avatar: string | null;
  rank: number;
  kills: number;
  alive: boolean;
  cause: number;
  killer: number;
}

export interface MatchHistorySummary {
  id: string;
  playedAt: number;
  matchMode: MatchMode;
  mapId: string;
  mapTitle: string;
  mapTheme: string;
  seed: number;
  speed: number;
  durationTicks: number;
  tickCount: number;
  humanSeat: number;
  winner: number;
  earlyExit: boolean;
  slots: SlotConfig[];
  players: HistoryPlayerSummary[];
  eloDelta: number | null;
  eloAfter: number | null;
  eloOldRank: number | null;
  eloNewRank: number | null;
}

export interface MatchReplayPayload {
  id: string;
  mapData: EngineMapData;
  ticks: TickSnapshot[];
}

export interface MatchReplayBundle {
  summary: MatchHistorySummary;
  replay: MatchReplayPayload;
}

let idSeq = 0;

export function buildMatchHistoryBundle(
  config: MatchConfig,
  mapData: EngineMapData,
  ticks: TickSnapshot[],
  eloResult: EloUpdateResult | null,
  earlyExit: boolean,
): MatchReplayBundle {
  const playedAt = Date.now();
  idSeq = (idSeq + 1) % 100000;
  const id = `${playedAt}-${String(idSeq).padStart(5, '0')}`;
  const finalState = ticks[ticks.length - 1];
  const humanSeat = config.slots.findIndex((s) => s.kind === 'human');

  const players: HistoryPlayerSummary[] = config.slots.map((slot, seat) => {
    const p = finalState?.players[seat];
    return {
      seat,
      kind: slot.kind,
      botId: slot.botId,
      displayName: slot.displayName,
      color: slot.color,
      ringAccent: slot.ringAccent,
      avatar: slot.avatar,
      rank: p ? p.rank : config.slots.length,
      kills: p ? p.kills : 0,
      alive: p ? p.alive === 1 : false,
      cause: p ? p.cause : 0,
      killer: p ? p.killer : -1,
    };
  });

  const summary: MatchHistorySummary = {
    id,
    playedAt,
    matchMode: config.matchMode,
    mapId: config.mapId,
    mapTitle: config.mapMeta.title,
    mapTheme: config.mapMeta.theme,
    seed: config.seed,
    speed: config.speed,
    durationTicks: finalState ? finalState.t : Math.max(0, ticks.length - 1),
    tickCount: ticks.length,
    humanSeat,
    winner: finalState ? finalState.winner : -1,
    earlyExit,
    slots: config.slots.map((s) => ({ ...s })),
    players,
    eloDelta: eloResult ? eloResult.delta : null,
    eloAfter: eloResult ? eloResult.newRating : null,
    eloOldRank: eloResult ? eloResult.oldRank : null,
    eloNewRank: eloResult ? eloResult.newRank : null,
  };

  const replay: MatchReplayPayload = {
    id,
    mapData,
    ticks,
  };

  return { summary, replay };
}

/**
 * Local IndexedDB-backed match history store retaining the latest 50 matches
 * (Ranked SOLO, Ranked FFA, and Custom) with full tick snapshots for instant
 * spectator-perspective replay & timeline scrubbing.
 */
export class MatchHistoryStore {
  private dbPromise: Promise<IDBDatabase | null> | null = null;
  private memFallback = false;
  private memSummaries = new Map<string, MatchHistorySummary>();
  private memReplays = new Map<string, MatchReplayPayload>();
  private listeners = new Set<() => void>();

  private openDb(): Promise<IDBDatabase | null> {
    if (this.memFallback) return Promise.resolve(null);
    if (this.dbPromise) return this.dbPromise;
    if (typeof indexedDB === 'undefined') {
      this.memFallback = true;
      return Promise.resolve(null);
    }

    this.dbPromise = new Promise<IDBDatabase | null>((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_SUMMARIES)) {
            const s = db.createObjectStore(STORE_SUMMARIES, { keyPath: 'id' });
            s.createIndex('playedAt', 'playedAt', { unique: false });
          }
          if (!db.objectStoreNames.contains(STORE_REPLAYS)) {
            db.createObjectStore(STORE_REPLAYS, { keyPath: 'id' });
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          db.onversionchange = () => {
            db.close();
            this.dbPromise = null;
          };
          resolve(db);
        };
        req.onerror = () => {
          this.memFallback = true;
          resolve(null);
        };
      } catch {
        this.memFallback = true;
        resolve(null);
      }
    });
    return this.dbPromise;
  }

  public onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emitChange() {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (err) {
        console.error('MatchHistoryStore listener error:', err);
      }
    }
  }

  public async saveBundle(bundle: MatchReplayBundle): Promise<void> {
    const db = await this.openDb();
    if (!db) {
      this.memSummaries.set(bundle.summary.id, bundle.summary);
      this.memReplays.set(bundle.replay.id, bundle.replay);
      this.pruneMemory();
      this.emitChange();
      return;
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction([STORE_SUMMARIES, STORE_REPLAYS], 'readwrite');
        const sumStore = tx.objectStore(STORE_SUMMARIES);
        const repStore = tx.objectStore(STORE_REPLAYS);

        sumStore.put(bundle.summary);
        repStore.put(bundle.replay);

        const allReq = sumStore.getAll();
        allReq.onsuccess = () => {
          const rows = (allReq.result as MatchHistorySummary[]) || [];
          if (rows.length > MAX_HISTORY_RECORDS) {
            rows.sort((a, b) => b.playedAt - a.playedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
            const stale = rows.slice(MAX_HISTORY_RECORDS);
            for (const old of stale) {
              sumStore.delete(old.id);
              repStore.delete(old.id);
            }
          }
        };

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('IndexedDB save failed'));
        tx.onabort = () => reject(tx.error || new Error('IndexedDB save aborted'));
      });
    } catch (err) {
      console.warn('MatchHistoryStore IndexedDB save failed, falling back to memory:', err);
      this.memSummaries.set(bundle.summary.id, bundle.summary);
      this.memReplays.set(bundle.replay.id, bundle.replay);
      this.pruneMemory();
    }
    this.emitChange();
  }

  private sortSummaries(rows: MatchHistorySummary[]): MatchHistorySummary[] {
    return rows.sort((a, b) => b.playedAt - a.playedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  }

  public async listSummaries(): Promise<MatchHistorySummary[]> {
    const db = await this.openDb();
    if (!db) {
      return this.sortSummaries(Array.from(this.memSummaries.values())).slice(0, MAX_HISTORY_RECORDS);
    }

    try {
      const rows = await new Promise<MatchHistorySummary[]>((resolve, reject) => {
        const tx = db.transaction([STORE_SUMMARIES], 'readonly');
        const req = tx.objectStore(STORE_SUMMARIES).getAll();
        req.onsuccess = () => resolve((req.result as MatchHistorySummary[]) || []);
        req.onerror = () => reject(req.error || new Error('IndexedDB read failed'));
      });
      // Merge any memory-fallback items if present
      const byId = new Map<string, MatchHistorySummary>();
      for (const r of rows) byId.set(r.id, r);
      for (const r of this.memSummaries.values()) byId.set(r.id, r);
      return this.sortSummaries(Array.from(byId.values())).slice(0, MAX_HISTORY_RECORDS);
    } catch {
      return this.sortSummaries(Array.from(this.memSummaries.values())).slice(0, MAX_HISTORY_RECORDS);
    }
  }

  public async getReplayBundle(id: string): Promise<MatchReplayBundle | null> {
    if (this.memSummaries.has(id) && this.memReplays.has(id)) {
      return {
        summary: this.memSummaries.get(id)!,
        replay: this.memReplays.get(id)!,
      };
    }

    const db = await this.openDb();
    if (!db) return null;

    try {
      return await new Promise<MatchReplayBundle | null>((resolve, reject) => {
        const tx = db.transaction([STORE_SUMMARIES, STORE_REPLAYS], 'readonly');
        const sumReq = tx.objectStore(STORE_SUMMARIES).get(id);
        const repReq = tx.objectStore(STORE_REPLAYS).get(id);
        tx.oncomplete = () => {
          const summary = sumReq.result as MatchHistorySummary | undefined;
          const replay = repReq.result as MatchReplayPayload | undefined;
          if (!summary || !replay || !Array.isArray(replay.ticks) || replay.ticks.length === 0) {
            resolve(null);
            return;
          }
          resolve({ summary, replay });
        };
        tx.onerror = () => reject(tx.error || new Error('IndexedDB get failed'));
      });
    } catch {
      return null;
    }
  }

  public async deleteMatch(id: string): Promise<void> {
    this.memSummaries.delete(id);
    this.memReplays.delete(id);
    const db = await this.openDb();
    if (db) {
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction([STORE_SUMMARIES, STORE_REPLAYS], 'readwrite');
          tx.objectStore(STORE_SUMMARIES).delete(id);
          tx.objectStore(STORE_REPLAYS).delete(id);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } catch {
        // Ignore
      }
    }
    this.emitChange();
  }

  public async clearAll(): Promise<void> {
    this.memSummaries.clear();
    this.memReplays.clear();
    const db = await this.openDb();
    if (db) {
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction([STORE_SUMMARIES, STORE_REPLAYS], 'readwrite');
          tx.objectStore(STORE_SUMMARIES).clear();
          tx.objectStore(STORE_REPLAYS).clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } catch {
        // Ignore
      }
    }
    this.emitChange();
  }

  private pruneMemory() {
    if (this.memSummaries.size <= MAX_HISTORY_RECORDS) return;
    const sorted = this.sortSummaries(Array.from(this.memSummaries.values()));
    for (const old of sorted.slice(MAX_HISTORY_RECORDS)) {
      this.memSummaries.delete(old.id);
      this.memReplays.delete(old.id);
    }
  }
}
