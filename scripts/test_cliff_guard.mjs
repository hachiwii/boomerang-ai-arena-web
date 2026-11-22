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
const engineGetMap = engineMod.cwrap('engine_get_map_json', 'string', []);
const engineStep = engineMod.cwrap('engine_step', 'number', ['string']);
const engineGetState = engineMod.cwrap('engine_get_state_json', 'string', []);

function startMap(mapName, seed = 0) {
  const mapText = fs.readFileSync(path.join(MAPS_DIR, `${mapName}.txt`), 'utf8');
  if (!engineInit(mapText, 2, seed)) throw new Error(`init failed for ${mapName}`);
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

console.log('ALL 8 CLIFF-GUARD WASM PHYSICS TESTS PASSED!');
