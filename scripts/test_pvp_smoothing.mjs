import assert from 'node:assert/strict';
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
const corrected = state(1, 600);
const original = structuredClone(corrected);
smoothing.tick(predicted, corrected, true, 25);
assert.deepEqual(positions(corrected, corrected, 1, 25), [100, 200]);
assert.deepEqual(positions(corrected, corrected, 1, 87.5), [350, 450]);
// Rebase while the earlier correction is still visible, then keep moving.
const again = state(1, 850);
smoothing.tick(corrected, again, true, 87.5);
assert.deepEqual(positions(again, again, 1, 87.5), [350, 450]);
const moving = state(2, 1050, { px: 850 });
smoothing.tick(again, moving, false, 100);
assert.deepEqual(positions(again, moving, 0.5, 150), [700, 800]);
assert.deepEqual(positions(again, moving, 1, 212.5), [1050, 1150]);
assert.deepEqual(corrected, original);

// A positional cut on an advancing tick must bypass even native tick interpolation.
let prev = moving;
for (const next of [
  state(3, 2551), state(4, 2600, { dashing: 1 }),
  state(5, 2650, { alive: 0 }), state(6, 2700),
]) {
  smoothing.tick(prev, next, true, 220);
  assert.deepEqual(positions(prev, next, 0, 220), [next.players[1].x, next.darts[1].x]);
  prev = next;
}
const landed = state(6, 2800, { dartState: 3 });
smoothing.tick(prev, landed, true, 230);
assert.deepEqual(positions(landed, landed, 1, 230), [2700, 2900]);
console.log('PvP render smoothing passed: interpolated origin, repeated moving corrections, 125 ms decay, cuts, local seat and raw state.');
