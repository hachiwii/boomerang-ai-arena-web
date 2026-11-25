import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { PvpCorrectionSmoothing } from '../src/render/pvpCorrectionSmoothing.ts';

function state(t, x, { y = 0, px = x, alive = 1, dashing = 0, dartState = 1 } = {}) {
  const local = { x: -x, y };
  const remote = { x, y, px, py: y, alive, dashing };
  return {
    t, over: false, events: [], players: [local, remote],
    darts: [local, { x: x + 100, y, st: dartState }],
  };
}

const start = state(0, 0);
const smoothing = new PvpCorrectionSmoothing(1, start);
function positions(prev, next, alpha, now) {
  const visual = smoothing.draw(prev, next, alpha, now);
  for (const key of ['players', 'darts']) {
    assert.equal(visual.prev[key][0], prev[key][0]);
    assert.equal(visual.next[key][0], next[key][0]);
  }
  return ['players', 'darts'].map((key) => {
    const from = visual.prev[key][1];
    const to = visual.next[key][1];
    return from.x + alpha * (to.x - from.x);
  });
}

const predicted = state(1, 200, { px: 0 });
smoothing.tick(start, predicted, false, 0);
assert.deepEqual(positions(start, predicted, 0.5, 25), [100, 200]);
// A same-tick correction confined to the local seat preserves the remote stride.
const localOnly = { ...predicted, players: [{ x: -100, y: 0 }, predicted.players[1]] };
smoothing.tick(predicted, localOnly, true, 25);
assert.deepEqual(positions(start, localOnly, 0.75, 37.5), [150, 250]);
const corrected = state(1, 600);
const original = structuredClone(corrected);
smoothing.tick(localOnly, corrected, true, 37.5);
assert.deepEqual(positions(corrected, corrected, 1, 37.5), [150, 250]);
assert.deepEqual(positions(corrected, corrected, 1, 100), [375, 475]);
// Rebase while the earlier correction is still visible, then keep moving.
const again = state(1, 850);
smoothing.tick(corrected, again, true, 100);
assert.deepEqual(positions(again, again, 1, 100), [375, 475]);
const moving = state(2, 1050, { px: 850 });
smoothing.tick(again, moving, false, 125);
assert.deepEqual(positions(again, moving, 0.5, 162.5), [712.5, 812.5]);
assert.deepEqual(positions(again, moving, 1, 225), [1050, 1150]);
assert.deepEqual(corrected, original);

// A positional cut on an advancing tick must bypass even native tick interpolation.
let prev = moving;
for (const next of [
  state(3, 2551), state(4, 2600, { dashing: 1 }),
  state(5, 2650, { alive: 0 }), state(6, 2700),
]) {
  smoothing.tick(prev, next, true, 230);
  assert.deepEqual(positions(prev, next, 0, 230), [next.players[1].x, next.darts[1].x]);
  prev = next;
}
const landed = state(6, 2800, { dartState: 3 });
smoothing.tick(prev, landed, true, 230);
assert.deepEqual(positions(landed, landed, 1, 230), [2700, 2900]);
// Exercise pushTick without allocating a WebGL context. Seat 1 is local here.
const build = await esbuild.build({
  entryPoints: [fileURLToPath(new URL('../src/render/renderer.ts', import.meta.url))],
  bundle: true, format: 'esm', write: false,
});
const { GameRenderer } = await import(`data:text/javascript;base64,${Buffer.from(build.outputFiles[0].contents).toString('base64')}`);
const renderer = Object.create(GameRenderer.prototype);
Object.assign(renderer, { humanSeat: 1, currState: start, prevState: start });
renderer.pushTick(start, predicted, 50, false);
const tickStart = renderer.tickReceivedAtMs;
renderer.pushTick(localOnly, localOnly, 50, true);
assert.equal(renderer.tickReceivedAtMs, tickStart);
assert.equal(renderer.prevState, start);
renderer.predErrX = 42;
renderer.pushTick(corrected, corrected, 50, true);
assert.equal(renderer.predErrX, 0, 'a local rollback discards the touch display offset');
assert.equal(renderer.prevState.players[1].x, corrected.players[1].px);
assert.equal(start.players[1].x, 0);
console.log('PvP render smoothing passed: interpolated origin, repeated moving corrections, 125 ms decay, cuts, local seat and raw state.');
