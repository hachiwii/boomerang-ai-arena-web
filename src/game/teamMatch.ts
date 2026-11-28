// 5v5 团队赛（上游第 12 集 boomerang-team）：10 个团队终版 bot、三张图三种模式、阵容分类、战术单的
// 基础选项 ↔ 两种原版写法（Astra 队 / Fable 队）的翻译与校验，以及交给引擎的开局参数（engine_init_team）。
// 电台翻译在引擎里做（wasm/engine_wasm.cpp）：这里只告诉引擎每个座位听哪种协议。

export type TeamModeNum = 3 | 4 | 5;
export type OrigTeam = 'astra' | 'fable';
export type TeamMapId = 'caldera' | 'piers' | 'keeps';
export type PointName = 'A' | 'B' | 'C';
/** 占点：guard 守卫（守住自己的点）/ roam 游走；刺王：guard 守卫（护王，国王本人 = 保命）/ hunt 进攻（抓对方国王，国王本人 = 参战） */
export type TeamJob = 'guard' | 'roam' | 'hunt';

export interface TeamBotDef {
  id: string; // WASM 模块名（public/wasm/bots/<id>.js）
  name: string; // 引擎里的短名（战术单、bot 默认分工都认它）
  display: string;
  fullName: string;
  team: OrigTeam;
  captain: boolean;
  charKey: string;
  avatar: string;
  color: string; // 角色色（名牌等），同原版 roster
}

export const TEAM_BOTS: TeamBotDef[] = [
  { id: 'team-astra', name: 'astra', display: 'Astra', fullName: 'GPT-6.2 Astra', team: 'astra', captain: true, charKey: 'astra', avatar: '/assets/avatars/astra.png', color: '#12B886' },
  { id: 'team-sol', name: 'sol', display: 'Sol', fullName: 'GPT-6.2 Sol', team: 'astra', captain: false, charKey: 'sol', avatar: '/assets/avatars/sol.png', color: '#7FE0A8' },
  { id: 'team-hydrogen', name: 'hydrogen', display: 'Hydrogen', fullName: 'Gemini 4 Hydrogen', team: 'astra', captain: false, charKey: 'gemini_s', avatar: '/assets/avatars/gemini_s.png', color: '#FFA6D6' },
  { id: 'team-grok', name: 'grok', display: 'Grok', fullName: 'Grok 4.7', team: 'astra', captain: false, charKey: 'grok', avatar: '/assets/avatars/grok.png', color: '#FFD43B' },
  { id: 'team-kimi', name: 'kimi', display: 'Kimi', fullName: 'Kimi K3.1 Pro', team: 'astra', captain: false, charKey: 'kimi', avatar: '/assets/avatars/kimi.png', color: '#5DC8F8' },
  { id: 'team-fable', name: 'fable', display: 'Fable', fullName: 'Claude Fable 5.2', team: 'fable', captain: true, charKey: 'fable', avatar: '/assets/avatars/fable.png', color: '#9E2340' },
  { id: 'team-opus', name: 'opus', display: 'Opus', fullName: 'Claude Opus 5.5', team: 'fable', captain: false, charKey: 'opus', avatar: '/assets/avatars/opus.png', color: '#FFA436' },
  { id: 'team-carbon', name: 'carbon', display: 'Carbon', fullName: 'Gemini 4 Carbon', team: 'fable', captain: false, charKey: 'gemini', avatar: '/assets/avatars/gemini.png', color: '#E8459B' },
  { id: 'team-glm', name: 'glm', display: 'GLM', fullName: 'GLM 5.3', team: 'fable', captain: false, charKey: 'glm', avatar: '/assets/avatars/glm.png', color: '#8892A8' },
  { id: 'team-deepseek', name: 'deepseek', display: 'DeepSeek', fullName: 'DeepSeek-V4.1-Flash', team: 'fable', captain: false, charKey: 'deepseek', avatar: '/assets/avatars/deepseek.png', color: '#1B4FD8' },
];
const BOT_BY_ID = new Map(TEAM_BOTS.map((b) => [b.id, b]));
export const teamBot = (id: string | undefined): TeamBotDef | undefined => (id ? BOT_BY_ID.get(id) : undefined);

/** 原版队伍的五个席位（顺序 = 原版座位顺序，队长在前；刺王里第一位当国王）。 */
export const TEAM_ROSTER: Record<OrigTeam, string[]> = {
  astra: ['team-astra', 'team-sol', 'team-hydrogen', 'team-grok', 'team-kimi'],
  fable: ['team-fable', 'team-opus', 'team-carbon', 'team-glm', 'team-deepseek'],
};
/** 队伍身份色（上游渲染器与网页版一致）：Astra 蓝、Fable 红。 */
export const TEAM_COLOR: Record<OrigTeam, string> = { astra: '#2E8CFF', fable: '#FF5B4D' };
export const TEAM_LABEL: Record<OrigTeam, string> = { astra: 'Astra 队', fable: 'Fable 队' };
/** 对局里的左右两队（座位 0～4 / 5～9）配色：左蓝右红。 */
export const SIDE_COLOR: [string, string] = ['#2E8CFF', '#FF5B4D'];

export interface TeamMapDef {
  id: TeamMapId;
  mode: TeamModeNum;
  title: string;
  modeLabel: string;
  theme: string;
  widthM: number;
  heightM: number;
  desc: string;
  /** 布阵区（左队，米，含边界）；右队是它绕地图中心转 180 度 */
  deploy: [number, number, number, number];
}

export const TEAM_MAPS: TeamMapDef[] = [
  {
    id: 'caldera', mode: 3, title: '火山口', modeLabel: '歼灭', theme: 'caldera', widthM: 28, heightM: 20, deploy: [1, 5, 6, 15],
    desc: '一圈环形山包着岩浆湖，湖心岩台只有南北两座 1 米窄桥能上。打光对方五人获胜；15 秒后由外向里逐波塌陷，最后在湖心岩台决胜。',
  },
  {
    id: 'piers', mode: 4, title: '三座栈桥', modeLabel: '占点', theme: 'harbor', widthM: 32, heightM: 20, deploy: [1, 1, 6.5, 19],
    desc: '两岸之间三座平行栈桥，A、B、C 三个点各在一座桥正中。站满 1 秒翻点，每占一个点每秒 1 分，60 秒比总分；出局 3 秒后在自己的布阵点复活，地图不塌。',
  },
  {
    id: 'keeps', mode: 5, title: '双堡', modeLabel: '刺王', theme: 'keeps', widthM: 30, heightM: 17, deploy: [1, 1, 8.5, 16],
    desc: '两队各有一座只开南北两道门的小城堡。第一位是国王：3 条命，掉命后 1.5 秒无敌，掉坑直接出局；打掉对方国王获胜，城堡自外向内塌陷。',
  },
];
export const teamMap = (id: string): TeamMapDef => TEAM_MAPS.find((m) => m.id === id) || TEAM_MAPS[0];

// ---------------------------------------------------------------- 阵容

export interface TeamSlotDraft {
  kind: 'human' | 'bot';
  botId?: string;
  /** 联机房间：这一席是哪位成员（房间内的成员 id）；本地对局的玩家席没有 */
  member?: number;
  /** 联机房间：成员顶替的是哪个 bot、它在每张图上的战术（交还席位时原样恢复） */
  prev?: string;
  prevTactics?: Partial<Record<TeamMapId, SlotTactic>>;
}

export interface SlotTactic {
  point: PointName | null;
  job: TeamJob | null;
  /** 高级指令：按这个 bot 原版队伍的写法，每行一条；省略名字 = 这个 bot 自己（Astra 写法也可写 ALL，Fable 写法也可写 all） */
  advanced: string;
}

export const emptyTactic = (): SlotTactic => ({ point: null, job: null, advanced: '' });

export type TeamKind = 'original' | 'impostor' | 'custom';

export interface TeamClass {
  kind: TeamKind;
  team: OrigTeam | null; // original / impostor 时是哪个原版队
  label: string; // 列顶显示的队名
}

/** 阵容分类：五个原版队员（顺序不限）= 原版队；把其中一人换成玩家 = 冒充；其他改动 = 自定义。 */
export function classifyTeam(slots: TeamSlotDraft[]): TeamClass {
  const humans = slots.filter((s) => s.kind === 'human').length;
  for (const team of ['astra', 'fable'] as OrigTeam[]) {
    const roster = TEAM_ROSTER[team];
    const bots = slots.filter((s) => s.kind === 'bot').map((s) => s.botId || '');
    const distinct = new Set(bots);
    if (distinct.size !== bots.length || !bots.every((id) => roster.includes(id))) continue;
    if (humans === 0) return { kind: 'original', team, label: TEAM_LABEL[team] };
    return { kind: 'impostor', team, label: `冒充 ${TEAM_LABEL[team]}` };
  }
  return { kind: 'custom', team: null, label: '自定义' };
}

/** 每个席位的短名：原版队员用原名，重复的从第二份起加 2、3…；冒充时玩家顶替缺的那位的名字，否则叫 player。 */
export function slotNames(slots: TeamSlotDraft[]): { name: string; display: string }[] {
  const cls = classifyTeam(slots);
  // 冒充时每位玩家按顺序顶替缺的队员的名字；否则叫 player、player2…（联机时一队可以有好几个人）
  const humanNames: string[] = [];
  if (cls.kind === 'impostor' && cls.team) {
    const present = new Set(slots.filter((s) => s.kind === 'bot').map((s) => s.botId));
    for (const id of TEAM_ROSTER[cls.team]) if (!present.has(id)) humanNames.push(teamBot(id)!.name);
  }
  let hi = 0;
  const seen = new Map<string, number>();
  return slots.map((s) => {
    if (s.kind === 'human') {
      const name = humanNames[hi] ?? (hi === 0 ? 'player' : `player${hi + 1}`);
      hi++;
      return { name, display: '玩家 (YOU)' };
    }
    const b = teamBot(s.botId)!;
    const n = (seen.get(b.id) || 0) + 1;
    seen.set(b.id, n);
    return n === 1 ? { name: b.name, display: b.display } : { name: `${b.name}${n}`, display: `${b.display}${n}` };
  });
}

/** 换人时保留的战术：同一原版队之间整份保留；否则只留基础选项，高级指令清空。 */
export function carryTactic(prev: SlotTactic, from: TeamSlotDraft, to: TeamSlotDraft): SlotTactic {
  const a = from.kind === 'bot' ? teamBot(from.botId)?.team : null;
  const b = to.kind === 'bot' ? teamBot(to.botId)?.team : null;
  if (a && b && a === b) return { ...prev };
  return { point: prev.point, job: prev.job, advanced: '' };
}

// ---------------------------------------------------------------- 战术按钮文字

export const JOB_LABEL: Record<TeamJob, string> = { guard: '守卫', roam: '游走', hunt: '进攻' };

export function tacticButtonLabel(t: SlotTactic, mode: TeamModeNum): string {
  if (mode === 4) {
    const parts = [t.point, t.job && (t.job === 'hunt' ? null : JOB_LABEL[t.job])].filter(Boolean);
    return parts.length ? parts.join(' ') : '战术';
  }
  if (mode === 5 && t.job) return t.job === 'roam' ? '战术' : JOB_LABEL[t.job];
  return '战术';
}

// ---------------------------------------------------------------- 高级指令：两种写法的词表与校验

export interface PlanIssue {
  line: number; // 1 起
  level: 'error' | 'warn';
  text: string;
}

interface AstraCmd {
  values?: string[]; // 不写 = 自由值（单独校验）
  captain?: boolean; // 只有队长 Astra 认
  modes: TeamModeNum[]; // 在哪些模式起作用
  desc: string;
}

const ALL_MODES: TeamModeNum[] = [3, 4, 5];
export const ASTRA_CMDS: Record<string, AstraCmd> = {
  lane: { values: ['A', 'B', 'C'], modes: [4], desc: '占点：主攻哪个点' },
  flex: { values: ['HOLD', 'ROAM'], modes: [4], desc: '占点：只守自己的点 / 占稳后可以支援别的点' },
  role: { values: ['HUNT', 'GUARD', 'FLEX'], modes: [5], desc: '刺王：抓对方国王 / 护己方国王 / 看情况' },
  wing: { values: ['N', 'S', 'AUTO'], modes: [3, 5], desc: '开局走北路 / 南路 / 自动' },
  pace: { values: ['SAFE', 'BAL', 'PRESS'], modes: ALL_MODES, desc: '打法：保守 / 均衡 / 激进' },
  mark: { modes: ALL_MODES, desc: '优先集火：KING（对方国王）或对手的短名' },
  rally: { modes: ALL_MODES, desc: '限时集合：起始步,结束步,x,y（米，按本队在左写）' },
  island: { values: ['EARLY', 'LATE', 'RIM'], captain: true, modes: [3], desc: '火山口：何时上湖心岩台' },
  kingstyle: { values: ['SHELTER', 'RAID', 'SCREEN', 'COUNTER', 'COVER'], captain: true, modes: [5], desc: '自己当国王时的打法' },
  screen: { values: ['DEEP', 'RING'], captain: true, modes: [4], desc: '占稳后前压拦截的深度' },
  ring: { values: ['FIXED', 'MOBILE'], captain: true, modes: [4], desc: '守点时在圈里固定站位 / 机动' },
  rim: { values: ['INNER'], captain: true, modes: [5], desc: '国王在塌陷后守在边缘内侧' },
  push: { values: ['PLAIN', 'ROYAL'], captain: true, modes: [5], desc: 'PLAIN 关闭推对方国王下坑' },
  contact: { values: ['OFF', 'ON'], captain: true, modes: ALL_MODES, desc: 'OFF 关闭推演里的人群挤碰模型' },
  learn: { values: ['OFF', 'ON'], captain: true, modes: ALL_MODES, desc: 'OFF 关闭对手躲避习惯的在线学习' },
  aid: { values: ['ROYAL', 'ALL'], captain: true, modes: ALL_MODES, desc: 'ROYAL 只掩护国王，不掩护其他队友' },
  duel: { values: ['BASIC', 'EXACT'], captain: true, modes: [3, 5], desc: 'BASIC 关闭单挑精算' },
  finish: { values: ['SOLO', 'ASSIST'], captain: true, modes: [3, 5], desc: 'SOLO 关闭残局补刀协同' },
  opening: { values: ['READ', 'SKIP'], captain: true, modes: [3, 4], desc: 'READ 根据对手开局站位调整分工' },
  leap: { values: ['OFF', 'ON'], captain: true, modes: [3, 5], desc: 'OFF 关闭冲刺越坑规划' },
};

interface FableKey {
  values?: string[];
  captain?: boolean;
  modes: TeamModeNum[];
  desc: string;
}
export const FABLE_KEYS: Record<string, FableKey> = {
  pt: { values: ['A', 'B', 'C'], modes: [4], desc: '占点：去哪个点' },
  job: { values: ['hold', 'roam', 'guard', 'hunt', 'safe', 'fight', 'sit'], modes: [4, 5], desc: '占点 hold/roam；刺王 guard/hunt，国王 safe/fight；GLM 另认 sit' },
  go: { modes: ALL_MODES, desc: '开局集合点 x,y（米，按本队在左写）' },
  until: { modes: ALL_MODES, desc: '集合持续到第几步（每秒 20 步）' },
  thr: { captain: true, modes: ALL_MODES, desc: '出手门槛（百分比，默认 100）' },
  fear: { captain: true, modes: ALL_MODES, desc: '怕死程度（百分比，默认 100）' },
  obj: { captain: true, modes: ALL_MODES, desc: '目标权重（百分比，默认 100）' },
  cap: { captain: true, modes: ALL_MODES, desc: '思考量上限（百分比，默认 100）' },
  avoid: { captain: true, modes: ALL_MODES, desc: '躲开某个对手（短名）' },
  focus: { captain: true, modes: ALL_MODES, desc: '盯住某个对手（短名）' },
  volley: { values: ['0', '1'], captain: true, modes: ALL_MODES, desc: '齐射开关（默认 1）' },
  rm: { values: ['1', '2'], captain: true, modes: [4], desc: '游走算法版本' },
};

const MODE_NAMES: Record<TeamModeNum, string> = { 3: '歼灭', 4: '占点', 5: '刺王' };
const modeList = (m: TeamModeNum[]) => m.map((x) => MODE_NAMES[x]).join('、');

function checkRally(v: string, map: TeamMapDef): string | null {
  const parts = v.split(',');
  if (parts.length !== 4) return 'rally 的值要写成 起始步,结束步,x,y';
  const [a, b, x, y] = parts.map(Number);
  if (![a, b, x, y].every(Number.isFinite)) return 'rally 的值要是四个数';
  if (!(Number.isInteger(a) && Number.isInteger(b) && a >= 0 && a < b)) return 'rally 的起止步要是整数，且起始 < 结束';
  if (x < 0 || y < 0 || x > map.widthM || y > map.heightM) return `rally 的坐标超出地图（${map.widthM}×${map.heightM} 米）`;
  return null;
}

function checkGo(v: string, map: TeamMapDef): string | null {
  const parts = v.split(',');
  if (parts.length !== 2 || !parts.every((p) => Number.isFinite(Number(p)))) return 'go 的值要写成 x,y（米）';
  const [x, y] = parts.map(Number);
  if (x <= 0 || y <= 0 || x > map.widthM || y > map.heightM) return `go 的坐标超出地图（${map.widthM}×${map.heightM} 米）`;
  return null;
}

/**
 * 校验并规范化一个 bot 的高级指令。返回规范化后的行（省略名字 = 自己；名字写成自己的也会去掉），
 * 生成战术单时再补上这个 bot 的短名。
 */
export function validateAdvanced(
  text: string,
  bot: TeamBotDef,
  selfName: string,
  mode: TeamModeNum,
  map: TeamMapDef,
): { lines: string[]; issues: PlanIssue[] } {
  const issues: PlanIssue[] = [];
  const lines: string[] = [];
  const rows = text.replace(/\r/g, '').split('\n');
  rows.forEach((raw, i) => {
    const line = i + 1;
    const tok = raw.trim().split(/\s+/).filter(Boolean);
    if (!tok.length) return;
    if (tok[0].startsWith('//') || tok[0].startsWith('#')) return;
    const err = (t: string) => issues.push({ line, level: 'error', text: t });
    const warn = (t: string) => issues.push({ line, level: 'warn', text: t });
    if (bot.team === 'astra') {
      // 指令 [名字|ALL] 值
      let cmd = tok[0], who = '', val = '';
      if (tok.length === 2) [cmd, val] = tok;
      else if (tok.length === 3) [cmd, who, val] = tok;
      else return err('Astra 队写法每行是「指令 值」或「指令 名字 值」');
      const def = ASTRA_CMDS[cmd];
      if (!def) return err(`Astra 队写法没有「${cmd}」这个指令`);
      if (who && who !== 'ALL' && who !== selfName) return err(`这份战术单只交给 ${selfName}，写别人的名字（${who}）没有用`);
      const all = who === 'ALL';
      if (all && (bot.id === 'team-sol' || bot.id === 'team-kimi') && cmd !== 'pace' && cmd !== 'mark')
        warn(`${bot.display} 只认 pace、mark 的 ALL 写法，这行请写成自己的名字或省略名字`);
      if (all && bot.id === 'team-sol' && cmd === 'mark' && val !== 'KING') warn('Sol 的 mark ALL 只认 KING');
      if (!all && bot.id === 'team-sol' && cmd === 'pace') warn('Sol 只认 pace ALL，写自己的名字它不认');
      if (def.captain && !bot.captain) warn(`「${cmd}」只有队长 Astra 认，${bot.display} 会忽略`);
      if (def.values && !def.values.includes(val)) warn(`${cmd} 的值 ${val} 不在 ${def.values.join(' / ')} 里，bot 会当作默认值`);
      if (cmd === 'rally') {
        const e = checkRally(val, map);
        if (e) return err(e);
      }
      if (!def.modes.includes(mode)) warn(`${cmd} 只在${modeList(def.modes)}模式起作用`);
      lines.push(all ? `${cmd} ALL ${val}` : `${cmd} ${val}`);
    } else {
      // [名字|all] 键=值 …
      let start = 0, all = false;
      if (!tok[0].includes('=')) {
        if (tok[0] === 'all') all = true;
        else if (tok[0] !== selfName) return err(`这份战术单只交给 ${selfName}，写别人的名字（${tok[0]}）没有用`);
        start = 1;
      }
      const pairs = tok.slice(start);
      if (!pairs.length) return err('Fable 队写法每行是「键=值 键=值 …」（可在最前面写 all）');
      for (const kv of pairs) {
        const eq = kv.indexOf('=');
        if (eq <= 0 || eq === kv.length - 1) return err(`「${kv}」要写成 键=值`);
        const k = kv.slice(0, eq), v = kv.slice(eq + 1);
        const def = FABLE_KEYS[k];
        if (!def) return err(`Fable 队写法没有「${k}」这个键`);
        if (def.captain && !bot.captain) warn(`「${k}」只有队长 Fable 认，${bot.display} 会忽略`);
        if (def.values && !def.values.includes(v)) warn(`${k} 的值 ${v} 不在 ${def.values.join(' / ')} 里，bot 会当作默认值`);
        if (k === 'job' && v === 'sit' && bot.id !== 'team-glm') warn('job=sit 只有 GLM 认');
        if (k === 'go') {
          const e = checkGo(v, map);
          if (e) return err(e);
        }
        if (k === 'until' && !/^\d+$/.test(v)) return err('until 要是步数（整数，每秒 20 步）');
        if (['thr', 'fear', 'obj', 'cap'].includes(k) && !Number.isFinite(Number(v))) return err(`${k} 要是数字（百分比）`);
        if (!def.modes.includes(mode)) warn(`${k} 只在${modeList(def.modes)}模式起作用`);
      }
      lines.push(all ? `all ${pairs.join(' ')}` : pairs.join(' '));
    }
  });
  return { lines, issues };
}

// ---------------------------------------------------------------- 生成每个 bot 的战术单

function basicLines(bot: TeamBotDef, name: string, t: SlotTactic, mode: TeamModeNum, isKing: boolean): string[] {
  if (bot.team === 'astra') {
    const out: string[] = [];
    if (mode === 4) {
      if (t.point) out.push(`lane ${name} ${t.point}`);
      if (t.job === 'guard') out.push(`flex ${name} HOLD`);
      if (t.job === 'roam') out.push(`flex ${name} ROAM`);
    } else if (mode === 5) {
      if (t.job === 'guard') out.push(`role ${name} GUARD`);
      if (t.job === 'hunt') out.push(`role ${name} HUNT`);
    }
    return out;
  }
  const kv: string[] = [];
  if (mode === 4) {
    if (t.point) kv.push(`pt=${t.point}`);
    if (t.job === 'guard') kv.push('job=hold');
    if (t.job === 'roam') kv.push('job=roam');
  } else if (mode === 5) {
    if (t.job === 'guard') kv.push(isKing ? 'job=safe' : 'job=guard');
    if (t.job === 'hunt') kv.push(isKing ? 'job=fight' : 'job=hunt');
  }
  return kv.length ? [`${name} ${kv.join(' ')}`] : [];
}

function expandAdvanced(bot: TeamBotDef, name: string, lines: string[]): string[] {
  return lines.map((l) => {
    const tok = l.split(' ');
    if (bot.team === 'astra') return tok.length === 2 ? `${tok[0]} ${name} ${tok[1]}` : l;
    return tok[0] === 'all' ? l : `${name} ${l}`;
  });
}

export interface SideSetup {
  slots: TeamSlotDraft[];
  tactics: SlotTactic[];
}

/**
 * 每个席位实际拿到的战术单：基础选项 + 高级指令（这个 bot 的写法）；队长 Astra 还会读队友的 lane，
 * 所以给它补上全队（包括 Fable 系队员和玩家）的 lane 行。玩家席位不需要战术单（空串）。
 */
export function buildSeatPlans(side: SideSetup, mode: TeamModeNum, map: TeamMapDef): string[] {
  const names = slotNames(side.slots).map((n) => n.name);
  return side.slots.map((s, i) => {
    if (s.kind !== 'bot') return '';
    const bot = teamBot(s.botId)!;
    const t = side.tactics[i] || emptyTactic();
    const adv = validateAdvanced(t.advanced, bot, names[i], mode, map);
    const lines = [...basicLines(bot, names[i], t, mode, mode === 5 && i === 0), ...expandAdvanced(bot, names[i], adv.lines)];
    if (bot.id === 'team-astra' && mode === 4) {
      side.slots.forEach((_, j) => {
        const tj = side.tactics[j];
        if (j !== i && tj?.point) lines.push(`lane ${names[j]} ${tj.point}`);
      });
    }
    return lines.join('\n');
  });
}

// ---------------------------------------------------------------- 预设（上游 6 回合 × 2 队 × 3 套）

export interface TeamPresetSet {
  variant: string; // 正式 / 备选1 / 备选2
  spawns: Record<string, [number, number]>;
  king: string | null;
  plan: string;
}
export interface TeamPresetRound {
  round: number;
  mode: TeamModeNum;
  map: TeamMapId;
  teams: Record<OrigTeam, TeamPresetSet[]>;
}

let presetCache: Promise<TeamPresetRound[]> | null = null;
export function loadTeamPresets(): Promise<TeamPresetRound[]> {
  presetCache ??= fetch(`/assets/team/presets.json?v=${typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : ''}`)
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => []);
  return presetCache;
}
export function setTeamPresetsForTest(rounds: TeamPresetRound[]) {
  presetCache = Promise.resolve(rounds);
}

/**
 * 把一套原版战术单拆到五个席位：基础选项（点 / 职责）进按钮，其余行（去掉名字）进各自的高级指令；
 * 写给 ALL / all 的行每人一份。返回按原版短名索引的战术。
 */
export function splitPresetPlan(team: OrigTeam, plan: string, mode: TeamModeNum, king: string | null): Record<string, SlotTactic> {
  const out: Record<string, SlotTactic> = {};
  const names = TEAM_ROSTER[team].map((id) => teamBot(id)!.name);
  const adv: Record<string, string[]> = {};
  for (const n of names) {
    out[n] = emptyTactic();
    adv[n] = [];
  }
  for (const raw of plan.split('\n')) {
    const tok = raw.trim().split(/\s+/).filter(Boolean);
    if (!tok.length) continue;
    if (team === 'astra') {
      if (tok.length !== 3) continue;
      const [cmd, who, val] = tok;
      if (who === 'ALL') {
        for (const n of names) adv[n].push(`${cmd} ALL ${val}`);
        continue;
      }
      if (!out[who]) continue;
      const t = out[who];
      if (mode === 4 && cmd === 'lane' && ['A', 'B', 'C'].includes(val)) t.point = val as PointName;
      else if (mode === 4 && cmd === 'flex' && (val === 'HOLD' || val === 'ROAM')) t.job = val === 'HOLD' ? 'guard' : 'roam';
      else if (mode === 5 && cmd === 'role' && (val === 'HUNT' || val === 'GUARD')) t.job = val === 'HUNT' ? 'hunt' : 'guard';
      else adv[who].push(`${cmd} ${val}`);
    } else {
      const who = tok[0];
      const pairs = tok.slice(1);
      const targets = who === 'all' ? names : out[who] ? [who] : [];
      for (const n of targets) {
        const t = out[n];
        const rest: string[] = [];
        for (const kv of pairs) {
          const [k, v] = kv.split('=');
          if (mode === 4 && k === 'pt' && ['A', 'B', 'C'].includes(v) && who !== 'all') t.point = v as PointName;
          else if (mode === 4 && k === 'job' && (v === 'hold' || v === 'roam') && who !== 'all') t.job = v === 'hold' ? 'guard' : 'roam';
          else if (mode === 5 && k === 'job' && who !== 'all' && ['guard', 'hunt', 'safe', 'fight'].includes(v)) {
            const isKing = n === king;
            if (isKing ? v === 'safe' || v === 'fight' : v === 'guard' || v === 'hunt') t.job = v === 'guard' || v === 'safe' ? 'guard' : 'hunt';
            else rest.push(kv);
          } else rest.push(kv);
        }
        if (rest.length) adv[n].push(who === 'all' ? `all ${rest.join(' ')}` : rest.join(' '));
      }
    }
  }
  for (const n of names) out[n].advanced = adv[n].join('\n');
  return out;
}

// ---------------------------------------------------------------- 布阵（米，按本队在左写）

export type SpawnM = [number, number];

/** 地图文件里的默认站位（SPAWN 行），按左队写的米数。 */
export function defaultSpawnsFromMap(mapText: string, mode: TeamModeNum): SpawnM[] {
  const m = mapText.match(new RegExp(`^SPAWN\\s+${mode}\\s+(.+)$`, 'm'));
  const nums = m ? m[1].trim().split(/\s+/).map(Number) : [];
  const out: SpawnM[] = [];
  for (let k = 0; k < 5; k++) out.push([nums[2 * k] ?? 3, nums[2 * k + 1] ?? 3]);
  return out;
}

export interface MapGrid {
  nx: number;
  ny: number;
  cells: string[]; // 每行一个字符串：. 地面 # 墙 ~ 坑 " 草丛
}

export function parseMapGrid(mapText: string): MapGrid {
  const lines = mapText.replace(/\r/g, '').split('\n');
  const gi = lines.findIndex((l) => /^GRID\s/.test(l));
  const [, a, b] = lines[gi].trim().split(/\s+/);
  const nx = Number(a), ny = Number(b ?? a);
  return { nx, ny, cells: lines.slice(gi + 1, gi + 1 + ny) };
}

const BODY_R_M = 0.4;
const CELL_M = 0.5;

/** 圆心所在地形（按规则第 3 节：碰到的格子全一样才算那种，压线算地面） */
function terrainAt(g: MapGrid, x: number, y: number): string {
  const xs = [Math.floor(x / CELL_M)];
  const ys = [Math.floor(y / CELL_M)];
  if (Number.isInteger(x / CELL_M)) xs.push(x / CELL_M - 1);
  if (Number.isInteger(y / CELL_M)) ys.push(y / CELL_M - 1);
  const kinds = new Set<string>();
  for (const cx of xs) for (const cy of ys) kinds.add(cx < 0 || cy < 0 || cx >= g.nx || cy >= g.ny ? '~' : g.cells[cy][cx]);
  return kinds.size === 1 ? [...kinds][0] : '.';
}

function circleHitsWall(g: MapGrid, x: number, y: number): boolean {
  const cx = Math.floor(x / CELL_M), cy = Math.floor(y / CELL_M);
  for (let gy = cy - 1; gy <= cy + 1; gy++)
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      if (gx < 0 || gy < 0 || gx >= g.nx || gy >= g.ny || g.cells[gy][gx] !== '#') continue;
      const qx = Math.min(Math.max(x, gx * CELL_M), (gx + 1) * CELL_M);
      const qy = Math.min(Math.max(y, gy * CELL_M), (gy + 1) * CELL_M);
      if ((x - qx) ** 2 + (y - qy) ** 2 < BODY_R_M ** 2 - 1e-9) return true;
    }
  return false;
}

/** 一个站位能不能站：在布阵区里、站在地面或草丛上、身体不碰墙。 */
export function spawnProblem(g: MapGrid, map: TeamMapDef, p: SpawnM): string | null {
  const [x0, y0, x1, y1] = map.deploy;
  if (p[0] < x0 || p[0] > x1 || p[1] < y0 || p[1] > y1) return '不在布阵区里';
  const t = terrainAt(g, p[0], p[1]);
  if (t !== '.' && t !== '"') return t === '#' ? '在墙里' : '在坑上';
  if (circleHitsWall(g, p[0], p[1])) return '身体碰到墙';
  return null;
}

/** 五人站位的全部问题（下标 → 原因）；队友两两至少 1 米。 */
export function formationProblems(g: MapGrid, map: TeamMapDef, spawns: SpawnM[]): Map<number, string> {
  const out = new Map<number, string>();
  spawns.forEach((p, i) => {
    const e = spawnProblem(g, map, p);
    if (e) out.set(i, e);
  });
  for (let i = 0; i < spawns.length; i++)
    for (let j = 0; j < i; j++) {
      const d = Math.hypot(spawns[i][0] - spawns[j][0], spawns[i][1] - spawns[j][1]);
      if (d < 1 - 1e-9) {
        if (!out.has(i)) out.set(i, '和队友离得不到 1 米');
        if (!out.has(j)) out.set(j, '和队友离得不到 1 米');
      }
    }
  return out;
}

export const roundSpawn = (v: number) => Math.round(v * 10) / 10;

// ---------------------------------------------------------------- 交给引擎

export interface TeamSideConfig {
  slots: TeamSlotDraft[];
  tactics: SlotTactic[];
  spawns: SpawnM[]; // 米，按本队在左写
  label: string;
}

export interface TeamMatchSetup {
  mapId: TeamMapId;
  mode: TeamModeNum;
  sides: [TeamSideConfig, TeamSideConfig];
}

const hex = (s: string) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('');

/** 引擎 engine_init_team 的 form 文本（见 wasm/engine_wasm.cpp）。 */
export function engineFormText(setup: TeamMatchSetup): string {
  const map = teamMap(setup.mapId);
  const W = map.widthM, H = map.heightM;
  const names: string[] = [];
  const xy: number[] = [];
  const plans: string[] = [];
  const protos: number[] = [];
  setup.sides.forEach((side, s) => {
    slotNames(side.slots).forEach((n) => names.push(n.name));
    side.spawns.forEach(([x, y]) => {
      const mx = Math.round(x * 10) * 100, my = Math.round(y * 10) * 100;
      xy.push(s ? W * 1000 - mx : mx, s ? H * 1000 - my : my);
    });
    buildSeatPlans(side, setup.mode, map).forEach((p) => plans.push(p));
    side.slots.forEach((sl) => protos.push(sl.kind === 'bot' ? (teamBot(sl.botId)!.team === 'astra' ? 1 : 2) : 0));
  });
  const out = [`NAMES ${names.join(' ')}`, `XY ${xy.join(' ')}`, 'KING 0 5', `PROTO ${protos.join(' ')}`];
  plans.forEach((p, k) => {
    if (p) out.push(`PLAN ${k} ${hex(p)}`);
  });
  return out.join('\n') + '\n';
}
