// Ranked bot results for the site analytics (src/game/botResults.ts): win / draw / loss per bot, its kills by cause
// and how it died, checked on the real engine (walk off, dash off, ground collapsing under a still or moving player) and on
// hand-made snapshots for kills, kicks, draws and a player stunned on a collapsing tile.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import createEngineModule from '../public/wasm/engine.js';
import { mapText } from './pvp_test_engine.mjs';

const source = new URL('../src/game/botResults.ts', import.meta.url);
const build = await esbuild.build({ entryPoints: [fileURLToPath(source)], bundle: true, format: 'esm', write: false });
const { deathCause, rankedBotResults } = await import(
  `data:text/javascript;base64,${Buffer.from(build.outputFiles[0].contents).toString('base64')}`
);

const mod = await createEngineModule({ print: () => {}, printErr: () => {} });
const call = (name, ret, args = []) => mod.cwrap(`engine_${name}`, ret, args);
const init = call('init_with_spawn_seed', 'number', ['string', 'number', 'number', 'number']);
const step = call('step', 'number', ['string']);
const stateJson = call('get_state_json', 'string');
const mapJson = call('get_map_json', 'string');

/** Run a 1v1 on stonecircle with both seats driven by `drive(t, state) → [action0, action1]` (no walk / cliff guard). */
function play(drive, maxTicks = 4000) {
  assert.equal(init(mapText('stonecircle'), 2, 7, 0), 1, call('last_error', 'string')());
  call('set_human_seats', null, ['number'])(3);
  call('set_human_cliff_guard', null, ['number'])(0);
  call('set_human_walk_guard', null, ['number'])(0);
  const map = JSON.parse(mapJson());
  const ticks = [JSON.parse(stateJson())];
  while (!ticks.at(-1).over && ticks.length < maxTicks) {
    const st = ticks.at(-1);
    step(drive(st.t, st).map((a) => a.join(' ')).join('\n'));
    ticks.push(JSON.parse(stateJson()));
  }
  assert.ok(ticks.at(-1).over, 'match ended');
  return { map, ticks };
}
const IDLE = [0, 0, 0, 0, 0, 0];
const walk = (mx, my) => [mx, my, 0, 0, 0, 0];
// Seat 1 heads for the middle of the stone circle (never collapses) and waits there
const toCentre = (st) => (st.players[1].x > 9500 ? walk(-1000, 0) : IDLE);
const cfg = (mode, kinds = ['bot', 'bot']) => ({
  matchMode: mode,
  slots: kinds.map((kind, i) => ({ kind, botId: kind === 'bot' ? `bot-${i}` : undefined })),
});

// 1. Walking off the west edge: a fall on its own
{
  const { map, ticks } = play((t, st) => [walk(-1000, 0), IDLE]);
  const p = ticks.at(-1).players[0];
  assert.equal(p.alive, 0);
  assert.equal(deathCause(ticks, 0, map), 'fall');
  // A fall on its own is nobody's kill
  assert.deepEqual(rankedBotResults(cfg('ranked-solo'), ticks, map), [
    { b: 'bot-0', r: 'l', death: 'fall' },
    { b: 'bot-1', r: 'w' },
  ]);
  // A human seat is not reported; custom matches report nothing
  assert.deepEqual(rankedBotResults(cfg('ranked-solo', ['human', 'bot']), ticks, map), [{ b: 'bot-1', r: 'w' }]);
  assert.deepEqual(rankedBotResults(cfg('custom'), ticks, map), []);
  assert.deepEqual(rankedBotResults(cfg('ranked-solo'), ticks.slice(0, -1), map), [], 'unfinished: nothing');
  console.log(`  [PASS] walk off the edge → fall (tick ${ticks.length})`);
}

// 2. Dashing off the west edge: also a fall on its own (dash ending over the pit)
{
  let dashed = false;
  const { map, ticks } = play((t, st) => {
    const me = st.players[0];
    if (!dashed && me.x < 3300) {
      dashed = true;
      return [[0, 0, 3, -1000, 0, 0], IDLE];
    }
    return [dashed ? IDLE : walk(-1000, 0), IDLE];
  });
  assert.ok(dashed);
  assert.equal(ticks.at(-1).players[0].alive, 0);
  assert.equal(deathCause(ticks, 0, map), 'fall');
  console.log('  [PASS] dash off the edge → fall');
}

// 3. Standing still until the outer ring collapses: collapse
{
  const { map, ticks } = play((t, st) => [IDLE, toCentre(st)]);
  const final = ticks.at(-1);
  assert.equal(final.players[0].alive, 0);
  assert.equal(final.winner, 1);
  assert.equal(deathCause(ticks, 0, map), 'collapse');
  assert.deepEqual(rankedBotResults(cfg('ranked-solo'), ticks, map), [
    { b: 'bot-0', r: 'l', death: 'collapse' },
    { b: 'bot-1', r: 'w' },
  ]);
  console.log(`  [PASS] still on a collapsing tile → collapse (tick ${ticks.length})`);
}

// 4. Shuffling back and forth on a collapsing tile (moves every tick): still a collapse, not a walk-off
{
  const { map, ticks } = play((t, st) => [walk(t % 2 ? 300 : -300, 0), toCentre(st)]);
  const di = ticks.findIndex((s) => s.players[0].alive === 0);
  const a = ticks[di - 1].players[0];
  const b = ticks[di].players[0];
  assert.ok(a.x !== b.x || a.y !== b.y, 'moved on the step it fell');
  assert.equal(deathCause(ticks, 0, map), 'collapse');
  console.log('  [PASS] moving on a collapsing tile → collapse');
}

// 5. Walking into a hole that collapsed long before: a fall on its own
{
  let waited = 0;
  const { map, ticks } = play((t, st) => {
    const me = st.players[0];
    // Walk to the centre first, wait for the outer rings to go, then walk out west into the hole
    if (waited === 0 && me.x < 8500) return [walk(1000, 0), toCentre(st)];
    if (st.fallen < 3) {
      waited++;
      return [IDLE, IDLE];
    }
    return [walk(-1000, 0), IDLE];
  });
  assert.ok(waited > 0);
  assert.equal(ticks.at(-1).players[0].alive, 0);
  assert.equal(deathCause(ticks, 0, map), 'fall');
  console.log('  [PASS] walk into a long-collapsed hole → fall');
}

// 6. Hand-made snapshots: kills and deaths by dart / melee / kick, draws, a death on a draw, stunned on a collapsing tile
{
  const map = { nx: 4, ny: 4, cell: 500, cells: Array(16).fill(0), waves: Array(16).fill(-1), waveSteps: [100] };
  map.waves[5] = 0; // cell (1, 1) collapses at step 100
  const P = (o = {}) => ({ alive: 1, x: 250, y: 250, cause: 0, killer: -1, deadT: 0, rank: 1, ...o });
  const snap = (t, players, over = false, winner = -2) => ({ t, over, winner, players });
  // Seat order: 0 dart victim (of 1), 1 melee victim (of 3), 2 kicked (by 3), 3 winner
  const ticks = [
    snap(1, [P(), P(), P(), P()]),
    snap(2, [P({ alive: 0, cause: 1, killer: 1, deadT: 1, rank: 4 }), P(), P(), P()]),
    snap(3, [P({ alive: 0, cause: 1, killer: 1, deadT: 1, rank: 4 }), P({ alive: 0, cause: 2, killer: 3, deadT: 2, rank: 3 }), P(), P()]),
    snap(4, [
      P({ alive: 0, cause: 1, killer: 1, deadT: 1, rank: 4 }), P({ alive: 0, cause: 2, killer: 3, deadT: 2, rank: 3 }),
      P({ alive: 0, cause: 3, killer: 3, deadT: 3, rank: 2 }), P({ rank: 1 }),
    ], true, 3),
  ];
  assert.equal(deathCause(ticks, 0, map), 'dart');
  assert.equal(deathCause(ticks, 1, map), 'melee');
  assert.equal(deathCause(ticks, 2, map), 'kick');
  assert.equal(deathCause(ticks, 3, map), null);
  assert.deepEqual(rankedBotResults(cfg('ranked-ffa', ['human', 'bot', 'bot', 'bot']), ticks, map), [
    { b: 'bot-1', r: 'l', kills: { dart: 1 }, death: 'melee' },
    { b: 'bot-2', r: 'l', death: 'kick' },
    { b: 'bot-3', r: 'w', kills: { melee: 1, kick: 1 } },
  ]);
  // Timeout with two left: both draw, the rest lose
  const tie = [...ticks.slice(0, 3), snap(4, [ticks[2].players[0], ticks[2].players[1], P({ rank: 1 }), P({ rank: 1 })], true, -1)];
  assert.deepEqual(rankedBotResults(cfg('ranked-ffa', ['bot', 'bot', 'bot', 'bot']), tie, map).map((r) => r.r), ['l', 'l', 'd', 'd']);
  // SOLO both out on the same step: a draw, and both deaths count
  const both = [snap(1, [P(), P()]), snap(2, [P({ alive: 0, cause: 1, killer: 1, deadT: 1 }), P({ alive: 0, cause: 2, killer: 0, deadT: 1 })], true, -1)];
  assert.deepEqual(rankedBotResults(cfg('ranked-solo'), both, map), [
    { b: 'bot-0', r: 'd', kills: { melee: 1 }, death: 'dart' },
    { b: 'bot-1', r: 'd', kills: { dart: 1 }, death: 'melee' },
  ]);
  // Stunned on (1, 1) from step 50, the tile collapses at step 100, the fall is judged when the stun ends (step 110)
  const stunTicks = [];
  for (let t = 40; t <= 112; t++) {
    const at = t <= 50 ? { x: 600 + (50 - t) * 10 } : { x: 600 };
    const dead = t >= 111;
    stunTicks.push(snap(t, [P({ y: 600, ...at, ...(dead ? { alive: 0, cause: 3, deadT: 110, rank: 2 } : {}) }), P()], t === 112, t === 112 ? 1 : -2));
  }
  assert.equal(deathCause(stunTicks, 0, map), 'collapse');
  console.log('  [PASS] snapshots: kills and deaths by dart / melee / kick, timeout and same-step draws, stunned on a collapsing tile');
}

console.log('Bot results passed');
