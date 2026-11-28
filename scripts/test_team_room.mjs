// 5v5 联机房间：中转 /team 端点的房间协议，以及「房主跑 bot、其他人按房主的动作重放」的确定性。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import createEngineModule from '../public/wasm/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const require = createRequire(new URL('../server/package.json', import.meta.url));
const WebSocket = require('ws');

// ---------------------------------------------------------------- 1. 中转的房间协议
const child = spawn(process.execPath, [path.join(root, 'server/dist/relay.mjs')], {
  env: { ...process.env, PORT: '0', HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
process.on('exit', () => child.kill());
const port = await new Promise((resolve, reject) => {
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    try {
      const j = JSON.parse(line);
      if (j.event === 'listening') resolve(j.port);
    } catch {}
  });
  child.on('exit', () => reject(new Error('relay exited')));
});
const url = `ws://127.0.0.1:${port}/team`;

class Peer {
  constructor(buildId = 'test-build') {
    this.msgs = [];
    this.waiters = [];
    this.ws = new WebSocket(url);
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      this.msgs.push(m);
      for (const w of [...this.waiters]) if (w.pred(m)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(m);
      }
    });
    this.closed = new Promise((r) => this.ws.on('close', r));
    this.ready = new Promise((r) => this.ws.on('open', r)).then(() => {
      this.send({ type: 'hello', protocol: 1, buildId });
      return this.next((m) => m.type === 'welcome');
    });
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  next(pred, label = 'message', timeout = 3000) {
    const found = this.msgs.find((m) => pred(m) && !m.__seen);
    if (found) { found.__seen = true; return Promise.resolve(found); }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), timeout);
      this.waiters.push({ pred, resolve: (m) => { clearTimeout(t); m.__seen = true; resolve(m); } });
    });
  }
  async none(pred, ms = 250) {
    await new Promise((r) => setTimeout(r, ms));
    assert.ok(!this.msgs.some((m) => pred(m) && !m.__seen), 'unexpected message');
  }
}

const A = new Peer();
await A.ready;
A.send({ type: 'create' });
const roomA = await A.next((m) => m.type === 'room', 'room for A');
assert.match(roomA.room.code, /^\d{6}$/);
assert.equal(roomA.room.members[0].name, 'Alice');
assert.equal(roomA.room.hostId, roomA.me);
const code = roomA.room.code;

const bad = new Peer();
await bad.ready;
bad.send({ type: 'join', code: code === '000000' ? '000001' : '000000' });
assert.equal((await bad.next((m) => m.type === 'error')).reason, 'not_found');
const other = new Peer('other-build');
await other.ready;
other.send({ type: 'join', code });
assert.equal((await other.next((m) => m.type === 'error')).reason, 'version');

const lobby = { mapId: 'piers', speed: 1, sides: [{ slots: [] }, { slots: [] }], note: 'x'.repeat(8000) };
A.send({ type: 'lobby', lobby });
const B = new Peer();
await B.ready;
B.send({ type: 'join', code });
const roomB = await B.next((m) => m.type === 'room');
assert.deepEqual(roomB.room.members.map((m) => m.name), ['Alice', 'Bob']);
assert.deepEqual((await B.next((m) => m.type === 'lobby')).lobby, lobby, 'joiner gets the latest lobby');
const C = new Peer();
await C.ready;
C.send({ type: 'join', code });
const roomC = await C.next((m) => m.type === 'room');
assert.deepEqual(roomC.room.members.map((m) => m.name), ['Alice', 'Bob', 'Carol']);
console.log(`ok - create / join: room ${code}, nicknames Alice Bob Carol, wrong code and other build refused, joiner gets the lobby`);

const lobby2 = { ...lobby, mapId: 'keeps' };
A.send({ type: 'lobby', lobby: lobby2 });
assert.equal((await B.next((m) => m.type === 'lobby' && m.lobby.mapId === 'keeps')).lobby.mapId, 'keeps');
B.send({ type: 'lobby', lobby: { hacked: true } });
await C.none((m) => m.type === 'lobby' && m.lobby.hacked);
B.send({ type: 'claim', side: 1, slot: 3 });
const claim = await A.next((m) => m.type === 'claim');
assert.deepEqual([claim.from, claim.side, claim.slot], [roomB.me, 1, 3]);
B.send({ type: 'unclaim' });
assert.equal((await A.next((m) => m.type === 'unclaim')).from, roomB.me);
console.log('ok - host lobby reaches everyone, guests cannot overwrite it; seat claims / unclaims go to the host');

const start = { matchId: 'm1', mapId: 'piers', seed: 7, spawnSeed: 8, bgmSeed: 9, speed: 1, setup: {}, seats: [null, null, null, null, null, null, null, null, roomB.me, null], names: [] };
A.send({ type: 'start', start });
assert.equal((await B.next((m) => m.type === 'start')).start.matchId, 'm1');
assert.equal((await C.next((m) => m.type === 'start')).start.seed, 7);
for (let t = 0; t < 3; t++) A.send({ type: 'frame', matchId: 'm1', t, acts: `f${t}` });
A.send({ type: 'frame', matchId: 'm1', t: 7, acts: 'out of order' });
const fr = [];
while (fr.length < 3) fr.push(...(await C.next((m) => m.type === 'frames')).acts);
assert.deepEqual(fr, ['f0', 'f1', 'f2']);
const D = new Peer();
await D.ready;
D.send({ type: 'join', code });
assert.equal((await D.next((m) => m.type === 'start')).start.matchId, 'm1');
assert.deepEqual((await D.next((m) => m.type === 'frames')).acts, ['f0', 'f1', 'f2'], 'late joiner catches up from frame 0');
B.send({ type: 'input', matchId: 'm1', action: [100, -200, 1, 300, 400, 0] });
const inp = await A.next((m) => m.type === 'input');
assert.deepEqual([inp.from, inp.action], [roomB.me, [100, -200, 1, 300, 400, 0]]);
B.send({ type: 'input', matchId: 'm1', action: [0, 0, 9, 0, 0, 0] });
await A.none((m) => m.type === 'input');
console.log('ok - start / frames reach everyone in order, a late joiner catches up, inputs go to the host (invalid ones dropped)');

A.send({ type: 'end', matchId: 'm1', aborted: false });
await B.next((m) => m.type === 'end' && !m.aborted);
let rm = await C.next((m) => m.type === 'rematch');
assert.deepEqual([rm.players, rm.want, rm.left, rm.countdownUntil], [[roomB.me], [], [], null]);
B.send({ type: 'rematch', matchId: 'm1', choice: 'want' });
rm = await A.next((m) => m.type === 'rematch' && m.want.length === 1);
assert.deepEqual(rm.want, [roomB.me]);
C.send({ type: 'rematch', matchId: 'm1', choice: 'go' });
await A.none((m) => m.type === 'rematch' && m.countdownUntil !== null);
A.send({ type: 'rematch', matchId: 'm1', choice: 'go' });
rm = await C.next((m) => m.type === 'rematch' && m.countdownUntil !== null);
assert.ok(rm.countdownUntil - rm.serverTime > 2500 && rm.countdownUntil - rm.serverTime <= 3000, 'three-second countdown');
B.send({ type: 'leave' });
await B.next((m) => m.type === 'left');
rm = await A.next((m) => m.type === 'rematch' && m.left.length === 1);
assert.equal(rm.countdownUntil, null, 'a player leaving cancels the countdown');
A.send({ type: 'rematch', matchId: 'm1', choice: 'go' });
await C.none((m) => m.type === 'rematch' && m.countdownUntil !== null);
console.log('ok - rematch: X/Y wants, only the host starts the 3 s countdown, a player leaving cancels it and blocks a rematch');

A.send({ type: 'start', start: { ...start, matchId: 'm2' } });
await C.next((m) => m.type === 'start' && m.start.matchId === 'm2');
A.ws.close();
const ended = await C.next((m) => m.type === 'end' && m.matchId === 'm2');
assert.deepEqual([ended.aborted, ended.reason], [true, 'host_left']);
const roomAfter = await C.next((m) => m.type === 'room' && m.room.hostId !== roomA.me);
assert.equal(roomAfter.room.hostId, roomC.me, 'host passes to the earliest remaining member');
assert.deepEqual(roomAfter.room.members.map((m) => m.name), ['Carol', 'Dave']);
console.log('ok - host leaving ends the running match for everyone and hands the room to the earliest member');

for (const p of [B, C, D, bad, other]) p.ws.close();
child.kill();

// ---------------------------------------------------------------- 2. 其他人按房主的动作重放 = 同一局
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-room-'));
const bundle = path.join(tmp, 'team.mjs');
await esbuild.build({
  stdin: { contents: `export * from './src/game/teamMatch.ts';`, resolveDir: root, loader: 'ts' },
  bundle: true,
  format: 'esm',
  outfile: bundle,
});
const T = await import(pathToFileURL(bundle).href);
const presets = JSON.parse(fs.readFileSync(path.join(root, 'public/assets/team/presets.json'), 'utf8'));
const mapText = (id) => fs.readFileSync(path.join(root, 'public/assets/maps/team', `${id}.txt`), 'utf8');
async function loadBot(id) {
  const f = (await import(pathToFileURL(path.join(root, 'public/wasm/bots', `${id}.js`)).href)).default;
  const m = await f({ print: () => {}, printErr: () => {} });
  return { init: m.cwrap('bot_init', 'number', ['string']), decide: m.cwrap('bot_decide', 'string', ['string']) };
}
async function engine(setup, seed, humanMask) {
  const e = await createEngineModule({ print: () => {}, printErr: () => {} });
  const c = (n, r, a) => e.cwrap(n, r, a);
  assert.equal(c('engine_init_team', 'number', ['string', 'number', 'number', 'string'])(mapText(setup.mapId), setup.mode, seed, T.engineFormText(setup)), 1);
  c('engine_set_human_seats', null, ['number'])(humanMask);
  c('engine_set_human_slash_ticks', null, ['number'])(2);
  c('engine_set_human_cliff_guard', null, ['number'])(1);
  c('engine_set_human_walk_guard', null, ['number'])(1);
  c('engine_set_human_melee_assist', null, ['number'])(1);
  return {
    header: c('engine_get_header', 'string', ['number']),
    obs: c('engine_get_obs', 'string', ['number']),
    step: c('engine_step', 'number', ['string']),
    digest: c('engine_get_digest', 'string', []),
    state: () => JSON.parse(c('engine_get_state_json', 'string', [])()),
  };
}
for (const [mapId, mode, round] of [['caldera', 3, 2], ['piers', 4, 4], ['keeps', 5, 6]]) {
  const rd = presets.find((r) => r.round === round);
  const side = (team, set, humans) => {
    const ids = [...T.TEAM_ROSTER[team]];
    if (mode === 5 && set.king) {
      const ki = ids.findIndex((id) => T.teamBot(id).name === set.king);
      [ids[0], ids[ki]] = [ids[ki], ids[0]];
    }
    const tactics = T.splitPresetPlan(team, set.plan, mode, set.king);
    return {
      slots: ids.map((id, i) => (humans.includes(i) ? { kind: 'human' } : { kind: 'bot', botId: id })),
      tactics: ids.map((id) => tactics[T.teamBot(id).name]),
      spawns: ids.map((id) => set.spawns[T.teamBot(id).name]),
      label: T.TEAM_LABEL[team],
    };
  };
  // 两个真人：左队 2 号、右队 4 号
  const setup = { mapId, mode, sides: [side('astra', rd.teams.astra[0], [2]), side('fable', rd.teams.fable[0], [4])] };
  const humanSeats = [2, 9];
  const mask = humanSeats.reduce((m, s) => m | (1 << s), 0);
  const host = await engine(setup, 4242, mask);
  const guest = await engine(setup, 4242, mask);
  const bots = [];
  for (let k = 0; k < 10; k++) {
    if (humanSeats.includes(k)) { bots.push(null); continue; }
    const b = await loadBot(setup.sides[k < 5 ? 0 : 1].slots[k % 5].botId);
    b.init(host.header(k));
    bots.push(b);
  }
  let rng = 17 + round;
  const rand = () => ((rng = (rng * 1103515245 + 12345) >>> 0) / 4294967296);
  let t = 0;
  for (; t < 1300; t++) {
    const acts = bots.map((b, k) =>
      b ? b.decide(host.obs(k)) : `${Math.round(rand() * 2000 - 1000)} ${Math.round(rand() * 2000 - 1000)} ${Math.floor(rand() * 5)} ${Math.round(rand() * 4000 - 2000)} ${Math.round(rand() * 4000 - 2000)} ${Math.floor(rand() * 3) * 1000}`,
    );
    const frame = acts.join('\n');
    const more = host.step(frame);
    guest.step(frame);
    assert.equal(guest.digest(), host.digest(), `${mapId} diverged at step ${t}`);
    if (!more) break;
  }
  const st = guest.state();
  assert.ok(st.over, `${mapId} finished`);
  console.log(`ok - ${mapId}: a guest replaying the host's ${t + 1} frames (8 bots + 2 humans) matches the host's state digest every step, winner ${st.winner}`);
}
console.log('team room: all checks passed');
