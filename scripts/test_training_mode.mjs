// Training-mode engine checks (engine_init_training on public/assets/training/training.txt):
// 64x32 wide arena, strike dummies 4m apart, open bottom-left, dart dummies near east edge with stone near max range,
// movement zone directly below dart zone, invincible player + fall fallback, reviving dummies, anchored dart dummies.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import createEngineModule from '../public/wasm/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mapText = fs.readFileSync(path.resolve(__dirname, '../public/assets/training/training.txt'), 'utf8');

const mod = await createEngineModule({ print: () => {}, printErr: () => {} });
const initTraining = mod.cwrap('engine_init_training', 'number', ['string']);
const setHumanSeat = mod.cwrap('engine_set_human_seat', null, ['number']);
const engineStep = mod.cwrap('engine_step', 'number', ['string']);
const getState = mod.cwrap('engine_get_state_json', 'string', []);
const getMap = mod.cwrap('engine_get_map_json', 'string', []);
const lastError = mod.cwrap('engine_last_error', 'string', []);

const N = 8;
const CELL = 500;
let st;
let map;

function reset() {
  assert.equal(initTraining(mapText), 1, `engine_init_training failed: ${lastError()}`);
  setHumanSeat(0);
  st = JSON.parse(getState());
  map = JSON.parse(getMap());
}

function step(acts = {}) {
  const lines = [];
  for (let k = 0; k < N; k++) {
    const a = acts[k] ?? [0, 0, 0, 0, 0];
    lines.push(`${a[0]} ${a[1]} ${a[2]} ${a[3]} ${a[4]} 0`);
  }
  const alive = engineStep(lines.join('\n'));
  assert.equal(alive, 1, 'training game must never end');
  st = JSON.parse(getState());
  return st.events;
}

function cellAt(x, y) {
  const gx = Math.floor(x / CELL);
  const gy = Math.floor(y / CELL);
  if (gx < 0 || gy < 0 || gx >= map.nx || gy >= map.ny) return 2;
  return map.cells[gy * map.nx + gx];
}

function walkTo(seat, x, y, tol = 120, maxTicks = 260, extra = {}) {
  const evs = [];
  for (let i = 0; i < maxTicks; i++) {
    const p = st.players[seat];
    const dx = x - p.x;
    const dy = y - p.y;
    const d = Math.hypot(dx, dy);
    if (d <= tol) return evs;
    const s = Math.min(1000, (d / 250) * 1000);
    evs.push(...step({ ...extra, [seat]: [Math.round((dx / d) * s), Math.round((dy / d) * s), 0, 0, 0] }));
  }
  return evs;
}

/** Drop seat 0's dart into the divider tree at (24..25, 15..16) = (12000..13000, 7500..8500) so seat 0 is empty-handed. */
function dropPlayerDartOnTree() {
  walkTo(0, 12250, 6500);
  step({ 0: [0, 0, 1, 0, 1000] });
  for (let i = 0; i < 20 && st.darts[0].st !== 3; i++) step();
  assert.equal(st.darts[0].st, 3, 'player dart dropped at the tree');
}

const has = (evs, name, pred = () => true) => evs.some((e) => e.name === name && pred(e));

// ---------------------------------------------------------------- 1. init & layout geometry
reset();
assert.equal(st.n, 8);
assert.equal(map.nx, 64, 'training map width doubled to 64 cells (32m)');
assert.equal(map.ny, 32, 'training map height stays 32 cells (16m)');
assert.equal(map.nwave, 0, 'training ground never collapses');
assert.ok(st.players.every((p) => p.alive === 1));
assert.deepEqual(map.spawns[1], [3250, 3000]);
assert.deepEqual(map.spawns[2], [7250, 3000]);
assert.deepEqual(map.spawns[3], [11250, 3000]);
assert.equal(map.spawns[2][0] - map.spawns[1][0], 4000, 'strike dummies spaced 4m apart (2x original)');
assert.equal(map.spawns[3][0] - map.spawns[2][0], 4000, 'strike dummies spaced 4m apart (2x original)');
assert.deepEqual(map.spawns[6], [30750, 3000]);
assert.deepEqual(map.spawns[7], [30750, 6500]);
// Verify bottom-left under strike zone is completely open floor
for (let gy = 15; gy <= 29; gy++) {
  for (let gx = 2; gx <= 20; gx++) {
    assert.equal(map.cells[gy * map.nx + gx], 0, `bottom-left (${gx},${gy}) should be empty open floor`);
  }
}
// Verify movement zone spans horizontally ~150% (cols 21..60, width 40 cells; lake row 23 cols 36..47 = 12 cells)
const lakeRow23 = [];
for (let gx = 1; gx <= 62; gx++) if (map.cells[23 * map.nx + gx] === 2) lakeRow23.push(gx);
assert.equal(lakeRow23.length, 12, `lake row 23 should be 12 cells wide (150% of 8), got ${lakeRow23.length}`);
console.log('  [PASS] init: 64x32 wide arena, 8 seats alive, 4m strike spacing, 150% movement zone, open bottom-left, no collapse');

// ---------------------------------------------------------------- 2. open lane: dart flies out and returns by itself
{
  reset();
  const evs = step({ 7: [0, 0, 1, -1000, 0] });
  let all = [...evs];
  for (let i = 0; i < 80 && !has(all, 'CATCH', (e) => e.a === 7); i++) all.push(...step());
  assert.ok(has(all, 'RELEASE', (e) => e.a === 7), 'dummy 7 released');
  assert.ok(has(all, 'TURN', (e) => e.a === 7 && Math.abs(e.b - (30750 - 7200)) <= 2), 'dart turned at full range');
  assert.ok(has(all, 'CATCH', (e) => e.a === 7), 'dart caught back');
  assert.ok(!has(all, 'DROP', (e) => e.a === 7), 'open lane: nothing in the way');
  assert.deepEqual([st.players[7].x, st.players[7].y], [30750, 6500]);
  console.log('  [PASS] open lane: full-range throw (7.2m), auto return, caught');
}

// ---------------------------------------------------------------- 3. stone lane: stone near max range (6.75m / 7.2m), drops & recalls
{
  reset();
  let all = [...step({ 6: [0, 0, 1, -1000, 0] })];
  for (let i = 0; i < 30 && !has(all, 'DROP', (e) => e.a === 6); i++) all.push(...step());
  const drop = all.find((e) => e.name === 'DROP' && e.a === 6);
  assert.ok(drop, 'dart hit the stone near end of range');
  assert.ok(drop.b >= 24000 && drop.b <= 24020 && drop.c === 3000, `dropped at the stone face (${drop.b},${drop.c})`);
  assert.equal(st.darts[6].st, 3);
  for (let i = 0; i < 60 && !has(all, 'CATCH', (e) => e.a === 6); i++) all.push(...step({ 6: [0, 0, 4, 0, 0] }));
  assert.ok(has(all, 'CALL', (e) => e.a === 6), 'recall flight started');
  assert.equal(st.darts[6].st, 0, 'recalled dart caught');
  console.log('  [PASS] stone lane: dart hits stone at 6.75m (93.8% of 7.2m range) and recalls cleanly');
}

// ---------------------------------------------------------------- 4. player is invincible to darts and slashes
{
  reset();
  // seat 2 (7.25, 3.0) throws straight south through the player at (7.25, 6.0)
  let all = [...step({ 2: [0, 0, 1, 0, 1000] })];
  for (let i = 0; i < 14; i++) all.push(...step());
  assert.ok(has(all, 'HIT', (e) => e.a === 2 && e.b === 0), 'dart hit the player');
  assert.ok(!has(all, 'DEATH', (e) => e.a === 0));
  assert.equal(st.players[0].alive, 1);
  for (let i = 0, got = false; i < 80 && !got; i++) got = has(step(), 'CATCH', (e) => e.a === 2);
  walkTo(0, 7250, 4100);
  all = [...step({ 2: [0, 0, 2, 0, 1000] })];
  for (let i = 0; i < 4; i++) all.push(...step());
  assert.ok(has(all, 'CUT', (e) => e.a === 2 && e.b === 0), 'slash connected');
  assert.equal(st.players[0].alive, 1);
  assert.equal(st.players[0].kills, 0);
  console.log('  [PASS] player invincible: HIT / CUT events, never dies');
}

// ---------------------------------------------------------------- 5. strike dummy dies and revives 2 s later at its spawn
{
  reset();
  walkTo(0, 7250, 4100);
  let all = [...step({ 0: [0, 0, 2, 0, -1000] })];
  for (let i = 0; i < 3; i++) all.push(...step());
  const death = all.find((e) => e.name === 'DEATH' && e.a === 2);
  assert.ok(death, 'strike dummy 2 slashed');
  assert.equal(st.players[2].alive, 0);
  assert.equal(st.players[0].kills, 1);
  const deadT = st.players[2].deadT;
  while (st.t <= deadT + 39) {
    assert.equal(st.players[2].alive, 0, `still down at t=${st.t}`);
    step();
  }
  assert.equal(st.t, deadT + 40);
  assert.equal(st.players[2].alive, 0);
  step();
  assert.equal(st.t, deadT + 41);
  assert.equal(st.players[2].alive, 1, 'revived exactly 40 ticks (2 s) after the death tick');
  assert.deepEqual([st.players[2].x, st.players[2].y], [7250, 3000]);
  assert.equal(st.players[2].st, 0);
  assert.equal(st.darts[2].st, 0);
  console.log('  [PASS] strike dummy: slashed → revives after 40 ticks (2 s) at its spawn');
}

// ---------------------------------------------------------------- 6. strike dummy kicked into the water dies, then revives
{
  reset();
  dropPlayerDartOnTree();
  // stand south of dummy 1 (3.25, 3.0) and kick it north into the water
  walkTo(0, 3250, 4050);
  let all = [...step({ 0: [0, 0, 2, 0, -1000] })];
  for (let i = 0; i < 20; i++) all.push(...step());
  assert.ok(has(all, 'KICKHIT', (e) => e.a === 0 && e.b === 1));
  assert.ok(has(all, 'DEATH', (e) => e.a === 1 && e.b === 3 && e.c === 0), 'kicked into the water');
  for (let i = 0; i < 45 && !st.players[1].alive; i++) step();
  assert.equal(st.players[1].alive, 1);
  assert.deepEqual([st.players[1].x, st.players[1].y], [3250, 3000]);
  console.log('  [PASS] strike dummy: kicked into the water → falls → revives at spawn');
}

// ---------------------------------------------------------------- 7. dart dummies: no knockback, no push, no death
{
  reset();
  dropPlayerDartOnTree();
  walkTo(0, 29900, 6500);
  for (let i = 0; i < 10; i++) step({ 0: [1000, 0, 0, 0, 0] });
  assert.deepEqual([st.players[7].x, st.players[7].y], [30750, 6500], 'not pushed');
  assert.ok(Math.hypot(st.players[0].x - 30750, st.players[0].y - 6500) >= 799, 'player was pushed out instead');
  let all = [...step({ 0: [0, 0, 2, 1000, 0] })];
  for (let i = 0; i < 15; i++) all.push(...step());
  assert.ok(has(all, 'KICKHIT', (e) => e.a === 0 && e.b === 7), 'kick connected');
  assert.deepEqual([st.players[7].x, st.players[7].y], [30750, 6500], 'not knocked back');
  assert.notEqual(st.players[7].st, 8, 'never stunned');
  assert.equal(st.players[7].alive, 1);
  all = [...step({ 7: [0, 0, 1, 0, -1000] })];
  for (let i = 0; i < 10; i++) all.push(...step());
  assert.ok(has(all, 'HIT', (e) => e.a === 7 && e.b === 6), 'dart hit dummy 6');
  assert.equal(st.players[6].alive, 1, 'dart dummy invincible');
  console.log('  [PASS] dart dummies: anchored (no push / knockback / stun) and invincible');
}

// ---------------------------------------------------------------- 8. player falls into the lake (below dart zone) → nearest safe ground
{
  reset();
  walkTo(0, 21000, 6500);
  walkTo(0, 21000, 9600);
  const evs = walkTo(0, 21000, 11800, 120, 60);
  const fall = evs.find((e) => e.name === 'FALL' && e.a === 0);
  assert.ok(fall, 'player fell into the lake below dart zone');
  assert.ok(!has(evs, 'DEATH', (e) => e.a === 0));
  const p = st.players[0];
  assert.equal(p.alive, 1);
  assert.notEqual(cellAt(p.x, p.y), 2, 'back on solid ground');
  assert.ok(Math.hypot(p.x - fall.c, p.y - fall.d) < 2000, `put back near the fall point (${p.x},${p.y})`);
  console.log(`  [PASS] lake fall: back on ground at (${p.x}, ${p.y}), ${Math.round(Math.hypot(p.x - fall.c, p.y - fall.d))}mm from the fall point`);
}

// ---------------------------------------------------------------- 9. player walks off the island edge
{
  reset();
  const evs = walkTo(0, -800, 6000, 120, 60);
  const fall = evs.find((e) => e.name === 'FALL' && e.a === 0);
  assert.ok(fall, 'player fell off the edge');
  const p = st.players[0];
  assert.equal(p.alive, 1);
  assert.notEqual(cellAt(p.x, p.y), 2);
  assert.ok(p.x >= 750 && p.x <= 1250, `back on the edge ground (${p.x},${p.y})`);
  console.log('  [PASS] edge fall: back on the nearest safe ground');
}

// ---------------------------------------------------------------- 10. never over
{
  reset();
  for (let i = 0; i < 3000; i++) step();
  assert.equal(st.over, false);
  assert.ok(st.players.every((p) => p.alive === 1));
  console.log('  [PASS] 3000 ticks (150 s): no time limit, no collapse, nobody dies on their own');
}

console.log('ALL TRAINING MODE ENGINE TESTS PASSED!');
