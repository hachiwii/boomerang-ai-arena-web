import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import createEngineModule from '../public/wasm/engine.js';

export function mapText(mapId) {
  return readFileSync(new URL(`../public/assets/maps/${mapId}.txt`, import.meta.url), 'utf8');
}

export async function makeEngine({ map = mapText('stonecircle'), seed = 0, spawnSeed = 0, humanSeats = 3, slashTicks = 2 } = {}) {
  const mod = await createEngineModule({ print: () => {}, printErr: () => {} });
  const call = (name, ret, args = []) => mod.cwrap(`engine_${name}`, ret, args);
  const init = call('init_with_spawn_seed', 'number', ['string', 'number', 'number', 'number']);
  assert.equal(init(map, 2, seed, spawnSeed), 1, call('last_error', 'string')());
  call('set_human_seats', null, ['number'])(humanSeats);
  call('set_human_slash_ticks', null, ['number'])(slashTicks);
  call('set_human_cliff_guard', null, ['number'])(1);
  call('set_human_melee_assist', null, ['number'])(1);
  return {
    step: call('step', 'number', ['string']),
    state: call('get_state_json', 'string'),
    events: call('get_events_json', 'string'),
    hash: call('state_hash', 'string'),
    save: call('snapshot_save', 'number', ['number']),
    restore: call('snapshot_restore', 'number', ['number']),
    observe: call('get_obs', 'string', ['number']),
  };
}

export function stepPair(engine, pair) {
  return engine.step(pair.map((action) => action.join(' ')).join('\n'));
}
