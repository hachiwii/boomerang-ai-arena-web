// 右上角击杀播报（CS 式）：每行「凶手 [方式] 受害者」，约 5 秒淡出，最多 5 行（手机 3 行），最新在最上面。
// 方式：回旋镖 / 近战 / 坠落。坠落有凶手 = 被踢下去（引擎把滑行到最后一步落坑记给踢的人），
// 没有凶手 = 自己走下去、冲刺冲下去或脚下塌陷，只显示「[坠落] 受害者」。
// 只在 3～4 人混战和 5v5 团队赛里出现；混战里自己蓝色、其他人红色，团队赛按队伍颜色。

import { CauseType, type GameEvent, type MatchMode, type SlotConfig, type TickSnapshot } from '../game/types';
import { SIDE_COLOR } from '../game/teamMatch';
import { ICON_BOOMERANG } from './icons';

export type KillFeedIcon = 'dart' | 'melee' | 'fall';

export interface KillFeedName {
  name: string;
  color: string;
}

export interface KillFeedEntry {
  /** null：没有凶手（自己摔下去 / 地形塌陷） */
  killer: KillFeedName | null;
  victim: KillFeedName;
  icon: KillFeedIcon;
  /** 被踢下去（坠落且有凶手） */
  kick: boolean;
  /** 自己是凶手或受害者 */
  mine: boolean;
  /** 刺王：国王掉了一条命（没出局），剩几条 */
  livesLeft?: number;
}

export interface KillFeedContext {
  slots: SlotConfig[];
  team: boolean;
  /** 自己的座位（观战 -1） */
  selfSeat: number;
}

/** 3～4 人混战（排位混战、自定义、斗蛐蛐）和 5v5 团队赛；1v1、PvP、训练不显示 */
export function killFeedEnabled(matchMode: MatchMode, slotCount: number): boolean {
  if (matchMode === 'team') return true;
  if (matchMode === 'training' || matchMode === 'pvp' || matchMode === 'ranked-solo') return false;
  return slotCount >= 3;
}

function seatName(ctx: KillFeedContext, seat: number): KillFeedName {
  const slot = ctx.slots[seat];
  const name = slot?.displayName || `P${seat + 1}`;
  if (ctx.team) return { name, color: SIDE_COLOR[slot?.side ?? (seat < 5 ? 0 : 1)] };
  return { name, color: seat === ctx.selfSeat ? SIDE_COLOR[0] : SIDE_COLOR[1] };
}

/** DEATH 事件（a 受害者座位，b 死因 CauseType，c 凶手座位，<0 没有）→ 一行播报 */
export function buildKillEntry(ev: Pick<GameEvent, 'a' | 'b' | 'c'>, ctx: KillFeedContext): KillFeedEntry | null {
  const victimSeat = ev.a;
  if (!(victimSeat >= 0)) return null;
  const killerSeat = ev.c >= 0 && ev.c !== victimSeat ? ev.c : -1;
  const icon: KillFeedIcon = ev.b === CauseType.DART ? 'dart' : ev.b === CauseType.SLASH ? 'melee' : 'fall';
  return {
    killer: killerSeat >= 0 ? seatName(ctx, killerSeat) : null,
    victim: seatName(ctx, victimSeat),
    icon,
    kick: icon === 'fall' && killerSeat >= 0,
    mine: ctx.selfSeat >= 0 && (victimSeat === ctx.selfSeat || killerSeat === ctx.selfSeat),
  };
}

// 原创小图标（白色，跟随 currentColor）
const KILL_FEED_ICONS: Record<KillFeedIcon, string> = {
  // 回旋镖：游戏里的三叶回旋镖，和 3D 模型同一套体素（白叶片、阴影边、暖色叶尖、白环 + 深色轴心）
  dart: ICON_BOOMERANG,
  // 近战：一道月牙形的挥砍弧光
  melee: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.2 20.4C6.4 11.6 12.4 5.6 21 3.2 15.6 7.2 10.8 12.6 7.4 21.2Z" fill="currentColor"/><path d="M14.8 15.6l3.6 1.2M17.4 12.4l3.2-.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity=".6"/></svg>`,
  // 坠落：崖边 + 向下的箭头
  fall: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 9.5H10v12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M16.5 3.5v13M12.5 12.5l4 4.5 4-4.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

const ICON_TITLE: Record<KillFeedIcon, string> = { dart: '回旋镖', melee: '近战', fall: '坠落' };
const MAX_LINES = 5; // 手机上 CSS 只显示最新 3 行

export class KillFeed {
  private readonly el: HTMLDivElement;
  private below: HTMLElement | null = null;
  private ctx: KillFeedContext | null = null;
  private lastT: number | null = null;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'kill-feed';
    this.el.setAttribute('aria-live', 'polite');
  }

  /** 放进 HUD 根节点；行从 `below`（顶栏）的下沿开始往下排，避开右上角按钮和比分 */
  public attach(root: HTMLElement, below: HTMLElement) {
    this.below = below;
    root.appendChild(this.el);
  }

  /** 新对局 / 新回放：清空并按模式开关。touch = 手机对局里有右侧触屏按键，整列往左让开 */
  public reset(matchMode: MatchMode, slots: SlotConfig[], selfSeat: number, touch = false) {
    this.clear();
    this.lastT = null;
    this.ctx = killFeedEnabled(matchMode, slots.length) ? { slots, team: matchMode === 'team', selfSeat } : null;
    this.el.classList.toggle('is-touch', touch);
    this.el.classList.remove('is-paused');
  }

  public clear() {
    this.el.replaceChildren();
  }

  /** 回放暂停时冻结淡出 */
  public setPaused(paused: boolean) {
    this.el.classList.toggle('is-paused', paused);
  }

  /**
   * 每个逻辑步调用一次。strict（回放）：只有前进正好一步才播报，拖进度条 / 重播 / 跳转就清空，免得刷屏；
   * 对局里只要往前走就播报。同一步重复调用忽略。
   */
  public tick(state: TickSnapshot, strict: boolean) {
    if (!this.ctx) return;
    const last = this.lastT;
    this.lastT = state.t;
    if (last === null || state.t === last) return;
    if (state.t < last || (strict && state.t !== last + 1)) {
      this.clear();
      return;
    }
    for (const ev of state.events || []) {
      if (ev.name === 'DEATH') {
        const entry = buildKillEntry(ev, this.ctx);
        if (entry) this.push(entry);
      } else if (ev.name === 'LIFE') {
        // 刺王：国王掉命（a 国王，b 剩余命数，c 凶手，d 死因）；最后一条命走 DEATH
        const entry = buildKillEntry({ a: ev.a, b: ev.d, c: ev.c }, this.ctx);
        if (entry) this.push({ ...entry, livesLeft: ev.b });
      }
    }
  }

  public push(entry: KillFeedEntry) {
    if (this.below) this.el.style.setProperty('--kf-top', `${this.below.offsetTop + this.below.offsetHeight + 8}px`);
    const line = document.createElement('div');
    line.className = `kill-feed-line${entry.mine ? ' is-mine' : ''}`;
    if (entry.killer) line.appendChild(nameEl(entry.killer));
    const icon = document.createElement('span');
    icon.className = `kill-feed-icon kf-${entry.icon}`;
    icon.title = entry.kick ? '踢下去' : ICON_TITLE[entry.icon];
    icon.innerHTML = KILL_FEED_ICONS[entry.icon];
    line.appendChild(icon);
    line.appendChild(nameEl(entry.victim));
    if (entry.livesLeft !== undefined) {
      const lives = document.createElement('span');
      lives.className = 'kill-feed-lives';
      lives.textContent = `♥${entry.livesLeft}`;
      lives.title = `国王还剩 ${entry.livesLeft} 条命`;
      line.appendChild(lives);
    }
    line.addEventListener('animationend', (e) => {
      if (e.target === line) line.remove();
    });
    this.el.prepend(line);
    while (this.el.childElementCount > MAX_LINES) this.el.lastElementChild?.remove();
  }
}

function nameEl(n: KillFeedName): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = 'kill-feed-name';
  s.style.color = n.color;
  s.textContent = n.name;
  return s;
}
