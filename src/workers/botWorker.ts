/// <reference lib="webworker" />

interface BotWasmModule {
  cwrap: (name: string, ret: string, args: string[]) => (...params: unknown[]) => unknown;
}

let botInitFn: ((header: string) => number) | null = null;
let botDecideFn: ((obs: string) => string) | null = null;
let loadedBotId = '';
const moduleCache = new Map<string, (opts: Record<string, unknown>) => Promise<BotWasmModule>>();

async function getFactory(origin: string, botId: string) {
  let factory = moduleCache.get(botId);
  if (!factory) {
    const url = `${origin}/wasm/bots/${botId}.js`;
    const imported = await import(/* @vite-ignore */ url);
    factory = imported.default as (opts: Record<string, unknown>) => Promise<BotWasmModule>;
    moduleCache.set(botId, factory);
  }
  return factory;
}

self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data;
  try {
    if (msg.type === 'init') {
      const { reqId, origin, botId, header } = msg as {
        reqId: number;
        origin: string;
        botId: string;
        header: string;
      };
      // Always instantiate a fresh WASM module instance per match so static/global state is 100% clean
      const factory = await getFactory(origin, botId);
      const mod = await factory({
        locateFile: (file: string) => `${origin}/wasm/bots/${file}`,
        print: () => {},
        printErr: () => {},
      });
      botInitFn = mod.cwrap('bot_init', 'number', ['string']) as (h: string) => number;
      botDecideFn = mod.cwrap('bot_decide', 'string', ['string']) as (o: string) => string;
      loadedBotId = botId;
      const ok = botInitFn(header);
      self.postMessage({ type: 'init_done', reqId, ok: ok === 1 });
    } else if (msg.type === 'decide') {
      const { reqId, obs } = msg as { reqId: number; obs: string };
      if (!botDecideFn) {
        self.postMessage({ type: 'decide_done', reqId, action: '0 0 0 0 0 0', ms: 0 });
        return;
      }
      const t0 = performance.now();
      const action = botDecideFn(obs);
      const ms = performance.now() - t0;
      self.postMessage({ type: 'decide_done', reqId, action, ms });
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      reqId: msg.reqId,
      botId: loadedBotId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
