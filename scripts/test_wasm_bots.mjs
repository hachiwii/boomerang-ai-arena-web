import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENGINE_JS = path.join(ROOT, 'public/wasm/engine.js');
const BOTS_DIR = path.join(ROOT, 'public/wasm/bots');
const MAPS_DIR = path.join(ROOT, 'public/assets/maps');

const { default: createEngineModule } = await import(pathToFileURL(ENGINE_JS).href);
const engineMod = await createEngineModule({ printErr: () => {} });

const engineInit = engineMod.cwrap('engine_init', 'number', ['string', 'number', 'number']);
const engineLastErr = engineMod.cwrap('engine_last_error', 'string', []);
const engineGetHeader = engineMod.cwrap('engine_get_header', 'string', ['number']);
const engineGetObs = engineMod.cwrap('engine_get_obs', 'string', ['number']);
const engineStep = engineMod.cwrap('engine_step', 'number', ['string']);
const engineGetState = engineMod.cwrap('engine_get_state_json', 'string', []);

async function loadBot(botId) {
  const modPath = path.join(BOTS_DIR, `${botId}.js`);
  const { default: createBotModule } = await import(pathToFileURL(modPath).href);
  const m = await createBotModule({ printErr: () => {} });
  return {
    id: botId,
    init: m.cwrap('bot_init', 'number', ['string']),
    decide: m.cwrap('bot_decide', 'string', ['string']),
  };
}

async function runMatch(mapName, botIds, maxTicks = 800) {
  const mapText = fs.readFileSync(path.join(MAPS_DIR, `${mapName}.txt`), 'utf8');
  const ok = engineInit(mapText, botIds.length, 42);
  if (!ok) throw new Error(`engine_init failed on ${mapName} (${botIds.length}p): ${engineLastErr()}`);

  const bots = [];
  for (let i = 0; i < botIds.length; i++) {
    const b = await loadBot(botIds[i]);
    const header = engineGetHeader(i);
    if (!b.init(header)) throw new Error(`bot_init failed for ${botIds[i]} seat ${i}`);
    bots.push(b);
  }

  let maxTickMs = 0;
  let totalBotMs = 0;
  let ticks = 0;
  let state = JSON.parse(engineGetState());

  while (!state.over && ticks < maxTicks) {
    const lines = [];
    let tickMaxBot = 0;
    for (let i = 0; i < bots.length; i++) {
      const obs = engineGetObs(i);
      const t0 = performance.now();
      const act = bots[i].decide(obs);
      const dt = performance.now() - t0;
      if (dt > tickMaxBot) tickMaxBot = dt;
      totalBotMs += dt;
      lines.push(act);
    }
    if (tickMaxBot > maxTickMs) maxTickMs = tickMaxBot;
    engineStep(lines.join('\n'));
    state = JSON.parse(engineGetState());
    ticks++;
  }
  return {
    ticks,
    over: state.over,
    winner: state.winner,
    kills: state.players.map((p) => p.kills),
    maxBotMs: maxTickMs.toFixed(2),
    avgBotMs: (totalBotMs / Math.max(1, ticks * bots.length)).toFixed(2),
  };
}

// 1. Test ALL 16 bots in 4-player matches (4 groups of 4)
const allBots = fs.readdirSync(BOTS_DIR).filter((f) => f.endsWith('.js')).map((f) => f.replace(/\.js$/, '')).sort();
console.log(`Testing all ${allBots.length} WASM bots...`);
const maps4 = ['twinlakes', 'yinyang', 'stonecircle', 'icefloes'];
for (let g = 0; g < allBots.length; g += 4) {
  const group = allBots.slice(g, g + 4);
  const map = maps4[(g / 4) % maps4.length];
  const r = await runMatch(map, group, 250);
  console.log(`  [4P ${map.padEnd(11)}] ${group.join(', ')} => ticks=${r.ticks} over=${r.over} winner=${r.winner} kills=[${r.kills}] avg=${r.avgBotMs}ms max=${r.maxBotMs}ms`);
}

// 2. Test 3-player match (checking 3P support!)
const r3 = await runMatch('skybridge', ['gpt-6.2-astra', 'claude-fable-5.2', 'gemini-4-carbon'], 300);
console.log(`  [3P skybridge  ] astra, fable, carbon => ticks=${r3.ticks} over=${r3.over} winner=${r3.winner} kills=[${r3.kills}] avg=${r3.avgBotMs}ms max=${r3.maxBotMs}ms`);

// 3. Test duplicate AI instances (same bot x3!) on a large map adapted for 3p!
const rDup = await runMatch('canyon', ['gpt-6.2-astra', 'gpt-6.2-astra', 'gpt-6.2-astra'], 200);
console.log(`  [3P DUP canyon ] 3x astra => ticks=${rDup.ticks} over=${rDup.over} winner=${rDup.winner} kills=[${rDup.kills}] avg=${rDup.avgBotMs}ms max=${rDup.maxBotMs}ms`);

// 4. Test 2P on all remaining maps
for (const m of ['ruins', 'hourglass', 'oldtown', 'forest']) {
  const r2 = await runMatch(m, ['claude-opus-5.5', 'gpt-6.2-sol'], 120);
  console.log(`  [2P ${m.padEnd(11)}] opus vs sol => ticks=${r2.ticks} over=${r2.over} winner=${r2.winner} kills=[${r2.kills}] avg=${r2.avgBotMs}ms max=${r2.maxBotMs}ms`);
}

console.log('ALL WASM ENGINE & BOT TESTS PASSED!');
