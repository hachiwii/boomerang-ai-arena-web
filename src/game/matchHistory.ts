import { EloUpdateResult } from './leaderboard';
import { EngineMapData, MatchConfig, MatchMode, SlotConfig, TickSnapshot } from './types';

export const MAX_HISTORY_PER_MODE = 50;
export const HISTORY_MODE_BUCKETS = ['ranked', 'cricket', 'custom'] as const;
export type HistoryModeBucket = (typeof HISTORY_MODE_BUCKETS)[number];
export const MAX_HISTORY_RECORDS = MAX_HISTORY_PER_MODE * HISTORY_MODE_BUCKETS.length;

export function getHistoryModeBucket(matchMode: MatchMode): HistoryModeBucket {
  if (matchMode === 'ranked-solo' || matchMode === 'ranked-ffa') return 'ranked';
  if (matchMode === 'cricket') return 'cricket';
  return 'custom';
}

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
  bgmSeed?: number;
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
  favorite?: boolean;
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
    bgmSeed: config.bgmSeed ?? config.seed,
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
    favorite: false,
  };

  const replay: MatchReplayPayload = {
    id,
    mapData,
    ticks,
  };

  return { summary, replay };
}

/**
 * Local IndexedDB-backed match history store retaining up to 50 matches per mode
 * (Ranked, Cricket, and Custom) with full tick snapshots for instant
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
    const targetBucket = getHistoryModeBucket(bundle.summary.matchMode);
    const db = await this.openDb();
    if (!db) {
      this.memSummaries.set(bundle.summary.id, bundle.summary);
      this.memReplays.set(bundle.replay.id, bundle.replay);
      this.pruneMemory(targetBucket);
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
          const staleIds = this.findOverflowIds(rows, targetBucket);
          for (const oldId of staleIds) {
            sumStore.delete(oldId);
            repStore.delete(oldId);
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
      this.pruneMemory(targetBucket);
    }
    this.emitChange();
  }

  private sortSummaries(rows: MatchHistorySummary[]): MatchHistorySummary[] {
    return rows.sort((a, b) => b.playedAt - a.playedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  }

  /**
   * Computes non-favorited overflow IDs exceeding MAX_HISTORY_PER_MODE.
   * Favorited records are permanently retained and exempt from the quota.
   * When targetBucket is specified (during saveBundle), only that mode bucket is pruned,
   * so an un-favorited older match is evicted only after the next match of that same mode.
   */
  public findOverflowIds(rows: MatchHistorySummary[], targetBucket?: HistoryModeBucket): string[] {
    const buckets: readonly HistoryModeBucket[] = targetBucket ? [targetBucket] : HISTORY_MODE_BUCKETS;
    const byBucket: Record<HistoryModeBucket, MatchHistorySummary[]> = {
      ranked: [],
      cricket: [],
      custom: [],
    };
    for (const r of rows) {
      if (r.favorite) continue;
      byBucket[getHistoryModeBucket(r.matchMode)].push(r);
    }
    const staleIds: string[] = [];
    for (const bucket of buckets) {
      const list = byBucket[bucket];
      if (list.length <= MAX_HISTORY_PER_MODE) continue;
      this.sortSummaries(list);
      for (const old of list.slice(MAX_HISTORY_PER_MODE)) {
        staleIds.push(old.id);
      }
    }
    return staleIds;
  }

  public async listSummaries(): Promise<MatchHistorySummary[]> {
    const db = await this.openDb();
    if (!db) {
      return this.sortSummaries(Array.from(this.memSummaries.values()));
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
      return this.sortSummaries(Array.from(byId.values()));
    } catch {
      return this.sortSummaries(Array.from(this.memSummaries.values()));
    }
  }

  /**
   * Marks or unmarks a match summary as favorite without pruning immediately.
   * Removing favorite from an older record leaves it in place until the next
   * match of the same mode triggers per-mode quota pruning.
   */
  public async setFavorite(id: string, favorite: boolean): Promise<boolean> {
    let updated = false;
    const memRow = this.memSummaries.get(id);
    if (memRow) {
      memRow.favorite = favorite;
      updated = true;
    }

    const db = await this.openDb();
    if (db) {
      try {
        const dbUpdated = await new Promise<boolean>((resolve, reject) => {
          const tx = db.transaction([STORE_SUMMARIES], 'readwrite');
          const sumStore = tx.objectStore(STORE_SUMMARIES);
          const getReq = sumStore.get(id);
          let didUpdate = false;
          getReq.onsuccess = () => {
            const row = getReq.result as MatchHistorySummary | undefined;
            if (row) {
              row.favorite = favorite;
              sumStore.put(row);
              didUpdate = true;
            }
          };
          tx.oncomplete = () => resolve(didUpdate);
          tx.onerror = () => reject(tx.error || new Error('IndexedDB favorite update failed'));
          tx.onabort = () => reject(tx.error || new Error('IndexedDB favorite update aborted'));
        });
        if (dbUpdated) updated = true;
      } catch (err) {
        console.warn('MatchHistoryStore setFavorite failed:', err);
      }
    }

    if (updated) {
      this.emitChange();
    }
    return updated;
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

  public async clearNonFavorites(): Promise<void> {
    for (const [id, row] of Array.from(this.memSummaries.entries())) {
      if (!row.favorite) {
        this.memSummaries.delete(id);
        this.memReplays.delete(id);
      }
    }
    const db = await this.openDb();
    if (db) {
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction([STORE_SUMMARIES, STORE_REPLAYS], 'readwrite');
          const sumStore = tx.objectStore(STORE_SUMMARIES);
          const repStore = tx.objectStore(STORE_REPLAYS);
          const allReq = sumStore.getAll();
          allReq.onsuccess = () => {
            const rows = (allReq.result as MatchHistorySummary[]) || [];
            for (const row of rows) {
              if (!row.favorite) {
                sumStore.delete(row.id);
                repStore.delete(row.id);
              }
            }
          };
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

  private pruneMemory(targetBucket?: HistoryModeBucket) {
    const staleIds = this.findOverflowIds(Array.from(this.memSummaries.values()), targetBucket);
    for (const oldId of staleIds) {
      this.memSummaries.delete(oldId);
      this.memReplays.delete(oldId);
    }
  }
}
