// PvP relay latency stats: unit checks of server/stats.ts and one real relay match (fills, late inputs, RTT samples,
// region / client derivation, the daily JSONL file, the loopback /stats endpoint and the report CLI). Run after
// `npm run build --prefix server`.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  RegionResolver, StatsStore, addRttSample, classifyClient, formatReport, newSeatStats, provinceKey, seatRecord, summarize,
} from '../server/stats.ts';

// ---------- unit: client classes ----------
const UA = {
  wechat: 'Mozilla/5.0 (Linux; Android 16; V2509A Build/X; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/156 Mobile Safari/537.36 XWEB/1560023 MicroMessenger/8.0.60',
  qq: 'Mozilla/5.0 (Linux; Android 16; SM-S9370; wv) AppleWebKit/537.36 Chrome/121 MQQBrowser/6.2 TBS/047941 Mobile Safari/537.36 V1_AND_SQ_9.3.85 QQ/9.3.85.43200',
  harmony: 'Mozilla/5.0 (Tablet; OpenHarmony 6.1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 ArkWeb/6.1.0.121',
  ios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.1 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0 Mobile Safari/537.36',
  desktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36 Edg/158.0.0.0',
};
for (const [kind, ua] of Object.entries(UA)) assert.equal(classifyClient(ua), kind, kind);
assert.equal(classifyClient(undefined), 'other');
assert.equal(classifyClient('curl/8.0'), 'other');

// ---------- unit: regions (bundled ip2region, IPv4 + IPv6) ----------
const regions = new RegionResolver();
await regions.open();
assert.deepEqual(regions.lookup('114.114.114.114'), { country: 'CN', province: '江苏' });
assert.deepEqual(regions.lookup('::ffff:114.114.114.114'), { country: 'CN', province: '江苏' });
assert.deepEqual(regions.lookup('240e:4c:4008::1'), { country: 'CN', province: '北京', isp: '电信' });
assert.deepEqual(regions.lookup('2409:8000::1'), { country: 'CN', province: '北京', isp: '移动' });
assert.deepEqual(regions.lookup('8.8.8.8'), { country: 'US' });
for (const bad of ['10.0.0.1', '::1', '?', '', 'not-an-ip', '1.2.3']) assert.deepEqual(regions.lookup(bad), { country: 'unknown' }, bad);
assert.equal(provinceKey({ country: 'CN', province: '北京', isp: '电信' }), 'CN-北京-电信');
assert.equal(provinceKey({ country: 'US' }), 'US');

// ---------- unit: seat summary ----------
const seat = newSeatStats('desktop', { country: 'US' });
for (const v of [40, 42, 38, 41, 300, 39, 40]) addRttSample(seat, v);
addRttSample(seat, 0); // ignored
addRttSample(seat, 99_999); // ignored
const rec = seatRecord(seat);
assert.equal(rec.samples, 7);
assert.equal(rec.rttMedian, 40);
assert.equal(rec.rttMax, 300);
assert.equal(rec.rttP95, 300);
assert.ok(rec.jitter > 0);
assert.equal('rtt' in rec, false);

// ---------- integration: a real relay match ----------
const statsDir = mkdtempSync(join(tmpdir(), 'pvp-stats-'));
const require = createRequire(new URL('../server/package.json', import.meta.url));
const WebSocket = require('ws');
const originKey = 'stats-test-key';
const relayPath = fileURLToPath(new URL('../server/dist/relay.mjs', import.meta.url));
const child = spawn(process.execPath, [relayPath], {
  env: { ...process.env, PORT: '0', HOST: '127.0.0.1', PVP_ORIGIN_KEY: originKey, PVP_STATS_DIR: statsDir },
  stdio: ['ignore', 'pipe', 'inherit'],
});
process.on('exit', () => child.kill());
const logs = [];
createInterface({ input: child.stdout }).on('line', (line) => logs.push(JSON.parse(line)));
const deadline = (ms) => Date.now() + ms;
async function until(fn, ms = 5000, what = 'condition') {
  const end = deadline(ms);
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const listening = await until(() => logs.find((l) => l.event === 'listening'), 5000, 'relay');
const ready = await until(() => logs.find((l) => l.event === 'stats-ready'), 10000, 'stats-ready');
assert.equal(ready.regions, true);
const base = `127.0.0.1:${listening.port}`;

class Client {
  constructor(ip, ua) {
    this.inbox = [];
    this.ws = new WebSocket(`ws://${base}/ws`, { headers: { 'x-pvp-origin-key': originKey, 'ali-cdn-real-ip': ip, 'user-agent': ua } });
    this.ws.on('message', (raw) => this.inbox.push(JSON.parse(raw.toString())));
    this.opened = new Promise((resolve) => this.ws.once('open', resolve));
  }
  send(msg) { this.ws.send(JSON.stringify(msg)); }
  take(type, ms) { return until(() => this.inbox.find((m) => m.type === type), ms, type); }
}

const a = new Client('114.114.114.114', UA.wechat);
const b = new Client('240e:4c:4008::1', UA.desktop);
await Promise.all([a.opened, b.opened]);
for (const c of [a, b]) c.send({ type: 'hello', protocol: 3, buildId: 'stats-test', token: null });
await Promise.all([a.take('welcome'), b.take('welcome')]);
const bCode = (await b.take('welcome')).code;
b.send({ type: 'presence', present: true });
a.send({ type: 'presence', present: true });
await sleep(50);
a.send({ type: 'challenge', request: 1, code: bCode });
const [startA] = await Promise.all([a.take('matchStart'), b.take('matchStart')]);
const matchId = startA.info.matchId;
for (const c of [a, b]) c.send({ type: 'ready', matchId });
const go = await a.take('go');
assert.equal(go.delay, 0, 'loopback RTT picks zero input delay');
await sleep(Math.max(0, go.startAt - Date.now()) + 5);

// A plays every frame on time and reports 30 ms; B stays silent (connected) for ~0.5 s and reports 70 ms.
const frameNow = () => Math.floor((Date.now() - go.startAt) / 50);
const action = [1000, 0, 0, 0, 0, 0];
let sentA = -1;
const end = deadline(1500);
let lateSent = false;
while (Date.now() < end) {
  const f = frameNow();
  for (let x = sentA + 1; x <= f; x++) a.send({ type: 'input', matchId, frame: x, action });
  sentA = Math.max(sentA, f);
  if (f % 4 === 0) {
    a.send({ type: 'ping', t: Date.now(), rttMs: 30 });
    b.send({ type: 'ping', t: Date.now(), rttMs: 70 });
  }
  if (!lateSent && f >= 14) {
    b.send({ type: 'input', matchId, frame: 2, action }); // frame 2 was filled long ago → dropped late
    lateSent = true;
  }
  if (f >= 12) {
    for (let x = f; x <= f + 1; x++) b.send({ type: 'input', matchId, frame: x, action });
  }
  await sleep(25);
}
a.send({ type: 'quit', matchId });
const stats = await until(() => logs.find((l) => l.event === 'match-stats'), 5000, 'match-stats log');
await sleep(200);

const files = readdirSync(statsDir);
assert.equal(files.length, 1);
assert.match(files[0], /^\d{4}-\d{2}-\d{2}\.jsonl$/);
const raw = readFileSync(join(statsDir, files[0]), 'utf8');
for (const secret of ['114.114.114.114', '240e:4c', 'MicroMessenger', 'Mozilla', 'Edg/']) {
  assert.equal(raw.includes(secret), false, `stats file leaks ${secret}`);
  assert.equal(JSON.stringify(stats).includes(secret), false, `log leaks ${secret}`);
}
const lines = raw.trim().split('\n').map((l) => JSON.parse(l));
assert.equal(lines.length, 1);
const m = lines[0];
assert.equal(m.matchId, matchId);
assert.equal(m.reason, 'forfeit');
assert.equal(m.cause, 'quit');
assert.equal(m.delay, 0);
assert.equal(m.rematch, false);
assert.ok(m.frames > 20, `frames ${m.frames}`);
const [sa, sb] = m.seats;
assert.equal(sa.client, 'wechat');
assert.equal(sb.client, 'desktop');
assert.deepEqual(sa.region, { country: 'CN', province: '江苏' });
assert.deepEqual(sb.region, { country: 'CN', province: '北京', isp: '电信' });
assert.equal(sa.rttMedian, 30);
assert.equal(sb.rttMedian, 70);
assert.ok(sa.samples > 3 && sb.samples > 3);
assert.ok(sa.fills <= 2, `A fills ${sa.fills}`);
assert.ok(sb.fills >= 5, `B fills ${sb.fills}`);
assert.equal(sb.lateDropped, 1);
assert.equal(sa.lateDropped, 0);
assert.equal(sa.reconnects + sb.reconnects, 0);

// Loopback /stats and the report CLI
const res = await fetch(`http://${base}/stats?days=1`);
assert.equal(res.status, 200);
const summary = await res.json();
assert.equal(summary.matches, 1);
assert.equal(summary.byProvince.some((g) => g.key === 'CN-北京-电信'), true);
const report = execFileSync(process.execPath, [fileURLToPath(new URL('../server/dist/stats-report.mjs', import.meta.url)), '--days', '1'], {
  env: { ...process.env, PVP_STATS_DIR: statsDir }, encoding: 'utf8',
});
assert.match(report, /1 matches \(1 played past GO\)/);
assert.match(report, /CN-江苏/);
assert.match(report, /wechat/);

// Store: append / read / prune across days
const store = new StatsStore(join(statsDir, 'store'), 90);
const old = { ...m, matchId: 'old', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:00:00.000Z' };
await store.append(old);
await store.append(m);
assert.equal((await store.read(400)).length, 2);
await store.prune();
assert.deepEqual((await store.read(400)).map((r) => r.matchId), [m.matchId]);
const text = formatReport(summarize([m], 1));
assert.match(text, /by client/);

for (const c of [a, b]) c.ws.terminate();
child.kill();
rmSync(statsDir, { recursive: true, force: true });
console.log(`PvP stats passed: client classes, IPv4/IPv6 regions, match record (B fills ${sb.fills}, late 1, rtt 30/70), loopback /stats, report CLI, prune`);
process.exit(0);
