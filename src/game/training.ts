import { DState, MapMeta, MatchConfig, PState, SlotConfig, TickSnapshot } from './types';

/**
 * Training ground (训练场): a fixed 8-seat layout on its own map, played through `engine_init_training`
 * (WASM engine: invincible player that is put back on the nearest ground after a fall, dummies that revive
 * 2 s after dying, anchored + invincible dart dummies, no collapse, no time limit).
 *
 * Seats: 0 player · 1-3 strike-zone scarecrows · 4-5 lakeside scarecrows · 6 dart scarecrow (stone lane) ·
 * 7 dart scarecrow (open lane). The dart scarecrows are driven by {@link TrainingDummyBrain}.
 */
export const TRAINING_MAP_URL = '/assets/training/training.txt';
export const TRAINING_SEATS = 8;
export const DART_DUMMY_SEATS = [6, 7] as const;
export const SCARECROW_CHAR_KEY = 'scarecrow';

const MAP_META: MapMeta = {
  id: 'training',
  title: '训练场',
  theme: 'meadow',
  category: 'standard',
  nx: 64,
  ny: 32,
  desc: '训练场：击打区、走位区、镖区',
  previewGrid: [],
};

function scarecrowAvatar(ring: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" rx="14" fill="${ring}"/>` +
    `<path d="M8 27h48v6H8z" fill="#C49B3A"/>` +
    `<path d="M18 21h28v-8a4 4 0 0 0-4-4H22a4 4 0 0 0-4 4z" fill="#E2BB57"/><path d="M18 17h28v4H18z" fill="#3F6FB0"/>` +
    `<path d="M20 27h24v20a6 6 0 0 1-6 6H26a6 6 0 0 1-6-6z" fill="#DDBA80"/>` +
    `<circle cx="27" cy="37" r="2.6" fill="#2E2238"/><circle cx="37" cy="37" r="2.6" fill="#2E2238"/>` +
    `<path d="M31 40h3l-1.5 4z" fill="#E8812F"/><path d="M26 47h12" stroke="#5A3A2A" stroke-width="1.6"/>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function dummySlot(name: string, color: string): SlotConfig {
  return {
    kind: 'bot',
    charKey: SCARECROW_CHAR_KEY,
    baseName: name,
    displayName: name,
    color,
    ringAccent: color,
    avatar: scarecrowAvatar(color),
  };
}

export function createTrainingConfig(human: SlotConfig): MatchConfig {
  const slots: SlotConfig[] = [
    { ...human },
    dummySlot('稻草人 1', '#D9A93A'),
    dummySlot('稻草人 2', '#D9A93A'),
    dummySlot('稻草人 3', '#D9A93A'),
    dummySlot('湖边稻草人', '#4FA9C9'),
    dummySlot('湖边稻草人', '#4FA9C9'),
    dummySlot('飞镖稻草人 · 挡石', '#E0663F'),
    dummySlot('飞镖稻草人 · 直线', '#E0663F'),
  ];
  return {
    matchMode: 'training',
    mapId: MAP_META.id,
    mapMeta: MAP_META,
    slots,
    seed: 0,
    speed: 1.0,
    cliffGuard: false,
    dashGuard: false,
  };
}

/** `// TREES x,y x,y ...` comment lines in the map file → wall cell indices drawn as trees. */
export function parseTreeCells(mapText: string, nx: number): number[] {
  const out: number[] = [];
  for (const line of mapText.split('\n')) {
    const m = /^\s*\/\/\s*TREES\s+(.*)$/.exec(line);
    if (!m) continue;
    for (const tok of m[1].trim().split(/\s+/)) {
      const [xs, ys] = tok.split(',');
      const x = Number(xs);
      const y = Number(ys);
      if (Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < nx && y >= 0) out.push(y * nx + x);
    }
  }
  return out;
}

const NO_ACTION = '0 0 0 0 0 0';

/**
 * Drives the two dart scarecrows: throw straight ahead (west) at a randomised interval while the dart is in hand,
 * recall it a moment after it lands (the stone lane), otherwise let it fly back on its own (the open lane).
 */
export class TrainingDummyBrain {
  private nextThrowT = new Map<number, number>();
  private groundSinceT = new Map<number, number>();

  reset() {
    this.nextThrowT.clear();
    this.groundSinceT.clear();
  }

  private scheduleThrow(seat: number, t: number, first = false) {
    // 1.4 – 3.2 s between throws (first throw staggered so the two lanes desync)
    const base = first ? (seat === DART_DUMMY_SEATS[0] ? 20 : 44) : 28;
    const spread = first ? 16 : 36;
    this.nextThrowT.set(seat, t + base + Math.floor(Math.random() * (spread + 1)));
  }

  /** Writes action lines for the dart dummies into `lines` (indexed by seat) for the step after `state`. */
  decide(state: TickSnapshot, lines: string[]) {
    for (const seat of DART_DUMMY_SEATS) {
      const p = state.players[seat];
      const d = state.darts[seat];
      if (!p || !d || !p.alive) continue;
      lines[seat] = NO_ACTION;
      if (d.st === DState.HAND) {
        this.groundSinceT.delete(seat);
        const due = this.nextThrowT.get(seat);
        if (due === undefined) {
          this.scheduleThrow(seat, state.t, state.t < 5);
        } else if (state.t >= due && p.st === PState.FREE) {
          lines[seat] = '0 0 1 -1000 0 0';
          this.nextThrowT.delete(seat);
        }
      } else if (d.st === DState.GROUND) {
        const since = this.groundSinceT.get(seat);
        if (since === undefined) this.groundSinceT.set(seat, state.t);
        else if (state.t - since >= 8 && p.st === PState.FREE) lines[seat] = '0 0 4 0 0 0';
      } else {
        this.groundSinceT.delete(seat);
      }
    }
  }
}
