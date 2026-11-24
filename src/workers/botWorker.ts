/// <reference lib="webworker" />
import { isCustomBotId, loadCustomBotWasm } from '../game/customBots/customBotStore';
import { instantiateWasiBot } from '../game/customBots/wasiBotRuntime';

interface BotWasmModule {
  cwrap: (name: string, ret: string, args: string[]) => (...params: unknown[]) => unknown;
}

const IDLE_ACTION = '0 0 0 0 0 0';

let botInitFn: ((header: string) => number) | null = null;
let botDecideFn: ((obs: string) => string) | null = null;
let loadedBotId = '';
// A custom bot that trapped (abort, out-of-bounds, exit…) is left in an undefined state: like the contest judge
// ending a crashed program, it just idles for the rest of the round instead of being called again.
let crashed = false;
const moduleCache = new Map<string, (opts: Record<string, unknown>) => Promise<BotWasmModule>>();

async function getFactory(origin: string, botId: string, q: string) {
  let factory = moduleCache.get(botId);
  if (!factory) {
    const url = `${origin}/wasm/bots/${botId}.js${q}`;
    const imported = await import(/* @vite-ignore */ url);
    factory = imported.default as (opts: Record<string, unknown>) => Promise<BotWasmModule>;
    moduleCache.set(botId, factory);
  }
  return factory;
}

async function initCustomBot(botId: string, header: string): Promise<boolean> {
  const wasm = await loadCustomBotWasm(botId);
  if (!wasm) throw new Error(`找不到自定义 Bot 的编译结果（${botId}）`);
  const bot = await instantiateWasiBot(await WebAssembly.compile(wasm));
  botDecideFn = (obs) => bot.decide(obs);
  return bot.init(header);
}

self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data;
  try {
    if (msg.type === 'init') {
      const { reqId, origin, buildId, botId, header } = msg as {
        reqId: number;
        origin: string;
        buildId?: string;
        botId: string;
        header: string;
      };
      loadedBotId = botId;
      crashed = false;
      if (isCustomBotId(botId)) {
        botInitFn = null;
        // A custom bot that fails to start (trap in init, missing wasm…) doesn't block the match: it stands still,
        // as the contest judge does with a program that dies at start-up.
        let ok = false;
        try {
          ok = await initCustomBot(botId, header);
        } catch (err) {
          console.warn(`[custom bot ${botId}] init failed:`, err);
        }
        if (!ok) crashed = true;
        self.postMessage({ type: 'init_done', reqId, ok: true, crashed: !ok });
        return;
      }
      const q = buildId ? `?v=${encodeURIComponent(buildId)}` : '';
      // Always instantiate a fresh WASM module instance per match so static/global state is 100% clean
      const factory = await getFactory(origin, botId, q);
      const mod = await factory({
        locateFile: (file: string) => `${origin}/wasm/bots/${file}${q}`,
        print: () => {},
        printErr: () => {},
      });
      botInitFn = mod.cwrap('bot_init', 'number', ['string']) as (h: string) => number;
      botDecideFn = mod.cwrap('bot_decide', 'string', ['string']) as (o: string) => string;
      const ok = botInitFn(header);
      self.postMessage({ type: 'init_done', reqId, ok: ok === 1 });
    } else if (msg.type === 'decide') {
      const { reqId, obs } = msg as { reqId: number; obs: string };
      if (!botDecideFn || crashed) {
        self.postMessage({ type: 'decide_done', reqId, action: IDLE_ACTION, ms: 0 });
        return;
      }
      const t0 = performance.now();
      let action: string;
      try {
        action = botDecideFn(obs);
      } catch (err) {
        if (!isCustomBotId(loadedBotId)) throw err;
        crashed = true;
        action = IDLE_ACTION;
      }
      const ms = performance.now() - t0;
      self.postMessage({ type: 'decide_done', reqId, action, ms });
    }
  } catch (err) {
    if (msg.type === 'init' && isCustomBotId(loadedBotId)) crashed = true;
    self.postMessage({
      type: 'error',
      reqId: msg.reqId,
      botId: loadedBotId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
