import type { TickSnapshot } from '../game/types';

const BLEND_MS = 125;
const SNAP_MM = 1500;

interface Point { x: number; y: number }

/** A render-space offset from the moving target, anchored to the last drawn pose. */
class CorrectionOffset {
  private shown: Point | null = null;
  private raw: Point | null = null;
  private dx = 0;
  private dy = 0;
  private started = 0;
  private useEndpoint = false;

  tick(target: Point, corrected: boolean, discontinuity: boolean, now: number) {
    this.useEndpoint = corrected;
    if (discontinuity) {
      this.dx = this.dy = 0;
      return;
    }
    if (!corrected || !this.shown || (target.x === this.raw?.x && target.y === this.raw.y)) return;
    this.dx = this.shown.x - target.x;
    this.dy = this.shown.y - target.y;
    if (Math.hypot(this.dx, this.dy) > SNAP_MM) this.dx = this.dy = 0;
    this.started = now;
  }

  draw<T extends Point>(prev: T, next: T, alpha: number, now: number): readonly [T, T] {
    const base = this.useEndpoint ? next : prev;
    const x = base.x + (next.x - base.x) * alpha;
    const y = base.y + (next.y - base.y) * alpha;
    const weight = Math.max(0, 1 - (now - this.started) / BLEND_MS);
    const dx = this.dx * weight;
    const dy = this.dy * weight;
    this.raw = { x, y };
    this.shown = { x: x + dx, y: y + dy };
    if (!dx && !dy && base.x === prev.x && base.y === prev.y) return [prev, next];
    return [{ ...prev, x: base.x + dx, y: base.y + dy }, { ...next, x: next.x + dx, y: next.y + dy }];
  }
}

export class PvpCorrectionSmoothing {
  private readonly seat: number;
  private readonly player = new CorrectionOffset();
  private readonly dart = new CorrectionOffset();

  constructor(remoteSeat: number, initial: TickSnapshot) {
    this.seat = remoteSeat;
    this.draw(initial, initial, 1, 0);
  }

  tick(old: TickSnapshot, next: TickSnapshot, rollback: boolean, now: number) {
    const seat = this.seat;
    const p = next.players[seat];
    const oldP = old.players[seat];
    const cut = next.over || !p.alive || p.alive !== oldP.alive || p.dashing !== oldP.dashing ||
      next.events.some((event) => event.name === 'DASH' && event.a === seat);
    // On an advancing tick, px/py is the corrected start of this stride.
    // An unrelated rollback can leave ordinary remote movement intact.
    const sameTick = next.t === old.t;
    if (!sameTick || cut || p.x !== oldP.x || p.y !== oldP.y || p.px !== oldP.px || p.py !== oldP.py) {
      const corrected = rollback && (next.t !== old.t + 1 || p.px !== oldP.x || p.py !== oldP.y || cut);
      this.player.tick(p, corrected, cut, now);
    }
    const dart = next.darts[seat];
    const oldDart = old.darts[seat];
    const dartCut = cut || dart.st !== oldDart.st;
    if (!sameTick || dartCut || dart.x !== oldDart.x || dart.y !== oldDart.y) {
      this.dart.tick(dart, rollback, dartCut, now);
    }
  }

  draw(prev: TickSnapshot, next: TickSnapshot, alpha: number, now: number) {
    const seat = this.seat;
    const [p0, p1] = this.player.draw(prev.players[seat], next.players[seat], alpha, now);
    const [d0, d1] = this.dart.draw(prev.darts[seat], next.darts[seat], alpha, now);
    const replace = (state: TickSnapshot, player: typeof p0, dart: typeof d0) => {
      if (player === state.players[seat] && dart === state.darts[seat]) return state;
      const players = state.players.slice();
      const darts = state.darts.slice();
      players[seat] = player;
      darts[seat] = dart;
      return { ...state, players, darts };
    };
    return { prev: replace(prev, p0, d0), next: replace(next, p1, d1) };
  }
}
