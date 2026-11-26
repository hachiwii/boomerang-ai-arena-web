// Site analytics on the relay: online count, daily UV, visitors / matches per mode, persistence across restarts and
// day changes, and the /beat /event endpoints (CORS, origin key, validation, rate limit, no IPs on disk).
// Run after `npm run build --prefix server`.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ONLINE_WINDOW_MS, SiteAnalytics, dayOf, formatVisitors, readDays } from '../server/analytics.ts';

const id = (n) => n.toString(16).padStart(32, '0');
const T0 = Date.parse('2026-11-26T04:00:00Z'); // 12:00 UTC+8

// ---------- unit ----------
{
  const dir = mkdtempSync(join(tmpdir(), 'site-analytics-'));
  const a = new SiteAnalytics(dir, 90, T0);
  for (const n of [1, 2, 3]) a.heartbeat(id(n), T0);
  assert.equal(a.onlineCount(T0), 3);
  a.leave(id(3));
  assert.equal(a.onlineCount(T0), 2);
  assert.equal(a.onlineCount(T0 + ONLINE_WINDOW_MS + 1), 0, 'silent visitors drop out of the online count');

  a.matchStarted(id(1), 'ranked-solo', T0);
  a.matchStarted(id(1), 'ranked-solo', T0);
  a.matchStarted(id(2), 'ranked-solo', T0);
  a.matchFinished(id(1), 'ranked-solo', T0);
  a.matchStarted(id(1), 'pvp', T0); // both PvP clients send this: marks visitors only
  a.matchStarted(id(2), 'pvp', T0);
  a.pvpMatchStarted(T0); // the relay counts the match once
  a.pvpMatchFinished(T0);
  a.matchStarted(id(4), 'replay', T0);
  await a.tick(T0);
  const snap = a.snapshot(T0);
  assert.equal(snap.uv, 4);
  assert.deepEqual(snap.modes['ranked-solo'], { visitors: 2, started: 3, finished: 1 });
  assert.deepEqual(snap.modes.pvp, { visitors: 2, started: 1, finished: 1 });
  assert.deepEqual(snap.modes.replay, { visitors: 1, started: 1, finished: 0 });

  // Restart: today's state comes back from disk
  const b = new SiteAnalytics(dir, 90, T0 + 60_000);
  await b.load(T0 + 60_000);
  b.heartbeat(id(1), T0 + 60_000); // already counted today
  assert.equal(b.snapshot(T0 + 60_000).uv, 4);
  assert.deepEqual(b.snapshot(T0 + 60_000).modes['ranked-solo'], { visitors: 2, started: 3, finished: 1 });

  // Next day (UTC+8): a new UV set; the previous day's file stays
  const next = T0 + 86_400_000;
  b.heartbeat(id(9), next);
  await b.tick(next);
  assert.equal(b.snapshot(next).uv, 1);
  assert.deepEqual(readdirSync(dir).sort(), [`${dayOf(T0)}.json`, `${dayOf(next)}.json`]);
  const days = await readDays(dir, 2, next);
  assert.deepEqual(days.map((d) => d.uv), [4, 1]);
  assert.equal('ids' in days[0], false, 'reports never include visitor ids');
  const text = formatVisitors(days);
  assert.match(text, /UV/);
  assert.match(text, /排位 SOLO/);
  assert.match(text, /PvP/);

  // Prune files older than keepDays
  writeFileSync(join(dir, '2025-01-01.json'), '{}');
  await b.prune(next);
  assert.equal(existsSync(join(dir, '2025-01-01.json')), false);
  rmSync(dir, { recursive: true, force: true });
}

// ---------- integration: the relay endpoints ----------
const statsDir = mkdtempSync(join(tmpdir(), 'site-analytics-relay-'));
const analyticsDir = join(statsDir, 'analytics');
const originKey = 'analytics-test-key';
const relayPath = fileURLToPath(new URL('../server/dist/relay.mjs', import.meta.url));
let child;
const logs = [];
async function startRelay() {
  logs.length = 0;
  child = spawn(process.execPath, [relayPath], {
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', PVP_ORIGIN_KEY: originKey, PVP_STATS_DIR: statsDir, PVP_ANALYTICS_TICK_MS: '150' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  createInterface({ input: child.stdout }).on('line', (line) => logs.push(JSON.parse(line)));
  for (let i = 0; i < 300; i++) {
    const l = logs.find((x) => x.event === 'listening');
    if (l) return `http://127.0.0.1:${l.port}`;
    await sleep(10);
  }
  throw new Error('relay did not start');
}
process.on('exit', () => child?.kill());
let base = await startRelay();
const post = (path, body, { key = true, ip = '114.114.114.114', raw } = {}) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'ali-cdn-real-ip': ip, ...(key ? { 'x-pvp-origin-key': originKey } : {}) },
  body: raw ?? JSON.stringify(body),
});

let res = await post('/beat', { id: id(1) });
assert.equal(res.status, 204);
assert.equal(res.headers.get('access-control-allow-origin'), '*');
assert.equal((await post('/beat', { id: id(1) }, { key: false })).status, 403, 'direct origin access needs the CDN key');
assert.equal((await post('/beat', { id: 'not-hex' })).status, 400);
assert.equal((await post('/beat', null, { raw: '{oops' })).status, 400);
res = await fetch(`${base}/beat`, { method: 'OPTIONS', headers: { 'x-pvp-origin-key': originKey } });
assert.equal(res.status, 204);
await post('/beat', { id: id(2) }, { ip: '240e:4c:4008::1' });
await post('/event', { id: id(1), kind: 'start', mode: 'cricket' });
await post('/event', { id: id(1), kind: 'end', mode: 'cricket' });
await post('/event', { id: id(2), kind: 'start', mode: 'pvp' });
await post('/event', { id: id(2), kind: 'end', mode: 'pvp' }); // ignored: the relay counts PvP matches
await post('/event', { id: id(2), kind: 'start', mode: 'not-a-mode' });
await sleep(400); // a couple of analytics ticks

const stats = await (await fetch(`${base}/stats?days=1`)).json();
assert.equal(stats.onlineNow, 2);
assert.equal(stats.visitorsToday, 2);
const files = readdirSync(analyticsDir);
assert.equal(files.length, 1);
const onDisk = readFileSync(join(analyticsDir, files[0]), 'utf8');
for (const secret of ['114.114.114.114', '240e:4c']) assert.equal(onDisk.includes(secret), false, `analytics file leaks ${secret}`);
const snap = JSON.parse(onDisk);
assert.deepEqual(snap.modes.cricket, { visitors: 1, started: 1, finished: 1 });
assert.deepEqual(snap.modes.pvp, { visitors: 1, started: 0, finished: 0 });
assert.equal(snap.peakOnline, 2);

// Rate limit: 120 requests per IP per minute
let limited = 0;
for (let i = 0; i < 125; i++) if ((await post('/beat', { id: id(3) }, { ip: '8.8.8.8' })).status === 429) limited++;
assert.ok(limited >= 4, `rate limited ${limited}`);

// Report CLI (after a couple of analytics ticks so the 3rd visitor is on disk)
await sleep(400);
const report = execFileSync(process.execPath, [fileURLToPath(new URL('../server/dist/stats-report.mjs', import.meta.url)), '--days', '1'], {
  env: { ...process.env, PVP_STATS_DIR: statsDir }, encoding: 'utf8',
});
assert.match(report, /visitors \(UTC\+8\) · online now 3/);
assert.match(report, /斗蛐蛐 +1 visitors +1 started +1 finished/);

// Restart: today's UV survives (SIGTERM flushes)
child.kill('SIGTERM');
await new Promise((r) => child.once('exit', r));
base = await startRelay();
await sleep(100);
const after = await (await fetch(`${base}/stats?days=1`)).json();
assert.equal(after.visitorsToday, 3);
assert.equal(after.onlineNow, 0, 'online is live state, not restored');

child.kill();
rmSync(statsDir, { recursive: true, force: true });
console.log('Site analytics passed: online / leave / timeout, daily UV, per-mode visitors and matches (PvP counted once), restart + day roll, CORS + origin key + validation + rate limit, no IPs on disk, report');
process.exit(0);
