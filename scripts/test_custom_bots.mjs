// Custom bot pipeline check (in-browser compiler path, run in Node):
//   1. bundled bot sources pass the contest source check and compile with the exact flags the browser uses;
//   2. compiling twice gives byte-identical wasm (duplicate detection hashes the wasm);
//   3. played through the WASI runtime, each bot's actions match its bundled Emscripten build step for step;
//   4. a bot that traps (uncaught exception → abort) surfaces as a catchable RuntimeError.
//
//   node scripts/test_custom_bots.mjs            (needs `npm install`; first run loads the ~100 MB toolchain)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runClang } from '@yowasp/clang';

const ROOT = path.resolve(import.meta.dirname, '..');
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const { CLANG_ARGS, compileInputs } = await imp('src/game/customBots/compileConfig.ts');
const { checkSource } = await imp('src/game/customBots/sourceCheck.ts');
const { instantiateWasiBot } = await imp('src/game/customBots/wasiBotRuntime.ts');

const DART_HPP = fs.readFileSync(path.join(ROOT, 'wasm/include/dart.hpp'), 'utf8');
const BOTS = ['gemini-4-carbon', 'gpt-6.2-astra', 'claude-opus-5.5', 'sparring-strong'];
const MAPS = ['canyon', 'forest', 'icefloes'];

let failures = 0;
const fail = (msg) => {
  failures++;
  console.log(`  FAIL ${msg}`);
};

async function compile(source) {
  let stderr = '';
  try {
    const out = await runClang(CLANG_ARGS, compileInputs(source, DART_HPP), {
      stdout: () => {},
      stderr: (b) => {
        if (b) stderr += Buffer.from(b).toString();
      },
      fetchProgress: () => {},
    });
    return { wasm: out['bot.wasm'], stderr };
  } catch (err) {
    return { wasm: null, stderr: stderr || String(err) };
  }
}

const { default: createEngine } = await imp('public/wasm/engine.js');
const eng = await createEngine({ printErr: () => {} });
const E = (n, r, a) => eng.cwrap(n, r, a);
const engineInit = E('engine_init', 'number', ['string', 'number', 'number']);
const engineHeader = E('engine_get_header', 'string', ['number']);
const engineObs = E('engine_get_obs', 'string', ['number']);
const engineStep = E('engine_step', 'number', ['string']);
const engineState = E('engine_get_state_json', 'string', []);

async function emscriptenBot(id) {
  const { default: create } = await imp(`public/wasm/bots/${id}.js`);
  const m = await create({ printErr: () => {} });
  return { init: m.cwrap('bot_init', 'number', ['string']), decide: m.cwrap('bot_decide', 'string', ['string']) };
}

/** 4-player match: seat 0 driven by the WASI build, also asking the Emscripten build every step. */
async function parityMatch(botId, wasmModule, map) {
  const mapText = fs.readFileSync(path.join(ROOT, `public/assets/maps/${map}.txt`), 'utf8');
  if (!engineInit(mapText, 4, 777)) throw new Error(`engine_init failed on ${map}`);
  const wasi = await instantiateWasiBot(wasmModule);
  const ref = await emscriptenBot(botId);
  const others = [await emscriptenBot('sparring-strong'), await emscriptenBot('sparring-mid'), await emscriptenBot('sparring-weak')];
  if (!wasi.init(engineHeader(0)) || ref.init(engineHeader(0)) !== 1) throw new Error('bot_init failed');
  others.forEach((b, i) => b.init(engineHeader(i + 1)));
  let st = JSON.parse(engineState());
  let steps = 0;
  let mismatches = 0;
  while (!st.over) {
    const lines = ['0 0 0 0 0 0', '0 0 0 0 0 0', '0 0 0 0 0 0', '0 0 0 0 0 0'];
    if (st.players[0].alive) {
      const obs = engineObs(0);
      const a = wasi.decide(obs);
      if (a !== ref.decide(obs)) mismatches++;
      lines[0] = a;
    }
    others.forEach((b, i) => {
      if (st.players[i + 1].alive) lines[i + 1] = b.decide(engineObs(i + 1));
    });
    engineStep(lines.join('\n'));
    st = JSON.parse(engineState());
    steps++;
  }
  return { steps, mismatches };
}

for (const id of BOTS) {
  const source = fs.readFileSync(path.join(ROOT, `wasm/bots/${id}.cpp`), 'utf8');
  const problems = checkSource(source);
  if (problems.length) fail(`${id}: source check: ${problems.join('; ')}`);
  const t0 = performance.now();
  const a = await compile(source);
  const ms = performance.now() - t0;
  if (!a.wasm) {
    fail(`${id}: compile failed\n${a.stderr}`);
    continue;
  }
  const b = await compile(source);
  const ha = crypto.createHash('sha256').update(a.wasm).digest('hex');
  const hb = b.wasm ? crypto.createHash('sha256').update(b.wasm).digest('hex') : 'none';
  if (ha !== hb) fail(`${id}: non-deterministic build (${ha.slice(0, 12)} vs ${hb.slice(0, 12)})`);
  const mod = await WebAssembly.compile(a.wasm);
  const res = [];
  for (const map of MAPS) {
    const r = await parityMatch(id, mod, map);
    if (r.mismatches) fail(`${id} on ${map}: ${r.mismatches}/${r.steps} actions differ from the Emscripten build`);
    res.push(`${map} ${r.steps} steps`);
  }
  console.log(`ok ${id}: ${(a.wasm.length / 1024).toFixed(0)} KB in ${(ms / 1000).toFixed(1)}s, sha ${ha.slice(0, 12)}, identical actions (${res.join(', ')})`);
}

// A throw that actually happens aborts the bot (no unwinding in this wasm): the host sees a RuntimeError
{
  const src = `#include <bits/stdc++.h>
#include "dart.hpp"
using namespace dart;
struct B { int n = 0; std::vector<int> v; Action decide(const Obs&) { if (++n > 3) v.at(7) = 1; return Action(); } };
DART_MAIN(B)
`;
  const { wasm, stderr } = await compile(src);
  if (!wasm) {
    fail(`trap bot: compile failed\n${stderr}`);
  } else {
    const mapText = fs.readFileSync(path.join(ROOT, 'public/assets/maps/forest.txt'), 'utf8');
    engineInit(mapText, 2, 1);
    const bot = await instantiateWasiBot(await WebAssembly.compile(wasm));
    bot.init(engineHeader(0));
    let trapped = -1;
    for (let i = 1; i <= 6 && trapped < 0; i++) {
      try {
        bot.decide(engineObs(0));
      } catch (err) {
        if (err instanceof WebAssembly.RuntimeError) trapped = i;
        else fail(`trap bot: unexpected ${err}`);
      }
    }
    if (trapped === 4) console.log('ok trap bot: <bits/stdc++.h> compiles, uncaught std::out_of_range traps on step 4');
    else fail(`trap bot: expected a trap on step 4, got ${trapped}`);
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall custom bot checks passed');
process.exit(failures ? 1 : 0);
