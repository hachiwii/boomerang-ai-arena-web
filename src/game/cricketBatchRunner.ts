import { buildMatchHistoryBundle, MatchReplayBundle } from './matchHistory';
import { CricketFormat } from './cricketStore';
import { EngineMapData, MatchConfig, TickSnapshot } from './types';

export interface CricketBatchBotSummary {
  botId: string;
  displayName: string;
  avatar: string | null;
  color: string;
  matches: number;
  wins: number;
  winRate: number;
  rankSum: number;
  avgRank: number;
  kills: number;
  deaths: number;
  kd: number;
}

export interface CricketBatchResult {
  format: CricketFormat;
  mapPoolCount: number;
  requestedTotal: number;
  completedMatches: number;
  draws: number;
  elapsedMs: number;
  cancelled: boolean;
  bots: CricketBatchBotSummary[];
}

export interface CricketBatchProgress {
  completed: number;
  total: number;
  elapsedMs: number;
  latestMapTitle: string;
  latestWinnerName: string | null;
  bots: CricketBatchBotSummary[];
}

export interface CricketBatchRunOptions {
  totalMatches: number;
  format: CricketFormat;
  mapPoolCount: number;
  createConfig: () => MatchConfig | null;
  signal: AbortSignal;
  onProgress?: (progress: CricketBatchProgress) => void;
  onMatchComplete?: (bundle: MatchReplayBundle) => void;
}

class WorkerRpcClient {
  private readonly worker: Worker;
  private reqId = 1;
  private pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private dead = false;

  constructor(worker: Worker) {
    this.worker = worker;
    this.worker.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as Record<string, unknown>;
      const id = typeof msg?.reqId === 'number' ? msg.reqId : 0;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (msg.type === 'error') {
        entry.reject(new Error(String(msg.error || 'Worker error')));
      } else {
        entry.resolve(msg);
      }
    };
    this.worker.onerror = (err) => {
      this.failAll(new Error(err.message || 'Worker runtime error'));
    };
  }

  public call(payload: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (this.dead) return Promise.reject(new Error('Worker terminated'));
    if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    return new Promise((resolve, reject) => {
      const id = this.reqId++;
      const onAbort = () => {
        if (this.pending.delete(id)) {
          reject(new DOMException('Aborted', 'AbortError'));
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: (v) => {
          signal.removeEventListener('abort', onAbort);
          resolve(v);
        },
        reject: (e) => {
          signal.removeEventListener('abort', onAbort);
          reject(e);
        },
      });
      this.worker.postMessage({ ...payload, reqId: id });
    });
  }

  public terminate() {
    if (this.dead) return;
    this.dead = true;
    this.failAll(new DOMException('Aborted', 'AbortError'));
    try {
      this.worker.terminate();
    } catch {
      // Ignore worker teardown errors
    }
  }

  private failAll(err: Error) {
    for (const entry of this.pending.values()) {
      entry.reject(err);
    }
    this.pending.clear();
  }
}

export function sortBatchBotSummaries(rows: CricketBatchBotSummary[]): CricketBatchBotSummary[] {
  return [...rows].sort(
    (a, b) =>
      b.winRate - a.winRate ||
      a.avgRank - b.avgRank ||
      b.kd - a.kd ||
      b.matches - a.matches ||
      a.displayName.localeCompare(b.displayName, 'zh-Hans-CN'),
  );
}

function buildBotSnapshots(acc: Map<string, CricketBatchBotSummary>): CricketBatchBotSummary[] {
  const rows: CricketBatchBotSummary[] = [];
  for (const s of acc.values()) {
    rows.push({
      ...s,
      winRate: s.matches > 0 ? s.wins / s.matches : 0,
      avgRank: s.matches > 0 ? s.rankSum / s.matches : 0,
      kd: s.deaths === 0 ? s.kills : s.kills / s.deaths,
    });
  }
  return sortBatchBotSummaries(rows);
}

/**
 * Simulates a batch of pure-AI Cricket matches in the background across parallel
 * reusable Worker lanes (1 engine WASM + N bot WASMs per lane), keeping the UI
 * smooth while producing full replay bundles and aggregated per-bot statistics.
 */
export async function runCricketBatch(opts: CricketBatchRunOptions): Promise<CricketBatchResult> {
  const { totalMatches, format, mapPoolCount, createConfig, signal, onProgress, onMatchComplete } = opts;
  const startedAt = performance.now();

  const configs: MatchConfig[] = [];
  for (let i = 0; i < totalMatches; i++) {
    const cfg = createConfig();
    if (!cfg) {
      throw new Error('当前斗蛐蛐配置不足以开始对局，请检查图池与选手名单');
    }
    configs.push(cfg);
  }

  const origin = window.location.origin;
  const uniqueMapIds = Array.from(new Set(configs.map((c) => c.mapId)));
  const mapTexts = new Map<string, string>();

  await Promise.all(
    uniqueMapIds.map(async (mapId) => {
      const resp = await fetch(`${origin}/assets/maps/${mapId}.txt?v=${__BUILD_ID__}`, { signal });
      if (!resp.ok) throw new Error(`无法加载地图 ${mapId}`);
      mapTexts.set(mapId, await resp.text());
    }),
  );

  if (signal.aborted) {
    return {
      format,
      mapPoolCount,
      requestedTotal: totalMatches,
      completedMatches: 0,
      draws: 0,
      elapsedMs: performance.now() - startedAt,
      cancelled: true,
      bots: [],
    };
  }

  const maxPlayers = Math.max(2, configs[0]?.slots.length ?? 2);
  const hw = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4;
  // Cap parallel worker lanes so we finish 50 matches rapidly without starving memory/CPU on mobile or laptops
  const laneCount = Math.min(totalMatches, Math.max(2, Math.min(4, Math.floor(hw / 2))));

  const botStats = new Map<string, CricketBatchBotSummary>();
  let completedMatches = 0;
  let draws = 0;
  let nextConfigIdx = 0;

  const lanes: { engine: WorkerRpcClient; bots: WorkerRpcClient[] }[] = [];
  const terminateAllLanes = () => {
    for (const lane of lanes) {
      lane.engine.terminate();
      for (const b of lane.bots) b.terminate();
    }
    lanes.length = 0;
  };

  const onAbortSignal = () => {
    terminateAllLanes();
  };
  signal.addEventListener('abort', onAbortSignal, { once: true });

  const simulateOneMatch = async (
    lane: { engine: WorkerRpcClient; bots: WorkerRpcClient[] },
    cfg: MatchConfig,
  ): Promise<MatchReplayBundle | null> => {
    const mapText = mapTexts.get(cfg.mapId);
    if (!mapText) throw new Error(`缺少地图数据 ${cfg.mapId}`);
    const n = cfg.slots.length;
    const botSeats = cfg.slots.map((_, idx) => idx);

    const initRes = await lane.engine.call(
      {
        type: 'init',
        origin,
        buildId: __BUILD_ID__,
        mapText,
        nPlayers: n,
        seed: cfg.seed,
        spawnSeed: cfg.spawnSeed ?? 0,
        botSeats,
        humanSeat: -1,
        cliffGuard: cfg.cliffGuard,
      },
      signal,
    );
    if (signal.aborted) return null;

    const mapData = initRes.mapData as EngineMapData;
    let curSnap = initRes.state as TickSnapshot;
    const headers = initRes.headers as Record<number, string>;
    let curObs = initRes.obs as Record<number, string>;

    await Promise.all(
      botSeats.map(async (seat) => {
        const slot = cfg.slots[seat];
        const res = await lane.bots[seat].call(
          {
            type: 'init',
            origin,
            buildId: __BUILD_ID__,
            botId: slot.botId!,
            header: headers[seat],
          },
          signal,
        );
        if (!res.ok) {
          throw new Error(`Bot ${slot.displayName} 初始化失败`);
        }
      }),
    );
    if (signal.aborted) return null;

    const ticks: TickSnapshot[] = [curSnap];
    const MAX_SAFETY_TICKS = 4000;

    while (!curSnap.over && ticks.length < MAX_SAFETY_TICKS) {
      if (signal.aborted) return null;
      const botDecisions = await Promise.all(
        botSeats.map(async (seat) => {
          const obs = curObs[seat];
          if (!obs) return { seat, action: '0 0 0 0 0 0' };
          const res = await lane.bots[seat].call({ type: 'decide', obs }, signal);
          return { seat, action: String(res.action || '0 0 0 0 0 0') };
        }),
      );
      if (signal.aborted) return null;

      const actionLines = new Array<string>(n).fill('0 0 0 0 0 0');
      for (const d of botDecisions) {
        actionLines[d.seat] = d.action;
      }

      const stepRes = await lane.engine.call(
        {
          type: 'step',
          actionsText: actionLines.join('\n'),
          botSeats,
        },
        signal,
      );
      if (signal.aborted) return null;

      curSnap = stepRes.state as TickSnapshot;
      curObs = stepRes.obs as Record<number, string>;
      ticks.push(curSnap);
    }

    if (signal.aborted) return null;
    return buildMatchHistoryBundle(cfg, mapData, ticks, null, false);
  };

  try {
    for (let i = 0; i < laneCount; i++) {
      const engine = new WorkerRpcClient(
        new Worker(new URL('../workers/engineWorker.ts', import.meta.url), { type: 'module' }),
      );
      const bots: WorkerRpcClient[] = [];
      for (let s = 0; s < maxPlayers; s++) {
        bots.push(
          new WorkerRpcClient(new Worker(new URL('../workers/botWorker.ts', import.meta.url), { type: 'module' })),
        );
      }
      lanes.push({ engine, bots });
    }

    const runLane = async (lane: { engine: WorkerRpcClient; bots: WorkerRpcClient[] }) => {
      while (!signal.aborted) {
        const idx = nextConfigIdx++;
        if (idx >= configs.length) return;
        const cfg = configs[idx];
        const bundle = await simulateOneMatch(lane, cfg);
        if (!bundle || signal.aborted) return;

        const sum = bundle.summary;
        completedMatches++;
        if (sum.winner < 0) draws++;

        for (const p of sum.players) {
          const key = p.botId || p.displayName;
          const prev = botStats.get(key) ?? {
            botId: p.botId || key,
            displayName: p.displayName,
            avatar: p.avatar,
            color: p.color,
            matches: 0,
            wins: 0,
            winRate: 0,
            rankSum: 0,
            avgRank: 0,
            kills: 0,
            deaths: 0,
            kd: 0,
          };
          prev.matches += 1;
          if (sum.winner >= 0 && sum.winner === p.seat) prev.wins += 1;
          prev.rankSum += p.rank;
          prev.kills += Math.max(0, p.kills);
          prev.deaths += p.alive ? 0 : 1;
          botStats.set(key, prev);
        }

        onMatchComplete?.(bundle);

        const winnerPlayer = sum.winner >= 0 ? sum.players.find((pl) => pl.seat === sum.winner) ?? null : null;
        onProgress?.({
          completed: completedMatches,
          total: totalMatches,
          elapsedMs: performance.now() - startedAt,
          latestMapTitle: sum.mapTitle,
          latestWinnerName: winnerPlayer ? winnerPlayer.displayName : null,
          bots: buildBotSnapshots(botStats),
        });
      }
    };

    const settled = await Promise.allSettled(lanes.map((lane) => runLane(lane)));
    if (!signal.aborted) {
      const firstErr = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (firstErr) {
        throw firstErr.reason;
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbortSignal);
    terminateAllLanes();
  }

  return {
    format,
    mapPoolCount,
    requestedTotal: totalMatches,
    completedMatches,
    draws,
    elapsedMs: performance.now() - startedAt,
    cancelled: signal.aborted,
    bots: buildBotSnapshots(botStats),
  };
}
