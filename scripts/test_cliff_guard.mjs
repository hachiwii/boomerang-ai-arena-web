import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENGINE_JS = path.join(ROOT, 'public/wasm/engine.js');
const MAPS_DIR = path.join(ROOT, 'public/assets/maps');

// Bundle src/game/cliffGuard.ts in memory so we test the exact production TypeScript code!
const built = await esbuild.build({
  entryPoints: [path.join(ROOT, 'src/game/cliffGuard.ts')],
  bundle: true,
  format: 'esm',
  write: false,
});
const code = built.outputFiles[0].text;
const modUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const { applyCliffGuard, cellOfPoint } = await import(modUrl);

const { default: createEngineModule } = await import(pathToFileURL(ENGINE_JS).href);
const engineMod = await createEngineModule({ printErr: () => {} });
const engineInit = engineMod.cwrap('engine_init', 'number', ['string', 'number', 'number']);
const engineSetHumanSeat = engineMod.cwrap('engine_set_human_seat', null, ['number']);
const engineSetHumanCliffGuard = engineMod.cwrap('engine_set_human_cliff_guard', null, ['number']);
const engineSetHumanDashTarget = engineMod.cwrap('engine_set_human_dash_target', null, ['number', 'number', 'number']);
const engineGetMap = engineMod.cwrap('engine_get_map_json', 'string', []);
const engineStep = engineMod.cwrap('engine_step', 'number', ['string']);
const engineGetState = engineMod.cwrap('engine_get_state_json', 'string', []);

function startMap(mapName, seed = 0, humanSeat = -1, cliffGuard = false) {
  const mapText = fs.readFileSync(path.join(MAPS_DIR, `${mapName}.txt`), 'utf8');
  if (!engineInit(mapText, 2, seed)) throw new Error(`init failed for ${mapName}`);
  engineSetHumanSeat(humanSeat);
  engineSetHumanCliffGuard(cliffGuard ? 1 : 0);
  return {
    map: JSON.parse(engineGetMap()),
    state: JSON.parse(engineGetState()),
  };
}

function actStr(a) {
  return `${a.mx} ${a.my} ${a.act} ${a.ax} ${a.ay} ${a.msg}`;
}

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

// ---------------------------------------------------------------------------
// Test 1: Walking in ALL 8 directions across multiple cliff-heavy maps with
// cliffGuard ON must NEVER cause a walking fall (even while throwing!).
// ---------------------------------------------------------------------------
const dirs = [
  [-1000, 0], [1000, 0], [0, -1000], [0, 1000],
  [-707, -707], [707, -707], [-707, 707], [707, 707],
];

for (const mapName of ['twinlakes', 'skybridge', 'icefloes', 'yinyang', 'canyon']) {
  for (const [dmx, dmy] of dirs) {
    let { map, state } = startMap(mapName, 7);
    let maxDist = 0;
    const x0 = state.players[0].x;
    const y0 = state.players[0].y;
    for (let tick = 0; tick < 120 && !state.over; tick++) {
      // Throw boomerang on tick 10 to also test walking while S_THROW / S_THROWN!
      const raw = {
        mx: dmx,
        my: dmy,
        act: tick === 10 ? 1 : 0,
        ax: dmx || 1000,
        ay: dmy,
        msg: 0,
      };
      const guarded = applyCliffGuard(map, state, 0, raw);
      engineStep(`${actStr(guarded)}\n0 0 0 0 0 0`);
      state = JSON.parse(engineGetState());
      const me = state.players[0];
      assert(me.alive === 1, `Human fell on ${mapName} walking (${dmx},${dmy}) at tick=${tick}, pos=(${me.x},${me.y}), cause=${me.cause}`);
      const d = Math.hypot(me.x - x0, me.y - y0);
      if (d > maxDist) maxDist = d;
    }
    assert(maxDist >= 0, 'sanity');
  }
}
console.log('  [TEST 1 PASS] 0 walking falls across 5 maps x 8 directions (40 runs, incl. walking during throw)!');

// ---------------------------------------------------------------------------
// Test 2: High-momentum 90-degree turn right at the cliff rim (vx=+250, pressing W/S)
// ---------------------------------------------------------------------------
{
  let { map, state } = startMap('twinlakes', 0);
  // Walk straight up (-y) until we stop at the top cliff edge, then verify rapid direction switches never slip over!
  const seq = [
    [0, -1000], [0, -1000], [0, -1000], [0, -1000], [0, -1000],
    [0, -1000], [0, -1000], [0, -1000], [0, -1000], [0, -1000],
    [-1000, 0], [1000, 0], [-707, -707], [707, -707], [0, -1000],
    [-1000, 0], [-1000, 0], [-1000, 0], [-1000, 0], [-1000, 0],
    [-1000, 0], [-1000, 0], [-1000, 0], [-1000, 0], [-1000, 0],
    [0, 1000], [0, -1000], [-1000, 0], [0, -1000], [1000, 0],
  ];
  for (let i = 0; i < 180 && !state.over; i++) {
    const [dmx, dmy] = seq[i % seq.length];
    const guarded = applyCliffGuard(map, state, 0, { mx: dmx, my: dmy, act: 0, ax: 0, ay: 0, msg: 0 });
    engineStep(`${actStr(guarded)}\n0 0 0 0 0 0`);
    state = JSON.parse(engineGetState());
    assert(state.players[0].alive === 1, `High-momentum turn fell at step ${i}!`);
  }
  console.log('  [TEST 2 PASS] Rapid 90-degree high-momentum turns along cliff rims: 0 falls!');
}

// ---------------------------------------------------------------------------
// Test 3: Control check — with cliffGuard OFF, walking into the cliff DOES fall!
// ---------------------------------------------------------------------------
{
  let { map, state } = startMap('twinlakes', 0);
  let fell = false;
  for (let i = 0; i < 60 && !state.over; i++) {
    engineStep(`-1000 0 0 0 0 0\n0 0 0 0 0 0`);
    state = JSON.parse(engineGetState());
    if (!state.players[0].alive && state.players[0].cause === 3) {
      fell = true;
      break;
    }
  }
  assert(fell, 'Without cliffGuard, walking left off twinlakes should fall');
  console.log('  [TEST 3 PASS] Without cliffGuard, walking off cliff falls as expected (cause=FALL).');
}

// ---------------------------------------------------------------------------
// Test 4: Dashing off a cliff with cliffGuard ON MUST STILL FALL (dash unaffected)!
// ---------------------------------------------------------------------------
{
  let { map, state } = startMap('twinlakes', 0);
  // First walk all the way left to the cliff rim with cliffGuard ON
  for (let i = 0; i < 40; i++) {
    const guarded = applyCliffGuard(map, state, 0, { mx: -1000, my: 0, act: 0, ax: 0, ay: 0, msg: 0 });
    engineStep(`${actStr(guarded)}\n0 0 0 0 0 0`);
    state = JSON.parse(engineGetState());
  }
  assert(state.players[0].alive === 1, 'Should be safely stopped at left cliff rim before dash');
  const rimX = state.players[0].x;

  // Now press Shift (ActType.DASH = 3) left into the abyss!
  const dashRaw = { mx: -1000, my: 0, act: 3, ax: -1000, ay: 0, msg: 0 };
  const dashGuarded = applyCliffGuard(map, state, 0, dashRaw);
  assert(dashGuarded.act === 3, 'Cliff guard must NOT cancel ActType.DASH');
  engineStep(`${actStr(dashGuarded)}\n0 0 0 0 0 0`);
  state = JSON.parse(engineGetState());

  let fellFromDash = false;
  for (let i = 0; i < 20 && !state.over; i++) {
    const nextGuarded = applyCliffGuard(map, state, 0, { mx: -1000, my: 0, act: 0, ax: 0, ay: 0, msg: 0 });
    engineStep(`${actStr(nextGuarded)}\n0 0 0 0 0 0`);
    state = JSON.parse(engineGetState());
    if (!state.players[0].alive && state.players[0].cause === 3) {
      fellFromDash = true;
      break;
    }
  }
  assert(fellFromDash, `Dashing off rimX=${rimX} with cliffGuard ON must still fall!`);
  console.log(`  [TEST 4 PASS] Dashing off cliff (from rim x=${rimX}) with cliffGuard ON still falls (dash unaffected)!`);
}

// ---------------------------------------------------------------------------
// Test 5: Platform collapse underneath player with cliffGuard ON MUST STILL FALL!
// ---------------------------------------------------------------------------
{
  let { map, state } = startMap('twinlakes', 0);
  // Walk to the outer wave-0 rim (left edge) with cliffGuard ON, then stand still until colStart (240) collapses under us!
  for (let i = 0; i < 40; i++) {
    const guarded = applyCliffGuard(map, state, 0, { mx: -1000, my: 0, act: 0, ax: 0, ay: 0, msg: 0 });
    engineStep(`${actStr(guarded)}\n0 0 0 0 0 0`);
    state = JSON.parse(engineGetState());
  }
  assert(state.players[0].alive === 1, 'Should be standing safely at outer wave-0 rim before collapse');
  const posX = state.players[0].x;
  const posY = state.players[0].y;

  let fellFromCollapse = false;
  for (let i = 0; i < 350 && !state.over; i++) {
    // Player stands still (or keeps pushing outward); when floor underneath collapses, must fall!
    const guarded = applyCliffGuard(map, state, 0, { mx: 0, my: 0, act: 0, ax: 0, ay: 0, msg: 0 });
    engineStep(`${actStr(guarded)}\n0 0 0 0 0 0`);
    state = JSON.parse(engineGetState());
    if (!state.players[0].alive && state.players[0].cause === 3) {
      fellFromCollapse = true;
      break;
    }
  }
  assert(fellFromCollapse, `Standing at (${posX},${posY}) during platform collapse with cliffGuard ON must still fall!`);
  console.log(`  [TEST 5 PASS] Platform collapse underneath player at t=${state.t} with cliffGuard ON still falls (collapse unaffected)!`);
}

// ---------------------------------------------------------------------------
// Test 6: Being kicked off a cliff (S_STUN) with cliffGuard ON MUST STILL FALL!
// ---------------------------------------------------------------------------
{
  // Use stonecircle (open ground between spawns and outer rim) so seat 1 cleanly approaches seat 0 and kicks them off!
  let { map, state } = startMap('stonecircle', 0);
  // 1) Seat 0 walks straight left to the outer cliff rim with cliffGuard ON
  for (let i = 0; i < 40; i++) {
    const g0 = applyCliffGuard(map, state, 0, { mx: -1000, my: 0, act: 0, ax: 0, ay: 0, msg: 0 });
    engineStep(`${actStr(g0)}\n0 0 0 0 0 0`);
    state = JSON.parse(engineGetState());
  }
  assert(state.players[0].alive === 1, 'Seat 0 alive at left cliff rim');
  const p0 = state.players[0];

  // 2) Seat 1 approaches seat 0 (with cliffGuard so seat 1 doesn't drown on the way!), drops dart into a wall or throws away, then KICKS seat 0 left off the cliff!
  let kicked = false;
  let kickHit = false;
  let fellFromKick = false;
  for (let step = 0; step < 220 && !state.over; step++) {
    const q0 = state.players[0];
    const q1 = state.players[1];
    // Stay at left cliff rim before kick; once kicked, even trying to walk right doesn't stop stun slide!
    const g0 = applyCliffGuard(map, state, 0, { mx: kicked ? 1000 : 0, my: 0, act: 0, ax: 0, ay: 0, msg: 0 });

    const dx = q0.x + 900 - q1.x;
    const dy = q0.y - q1.y;
    const dist = Math.hypot(dx, dy);
    let raw1;
    if (dist > 300) {
      raw1 = { mx: Math.round((dx / dist) * 1000), my: Math.round((dy / dist) * 1000), act: 0, ax: 0, ay: 0, msg: 0 };
    } else if (state.darts[1].st === 0) {
      // Throw dart straight RIGHT (+1000, 0) away from seat 0 so seat 1 is empty-handed for kicking!
      raw1 = { mx: 0, my: 0, act: 1, ax: 1000, ay: 0, msg: 0 };
    } else if (!kicked && q1.st === 0) {
      // Kick seat 0 straight LEFT (-1000, 0) off the cliff!
      const kdx = q0.x - q1.x;
      const kdy = q0.y - q1.y;
      const kl = Math.hypot(kdx, kdy) || 1;
      raw1 = { mx: 0, my: 0, act: 2, ax: Math.round((kdx / kl) * 1000), ay: Math.round((kdy / kl) * 1000), msg: 0 };
      kicked = true;
    } else {
      raw1 = { mx: 0, my: 0, act: 0, ax: 0, ay: 0, msg: 0 };
    }
    const g1 = applyCliffGuard(map, state, 1, raw1);

    engineStep(`${actStr(g0)}\n${actStr(g1)}`);
    state = JSON.parse(engineGetState());
    if (state.events.some((e) => e.name === 'KICKHIT' && e.b === 0)) {
      kickHit = true;
    }
    if (!state.players[0].alive && state.players[0].cause === 3 && state.players[0].killer === 1) {
      fellFromKick = true;
      break;
    }
  }
  assert(kickHit, 'Seat 1 should have landed KICKHIT on seat 0');
  assert(fellFromKick, `Being kicked off cliff (from x=${p0.x}) with cliffGuard ON must still fall and credit killer=1!`);
  console.log('  [TEST 6 PASS] Being kicked off cliff with cliffGuard ON still falls and credits kicker (kick unaffected)!');
}

// ---------------------------------------------------------------------------
// Test 7: Diagonal cliff sliding — holding W+D near right cliff slides smoothly upward!
// ---------------------------------------------------------------------------
{
  let { map, state } = startMap('twinlakes', 0);
  // Walk to left rim first
  for (let i = 0; i < 30; i++) {
    const g0 = applyCliffGuard(map, state, 0, { mx: -1000, my: 0, act: 0, ax: 0, ay: 0, msg: 0 });
    engineStep(`${actStr(g0)}\n0 0 0 0 0 0`);
    state = JSON.parse(engineGetState());
  }
  const yBefore = state.players[0].y;
  // Hold down-left (-707, +707) along the left cliff edge for 15 ticks — should slide down smoothly without falling!
  for (let i = 0; i < 15; i++) {
    const g0 = applyCliffGuard(map, state, 0, { mx: -707, my: 707, act: 0, ax: 0, ay: 0, msg: 0 });
    engineStep(`${actStr(g0)}\n0 0 0 0 0 0`);
    state = JSON.parse(engineGetState());
    assert(state.players[0].alive === 1, 'Fell while sliding diagonally along cliff!');
  }
  const ySlide = state.players[0].y - yBefore;
  assert(ySlide > 500, `Expected smooth downward slide > 500mm along left cliff, got ${ySlide}mm`);
  console.log(`  [TEST 7 PASS] Diagonal cliff-edge sliding moved smoothly +${ySlide}mm along cliff with 0 falls!`);
}

// ---------------------------------------------------------------------------
// Test 8: After wave 0+1 collapse (t >= 280), walking into the newly collapsed pit
// is ALSO blocked by cliffGuard!
// ---------------------------------------------------------------------------
{
  let { map, state } = startMap('stonecircle', 0);
  // Move BOTH players toward center (offset apart so they don't collide) so the match stays alive past wave 1!
  const cx = map.nx * map.cell * 0.5;
  const cy = map.ny * map.cell * 0.5;
  while (state.t < 280 && !state.over) {
    const moveTo = (seat, tx, ty) => {
      const p = state.players[seat];
      const dx = tx - p.x;
      const dy = ty - p.y;
      const d = Math.hypot(dx, dy);
      const raw = d > 100
        ? { mx: Math.round((dx / d) * 1000), my: Math.round((dy / d) * 1000), act: 0, ax: 0, ay: 0, msg: 0 }
        : { mx: 0, my: 0, act: 0, ax: 0, ay: 0, msg: 0 };
      return applyCliffGuard(map, state, seat, raw);
    };
    const g0 = moveTo(0, cx - 1500, cy);
    const g1 = moveTo(1, cx + 1500, cy);
    engineStep(`${actStr(g0)}\n${actStr(g1)}`);
    state = JSON.parse(engineGetState());
  }
  assert(!state.over && state.players[0].alive === 1 && state.fallen >= 2, `Expected match alive after >=2 collapse waves, over=${state.over}, fallen=${state.fallen}`);
  // Walk straight left into the newly collapsed wave-1 rim during t=280..299 (before wave 2 collapses at t=300!)
  for (let i = 0; i < 19 && !state.over; i++) {
    const g0 = applyCliffGuard(map, state, 0, { mx: -1000, my: 0, act: 0, ax: 0, ay: 0, msg: 0 });
    engineStep(`${actStr(g0)}\n0 0 0 0 0 0`);
    state = JSON.parse(engineGetState());
    assert(state.players[0].alive === 1, `Fell into newly collapsed wave-1 pit at t=${state.t}!`);
  }
  // Confirm seat 0 stopped right at the newly collapsed cliff rim (not at original wave-0 edge x=500!)
  assert(state.players[0].x > 500, `Expected shrunk rim x > 500, got ${state.players[0].x}`);
  assert(cellOfPoint(map, state.players[0].x - 10, state.players[0].y, state.t) === 2, `Expected pit 10mm left of stopped pos x=${state.players[0].x}!`);
  console.log(`  [TEST 8 PASS] Stopped cleanly at newly collapsed cliff rim (x=${state.players[0].x}, fallen=${state.fallen} waves, t=${state.t}) with 0 falls!`);
}

// ---------------------------------------------------------------------------
// Test 9: Human dash-tail cliff guard — dashing 3000mm left from x=3000 (rim at x=500)
// normally lands at x=0 (C_PIT), but the final 25% [x=750..0] contains safe ground [750..500].
// With human cliffGuard ON, must stop at exact farthest safe landing point x=500 and stay alive!
// With human cliffGuard OFF (or for a Bot), exact same dash MUST fall!
// ---------------------------------------------------------------------------
{
  const runDashFromX = (startX, humanSeat, cliffGuard, seatToDash = 0) => {
    let { state } = startMap('stonecircle', 0, humanSeat, cliffGuard);
    // Move seat 0 horizontally to exact startX on y=6000 (stonecircle left rim is at x=500)
    for (let i = 0; i < 40; i++) {
      const dx = startX - state.players[0].x;
      if (Math.abs(dx) <= 1) break;
      const step = Math.max(-250, Math.min(250, dx));
      const mx = Math.round((step / 250) * 1000);
      engineStep(`${mx} 0 0 0 0 0\n0 0 0 0 0 0`);
      state = JSON.parse(engineGetState());
    }
    engineStep('0 0 0 0 0 0\n0 0 0 0 0 0');
    state = JSON.parse(engineGetState());
    const x0 = state.players[0].x;
    // Dash straight left (-1000, 0) for full 8 ticks + 2 extra ticks to verify zero post-dash slide-off
    engineStep(`${seatToDash === 0 ? '0 0 3 -1000 0 0' : '0 0 0 0 0 0'}\n0 0 0 0 0 0`);
    for (let i = 0; i < 10 && !state.over; i++) {
      engineStep('0 0 0 0 0 0\n0 0 0 0 0 0');
      state = JSON.parse(engineGetState());
    }
    return { x0, state };
  };

  // 9a: Overshoot by 500mm (within final 25% = 750mm) with human cliffGuard ON -> SAVED at x=500!
  const saved = runDashFromX(3000, 0, true);
  assert(saved.state.players[0].alive === 1, `Expected human saved by dash-tail cliff guard from x0=${saved.x0}, got alive=0`);
  assert(saved.state.players[0].x === 500, `Expected human stopped at exact farthest safe point x=500, got x=${saved.state.players[0].x}`);
  assert(saved.state.players[0].st === 0, `Expected human back to S_FREE after dash_post, got st=${saved.state.players[0].st}`);

  // 9b: Exact same dash with cliffGuard OFF -> FALLS!
  const off = runDashFromX(3000, 0, false);
  assert(off.state.players[0].alive === 0 && off.state.players[0].cause === 3, 'With cliffGuard OFF, overshoot dash must fall!');

  // 9c: Exact same dash as a BOT (humanSeat = 1, seat 0 is bot) with cliffGuard ON -> FALLS!
  const bot = runDashFromX(3000, 1, true);
  assert(bot.state.players[0].alive === 0 && bot.state.players[0].cause === 3, 'Bot dash must NEVER be affected by human cliffGuard!');

  // 9d: Overshoot by 900mm (> final 25% = 750mm; startX=2600 -> 75% mark is x=350, ALREADY C_PIT!) -> MUST STILL FALL!
  const deepAbyss = runDashFromX(2600, 0, true);
  assert(deepAbyss.state.players[0].alive === 0 && deepAbyss.state.players[0].cause === 3, `When entire final 25% is pit (x0=${deepAbyss.x0}), human must still fall!`);

  console.log(`  [TEST 9 PASS] Dash-tail 25% cliff guard: saved at exact x=${saved.state.players[0].x} (ON), fell when OFF/Bot/deep-abyss!`);
}

// ---------------------------------------------------------------------------
// Test 10: Gap-dash overshoot onto a narrow far island — 75% mark is still over the pit,
// 80%..96% is solid ground on the far island, and 100% overshoots off the far edge into pit.
// Human with cliffGuard ON must land safely at the FARTHEST safe point on the far island!
// ---------------------------------------------------------------------------
{
  // Build a clean synthetic test map (20x8 cells, CELL=500mm):
  // Row 3..4: cols 1..3 solid (x=500..2000), cols 4..7 pit (x=2000..4000, 2000mm gap),
  //           col 8 solid narrow island (x=4000..4500, 500mm wide!), cols 9..19 pit (x=4500..10000).
  // Seat 0 spawns at (1.6, 3.5) -> x=1600, y=3500:
  //   Dash right (+3000mm):
  //     75% mark = 1600 + 2250 = 3850 (STILL in pit col 7!)
  //     80%..96.6% = 4000..4500 (SOLID narrow island col 8!)
  //     100% mark = 1600 + 3000 = 4600 (OVERSHOT into pit col 9!)
  //   Farthest safe landing point in [3850..4600] is EXACTLY x = 4500!
  const syntheticMap = [
    'NAME gap_dash_test',
    'MODES 0',
    'SPAWN 0 1.6 2.0 8.5 2.0',
    'GRID 20 8',
    '~~~~~~~~~~~~~~~~~~~~',
    '~~~~~~~~~~~~~~~~~~~~',
    '~~~~~~~~~~~~~~~~~~~~',
    '~...~~~~.~~~~~~~...~',
    '~...~~~~.~~~~~~~...~',
    '~~~~~~~~~~~~~~~~~~~~',
    '~~~~~~~~~~~~~~~~~~~~',
    '~~~~~~~~~~~~~~~~~~~~',
  ].join('\n');

  assert(engineInit(syntheticMap, 2, 0), 'synthetic gap_dash_test init failed');
  engineSetHumanSeat(0);
  engineSetHumanCliffGuard(1);
  let st = JSON.parse(engineGetState());
  assert(st.players[0].x === 1600, `Expected start x=1600, got ${st.players[0].x}`);
  engineStep('0 0 3 1000 0 0\n0 0 0 0 0 0');
  for (let i = 0; i < 10 && !st.over; i++) {
    engineStep('0 0 0 0 0 0\n0 0 0 0 0 0');
    st = JSON.parse(engineGetState());
  }
  assert(st.players[0].alive === 1, 'Human should survive gap-dash overshoot onto narrow island!');
  assert(st.players[0].x === 4500, `Expected landing at farthest safe edge x=4500 of narrow island, got x=${st.players[0].x}`);

  // Confirm without cliffGuard, exact same gap-dash overshoots to x=4600 and falls!
  assert(engineInit(syntheticMap, 2, 0), 'synthetic gap_dash_test init 2 failed');
  engineSetHumanSeat(0);
  engineSetHumanCliffGuard(0);
  engineStep('0 0 3 1000 0 0\n0 0 0 0 0 0');
  for (let i = 0; i < 10; i++) {
    engineStep('0 0 0 0 0 0\n0 0 0 0 0 0');
    st = JSON.parse(engineGetState());
    if (st.over) break;
  }
  assert(st.players[0].alive === 0 && st.players[0].cause === 3, 'Without cliffGuard, gap-dash overshoot to x=4600 must fall!');
  console.log('  [TEST 10 PASS] Gap-dash overshoot onto narrow island (75%=pit, 80..96%=land, 100%=pit) saved at exact farthest safe point x=4500!');
}

// ---------------------------------------------------------------------------
// Test 11: Exact mouse-target dash within range (0mm error), wall blocking,
// beyond-range full dash + 25% cliff guard, and short targeted dash 25% cliff guard!
// ---------------------------------------------------------------------------
{
  // Open test arena (24x16 cells, CELL=500mm -> x=500..11500, y=500..7500 solid, with one vertical wall at col 14)
  const rows = [];
  for (let r = 0; r < 16; r++) {
    let line = '';
    for (let c = 0; c < 24; c++) {
      if (r === 0 || r === 15 || c === 0 || c === 23) line += '~';
      else if (c === 14 && r >= 4 && r <= 11) line += '#';
      else line += '.';
    }
    rows.push(line);
  }
  const openMap = [
    'NAME target_dash_test',
    'MODES 0',
    'SPAWN 0 4.0 4.0 10.0 4.0',
    'GRID 24 16',
    ...rows,
  ].join('\n');

  const dashTo = (startX, startY, tx, ty, cliffGuard = true) => {
    const custom = openMap.replace('SPAWN 0 4.0 4.0 10.0 4.0', `SPAWN 0 ${(startX / 1000).toFixed(3)} ${(startY / 1000).toFixed(3)} 10.5 7.0`);
    assert(engineInit(custom, 2, 0), 'openMap init failed');
    engineSetHumanSeat(0);
    engineSetHumanCliffGuard(cliffGuard ? 1 : 0);
    let st = JSON.parse(engineGetState());
    const dx = tx - st.players[0].x;
    const dy = ty - st.players[0].y;
    const d = Math.hypot(dx, dy) || 1;
    const ax = Math.round((dx / d) * 1000);
    const ay = Math.round((dy / d) * 1000);
    engineSetHumanDashTarget(1, tx, ty);
    engineStep(`0 0 3 ${ax} ${ay} 0\n0 0 0 0 0 0`);
    engineSetHumanDashTarget(0, 0, 0);
    for (let i = 0; i < 10; i++) {
      engineStep('0 0 0 0 0 0\n0 0 0 0 0 0');
      st = JSON.parse(engineGetState());
      if (st.over) break;
    }
    return st;
  };

  // 11a: Mouse cursor at short horizontal distance (423mm) -> mouse ONLY sets direction, dash runs FULL 3000mm (wall at col 14 => stops at x=6600)!
  // Wait: start at (3000, 4000), click 423mm right at (3423, 4000) -> full 3000mm dash lands at (6000, 4000) (NOT stopped at 3423)!
  let st = dashTo(3000, 4000, 3423, 4000, true);
  assert(st.players[0].alive === 1 && st.players[0].x >= 6000 && st.players[0].y === 4000,
    `11a full dash in mouse dir (no mouse stop): expected x>=6000, got (${st.players[0].x}, ${st.players[0].y})`);

  // 11b: Mid-range diagonal click (dx=1234, dy=-987 -> dist=1580mm) -> runs FULL 3000mm along diagonal (NOT stopped at 5234, 3013)!
  st = dashTo(3000, 5000, 4234, 4013, true);
  const diagDist = Math.hypot(st.players[0].x - 3000, st.players[0].y - 5000);
  assert(st.players[0].alive === 1 && diagDist >= 2950,
    `11b diag dash must travel full ~3000mm (no mouse stop), got dist=${Math.round(diagDist)} (${st.players[0].x}, ${st.players[0].y})`);

  // 11c: Wall blocking (wall at col 14 => x=7000..7500, body_r=400 => max safe x before wall is 6600)
  st = dashTo(5500, 4000, 7800, 4000, true);
  assert(st.players[0].alive === 1 && st.players[0].x === 6600 && st.players[0].y === 4000,
    `11c wall block: expected stopped at wall x=6600, got (${st.players[0].x}, ${st.players[0].y})`);

  // 11d: Mouse left toward abyss from x=3000 -> full 3000mm dash overshoots x=500 rim by 500mm (within final 25% = 750mm) -> 25% cliff guard saves at x=500!
  st = dashTo(3000, 4000, 2200, 4000, true);
  assert(st.players[0].alive === 1 && st.players[0].x === 500,
    `11d full dash + 25% cliff guard: expected saved at x=500, got alive=${st.players[0].alive} x=${st.players[0].x}`);

  // Same 11d with cliffGuard OFF -> full 3000mm dash lands in pit and falls!
  st = dashTo(3000, 4000, 2200, 4000, false);
  assert(st.players[0].alive === 0 && st.players[0].cause === 3,
    `11d with cliffGuard OFF must fall into pit, got alive=${st.players[0].alive}`);

  console.log('  [TEST 11 PASS] Mouse-direction dash: mouse sets direction ONLY (full 3000mm dash, never stops at cursor), wall block & 25% cliff guard intact!');
}

console.log('ALL 11 CLIFF-GUARD & MOUSE-DIRECTION DASH WASM PHYSICS TESTS PASSED!');
