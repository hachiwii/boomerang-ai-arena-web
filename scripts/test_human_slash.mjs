import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENGINE_JS = path.join(ROOT, 'public/wasm/engine.js');
const MAPS_DIR = path.join(ROOT, 'public/assets/maps');

const { default: createEngineModule } = await import(pathToFileURL(ENGINE_JS).href);
const mod = await createEngineModule({ printErr: () => {} });
const engineInit = mod.cwrap('engine_init', 'number', ['string', 'number', 'number']);
const engineSetHumanSeat = mod.cwrap('engine_set_human_seat', null, ['number']);
const engineStep = mod.cwrap('engine_step', 'number', ['string']);
const engineGetState = mod.cwrap('engine_get_state_json', 'string', []);

const mapText = fs.readFileSync(path.join(MAPS_DIR, 'stonecircle.txt'), 'utf8');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

/**
 * Walk seat 0 and seat 1 toward each other on stonecircle (y = 6000) until their
 * x-distance reaches `targetDistMm`, then stop both cleanly (vx=vy=0).
 */
function setupDuelAtDistance(targetDistMm, humanSeat) {
  assert(engineInit(mapText, 2, 0), 'engine_init failed');
  engineSetHumanSeat(humanSeat);
  let st = JSON.parse(engineGetState());
  for (let i = 0; i < 60; i++) {
    const dist = st.players[1].x - st.players[0].x;
    if (dist <= targetDistMm) break;
    const gap = dist - targetDistMm;
    const stepEach = Math.min(250, Math.floor(gap / 2));
    const m = Math.max(4, Math.min(1000, Math.round((stepEach / 250) * 1000)));
    if (gap < 250) {
      // Only move seat 1 left by exact gap
      const m1 = Math.max(4, Math.round((gap / 250) * 1000));
      engineStep(`0 0 0 0 0 0\n-${m1} 0 0 0 0 0`);
    } else {
      engineStep(`${m} 0 0 0 0 0\n-${m} 0 0 0 0 0`);
    }
    st = JSON.parse(engineGetState());
  }
  // Stop both players completely
  engineStep('0 0 0 0 0 0\n0 0 0 0 0 0');
  st = JSON.parse(engineGetState());
  return st;
}

// ---------------------------------------------------------------------------
// Test 1: Human slash hits on EACH of ticks 0, 1, 2, 3 (200ms) and does NOT hit on tick 4!
// ---------------------------------------------------------------------------
// Distance needed so seat 1 (moving left at 250mm/tick) enters <= 1500mm on exact tick k:
// Tick 0: start at 1400mm (already in range when pressed!)
// Tick 1: start at 1650mm -> tick 0 moves to 1400? Wait: stage 2 moves BEFORE stage 4!
// So on tick k, seat 1 has moved (k+1)*250mm left from initial distance D!
// Specifically:
//   after tick 0 stage 2: dist = D - 250
//   after tick 1 stage 2: dist = D - 500
//   after tick 2 stage 2: dist = D - 750
//   after tick 3 stage 2: dist = D - 1000
//   after tick 4 stage 2: dist = D - 1250
// Pick D so it crosses 1500mm on EXACT tick k:
//   k=0: D = 1650 -> tick 0 dist=1400 <= 1500 -> HIT on tick 0!
//   k=1: D = 1900 -> tick 0 dist=1650 (>1500), tick 1 dist=1400 -> HIT on tick 1!
//   k=2: D = 2150 -> tick 0:1900, tick 1:1650, tick 2:1400 -> HIT on tick 2 (S_SLASHED)!
//   k=3: D = 2400 -> tick 0:2150, tick 1:1900, tick 2:1650, tick 3:1400 -> HIT on tick 3 (S_SLASHED)!
//   k=4: D = 2650 -> tick 0..3 dist >= 1650, tick 4 dist=1400 -> MUST NOT HIT (window over at 200ms)!
for (const tc of [
  { label: 'Tick 0 (0ms, S_SLASH windup 1)', D: 1650, expectHitTick: 0 },
  { label: 'Tick 1 (50ms, S_SLASH windup 2)', D: 1900, expectHitTick: 1 },
  { label: 'Tick 2 (100ms, S_SLASHED post 1)', D: 2150, expectHitTick: 2 },
  { label: 'Tick 3 (150ms, S_SLASHED post 2)', D: 2400, expectHitTick: 3 },
  { label: 'Tick 4 (200ms, S_SLASHED post 3 — EXPIRED)', D: 2650, expectHitTick: -1 },
]) {
  let st = setupDuelAtDistance(tc.D, 0);
  const startDist = st.players[1].x - st.players[0].x;
  let hitTick = -1;
  let swingCount = 0;
  let swingTick = -1;

  for (let tick = 0; tick < 8 && !st.over; tick++) {
    const act0 = tick === 0 ? '0 0 2 1000 0 0' : '0 0 0 0 0 0';
    const act1 = '-1000 0 0 0 0 0';
    engineStep(`${act0}\n${act1}`);
    st = JSON.parse(engineGetState());
    for (const ev of st.events) {
      if (ev.name === 'SWING' && ev.a === 0) {
        swingCount++;
        swingTick = tick;
      }
      if (ev.name === 'CUT' && ev.a === 0 && ev.b === 1) {
        hitTick = tick;
      }
    }
  }
  assert(swingCount === 1 && swingTick === 0, `${tc.label}: expected exactly 1 EV_SWING on tick 0, got count=${swingCount} at tick=${swingTick}`);
  assert(hitTick === tc.expectHitTick, `${tc.label} (startDist=${startDist}): expected hitTick=${tc.expectHitTick}, got ${hitTick}`);
  if (tc.expectHitTick === -1) {
    assert(st.players[1].alive === 1, 'Tick 4 case: enemy should still be alive');
    assert(st.players[0].st === 0, `After 8 ticks human should return to S_FREE (0), got st=${st.players[0].st}`);
  }
  console.log(`  [PASS] Human ${tc.label} -> hitTick=${hitTick}, EV_SWING=${swingCount}@tick${swingTick}`);
}

// ---------------------------------------------------------------------------
// Test 2: Human blocks flying dart entering slash sector on Tick 2 (during S_SLASHED post-recovery!)
// ---------------------------------------------------------------------------
{
  let st = setupDuelAtDistance(3100, 0);
  // Seat 1 throws dart left toward seat 0 (throw_pre=2: released at tick 1 at x1, moves at tick 2 (dist ~2200), tick 3 (dist ~1350 <= 1500!))
  // Human presses slash on Tick 1 -> active ticks are 1, 2, 3, 4! Dart enters 1350mm on Tick 3 (Human's recovery tick 1 = S_SLASHED!)
  let blockedTick = -1;
  for (let tick = 0; tick < 8 && !st.over; tick++) {
    const act0 = tick === 1 ? '0 0 2 1000 0 0' : '0 0 0 0 0 0';
    const act1 = tick === 0 ? '0 0 1 -1000 0 0' : '0 0 0 0 0 0';
    engineStep(`${act0}\n${act1}`);
    st = JSON.parse(engineGetState());
    for (const ev of st.events) {
      if (ev.name === 'BLOCK' && ev.a === 0) blockedTick = tick;
    }
  }
  assert(st.players[0].alive === 1, 'Human should survive by blocking dart during S_SLASHED active window!');
  assert(blockedTick === 4 || blockedTick === 3, `Expected dart block on tick 3 or 4 (during recovery window), got ${blockedTick}`);
  assert(st.darts[1].st === 3, `Blocked dart should drop to D_GROUND (3), got ${st.darts[1].st}`);
  console.log(`  [PASS] Human blocked enemy flying dart during S_SLASHED active window (tick ${blockedTick})!`);
}

// ---------------------------------------------------------------------------
// Test 3: Bot slash (humanSeat = -1) strictly retains 1-tick original judgment (Tick 1 ONLY!)
// ---------------------------------------------------------------------------
{
  // Enemy walks into range on Tick 0 -> bot does NOT hit on Tick 0, hits on Tick 1
  let st = setupDuelAtDistance(1650, -1);
  let hitTick = -1;
  let swingTick = -1;
  for (let tick = 0; tick < 8 && !st.over; tick++) {
    engineStep(`${tick === 0 ? '0 0 2 1000 0 0' : '0 0 0 0 0 0'}\n-1000 0 0 0 0 0`);
    st = JSON.parse(engineGetState());
    for (const ev of st.events) {
      if (ev.name === 'SWING' && ev.a === 0) swingTick = tick;
      if (ev.name === 'CUT' && ev.a === 0) hitTick = tick;
    }
  }
  assert(swingTick === 1 && hitTick === 1, `Bot slash must fire ONLY on tick 1, got swing=${swingTick}, hit=${hitTick}`);

  // Enemy walks into range on Tick 2 (S_SLASHED) -> bot must NOT hit!
  st = setupDuelAtDistance(2150, -1);
  let botHitLate = false;
  for (let tick = 0; tick < 8 && !st.over; tick++) {
    engineStep(`${tick === 0 ? '0 0 2 1000 0 0' : '0 0 0 0 0 0'}\n-1000 0 0 0 0 0`);
    st = JSON.parse(engineGetState());
    if (st.events.some((ev) => ev.name === 'CUT' && ev.a === 0)) botHitLate = true;
  }
  assert(!botHitLate, 'Bot slash must NOT stay active during S_SLASHED (tick 2)!');
  console.log('  [PASS] Bot slash retains exact original 1-tick judgment on Tick 1 only!');
}

console.log('ALL HUMAN 200ms (4-TICK) SLASH WASM TESTS PASSED!');
