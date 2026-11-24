import { TickSnapshot } from '../game/types';

/**
 * Training ground status pill (replaces the match timer / collapse countdown, which the HUD hides in training):
 * what the mode is, plus running counters — knockdowns, darts blocked, hits taken, falls.
 */
export class TrainingPanel {
  private readonly el: HTMLDivElement;
  private readonly valEls: Record<'kills' | 'blocks' | 'hits' | 'falls', HTMLElement>;
  private blocks = 0;
  private hits = 0;
  private falls = 0;
  private lastHitTick = new Map<string, number>();

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'training-panel hidden';
    this.el.innerHTML = `
      <div class="tp-head"><span class="tp-title">🎯 训练场</span></div>
      <div class="tp-stats">
        <span class="tp-stat"><b data-tp="kills">0</b>击倒</span>
        <span class="tp-stat"><b data-tp="blocks">0</b>挡镖</span>
        <span class="tp-stat"><b data-tp="hits">0</b>受击</span>
        <span class="tp-stat"><b data-tp="falls">0</b>落水</span>
        <span class="tp-exit-hint">ESC / 主界面 退出</span>
      </div>`;
    root.appendChild(this.el);
    const q = (k: string) => this.el.querySelector<HTMLElement>(`[data-tp="${k}"]`)!;
    this.valEls = { kills: q('kills'), blocks: q('blocks'), hits: q('hits'), falls: q('falls') };
  }

  public show(mobile: boolean) {
    this.blocks = 0;
    this.hits = 0;
    this.falls = 0;
    this.lastHitTick.clear();
    for (const v of Object.values(this.valEls)) v.textContent = '0';
    this.el.classList.toggle('is-mobile', mobile);
    this.el.classList.remove('hidden');
  }

  public setMobile(mobile: boolean) {
    this.el.classList.toggle('is-mobile', mobile);
  }

  public hide() {
    this.el.classList.add('hidden');
  }

  public onTick(state: TickSnapshot, humanSeat: number) {
    if (humanSeat < 0) return;
    for (const ev of state.events) {
      if (ev.name === 'BLOCK' && ev.a === humanSeat) this.blocks++;
      else if (ev.name === 'FALL' && ev.a === humanSeat) this.falls++;
      else if ((ev.name === 'HIT' || ev.name === 'CUT') && ev.b === humanSeat) {
        // nothing dies in training, so one slash window / one dart passing through (or hanging at its turn point)
        // reports on consecutive ticks: count it once
        const key = `${ev.name}:${ev.a}`;
        const last = this.lastHitTick.get(key) ?? -999;
        this.lastHitTick.set(key, state.t);
        if (state.t - last > 6) this.hits++;
      }
    }
    this.valEls.kills.textContent = String(state.players[humanSeat]?.kills ?? 0);
    this.valEls.blocks.textContent = String(this.blocks);
    this.valEls.hits.textContent = String(this.hits);
    this.valEls.falls.textContent = String(this.falls);
  }
}
