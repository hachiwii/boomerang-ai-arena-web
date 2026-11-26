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
import esbuild from 'esbuild';
import { ONLINE_WINDOW_MS, SiteAnalytics, dayOf, formatBots, formatVisitors, parseBotResults, readDays } from '../server/analytics.ts';

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
  assert.deepEqual(readdirSync(dir).filter((n) => /^\d{4}-/.test(n)).sort(), [`${dayOf(T0)}.json`, `${dayOf(next)}.json`]);
  const days = await readDays(dir, 2, next);
  assert.deepEqual(days.map((d) => d.uv), [4, 1]);
  assert.equal('ids' in days[0], false, 'reports never include visitor ids');
  const text = formatVisitors(days);
  assert.match(text, /UV/);
  assert.match(text, /排位 SOLO/);
  assert.match(text, /PvP/);

  // Prune: junk files go; real days older than keepDays are compacted (see the public stats test)
  writeFileSync(join(dir, '2025-01-01.json'), '{}');
  await b.prune(next);
  assert.equal(existsSync(join(dir, '2025-01-01.json')), false);
  rmSync(dir, { recursive: true, force: true });
}

// ---------- unit: ranked bot results ----------
{
  // Validation: one bot in SOLO, up to three in 四人, kills only by causes with a killer and at most one per opponent,
  // known death causes, a winner never died, at most one winner, a win is not a draw
  assert.deepEqual(parseBotResults('ranked-solo', [{ b: 'glm-5.3', r: 'w', kills: { dart: 1 } }]), [{ b: 'glm-5.3', r: 'w', kills: { dart: 1 } }]);
  assert.deepEqual(parseBotResults('ranked-solo', [{ b: 'glm-5.3', r: 'd', death: 'collapse' }]), [{ b: 'glm-5.3', r: 'd', death: 'collapse' }]);
  assert.deepEqual(parseBotResults('ranked-ffa', [{ b: 'a', r: 'w', kills: { melee: 2, kick: 1 } }, { b: 'b', r: 'l', death: 'kick' }]),
    [{ b: 'a', r: 'w', kills: { melee: 2, kick: 1 } }, { b: 'b', r: 'l', death: 'kick' }]);
  assert.deepEqual(parseBotResults('ranked-solo', [{ b: 'a', r: 'l', kills: {} }]), [{ b: 'a', r: 'l' }]);
  assert.equal(parseBotResults('ranked-solo', [{ b: 'a', r: 'w', kills: { dart: 2 } }]), null, 'more kills than opponents');
  assert.equal(parseBotResults('ranked-ffa', [{ b: 'a', r: 'w', kills: { dart: 2, melee: 2 } }]), null);
  assert.equal(parseBotResults('ranked-solo', [{ b: 'a', r: 'w', kills: { fall: 1 } }]), null, 'a fall has no killer');
  assert.equal(parseBotResults('ranked-solo', [{ b: 'a', r: 'w', kills: { dart: 0.5 } }]), null);
  assert.equal(parseBotResults('ranked-solo', [{ b: 'a', r: 'w', kills: [1] }]), null);
  assert.equal(parseBotResults('ranked-solo', [{ b: 'a', r: 'w', death: 'dart' }]), null, 'a winner is alive');
  assert.equal(parseBotResults('ranked-solo', [{ b: 'a', r: 'l', death: 'walk' }]), null, 'unknown cause');
  assert.equal(parseBotResults('ranked-solo', [{ b: 'a', r: 'l' }, { b: 'b', r: 'l' }]), null);
  assert.equal(parseBotResults('ranked-ffa', [{ b: 'a', r: 'l' }, { b: 'b', r: 'l' }, { b: 'c', r: 'l' }, { b: 'd', r: 'l' }]), null);
  assert.equal(parseBotResults('ranked-ffa', [{ b: 'a', r: 'w' }, { b: 'b', r: 'w' }]), null);
  assert.equal(parseBotResults('ranked-ffa', [{ b: 'a', r: 'w' }, { b: 'b', r: 'd' }]), null);
  assert.equal(parseBotResults('ranked-solo', [{ b: '<script>', r: 'l' }]), null, 'bot ids are plain names');
  assert.equal(parseBotResults('ranked-solo', [{ b: 'x'.repeat(41), r: 'l' }]), null);
  assert.equal(parseBotResults('custom', [{ b: 'a', r: 'l' }]), null, 'ranked modes only');
  assert.equal(parseBotResults('ranked-solo', 'nope'), null);
  assert.equal(parseBotResults('ranked-solo', []), null);

  const dir = mkdtempSync(join(tmpdir(), 'site-analytics-bots-'));
  const a = new SiteAnalytics(dir, 90, T0);
  a.matchFinished(id(1), 'ranked-solo', T0, [{ b: 'glm-5.3', r: 'w', kills: { kick: 1 } }]);
  a.matchFinished(id(1), 'ranked-solo', T0, [{ b: 'glm-5.3', r: 'l', death: 'dart' }]);
  a.matchFinished(id(2), 'ranked-solo', T0, [{ b: 'glm-5.3', r: 'd', death: 'collapse' }]);
  a.matchFinished(id(2), 'ranked-solo', T0, [{ b: 'kimi-k3.1-pro', r: 'l', death: 'fall' }]);
  a.matchFinished(id(2), 'ranked-solo', T0, null); // malformed results: the finish still counts
  a.matchFinished(id(3), 'ranked-ffa', T0, [
    { b: 'gpt-6.2-astra', r: 'w', kills: { dart: 1, melee: 1 } }, { b: 'glm-5.3', r: 'l', kills: { dart: 1 }, death: 'melee' },
    { b: 'glm-5.3', r: 'l', death: 'collapse' },
  ]);
  for (let i = 0; i < 70; i++) a.matchFinished(id(4), 'ranked-ffa', T0, [{ b: `spam-${i}`, r: 'l' }]);
  const snap = a.snapshot(T0);
  assert.deepEqual(snap.modes['ranked-solo'].finished, 5);
  assert.deepEqual(snap.bots['ranked-solo']['glm-5.3'], { w: 1, d: 1, l: 1, kills: { kick: 1 }, deaths: { dart: 1, collapse: 1 } });
  assert.deepEqual(snap.bots['ranked-solo']['kimi-k3.1-pro'], { w: 0, d: 0, l: 1, kills: {}, deaths: { fall: 1 } });
  assert.deepEqual(snap.bots['ranked-ffa']['glm-5.3'], { w: 0, d: 0, l: 2, kills: { dart: 1 }, deaths: { melee: 1, collapse: 1 } });
  assert.deepEqual(snap.bots['ranked-ffa']['gpt-6.2-astra'], { w: 1, d: 0, l: 0, kills: { dart: 1, melee: 1 }, deaths: {} });
  assert.equal(Object.keys(snap.bots['ranked-ffa']).length, 64, 'distinct bot ids per mode and day are capped');

  // Survives a restart and sums over days in the report (kill and death totals)
  await a.tick(T0);
  const b = new SiteAnalytics(dir, 90, T0 + 60_000);
  await b.load(T0 + 60_000);
  assert.deepEqual(b.snapshot(T0 + 60_000).bots['ranked-solo']['glm-5.3'], snap.bots['ranked-solo']['glm-5.3']);
  const next = T0 + 86_400_000;
  b.matchFinished(id(1), 'ranked-solo', next, [{ b: 'glm-5.3', r: 'w', kills: { dart: 1 } }]);
  await b.tick(next);
  const text = formatBots(await readDays(dir, 2, next));
  assert.match(text, /ranked bots, last 2 day\(s\)/);
  assert.match(text, /kills by 近战\/飞镖\/踢下 · deaths by 近战\/飞镖\/踢下\/自坠\/塌陷/);
  //                       games  W   D   L  win%  kills melee/dart/kick  deaths melee/dart/kick/fall/collapse
  assert.match(text, /排位 SOLO\n.*\n +glm-5\.3 +4 +2 +1 +1 +50% +2 +0\/1\/1 +2 +0\/1\/0\/0\/1/);
  assert.match(text, /排位 四人\n.*\n +glm-5\.3 +2 +0 +0 +2 +0% +1 +0\/1\/0 +2 +1\/0\/0\/0\/1/);
  assert.match(formatBots([]), /no ranked results yet/);
  rmSync(dir, { recursive: true, force: true });
}

// ---------- unit: public stats (all-time totals, last 24 whole hours, bots) and compaction ----------
{
  const dir = mkdtempSync(join(tmpdir(), 'site-analytics-public-'));
  const NOW = Date.parse('2026-11-28T03:30:00Z'); // 11:30 UTC+8: the window is 11-27 12:00 → now
  const day = (d, extra) => JSON.stringify({ v: 1, day: d, updatedAt: '', uv: 1, peakOnline: 1, peakAt: null, online: {}, ids: [id(7)], modeIds: {}, ...extra });
  writeFileSync(join(dir, '2026-11-26.json'), day('2026-11-26', {
    // Players before players.json existed: rebuilt from these (replay-only viewers are not players)
    modeIds: { 'ranked-solo': [id(7), id(8)], pvp: [id(8)], replay: [id(9)] },
    modes: { 'ranked-solo': { visitors: 1, started: 7, finished: 7 }, pvp: { visitors: 1, started: 3, finished: 3 } },
    bots: { 'ranked-solo': { 'glm-5.3': { w: 2, d: 0, l: 1, kills: { dart: 2 }, deaths: { fall: 1 } } } },
    hours: { 12: { 'ranked-solo': 7 } },
  }));
  writeFileSync(join(dir, '2026-11-27.json'), day('2026-11-27', {
    modes: {
      'ranked-solo': { visitors: 1, started: 102, finished: 90 }, cricket: { visitors: 1, started: 1, finished: 1 },
      custom: { visitors: 1, started: 5, finished: 5 }, training: { visitors: 1, started: 5, finished: 0 },
    },
    hours: { 10: { 'ranked-solo': 100 }, 11: { 'ranked-solo': 2 }, 12: { custom: 5 }, 23: { cricket: 1, training: 5 } },
  }));
  const a = new SiteAnalytics(dir, 90, NOW);
  await a.load(NOW);
  const at = (hhmm) => Date.parse(`2026-11-28T${hhmm}:00+08:00`);
  a.matchStarted(id(1), 'ranked-ffa', at('00:30'));
  a.matchStarted(id(2), 'ranked-ffa', at('00:40'));
  a.pvpMatchStarted(at('05:00'));
  a.matchStarted(id(1), 'custom', at('11:10')); // the current hour counts too
  a.matchStarted(id(1), 'replay', at('11:12')); // not a public mode
  a.matchFinished(id(1), 'ranked-solo', at('11:15'), [{ b: 'glm-5.3', r: 'w', kills: { melee: 1 } }]);
  a.heartbeat(id(1), NOW);
  const st = await a.publicStats(NOW);
  assert.equal(st.since, '2026-11-26');
  assert.equal(st.online, 1);
  assert.equal(st.players, 4, 'ids 7 and 8 from the day files, 1 and 2 today; 9 only watched replays');
  assert.deepEqual(st.total, { 'ranked-solo': 109, 'ranked-ffa': 2, cricket: 1, custom: 6, pvp: 4 });
  // 11-27 10:00 and 11:00 are out (more than 23 whole hours back), 12:00 is in, and so is 11-28 11:10
  assert.deepEqual(st.last24h.modes, { 'ranked-solo': 0, 'ranked-ffa': 2, cricket: 1, custom: 6, pvp: 1 });
  assert.equal(st.last24h.from, '2026-11-27T04:00:00.000Z');
  assert.equal(st.last24h.to, '2026-11-28T03:30:00.000Z');
  assert.deepEqual(st.bots['ranked-solo']['glm-5.3'], { w: 3, d: 0, l: 1, kills: { dart: 2, melee: 1 }, deaths: { fall: 1 } });
  assert.deepEqual(st.bots['ranked-ffa'], {});
  assert.equal(JSON.stringify(st).includes(id(7)), false, 'no visitor ids');
  // Hourly buckets persist with today's snapshot
  await a.tick(NOW);
  const re = new SiteAnalytics(dir, 90, NOW);
  await re.load(NOW);
  assert.deepEqual((await re.publicStats(NOW)).last24h.modes, st.last24h.modes);
  assert.ok(existsSync(join(dir, 'players.json')));
  assert.equal((await re.publicStats(NOW)).players, 4);
  re.matchStarted(id(9), 'cricket', NOW); // the replay viewer plays a match: now a player
  re.matchStarted(id(7), 'custom', NOW); // already counted
  assert.equal((await re.publicStats(NOW)).players, 5);
  await re.tick(NOW);
  // Compaction keeps the totals (and the window, which only reaches back to yesterday)
  const c = new SiteAnalytics(dir, 1, NOW);
  await c.prune(NOW);
  const old = JSON.parse(readFileSync(join(dir, '2026-11-26.json'), 'utf8'));
  assert.equal(old.compact, true);
  assert.deepEqual(old.ids, []);
  assert.equal(old.hours, undefined);
  assert.deepEqual(old.modes['ranked-solo'], { visitors: 1, started: 7, finished: 7 });
  await c.load(NOW);
  const after = await c.publicStats(NOW);
  assert.equal(after.players, 5, 'players survive compaction (players.json)');
  assert.deepEqual({ ...after.total, cricket: after.total.cricket - 1, custom: after.total.custom - 1 }, st.total);
  assert.deepEqual(after.bots, st.bots);
  assert.equal(readdirSync(dir).filter((n) => n.startsWith('players')).join(), 'players.json', 'prune leaves players.json alone');
  // An hour later the window slides
  const later = await c.publicStats(NOW + 3_600_000);
  assert.equal(later.last24h.from, '2026-11-27T05:00:00.000Z');
  assert.equal(later.last24h.modes.custom, 2, '11-27 12:00 left the window, 11-28 11:10 and 11:30 are still in');
  assert.equal(later.last24h.modes.cricket, 2);
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
const ffaBots = [
  { b: 'deepseek-v4.1-flash', r: 'w', kills: { kick: 1, dart: 1 } }, { b: 'qwen4-max', r: 'l', death: 'kick' },
  { b: 'doubao-seed-evolving', r: 'l', death: 'fall' },
];
assert.equal((await post('/event', { id: id(1), kind: 'end', mode: 'ranked-ffa', bots: ffaBots })).status, 204);
assert.equal((await post('/event', { id: id(1), kind: 'end', mode: 'ranked-solo', bots: [{ b: 'glm-5.3', r: 'x' }] })).status, 204);
await sleep(400); // a couple of analytics ticks

const stats = await (await fetch(`${base}/stats?days=1`)).json();
assert.equal(stats.onlineNow, 2);
assert.equal(stats.visitorsToday, 2);
const files = readdirSync(analyticsDir).filter((n) => /^\d{4}-/.test(n));
assert.equal(files.length, 1);
assert.deepEqual(JSON.parse(readFileSync(join(analyticsDir, 'players.json'), 'utf8')).ids.sort(), [id(1), id(2)]);
const onDisk = readFileSync(join(analyticsDir, files[0]), 'utf8');
for (const secret of ['114.114.114.114', '240e:4c']) assert.equal(onDisk.includes(secret), false, `analytics file leaks ${secret}`);
const snap = JSON.parse(onDisk);
assert.deepEqual(snap.modes.cricket, { visitors: 1, started: 1, finished: 1 });
assert.deepEqual(snap.modes.pvp, { visitors: 1, started: 0, finished: 0 });
assert.deepEqual(snap.modes['ranked-solo'].finished, 1, 'a finish with malformed bot results still counts');
assert.deepEqual(snap.bots['ranked-ffa']['deepseek-v4.1-flash'], { w: 1, d: 0, l: 0, kills: { kick: 1, dart: 1 }, deaths: {} });
assert.deepEqual(snap.bots['ranked-ffa']['qwen4-max'], { w: 0, d: 0, l: 1, kills: {}, deaths: { kick: 1 } });
assert.equal(snap.bots['ranked-solo'], undefined);
assert.equal(snap.peakOnline, 2);

// Public stats: through the CDN only (origin key), CORS, cacheable for a few seconds, aggregates only
res = await fetch(`${base}/public-stats`, { headers: { 'x-pvp-origin-key': originKey, 'ali-cdn-real-ip': '1.2.4.8' } });
assert.equal(res.status, 200);
assert.equal(res.headers.get('access-control-allow-origin'), '*');
assert.match(res.headers.get('cache-control'), /max-age=15/);
const pub = await res.json();
assert.equal(pub.online, 2);
assert.equal(pub.players, 2, 'id 1 (cricket) and id 2 (pvp)');
assert.equal(pub.total.cricket, 1);
assert.equal(pub.bots['ranked-ffa']['qwen4-max'].l, 1);
assert.equal(JSON.stringify(pub).includes(id(1)), false);
assert.equal((await fetch(`${base}/public-stats`)).status, 403, 'direct origin access needs the CDN key');

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
assert.match(report, /ranked bots, last 1 day\(s\)[\s\S]*排位 四人[\s\S]*deepseek-v4\.1-flash +1 +1 +0 +0 +100% +2 +0\/1\/1 +0 +0\/0\/0\/0\/0/);

// Restart: today's UV survives (SIGTERM flushes)
child.kill('SIGTERM');
await new Promise((r) => child.once('exit', r));
base = await startRelay();
await sleep(100);
const after = await (await fetch(`${base}/stats?days=1`)).json();
assert.equal(after.visitorsToday, 3);
assert.equal(after.onlineNow, 0, 'online is live state, not restored');

const exited = new Promise((resolve) => child.once('exit', resolve));
child.kill();
await exited; // the relay flushes its stats on SIGTERM: remove the directory only after that
rmSync(statsDir, { recursive: true, force: true });

// ---------- client (src/net/analytics.ts): a quick restart counts the match being left as finished, once ----------
{
  const source = new URL('../src/net/analytics.ts', import.meta.url);
  const build = await esbuild.build({
    entryPoints: [fileURLToPath(source)], bundle: true, format: 'esm', write: false,
    define: { 'import.meta.env': '{"VITE_PVP_ENABLED":"1","VITE_PVP_URL":"wss://relay.test/ws"}' },
  });
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url, ...JSON.parse(init.body) });
    return new Response(null, { status: 204 });
  };
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const a = await import(`data:text/javascript;base64,${Buffer.from(build.outputFiles[0].contents).toString('base64')}`);
  const events = () => sent.splice(0).map((e) => `${e.kind}:${e.mode}`);

  a.trackMatchStart('ranked-ffa'); // eliminated, R before the bots finish
  a.trackMatchRestart();
  a.trackMatchStart('ranked-ffa'); // played to the result screen, then R
  a.trackMatchEnd('ranked-ffa');
  a.trackMatchRestart();
  assert.deepEqual(events(), ['start:ranked-ffa', 'end:ranked-ffa', 'start:ranked-ffa', 'end:ranked-ffa']);
  assert.equal(sent.length, 0);

  a.trackMatchStart('custom'); // spectating: R before the simulation completes, then again after it completed
  a.trackMatchRestart();
  a.trackMatchStart('custom');
  a.trackMatchEnd('custom');
  a.trackMatchRestart();
  assert.deepEqual(events(), ['start:custom', 'end:custom', 'start:custom', 'end:custom']);

  a.trackMatchStart('pvp'); // PvP is counted by the relay; replays and cricket batches never end through a restart
  a.trackMatchRestart();
  a.trackMatchStart('replay');
  a.trackMatchRestart();
  a.trackMatchStart('cricket-batch');
  a.trackMatchRestart();
  assert.deepEqual(events(), ['start:pvp', 'start:replay', 'start:cricket-batch']);
  a.trackMatchStart('training');
  a.trackMatchStart('cricket-batch'); // a batch in between leaves the open match alone
  a.trackMatchEnd('cricket-batch');
  a.trackMatchRestart();
  assert.deepEqual(events(), ['start:training', 'start:cricket-batch', 'end:cricket-batch', 'end:training']);
  // 排位四人 left with R while the bots finish it in the background: R does not count it, the background run does
  // (with the bots), and that late end leaves the next match (same mode) alone
  a.trackMatchStart('ranked-ffa');
  a.releaseUnfinished('ranked-ffa');
  a.trackMatchRestart();
  a.trackMatchStart('ranked-ffa');
  a.trackBackgroundEnd('ranked-ffa', [{ b: 'glm-5.3', r: 'w', kills: { dart: 2 } }]);
  a.trackMatchRestart(); // the new match is still open: R counts it
  assert.deepEqual(events(), ['start:ranked-ffa', 'start:ranked-ffa', 'end:ranked-ffa', 'end:ranked-ffa']);
  a.trackBackgroundEnd('ranked-ffa');
  assert.deepEqual(sent.splice(0).map((e) => e.bots ?? null), [null]);
  assert.equal(new Set(sent.map((e) => e.url)).size <= 1, true);
}

// ---------- client: counts on the 全球统计 panel ----------
{
  const source = new URL('../src/net/publicStats.ts', import.meta.url);
  const build = await esbuild.build({
    entryPoints: [fileURLToPath(source)], bundle: true, format: 'esm', write: false,
    define: { 'import.meta.env': '{"VITE_PVP_ENABLED":"1","VITE_PVP_URL":"wss://relay.test/ws"}' },
  });
  const { formatCount, formatTileCount } = await import(`data:text/javascript;base64,${Buffer.from(build.outputFiles[0].contents).toString('base64')}`);
  const cases = [
    [0, '0'], [999, '999'], [9999, '9,999'], [10000, '10,000'], [10001, '1.000万'], [12345, '1.235万'], [99_995, '10.00万'],
    [123_456, '12.35万'], [1_234_567, '123.5万'], [12_345_678, '1235万'], [99_999_999, '1.000亿'], [123_456_789, '1.235亿'],
    [1_234_567_890_123, '1.235万亿'],
  ];
  for (const [n, want] of cases) assert.equal(formatCount(n), want, `formatCount(${n})`);
  const tiles = [
    [0, '0'], [12_345, '12,345'], [999_999_999, '999,999,999'], [1_000_000_000, '10亿'], [1_234_567_890, '12.3456789亿'],
    [1_234_567_895, '12.345679亿'], [123_456_789_012, '1,234.56789亿'],
  ];
  for (const [n, want] of tiles) assert.equal(formatTileCount(n), want, `formatTileCount(${n})`);
}

console.log('Site analytics passed: online / leave / timeout, daily UV, per-mode visitors and matches (PvP counted once), restart + day roll, CORS + origin key + validation + rate limit, no IPs on disk, report, quick restart = finished');
process.exit(0);
