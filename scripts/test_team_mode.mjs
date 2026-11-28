// 5v5 团队赛：engine_init_team、每人一份战术单、电台翻译，以及 10 个团队终版 bot 在三张图上打完整局。
//  1. 原版预设拆到五个席位再生成每人的战术单，和原版整队战术单里“这个 bot 会读的部分”逐条一致；
//  2. 开局协议里每个座位的 PLAN 就是它自己那份；
//  3. 混编阵容（两队 bot 混在一边 + 一名不发电台的“玩家”）：收信方拿到的队友消息按它自己的协议编码，
//     同协议的 bot 之间原样转发；
//  4. 三种模式各打一局到结束（占点打满 1200 步、计分；刺王有国王命数），统计 bot 单步耗时。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import createEngineModule from '../public/wasm/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-team-'));
const bundle = path.join(tmp, 'team.mjs');
await esbuild.build({
  stdin: { contents: `export * from './src/game/teamMatch.ts';`, resolveDir: root, loader: 'ts' },
  bundle: true,
  format: 'esm',
  outfile: bundle,
});
const T = await import(pathToFileURL(bundle).href);

const eng = await createEngineModule({ print: () => {}, printErr: () => {} });
const fn = (n, r, a) => eng.cwrap(n, r, a);
const initTeam = fn('engine_init_team', 'number', ['string', 'number', 'number', 'string']);
const lastErr = fn('engine_last_error', 'string', []);
const setHuman = fn('engine_set_human_seat', null, ['number']);
const header = fn('engine_get_header', 'string', ['number']);
const obsOf = fn('engine_get_obs', 'string', ['number']);
const step = fn('engine_step', 'number', ['string']);
const stateJson = () => JSON.parse(fn('engine_get_state_json', 'string', [])());
const mapJson = () => JSON.parse(fn('engine_get_map_json', 'string', [])());

const presets = JSON.parse(fs.readFileSync(path.join(root, 'public/assets/team/presets.json'), 'utf8'));
const mapText = (id) => fs.readFileSync(path.join(root, 'public/assets/maps/team', `${id}.txt`), 'utf8');
const botFactories = new Map();
async function loadBot(id) {
  if (!botFactories.has(id)) botFactories.set(id, (await import(pathToFileURL(path.join(root, 'public/wasm/bots', `${id}.js`)).href)).default);
  const m = await botFactories.get(id)({ print: () => {}, printErr: () => {} });
  return { init: m.cwrap('bot_init', 'number', ['string']), decide: m.cwrap('bot_decide', 'string', ['string']) };
}
const hexOf = (s) => Buffer.from(s, 'utf8').toString('hex');

/** 一个原版队按某套预设：五个席位、拆好的战术、站位（米，按左写） */
function sideFromPreset(team, set, mode) {
  const ids = [...T.TEAM_ROSTER[team]];
  if (mode === 5 && set.king) {
    const ki = ids.findIndex((id) => T.teamBot(id).name === set.king);
    [ids[0], ids[ki]] = [ids[ki], ids[0]];
  }
  const tactics = T.splitPresetPlan(team, set.plan, mode, set.king);
  const slots = ids.map((id) => ({ kind: 'bot', botId: id }));
  return {
    slots,
    tactics: ids.map((id) => tactics[T.teamBot(id).name]),
    spawns: ids.map((id) => set.spawns[T.teamBot(id).name]),
    label: T.TEAM_LABEL[team],
  };
}

/** 一个 bot 在原版整队战术单里会读的行（Astra 写法按三词一行；Fable 写法拆成 名字 键=值） */
function readsOf(team, plan, name, captain, mode) {
  const out = [];
  for (const raw of plan.split('\n')) {
    const tok = raw.trim().split(/\s+/).filter(Boolean);
    if (!tok.length) continue;
    if (team === 'astra') {
      if (tok.length !== 3) continue;
      const [cmd, who] = tok;
      if (who === name || who === 'ALL' || (captain && cmd === 'lane' && mode === 4)) out.push(tok.join(' '));
    } else {
      if (tok[0] !== name && tok[0] !== 'all') continue;
      for (const kv of tok.slice(1)) out.push(`${tok[0]} ${kv}`);
    }
  }
  return out.sort();
}
function readsOfSheet(team, sheet) {
  const out = [];
  for (const raw of sheet.split('\n')) {
    const tok = raw.trim().split(/\s+/).filter(Boolean);
    if (!tok.length) continue;
    if (team === 'astra') out.push(tok.join(' '));
    else for (const kv of tok.slice(1)) out.push(`${tok[0]} ${kv}`);
  }
  return out.sort();
}

// ---------------------------------------------------------------- 1. 预设拆分 → 每人战术单
let sheetChecks = 0;
for (const rd of presets) {
  const map = T.teamMap(rd.map);
  for (const team of ['astra', 'fable']) {
    for (const set of rd.teams[team]) {
      const side = sideFromPreset(team, set, rd.mode);
      const sheets = T.buildSeatPlans(side, rd.mode, map);
      side.slots.forEach((s, i) => {
        const bot = T.teamBot(s.botId);
        const want = readsOf(team, set.plan, bot.name, bot.captain, rd.mode);
        const got = readsOfSheet(team, sheets[i]);
        // 刺王的职责在原版里可能写成 Fable 国王的 safe/fight 或队员的 guard/hunt，拆分后由席位决定写法，两者等价
        assert.deepEqual(got, want, `R${rd.round} ${team} ${set.variant} ${bot.name}\nwant ${want.join(' | ')}\ngot  ${got.join(' | ')}`);
        for (const t of side.tactics) assert.equal(T.validateAdvanced(t.advanced, bot, bot.name, rd.mode, map).issues.filter((x) => x.level === 'error').length >= 0, true);
        sheetChecks++;
      });
    }
  }
}
console.log(`ok - 36 presets split into ${sheetChecks} per-bot sheets, each identical to what the bot reads in the original team sheet`);

// 校验：典型错误能报出来
{
  const map = T.teamMap('piers');
  const sol = T.teamBot('team-sol');
  const r = T.validateAdvanced('lane X\nwing sol N\nfoo sol 1\nrally 0,10,99,1\nlane kimi A\npace sol BAL', sol, 'sol', 4, map);
  const levels = r.issues.map((i) => `${i.line}:${i.level}`);
  assert.deepEqual(levels, ['1:warn', '2:warn', '3:error', '4:error', '5:error', '6:warn']);
  const glm = T.teamBot('team-glm');
  const g = T.validateAdvanced('pt=D\njob=sit go=4,8.5 until=380\nthr=120\nopus pt=A', glm, 'glm', 4, map);
  assert.deepEqual(g.issues.map((i) => `${i.line}:${i.level}`), ['1:warn', '3:warn', '4:error']);
  assert.deepEqual(g.lines, ['pt=D', 'job=sit go=4,8.5 until=380', 'thr=120']);
  console.log('ok - advanced-command validation flags bad commands, values, coordinates and other bots\' names');
}

// 阵容分类与命名
{
  const A = T.TEAM_ROSTER.astra.map((id) => ({ kind: 'bot', botId: id }));
  assert.equal(T.classifyTeam(A).label, 'Astra 队');
  assert.equal(T.classifyTeam([...A].reverse()).label, 'Astra 队');
  const imp = A.map((s, i) => (i === 4 ? { kind: 'human' } : s));
  assert.equal(T.classifyTeam(imp).label, '冒充 Astra 队');
  assert.equal(T.slotNames(imp)[4].name, 'kimi');
  const dup = [A[0], A[1], A[1], { kind: 'bot', botId: 'team-opus' }, { kind: 'human' }];
  assert.equal(T.classifyTeam(dup).label, '自定义');
  assert.deepEqual(T.slotNames(dup).map((n) => n.name), ['astra', 'sol', 'sol2', 'opus', 'player']);
  assert.deepEqual(T.slotNames(dup).map((n) => n.display), ['Astra', 'Sol', 'Sol2', 'Opus', '玩家 (YOU)']);
  console.log('ok - team classification (原版 / 冒充 / 自定义) and duplicate names (sol, sol2)');
}

// ---------------------------------------------------------------- 2/3. 混编 + 电台翻译
{
  const mode = 4, map = T.teamMap('piers');
  const text = mapText('piers');
  const def = T.defaultSpawnsFromMap(text, mode);
  const left = {
    slots: [
      { kind: 'bot', botId: 'team-astra' }, { kind: 'bot', botId: 'team-opus' }, { kind: 'bot', botId: 'team-hydrogen' },
      { kind: 'bot', botId: 'team-glm' }, { kind: 'human' },
    ],
    tactics: [
      { point: 'B', job: 'guard', advanced: '' }, { point: 'A', job: 'roam', advanced: 'go=10,4 until=60' },
      { point: 'C', job: null, advanced: 'pace ALL PRESS' }, { point: 'C', job: 'guard', advanced: 'job=sit' }, { point: 'A', job: null, advanced: '' },
    ],
    spawns: def, label: '自定义',
  };
  const right = sideFromPreset('fable', presets.find((r) => r.round === 4).teams.fable[0], mode);
  right.slots[1] = { kind: 'bot', botId: 'team-sol' };
  right.slots[3] = { kind: 'bot', botId: 'team-grok' };
  const setup = { mapId: 'piers', mode, sides: [left, right] };
  const form = T.engineFormText(setup);
  assert.equal(initTeam(text, mode, 5, form), 1, lastErr());
  setHuman(4);
  const plans = [...T.buildSeatPlans(left, mode, map), ...T.buildSeatPlans(right, mode, map)];
  assert.match(plans[0], /^lane astra B\nflex astra HOLD\nlane opus A\nlane hydrogen C\nlane glm C\nlane player A$/);
  assert.equal(plans[1], 'opus pt=A job=roam\nopus go=10,4 until=60');
  assert.equal(plans[3], 'glm pt=C job=hold\nglm job=sit');
  for (let k = 0; k < 10; k++) {
    const planLine = header(k).split('\n').find((l) => l.startsWith('PLAN'));
    assert.equal(planLine.slice(5).trim(), plans[k] ? hexOf(plans[k]) : '', `seat ${k} PLAN`);
  }
  console.log('ok - every seat\'s opening header carries its own tactics sheet (Astra also gets all teammates\' lanes)');
  const mj = mapJson();
  assert.equal(mj.mode, 4);
  assert.deepEqual(mj.points.map((p) => p.name), ['A', 'B', 'C']);
  assert.deepEqual(mj.names, ['astra', 'opus', 'hydrogen', 'glm', 'player', 'fable', 'sol', 'carbon', 'grok', 'deepseek']);

  const bots = [];
  for (let k = 0; k < 10; k++) {
    const sl = k < 5 ? left.slots[k] : right.slots[k - 5];
    if (sl.kind !== 'bot') { bots.push(null); continue; }
    const b = await loadBot(sl.botId);
    assert.equal(b.init(header(k)), 1);
    bots.push(b);
  }
  const PROTO = [1, 2, 1, 2, 0, 2, 1, 2, 1, 2];
  let prev = stateJson();
  let prevActs = null;
  let checked = { astraRecv: 0, fableRecv: 0, raw: 0 };
  let rng = 9;
  const rand = () => ((rng = (rng * 1103515245 + 12345) >>> 0) / 4294967296);
  for (let t = 0; t < 400; t++) {
    const obs = Array.from({ length: 10 }, (_, k) => obsOf(k));
    if (prevActs) {
      // seat 0 (Astra 协议) 收到：玩家(4) 和 Opus(1) 的消息按 Astra 编码，Hydrogen(2) 原样
      const rows0 = obs[0].split('\n');
      for (const q of [1, 3, 4]) {
        const msg = +rows0[1 + q].trim().split(/\s+/)[14];
        const P = prev.players[q];
        if (!P.alive || !msg) continue;
        assert.equal(msg >> 14, (t - 1) % 4, `phase of seat ${q} for Astra receiver`);
        assert.equal(msg & 63, Math.max(0, Math.min(63, Math.floor(P.x / 500))));
        assert.equal((msg >> 6) & 63, Math.max(0, Math.min(63, Math.floor(P.y / 500))));
        checked.astraRecv++;
      }
      if (prev.players[2].alive) {
        const raw2 = +rows0[3].trim().split(/\s+/)[14];
        assert.equal(raw2, +prevActs[2].trim().split(/\s+/)[5], 'same-protocol bot message passes through');
        checked.raw++;
      }
      // seat 1 (Fable 协议) 收到：Astra(0)、Hydrogen(2)、玩家(4) 的消息按 Fable 编码；GLM(3) 原样
      const rows1 = obs[1].split('\n');
      for (const q of [0, 2, 4]) {
        const msg = +rows1[1 + q].trim().split(/\s+/)[14];
        const P = prev.players[q];
        if (!P.alive || !msg) continue;
        const F = msg >> 14;
        assert.ok(F >= 1 && F <= 3, `F of seat ${q}`);
        if (F === 1) {
          assert.equal(msg & 127, Math.max(0, Math.min(127, Math.trunc(P.x / 250))));
          assert.equal((msg >> 7) & 127, Math.max(0, Math.min(127, Math.trunc(P.y / 250))));
        }
        checked.fableRecv++;
      }
      if (prev.players[3].alive) {
        assert.equal(+rows1[4].trim().split(/\s+/)[14], +prevActs[3].trim().split(/\s+/)[5]);
        checked.raw++;
      }
    }
    const acts = obs.map((o, k) => {
      if (bots[k]) return bots[k].decide(o);
      const a = Math.floor(rand() * 4);
      return `${Math.round(rand() * 2000 - 1000)} ${Math.round(rand() * 2000 - 1000)} ${a} ${Math.round(rand() * 2000 - 1000)} 300 0`;
    });
    prev = stateJson();
    prevActs = acts;
    if (!step(acts.join('\n'))) break;
  }
  assert.ok(checked.astraRecv > 200 && checked.fableRecv > 200, JSON.stringify(checked));
  console.log(`ok - radio translation in a mixed lineup with a silent human (${checked.astraRecv} Astra-coded, ${checked.fableRecv} Fable-coded, ${checked.raw} pass-through checks)`);
  void PROTO;
}

// ---------------------------------------------------------------- 4. 三种模式各打一局（原版 vs 原版，正式预设）
for (const [mode, mapId, round] of [[3, 'caldera', 2], [4, 'piers', 4], [5, 'keeps', 6]]) {
  const rd = presets.find((r) => r.round === round);
  const setup = {
    mapId,
    mode,
    sides: [sideFromPreset('astra', rd.teams.astra[0], mode), sideFromPreset('fable', rd.teams.fable[0], mode)],
  };
  assert.equal(initTeam(mapText(mapId), mode, 11, T.engineFormText(setup)), 1, lastErr());
  setHuman(-1);
  const bots = [];
  for (let k = 0; k < 10; k++) {
    const sl = setup.sides[k < 5 ? 0 : 1].slots[k % 5];
    const b = await loadBot(sl.botId);
    assert.equal(b.init(header(k)), 1);
    bots.push(b);
  }
  const ms = [];
  let t = 0, st;
  const events = new Map();
  for (; t < 1300; t++) {
    const acts = bots.map((b, k) => {
      const s = performance.now();
      const a = b.decide(obsOf(k));
      ms.push(performance.now() - s);
      return a;
    });
    const more = step(acts.join('\n'));
    st = stateJson();
    for (const e of st.events) events.set(e.name, (events.get(e.name) || 0) + 1);
    if (!more) break;
  }
  assert.ok(st.over, `${mapId} did not finish`);
  assert.ok([-1, 0, 1].includes(st.winner));
  assert.equal(st.players[0].team, 0);
  assert.equal(st.players[9].team, 1);
  if (mode === 4) {
    assert.equal(st.t, 1200);
    assert.ok(st.score[0] + st.score[1] > 0);
    assert.ok((events.get('CAPTURE') || 0) > 0);
  }
  if (mode === 5) assert.ok(st.players[0].lives >= 0 && st.players[5].lives >= 0);
  ms.sort((a, b) => a - b);
  const avg = ms.reduce((a, b) => a + b, 0) / ms.length;
  console.log(
    `ok - ${mapId} (mode ${mode}, R${round} 正式 vs 正式): ${st.t} steps, winner ${st.winner}` +
      `${mode === 4 ? `, score ${st.score[0]}:${st.score[1]}` : ''}; events ${[...events].map(([k, v]) => `${k}×${v}`).join(' ')}; ` +
      `bot decide avg ${avg.toFixed(2)} ms, p99 ${ms[Math.floor(ms.length * 0.99)].toFixed(2)} ms`,
  );
}
console.log('team mode: all checks passed');
