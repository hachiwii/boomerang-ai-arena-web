// 分享对局：回放编解码（src/game/replayShare.ts）、清洗、服务器存储（server/shares.ts）和中转服务器的 /share 接口。
// 先 `npm run build --prefix server`。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import * as client from '../src/game/replayShare.ts';
import * as server from '../server/shares.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { decodeReplayDoc, encodeReplayDoc, packReplay, unpackReplay, sanitizeMapData } = client;

// ---------- the two sides agree on the limits ----------
assert.equal(server.SHARE_FORMAT_VERSION, client.SHARE_FORMAT_VERSION);
assert.equal(server.SHARE_MAX_TEXT_BYTES, client.SHARE_MAX_TEXT_BYTES);
assert.equal(server.SHARE_MAX_JSON_BYTES, client.SHARE_MAX_JSON_BYTES);
assert.equal(String(server.SHARE_ID_RE), String(client.SHARE_ID_RE));

// ---------- real matches from the engine + WASM bots ----------
const { default: createEngineModule } = await import(pathToFileURL(join(ROOT, 'public/wasm/engine.js')).href);
const engine = await createEngineModule({ print: () => {}, printErr: () => {} });
const call = (name, ret, args = []) => engine.cwrap(`engine_${name}`, ret, args);
const init = call('init_with_spawn_seed', 'number', ['string', 'number', 'number', 'number']);
const header = call('get_header', 'string', ['number']);
const observe = call('get_obs', 'string', ['number']);
const step = call('step', 'number', ['string']);
const state = call('get_state_json', 'string');
const mapJson = call('get_map_json', 'string');
const mapText = (id) => readFileSync(join(ROOT, `public/assets/maps/${id}.txt`), 'utf8');
const manifest = JSON.parse(readFileSync(join(ROOT, 'public/assets/maps/manifest.json'), 'utf8'));
const roster = JSON.parse(readFileSync(join(ROOT, 'public/assets/chars/roster.json'), 'utf8'));

async function playMatch(mapId, botIds, seed) {
  assert.equal(init(mapText(mapId), botIds.length, seed, seed * 7 + 1), 1, call('last_error', 'string')());
  const bots = [];
  for (let seat = 0; seat < botIds.length; seat++) {
    const { default: create } = await import(pathToFileURL(join(ROOT, `public/wasm/bots/${botIds[seat]}.js`)).href);
    const mod = await create({ print: () => {}, printErr: () => {} });
    mod.cwrap('bot_init', 'number', ['string'])(header(seat));
    bots.push(mod.cwrap('bot_decide', 'string', ['string']));
  }
  const ticks = [{ ...JSON.parse(state()), timestampMs: 1000.25 }];
  let st = ticks[0];
  while (!st.over && ticks.length < 3000) {
    step(bots.map((decide, seat) => (st.players[seat].alive ? decide(observe(seat)) : '0 0 0 0 0 0')).join('\n'));
    st = { ...JSON.parse(state()), timestampMs: 1000.25 + ticks.length * 50.5 };
    ticks.push(st);
  }
  const mapData = JSON.parse(mapJson());
  const meta = manifest.find((m) => m.id === mapId);
  const slots = botIds.map((botId, seat) => {
    const r = roster.find((e) => e.id === botId);
    return seat === 0
      ? { kind: 'human', charKey: 'demo_blue', baseName: '玩家', displayName: '玩家', color: '#3B78F0', avatar: 'data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22x%22%3E%3C%2Fsvg%3E' }
      : { kind: 'bot', botId, charKey: r.charKey, baseName: r.shortName, displayName: r.shortName, color: r.color, avatar: r.avatar };
  });
  const last = ticks[ticks.length - 1];
  const summary = {
    id: `1764300000000-0000${seed % 10}`, playedAt: 1764300000000, matchMode: 'ranked-ffa', mapId, mapTitle: meta.title,
    mapTheme: meta.theme, seed, spawnSeed: seed * 7 + 1, bgmSeed: seed + 3, speed: 1, durationTicks: last.t,
    tickCount: ticks.length, humanSeat: 0, winner: last.winner, earlyExit: false, slots,
    players: slots.map((s, seat) => ({
      seat, kind: s.kind, ...(s.botId ? { botId: s.botId } : {}), displayName: s.displayName, color: s.color, avatar: s.avatar,
      rank: last.players[seat].rank, kills: last.players[seat].kills, alive: last.players[seat].alive === 1,
      cause: last.players[seat].cause, killer: last.players[seat].killer,
    })),
    eloDelta: 12, eloAfter: 1512, eloOldRank: 9, eloNewRank: 8, favorite: true,
  };
  return { summary, replay: { id: summary.id, mapData, ticks } };
}

const withoutClock = (ticks) => ticks.map(({ timestampMs: _t, ...rest }) => rest);

const matches = [
  await playMatch('stonecircle', ['claude-opus-5.5', 'gpt-6.2-sol', 'grok-4.7', 'kimi-k3.1-pro'], 11),
  await playMatch('canyon', ['gemini-4-hydrogen', 'doubao-seed-evolving', 'qwen4-max', 'mimo-v2.6-pro'], 23),
  await playMatch('twinlakes', ['claude-fable-5.2', 'gpt-6.2-astra'], 5),
];
for (const bundle of matches) {
  const doc = encodeReplayDoc(bundle);
  assert.equal(doc.r, undefined, 'engine snapshots use the column format');
  const text = await packReplay(bundle);
  assert.match(text, /^[A-Za-z0-9_-]+$/);
  assert.ok(text.length < 24_000, `${bundle.summary.mapId}: ${text.length} chars`);
  assert.equal(await server.validateShareText(text), null);
  const back = await unpackReplay(text, 'abc123xyz0');
  // Every tick comes back exactly (the local clock is not shared)
  assert.deepEqual(withoutClock(back.replay.ticks), withoutClock(bundle.replay.ticks));
  back.replay.ticks.forEach((t, i) => assert.equal(t.timestampMs, i * 50));
  assert.deepEqual(back.replay.mapData, bundle.replay.mapData);
  const { favorite: _f, id: _id, ...summary } = bundle.summary;
  const { favorite, id, ...got } = back.summary;
  assert.deepEqual(got, summary);
  assert.equal(favorite, false);
  assert.equal(id, 'share-abc123xyz0');
  assert.equal(back.replay.id, id);
}

// Every standard map survives map cleaning unchanged
for (const meta of manifest) {
  assert.equal(init(mapText(meta.id), 2, 1, 1), 1, meta.id);
  const mapData = JSON.parse(mapJson());
  assert.deepEqual(sanitizeMapData(mapData), mapData, meta.id);
}

// ---------- 5v5-style extra fields: fixed-length arrays and optional player fields ----------
{
  const base = matches[0];
  const ticks = base.replay.ticks.map((t, i) => ({
    ...t,
    owner: [-1, i % 2, 1], taking: [-1, -1, i % 3 === 0 ? 0 : -1], prog: [0, i % 5, 0], score: [i, i * 2],
    players: t.players.map((p, seat) => ({ ...p, team: seat % 2, lives: 3, inv: 0, revivals: Math.floor(i / 40) })),
  }));
  const bundle = { ...base, replay: { ...base.replay, ticks } };
  const doc = encodeReplayDoc(bundle);
  assert.equal(doc.r, undefined);
  assert.deepEqual(doc.ta.map(([k]) => k), ['owner', 'taking', 'prog', 'score']);
  const back = await unpackReplay(await packReplay(bundle));
  assert.deepEqual(withoutClock(back.replay.ticks), withoutClock(ticks));
}

// ---------- irregular snapshots fall back to storing the ticks themselves ----------
{
  const base = matches[2];
  const ticks = base.replay.ticks.map((t, i) => (i === 3 ? (({ warn: _w, ...rest }) => rest)(t) : t));
  const bundle = { ...base, replay: { ...base.replay, ticks } };
  const doc = encodeReplayDoc(bundle);
  assert.ok(Array.isArray(doc.r), 'a tick missing a field is stored as is');
  const back = await unpackReplay(await packReplay(bundle));
  assert.deepEqual(withoutClock(back.replay.ticks), withoutClock(ticks));
}

// ---------- someone else's data is cleaned before it reaches the HUD (names go into innerHTML) ----------
{
  const doc = JSON.parse(JSON.stringify(encodeReplayDoc(matches[2])));
  doc.s.slots[1] = {
    ...doc.s.slots[1],
    displayName: '<img src=x onerror="alert(1)">Bob',
    baseName: 'a`b\'c"d&e',
    color: 'red;background:url(//evil)',
    ringAccent: '#12345G',
    avatar: 'javascript:alert(1)',
    charKey: '../../../etc/passwd',
    botId: 'x"><script>',
  };
  doc.s.slots[0].avatar = "data:image/svg+xml;utf8,%3Csvg%20onload%3D'x'()%3E";
  doc.s.mapTitle = '<b>Map</b>';
  doc.s.mapTheme = 'meadow" onload="x';
  doc.s.matchMode = 'hacked';
  doc.s.speed = 1e9;
  doc.s.pvp = { matchId: '<x>', mySeat: 1 };
  doc.m.name = '<svg onload=alert(1)>';
  doc.en[0] = '<script>';
  const back = decodeReplayDoc(doc, 'zzzzzzzzzz');
  const slot = back.summary.slots[1];
  assert.equal(slot.displayName, 'img src=x onerror=alert(1)Bob');
  assert.equal(slot.baseName, 'abcde');
  assert.equal(slot.color, '#8A97B0');
  assert.equal(slot.ringAccent, '#8A97B0');
  assert.equal(slot.avatar, null);
  assert.equal(slot.charKey, 'demo_red');
  assert.equal(slot.botId, undefined);
  assert.equal(back.summary.players[1].displayName, slot.displayName);
  assert.equal(back.summary.slots[0].avatar, 'data:image/svg+xml;utf8,%3Csvg%20onload%3D%27x%27%28%29%3E');
  assert.equal(back.summary.mapTitle, 'bMap/b');
  assert.equal(back.summary.mapTheme, 'meadow');
  assert.equal(back.summary.matchMode, 'custom');
  assert.equal(back.summary.speed, 1);
  assert.equal(back.summary.pvp.matchId, 'pvp');
  assert.equal(back.replay.mapData.name, 'svg onload=alert(1)');
  const names = new Set(back.replay.ticks.flatMap((t) => t.events.map((e) => e.name)));
  assert.ok(!Array.from(names).some((n) => /[<>]/.test(n)), Array.from(names).join());
  assert.ok(names.has('UNKNOWN'));
}

// ---------- malformed documents are rejected ----------
{
  const good = encodeReplayDoc(matches[0]);
  const bad = (mutate, label) => {
    const doc = JSON.parse(JSON.stringify(good));
    mutate(doc);
    assert.throws(() => decodeReplayDoc(doc), /分享数据无效/, label);
  };
  bad((d) => (d.v = 2), 'version');
  bad((d) => (d.n = 0), 'no ticks');
  bad((d) => (d.n += 1), 'column length');
  bad((d) => d.c.pop(), 'missing column');
  bad((d) => d.c.push([0]), 'extra column');
  bad((d) => (d.c[0] = ['99999']), 'zero run past the end');
  bad((d) => (d.c[0][0] = 'x'), 'bad run');
  bad((d) => (d.pk = ['__proto__', ...d.pk.slice(1)]), 'prototype key');
  bad((d) => (d.pk = d.pk.slice(1)), 'columns no longer line up');
  bad((d) => (d.s.slots = []), 'no seats');
  bad((d) => (d.s.slots = Array.from({ length: 17 }, () => d.s.slots[0])), 'too many seats');
  bad((d) => d.s.slots.pop(), 'ticks have more players than seats');
  bad((d) => (d.m.nx = 100000), 'huge map');
  bad((d) => d.m.cells.pop(), 'map cells');
  bad((d) => (d.e[0] = 1e9), 'event past the end');
  bad((d) => d.e.pop(), 'event row length');
  // Gzip bomb / not gzip / not base64url
  const bomb = gzipSync(JSON.stringify({ v: 1, pad: 'a'.repeat(5 * 1024 * 1024) })).toString('base64url');
  await assert.rejects(unpackReplay(bomb), /数据过大/);
  assert.equal(await server.validateShareText(bomb), 'bad-gzip');
  await assert.rejects(unpackReplay('not base64!'), /编码/);
  assert.equal(await server.validateShareText('not base64!'), 'bad-encoding');
  assert.equal(await server.validateShareText(Buffer.from('plain').toString('base64url')), 'bad-gzip');
  assert.equal(await server.validateShareText(gzipSync('{"v":1}').toString('base64url')), 'bad-doc');
  assert.equal(await server.validateShareText(gzipSync('[1,2').toString('base64url')), 'bad-json');
  assert.equal(await server.validateShareText(''), 'empty');
  assert.equal(await server.validateShareText('a'.repeat(server.SHARE_MAX_TEXT_BYTES + 1)), 'too-large');
}

// ---------- server store: content ids, persistence, TTL and the byte cap ----------
const texts = await Promise.all(matches.map((m) => packReplay(m)));
{
  const dir = mkdtempSync(join(tmpdir(), 'boomerang-shares-'));
  try {
    const DAY = 86_400_000;
    const t0 = Date.UTC(2026, 10, 1);
    // The directory appears with the first upload (a relay whose shares dir sits in the stats dir adds nothing there)
    const lazy = new server.ShareStore(join(dir, 'later'), { maxBytes: 1 << 20, ttlMs: DAY });
    assert.deepEqual(await lazy.usage(), { count: 0, bytes: 0 });
    assert.equal(await lazy.prune(), 0);
    assert.equal(existsSync(join(dir, 'later')), false);
    await lazy.put('x'.repeat(10));
    assert.equal(readdirSync(join(dir, 'later')).length, 1);
    rmSync(join(dir, 'later'), { recursive: true });
    // LRU order is exact in memory: a view minutes later (no file write) still saves P and evicts Q
    {
      const lru = new server.ShareStore(join(dir, 'lru'), { maxBytes: 3 * 4096 - 1, ttlMs: DAY });
      const p = await lru.put('p'.repeat(100), t0);
      const q = await lru.put('q'.repeat(100), t0 + 1000);
      assert.equal(await lru.get(p.id, t0 + 2000), 'p'.repeat(100));
      await lru.put('r'.repeat(100), t0 + 3000);
      assert.equal(await lru.get(q.id, t0 + 4000), null);
      assert.equal(await lru.get(p.id, t0 + 4000), 'p'.repeat(100));
      rmSync(join(dir, 'lru'), { recursive: true });
    }
    const [A, B, C] = ['a'.repeat(1000), 'b'.repeat(1000), 'c'.repeat(500)];
    // Sizes count whole 4 KiB disk blocks: three shares of one block each, cap just under three blocks
    assert.equal(server.shareDiskBytes(1), 4096);
    assert.equal(server.shareDiskBytes(4097), 8192);
    const store = new server.ShareStore(dir, { maxBytes: 3 * 4096 - 1, ttlMs: 10 * DAY });
    const a = await store.put(A, t0);
    assert.deepEqual(a, { id: server.shareIdFor(A), created: true });
    assert.match(a.id, server.SHARE_ID_RE);
    assert.deepEqual(await store.put(A, t0 + 1), { id: a.id, created: false }, 'same text, same id');
    const b = await store.put(B, t0 + DAY);
    assert.equal(await store.get(a.id, t0 + 2 * DAY), A);
    assert.equal(await store.get('zzzzzzzzzz', t0), null);
    assert.equal(await store.get('../etc/pwd', t0), null);
    // Over the cap: the least recently used share goes (a was viewed after b was stored, so b goes)
    const c = await store.put(C, t0 + 3 * DAY);
    assert.equal(await store.get(b.id, t0 + 3 * DAY), null);
    assert.equal(await store.get(a.id, t0 + 3 * DAY), A);
    assert.ok(existsSync(join(dir, `${c.id}.txt`)));
    // A fresh process finds what is on disk; unused past the TTL is pruned
    const reopened = new server.ShareStore(dir, { maxBytes: 1 << 30, ttlMs: 10 * DAY });
    assert.deepEqual(await reopened.usage(), { count: 2, bytes: 2 * 4096 });
    const old = new Date(t0 - 20 * DAY);
    utimesSync(join(dir, `${c.id}.txt`), old, old);
    const pruner = new server.ShareStore(dir, { maxBytes: 1 << 30, ttlMs: 10 * DAY });
    assert.equal(await pruner.prune(t0 + 4 * DAY), 1);
    assert.deepEqual(readdirSync(dir), [`${a.id}.txt`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log('Replay share codec and store passed: exact round trips, 5v5 fields, raw fallback, cleaning, rejects, LRU + TTL.');

// ---------- the relay's /share endpoints ----------
const originKey = 'share-integration-test-key';
const dir = mkdtempSync(join(tmpdir(), 'boomerang-relay-shares-'));
const relays = [];
async function startRelay() {
  const child = spawn(process.execPath, [join(ROOT, 'server/dist/relay.mjs')], {
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', PVP_ORIGIN_KEY: originKey, PVP_SHARES_DIR: dir, PVP_STATS_DIR: '', STATE_DIRECTORY: '' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  relays.push(child);
  const logs = [];
  createInterface({ input: child.stdout }).on('line', (line) => logs.push(JSON.parse(line)));
  const stop = Date.now() + 5000;
  while (!logs.some((l) => l.event === 'listening') || !logs.some((l) => l.event === 'shares-ready')) {
    assert.ok(Date.now() < stop, 'relay did not start');
    assert.equal(child.exitCode, null, 'relay exited');
    await sleep(10);
  }
  const { port } = logs.find((l) => l.event === 'listening');
  return { child, logs, base: `http://127.0.0.1:${port}` };
}
try {
  let { child, logs, base } = await startRelay();
  const headers = (ip) => ({ 'x-pvp-origin-key': originKey, 'x-forwarded-for': ip, 'content-type': 'text/plain;charset=UTF-8' });
  const upload = (text, ip = '203.0.113.1') => fetch(`${base}/share`, { method: 'POST', headers: headers(ip), body: text });
  const download = (id, ip = '203.0.113.1') => fetch(`${base}/share/${id}`, { headers: headers(ip) });

  // Origin key required (the CDN adds it)
  assert.equal((await fetch(`${base}/share/${'a'.repeat(10)}`)).status, 403);
  assert.equal((await fetch(`${base}/share`, { method: 'POST', body: texts[0] })).status, 403);

  const res = await upload(texts[0]);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const { id } = await res.json();
  assert.equal(id, server.shareIdFor(texts[0]));
  assert.ok(logs.some((l) => l.event === 'share' && l.id === id && l.created === true));
  assert.ok(!JSON.stringify(logs).includes('203.0.113.1'), 'no IPs in the log');
  assert.deepEqual(await (await upload(texts[0])).json(), { id }, 'same match, same link');

  const got = await download(id);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('access-control-allow-origin'), '*');
  assert.match(got.headers.get('cache-control'), /public, max-age=86400/);
  const back = await unpackReplay(await got.text(), id);
  assert.deepEqual(withoutClock(back.replay.ticks), withoutClock(matches[0].replay.ticks));
  assert.equal((await download('zzzzzzzzzz')).status, 404);
  assert.equal((await download('BAD')).status, 404);
  assert.equal((await fetch(`${base}/share`, { headers: headers('203.0.113.1') })).status, 405);
  const pre = await fetch(`${base}/share`, { method: 'OPTIONS', headers: headers('203.0.113.1') });
  assert.equal(pre.status, 204);

  // Rejects
  const reject = async (body, status, error, ip) => {
    const r = await upload(body, ip);
    assert.equal(r.status, status, error);
    assert.deepEqual(await r.json(), { error });
  };
  await reject('not base64!', 400, 'bad-encoding', '203.0.113.2');
  await reject(gzipSync('{"v":1}').toString('base64url'), 400, 'bad-doc', '203.0.113.2');
  await reject('a'.repeat(server.SHARE_MAX_TEXT_BYTES + 10), 413, 'too-large', '203.0.113.2');

  // 6 uploads a minute per IP
  for (let i = 0; i < 6; i++) assert.equal((await upload(texts[1], '203.0.113.9')).status, 200, `upload ${i}`);
  await reject(texts[1], 429, 'rate-limited', '203.0.113.9');
  assert.equal((await upload(texts[2], '203.0.113.10')).status, 200, 'other IPs unaffected');

  // Shares survive a relay restart
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
  ({ child, logs, base } = await startRelay());
  const ready = logs.find((l) => l.event === 'shares-ready');
  assert.equal(ready.count, 3);
  assert.equal(await (await download(id)).text(), texts[0]);
  console.log('Relay /share passed: origin key, upload + same id, download + CORS/cache headers, rejects, per-IP limit, restart.');
} finally {
  for (const r of relays) if (r.exitCode === null) r.kill('SIGTERM');
  rmSync(dir, { recursive: true, force: true });
}
