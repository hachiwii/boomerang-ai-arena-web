// PC MOBA control scheme: settings (per-scheme key sets, defaults, migration, reset), and the input layer driving
// the real WASM engine — right-click move with path-finding around walls, exact stop, clicking into a pit, hold to
// follow, S stop, Q / W / E toward the cursor, countdown move, plus a fuzz over the real maps with the engine's
// walk guard OFF (the planner alone must never walk into a pit).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import createEngineModule from '../public/wasm/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-moba-'));
const bundlePath = path.join(tmpDir, 'bundle.mjs');
await esbuild.build({
  stdin: {
    contents: `
      export { HumanInputController } from './src/game/humanInput.ts';
      export * from './src/game/settings.ts';
    `,
    resolveDir: rootDir,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  outfile: bundlePath,
});

let fakeNow = 1000;
const winListeners = new Map();
const canvasListeners = new Map();
const addL = (map, type, fn) => {
  if (!map.has(type)) map.set(type, []);
  map.get(type).push(fn);
};
const fireL = (map, type, ev) => {
  for (const fn of map.get(type) ?? []) fn(ev);
};
globalThis.window = {
  innerWidth: 1280,
  innerHeight: 800,
  addEventListener: (t, fn) => addL(winListeners, t, fn),
  removeEventListener: () => {},
};
globalThis.HTMLInputElement = class {};
globalThis.HTMLTextAreaElement = class {};
const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};
Object.defineProperty(globalThis, 'performance', { value: { now: () => fakeNow }, configurable: true });

const S = await import(bundlePath);
const { HumanInputController, SettingsStore } = S;
const mod = await createEngineModule({ print: () => {}, printErr: () => {} });
const SETTINGS_KEY = 'boomerang_arena_settings_v1';

// ---------------------------------------------------------------- settings
{
  storage.clear();
  const st = new SettingsStore();
  assert.equal(st.get().controlScheme, null, 'new players have not picked a scheme');
  assert.equal(S.activeControlScheme(st.get()), 'standard', 'unset scheme behaves as standard');
  const kb = st.get().keybindings;
  assert.deepEqual(
    [kb.mobaMove, kb.mobaStop, kb.mobaThrowRecall, kb.mobaMelee, kb.mobaDash, kb.mobaQuickRestart, kb.mobaToggleHideUi],
    [['Mouse2', null], ['KeyS', null], ['KeyQ', null], ['KeyW', null], ['KeyE', null], ['KeyR', null], ['Shift+KeyF', null]],
  );
  // Conflicts are resolved inside one scheme only
  assert.equal(st.setBinding('throwRecall', 0, 'KeyQ').clearedFrom, undefined);
  assert.deepEqual(st.get().keybindings.mobaThrowRecall, ['KeyQ', null], 'standard rebinding leaves MOBA keys alone');
  assert.equal(st.setBinding('mobaMelee', 1, 'KeyQ').clearedFrom, 'mobaThrowRecall');
  assert.deepEqual(st.get().keybindings.mobaThrowRecall, [null, null]);
  assert.deepEqual(st.get().keybindings.throwRecall, ['KeyQ', null], 'MOBA rebinding leaves standard keys alone');
  // Reset one scheme
  st.resetKeybindings('moba');
  assert.deepEqual(st.get().keybindings.mobaThrowRecall, ['KeyQ', null]);
  assert.deepEqual(st.get().keybindings.mobaMelee, ['KeyW', null]);
  assert.deepEqual(st.get().keybindings.throwRecall, ['KeyQ', null], 'resetting MOBA keeps the custom standard key');
  // Shortcuts and legends follow the active scheme
  st.setBinding('mobaQuickRestart', 0, 'KeyT');
  assert.deepEqual(S.shortcutBind(st.get(), 'quickRestart'), ['KeyR', null]);
  st.setControlScheme('moba');
  assert.equal(S.shortcutAction(st.get(), 'quickRestart'), 'mobaQuickRestart');
  assert.deepEqual(S.shortcutBind(st.get(), 'quickRestart'), ['KeyT', null]);
  assert.deepEqual(S.controlHintLabels(st.get()), { move: '右键', throwRecall: 'Q', melee: 'W', dash: 'E' });
  // Persisted, and kept by 重置配置
  assert.equal(new SettingsStore().get().controlScheme, 'moba');
  st.resetAll();
  assert.equal(st.get().controlScheme, 'moba', 'reset-all keeps the one-time scheme choice');
  assert.deepEqual(st.get().keybindings.mobaQuickRestart, ['KeyR', null]);
  // A saved config from before this feature: MOBA keys get defaults, the scheme is unset (chooser shows once)
  storage.set(SETTINGS_KEY, JSON.stringify({ soundEnabled: false, keybindings: { throwRecall: ['Mouse0', null], dash: ['Space', null] } }));
  const legacy = new SettingsStore().get();
  assert.equal(legacy.controlScheme, null);
  assert.equal(legacy.soundEnabled, false);
  assert.deepEqual(legacy.keybindings.dash, ['Space', null]);
  assert.deepEqual(legacy.keybindings.mobaDash, ['KeyE', null]);
  console.log('  [PASS] settings: per-scheme keys, conflicts, reset, shortcuts, persistence, migration');
}

// ---------------------------------------------------------------- engine harness
const PIT = '~';
function frame(rows) {
  return rows.map((r, y) => (y === 0 || y === rows.length - 1 ? PIT.repeat(r.length) : PIT + r.slice(1, -1) + PIT));
}
function makeMap(rows, spawn = '4 6 14 6') {
  return `NAME moba\nMODES 0\nSPAWN 0 ${spawn}\nGRID ${rows[0].length} ${rows.length}\n${rows.join('\n')}\n`;
}
const blank = () => Array.from({ length: 24 }, () => '.'.repeat(36));
// A wall column at x = 7.0–7.5 m from the top down to y = 9 m (gap below), and a pit pool around (11.5 m, 3 m)
const arenaRows = frame(
  blank().map((row, y) => {
    let r = row.split('');
    if (y >= 1 && y <= 17) r[14] = '#';
    if (y >= 4 && y <= 8) for (let x = 20; x <= 26; x++) r[x] = PIT;
    return r.join('');
  }),
);

function setup({ map = makeMap(arenaRows), walkGuard = 1, scheme = 'moba', spawnSeed = null } = {}) {
  winListeners.clear();
  canvasListeners.clear();
  fakeNow = 1000;
  storage.clear();
  const canvas = { addEventListener: (t, fn) => addL(canvasListeners, t, fn), removeEventListener: () => {} };
  const settings = new SettingsStore();
  settings.setControlScheme(scheme);
  settings.setMeleeAssist(false);
  if (spawnSeed === null) {
    assert.equal(mod.ccall('engine_init', 'number', ['string', 'number', 'number'], [map, 2, 0]), 1);
  } else {
    assert.equal(
      mod.ccall('engine_init_with_spawn_seed', 'number', ['string', 'number', 'number', 'number'], [map, 2, 0, spawnSeed]),
      1,
    );
  }
  mod.ccall('engine_set_human_seat', 'void', ['number'], [0]);
  mod.ccall('engine_set_human_cliff_guard', 'void', ['number'], [walkGuard]);
  mod.ccall('engine_set_human_walk_guard', 'void', ['number'], [walkGuard]);
  const mapData = JSON.parse(mod.ccall('engine_get_map_json', 'string', [], []));
  let state = JSON.parse(mod.ccall('engine_get_state_json', 'string', [], []));
  const input = new HumanInputController(canvas, settings);
  input.setMapData(mapData);
  input.setInputMode('active');
  let mouse = [0, 0];
  input.setAimProjector(() => mouse);
  input.hasMouse = true;
  const markers = [];
  input.setMoveMarkerListener((x, y) => markers.push([x, y]));
  const setMouse = (x, y) => {
    mouse = [x, y];
    input.hasMouse = true;
    input.aimWorldMmX = x;
    input.aimWorldMmY = y;
  };
  const key = (code, down = true) => {
    fakeNow += 1;
    if (down) {
      fireL(winListeners, 'keydown', {
        code, repeat: false, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, target: {}, preventDefault() {},
      });
    } else fireL(winListeners, 'keyup', { code });
  };
  const mouseBtn = (button, down = true) => {
    fakeNow += 1;
    if (down) fireL(canvasListeners, 'mousedown', { button, clientX: 640, clientY: 400, preventDefault() {} });
    else fireL(winListeners, 'mouseup', { button });
  };
  const rightClick = (x, y) => {
    setMouse(x, y);
    mouseBtn(2, true);
    mouseBtn(2, false);
  };
  const step = () => {
    fakeNow += 50;
    const act = input.sampleAction(state, 0);
    mod.ccall('engine_step', 'number', ['string'], [`${act.mx} ${act.my} ${act.act} ${act.ax} ${act.ay} ${act.msg}\n0 0 0 0 0 0`]);
    state = JSON.parse(mod.ccall('engine_get_state_json', 'string', [], []));
    return { act, state };
  };
  return { input, settings, mapData, setMouse, key, mouseBtn, rightClick, step, markers, me: () => state.players[0], state: () => state };
}
const dist = (p, x, y) => Math.hypot(p.x - x, p.y - y);
const pathLen = (h, maxTicks) => {
  let ticks = 0;
  while (h.input.getMoveTarget() && ticks < maxTicks) {
    h.step();
    ticks++;
    assert.equal(h.me().alive, 1, 'never falls');
  }
  return ticks;
};

// Walk around the wall and stop exactly on the click
{
  const h = setup();
  const me0 = h.me();
  assert.deepEqual([me0.x, me0.y], [4000, 6000]);
  h.rightClick(10000, 6000);
  assert.deepEqual(h.markers, [[10000, 6000]], 'a move command plays the marker at the clicked point');
  let maxY = 0;
  let ticks = 0;
  while (h.input.getMoveTarget() && ticks < 200) {
    h.step();
    ticks++;
    maxY = Math.max(maxY, h.me().y);
    assert.equal(h.me().alive, 1);
  }
  const me = h.me();
  assert.ok(dist(me, 10000, 6000) <= 20, `stops on the click (off by ${dist(me, 10000, 6000).toFixed(1)} mm)`);
  assert.ok(maxY > 9000, `went around the bottom of the wall (max y ${maxY})`);
  assert.ok(ticks < 60, `straight-ish route, ${ticks} ticks`);
  for (let i = 0; i < 5; i++) {
    const { act } = h.step();
    assert.deepEqual([act.mx, act.my], [0, 0], 'stands still after arriving');
  }
  assert.equal(h.me().vx, 0);
  console.log(`  [PASS] path around a wall: arrived in ${ticks} ticks, ${dist(me, 10000, 6000).toFixed(1)} mm from the click`);
}

// Clicking into a pit walks to its edge and stops there (walk guard off: the planner alone keeps the body safe)
{
  const h = setup({ walkGuard: 0 });
  h.rightClick(11750, 3250); // inside the pit pool (x 10–13.5 m, y 2–4.5 m): its north edge is the nearest ground
  const ticks = pathLen(h, 200);
  assert.ok(ticks < 200, 'the order finishes');
  const me = h.me();
  assert.ok(Math.abs(me.x - 11750) <= 30 && me.y < 2000 - 100 && me.y > 1500, `stopped on the pool's north edge (${me.x}, ${me.y})`);
  for (let i = 0; i < 10; i++) h.step();
  assert.equal(h.me().alive, 1);
  console.log(`  [PASS] click into a pit: stopped at (${me.x}, ${me.y}) on the edge`);
}

// Hold right button = follow the cursor; S stops
{
  const h = setup();
  h.setMouse(8000, 12000 - 1500);
  h.mouseBtn(2, true);
  for (let i = 0; i < 6; i++) h.step();
  h.setMouse(2000, 2000);
  for (let i = 0; i < 4; i++) h.step();
  assert.deepEqual(h.input.getMoveTarget(), [2000, 2000], 'held button keeps retargeting to the cursor');
  assert.equal(h.markers.length, 1, 'the marker plays on the press only');
  h.mouseBtn(2, false);
  h.key('KeyS');
  assert.equal(h.input.getMoveTarget(), null);
  const { act } = h.step();
  assert.deepEqual([act.mx, act.my], [0, 0], 'S stops walking');
  console.log('  [PASS] hold-to-follow and S stop');
}

// Q throws toward the cursor and keeps walking; W melees toward the cursor; E dashes toward the cursor and ends the walk
{
  const h = setup();
  h.rightClick(4000, 10000);
  h.step();
  h.setMouse(9000, 6000); // cursor to the right
  h.key('KeyQ');
  const r = h.step();
  assert.equal(r.act.act, 1, 'Q = throw');
  // The body already walked a step down (y ≈ 6250), so the cursor is slightly up-right of it
  assert.ok(r.act.ax > 990 && r.act.ay < 0 && r.act.ay > -80, `throw aims at the cursor (${r.act.ax}, ${r.act.ay})`);
  assert.ok(r.act.my > 0, 'keeps walking toward the target while throwing');
  h.key('KeyQ', false);
  assert.ok(h.input.getMoveTarget(), 'the walk order survives a throw');
  const ticks = pathLen(h, 100);
  assert.ok(dist(h.me(), 4000, 10000) <= 20, `arrives after throwing (${ticks} ticks)`);

  const h2 = setup();
  h2.setMouse(4000, 3000); // cursor above
  h2.key('KeyW');
  const m = h2.step();
  assert.equal(m.act.act, 2, 'W = melee');
  assert.ok(m.act.ay < -990, `melee toward the cursor (${m.act.ax}, ${m.act.ay})`);

  const h3 = setup();
  h3.rightClick(4000, 10000);
  h3.step();
  h3.setMouse(1000, 6000); // cursor to the left
  h3.key('KeyE');
  const d = h3.step();
  assert.equal(d.act.act, 3, 'E = dash');
  assert.ok(d.act.ax < -990, `dash toward the cursor (${d.act.ax}, ${d.act.ay})`);
  assert.equal(h3.input.getMoveTarget(), null, 'a dash ends the walk order');
  // WASD do nothing in MOBA (W is melee): no walking up
  const h4 = setup();
  h4.key('KeyA');
  const a = h4.step();
  assert.deepEqual([a.act.mx, a.act.my, a.act.act], [0, 0, 0], 'A is not a move key in MOBA');
  console.log('  [PASS] Q / W / E toward the cursor; throw keeps the walk, dash ends it; WASD unbound');
}

// Countdown: a move order given before GO is walked right at GO; the standard scheme ignores right-click moves
{
  const h = setup();
  h.input.setInputMode('countdown');
  h.rightClick(8000, 10000);
  assert.deepEqual(h.input.getMoveTarget(), [8000, 10000]);
  h.input.setInputMode('active');
  const { act } = h.step();
  assert.ok(act.mx !== 0 || act.my !== 0, 'walks on the first active tick');

  const s = setup({ scheme: 'standard' });
  s.rightClick(8000, 10000);
  assert.equal(s.input.getMoveTarget(), null, 'standard scheme: right click is melee, not move');
  assert.equal(s.step().act.act, 2);
  console.log('  [PASS] countdown move order; standard scheme unaffected');
}

// Fuzz on the real maps, walk guard OFF: random clicks never make the body fall, and orders always finish
{
  const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'public/assets/maps/manifest.json'), 'utf8'));
  let rng = 12345;
  const rand = () => ((rng = (Math.imul(rng, 1103515245) + 12345) >>> 0) / 4294967296);
  let orders = 0;
  let arrived = 0;
  let totalTicks = 0;
  let cut = 0;
  for (const meta of manifest) {
    const text = fs.readFileSync(path.join(rootDir, `public/assets/maps/${meta.id}.txt`), 'utf8');
    for (let k = 0; k < 12; k++) {
      const h = setup({ map: text, walkGuard: 0, spawnSeed: 1 + k });
      const W = h.mapData.nx * h.mapData.cell;
      const H = h.mapData.ny * h.mapData.cell;
      // Several orders in a row, all before the first collapse wave
      for (let o = 0; o < 3 && h.state().t < h.mapData.colStart - 60; o++) {
        const tx = Math.round(rand() * W);
        const ty = Math.round(rand() * H);
        h.rightClick(tx, ty);
        let ticks = 0;
        while (h.input.getMoveTarget() && ticks < 160 && h.state().t < h.mapData.colStart - 10) {
          h.step();
          ticks++;
          assert.equal(h.me().alive, 1, `${meta.id} seed ${k}: fell walking to (${tx}, ${ty})`);
        }
        orders++;
        totalTicks += ticks;
        if (dist(h.me(), tx, ty) <= 25) arrived++;
        if (h.input.getMoveTarget()) cut++; // still walking when the pre-collapse window ended
        assert.ok(ticks < 160, `${meta.id}: order to (${tx}, ${ty}) did not finish`);
      }
    }
  }
  console.log(`  [PASS] fuzz: ${orders} random orders on ${manifest.length} maps, no falls, ${arrived} exact arrivals (the rest clicked pits / walls / other islands; ${cut} cut off by the collapse window), avg ${(totalTicks / orders).toFixed(1)} ticks`);
}

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('ALL MOBA CONTROL TESTS PASSED');
