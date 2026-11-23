import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// Compile src/game/humanInput.ts + settings.ts in-memory with esbuild so we test the REAL source code!
const built = await esbuild.build({
  entryPoints: [
    path.join(root, 'src/game/humanInput.ts'),
    path.join(root, 'src/game/settings.ts'),
  ],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
  outdir: path.join(root, '.tmp-test'),
});

const codeByName = new Map(built.outputFiles.map((f) => [path.basename(f.path), f.text]));

// Minimal browser DOM/window/performance shim for HumanInputController + SettingsStore
let fakeNowMs = 1000;
const winListeners = new Map();
const canvasListeners = new Map();
const storage = new Map();

function addListener(map, type, fn) {
  if (!map.has(type)) map.set(type, []);
  map.get(type).push(fn);
}
function emitEvent(map, type, ev) {
  for (const fn of map.get(type) || []) fn(ev);
}

globalThis.window = {
  innerWidth: 1280,
  innerHeight: 800,
  addEventListener: (t, fn) => addListener(winListeners, t, fn),
  removeEventListener: () => {},
};
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};
globalThis.HTMLInputElement = class {};
globalThis.HTMLTextAreaElement = class {};
Object.defineProperty(globalThis, 'performance', {
  value: { now: () => fakeNowMs },
  configurable: true,
});

const fakeCanvas = {
  addEventListener: (t, fn) => addListener(canvasListeners, t, fn),
  removeEventListener: () => {},
};

const settingsMod = await import(`data:text/javascript;base64,${Buffer.from(codeByName.get('settings.js')).toString('base64')}`);
const inputMod = await import(`data:text/javascript;base64,${Buffer.from(codeByName.get('humanInput.js')).toString('base64')}`);

const { SettingsStore, defaultSettings } = settingsMod;
const { HumanInputController } = inputMod;

// Load real WASM engine
const engineUrl = pathToFileURL(path.join(root, 'public/wasm/engine.js')).href;
const { default: createEngine } = await import(engineUrl);
const wasmBinary = fs.readFileSync(path.join(root, 'public/wasm/engine.wasm'));
const mod = await createEngine({ wasmBinary });

const openMap = [
  'NAME test_open',
  'MODES 0',
  'SPAWN 0 3.0 5.0 13.0 5.0',
  'GRID 32 20',
  ...Array.from({ length: 20 }, () => '.'.repeat(32)),
].join('\n');

function initMatch(cliffGuard = true) {
  const rc = mod.ccall('engine_init', 'number', ['string', 'number', 'number'], [openMap, 2, 0]);
  assert.equal(rc, 1, 'engine_init should return 1 on success');
  mod.ccall('engine_set_human_seat', 'void', ['number'], [0]);
  mod.ccall('engine_set_human_cliff_guard', 'void', ['number'], [cliffGuard ? 1 : 0]);
  const mapData = JSON.parse(mod.ccall('engine_get_map_json', 'string', [], []));
  const state = JSON.parse(mod.ccall('engine_get_state_json', 'string', [], []));
  return { mapData, state };
}

function stepEngine(humanAction) {
  if (
    humanAction.act === 3 &&
    typeof humanAction.dashTargetX === 'number' &&
    typeof humanAction.dashTargetY === 'number'
  ) {
    mod.ccall('engine_set_human_dash_target', 'void', ['number', 'number', 'number'], [
      1,
      Math.round(humanAction.dashTargetX),
      Math.round(humanAction.dashTargetY),
    ]);
  } else {
    mod.ccall('engine_set_human_dash_target', 'void', ['number', 'number', 'number'], [0, 0, 0]);
  }
  const line0 = `${humanAction.mx} ${humanAction.my} ${humanAction.act} ${humanAction.ax} ${humanAction.ay} ${humanAction.msg}`;
  const actionsText = `${line0}\n0 0 0 0 0 0`;
  mod.ccall('engine_step', 'number', ['string'], [actionsText]);
  return JSON.parse(mod.ccall('engine_get_state_json', 'string', [], []));
}

function pressKey(code, atMs) {
  fakeNowMs = atMs;
  emitEvent(winListeners, 'keydown', { code, repeat: false, target: null, preventDefault() {} });
}
function releaseKey(code, atMs) {
  fakeNowMs = atMs;
  emitEvent(winListeners, 'keyup', { code, target: null });
}
function clickMouse(button, atMs) {
  fakeNowMs = atMs;
  emitEvent(canvasListeners, 'mousedown', { button, clientX: 900, clientY: 400, preventDefault() {} });
}
function releaseMouse(button, atMs) {
  fakeNowMs = atMs;
  emitEvent(winListeners, 'mouseup', { button });
}

function setupHarness({ dashInputBuffer = true, bindDashToMouse = false } = {}) {
  winListeners.clear();
  canvasListeners.clear();
  storage.clear();
  fakeNowMs = 1000;

  const settings = new SettingsStore();
  settings.setDashInputBuffer(dashInputBuffer);
  if (bindDashToMouse) {
    settings.setBinding('dashToMouse', 0, 'KeyQ');
  }
  const input = new HumanInputController(fakeCanvas, settings);
  const { mapData, state } = initMatch(true);
  input.setMapData(mapData);
  input.setCliffGuard(true);
  input.setTickIntervalMs(50);
  input.setInputMode('active');
  // Aim directly to the right (+X)
  let aimTarget = [10000, 5000];
  input.hasMouse = true;
  input.setAimProjector(() => aimTarget);
  return {
    settings,
    input,
    state,
    setAimTarget: (x, y) => {
      aimTarget = [x, y];
    },
  };
}

// ---------- TEST 1: Default setting is ON ----------
assert.equal(defaultSettings().dashInputBuffer, true, 'dashInputBuffer must default to true');
console.log('  [TEST 1 PASS] defaultSettings().dashInputBuffer === true');

// ---------- TEST 2: Pre-input THROW early in dash (windup tick 1) fires on exact first operable tick (tick 8) ----------
{
  const h = setupHarness({ dashInputBuffer: true });
  let st = h.state;
  const startX = st.players[0].x;

  // Tick 0: press Shift (dash right)
  pressKey('ShiftLeft', 1010);
  fakeNowMs = 1050;
  let act = h.input.sampleAction(st, 0);
  assert.equal(act.act, 3, 'Tick 0 should start DASH');
  st = stepEngine(act);
  releaseKey('ShiftLeft', 1060);

  let throwTick = -1;
  for (let tick = 1; tick <= 9; tick++) {
    if (tick === 1) {
      // Press LeftClick (THROW) during dash windup (~350ms before dash finishes!)
      clickMouse(0, 1070);
      releaseMouse(0, 1085);
    }
    fakeNowMs = 1050 + tick * 50;
    act = h.input.sampleAction(st, 0);
    st = stepEngine(act);
    if (st.events.some((e) => e.name === 'THROW')) throwTick = tick;
    if (tick < 8) {
      assert.equal(st.players[0].st === 7 || tick === 7, true, `Tick ${tick} must stay in DASH until recovery finishes`);
      assert.equal(throwTick, -1, `THROW must not fire early on tick ${tick}`);
    }
  }
  assert.equal(throwTick, 8, `Pre-input THROW should fire on exact first operable tick 8, got ${throwTick}`);
  assert.equal(st.players[0].x - startX, 3000, 'Dash must complete full 3000mm distance uninterrupted');
  console.log('  [TEST 2 PASS] Pre-input THROW during dash windup: full 3000mm dash + EV_THROW on exact tick 8!');
}

// ---------- TEST 3: Pre-input MELEE (Slash) during dash moving ticks (timer 5) does NOT cancel dash, fires at tick 8 ----------
{
  const h = setupHarness({ dashInputBuffer: true });
  let st = h.state;
  const startX = st.players[0].x;

  pressKey('ShiftLeft', 1010);
  fakeNowMs = 1050;
  st = stepEngine(h.input.sampleAction(st, 0));
  releaseKey('ShiftLeft', 1060);

  let slashTick = -1;
  for (let tick = 1; tick <= 9; tick++) {
    if (tick === 3) {
      assert.equal(st.players[0].st, 7);
      assert.equal(st.players[0].timer, 5, 'Should be in dash moving phase (timer=5)');
      clickMouse(2, 1050 + tick * 50 - 15);
      releaseMouse(2, 1050 + tick * 50 - 5);
    }
    fakeNowMs = 1050 + tick * 50;
    const act = h.input.sampleAction(st, 0);
    st = stepEngine(act);
    if (st.events.some((e) => e.name === 'SLASH')) slashTick = tick;
  }
  assert.equal(slashTick, 8, `Pre-input SLASH should fire on exact first operable tick 8, got ${slashTick}`);
  assert.equal(st.players[0].x - startX, 3000, 'Dash must NOT be interrupted by melee when dashInputBuffer is ON');
  console.log('  [TEST 3 PASS] Pre-input SLASH during dash moving phase: full 3000mm dash + EV_SLASH on exact tick 8!');
}

// ---------- TEST 4: Multiple pre-inputs during dash keep ONLY the LAST one ----------
for (const [label, sequence, expectedEvent, forbiddenEvent] of [
  ['Throw(t2) -> Melee(t4)', [[2, 0], [4, 2]], 'SLASH', 'THROW'],
  ['Melee(t2) -> Throw(t5)', [[2, 2], [5, 0]], 'THROW', 'SLASH'],
  ['Throw(t1) -> Melee(t3) -> Throw(t5) -> Melee(t7)', [[1, 0], [3, 2], [5, 0], [7, 2]], 'SLASH', 'THROW'],
  ['Throw(t3) -> Melee right before tick 8 (t7.8)', [[3, 0], [8, 2]], 'SLASH', 'THROW'],
]) {
  const h = setupHarness({ dashInputBuffer: true });
  let st = h.state;
  const startX = st.players[0].x;

  pressKey('ShiftLeft', 1010);
  fakeNowMs = 1050;
  st = stepEngine(h.input.sampleAction(st, 0));
  releaseKey('ShiftLeft', 1060);

  let gotExpected = -1;
  let gotForbidden = -1;
  for (let tick = 1; tick <= 9; tick++) {
    for (const [atTick, btn] of sequence) {
      if (atTick === tick) {
        const ts = 1050 + tick * 50 - 15;
        clickMouse(btn, ts);
        releaseMouse(btn, ts + 5);
      }
    }
    fakeNowMs = 1050 + tick * 50;
    st = stepEngine(h.input.sampleAction(st, 0));
    if (st.events.some((e) => e.name === expectedEvent)) gotExpected = tick;
    if (st.events.some((e) => e.name === forbiddenEvent)) gotForbidden = tick;
  }
  assert.equal(gotExpected, 8, `${label}: expected ${expectedEvent} on tick 8, got ${gotExpected}`);
  assert.equal(gotForbidden, -1, `${label}: ${forbiddenEvent} must NOT fire`);
  assert.equal(st.players[0].x - startX, 3000, `${label}: full 3000mm dash required`);
}
console.log('  [TEST 4 PASS] Multiple pre-inputs during dash (4 sequences): ONLY the last command fires on tick 8!');

// ---------- TEST 5: Same-tick Dash then Melee (<50ms gap before tick 0) ----------
{
  const h = setupHarness({ dashInputBuffer: true });
  let st = h.state;
  const startX = st.players[0].x;

  pressKey('ShiftLeft', 1010);
  clickMouse(2, 1030); // RightClick 20ms AFTER ShiftLeft, before tick 0 executes!
  releaseKey('ShiftLeft', 1035);
  releaseMouse(2, 1040);

  let dashTick = -1;
  let slashTick = -1;
  for (let tick = 0; tick <= 9; tick++) {
    fakeNowMs = 1050 + tick * 50;
    st = stepEngine(h.input.sampleAction(st, 0));
    if (st.events.some((e) => e.name === 'DASH')) dashTick = tick;
    if (st.events.some((e) => e.name === 'SLASH')) slashTick = tick;
  }
  assert.equal(dashTick, 0, 'Dash pressed first must start on tick 0');
  assert.equal(slashTick, 8, 'Melee pressed 20ms after Dash must fire on exact tick 8');
  assert.equal(st.players[0].x - startX, 3000, 'Full 3000mm dash required');
  console.log('  [TEST 5 PASS] Same-tick Shift + Melee (20ms apart): Dash on tick 0 -> full 3000mm -> EV_SLASH on tick 8!');
}

// ---------- TEST 6: Short exact mouse-target dash (1200mm -> 2 move steps -> ends tick 6) + pre-input Throw ----------
{
  const h = setupHarness({ dashInputBuffer: true, bindDashToMouse: true });
  let st = h.state;
  const startX = st.players[0].x; // 3000
  h.setAimTarget(startX + 1200, 5000); // 1200mm -> 2 move ticks (ticks 2 & 3) + 2 post ticks (4 & 5) -> FREE at tick 6!

  pressKey('KeyQ', 1010);
  fakeNowMs = 1050;
  st = stepEngine(h.input.sampleAction(st, 0));
  releaseKey('KeyQ', 1060);

  let throwTick = -1;
  for (let tick = 1; tick <= 8; tick++) {
    if (tick === 2) {
      clickMouse(0, 1050 + tick * 50 - 15);
      releaseMouse(0, 1050 + tick * 50 - 5);
    }
    fakeNowMs = 1050 + tick * 50;
    st = stepEngine(h.input.sampleAction(st, 0));
    if (st.events.some((e) => e.name === 'THROW')) throwTick = tick;
  }
  assert.equal(st.players[0].x, startX + 1200, 'Exact target dash should land at exact +1200mm');
  assert.equal(throwTick, 6, `Short exact dash finishes at tick 5 -> THROW must fire on exact tick 6, got ${throwTick}`);
  console.log('  [TEST 6 PASS] Short exact-target dash (1200mm): exact landing + pre-input THROW on exact tick 6!');
}

// ---------- TEST 7: Setting OFF restores original dash-cancel melee ("冲刺斩") & no early-dash throw buffer ----------
{
  // 7a: Melee during dash moving phase interrupts dash immediately at tick 3
  const h1 = setupHarness({ dashInputBuffer: false });
  let st = h1.state;
  const startX = st.players[0].x;

  pressKey('ShiftLeft', 1010);
  fakeNowMs = 1050;
  st = stepEngine(h1.input.sampleAction(st, 0));
  releaseKey('ShiftLeft', 1060);

  let slashTick = -1;
  for (let tick = 1; tick <= 9; tick++) {
    if (tick === 3) {
      clickMouse(2, 1050 + tick * 50 - 15);
      releaseMouse(2, 1050 + tick * 50 - 5);
    }
    fakeNowMs = 1050 + tick * 50;
    st = stepEngine(h1.input.sampleAction(st, 0));
    if (st.events.some((e) => e.name === 'SLASH')) slashTick = tick;
  }
  assert.equal(slashTick, 3, `With dashInputBuffer OFF, melee on tick 3 must cancel dash immediately, got ${slashTick}`);
  assert.ok(st.players[0].x - startX < 2500, 'Dash should be cut short when dash-canceled');

  // 7b: Throw pressed early in dash (tick 1) expires and does NOT fire at tick 8
  const h2 = setupHarness({ dashInputBuffer: false });
  st = h2.state;
  pressKey('ShiftLeft', 1010);
  fakeNowMs = 1050;
  st = stepEngine(h2.input.sampleAction(st, 0));
  releaseKey('ShiftLeft', 1060);

  let throwTick = -1;
  for (let tick = 1; tick <= 9; tick++) {
    if (tick === 1) {
      clickMouse(0, 1070);
      releaseMouse(0, 1085);
    }
    fakeNowMs = 1050 + tick * 50;
    st = stepEngine(h2.input.sampleAction(st, 0));
    if (st.events.some((e) => e.name === 'THROW')) throwTick = tick;
  }
  assert.equal(throwTick, -1, 'With dashInputBuffer OFF, early-dash throw must not be pre-buffered to tick 8');
  console.log('  [TEST 7 PASS] dashInputBuffer OFF: original dash-cancel melee (tick 3) & no full-dash throw buffer preserved!');
}

console.log('ALL 7 DASH PRE-INPUT BUFFER TESTS PASSED!');
