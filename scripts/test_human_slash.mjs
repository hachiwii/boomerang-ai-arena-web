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
const engineSetHumanMeleeAssist = mod.cwrap('engine_set_human_melee_assist', null, ['number']);
const engineStep = mod.cwrap('engine_step', 'number', ['string']);
const engineGetState = mod.cwrap('engine_get_state_json', 'string', []);

const mapText = fs.readFileSync(path.join(MAPS_DIR, 'stonecircle.txt'), 'utf8');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function makeCustomMap(rows, spawn) {
  const ny = rows.length;
  const nx = rows[0].length;
  return ['NAME test_slash', 'MODES 0', `SPAWN 0 ${spawn}`, `GRID ${nx} ${ny}`, ...rows].join('\n');
}

const openRows = Array.from({ length: 20 }, () => '.'.repeat(24));

/**
 * Walk seat 0 and seat 1 toward each other on stonecircle (y = 6000) until their
 * x-distance reaches `targetDistMm`, then stop both cleanly (vx=vy=0).
 */
function setupDuelAtDistance(targetDistMm, humanSeat, emptyHandSeat0 = false, humanSlashTicks = 4) {
  assert(engineInit(mapText, 2, 0), 'engine_init failed');
  engineSetHumanSeat(humanSeat);
  engineSetHumanSlashTicks(humanSlashTicks);
  engineSetHumanMeleeAssist(0);
  let st = JSON.parse(engineGetState());

  if (emptyHandSeat0) {
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
  engineStep('0 0 0 0 0 0\n0 0 0 0 0 0');
  st = JSON.parse(engineGetState());
  if (emptyHandSeat0) {
    assert(st.darts[0].st === 3, `Seat 0 should still be empty-handed (D_GROUND=3), got ${st.darts[0].st}`);
  }
  return st;
}

// ---------------------------------------------------------------------------
// Test 1: Human NORMAL SLASH hits on EACH of ticks 0, 1, 2, 3 (200ms = 4 ticks)
//         and does NOT hit on tick 4 or tick 5 (expired)!
// ---------------------------------------------------------------------------
for (const tc of [
  { label: 'Tick 0 (0ms, S_SLASH windup 1)', D: 1650, expectHitTick: 0 },
  { label: 'Tick 1 (50ms, S_SLASH windup 2)', D: 1900, expectHitTick: 1 },
  { label: 'Tick 2 (100ms, S_SLASHED post 1)', D: 2150, expectHitTick: 2 },
  { label: 'Tick 3 (150ms, S_SLASHED post 2)', D: 2400, expectHitTick: 3 },
  { label: 'Tick 4 (200ms, S_SLASHED post 3 — EXPIRED)', D: 2650, expectHitTick: -1 },
  { label: 'Tick 5 (250ms, S_SLASHED post 4 — EXPIRED)', D: 2900, expectHitTick: -1 },
]) {
  let st = setupDuelAtDistance(tc.D, 0, false, 4);
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
    assert(st.players[1].alive === 1, `${tc.label}: enemy should still be alive`);
    assert(st.players[0].st === 0, `After 8 ticks human should return to S_FREE (0), got st=${st.players[0].st}`);
  }
  console.log(`  [PASS] Human NORMAL SLASH ${tc.label} -> hitTick=${hitTick}, EV_SWING=${swingCount}@tick${swingTick}`);
}

// ---------------------------------------------------------------------------
// Test 2: Human NORMAL KICK hits on EACH of ticks 0, 1, 2, 3 (200ms = 4 ticks)
//         and does NOT hit on tick 4 (expired), emits 1 EV_SWING(b=0) on tick 0,
//         and NEVER double-kicks an already-stunned victim!
// ---------------------------------------------------------------------------
for (const tc of [
  { label: 'Tick 0 (0ms, S_KICK windup 1)', D: 1650, expectHitTick: 0 },
  { label: 'Tick 1 (50ms, S_KICK windup 2)', D: 1900, expectHitTick: 1 },
  { label: 'Tick 2 (100ms, S_KICKED post 1)', D: 2150, expectHitTick: 2 },
  { label: 'Tick 3 (150ms, S_KICKED post 2)', D: 2400, expectHitTick: 3 },
  { label: 'Tick 4 (200ms, S_KICKED post 3 — EXPIRED)', D: 2650, expectHitTick: -1 },
]) {
  let st = setupDuelAtDistance(tc.D, 0, true, 4);
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
    assert(kickHitCount === 0, `${tc.label}: expected 0 KICKHIT, got ${kickHitCount}`);
    assert(st.players[1].st === 0, `${tc.label}: enemy should remain S_FREE (0), got st=${st.players[1].st}`);
    assert(st.players[0].st === 0, `After 7 ticks human kick should return to S_FREE (0), got st=${st.players[0].st}`);
  }
  console.log(`  [PASS] Human NORMAL KICK  ${tc.label} -> hitTick=${hitTick}, hits=${kickHitCount}, EV_SWING=${swingCount}@tick${swingTick}`);
}

// ---------------------------------------------------------------------------
// Test 3: Human NORMAL (4f) blocks flying dart entering slash sector on late active tick (tick 3)
// ---------------------------------------------------------------------------
{
  let st = setupDuelAtDistance(3100, 0, false, 4);
  // Seat 1 throws left on tick 0 -> releases tick 1 at dist=3100;
  // tick 2 moves 3100 -> 2200; tick 3 moves 2200 -> 1350 (swept block on 4th active tick = tick 3!)
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
  assert(st.players[0].alive === 1, 'Human should survive by blocking dart on 4th active tick (Tick 3)!');
  assert(blockedTick === 3, `Expected dart block on tick 3 via swept segment, got ${blockedTick}`);
  assert(st.darts[1].st === 3, `Blocked dart should drop to D_GROUND (3), got ${st.darts[1].st}`);
  console.log(`  [PASS] Human NORMAL blocked enemy flying dart on 4th active tick (tick ${blockedTick})!`);
}

// ---------------------------------------------------------------------------
// Test 4: Bot SLASH & Bot KICK (humanSeat = -1) strictly retain 1-tick original judgment (Tick 1 ONLY!)
// ---------------------------------------------------------------------------
{
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

  st = setupDuelAtDistance(2150, -1, false);
  let botSlashLate = false;
  for (let tick = 0; tick < 8 && !st.over; tick++) {
    engineStep(`${tick === 0 ? '0 0 2 1000 0 0' : '0 0 0 0 0 0'}\n-1000 0 0 0 0 0`);
    st = JSON.parse(engineGetState());
    if (st.events.some((ev) => ev.name === 'CUT' && ev.a === 0)) botSlashLate = true;
  }
  assert(!botSlashLate, 'Bot slash must NOT stay active during S_SLASHED (tick 2)!');

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
// Test 5: Human STRICT mode (humanSlashTicks = 2) hits ONLY on ticks 0, 1
//         and misses on ticks 2, 3, 4 (for both SLASH and KICK)!
// ---------------------------------------------------------------------------
for (const tc of [
  { label: 'Strict Tick 0', D: 1650, expectHitTick: 0 },
  { label: 'Strict Tick 1', D: 1900, expectHitTick: 1 },
  { label: 'Strict Tick 2 (EXPIRED)', D: 2150, expectHitTick: -1 },
  { label: 'Strict Tick 3 (EXPIRED)', D: 2400, expectHitTick: -1 },
]) {
  let st = setupDuelAtDistance(tc.D, 0, false, 2);
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
  { label: 'Strict Kick Tick 1', D: 1900, expectHitTick: 1 },
  { label: 'Strict Kick Tick 2 (EXPIRED)', D: 2150, expectHitTick: -1 },
]) {
  let st = setupDuelAtDistance(tc.D, 0, true, 2);
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

  st = setupDuelAtDistance(2150, 0, false, 0);
  let lateHit = false;
  for (let tick = 0; tick < 8 && !st.over; tick++) {
    engineStep(`${tick === 0 ? '0 0 2 1000 0 0' : '0 0 0 0 0 0'}\n-1000 0 0 0 0 0`);
    st = JSON.parse(engineGetState());
    if (st.events.some((ev) => ev.name === 'CUT' && ev.a === 0)) lateHit = true;
  }
  assert(!lateHit, 'Human AI-mode SLASH must NOT hit on tick 2!');

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

// ---------------------------------------------------------------------------
// Test 7: Swept-segment frontal tunneling block (1550mm -> 700mm in 1 tick!)
//         - Normal (4f) & Strict (2f) BOTH block whether meleeAssist is ON or OFF
//         - Dart drops right at the intercept edge (~1500mm)
//         - AI mode (0f) does NOT swept-block even with meleeAssist ON!
// ---------------------------------------------------------------------------
{
  const tunnelMap = makeCustomMap(openRows, '5.0 5.0 7.45 5.0'); // dist = 2450mm
  // Tick 0: seat 1 throws left (-1000, 0)
  // Tick 1: dart releases at x=7450 (dist=2450, fresh)
  // Tick 2: dart moves 900mm -> x=6550 (dist=1550 > 1500!)
  // Tick 3: dart moves 850mm -> x=5700 (dist=700 <= 720 -> TUNNELS through [1500, 720] in 1 step!)
  for (const tc of [
    { label: 'Normal(4f) assist=OFF', ticks: 4, assist: 0, pressTick: 3, expectBlock: true },
    { label: 'Normal(4f) assist=ON', ticks: 4, assist: 1, pressTick: 3, expectBlock: true },
    { label: 'Strict(2f) assist=OFF', ticks: 2, assist: 0, pressTick: 3, expectBlock: true },
    { label: 'Strict(2f) assist=ON', ticks: 2, assist: 1, pressTick: 3, expectBlock: true },
    { label: 'AI(0f) assist=ON (fires tick 3)', ticks: 0, assist: 1, pressTick: 2, expectBlock: false },
    { label: 'Bot(seat=-1) (fires tick 3)', ticks: 4, assist: 1, humanSeat: -1, pressTick: 2, expectBlock: false },
  ]) {
    assert(engineInit(tunnelMap, 2, 0), 'tunnelMap init failed');
    engineSetHumanSeat(tc.humanSeat ?? 0);
    engineSetHumanSlashTicks(tc.ticks);
    engineSetHumanMeleeAssist(tc.assist);
    let blockEv = null;
    let st = JSON.parse(engineGetState());
    for (let tick = 0; tick <= 4 && !st.over; tick++) {
      const a0 = tick === tc.pressTick ? '0 0 2 1000 0 0' : '0 0 0 0 0 0';
      const a1 = tick === 0 ? '0 0 1 -1000 0 0' : '0 0 0 0 0 0';
      engineStep(`${a0}\n${a1}`);
      st = JSON.parse(engineGetState());
      for (const ev of st.events) {
        if (ev.name === 'BLOCK' && ev.a === 0) blockEv = ev;
      }
    }
    if (tc.expectBlock) {
      assert(blockEv !== null, `${tc.label}: expected swept EV_BLOCK on tunneling dart!`);
      assert(st.players[0].alive === 1, `${tc.label}: human must survive tunneling dart!`);
      assert(st.darts[1].st === 3, `${tc.label}: blocked dart must drop to D_GROUND(3), got ${st.darts[1].st}`);
      const dropDist = st.darts[1].x - st.players[0].x;
      assert(
        dropDist >= 1495 && dropDist <= 1500,
        `${tc.label}: swept block should drop dart right at reach edge (~1500mm), got ${dropDist}mm`,
      );
    } else {
      assert(blockEv === null, `${tc.label}: must NOT swept-block tunneling dart!`);
      assert(st.players[0].alive === 0, `${tc.label}: should die to tunneling dart!`);
    }
    console.log(`  [PASS] Tunneling 1550->700mm ${tc.label} -> blocked=${blockEv !== null}, alive=${st.players[0].alive}`);
  }
}

// ---------------------------------------------------------------------------
// Test 8: Dart block angle cone (±60° in Normal/Strict independent of meleeAssist;
//         strictly ±20° in AI mode even when meleeAssist=ON!)
// ---------------------------------------------------------------------------
{
  const coneMap = makeCustomMap(openRows, '5.0 5.0 7.1 5.0'); // dist = 2100mm
  // Tick 0: seat 1 throws left (-1000, 0)
  // Tick 1: dart releases at x=7100 (dist=2100)
  // Tick 2: dart moves 900 -> x=6200 (dist=1200, pure +x = 0° from seat 0!)
  // Tick 3: static Stage 4 check sees dart at (6200, 5000) -> dist=1200, angle=0°!
  const aimAtDeg = (deg) => {
    const rad = (deg * Math.PI) / 180;
    return `${Math.round(Math.cos(rad) * 1000)} ${Math.round(Math.sin(rad) * 1000)}`;
  };
  for (const tc of [
    { label: 'Normal(4f) assist=OFF @50° (inside ±60°)', ticks: 4, assist: 0, deg: 50, pressTick: 3, expectBlock: true },
    { label: 'Normal(4f) assist=ON  @50° (inside ±60°)', ticks: 4, assist: 1, deg: 50, pressTick: 3, expectBlock: true },
    { label: 'Strict(2f) assist=OFF @50° (inside ±60°)', ticks: 2, assist: 0, deg: 50, pressTick: 3, expectBlock: true },
    { label: 'Normal(4f) assist=ON  @70° (outside ±60°)', ticks: 4, assist: 1, deg: 70, pressTick: 3, expectBlock: false },
    { label: 'Strict(2f) assist=ON  @70° (outside ±60°)', ticks: 2, assist: 1, deg: 70, pressTick: 3, expectBlock: false },
    { label: 'AI(0f)     assist=ON  @50° (outside ±20°)', ticks: 0, assist: 1, deg: 50, pressTick: 2, expectBlock: false },
    { label: 'AI(0f)     assist=ON  @25° (outside ±20°, no assist boost!)', ticks: 0, assist: 1, deg: 25, pressTick: 2, expectBlock: false },
    { label: 'AI(0f)     assist=OFF @15° (inside ±20°)', ticks: 0, assist: 0, deg: 15, pressTick: 2, expectBlock: true },
  ]) {
    assert(engineInit(coneMap, 2, 0), 'coneMap init failed');
    engineSetHumanSeat(0);
    engineSetHumanSlashTicks(tc.ticks);
    engineSetHumanMeleeAssist(tc.assist);
    let blocked = false;
    let st = JSON.parse(engineGetState());
    for (let tick = 0; tick <= 4 && !st.over; tick++) {
      const a0 = tick === tc.pressTick ? `0 0 2 ${aimAtDeg(tc.deg)} 0` : '0 0 0 0 0 0';
      const a1 = tick === 0 ? '0 0 1 -1000 0 0' : '0 0 0 0 0 0';
      engineStep(`${a0}\n${a1}`);
      st = JSON.parse(engineGetState());
      if (st.events.some((ev) => ev.name === 'BLOCK' && ev.a === 0)) blocked = true;
    }
    assert(blocked === tc.expectBlock, `${tc.label}: expected blocked=${tc.expectBlock}, got ${blocked}`);
    console.log(`  [PASS] Cone ${tc.label} -> blocked=${blocked}`);
  }
}

// ---------------------------------------------------------------------------
// Test 9: Rear hit-before-block safety (s_hit < s_block):
//         Dart flying from BEHIND through seat 0's body into the front +x cone
//         MUST kill seat 0 (cannot block after getting hit in the back!).
// ---------------------------------------------------------------------------
{
  // Seat 0 at (5.0, 5.0) faces & slashes +x; Seat 1 at (3.2, 5.0) (1800mm BEHIND) throws +x.
  // Tick 1: dart releases at x=3200 (-1800mm)
  // Tick 2: dart moves +900 -> x=4100 (-900mm, outside hit_r=720)
  // Tick 3: dart moves +850 -> x=4950 (-50mm, enters 720mm from behind at s_hit=180/850=0.21, then passes body_r=400!)
  // Even with Normal(4f) slashing +x on tick 3, s_hit < s_block (and never inside ±60° before s_hit) -> MUST DIE!
  const rearMap = makeCustomMap(openRows, '5.0 5.0 3.2 5.0');
  assert(engineInit(rearMap, 2, 0), 'rearMap init failed');
  engineSetHumanSeat(0);
  engineSetHumanSlashTicks(4);
  engineSetHumanMeleeAssist(1);
  let blocked = false;
  let st = JSON.parse(engineGetState());
  for (let tick = 0; tick <= 4 && !st.over; tick++) {
    const a0 = tick === 3 ? '0 0 2 1000 0 0' : '0 0 0 0 0 0';
    const a1 = tick === 0 ? '0 0 1 1000 0 0' : '0 0 0 0 0 0';
    engineStep(`${a0}\n${a1}`);
    st = JSON.parse(engineGetState());
    if (st.events.some((ev) => ev.name === 'BLOCK' && ev.a === 0)) blocked = true;
  }
  assert(!blocked, 'Dart from behind must NOT be swept-blocked after hitting body!');
  assert(st.players[0].alive === 0, 'Seat 0 must die to rear dart!');
  console.log('  [PASS] Rear dart s_hit < s_block safety: no false block through body/back!');
}

// ---------------------------------------------------------------------------
// Test 10: Wall occlusion in swept-segment block:
//          (a) Fully behind wall -> CANNOT block through wall!
//          (b) Emerges past wall corner while still inside ±60° & 1500mm -> BLOCKS at clearance!
// ---------------------------------------------------------------------------
{
  // Map cell size = 500mm.
  // Seat 0 at (5.0, 5.0) = (5000, 5000), cell (10, 10), slashing +x (1000, 0).
  // Put a 3-cell vertical wall at gx=11 (x=5500..6000), gy=9,10,11 (y=4500..6000).
  // Case (a): Seat 1 at (6.25, 4.2) throws straight down (+y) past x=6250:
  //   At y=4600..5450 (distance ~1250..1330, angle ~0..20°), wall at gx=11 blocks ALL line of sight!
  const blockedWallRows = openRows.map((row, y) =>
    y >= 8 && y <= 12 ? row.slice(0, 11) + '#' + row.slice(12) : row,
  );
  const wallBlockedMap = makeCustomMap(blockedWallRows, '5.0 5.0 6.25 3.7');
  assert(engineInit(wallBlockedMap, 2, 0), 'wallBlockedMap init failed');
  engineSetHumanSeat(0);
  engineSetHumanSlashTicks(4);
  engineSetHumanMeleeAssist(0);
  let blockedThroughWall = false;
  let st = JSON.parse(engineGetState());
  for (let tick = 0; tick <= 5 && !st.over; tick++) {
    const a0 = tick === 2 ? '0 0 2 1000 0 0' : '0 0 0 0 0 0';
    const a1 = tick === 0 ? '0 0 1 0 1000 0' : '0 0 0 0 0 0';
    engineStep(`${a0}\n${a1}`);
    st = JSON.parse(engineGetState());
    if (st.events.some((ev) => ev.name === 'BLOCK' && ev.a === 0)) blockedThroughWall = true;
  }
  assert(!blockedThroughWall, 'Swept block must NOT pass through solid wall!');

  // Case (b): Wall only covers gy=9,10 (y=4500..5500) at gx=11; gy=11 (y>=5500) is open!
  // Dart flies vertically down along x=6250: on tick 3 it moves from y=4600 (behind wall) -> y=5450?
  // Wait: at y=5800 (dist=sqrt(1250^2+800^2)=1484 <= 1500, angle=32.6° <= 60°), line from (5000,5000) to (6250,5800)
  // passes x=5500 at y=5320 (still blocked by gy=10 y=5000..5500), so let wall only cover gy=9 (y=4500..5000)!
  // Then at y=4750 -> y=5600: start (6250, 4750) is blocked by gy=9 (line crosses x=5500..6000 at y=4900..4800),
  // and once y > 5000 line from (5000, 5000) clears gy=9 completely -> swept block catches it mid-step!
  const cornerWallRows = openRows.map((row, y) =>
    y === 9 ? row.slice(0, 11) + '#' + row.slice(12) : row,
  );
  const wallCornerMap = makeCustomMap(cornerWallRows, '5.0 5.0 6.25 3.85');
  assert(engineInit(wallCornerMap, 2, 0), 'wallCornerMap init failed');
  engineSetHumanSeat(0);
  engineSetHumanSlashTicks(4);
  engineSetHumanMeleeAssist(0);
  let cornerBlockEv = null;
  st = JSON.parse(engineGetState());
  for (let tick = 0; tick <= 4 && !st.over; tick++) {
    // Tick 1: dart releases at (6250, 3850)
    // Tick 2: dart moves +900 -> (6250, 4750) (behind wall cell (11,9)!)
    // Tick 3: dart moves +850 -> (6250, 5600) (clears wall at y>5000, dist<=1500, angle<=60°!)
    const a0 = tick === 3 ? '0 0 2 1000 0 0' : '0 0 0 0 0 0';
    const a1 = tick === 0 ? '0 0 1 0 1000 0' : '0 0 0 0 0 0';
    engineStep(`${a0}\n${a1}`);
    st = JSON.parse(engineGetState());
    for (const ev of st.events) {
      if (ev.name === 'BLOCK' && ev.a === 0) cornerBlockEv = ev;
    }
  }
  assert(cornerBlockEv !== null, 'Swept block should catch dart right after clearing wall corner mid-step!');
  assert(
    cornerBlockEv.d >= 5000 && cornerBlockEv.d <= 5150,
    `Expected corner block right after clearing y=5000, got y=${cornerBlockEv.d}`,
  );
  console.log(`  [PASS] Wall occlusion: blocked through wall=false; corner emergence blocked at y=${cornerBlockEv.d}`);
}

console.log('ALL HUMAN SLASH JUDGMENT (NORMAL 4f+SWEPT±60° / STRICT 2f+SWEPT±60° / AI EXACT) WASM TESTS PASSED!');
