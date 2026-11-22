/// <reference lib="webworker" />

interface EngineWasmModule {
  cwrap: (name: string, ret: string, args: string[]) => (...params: unknown[]) => unknown;
}

let engineInit: ((mapText: string, nPlayers: number, seed: number) => number) | null = null;
let engineLastErr: (() => string) | null = null;
let engineGetHeader: ((seat: number) => string) | null = null;
let engineGetObs: ((seat: number) => string) | null = null;
let engineStep: ((actionsText: string) => number) | null = null;
let engineGetMapJson: (() => string) | null = null;
let engineGetStateJson: (() => string) | null = null;

async function ensureLoaded(origin: string) {
  if (engineInit) return;
  const url = `${origin}/wasm/engine.js`;
  const imported = await import(/* @vite-ignore */ url);
  const factory = imported.default as (opts: Record<string, unknown>) => Promise<EngineWasmModule>;
  const mod = await factory({
    locateFile: (file: string) => `${origin}/wasm/${file}`,
    print: () => {},
    printErr: () => {},
  });
  engineInit = mod.cwrap('engine_init', 'number', ['string', 'number', 'number']) as (m: string, n: number, s: number) => number;
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
      const { reqId, origin, mapText, nPlayers, seed, botSeats } = msg as {
        reqId: number;
        origin: string;
        mapText: string;
        nPlayers: number;
        seed: number;
        botSeats: number[];
      };
      await ensureLoaded(origin);
      const ok = engineInit!(mapText, nPlayers, seed);
      if (!ok) {
        self.postMessage({ type: 'error', reqId, error: engineLastErr!() });
        return;
      }
      const mapData = JSON.parse(engineGetMapJson!());
      const state = JSON.parse(engineGetStateJson!());
      const headers: Record<number, string> = {};
      const obs: Record<number, string> = {};
      for (const seat of botSeats) {
        headers[seat] = engineGetHeader!(seat);
        obs[seat] = engineGetObs!(seat);
      }
      self.postMessage({ type: 'init_done', reqId, mapData, state, headers, obs });
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
          if (state.players[seat]?.alive) {
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
