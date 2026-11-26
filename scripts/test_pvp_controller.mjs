// Exercise the production controller clock and worker messages with a controllable
// browser timer. The worker adapter uses the same simulation and WASM as the relay test.
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { makeEngine, stepPair } from './pvp_test_engine.mjs';
import { PvpSimulation } from '../src/workers/pvpSimulation.ts';
import { NEUTRAL, PVP_TICK_MS } from '../src/net/pvpProtocol.ts';

const source = new URL('../src/game/pvpMatchController.ts', import.meta.url);
const build = await esbuild.build({
  entryPoints: [fileURLToPath(source)], bundle: true, format: 'esm', write: false,
  define: { __BUILD_ID__: '"test"', 'import.meta.url': JSON.stringify(source.href) },
});
const { PvpMatchController } = await import(`data:text/javascript;base64,${Buffer.from(build.outputFiles[0].contents).toString('base64')}`);
const map = [
  'NAME clock', 'MODES 0', 'SPAWN 0 3.4 6 14.6 6', 'GRID 36 24',
  ...Array.from({ length: 24 }, () => '~' + '.'.repeat(34) + '~'),
].join('\n');
globalThis.fetch = async () => new Response(map);

for (const delay of [0, 1, 2]) {
  const seat = delay % 2;
  const engine = await makeEngine({ map });
  const initial = JSON.parse(engine.state());
  const sim = new PvpSimulation(engine, initial);
  globalThis.Worker = class {
    postMessage({ reqId, type, update, throughT }) {
      const reply = type === 'init' ? { state: initial, mapData: {} } :
        type === 'pvp_update' ? { result: sim.update(update) } : { ticks: sim.recorded(throughT) };
      queueMicrotask(() => this.onmessage({ data: { ...reply, reqId } }));
    }
    terminate() {}
  };
  let time = 0, id = 0;
  const timers = new Map();
  globalThis.window = {
    location: { origin: 'http://localhost' },
    setTimeout: (fn, ms) => { timers.set(++id, { fn, at: time + ms }); return id; },
    clearTimeout: (i) => timers.delete(i),
  };
  async function wake(at) {
    time = at;
    for (let attempts = 0; attempts < 10; attempts++) {
      const due = [...timers].find(([, timer]) => timer.at <= time);
      if (!due) return;
      timers.delete(due[0]);
      due[1].fn();
      await turn();
    }
    assert.fail('clock kept scheduling an immediate wake');
  }

  const stages = [], sent = [], rollbacks = [], hashes = [], results = [];
  let receive, mode, tick, report;
  const go = { type: 'go', delay, startAt: 3000 };
  const controller = new PvpMatchController({
    reset() {}, setMapData() {}, setFixedMatchRules() {}, setTickIntervalMs() {},
    setInputMode: (value) => { mode = value; },
    sampleAction: () => {
      assert.equal(mode, 'active');
      return { mx: 0, my: 0, act: sent.length ? 0 : 2, ax: 1000, ay: 0, msg: 0 };
    },
  }, { mapId: 'clock' }, seat, {
    serverNow: () => time, onMessage: (cb) => { receive = cb; return () => {}; },
    ready: () => receive(go),
    input: (frame, action) => sent.push({ frame, action }),
    hash: (frame, hash) => hashes.push({ frame, hash }),
    setRollbackFrames: (depth) => rollbacks.push(depth), end: (end) => { report = end; },
  }, {
    onMapLoaded() {}, onNotice() {}, onCountdown: (s) => stages.push(s),
    onTick: (_prev, next) => { tick = next; }, onMatchOver: (end) => results.push(end),
    onError: (message) => assert.fail(message),
  });
  await controller.start();
  const rows = (frame, pair) => [[frame, 0, pair[0]], [frame, 1, pair[1]]];
  const idle = [NEUTRAL, NEUTRAL];
  receive({ type: 'inputs', rows: Array.from({ length: delay }, (_, f) => rows(f, idle)).flat() });
  for (const at of [0, 1000, 2000, 2999]) await wake(at);
  assert.deepEqual(stages, [3, 2, 1]);
  assert.equal(mode, 'countdown');
  assert.equal(sent.length, 0);
  assert.equal(tick, undefined);
  for (let f = 0; f <= delay; f++) {
    await wake(go.startAt + f * PVP_TICK_MS);
    assert.equal(sent[f].frame, f + delay);
    assert.equal(tick.t, f + 1);
    assert.equal(tick.events.some((e) => e.name === 'SWING' && e.a === seat), f === delay);
  }
  assert.equal(stages.at(-1), 'GO');
  receive({ type: 'inputs', rows: rows(delay, idle) });
  await wake(time);
  assert.deepEqual(rollbacks, [1]);

  const offline = await makeEngine({ map });
  const history = [JSON.parse(offline.state())];
  const canonical = [];
  const expectedHashes = [];
  for (let f = 0; f < 100; f++) {
    const pair = f < 8 ? idle : [[-1000, 0, f >= 40 ? 3 : 0, -1000, 0, 0], NEUTRAL];
    canonical.push(...rows(f, pair));
    stepPair(offline, pair);
    const state = JSON.parse(offline.state());
    history.push(state);
    if ((f + 1) % 20 === 0) expectedHashes.push({ frame: f, hash: offline.hash() });
    if (f === delay) assert.deepEqual(tick.players, state.players, 'own neutral fill removed the swing');
    if (state.over) break;
  }
  assert.equal(history.at(-1).over, true);
  // The swing the relay filled is re-sent with the next sampled frame (≈ pressed one frame later, not lost).
  await wake(go.startAt + (delay + 1) * PVP_TICK_MS);
  assert.equal(sent.at(-1).frame, delay + 1 + delay);
  assert.equal(sent.at(-1).action[2], 2, 'filled action re-sent on the next frame');
  await wake(go.startAt + (delay + 2) * PVP_TICK_MS);
  assert.equal(sent.at(-1).action[2], 0, 're-sent only once');
  // A rejoin repeats GO and replays canonical inputs. Wake the throttled tab once.
  receive(go);
  receive({ type: 'inputs', rows: canonical });
  const count = sent.length;
  const endFrame = history.at(-1).t - 1;
  await wake(go.startAt + endFrame * PVP_TICK_MS);
  assert.equal(sent.length, count + 1);
  assert.equal(sent.at(-1).frame, endFrame + delay);
  assert.deepEqual(hashes, expectedHashes);
  assert.deepEqual(report, { frame: endFrame, winner: 1, hash: offline.hash() });
  assert.equal(results.length, 0);
  const through = delay === 0 ? endFrame - 1 : endFrame;
  receive(delay === 0 ? { type: 'terminal', reason: 'forfeit', winner: 0, cause: 'quit', through } :
    { type: 'terminal', reason: 'complete', through });
  await wake(time);
  assert.equal(controller.isFinished(), true);
  assert.equal(results.length, 1);
  assert.equal(results[0].t, through + 1);
  assert.equal(results[0].winner, delay === 0 ? 0 : 1);
  assert.deepEqual(controller.getRecordedTicks(), history.slice(0, through + 2));
  controller.stop();
}
console.log('PvP controller passed at delays 0/1/2: countdown, first-frame swing, own neutral fill, resume/catch-up, hashes and exact terminal history.');
