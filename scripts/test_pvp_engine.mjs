import assert from 'node:assert/strict';
import { makeEngine, stepPair } from './pvp_test_engine.mjs';
import { NEUTRAL } from '../src/net/pvpProtocol.ts';
import { PvpSimulation } from '../src/workers/pvpSimulation.ts';
import { PvpEventDedup, PvpTimeline } from '../src/net/pvpTimeline.ts';

const map = [
  'NAME rollback', 'MODES 0', 'SPAWN 0 4 5 8 5', 'GRID 24 20',
  ...Array.from({ length: 20 }, () => '.'.repeat(24)),
  'COLLAPSE', '0'.repeat(24), ...Array.from({ length: 19 }, () => '.'.repeat(24)),
].join('\n');
const engine = await makeEngine({ map, seed: 47, spawnSeed: 239 });
const state = () => JSON.parse(engine.state());
for (let f = 0; f < 234; f++) stepPair(engine, [NEUTRAL, NEUTRAL]);
assert.equal(engine.save(8), 1);
const checkpoint = { hash: engine.hash(), state: state(), a: engine.observe(0), b: engine.observe(1) };
const steps = Array.from({ length: 30 }, (_, f) => [
  [f % 2 ? 140 : -140, 0, f === 5 ? 1 : 0, -1000, 0, 0],
  [0, f % 2 ? 140 : -140, f === 12 ? 2 : 0, 1000, 0, 0],
]);
function run() {
  return steps.map((pair) => {
    stepPair(engine, pair);
    return [engine.hash(), state(), engine.observe(0), engine.observe(1)];
  });
}
const expected = run();
assert.ok(expected.some(([, tick]) => tick.events.some((event) => event.name === 'COLLAPSE')));
assert.ok(expected.some(([, tick]) => tick.events.some((event) => event.name === 'RELEASE')));
for (let repetition = 0; repetition < 3; repetition++) {
  assert.equal(engine.restore(8), 1);
  assert.deepEqual({ hash: engine.hash(), state: state(), a: engine.observe(0), b: engine.observe(1) }, checkpoint);
  for (let f = 0; f < 14; f++) stepPair(engine, [[0, 500, 0, 0, 0, 0], NEUTRAL]);
  assert.notEqual(engine.hash(), expected[13][0]);
  assert.equal(engine.restore(8), 1);
  assert.deepEqual(run(), expected);
}
assert.equal(engine.restore(63), 0);

// The human pre-window emits a swing on the first tick for both seats.
const humans = await makeEngine({ map });
const legacy = await makeEngine({ map, humanSeats: 1 });
const slashes = [[0, 0, 2, 1000, 0, 0], [0, 0, 2, -1000, 0, 0]];
for (const game of [humans, legacy]) stepPair(game, slashes);
assert.deepEqual(JSON.parse(humans.events()).filter((e) => e.name === 'SWING').map((e) => e.a), [0, 1]);
assert.deepEqual(JSON.parse(legacy.events()).filter((e) => e.name === 'SWING').map((e) => e.a), [0]);

// Force a rollback older than the 32-checkpoint ring while confirmation remains
// blocked by a hole. The timeline must reconstruct from the canonical checkpoint.
const rollbackEngine = await makeEngine({ map });
const sim = new PvpSimulation(rollbackEngine, JSON.parse(rollbackEngine.state()));
const timeline = new PvpTimeline(0);
const first = timeline.plan(0, 0, 60);
const predicted = sim.update(first);
timeline.commit(first, predicted.state.t);
timeline.accept([[4, 1, [0, 100, 2, -1000, 0, 0]]]);
const correction = timeline.plan(0, 60, 60);
assert.equal(correction.prediction.from, 0);
assert.equal(correction.rollbackFrames, 56);
const corrected = sim.update(correction);
assert.equal(corrected.state.t, 60);
assert.notDeepEqual(corrected.state.players[1], predicted.state.players[1]);

const dedup = new PvpEventDedup();
const event = { t: 4, type: 2, a: 0, b: 1, c: 2, d: 3 };
assert.equal(dedup.take([event, event]).length, 2);
assert.equal(dedup.take([event]).length, 0);
assert.equal(dedup.take([event, event, event]).length, 1);
console.log(`PvP engine passed: 3 × 30 restored steps, collapse + events + both observations, dual human windows, 56-frame rewind, dedup. Final hash ${expected.at(-1)[0]}`);
