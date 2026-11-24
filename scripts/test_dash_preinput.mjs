import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import createEngineModule from '../public/wasm/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-preinput-'));
const bundlePath = path.join(tmpDir, 'bundle.mjs');
await esbuild.build({
  stdin: {
    contents: `
      export { HumanInputController } from './src/game/humanInput.ts';
      export { SettingsStore, defaultSettings } from './src/game/settings.ts';
    `,
    resolveDir: rootDir,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  outfile: bundlePath,
});

// Mock browser globals with controllable clock
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
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
Object.defineProperty(globalThis, 'performance', { value: { now: () => fakeNow }, configurable: true });

const mod = await createEngineModule({ print: () => {}, printErr: () => {} });
const { HumanInputController, SettingsStore, defaultSettings } = await import(bundlePath);

function makeMap(rows, spawn = '4 6 14 6') {
  const ny = rows.length;
  const nx = rows[0].length;
  return `NAME test\nMODES 0\nSPAWN 0 ${spawn}\nGRID ${nx} ${ny}\n${rows.join('\n')}\n`;
}

const openRows = Array.from({ length: 24 }, () => '.'.repeat(36));
const wallRightRows = openRows.map((row) => row.slice(0, 12) + '#' + row.slice(13)); // wall at x=6000mm

function setup({ preInput = true, rows = openRows, spawn = '4 6 14 6', bindDashToMouse = false } = {}) {
  winListeners.clear();
  canvasListeners.clear();
  fakeNow = 1000;

  const canvas = {
    addEventListener: (t, fn) => addL(canvasListeners, t, fn),
    removeEventListener: () => {},
  };
  const settings = new SettingsStore();
  settings.setCliffGuard(false);
  settings.setDashGuard(false);
  settings.setMeleeAssist(false);
  settings.setDashInputBuffer(preInput);
  if (bindDashToMouse) settings.setBinding('dashToMouse', 0, 'KeyQ');

  assert.equal(mod.ccall('engine_init', 'number', ['string', 'number', 'number'], [makeMap(rows, spawn), 2, 0]), 1);
  mod.ccall('engine_set_human_seat', 'void', ['number'], [0]);
  mod.ccall('engine_set_human_slash_ticks', 'void', ['number'], [5]);

  const mapData = JSON.parse(mod.ccall('engine_get_map_json', 'string', [], []));
  let state = JSON.parse(mod.ccall('engine_get_state_json', 'string', [], []));

  const input = new HumanInputController(canvas, settings);
  input.setMapData(mapData);
  input.setCliffGuard(false);
  input.setInputMode('active');
  input.hasMouse = true;
  input.aimWorldMmX = state.players[0].x + 4000;
  input.aimWorldMmY = state.players[0].y;

  const setMouse = (wx, wy) => {
    input.hasMouse = true;
    input.aimWorldMmX = wx;
    input.aimWorldMmY = wy;
  };
  const pressKey = (code, nowMs = fakeNow) => {
    fakeNow = nowMs;
    fireL(winListeners, 'keydown', {
      code,
      repeat: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: code.startsWith('Shift'),
      metaKey: false,
      target: {},
      preventDefault: () => {},
    });
  };
  const releaseKey = (code, nowMs = fakeNow) => {
    fakeNow = nowMs;
    fireL(winListeners, 'keyup', { code });
  };
  const clickMouse = (button, nowMs = fakeNow, hold = false) => {
    fakeNow = nowMs;
    fireL(canvasListeners, 'mousedown', { button, clientX: 640, clientY: 400, preventDefault: () => {} });
    if (!hold) {
      fakeNow = nowMs + 5;
      fireL(winListeners, 'mouseup', { button });
    }
  };
  const stepTick = (p1Line = '0 0 0 0 0 0') => {
    fakeNow += 50;
    const act = input.sampleAction(state, 0);
    if (act.dashTargetX !== undefined && act.dashTargetY !== undefined) {
      mod.ccall('engine_set_human_dash_target', 'void', ['number', 'number', 'number'], [1, Math.round(act.dashTargetX), Math.round(act.dashTargetY)]);
    } else {
      mod.ccall('engine_set_human_dash_target', 'void', ['number', 'number', 'number'], [0, 0, 0]);
    }
    const line0 = `${act.mx} ${act.my} ${act.act} ${act.ax} ${act.ay} ${act.msg}`;
    mod.ccall('engine_step', 'number', ['string'], [`${line0}\n${p1Line}`]);
    state = JSON.parse(mod.ccall('engine_get_state_json', 'string', [], []));
    return { act, state };
  };

  return { input, settings, setMouse, pressKey, releaseKey, clickMouse, stepTick, getState: () => state };
}

const ev = (st, name) => st.events.find((e) => e.name === name);

// Test 0: Default enabled
assert.equal(defaultSettings().dashInputBuffer, true);
console.log('  [PASS] Default pre-input setting enabled');

// =====================================================================
// CASE 1: 有镖情况下右键接左键 -> 近战后摇结束后立即扔镖，扔向按左键时鼠标的位置
// =====================================================================
{
  const h = setup();
  const p0 = h.getState().players[0]; // (4000, 6000)
  // Aim right for melee
  h.setMouse(p0.x + 3000, p0.y);
  h.clickMouse(2, fakeNow + 5); // RightClick -> SLASH (8 ticks: 2 pre + 6 post)
  const r0 = h.stepTick();
  assert.ok(ev(r0.state, 'SLASH'), 'Case 1: SLASH starts on tick 0');

  let throwTick = -1;
  let throwEv = null;
  let firstFreeTick = -1;
  const targetX = p0.x;
  const targetY = p0.y - 4000; // UP (-y)

  for (let tick = 1; tick <= 12; tick++) {
    if (tick === 3) {
      // During SLASHED recovery, aim UP and LeftClick!
      h.setMouse(targetX, targetY);
      h.clickMouse(0, fakeNow + 10);
    }
    if (tick === 5) {
      // Move mouse away to DOWN (+y) BEFORE recovery ends — throw MUST still aim UP (where mouse was at LeftClick)!
      h.setMouse(p0.x, p0.y + 4000);
    }
    const { state } = h.stepTick();
    if (firstFreeTick < 0 && state.players[0].st === 0) firstFreeTick = tick;
    const te = ev(state, 'THROW');
    if (te && throwTick < 0) {
      throwTick = tick;
      throwEv = te;
    }
  }
  assert.equal(throwTick, firstFreeTick + 1, `Case 1: THROW must fire on exact first tick after melee recovery (free@${firstFreeTick}, throw@${throwTick})`);
  assert.ok(Math.abs(throwEv.b) < 20 && throwEv.c < -990, `Case 1: THROW must aim at LeftClick mouse pos UP (0, -1000), got (${throwEv.b}, ${throwEv.c})`);

  // Also test sub-50ms fast combo (RightClick then LeftClick before tick 0!)
  const hFast = setup();
  hFast.setMouse(4000 + 3000, 6000);
  hFast.clickMouse(2, 1010);
  hFast.setMouse(4000, 2000); // UP
  hFast.clickMouse(0, 1030);
  hFast.setMouse(4000, 10000); // move mouse away to DOWN
  let fastSlash = -1, fastThrow = -1, fastThrowEv = null;
  for (let t = 0; t <= 12; t++) {
    const { state } = hFast.stepTick();
    if (ev(state, 'SLASH') && fastSlash < 0) fastSlash = t;
    const te = ev(state, 'THROW');
    if (te && fastThrow < 0) { fastThrow = t; fastThrowEv = te; }
  }
  assert.equal(fastSlash, 0, 'Case 1 (fast): SLASH fires first on tick 0');
  assert.equal(fastThrow, 8, 'Case 1 (fast): THROW fires on tick 8 right after 8-tick slash');
  assert.ok(fastThrowEv.c < -990, `Case 1 (fast): THROW aims UP at snapshotted mouse pos, got (${fastThrowEv.b}, ${fastThrowEv.c})`);
  console.log('  [CASE 1 PASS] 有镖右键接左键：近战后摇结束即向按左键时的鼠标位置扔镖（含极速同帧连按）');
}

// =====================================================================
// CASE 2: 有镖情况下冲刺接左键 -> 冲刺结束后立即扔镖，以冲刺后位置为起点、按左键时鼠标位置为终点
// =====================================================================
{
  const h = setup();
  const startX = h.getState().players[0].x; // 4000
  const startY = h.getState().players[0].y; // 6000
  // Dash RIGHT (+3000mm -> ends at x = 7000, y = 6000)
  h.pressKey('KeyD', fakeNow + 5);
  h.pressKey('ShiftLeft', fakeNow + 10);
  h.releaseKey('ShiftLeft', fakeNow + 20);
  const r0 = h.stepTick();
  assert.ok(ev(r0.state, 'DASH'), 'Case 2: DASH starts on tick 0');
  h.releaseKey('KeyD', fakeNow + 5);

  // Target point directly above the POST-DASH position (7000, 3000):
  // From pre-dash (4000, 6000), that point is 45° up-right (+707, -707)!
  // From post-dash (7000, 6000), that point is STRAIGHT UP (0, -1000)!
  const aimTargetX = startX + 3000; // 7000
  const aimTargetY = startY - 3000; // 3000

  let throwTick = -1;
  let throwEv = null;
  for (let tick = 1; tick <= 12; tick++) {
    if (tick === 1) {
      // Press LeftClick during dash windup while still at (4000, 6000)!
      h.setMouse(aimTargetX, aimTargetY);
      h.clickMouse(0, fakeNow + 10);
    }
    if (tick === 5) {
      // Move mouse far LEFT before dash ends
      h.setMouse(1000, 6000);
    }
    const { state } = h.stepTick();
    const te = ev(state, 'THROW');
    if (te && throwTick < 0) {
      throwTick = tick;
      throwEv = te;
    }
  }
  assert.equal(throwTick, 8, `Case 2: THROW fires on exact first tick after 8-tick dash (tick 8), got ${throwTick}`);
  assert.ok(Math.abs(h.getState().players[0].x - (startX + 3000)) < 150, 'Case 2: full 3000mm dash completed');
  // Vector from post-dash (~7000, 6000) to snapshotted mouse (7000, 3000) MUST be straight UP (0, -1000), NOT 45° (+707, -707) and NOT LEFT (-1000, 0)!
  assert.ok(Math.abs(throwEv.b) < 60 && throwEv.c < -990, `Case 2: expected straight UP (0,-1000) from post-dash pos to click target, got (${throwEv.b}, ${throwEv.c})`);
  console.log('  [CASE 2 PASS] 有镖冲刺接左键：冲刺后首帧扔镖，精确以冲刺落点为起点、按左键时鼠标点为终点');
}

// =====================================================================
// CASE 3: 有镖情况下冲刺接左键接右键 -> 右键覆盖左键并立即触发冲刺斩
// =====================================================================
{
  // 3a: Dash tick 0, LeftClick tick 1 (windup), RightClick tick 3 (moving) -> immediate dash-slash on tick 3, NO later throw
  const h = setup();
  const startX = h.getState().players[0].x;
  h.pressKey('KeyD', fakeNow + 5);
  h.pressKey('ShiftLeft', fakeNow + 10);
  h.releaseKey('ShiftLeft', fakeNow + 15);
  h.stepTick();
  h.releaseKey('KeyD', fakeNow + 5);

  let slashTick = -1;
  let throwCount = 0;
  for (let tick = 1; tick <= 18; tick++) {
    if (tick === 1) h.clickMouse(0, fakeNow + 10); // LeftClick during windup
    if (tick === 3) h.clickMouse(2, fakeNow + 10); // RightClick during moving -> overrides LeftClick & triggers dash-slash!
    const { state } = h.stepTick();
    if (ev(state, 'SLASH') && slashTick < 0) slashTick = tick;
    if (ev(state, 'THROW')) throwCount++;
  }
  assert.equal(slashTick, 3, `Case 3a: RightClick must immediately trigger dash-slash on tick 3, got ${slashTick}`);
  assert.equal(throwCount, 0, 'Case 3a: Overwritten LeftClick must NEVER fire after dash-slash');
  assert.ok(h.getState().players[0].x - startX < 2800, 'Case 3a: dash cut short by dash-slash');

  // 3b: Dash tick 0, LeftClick then RightClick BOTH during windup tick 1 -> fires dash-slash on tick 2 (first moving tick!)
  const h2 = setup();
  h2.pressKey('KeyD', fakeNow + 5);
  h2.pressKey('ShiftLeft', fakeNow + 10);
  h2.releaseKey('ShiftLeft', fakeNow + 15);
  h2.stepTick();
  h2.releaseKey('KeyD', fakeNow + 5);
  let slash2 = -1, throw2 = 0;
  for (let tick = 1; tick <= 16; tick++) {
    if (tick === 1) {
      h2.clickMouse(0, fakeNow + 5);
      h2.clickMouse(2, fakeNow + 15);
    }
    const { state } = h2.stepTick();
    if (ev(state, 'SLASH') && slash2 < 0) slash2 = tick;
    if (ev(state, 'THROW')) throw2++;
  }
  assert.equal(slash2, 2, `Case 3b: RightClick overwriting LeftClick in windup triggers dash-slash on first moving tick 2, got ${slash2}`);
  assert.equal(throw2, 0, 'Case 3b: Overwritten LeftClick must NEVER fire');
  console.log('  [CASE 3 PASS] 有镖冲刺接左键接右键：右键覆盖左键并立即触发冲刺斩（移动段&前摇段均验证）');
}

// =====================================================================
// CASE 4: 无镖情况下右键接左键 -> 踢击后因为没有镖左键不成立，丢弃且无动作
// =====================================================================
{
  const h = setup({ rows: wallRightRows });
  // Throw dart into wall at x=6000 so player becomes empty-handed with dart on ground
  h.setMouse(8000, 6000);
  h.clickMouse(0, fakeNow + 5);
  for (let i = 0; i < 15; i++) h.stepTick();
  assert.equal(h.getState().players[0].st, 0, 'Case 4: free after throw');
  assert.equal(h.getState().darts[0].st, 3, 'Case 4: dart on ground (empty-handed)');

  // Now RightClick (KICK) followed by LeftClick (THROW) during kick recovery
  h.clickMouse(2, fakeNow + 5);
  const rKick = h.stepTick();
  assert.ok(ev(rKick.state, 'KICK'), 'Case 4: KICK starts');

  let throwCount = 0;
  let recallCount = 0;
  for (let tick = 1; tick <= 12; tick++) {
    if (tick === 2) {
      h.clickMouse(0, fakeNow + 10); // quick tap LeftClick during kick
    }
    const { state } = h.stepTick();
    if (ev(state, 'THROW')) throwCount++;
    if (ev(state, 'RECALL')) recallCount++;
  }
  assert.equal(throwCount, 0, 'Case 4: no THROW after kick when empty-handed');
  assert.equal(recallCount, 0, 'Case 4: quick LeftClick tap must not start recall');

  // Walk right onto grounded dart at x=6000 -> verify discarded LeftClick does NOT fire later upon pickup!
  h.pressKey('KeyD', fakeNow + 5);
  let pickedUp = false;
  for (let i = 0; i < 15; i++) {
    const { state } = h.stepTick();
    if (state.darts[0].st === 0) pickedUp = true;
    if (ev(state, 'THROW')) throwCount++;
  }
  h.releaseKey('KeyD', fakeNow + 5);
  assert.ok(pickedUp, 'Case 4: later picked up dart');
  assert.equal(throwCount, 0, 'Case 4: discarded pre-input must NOT fire later after picking up dart');
  console.log('  [CASE 4 PASS] 无镖右键接左键：踢击后无镖丢弃且无动作（后续捡镖也不会延迟触发）');
}

// =====================================================================
// CASE 5: 冲刺冷却下右键接冲刺 -> 斩击/踢击后冲刺仍在冷却，丢弃且无动作
// =====================================================================
{
  const h = setup();
  // Spend dash first so cd = 20 -> finishes dash at tick 8 with cd = 12
  h.pressKey('KeyD', fakeNow + 5);
  h.pressKey('ShiftLeft', fakeNow + 10);
  h.releaseKey('ShiftLeft', fakeNow + 15);
  for (let i = 0; i < 8; i++) h.stepTick();
  h.releaseKey('KeyD', fakeNow + 5);
  assert.equal(h.getState().players[0].st, 0, 'Case 5: free after first dash');
  assert.ok(h.getState().players[0].cd >= 10, `Case 5: dash still on CD (${h.getState().players[0].cd})`);

  // Immediately RightClick (SLASH, 8 ticks -> unlocks while cd is still > 0!)
  h.clickMouse(2, fakeNow + 5);
  const rSlash = h.stepTick();
  assert.ok(ev(rSlash.state, 'SLASH'), 'Case 5: SLASH starts');

  let extraDashes = 0;
  for (let tick = 1; tick <= 20; tick++) {
    if (tick === 2) {
      h.pressKey('ShiftLeft', fakeNow + 10);
      h.releaseKey('ShiftLeft', fakeNow + 15);
    }
    const { state } = h.stepTick();
    if (ev(state, 'DASH')) extraDashes++;
  }
  assert.equal(extraDashes, 0, 'Case 5: pre-input DASH invalid on unlock tick must be discarded and NOT fire even after CD reaches 0');
  console.log('  [CASE 5 PASS] 冲刺冷却下右键接冲刺：解锁时仍在冷却，直接丢弃无动作（冷却完毕也不补放）');
}

// =====================================================================
// CASE 6: 无镖状态下冲刺接左键 -> 路径上捡到镖则冲刺结束后向当时鼠标位置扔镖，否则无动作
// =====================================================================
{
  // 6a: Dart on ground at x=6000 (right on dash path from x=4000 -> x=7000!)
  const hPick = setup({ rows: wallRightRows });
  hPick.setMouse(8000, 6000);
  hPick.clickMouse(0, fakeNow + 5);
  for (let i = 0; i < 15; i++) hPick.stepTick();
  assert.equal(hPick.getState().darts[0].st, 3, 'Case 6a: dart on ground at wall');
  const dartX = hPick.getState().darts[0].x;
  assert.ok(dartX > 5000 && dartX < 6200, `Case 6a: dart sits on dash path (x=${dartX})`);

  // Dash RIGHT toward wall/dart (will stop at wall ~5600 and pick up dart along the way!)
  const pBefore = hPick.getState().players[0];
  hPick.pressKey('KeyD', fakeNow + 5);
  hPick.pressKey('ShiftLeft', fakeNow + 10);
  hPick.releaseKey('ShiftLeft', fakeNow + 15);
  const rD = hPick.stepTick();
  assert.ok(ev(rD.state, 'DASH'), 'Case 6a: DASH starts empty-handed');
  hPick.releaseKey('KeyD', fakeNow + 5);

  const aimX = 5600;
  const aimY = 2000; // UP from post-dash pos (~5600, 6000)
  let throwTick = -1;
  let throwEv = null;
  for (let tick = 1; tick <= 12; tick++) {
    if (tick === 1) {
      // Mid-dash (windup), STILL empty-handed (dart.st === 3), press LeftClick aimed UP!
      assert.equal(hPick.getState().darts[0].st, 3, 'Case 6a: still empty-handed when LeftClick pressed');
      hPick.setMouse(aimX, aimY);
      hPick.clickMouse(0, fakeNow + 10);
    }
    if (tick === 5) {
      // Move mouse away to DOWN before dash ends
      hPick.setMouse(5600, 10000);
    }
    const { state } = hPick.stepTick();
    const te = ev(state, 'THROW');
    if (te && throwTick < 0) {
      throwTick = tick;
      throwEv = te;
    }
  }
  assert.equal(throwTick, 8, `Case 6a: after picking up dart during dash, THROW fires on tick 8, got ${throwTick}`);
  assert.ok(Math.abs(throwEv.b) < 120 && throwEv.c < -980, `Case 6a: THROW aimed UP at LeftClick mouse pos, got (${throwEv.b}, ${throwEv.c})`);

  // 6b: Dash LEFT away from grounded dart -> never picks up dart -> NO throw after dash!
  const hMiss = setup({ rows: wallRightRows });
  hMiss.setMouse(8000, 6000);
  hMiss.clickMouse(0, fakeNow + 5);
  for (let i = 0; i < 15; i++) hMiss.stepTick();
  assert.equal(hMiss.getState().darts[0].st, 3);
  hMiss.pressKey('KeyA', fakeNow + 5);
  hMiss.pressKey('ShiftLeft', fakeNow + 10);
  hMiss.releaseKey('ShiftLeft', fakeNow + 15);
  hMiss.stepTick();
  hMiss.releaseKey('KeyA', fakeNow + 5);
  let missThrows = 0;
  for (let tick = 1; tick <= 12; tick++) {
    if (tick === 2) hMiss.clickMouse(0, fakeNow + 10);
    const { state } = hMiss.stepTick();
    if (ev(state, 'THROW')) missThrows++;
  }
  assert.equal(missThrows, 0, 'Case 6b: did not pick up dart during dash -> pre-input THROW discarded');
  console.log('  [CASE 6 PASS] 无镖冲刺接左键：捡到镖则冲刺结束向当时鼠标点扔镖，未捡到则丢弃无动作');
}

// =====================================================================
// CASE 7: 同一次锁动作区间内多次预输入只保留最后一个 + 被踢硬直 S_STUN 预输入
// =====================================================================
{
  const h = setup();
  h.clickMouse(2, fakeNow + 5); // SLASH (8 ticks)
  h.stepTick();
  let dashCount = 0, throwCount = 0, slash2Tick = -1;
  for (let tick = 1; tick <= 12; tick++) {
    if (tick === 2) { h.pressKey('ShiftLeft', fakeNow + 5); h.releaseKey('ShiftLeft', fakeNow + 10); }
    if (tick === 3) h.clickMouse(0, fakeNow + 5);
    if (tick === 4) h.clickMouse(2, fakeNow + 5); // LAST command during slash -> only SLASH should fire!
    const { state } = h.stepTick();
    if (ev(state, 'DASH')) dashCount++;
    if (ev(state, 'THROW')) throwCount++;
    if (ev(state, 'SLASH') && slash2Tick < 0) slash2Tick = tick;
  }
  assert.equal(dashCount, 0, 'Case 7: overwritten DASH must not fire');
  assert.equal(throwCount, 0, 'Case 7: overwritten THROW must not fire');
  assert.equal(slash2Tick, 8, `Case 7: final pre-input SLASH fires on exact tick 8, got ${slash2Tick}`);
  console.log('  [CASE 7 PASS] 同锁动作区间多次预输入只保留最后一条（冲刺→扔镖→斩击，仅释放斩击）');
}

// =====================================================================
// CASE 8: 预输入关闭时，锁动作内长预输入不生效，但冲刺斩仍可用
// =====================================================================
{
  const h1 = setup({ preInput: false });
  h1.clickMouse(2, fakeNow + 5); // SLASH
  h1.stepTick();
  let throwsOff = 0;
  for (let tick = 1; tick <= 12; tick++) {
    if (tick === 2) h1.clickMouse(0, fakeNow + 5);
    const { state } = h1.stepTick();
    if (ev(state, 'THROW')) throwsOff++;
  }
  assert.equal(throwsOff, 0, 'Case 8a: pre-input OFF must not fire throw queued early in slash');

  const h2 = setup({ preInput: false });
  h2.pressKey('KeyD', fakeNow + 5);
  h2.pressKey('ShiftLeft', fakeNow + 10);
  h2.releaseKey('ShiftLeft', fakeNow + 15);
  h2.stepTick();
  h2.releaseKey('KeyD', fakeNow + 5);
  let dashSlashTick = -1;
  for (let tick = 1; tick <= 10; tick++) {
    if (tick === 3) h2.clickMouse(2, fakeNow + 5);
    const { state } = h2.stepTick();
    if (ev(state, 'SLASH') && dashSlashTick < 0) dashSlashTick = tick;
  }
  assert.equal(dashSlashTick, 3, 'Case 8b: pre-input OFF still allows immediate dash-slash in moving phase');
  console.log('  [CASE 8 PASS] 预输入关闭时：不跨硬直缓存，冲刺移动段冲刺斩仍即时生效');
}

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('\nALL UNIFIED PRE-INPUT & DASH-SLASH/KICK TESTS PASSED!');
