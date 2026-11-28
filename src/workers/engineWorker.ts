/// <reference lib="webworker" />
import { PvpSimulation } from './pvpSimulation';

interface EngineWasmModule {
  cwrap: (name: string, ret: string | null, args: string[]) => (...params: unknown[]) => unknown;
}

let engineInit: ((mapText: string, nPlayers: number, seed: number) => number) | null = null;
let engineInitWithSpawnSeed:
  | ((mapText: string, nPlayers: number, seed: number, spawnSeed: number) => number)
  | null = null;
let engineInitTraining: ((mapText: string) => number) | null = null;
let engineInitTeam: ((mapText: string, mode: number, seed: number, formText: string) => number) | null = null;
/** 5v5：每一步都给所有 bot 座位发观察（占点里出局的人还在想，复活倒计时就在自己的观察里） */
let obsForDeadBots = false;
let pvpSimulation: PvpSimulation | null = null;
let engineSetHumanSeats: ((seats: number) => void) | null = null;
let engineSave: ((slot: number) => number) | null = null;
let engineRestore: ((slot: number) => number) | null = null;
let engineEvents: (() => string) | null = null;
let engineHash: (() => string) | null = null;
let engineSetHumanSeat: ((seat: number) => void) | null = null;
let engineSetHumanSlashTicks: ((ticks: number) => void) | null = null;
let engineSetHumanCliffGuard: ((enabled: number) => void) | null = null;
let engineSetHumanWalkGuard: ((enabled: number) => void) | null = null;
let walkGuardEnabled = false;
let engineSetHumanMeleeAssist: ((enabled: number) => void) | null = null;
let engineLastErr: (() => string) | null = null;
let engineGetHeader: ((seat: number) => string) | null = null;
let engineGetObs: ((seat: number) => string) | null = null;
let engineStep: ((actionsText: string) => number) | null = null;
let engineGetMapJson: (() => string) | null = null;
let engineGetStateJson: (() => string) | null = null;

async function ensureLoaded(origin: string, buildId?: string) {
  if (engineInit) return;
  const q = buildId ? `?v=${encodeURIComponent(buildId)}` : '';
  const url = `${origin}/wasm/engine.js${q}`;
  const imported = await import(/* @vite-ignore */ url);
  const factory = imported.default as (opts: Record<string, unknown>) => Promise<EngineWasmModule>;
  const mod = await factory({
    locateFile: (file: string) => `${origin}/wasm/${file}${q}`,
    print: () => {},
    printErr: () => {},
  });
  engineInit = mod.cwrap('engine_init', 'number', ['string', 'number', 'number']) as (m: string, n: number, s: number) => number;
  engineInitWithSpawnSeed = mod.cwrap('engine_init_with_spawn_seed', 'number', ['string', 'number', 'number', 'number']) as (
    m: string,
    n: number,
    s: number,
    ss: number,
  ) => number;
  engineInitTraining = mod.cwrap('engine_init_training', 'number', ['string']) as (m: string) => number;
  engineInitTeam = mod.cwrap('engine_init_team', 'number', ['string', 'number', 'number', 'string']) as (
    m: string,
    mode: number,
    seed: number,
    form: string,
  ) => number;
  engineSetHumanSeats = mod.cwrap('engine_set_human_seats', null, ['number']) as (seats: number) => void;
  engineSave = mod.cwrap('engine_snapshot_save', 'number', ['number']) as (slot: number) => number;
  engineRestore = mod.cwrap('engine_snapshot_restore', 'number', ['number']) as (slot: number) => number;
  engineEvents = mod.cwrap('engine_get_events_json', 'string', []) as () => string;
  engineHash = mod.cwrap('engine_state_hash', 'string', []) as () => string;
  engineSetHumanSeat = mod.cwrap('engine_set_human_seat', null, ['number']) as (s: number) => void;
  engineSetHumanSlashTicks = mod.cwrap('engine_set_human_slash_ticks', null, ['number']) as (t: number) => void;
  engineSetHumanCliffGuard = mod.cwrap('engine_set_human_cliff_guard', null, ['number']) as (e: number) => void;
  engineSetHumanWalkGuard = mod.cwrap('engine_set_human_walk_guard', null, ['number']) as (e: number) => void;
  engineSetHumanMeleeAssist = mod.cwrap('engine_set_human_melee_assist', null, ['number']) as (e: number) => void;
  engineLastErr = mod.cwrap('engine_last_error', 'string', []) as () => string;
  engineGetHeader = mod.cwrap('engine_get_header', 'string', ['number']) as (s: number) => string;
  engineGetObs = mod.cwrap('engine_get_obs', 'string', ['number']) as (s: number) => string;
  engineStep = mod.cwrap('engine_step', 'number', ['string']) as (a: string) => number;
  engineGetMapJson = mod.cwrap('engine_get_map_json', 'string', []) as () => string;
  engineGetStateJson = mod.cwrap('engine_get_state_json', 'string', []) as () => string;
}

self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data;
  try {
    if (msg.type === 'init') {
      const { reqId, origin, buildId, mapText, nPlayers, seed, spawnSeed, botSeats, humanSeat, humanSeats, cliffGuard, walkGuard, meleeAssist, humanSlashTicks, training, team } = msg as {
        reqId: number;
        origin: string;
        buildId?: string;
        mapText: string;
        nPlayers: number;
        seed: number;
        spawnSeed?: number;
        botSeats: number[];
        humanSeat?: number;
        humanSeats?: number;
        cliffGuard?: boolean;
        walkGuard?: boolean;
        meleeAssist?: boolean;
        humanSlashTicks?: number;
        training?: boolean;
        team?: { mode: number; formText: string };
      };
      walkGuardEnabled = walkGuard === true;
      await ensureLoaded(origin, buildId);
      const ss = typeof spawnSeed === 'number' && spawnSeed !== 0 ? (spawnSeed >>> 0) : 0;
      // Training ground: fixed 8-seat layout with training-only rules (see engine_init_training in engine_wasm.cpp)
      obsForDeadBots = Boolean(team);
      const ok = team
        ? engineInitTeam!(mapText, team.mode, seed >>> 0, team.formText)
        : training
        ? engineInitTraining!(mapText)
        : ss !== 0
          ? engineInitWithSpawnSeed!(mapText, nPlayers, seed, ss)
          : engineInit!(mapText, nPlayers, seed);
      if (!ok) {
        self.postMessage({ type: 'error', reqId, error: engineLastErr!() });
        return;
      }
      if (humanSeats !== undefined) engineSetHumanSeats!(humanSeats);
      else engineSetHumanSeat!(typeof humanSeat === 'number' ? humanSeat : -1);
      engineSetHumanSlashTicks!(typeof humanSlashTicks === 'number' ? humanSlashTicks : 3);
      engineSetHumanCliffGuard!(cliffGuard ? 1 : 0);
      engineSetHumanWalkGuard!(walkGuardEnabled ? 1 : 0);
      engineSetHumanMeleeAssist!(meleeAssist === false ? 0 : 1);
      const mapData = JSON.parse(engineGetMapJson!());
      const state = JSON.parse(engineGetStateJson!());
      pvpSimulation = humanSeats !== undefined
        ? new PvpSimulation({
            step: engineStep!, state: engineGetStateJson!, events: engineEvents!, save: engineSave!,
            restore: engineRestore!, hash: engineHash!,
          }, state)
        : null;
      const headers: Record<number, string> = {};
      const obs: Record<number, string> = {};
      for (const seat of botSeats) {
        headers[seat] = engineGetHeader!(seat);
        obs[seat] = engineGetObs!(seat);
      }
      self.postMessage({ type: 'init_done', reqId, mapData, state, headers, obs });
    } else if (msg.type === 'set_walk_guard') {
      // Keep changes that arrive while the WASM module is loading.
      walkGuardEnabled = msg.enabled === true;
      engineSetHumanWalkGuard?.(walkGuardEnabled ? 1 : 0);
    } else if (msg.type === 'set_cliff_guard') {
      if (engineSetHumanCliffGuard) {
        engineSetHumanCliffGuard(msg.enabled ? 1 : 0);
      }
    } else if (msg.type === 'set_melee_assist') {
      if (engineSetHumanMeleeAssist) {
        engineSetHumanMeleeAssist(msg.enabled ? 1 : 0);
      }
    } else if (msg.type === 'set_slash_ticks') {
      if (engineSetHumanSlashTicks) {
        engineSetHumanSlashTicks(typeof msg.ticks === 'number' ? msg.ticks : 3);
      }
    } else if (msg.type === 'pvp_update') {
      if (!pvpSimulation) throw new Error('PvP engine is not initialized');
      const result = pvpSimulation.update(msg.update);
      self.postMessage({ type: 'pvp_update_done', reqId: msg.reqId, result });
    } else if (msg.type === 'pvp_history') {
      if (!pvpSimulation) throw new Error('PvP engine is not initialized');
      self.postMessage({ type: 'pvp_history_done', reqId: msg.reqId, ticks: pvpSimulation.recorded(msg.throughT) });
    } else if (msg.type === 'step') {
      const { reqId, actionsText, botSeats } = msg as {
        reqId: number;
        actionsText: string;
        botSeats: number[];
      };
      engineStep!(actionsText);
      const state = JSON.parse(engineGetStateJson!());
      const obs: Record<number, string> = {};
      if (!state.over) {
        for (const seat of botSeats) {
          if (obsForDeadBots || state.players[seat]?.alive) {
            obs[seat] = engineGetObs!(seat);
          }
        }
      }
      self.postMessage({ type: 'step_done', reqId, state, obs });
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      reqId: msg.reqId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
