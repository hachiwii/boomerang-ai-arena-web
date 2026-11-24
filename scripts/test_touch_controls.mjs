import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

/**
 * Mobile touch-control input tests against the REAL WASM engine + REAL HumanInputController
 * (touch mode): stick-direction dash, facing dash, dash pre-input throw / slash, recall hold.
 */
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const built = await esbuild.build({
  entryPoints: [path.join(root, 'src/game/humanInput.ts'), path.join(root, 'src/game/settings.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
  outdir: path.join(root, '.tmp-test'),
});
const codeByName = new Map(built.outputFiles.map((f) => [path.basename(f.path), f.text]));

let fakeNowMs = 1000;
const storage = new Map();
globalThis.window = {
  innerWidth: 844,
  innerHeight: 390,
  addEventListener: () => {},
  removeEventListener: () => {},
};
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};
globalThis.HTMLInputElement = class {};
globalThis.HTMLTextAreaElement = class {};
Object.defineProperty(globalThis, 'performance', { value: { now: () => fakeNowMs }, configurable: true });
const fakeCanvas = { addEventListener: () => {}, removeEventListener: () => {} };

const settingsMod = await import(`data:text/javascript;base64,${Buffer.from(codeByName.get('settings.js')).toString('base64')}`);
const inputMod = await import(`data:text/javascript;base64,${Buffer.from(codeByName.get('humanInput.js')).toString('base64')}`);
const { SettingsStore } = settingsMod;
const { HumanInputController } = inputMod;

const engineUrl = pathToFileURL(path.join(root, 'public/wasm/engine.js')).href;
const { default: createEngine } = await import(engineUrl);
const mod = await createEngine({ wasmBinary: fs.readFileSync(path.join(root, 'public/wasm/engine.wasm')) });

const openRows = Array.from({ length: 20 }, () => '.'.repeat(32));
// Wall column at x = 8.0m (cell 16) so a thrown dart drops to the ground for recall tests
const wallRows = Array.from({ length: 20 }, () => '.'.repeat(16) + '#' + '.'.repeat(15));
const mapText = (rows, spawn = '3.0 5.0 13.0 5.0') =>
  ['NAME test_touch', 'MODES 0', `SPAWN 0 ${spawn}`, 'GRID 32 20', ...rows].join('\n');

function initMatch(rows, spawn) {
  const rc = mod.ccall('engine_init', 'number', ['string', 'number', 'number'], [mapText(rows, spawn), 2, 0]);
  assert.equal(rc, 1, 'engine_init should succeed');
  mod.ccall('engine_set_human_seat', 'void', ['number'], [0]);
  mod.ccall('engine_set_human_cliff_guard', 'void', ['number'], [1]);
  return {
    mapData: JSON.parse(mod.ccall('engine_get_map_json', 'string', [], [])),
    state: JSON.parse(mod.ccall('engine_get_state_json', 'string', [], [])),
  };
}

function stepEngine(a, botLine = '0 0 0 0 0 0') {
  mod.ccall('engine_set_human_dash_target', 'void', ['number', 'number', 'number'], [0, 0, 0]);
  mod.ccall('engine_step', 'number', ['string'], [`${a.mx} ${a.my} ${a.act} ${a.ax} ${a.ay} ${a.msg}\n${botLine}`]);
  return JSON.parse(mod.ccall('engine_get_state_json', 'string', [], []));
}

function setup(rows = openRows, opts = {}) {
  storage.clear();
  fakeNowMs = 1000;
  const settings = new SettingsStore();
  if (opts.meleeAssist === false) settings.setMeleeAssist(false);
  mod.ccall('engine_set_human_melee_assist', 'void', ['number'], [opts.meleeAssist === false ? 0 : 1]);
  const input = new HumanInputController(fakeCanvas, settings);
  input.setTouchMode(true);
  const { mapData, state } = initMatch(rows, opts.spawn);
  input.setMapData(mapData);
  input.setCliffGuard(true);
  input.setTickIntervalMs(50);
  input.setInputMode('active');
  let st = state;
  let tick = 0;
  const step = (botLine) => {
    tick++;
    fakeNowMs = 1000 + tick * 50;
    const act = input.sampleAction(st, 0);
    st = stepEngine(act, botLine);
    return { act, st };
  };
  const at = (offsetMs) => {
    fakeNowMs = 1000 + tick * 50 + offsetMs;
  };
  return { input, get st() { return st; }, step, at, get tick() { return tick; } };
}

const ev = (st, name) => st.events.find((e) => e.name === name);

// ---------- 1. Left stick: 6% deadzone, instant 100% full speed beyond, 50% speed cap while aiming ----------
{
  const h = setup();
  h.input.setVirtualMove(1, 0);
  let { act } = h.step();
  assert.equal(act.mx, 1000);
  assert.equal(act.my, 0);
  // Just past 6% deadzone → instant full speed (1000)
  h.input.setVirtualMove(0.08, 0);
  ({ act } = h.step());
  assert.equal(act.mx, 1000, `past 6% deadzone must immediately reach full speed (mx=${act.mx})`);
  // Aiming throw → capped to 50% speed (500)
  h.input.setVirtualAiming(true);
  h.input.setVirtualMove(1, 0);
  ({ act } = h.step());
  assert.equal(act.mx, 500, `while aiming throw, movement speed must be capped at 50% (mx=${act.mx})`);
  h.input.setVirtualAiming(false);
  // Inside 6% deadzone → stop
  h.input.setVirtualMove(0.05, 0);
  ({ act } = h.step());
  assert.equal(act.mx, 0, 'inside 6% dead zone → stop');
  console.log('  [TEST 1 PASS] left stick: 6% deadzone / instant full speed / 50% aiming speed cap');
}

// ---------- 2. Dash button toward held stick direction ----------
{
  const h = setup();
  const y0 = h.st.players[0].y;
  h.input.setVirtualMove(0, 1);
  h.at(10);
  h.input.queueVirtualDash();
  const { st } = h.step();
  const d = ev(st, 'DASH');
  assert.ok(d, 'DASH fires');
  assert.ok(d.c > 900 && Math.abs(d.b) < 100, `dash goes down the stick (+y), got (${d.b}, ${d.c})`);
  for (let i = 0; i < 9; i++) h.step();
  assert.ok(h.st.players[0].y - y0 >= 2900, `moved ~3m down, got ${h.st.players[0].y - y0}`);
  console.log('  [TEST 2 PASS] dash follows the move stick');
}

// ---------- 3. Dash button without stick → current facing ----------
{
  const h = setup();
  const faceRad = (h.st.players[0].face / 100) * (Math.PI / 180);
  h.at(10);
  h.input.queueVirtualDash();
  const { st } = h.step();
  const d = ev(st, 'DASH');
  assert.ok(d, 'DASH fires');
  const dot = (d.b * Math.cos(faceRad) + d.c * Math.sin(faceRad)) / 1000;
  assert.ok(dot > 0.98, `dash follows facing (dot=${dot.toFixed(3)})`);
  console.log('  [TEST 3 PASS] dash without stick uses facing');
}

// ---------- 4. Throw released during dash → fires on the first free tick, dash uninterrupted ----------
for (const afterDash of [true, false]) {
  const h = setup();
  const y0 = h.st.players[0].y;
  h.input.setVirtualMove(0, 1);
  h.at(10);
  h.input.queueVirtualDash();
  h.step();
  h.input.setVirtualMove(0, 0);
  let throwTick = -1;
  let throwEv = null;
  let firstFree = -1;
  for (let i = 1; i <= 12; i++) {
    if (i === 2) {
      h.at(20);
      h.input.queueVirtualThrow(1, 0, afterDash);
    }
    const { st } = h.step();
    if (firstFree < 0 && st.players[0].st !== 7) firstFree = h.tick;
    const t = ev(st, 'THROW');
    if (t && throwTick < 0) {
      throwTick = h.tick;
      throwEv = t;
    }
  }
  assert.ok(throwTick > 0, 'THROW fired');
  assert.equal(throwTick, firstFree + 1, `THROW on the first operable tick after dash (free@${firstFree}, throw@${throwTick})`);
  assert.ok(throwEv.b > 900, 'thrown toward the aimed direction (+x)');
  assert.ok(h.st.players[0].y - y0 >= 2900, 'dash distance not cut short');
  console.log(`  [TEST 4 PASS] throw pre-input during dash (afterDash=${afterDash}) fires right after the dash`);
}

// ---------- 5. Mobile dash-slash/kick (manual & smart auto-trigger with preInput + meleeAssist) ----------
{
  // 5a. Manual dash-slash (meleeAssist OFF): pressing melee on moving tick 3 immediately cuts dash into SLASH
  const h = setup(openRows, { meleeAssist: false });
  const y0 = h.st.players[0].y;
  h.input.setVirtualMove(0, 1);
  h.at(10);
  h.input.queueVirtualDash();
  h.step(); // dash tick 0 (timer=7)
  let slashOffset = -1;
  let slashEv = null;
  for (let i = 1; i <= 10; i++) {
    if (i === 3) {
      h.at(20);
      h.input.setVirtualMove(-1, 0); // stick points LEFT
      h.input.queueVirtualMelee();
    }
    const { st } = h.step();
    const s = ev(st, 'SLASH');
    if (s && slashOffset < 0) {
      slashOffset = i;
      slashEv = s;
    }
  }
  assert.equal(slashOffset, 3, `Manual mobile dash-slash must fire immediately on moving tick 3, got ${slashOffset}`);
  assert.ok(slashEv.b < -700, `dash-slash aimed left, got (${slashEv.b}, ${slashEv.c})`);
  assert.ok(h.st.players[0].y - y0 < 2600, `dash cut short by manual mobile dash-slash (dy=${h.st.players[0].y - y0})`);

  // 5b. Manual dash-kick (meleeAssist OFF, empty-handed): immediately fires KICK on moving tick 3
  const hKick = setup(wallRows, { meleeAssist: false });
  hKick.at(5);
  hKick.input.queueVirtualThrow(1, 0, false);
  for (let i = 0; i < 8; i++) hKick.step();
  assert.equal(hKick.st.players[0].st, 0, 'player free after throw');
  assert.notEqual(hKick.st.darts[0].st, 0, 'player empty-handed');
  hKick.input.setVirtualMove(0, 1);
  hKick.at(100);
  hKick.input.queueVirtualDash();
  hKick.step();
  let kickOffset = -1;
  for (let i = 1; i <= 10; i++) {
    if (i === 3) {
      hKick.at(200);
      hKick.input.setVirtualMove(-1, 0);
      hKick.input.queueVirtualMelee();
    }
    const { st } = hKick.step();
    if (ev(st, 'KICK') && kickOffset < 0) kickOffset = i;
  }
  assert.equal(kickOffset, 3, `Manual mobile dash-kick must fire immediately on moving tick 3, got ${kickOffset}`);

  // 5c. Smart dash-melee (preInput ON + meleeAssist ON) with NO enemy/dart in reach:
  // completes FULL 3000mm dash and fires SLASH on the first FREE tick after dash!
  const hNoTarget = setup(openRows, { meleeAssist: true });
  const yNT0 = hNoTarget.st.players[0].y;
  hNoTarget.input.setVirtualMove(0, 1);
  hNoTarget.at(10);
  hNoTarget.input.queueVirtualDash();
  hNoTarget.step();
  let ntSlashTick = -1;
  let ntFirstFree = -1;
  for (let i = 1; i <= 12; i++) {
    if (i === 2) {
      hNoTarget.at(20);
      hNoTarget.input.setVirtualMove(-1, 0);
      hNoTarget.input.queueVirtualMelee();
    }
    const { st } = hNoTarget.step();
    if (ntFirstFree < 0 && st.players[0].st !== 7) ntFirstFree = hNoTarget.tick;
    if (ev(st, 'SLASH') && ntSlashTick < 0) ntSlashTick = hNoTarget.tick;
  }
  assert.equal(ntSlashTick, ntFirstFree + 1, `Smart dash-melee with no target fires right after dash (free@${ntFirstFree}, slash@${ntSlashTick})`);
  assert.ok(hNoTarget.st.players[0].y - yNT0 >= 2900, 'full 3000mm dash completed when no hit opportunity arose');

  // 5d. Smart dash-melee (preInput ON + meleeAssist ON) when enemy enters reach mid-dash:
  // P0 at (3.0, 5.0), P1 at (5.0, 5.0) = 2000mm ahead -> dash right + tap melee early -> auto-cuts on tick 3 (dist=1250mm) & kills P1!
  const hHit = setup(openRows, { meleeAssist: true, spawn: '3 5 5 5' });
  hHit.input.setVirtualMove(1, 0); // dash right toward P1
  hHit.at(10);
  hHit.input.queueVirtualDash();
  hHit.step(); // dash tick 0 (timer=7, x=3000)
  let hitSlashOffset = -1;
  let killedP1 = false;
  for (let i = 1; i <= 10; i++) {
    if (i === 1) {
      hHit.at(20);
      hHit.input.setVirtualMove(0, -1); // stick points UP (away from P1) to also verify 360° assist snap!
      hHit.input.queueVirtualMelee();
    }
    const { st } = hHit.step();
    if (ev(st, 'SLASH') && hitSlashOffset < 0) hitSlashOffset = i;
    if (st.players[1].alive === 0) killedP1 = true;
  }
  assert.equal(hitSlashOffset, 3, `Smart dash-melee must auto-trigger on exact first tick enemy enters reach (offset 3), got ${hitSlashOffset}`);
  assert.ok(killedP1, 'Smart dash-melee must kill P1 cleanly');

  // 5e. Smart dash-melee (preInput ON + meleeAssist ON) auto-triggers to BLOCK an incoming enemy dart mid-dash!
  const hBlk = setup(openRows, { meleeAssist: true, spawn: '3 5 8 5' });
  // P1 throws left toward P0 on tick 0; P0 waits 2 ticks then dashes UP while tapping melee
  hBlk.step('0 0 1 -1000 0 0');
  hBlk.step('0 0 0 0 0 0');
  hBlk.input.setVirtualMove(0, 1);
  hBlk.at(10);
  hBlk.input.queueVirtualDash();
  hBlk.step('0 0 0 0 0 0'); // dash starts while dart is still ~5m away
  let blkOffset = -1;
  let dartBlocked = false;
  for (let i = 1; i <= 12; i++) {
    if (i === 1) {
      hBlk.at(20);
      hBlk.input.queueVirtualMelee();
    }
    const { st } = hBlk.step('0 0 0 0 0 0');
    if (ev(st, 'SLASH') && blkOffset < 0) blkOffset = i;
    if (ev(st, 'BLOCK')) dartBlocked = true;
  }
  assert.ok(blkOffset >= 2 && blkOffset <= 5, `Smart dash-melee should trigger mid-dash when dart enters window, got offset ${blkOffset}`);
  assert.ok(dartBlocked, 'Smart dash-melee auto-trigger must block the incoming dart');

  console.log('  [TEST 5 PASS] mobile dash-slash/kick (manual) + smart dash-melee (auto-hit enemy, auto-block dart, full-dash fallback)');
}

// ---------- 6. Hold right stick with dart on the ground → recall channel → CALL ----------
{
  const h = setup(wallRows);
  h.at(5);
  h.input.queueVirtualThrow(1, 0, false);
  let landed = false;
  for (let i = 0; i < 60 && !landed; i++) {
    const { st } = h.step();
    landed = st.darts[0].st === 3;
  }
  assert.ok(landed, 'dart dropped after hitting the wall');
  h.input.setVirtualRecallHeld(true);
  let recallTick = -1;
  let callTick = -1;
  for (let i = 0; i < 30 && callTick < 0; i++) {
    const { st } = h.step();
    if (ev(st, 'RECALL') && recallTick < 0) recallTick = h.tick;
    if (ev(st, 'CALL')) callTick = h.tick;
  }
  assert.ok(recallTick > 0, 'RECALL started while holding');
  assert.ok(callTick > recallTick, 'CALL fired after the channel');
  h.input.setVirtualRecallHeld(false);
  console.log(`  [TEST 6 PASS] hold-to-recall: RECALL@${recallTick} → CALL@${callTick}`);
}

// ---------- 7. Releasing the stick mid-channel cancels the recall ----------
{
  const h = setup(wallRows);
  h.at(5);
  h.input.queueVirtualThrow(1, 0, false);
  for (let i = 0; i < 60 && h.st.darts[0].st !== 3; i++) h.step();
  h.input.setVirtualRecallHeld(true);
  for (let i = 0; i < 4; i++) h.step();
  assert.equal(h.st.players[0].st, 9, 'channelling recall');
  h.input.setVirtualRecallHeld(false);
  h.step();
  h.step();
  assert.equal(h.st.players[0].st, 0, 'back to free after release');
  assert.equal(h.st.darts[0].st, 3, 'dart stays on the ground');
  console.log('  [TEST 7 PASS] releasing mid-channel cancels the recall');
}

// ---------- 8. Melee assist ON: slash auto-turns 360° to block a dart coming from behind ----------
// P0 at (7,5) faces +x (toward map center); P1 at (2,5) throws +x straight at P0's back.
function dartFromBehind(meleeAssist, slashTicksLabel = 'normal') {
  const h = setup(openRows, { meleeAssist, spawn: '7.0 5.0 2.0 5.0' });
  if (slashTicksLabel !== 'normal') {
    h.input['settings'].setSlashJudgment(slashTicksLabel);
    mod.ccall('engine_set_human_slash_ticks', 'void', ['number'], [slashTicksLabel === 'strict' ? 2 : 0]);
  }
  const faceRad = (h.st.players[0].face / 100) * (Math.PI / 180);
  assert.ok(Math.cos(faceRad) > 0.9, 'P0 starts facing +x (away from the thrower)');
  h.step('0 0 1 1000 0 0'); // P1 throws toward P0
  let pressed = -1;
  let slash = null;
  let block = null;
  let died = false;
  for (let i = 0; i < 20 && !block && !died; i++) {
    const d = h.st.darts[1];
    const dist = Math.hypot(d.x - h.st.players[0].x, d.y - h.st.players[0].y);
    if (pressed < 0 && d.st === 1 && dist <= 2600) {
      pressed = h.tick;
      h.at(10);
      h.input.queueVirtualMelee(); // no stick held → would swing toward facing (+x) without assist
    }
    const { st } = h.step();
    slash = slash || ev(st, 'SLASH');
    block = block || st.events.find((e) => e.name === 'BLOCK' && e.a === 0);
    died = st.players[0].alive !== 1;
  }
  return { pressed, slash, block, died };
}
{
  const on = dartFromBehind(true);
  assert.ok(on.pressed > 0, 'slash pressed while the dart was inbound');
  assert.ok(on.slash && on.slash.b < -900, `assist swings back toward the dart (-x), got (${on.slash?.b}, ${on.slash?.c})`);
  assert.ok(on.block, 'dart blocked');
  assert.ok(!on.died, 'player survives');
  const off = dartFromBehind(false);
  assert.ok(off.slash && off.slash.b > 900, 'without assist the swing keeps facing +x');
  assert.ok(!off.block, 'without assist the dart is not blocked');
  console.log('  [TEST 8 PASS] assist ON turns 360° and blocks a dart from behind; OFF does not');
}

// ---------- 9. Multi-frame prediction: dart still out of reach on the press tick, enters later ----------
{
  const h = setup(openRows, { spawn: '7.0 5.0 2.0 5.0' });
  h.step('0 0 1 1000 0 0');
  let pressedDist = -1;
  let block = null;
  let died = false;
  for (let i = 0; i < 20 && !block && !died; i++) {
    const d = h.st.darts[1];
    const dist = Math.hypot(d.x - h.st.players[0].x, d.y - h.st.players[0].y);
    // Press while the dart is clearly OUTSIDE reach (1.5m) — only the window prediction can catch it
    if (pressedDist < 0 && d.st === 1 && dist > 1700 && dist <= 3400) {
      pressedDist = dist;
      h.at(10);
      h.input.queueVirtualMelee();
    }
    const { st } = h.step();
    block = block || st.events.find((e) => e.name === 'BLOCK' && e.a === 0);
    died = st.players[0].alive !== 1;
  }
  assert.ok(pressedDist > 1500, `pressed out of reach (${Math.round(pressedDist)}mm)`);
  assert.ok(block && !died, 'blocked on a later judgment frame of the same swing');
  console.log(`  [TEST 9 PASS] pressed at ${Math.round(pressedDist)}mm (out of reach) → blocked on a later window frame`);
}

console.log('\nAll touch-control tests passed.');
