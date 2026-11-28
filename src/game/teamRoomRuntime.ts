// 团队赛联机对局的两端：
//  - RoomHostNet：房主一侧，收别人的操作填进他们的座位，每一步把 10 行动作发给中转。
//  - TeamGuestController：其他人一侧，用自己的引擎按房主发来的动作重放（不跑 bot），把自己的操作发给房主。
import type { HumanInputController } from './humanInput';
import type { MatchCallbacks, TeamHostNet } from './matchController';
import { engineFormText } from './teamMatch';
import { ActType, LOGIC_DT_MS, LOGIC_HZ, type EngineMapData, type MatchConfig, type TickSnapshot } from './types';
import type { RoomAction } from '../net/teamRoomProtocol';
import { trackMatchStart } from '../net/analytics';

const NEUTRAL_LINE = '0 0 0 0 0 0';

/** 房主一侧：最新的移动 / 瞄准一直沿用；扔镖、近战、冲刺这种一下的操作保留到被某一步用掉；召回按住才有。 */
export class RoomHostNet implements TeamHostNet {
  private latest = new Map<number, RoomAction>();
  private oneShot = new Map<number, RoomAction>();
  private fresh = new Set<number>();

  constructor(
    private readonly seats: (number | null)[],
    private readonly sendFrame: (frame: number, acts: string) => void,
  ) {}

  onInput(from: number, action: RoomAction) {
    const seat = this.seats.findIndex((id) => id === from);
    if (seat < 0) return;
    this.latest.set(seat, action);
    this.fresh.add(seat);
    const act = action[2];
    if (act === ActType.THROW || act === ActType.MELEE || act === ActType.DASH) this.oneShot.set(seat, action);
  }

  remoteAction(seat: number): string {
    const a = this.latest.get(seat);
    if (!a) return NEUTRAL_LINE;
    const shot = this.oneShot.get(seat);
    this.oneShot.delete(seat);
    const wasFresh = this.fresh.delete(seat);
    if (shot) return `${a[0]} ${a[1]} ${shot[2]} ${shot[3]} ${shot[4]} ${a[5]}`;
    // 召回是按住的：最新一条还是召回就继续；其他情况这一步不带动作
    const act = a[2] === ActType.RECALL && wasFresh ? ActType.RECALL : ActType.NONE;
    return `${a[0]} ${a[1]} ${act} ${act ? a[3] : 0} ${act ? a[4] : 0} ${a[5]}`;
  }

  onFrame(frame: number, actionsText: string) {
    this.sendFrame(frame, actionsText);
  }
}

export interface TeamGuestCallbacks extends MatchCallbacks {
  /** 房主中途结束了对局（或房主离开）：回到大厅 */
  onAborted: (reason?: string) => void;
}

/** 其他人一侧的对局：init 和房主一样的引擎（同一份开局信息），按收到的每一步动作重放。 */
export class TeamGuestController {
  private worker: Worker | null = null;
  private reqId = 0;
  private current: TickSnapshot | null = null;
  private history: TickSnapshot[] = [];
  private queue: string[] = [];
  private received = 0;
  private timer: number | null = null;
  private countdownTimer: number | null = null;
  private stepping = false;
  private loaded = false;
  private stopped = false;
  private finished = false;
  private readonly baseIntervalMs: number;
  private readonly mySeat: number;
  public actualLogicHz = LOGIC_HZ;
  private tickTimes: number[] = [];

  constructor(
    private readonly input: HumanInputController,
    private readonly config: MatchConfig,
    private readonly callbacks: TeamGuestCallbacks,
    private readonly sendInput: (action: RoomAction) => void,
  ) {
    this.baseIntervalMs = LOGIC_DT_MS / Math.max(0.1, Math.min(2, config.speed || 1));
    this.mySeat = config.teamRoom?.mySeat ?? -1;
  }

  getHumanSeat() { return this.mySeat; }
  getRecordedTicks() { return this.history; }
  getTickIntervalMs() { return this.baseIntervalMs; }
  getCurrentState() { return this.current; }
  isFinished() { return this.finished; }
  matchId() { return this.config.teamRoom?.matchId ?? ''; }

  private rpc(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const w = this.worker!;
    return new Promise((resolve, reject) => {
      const reqId = ++this.reqId;
      const onMsg = (ev: MessageEvent) => {
        const d = ev.data;
        if (!d || d.reqId !== reqId) return;
        w.removeEventListener('message', onMsg);
        if (d.type === 'error') reject(new Error(d.error || 'Worker error'));
        else resolve(d);
      };
      w.addEventListener('message', onMsg);
      w.postMessage({ ...payload, reqId });
    });
  }

  async start(): Promise<void> {
    const config = this.config;
    const team = config.team!;
    trackMatchStart(config.matchMode);
    this.callbacks.onStatus?.('加载地图与引擎 WASM...');
    const origin = window.location.origin;
    const resp = await fetch(`${origin}/assets/maps/team/${config.mapId}.txt?v=${__BUILD_ID__}`);
    if (!resp.ok) throw new Error(`无法加载地图 ${config.mapId}`);
    const mapText = await resp.text();
    if (this.stopped) return;
    this.worker = new Worker(new URL('../workers/engineWorker.ts', import.meta.url), { type: 'module' });
    const res = await this.rpc({
      type: 'init',
      origin,
      buildId: __BUILD_ID__,
      mapText,
      nPlayers: config.slots.length,
      seed: config.seed,
      spawnSeed: config.spawnSeed ?? 0,
      botSeats: [],
      humanSeat: this.mySeat,
      humanSeats: config.slots.reduce((m, s, i) => (s.kind === 'human' ? m | (1 << i) : m), 0),
      cliffGuard: config.dashGuard ?? config.cliffGuard,
      walkGuard: config.cliffGuard,
      meleeAssist: config.meleeAssist ?? true,
      humanSlashTicks: config.humanSlashTicks ?? 3,
      team: { mode: team.mode, formText: engineFormText(team) },
    });
    if (this.stopped) return;
    const mapData = res.mapData as EngineMapData;
    const initial = res.state as TickSnapshot;
    initial.timestampMs = performance.now();
    this.current = initial;
    this.history = [initial];
    await this.callbacks.onMapLoaded(mapData, initial, null);
    if (this.stopped) return;
    this.input.reset();
    this.input.setMapData(mapData);
    this.input.setTickIntervalMs(this.baseIntervalMs);
    this.input.setFixedMatchRules({ meleeAssist: config.meleeAssist ?? true, humanSlashTicks: config.humanSlashTicks ?? 3, bulletTime: false });
    this.loaded = true;
    if (this.queue.length > 0) {
      // 中途加入：已经开打了，不倒计时
      this.input.setInputMode(this.mySeat >= 0 ? 'active' : 'off');
      this.callbacks.onCountdown?.(null);
      this.schedule(0);
      return;
    }
    // 和房主一样的 3 秒倒计时（房主那边的倒计时也在走，第一步动作大约在 GO 时到）
    this.input.setInputMode(this.mySeat >= 0 ? 'countdown' : 'off');
    const stages: (3 | 2 | 1 | 'GO' | null)[] = [3, 2, 1, 'GO', null];
    let i = 0;
    const next = () => {
      if (this.stopped) return;
      const st = stages[i++];
      this.callbacks.onCountdown?.(st);
      if (st === 'GO') this.goLive();
      if (i < stages.length) this.countdownTimer = window.setTimeout(next, st === 'GO' ? 550 : 1000);
    };
    next();
  }

  private goLive() {
    if (this.stopped || this.finished) return;
    if (this.mySeat >= 0) this.input.setInputMode('active');
    this.schedule(0);
  }

  /** 收到房主发来的若干步动作（from = 第一步的序号） */
  pushFrames(from: number, acts: string[]) {
    if (this.stopped || this.finished) return;
    for (let i = 0; i < acts.length; i++) {
      if (from + i !== this.received) continue; // 重复或乱序（TCP 不会乱序，只防重复）
      this.queue.push(acts[i]);
      this.received++;
    }
    if (this.loaded && this.timer === null && !this.stepping && this.queue.length > 0) {
      // 倒计时结束前到的第一步：直接开始
      if (this.mySeat >= 0 && this.input.getInputMode() === 'countdown') this.input.setInputMode('active');
      this.callbacks.onCountdown?.(null);
      this.schedule(0);
    }
  }

  private schedule(delayMs: number) {
    if (this.timer !== null || this.stopped || this.finished) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, Math.max(0, delayMs));
  }

  private async tick() {
    if (this.stopped || this.finished || this.stepping || !this.current) return;
    if (this.queue.length === 0) return; // 等下一批（pushFrames 会再排）
    this.stepping = true;
    try {
      // 落后太多（网络抖动或中途加入）：前面的一口气算完，只画最后几步
      while (this.queue.length > 6) {
        const res = await this.rpc({ type: 'step', actionsText: this.queue.shift()!, botSeats: [] });
        if (this.stopped) return;
        const st = res.state as TickSnapshot;
        st.timestampMs = performance.now();
        st.events = st.events ?? [];
        this.history.push(st);
        this.current = st;
        if (st.over) break;
      }
      const prev = this.current;
      let next = prev;
      if (!prev.over && this.queue.length > 0) {
        const res = await this.rpc({ type: 'step', actionsText: this.queue.shift()!, botSeats: [] });
        if (this.stopped) return;
        next = res.state as TickSnapshot;
        next.timestampMs = performance.now();
        this.history.push(next);
        this.current = next;
      }
      const backlog = this.queue.length;
      // 有积压就稍微快一点追上，没有就按房主的节奏
      const interval = this.baseIntervalMs * (backlog > 3 ? 0.5 : backlog > 1 ? 0.8 : 1);
      const now = performance.now();
      this.tickTimes.push(now);
      while (this.tickTimes.length > 21) this.tickTimes.shift();
      if (this.tickTimes.length >= 2) {
        const span = this.tickTimes[this.tickTimes.length - 1] - this.tickTimes[0];
        if (span > 0) this.actualLogicHz = ((this.tickTimes.length - 1) * 1000) / span;
      }
      if (next !== prev) this.callbacks.onTick(prev, next, interval);
      if (next.over) {
        this.finished = true;
        this.input.setEnabled(false);
        this.callbacks.onMatchOver(next);
        return;
      }
      if (this.mySeat >= 0) {
        const a = this.input.sampleAction(next, this.mySeat);
        this.sendInput([a.mx, a.my, a.act, a.ax, a.ay, a.msg]);
      }
      this.stepping = false;
      if (this.queue.length > 0) this.schedule(interval);
    } catch (err) {
      this.callbacks.onError?.(err instanceof Error ? err.message : String(err));
    } finally {
      this.stepping = false;
    }
  }

  /** 房主结束了这局：正常结束等自己算到最后一步；中途结束就回大厅 */
  end(aborted: boolean, reason?: string) {
    if (!aborted || this.finished) return;
    this.stop();
    this.callbacks.onAborted(reason);
  }

  stop() {
    this.stopped = true;
    if (this.timer !== null) window.clearTimeout(this.timer);
    if (this.countdownTimer !== null) window.clearTimeout(this.countdownTimer);
    this.timer = null;
    this.countdownTimer = null;
    this.worker?.terminate();
    this.worker = null;
    this.input.setFixedMatchRules(null);
  }
}
