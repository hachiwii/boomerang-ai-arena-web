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
const mapText = (rows) => ['NAME test_touch', 'MODES 0', 'SPAWN 0 3.0 5.0 13.0 5.0', 'GRID 32 20', ...rows].join('\n');

function initMatch(rows) {
  const rc = mod.ccall('engine_init', 'number', ['string', 'number', 'number'], [mapText(rows), 2, 0]);
  assert.equal(rc, 1, 'engine_init should succeed');
  mod.ccall('engine_set_human_seat', 'void', ['number'], [0]);
  mod.ccall('engine_set_human_cliff_guard', 'void', ['number'], [1]);
  return {
    mapData: JSON.parse(mod.ccall('engine_get_map_json', 'string', [], [])),
    state: JSON.parse(mod.ccall('engine_get_state_json', 'string', [], [])),
  };
}

function stepEngine(a) {
  mod.ccall('engine_set_human_dash_target', 'void', ['number', 'number', 'number'], [0, 0, 0]);
  mod.ccall('engine_step', 'number', ['string'], [`${a.mx} ${a.my} ${a.act} ${a.ax} ${a.ay} ${a.msg}\n0 0 0 0 0 0`]);
  return JSON.parse(mod.ccall('engine_get_state_json', 'string', [], []));
}

function setup(rows = openRows) {
  storage.clear();
  fakeNowMs = 1000;
  const settings = new SettingsStore();
  const input = new HumanInputController(fakeCanvas, settings);
  input.setTouchMode(true);
  const { mapData, state } = initMatch(rows);
  input.setMapData(mapData);
  input.setCliffGuard(true);
  input.setTickIntervalMs(50);
  input.setInputMode('active');
  let st = state;
  let tick = 0;
  const step = () => {
    tick++;
    fakeNowMs = 1000 + tick * 50;
    const act = input.sampleAction(st, 0);
    st = stepEngine(act);
    return { act, st };
  };
  const at = (offsetMs) => {
    fakeNowMs = 1000 + tick * 50 + offsetMs;
  };
  return { input, get st() { return st; }, step, at, get tick() { return tick; } };
}

const ev = (st, name) => st.events.find((e) => e.name === name);

// ---------- 1. Analog left stick → proportional walk, full deflection = full speed ----------
{
  const h = setup();
  h.input.setVirtualMove(1, 0);
  let { act } = h.step();
  assert.equal(act.mx, 1000);
  assert.equal(act.my, 0);
  h.input.setVirtualMove(0.25, 0);
  ({ act } = h.step());
  assert.ok(act.mx > 0 && act.mx < 1000, `partial deflection walks slower (mx=${act.mx})`);
  h.input.setVirtualMove(0.05, 0);
  ({ act } = h.step());
  assert.equal(act.mx, 0, 'inside dead zone → stop');
  console.log('  [TEST 1 PASS] analog stick: full / proportional / dead zone');
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

// ---------- 5. Slash during dash (+ stick held) → after the dash, toward the stick ----------
for (const pressTick of [1, 3, 5]) {
  const h = setup();
  const y0 = h.st.players[0].y;
  h.input.setVirtualMove(0, 1);
  h.at(10);
  h.input.queueVirtualDash();
  h.step();
  let slashTick = -1;
  let slashEv = null;
  let firstFree = -1;
  for (let i = 1; i <= 12; i++) {
    if (i === pressTick) {
      h.at(20);
      h.input.setVirtualMove(-1, 0); // stick now points LEFT
      h.input.queueVirtualMelee();
    }
    const { st } = h.step();
    if (firstFree < 0 && st.players[0].st !== 7) firstFree = h.tick;
    const s = ev(st, 'SLASH');
    if (s && slashTick < 0) {
      slashTick = h.tick;
      slashEv = s;
    }
  }
  assert.ok(slashTick > 0, 'SLASH fired');
  assert.equal(slashTick, firstFree + 1, `SLASH right after dash ends (free@${firstFree}, slash@${slashTick})`);
  assert.ok(slashEv.b < -700, `slash toward the stick (left), got (${slashEv.b}, ${slashEv.c})`);
  assert.ok(h.st.players[0].y - y0 >= 2900, 'dash not cut short by the buffered slash');
  console.log(`  [TEST 5 PASS] slash pressed at dash tick ${pressTick} → fires after dash toward the stick`);
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

console.log('\nAll touch-control tests passed.');
