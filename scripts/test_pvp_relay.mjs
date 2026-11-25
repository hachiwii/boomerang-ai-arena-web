import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { makeEngine, stepPair } from './pvp_test_engine.mjs';
import { PvpSimulation } from '../src/workers/pvpSimulation.ts';
import { PvpTimeline } from '../src/net/pvpTimeline.ts';
import { NEUTRAL, PVP_TICK_MS } from '../src/net/pvpProtocol.ts';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const WebSocket = require('ws');
const originKey = 'relay-integration-test-key';
const headers = { 'x-pvp-origin-key': originKey };
const child = spawn(process.execPath, [fileURLToPath(new URL('../server/dist/relay.mjs', import.meta.url))], {
  env: { ...process.env, PORT: '0', HOST: '127.0.0.1', PVP_ORIGIN_KEY: originKey, PVP_REMATCH_TIMEOUT_MS: '2300' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
const lines = createInterface({ input: child.stdout });
const logs = [];
lines.on('line', (line) => logs.push(JSON.parse(line)));
const peers = [];
let url;
let request = 0;

// Keep the cliff regression independent of the relay's randomized spawns.
const edgeMap = [
  'NAME relay-cliff', 'MODES 0', 'SPAWN 0 3.4 6 14.6 6', 'GRID 36 24',
  ...Array.from({ length: 24 }, () => '~' + '.'.repeat(34) + '~'),
].join('\n');
const makeMatchEngine = (info) => makeEngine({ ...info, map: edgeMap });
const manifest = JSON.parse(readFileSync(new URL('../public/assets/maps/manifest.json', import.meta.url), 'utf8'));

async function until(find, label, timeout = 5000) {
  const stop = Date.now() + timeout;
  while (Date.now() < stop) {
    assert.equal(child.exitCode, null, 'relay exited');
    for (const peer of peers) if (peer.error) throw peer.error;
    const value = find();
    if (value) return value;
    await sleep(10);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

class Peer {
  socket = null;
  welcome = null;
  play = null;
  messages = [];
  pending = [];
  timers = new Set();
  sentAt = 0;
  arrivedAt = 0;
  requestLog = [];
  pausedUntil = 0;
  noise = 91021;

  constructor({ ip, rtt, clockSkew = 0, build = 'integration' }) {
    Object.assign(this, { ip, rtt, clockSkew, build });
    peers.push(this);
    this.timer = setInterval(() => {
      try { this.tick(); } catch (error) { this.error = error; }
    }, 8);
  }

  later(fn, wait) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, Math.max(0, wait));
    this.timers.add(timer);
  }

  random() {
    this.noise = (Math.imul(this.noise, 1664525) + 1013904223) >>> 0;
    return this.noise / 0xffffffff;
  }

  connect() {
    const socket = this.socket = new WebSocket(url, {
      headers: { ...headers, 'ali-cdn-real-ip': this.ip, 'x-forwarded-for': '198.51.100.1' },
    });
    socket.once('open', () => {
      this.send({
        type: 'hello', token: this.welcome?.token ?? null, buildId: this.build, matchId: this.play?.info.matchId ?? this.resumeMatchId,
      });
    });
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      const at = Math.max(this.arrivedAt + 1, Date.now() + this.rtt / 2 + Math.round(this.random() * 38));
      this.arrivedAt = at;
      this.later(() => {
        if (this.socket === socket) this.pending.push(message);
      }, at - Date.now());
    });
    socket.on('error', (error) => { this.error = error; });
  }

  cut() {
    const socket = this.socket;
    this.socket = null;
    socket?.terminate();
  }

  close() {
    this.cut();
    clearInterval(this.timer);
    for (const timer of this.timers) clearTimeout(timer);
  }

  send(message, afterMs = 0) {
    const socket = this.socket;
    const deliver = () => {
      if (this.socket === socket && socket?.readyState === WebSocket.OPEN) {
        this.requestLog.push(message);
        socket.send(JSON.stringify(message));
      }
    };
    if (afterMs) {
      this.later(deliver, afterMs);
      return;
    }
    const at = Math.max(this.sentAt + 1, Date.now() + this.rtt / 2 + Math.round(this.random() * 38));
    this.sentAt = at;
    this.later(deliver, at - Date.now());
  }

  request(type, extra) {
    const id = ++request;
    this.send({ type, request: id, ...extra });
    return until(() => this.messages.find((msg) => msg.request === id), type);
  }

  async readyPlay(info) {
    const engine = await makeMatchEngine(info);
    this.play = {
      info, go: null, terminal: null, timeline: new PvpTimeline(info.mySeat), log: [], hashes: new Map(),
      sim: new PvpSimulation(engine, JSON.parse(engine.state())), confirmedT: 0, predictedT: 0,
      sampled: -1, targetT: 0, changed: false, rollbacks: 0, maxRollback: 0, maxBatch: 0, end: null,
    };
    this.send({ type: 'ready', matchId: info.matchId });
  }

  receive(message) {
    this.messages.push(message);
    if (message.type === 'welcome') this.welcome = message;
    if (!this.play || message.matchId !== this.play.info.matchId) return;
    const play = this.play;
    if (message.type === 'go') {
      if (play.go) assert.deepEqual(message, play.go, 'resume must keep the same start and delay');
      play.go = message;
    } else if (message.type === 'terminal') {
      play.terminal = message;
    } else if (message.type === 'inputs') {
      for (const [frame, seat, action] of message.rows) {
        const row = play.log[frame] ?? (play.log[frame] = []);
        if (row[seat]) assert.deepEqual(action, row[seat], 'canonical rows must be immutable');
        row[seat] = action;
      }
      play.timeline.accept(message.rows);
      play.changed = true;
    }
  }

  tick() {
    const time = Date.now();
    if (time < this.pausedUntil) return;
    for (const message of this.pending.splice(0)) this.receive(message);
    const play = this.play;
    if (!play?.go || play.end) return;
    const { matchId, mySeat } = play.info;
    const frame = Math.floor((time + this.clockSkew - play.go.startAt) / PVP_TICK_MS);
    if (frame < 0) return;

    if (mySeat === 0 && frame >= 44 && !play.stalled) {
      play.stalled = true;
      this.pausedUntil = time + 2000;
      return;
    }
    if (mySeat === 1 && frame >= 70 && !play.stalled) {
      play.stalled = true;
      this.pausedUntil = time + 1300;
      return;
    }
    if (mySeat === 1 && frame >= 104 && !play.reconnected) {
      play.reconnected = true;
      this.cut();
      this.later(() => this.connect(), 720);
    }

    if (frame > play.sampled) {
      play.sampled = frame;
      const future = frame + play.go.delay;
      const a = (Math.imul(future + 7, 16777619) ^ (mySeat * 1225971)) >>> 0;
      const b = (Math.imul(a ^ (a >>> 13), 2246822507) >>> 0) % 4096;
      let input = [b % 25 - 12, (b >>> 5) % 25 - 12, b % 16 < 4 ? b % 4 + 1 : 0, mySeat ? 1000 : -1000, 0, 0];
      if (input[2] === 3) input[2] = 4;
      // Both players hold outward near their spawn cliffs through the stalls.
      // P1 eventually dashes off deliberately to produce a confirmed end.
      if (frame < 112) input = [mySeat ? 1000 : -1000, 0, ...input.slice(2)];
      if (frame < 36) input[2] = 0;
      if (frame >= 150) input = mySeat ? NEUTRAL : [-1000, 0, frame >= 175 ? 3 : 0, -1000, 0, 0];
      const late = mySeat === 0 && future === 28;
      if (late) {
        input = [0, 900, 2, 0, -1000, 23];
        play.late = input;
      }
      play.timeline.sample(future, input);
      this.send({ type: 'input', matchId, frame: future, action: input }, late ? 430 : 0);
    }
    const targetT = frame + 1;
    if (targetT === play.targetT && !play.changed) return;
    play.targetT = targetT;
    play.changed = false;
    const update = play.timeline.plan(play.confirmedT, play.predictedT, targetT);
    if (update.rollbackFrames) {
      play.rollbacks++;
      play.maxRollback = Math.max(play.maxRollback, update.rollbackFrames);
    }
    const result = play.sim.update(update);
    play.maxBatch = Math.max(play.maxBatch, result.predictedEvents.length, result.confirmedEvents.length);
    play.timeline.commit(update, result.state.t);
    play.confirmedT = result.confirmedT;
    play.predictedT = result.state.t;
    for (const { frame: f, hash } of result.hashes) {
      play.hashes.set(f, hash);
      this.send({ type: 'hash', matchId, frame: f, hash });
    }
    if (result.end) {
      play.end = result.end;
      this.send({ type: 'end', matchId, ...play.end });
    }
  }
}

async function startMatch(a, b, runSimulation = true) {
  const nA = a.messages.length;
  const nB = b.messages.length;
  a.send({ type: 'presence', present: true });
  b.send({ type: 'presence', present: true });
  await until(() => a.messages.slice(nA).some((m) => m.type === 'code') &&
    b.messages.slice(nB).some((m) => m.type === 'code'), 'both presences');
  assert.deepEqual((await a.request('challenge', { code: b.welcome.code })).result, { ok: true });
  const getInfo = (peer, start) => until(() =>
    peer.messages.slice(start).find((m) => m.type === 'matchStart')?.info, 'matchStart');
  const [aInfo, bInfo] = await Promise.all([getInfo(a, nA), getInfo(b, nB)]);
  assert.equal(aInfo.mySeat, 0);
  assert.equal(bInfo.mySeat, 1);
  assert.equal(aInfo.matchId, bInfo.matchId);
  assert.equal(aInfo.mapId, bInfo.mapId);
  for (const field of ['seed', 'spawnSeed', 'bgmSeed']) {
    assert.ok(Number.isSafeInteger(aInfo[field]) && aInfo[field] >= 0 && aInfo[field] <= 0xffffffff);
    assert.equal(aInfo[field], bInfo[field]);
  }
  if (runSimulation) await Promise.all([a.readyPlay(aInfo), b.readyPlay(bInfo)]);
  return aInfo.matchId;
}

try {
  const { port } = await until(() => logs.find((line) => line.event === 'listening'), 'relay listen');
  const http = `http://127.0.0.1:${port}`;
  url = `ws://127.0.0.1:${port}/ws`;
  assert.equal(await (await fetch(`${http}/healthz`)).text(), 'ok\n');
  assert.equal((await fetch(`${http}/other`)).status, 403);
  assert.equal((await fetch(`${http}/other`, { headers })).status, 404);
  const wrong = new WebSocket(url, { headers: { 'x-pvp-origin-key': 'wrong' } });
  assert.equal(await new Promise((resolve) => {
    wrong.on('unexpected-response', (_req, response) => { response.resume(); resolve(response.statusCode); });
  }), 403);

  const a = new Peer({ ip: '192.0.2.1', rtt: 96, clockSkew: 6 });
  const b = new Peer({ ip: '192.0.2.2', rtt: 212, clockSkew: -7, build: 'old-build' });
  a.connect();
  b.connect();
  await until(() => a.welcome && b.welcome, 'both welcomes');
  assert.match(a.welcome.code, /^\d{6}$/);
  const oldCode = b.welcome.code;
  const next = await b.request('resetCode');
  assert.notEqual(next.code, oldCode);
  b.welcome.code = next.code;
  a.send({ type: 'presence', present: true });
  a.send({ type: 'ping', t: 1, rttMs: a.rtt });
  b.send({ type: 'ping', t: 1, rttMs: b.rtt });
  const ask = (code) => a.request('challenge', { code });
  assert.deepEqual((await ask(oldCode)).result, { ok: false, reason: 'not_found' });
  assert.deepEqual((await ask(next.code)).result, { ok: false, reason: 'offline' });
  b.send({ type: 'presence', present: true });
  await until(() => b.messages.filter((m) => m.type === 'code').length >= 2, 'B presence');
  assert.deepEqual((await ask(next.code)).result, { ok: false, reason: 'version' });
  const token = b.welcome.token;
  b.cut();
  b.build = 'integration';
  b.welcome = { ...b.welcome, code: '' };
  b.connect();
  await until(() => b.welcome.code === next.code, 'token reclaim');
  assert.equal(b.welcome.token, token);
  b.send({ type: 'ping', t: 2, rttMs: b.rtt });
  a.send({ type: 'mapPool', ids: ['twinlakes'] });
  b.send({ type: 'mapPool', ids: ['invalid-map', 'stonecircle', 'stonecircle'] });

  const matchId = await startMatch(a, b);
  assert.equal(a.play.info.mapId, 'stonecircle');
  await until(() => a.play.end && b.play.end && a.play.terminal && b.play.terminal, 'confirmed finish', 20_000);
  assert.equal(a.play.terminal.reason, 'complete');
  assert.equal(a.play.go.delay, 4);
  assert.equal(a.play.go.startAt, b.play.go.startAt);
  assert.deepEqual(a.play.end, b.play.end);
  assert.deepEqual(a.play.hashes, b.play.hashes);
  const end = a.play.end;
  assert.equal(end.winner, 1);
  const canonical = a.play.log.slice(0, end.frame + 1);
  assert.deepEqual(canonical, b.play.log.slice(0, end.frame + 1));
  assert.ok(a.play.late);
  assert.ok(a.requestLog.some((m) => m.type === 'input' && m.action === a.play.late), 'late input was transmitted');
  assert.notDeepEqual(canonical[28][0], a.play.late);
  assert.equal(canonical[27][0][0], -1000);
  assert.deepEqual(canonical[28][0], NEUTRAL);
  assert.deepEqual(canonical[55][0], NEUTRAL);
  assert.ok(!a.requestLog.some((m) => m.type === 'input' && m.frame === 55));
  assert.ok(a.play.rollbacks > 0 && b.play.rollbacks > 0);
  assert.ok(a.play.maxBatch >= 35 && b.play.maxBatch >= 20);
  assert.deepEqual(a.messages.filter((m) => m.type === 'peer').map((m) => m.connected), [false, true]);
  assert.equal(b.messages.filter((m) => m.type === 'matchStart' && m.info.matchId === matchId).length, 2);

  const offline = await makeMatchEngine(a.play.info);
  const offlineTicks = [JSON.parse(offline.state())];
  for (const [frame, pair] of canonical.entries()) {
    assert.ok(pair[0] && pair[1]);
    stepPair(offline, pair);
    offlineTicks.push(JSON.parse(offline.state()));
    if ((frame + 1) % 20 === 0) assert.equal(a.play.hashes.get(frame), offline.hash());
  }
  assert.equal(offline.hash(), end.hash);
  assert.deepEqual(offlineTicks[40].players.map((p) => [p.alive, p.x]), [[1, 500], [1, 17500]]);
  assert.ok(offlineTicks.slice(0, -1).every((tick) => tick.players.every((p) => p.alive)));
  assert.ok(offlineTicks.slice(-10).some((tick) => tick.events.some((e) => e.name === 'DASH' && e.a === 0)));
  assert.deepEqual(a.play.sim.recorded(end.frame + 1), offlineTicks);
  assert.deepEqual(b.play.sim.recorded(end.frame + 1), offlineTicks);
  assert.ok(!logs.some(({ event }) => event === 'desync' || event === 'end-desync'));
  console.log(`PvP relay convergence: ${end.frame + 1} canonical ticks, 3 equal hashes ${end.hash}, delay ${a.play.go.delay}, ` +
    `${a.play.hashes.size} periodic hashes, rollback counts ${a.play.rollbacks}/${b.play.rollbacks}, ` +
    `largest rollback ${a.play.maxRollback}/${b.play.maxRollback}, catch-up batches ${a.play.maxBatch}/${b.play.maxBatch}`);

  const getRematch = (peer, id, me, opponent) => peer.messages.find((m) =>
    m.type === 'rematch' && m.matchId === id && m.me === me && m.opponent === opponent);
  const choose = (peer, matchId, choice) => peer.send({ type: 'rematch', matchId, choice });
  await until(() => getRematch(a, matchId, 'undecided', 'undecided') &&
    getRematch(b, matchId, 'undecided', 'undecided'), 'both result-screen choices');
  choose(a, matchId, 'rematch');
  await until(() => getRematch(b, matchId, 'undecided', 'rematch'), 'peer rematch request');
  b.send({ type: 'mapPool', ids: ['forest', 'missing'] });
  choose(b, matchId, 'rematch');
  const getRound = (peer) => peer.messages.find((m) => m.type === 'matchStart' && m.info.rematchOf === matchId)?.info;
  const [roundA, roundB] = await until(() => getRound(a) && getRound(b) && [getRound(a), getRound(b)], 'new round on both sockets');
  assert.equal(roundA.mapId, 'forest');
  assert.equal(roundA.mySeat, 0);
  assert.equal(roundB.mySeat, 1);
  assert.notEqual(roundA.matchId, matchId);
  assert.deepEqual(roundA, { ...roundB, mySeat: 0, challenger: true });
  assert.notDeepEqual([roundA.seed, roundA.spawnSeed, roundA.bgmSeed], [a.play.info.seed, a.play.info.spawnSeed, a.play.info.bgmSeed]);

  const c = new Peer({ ip: '192.0.2.3', rtt: 10 });
  const d = new Peer({ ip: '192.0.2.4', rtt: 10 });
  c.connect();
  d.connect();
  await until(() => c.welcome && d.welcome, 'forfeit welcomes');
  const getTerminal = (p, id) => p.messages.find((m) => m.type === 'terminal' && m.matchId === id);
  d.send({ type: 'mapPool', ids: ['not-on-manifest', 'canyon'] });
  const quitId = await startMatch(c, d, false);
  assert.equal(c.messages.find((m) => m.type === 'matchStart' && m.info.matchId === quitId).info.mapId, 'canyon');
  c.send({ type: 'quit', matchId: quitId });
  const quit = await until(() => getTerminal(d, quitId), 'quit forfeit');
  assert.deepEqual(quit, { type: 'terminal', matchId: quitId, reason: 'forfeit', cause: 'quit', winner: 1, through: -1 });
  await until(() => getRematch(d, quitId, 'undecided', 'undecided'), 'quit result choices');
  choose(c, quitId, 'left');
  await until(() => getRematch(d, quitId, 'undecided', 'left'), 'opponent left the result');
  choose(d, quitId, 'left');
  await until(() => getRematch(d, quitId, 'left', 'left'), 'both players left');

  // An empty pool restores all standard and large maps.
  d.send({ type: 'mapPool', ids: [] });
  const waitingId = await startMatch(c, d, false);
  const waitingInfo = d.messages.find((m) => m.type === 'matchStart' && m.info.matchId === waitingId).info;
  assert.ok(manifest.some((map) => map.id === waitingInfo.mapId));
  c.send({ type: 'quit', matchId: waitingId });
  await until(() => getRematch(c, waitingId, 'undecided', 'undecided'), 'postgame before waiting timeout');
  choose(c, waitingId, 'rematch');
  await until(() => getRematch(c, waitingId, 'rematch', 'left') &&
    getRematch(d, waitingId, 'left', 'rematch'), 'undecided player timed out');
  choose(c, waitingId, 'left');
  await until(() => getRematch(c, waitingId, 'left', 'left'), 'waiting player exited');

  const goneId = await startMatch(c, d, false);
  const disconnectedAt = Date.now();
  d.resumeMatchId = goneId;
  d.cut();
  const gone = await until(() => getTerminal(c, goneId), 'disconnect forfeit', 13_000);
  assert.deepEqual(gone, { type: 'terminal', matchId: goneId, reason: 'forfeit', cause: 'disconnect', winner: 0, through: -1 });
  const forfeitMs = Date.now() - disconnectedAt;
  assert.ok(forfeitMs >= 10_000);
  await until(() => getRematch(c, goneId, 'undecided', 'left'), 'disconnected player left postgame');
  d.connect();
  assert.deepEqual(await until(() => getTerminal(d, goneId), 'forfeit replay after reconnect'), gone);
  await until(() => getRematch(d, goneId, 'left', 'undecided'), 'postgame choices replayed to disconnected player');
  choose(c, goneId, 'left');
  await until(() => getRematch(c, goneId, 'left', 'left'), 'connected player exited after a forfeit');

  const dropAtResultId = await startMatch(c, d, false);
  c.send({ type: 'quit', matchId: dropAtResultId });
  await until(() => getRematch(d, dropAtResultId, 'undecided', 'undecided'), 'postgame before socket close');
  d.cut();
  await until(() => getRematch(c, dropAtResultId, 'undecided', 'left'), 'postgame socket close');
  console.log(`PvP relay lobby/origin checks and quit/disconnect forfeits passed; disconnect forfeit after ${forfeitMs} ms`);
  console.log('PvP map pool and rematch passed: challenged pools, large maps, fresh seeds and same seats, explicit exit, disconnect, and 2300 ms undecided timeout.');
} finally {
  for (const peer of peers) peer.close();
  lines.close();
  child.kill();
}
