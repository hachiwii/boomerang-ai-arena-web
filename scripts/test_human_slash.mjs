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
const engineSetHumanSlashTicks = mod.cwrap('engine_set_human_slash_ticks', null, ['number']);
const engineStep = mod.cwrap('engine_step', 'number', ['string']);
const engineGetState = mod.cwrap('engine_get_state_json', 'string', []);

const mapText = fs.readFileSync(path.join(MAPS_DIR, 'stonecircle.txt'), 'utf8');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

/**
 * Walk seat 0 and seat 1 toward each other on stonecircle (y = 6000) until their
 * x-distance reaches `targetDistMm`, then stop both cleanly (vx=vy=0).
 * When `emptyHandSeat0` is true, seat 0 first throws its dart straight left into the wall
 * so it drops to D_GROUND far behind seat 0 before positioning.
 */
function setupDuelAtDistance(targetDistMm, humanSeat, emptyHandSeat0 = false, humanSlashTicks = 5) {
  assert(engineInit(mapText, 2, 0), 'engine_init failed');
  engineSetHumanSeat(humanSeat);
  engineSetHumanSlashTicks(humanSlashTicks);
  let st = JSON.parse(engineGetState());

  if (emptyHandSeat0) {
    // Throw dart up-right into the northwest stone pillar so it hits the wall and drops to D_GROUND far from y=6000
    engineStep('0 0 1 800 -600 0\n0 0 0 0 0 0');
    for (let i = 0; i < 30; i++) {
      engineStep('0 0 0 0 0 0\n0 0 0 0 0 0');
      st = JSON.parse(engineGetState());
      if (st.darts[0].st === 3 && st.players[0].st === 0) break;
    }
    assert(st.darts[0].st === 3, `Expected seat 0 dart on D_GROUND (3), got st=${st.darts[0].st}`);
    assert(st.players[0].st === 0, `Expected seat 0 S_FREE (0), got st=${st.players[0].st}`);
  }

  for (let i = 0; i < 60; i++) {
    const dist = st.players[1].x - st.players[0].x;
    if (dist <= targetDistMm) break;
    const gap = dist - targetDistMm;
    const stepEach = Math.min(250, Math.floor(gap / 2));
    const m = Math.max(4, Math.min(1000, Math.round((stepEach / 250) * 1000)));
    if (gap < 250) {
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
  if (emptyHandSeat0) {
    assert(st.darts[0].st === 3, `Seat 0 should still be empty-handed (D_GROUND=3), got ${st.darts[0].st}`);
  }
  return st;
}

// ---------------------------------------------------------------------------
// Test 1: Human SLASH hits on EACH of ticks 0, 1, 2, 3, 4 (250ms = 5 ticks)
//         and does NOT hit on tick 5 (expired)!
// ---------------------------------------------------------------------------
// Distance D so seat 1 (moving left at 250mm/tick) enters <= 1500mm on exact tick k:
//   after tick k stage 2: dist = D - (k + 1) * 250
//   k=0: D=1650 -> tick 0 dist=1400
//   k=1: D=1900 -> tick 1 dist=1400
//   k=2: D=2150 -> tick 2 dist=1400
//   k=3: D=2400 -> tick 3 dist=1400
//   k=4: D=2650 -> tick 4 dist=1400
//   k=5: D=2900 -> tick 5 dist=1400 (window over at 250ms!)
for (const tc of [
  { label: 'Tick 0 (0ms, S_SLASH windup 1)', D: 1650, expectHitTick: 0 },
  { label: 'Tick 1 (50ms, S_SLASH windup 2)', D: 1900, expectHitTick: 1 },
  { label: 'Tick 2 (100ms, S_SLASHED post 1)', D: 2150, expectHitTick: 2 },
  { label: 'Tick 3 (150ms, S_SLASHED post 2)', D: 2400, expectHitTick: 3 },
  { label: 'Tick 4 (200ms, S_SLASHED post 3)', D: 2650, expectHitTick: 4 },
  { label: 'Tick 5 (250ms, S_SLASHED post 4 — EXPIRED)', D: 2900, expectHitTick: -1 },
]) {
  let st = setupDuelAtDistance(tc.D, 0, false);
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
        assert(ev.b === 1, `Expected SLASH EV_SWING b=1, got ${ev.b}`);
        swingCount++;
        swingTick = tick;
      }
      if (ev.name === 'CUT' && ev.a === 0 && ev.b === 1) {
        hitTick = tick;
      }
    }
  }
  assert(swingCount === 1 && swingTick === 0, `${tc.label}: expected 1 EV_SWING on tick 0, got count=${swingCount}@tick${swingTick}`);
  assert(hitTick === tc.expectHitTick, `${tc.label} (startDist=${startDist}): expected hitTick=${tc.expectHitTick}, got ${hitTick}`);
  if (tc.expectHitTick === -1) {
    assert(st.players[1].alive === 1, 'Tick 5 slash case: enemy should still be alive');
    assert(st.players[0].st === 0, `After 8 ticks human should return to S_FREE (0), got st=${st.players[0].st}`);
  }
  console.log(`  [PASS] Human SLASH ${tc.label} -> hitTick=${hitTick}, EV_SWING=${swingCount}@tick${swingTick}`);
}

// ---------------------------------------------------------------------------
// Test 2: Human KICK hits on EACH of ticks 0, 1, 2, 3, 4 (250ms = 5 ticks)
//         and does NOT hit on tick 5 (expired), emits 1 EV_SWING(b=0) on tick 0,
//         and NEVER double-kicks an already-stunned victim!
// ---------------------------------------------------------------------------
for (const tc of [
  { label: 'Tick 0 (0ms, S_KICK windup 1)', D: 1650, expectHitTick: 0 },
  { label: 'Tick 1 (50ms, S_KICK windup 2)', D: 1900, expectHitTick: 1 },
  { label: 'Tick 2 (100ms, S_KICKED post 1)', D: 2150, expectHitTick: 2 },
  { label: 'Tick 3 (150ms, S_KICKED post 2)', D: 2400, expectHitTick: 3 },
  { label: 'Tick 4 (200ms, S_KICKED post 3)', D: 2650, expectHitTick: 4 },
  { label: 'Tick 5 (250ms, S_KICKED post 4 — EXPIRED)', D: 2900, expectHitTick: -1 },
]) {
  let st = setupDuelAtDistance(tc.D, 0, true);
  const startDist = st.players[1].x - st.players[0].x;
  let hitTick = -1;
  let kickHitCount = 0;
  let cutCount = 0;
  let swingCount = 0;
  let swingTick = -1;

  for (let tick = 0; tick < 7 && !st.over; tick++) {
    const act0 = tick === 0 ? '0 0 2 1000 0 0' : '0 0 0 0 0 0';
    const act1 = '-1000 0 0 0 0 0';
    engineStep(`${act0}\n${act1}`);
    st = JSON.parse(engineGetState());
    if (tick === 0) {
      assert(st.players[0].st === 5, `Tick 0 kick should be S_KICK (5), got st=${st.players[0].st}`);
    }
    for (const ev of st.events) {
      if (ev.name === 'SWING' && ev.a === 0) {
        assert(ev.b === 0, `Expected KICK EV_SWING b=0, got ${ev.b}`);
        swingCount++;
        swingTick = tick;
      }
      if (ev.name === 'KICKHIT' && ev.a === 0 && ev.b === 1) {
        if (hitTick < 0) hitTick = tick;
        kickHitCount++;
      }
      if (ev.name === 'CUT' && ev.a === 0) {
        cutCount++;
      }
    }
  }
  assert(cutCount === 0, `${tc.label}: empty-handed kick must never emit CUT`);
  assert(swingCount === 1 && swingTick === 0, `${tc.label}: expected 1 EV_SWING(b=0) on tick 0, got count=${swingCount}@tick${swingTick}`);
  assert(hitTick === tc.expectHitTick, `${tc.label} (startDist=${startDist}): expected hitTick=${tc.expectHitTick}, got ${hitTick}`);
  if (tc.expectHitTick >= 0) {
    assert(kickHitCount === 1, `${tc.label}: victim must be kicked exactly once (no double-kick), got ${kickHitCount}`);
    assert(st.players[1].st === 8, `${tc.label}: kicked enemy should be in S_STUN (8), got st=${st.players[1].st}`);
  } else {
    assert(kickHitCount === 0, `Tick 5 kick case: expected 0 KICKHIT, got ${kickHitCount}`);
    assert(st.players[1].st === 0, `Tick 5 kick case: enemy should remain S_FREE (0), got st=${st.players[1].st}`);
    assert(st.players[0].st === 0, `After 7 ticks human kick should return to S_FREE (0), got st=${st.players[0].st}`);
  }
  console.log(`  [PASS] Human KICK  ${tc.label} -> hitTick=${hitTick}, hits=${kickHitCount}, EV_SWING=${swingCount}@tick${swingTick}`);
}

// ---------------------------------------------------------------------------
// Test 3: Human blocks flying dart entering slash sector on Tick 4 (5th active tick!)
// ---------------------------------------------------------------------------
{
  let st = setupDuelAtDistance(3100, 0, false);
  // Seat 1 throws dart left on tick 0 -> released on tick 1, moves on tick 2, enters <=1500mm on tick 3 or 4.
  // Human presses slash on Tick 0 -> active ticks are 0, 1, 2, 3, 4 (5 ticks)!
  let blockedTick = -1;
  for (let tick = 0; tick < 8 && !st.over; tick++) {
    const act0 = tick === 0 ? '0 0 2 1000 0 0' : '0 0 0 0 0 0';
    const act1 = tick === 0 ? '0 0 1 -1000 0 0' : '0 0 0 0 0 0';
    engineStep(`${act0}\n${act1}`);
    st = JSON.parse(engineGetState());
    for (const ev of st.events) {
      if (ev.name === 'BLOCK' && ev.a === 0) blockedTick = tick;
    }
  }
  assert(st.players[0].alive === 1, 'Human should survive by blocking dart on 5th active tick (Tick 4)!');
  assert(blockedTick === 3 || blockedTick === 4, `Expected dart block on tick 3 or 4, got ${blockedTick}`);
  assert(st.darts[1].st === 3, `Blocked dart should drop to D_GROUND (3), got ${st.darts[1].st}`);
  console.log(`  [PASS] Human blocked enemy flying dart on late active tick (tick ${blockedTick})!`);
}

// ---------------------------------------------------------------------------
// Test 4: Bot SLASH & Bot KICK (humanSeat = -1) strictly retain 1-tick original judgment (Tick 1 ONLY!)
// ---------------------------------------------------------------------------
{
  // Bot slash: enemy in range on tick 0 -> hits ONLY on tick 1
  let st = setupDuelAtDistance(1650, -1, false);
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

  // Bot slash late (tick 2): must NOT hit
  st = setupDuelAtDistance(2150, -1, false);
  let botSlashLate = false;
  for (let tick = 0; tick < 8 && !st.over; tick++) {
    engineStep(`${tick === 0 ? '0 0 2 1000 0 0' : '0 0 0 0 0 0'}\n-1000 0 0 0 0 0`);
    st = JSON.parse(engineGetState());
    if (st.events.some((ev) => ev.name === 'CUT' && ev.a === 0)) botSlashLate = true;
  }
  assert(!botSlashLate, 'Bot slash must NOT stay active during S_SLASHED (tick 2)!');

  // Bot kick: enemy in range on tick 0 -> kicks ONLY on tick 1
  st = setupDuelAtDistance(1650, -1, true);
  hitTick = -1;
  swingTick = -1;
  for (let tick = 0; tick < 7 && !st.over; tick++) {
    engineStep(`${tick === 0 ? '0 0 2 1000 0 0' : '0 0 0 0 0 0'}\n-1000 0 0 0 0 0`);
    st = JSON.parse(engineGetState());
    for (const ev of st.events) {
      if (ev.name === 'SWING' && ev.a === 0) swingTick = tick;
      if (ev.name === 'KICKHIT' && ev.a === 0) hitTick = tick;
    }
  }
  assert(swingTick === 1 && hitTick === 1, `Bot kick must fire ONLY on tick 1, got swing=${swingTick}, hit=${hitTick}`);

  // Bot kick late (tick 2): must NOT kick
  st = setupDuelAtDistance(2150, -1, true);
  let botKickLate = false;
  for (let tick = 0; tick < 7 && !st.over; tick++) {
    engineStep(`${tick === 0 ? '0 0 2 1000 0 0' : '0 0 0 0 0 0'}\n-1000 0 0 0 0 0`);
    st = JSON.parse(engineGetState());
    if (st.events.some((ev) => ev.name === 'KICKHIT' && ev.a === 0)) botKickLate = true;
  }
  assert(!botKickLate, 'Bot kick must NOT stay active during S_KICKED (tick 2)!');

  console.log('  [PASS] Bot SLASH & Bot KICK both retain exact original 1-tick judgment on Tick 1 only!');
}

// ---------------------------------------------------------------------------
// Test 5: Human STRICT mode (humanSlashTicks = 3) hits ONLY on ticks 0, 1, 2
//         and misses on ticks 3, 4, 5 (for both SLASH and KICK)!
// ---------------------------------------------------------------------------
for (const tc of [
  { label: 'Strict Tick 0', D: 1650, expectHitTick: 0 },
  { label: 'Strict Tick 1', D: 1900, expectHitTick: 1 },
  { label: 'Strict Tick 2', D: 2150, expectHitTick: 2 },
  { label: 'Strict Tick 3 (EXPIRED)', D: 2400, expectHitTick: -1 },
  { label: 'Strict Tick 4 (EXPIRED)', D: 2650, expectHitTick: -1 },
]) {
  let st = setupDuelAtDistance(tc.D, 0, false, 3);
  let hitTick = -1;
  let swingCount = 0;
  let swingTick = -1;
  for (let tick = 0; tick < 8 && !st.over; tick++) {
    engineStep(`${tick === 0 ? '0 0 2 1000 0 0' : '0 0 0 0 0 0'}\n-1000 0 0 0 0 0`);
    st = JSON.parse(engineGetState());
    for (const ev of st.events) {
      if (ev.name === 'SWING' && ev.a === 0) {
        swingCount++;
        swingTick = tick;
      }
      if (ev.name === 'CUT' && ev.a === 0 && ev.b === 1) hitTick = tick;
    }
  }
  assert(swingCount === 1 && swingTick === 0, `${tc.label}: expected 1 EV_SWING@tick0, got ${swingCount}@${swingTick}`);
  assert(hitTick === tc.expectHitTick, `${tc.label}: expected hitTick=${tc.expectHitTick}, got ${hitTick}`);
  console.log(`  [PASS] Human STRICT SLASH ${tc.label} -> hitTick=${hitTick}`);
}

for (const tc of [
  { label: 'Strict Kick Tick 2', D: 2150, expectHitTick: 2 },
  { label: 'Strict Kick Tick 3 (EXPIRED)', D: 2400, expectHitTick: -1 },
]) {
  let st = setupDuelAtDistance(tc.D, 0, true, 3);
  let hitTick = -1;
  for (let tick = 0; tick < 7 && !st.over; tick++) {
    engineStep(`${tick === 0 ? '0 0 2 1000 0 0' : '0 0 0 0 0 0'}\n-1000 0 0 0 0 0`);
    st = JSON.parse(engineGetState());
    for (const ev of st.events) {
      if (ev.name === 'KICKHIT' && ev.a === 0 && ev.b === 1 && hitTick < 0) hitTick = tick;
    }
  }
  assert(hitTick === tc.expectHitTick, `${tc.label}: expected hitTick=${tc.expectHitTick}, got ${hitTick}`);
  console.log(`  [PASS] Human STRICT KICK ${tc.label} -> hitTick=${hitTick}`);
}

// ---------------------------------------------------------------------------
// Test 6: Human AI mode (humanSlashTicks = 0) matches AI 100%:
//         has windup on tick 0 (NO swing/hit), fires ONLY 1 frame on tick 1, misses on tick 2+!
// ---------------------------------------------------------------------------
{
  // Enemy in range on tick 0 -> windup on tick 0, hits ONLY on tick 1 with EV_SWING on tick 1
  let st = setupDuelAtDistance(1650, 0, false, 0);
  let hitTick = -1;
  let swingTick = -1;
  let swingCount = 0;
  for (let tick = 0; tick < 8 && !st.over; tick++) {
    engineStep(`${tick === 0 ? '0 0 2 1000 0 0' : '0 0 0 0 0 0'}\n-1000 0 0 0 0 0`);
    st = JSON.parse(engineGetState());
    for (const ev of st.events) {
      if (ev.name === 'SWING' && ev.a === 0) {
        swingCount++;
        swingTick = tick;
      }
      if (ev.name === 'CUT' && ev.a === 0 && ev.b === 1) hitTick = tick;
    }
  }
  assert(
    swingCount === 1 && swingTick === 1 && hitTick === 1,
    `Human AI-mode SLASH must windup tick 0 and fire ONLY tick 1, got swing=${swingCount}@${swingTick}, hit=${hitTick}`,
  );

  // Enemy enters on tick 2 -> MUST NOT hit in AI mode
  st = setupDuelAtDistance(2150, 0, false, 0);
  let lateHit = false;
  for (let tick = 0; tick < 8 && !st.over; tick++) {
    engineStep(`${tick === 0 ? '0 0 2 1000 0 0' : '0 0 0 0 0 0'}\n-1000 0 0 0 0 0`);
    st = JSON.parse(engineGetState());
    if (st.events.some((ev) => ev.name === 'CUT' && ev.a === 0)) lateHit = true;
  }
  assert(!lateHit, 'Human AI-mode SLASH must NOT hit on tick 2!');

  // Empty-handed kick in AI mode -> windup tick 0, hits ONLY tick 1
  st = setupDuelAtDistance(1650, 0, true, 0);
  hitTick = -1;
  swingTick = -1;
  for (let tick = 0; tick < 7 && !st.over; tick++) {
    engineStep(`${tick === 0 ? '0 0 2 1000 0 0' : '0 0 0 0 0 0'}\n-1000 0 0 0 0 0`);
    st = JSON.parse(engineGetState());
    for (const ev of st.events) {
      if (ev.name === 'SWING' && ev.a === 0) swingTick = tick;
      if (ev.name === 'KICKHIT' && ev.a === 0 && ev.b === 1) hitTick = tick;
    }
  }
  assert(
    swingTick === 1 && hitTick === 1,
    `Human AI-mode KICK must fire ONLY on tick 1, got swing=${swingTick}, hit=${hitTick}`,
  );

  // Enemy enters on tick 2 in AI mode -> KICK must NOT hit
  st = setupDuelAtDistance(2150, 0, true, 0);
  let lateKick = false;
  for (let tick = 0; tick < 7 && !st.over; tick++) {
    engineStep(`${tick === 0 ? '0 0 2 1000 0 0' : '0 0 0 0 0 0'}\n-1000 0 0 0 0 0`);
    st = JSON.parse(engineGetState());
    if (st.events.some((ev) => ev.name === 'KICKHIT' && ev.a === 0)) lateKick = true;
  }
  assert(!lateKick, 'Human AI-mode KICK must NOT hit on tick 2!');

  console.log('  [PASS] Human AI mode (ticks=0) matches AI 100%: windup tick 0 + 1-frame judgment on tick 1 only!');
}

console.log('ALL HUMAN SLASH JUDGMENT (NORMAL 5f / STRICT 3f / AI 1f) WASM TESTS PASSED!');
