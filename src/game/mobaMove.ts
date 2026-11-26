// MOBA-scheme movement (PC): a clicked ground point becomes per-tick move vectors. Pure input layer — the engine
// only ever receives ordinary {mx, my} walking input, exactly like a held WASD direction.
//
// Paths are planned on a half-cell node grid (250 mm) over the live map: nodes must keep the body clear of walls
// (engine circle-vs-cell test) and the centre off pits (incl. cells collapsing within the next few ticks). The route
// is string-pulled to straight segments, followed waypoint by waypoint, and the last step is scaled so the body stops
// on the destination instead of overshooting. Clicking an unreachable spot (pit, wall, another island) walks to the
// reachable point nearest to it, like LoL.
import { CellType, EngineMapData, PlayerSnapshot } from './types';

const RUN_V = 250; // engine full walking speed (mm per tick); input magnitude 1000 = full speed
const ARRIVE_MM = 20;
const PIT_MARGIN = 100; // keep the body centre this far from pit cells
const WALL_PAD = 15; // extra clearance beyond the body radius when planning
const COLLAPSE_LOOKAHEAD = 6; // ticks: treat cells that are about to fall as pits already
const LINE_STEP = 100; // mm between line-of-sight samples
const STUCK_TICKS = 8;

type Pt = [number, number];

export class MobaMover {
  private target: Pt | null = null;
  private path: Pt[] = [];
  private idx = 0;
  private needPlan = false;
  private planKey = -1; // number of collapsed waves (incl. look-ahead) the path was planned against
  private replanned = false;
  private lastPos: Pt | null = null;
  private stuck = 0;

  // Node grid cache (rebuilt when the map or the collapse state changes)
  private grid: Uint8Array | null = null;
  private gridMap: EngineMapData | null = null;
  private gridKey = -1;
  private gw = 0;
  private gh = 0;
  private node = 250;

  hasTarget(): boolean {
    return this.target !== null;
  }

  getTarget(): Pt | null {
    return this.target;
  }

  /** Remaining waypoints (destination last), for debugging / tests. */
  getPath(): Pt[] {
    return this.path.slice(this.idx);
  }

  setTarget(x: number, y: number) {
    if (this.target && Math.hypot(this.target[0] - x, this.target[1] - y) < 1) return;
    this.target = [x, y];
    this.needPlan = true;
    this.replanned = false;
    this.stuck = 0;
  }

  clear() {
    this.target = null;
    this.path = [];
    this.idx = 0;
    this.needPlan = false;
    this.lastPos = null;
    this.stuck = 0;
  }

  /**
   * The move vector to send this tick (|v| ≤ 1000), or [0, 0] when there is nothing to do.
   * `walking` = the player can walk this tick (FREE): only then is lack of progress counted as stuck.
   */
  step(map: EngineMapData | null, t: number, me: PlayerSnapshot, walking: boolean): Pt {
    if (!this.target) return [0, 0];
    if (!map) return this.direct(me, this.target);

    const key = collapseKey(map, t + COLLAPSE_LOOKAHEAD);
    if (this.needPlan || key !== this.planKey) this.plan(map, t, me);

    // Arrived?
    const dest = this.path[this.path.length - 1] ?? this.target;
    if (Math.hypot(dest[0] - me.x, dest[1] - me.y) <= ARRIVE_MM) {
      this.clear();
      return [0, 0];
    }

    // Stuck detection (pushed into a corner, blocked by a body, …): re-plan once, then give up
    if (walking && this.lastPos && Math.hypot(me.x - this.lastPos[0], me.y - this.lastPos[1]) < 15) {
      if (++this.stuck >= STUCK_TICKS) {
        if (this.replanned) {
          this.clear();
          return [0, 0];
        }
        this.replanned = true;
        this.stuck = 0;
        this.plan(map, t, me);
      }
    } else if (walking) {
      this.stuck = 0;
    }
    this.lastPos = [me.x, me.y];

    // Advance past reached waypoints, and skip ahead whenever a later one is in clear sight
    const r = map.bodyR || 400;
    while (this.idx < this.path.length - 1) {
      const w = this.path[this.idx];
      if (Math.hypot(w[0] - me.x, w[1] - me.y) <= RUN_V * 0.6) {
        this.idx++;
        continue;
      }
      if (this.clearLine(map, t, me.x, me.y, this.path[this.idx + 1][0], this.path[this.idx + 1][1], r, 150)) {
        this.idx++;
        continue;
      }
      break;
    }
    const w = this.path[this.idx] ?? dest;
    const last = this.idx >= this.path.length - 1;
    return vectorTo(me.x, me.y, w[0], w[1], last);
  }

  private direct(me: PlayerSnapshot, to: Pt): Pt {
    if (Math.hypot(to[0] - me.x, to[1] - me.y) <= ARRIVE_MM) {
      this.clear();
      return [0, 0];
    }
    return vectorTo(me.x, me.y, to[0], to[1], true);
  }

  // ---------------------------------------------------------------- planning

  private plan(map: EngineMapData, t: number, me: PlayerSnapshot) {
    this.needPlan = false;
    this.planKey = collapseKey(map, t + COLLAPSE_LOOKAHEAD);
    this.idx = 0;
    this.lastPos = null;
    this.stuck = 0;
    const target = this.target!;
    this.ensureGrid(map, t);
    const r = map.bodyR || 400;
    const grid = this.grid!;
    const { gw, gh, node } = this;

    const nodeOf = (x: number, y: number): Pt => [
      Math.max(0, Math.min(gw - 1, Math.round(x / node))),
      Math.max(0, Math.min(gh - 1, Math.round(y / node))),
    ];
    // Start: the free node nearest to the body (it may stand closer to a wall than the planning margin)
    const start = this.nearestFree(nodeOf(me.x, me.y), me.x, me.y, 4);
    if (start < 0) {
      this.path = [target];
      return;
    }
    const goalGuess = this.nearestFree(nodeOf(target[0], target[1]), target[0], target[1], 6);

    // A* (8-neighbour, no corner cutting); if the goal is unreachable, walk to the explored node nearest the click
    const n = gw * gh;
    const g = new Float64Array(n).fill(Infinity);
    const from = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const heap = new MinHeap();
    const gx = (i: number) => i % gw;
    const gy = (i: number) => (i / gw) | 0;
    const hTo = goalGuess >= 0 ? goalGuess : start;
    const h = (i: number) => {
      const dx = Math.abs(gx(i) - gx(hTo));
      const dy = Math.abs(gy(i) - gy(hTo));
      return (Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)) * node;
    };
    g[start] = 0;
    heap.push(start, h(start));
    let best = start;
    let bestD = Infinity;
    let reached = -1;
    while (heap.size) {
      const i = heap.pop();
      if (closed[i]) continue;
      closed[i] = 1;
      const d = Math.hypot(gx(i) * node - target[0], gy(i) * node - target[1]);
      if (d < bestD - 1e-6 || (Math.abs(d - bestD) < 1e-6 && g[i] < g[best])) {
        best = i;
        bestD = d;
      }
      if (i === goalGuess) {
        reached = i;
        break;
      }
      const x = gx(i);
      const y = gy(i);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          const j = ny * gw + nx;
          if (!grid[j] || closed[j]) continue;
          if (dx && dy && (!grid[y * gw + nx] || !grid[ny * gw + x])) continue;
          const ng = g[i] + (dx && dy ? Math.SQRT2 : 1) * node;
          if (ng < g[j]) {
            g[j] = ng;
            from[j] = i;
            heap.push(j, ng + h(j));
          }
        }
      }
    }
    const end = reached >= 0 ? reached : best;
    const chain: Pt[] = [];
    for (let i = end; i >= 0; i = from[i]) chain.push([gx(i) * node, gy(i) * node]);
    chain.reverse();

    // Exact destination when the click itself is a valid standing spot in sight of the last node
    const lastNode = chain[chain.length - 1];
    if (
      reached >= 0 &&
      this.pointFree(map, t, target[0], target[1], r) &&
      this.clearLine(map, t, lastNode[0], lastNode[1], target[0], target[1], r, 0)
    ) {
      chain.push([target[0], target[1]]);
    }

    // String-pull from the body's real position
    const pts: Pt[] = [];
    let anchor: Pt = [me.x, me.y];
    let k = 0;
    while (k < chain.length) {
      let far = k;
      for (let m = chain.length - 1; m > k; m--) {
        if (this.clearLine(map, t, anchor[0], anchor[1], chain[m][0], chain[m][1], r, pts.length ? 0 : 150)) {
          far = m;
          break;
        }
      }
      pts.push(chain[far]);
      anchor = chain[far];
      k = far + 1;
    }
    this.path = pts.length ? pts : [lastNode];
  }

  private ensureGrid(map: EngineMapData, t: number) {
    const key = collapseKey(map, t + COLLAPSE_LOOKAHEAD);
    if (this.grid && this.gridMap === map && this.gridKey === key) return;
    this.node = map.cell / 2;
    this.gw = map.nx * 2 + 1;
    this.gh = map.ny * 2 + 1;
    const grid = new Uint8Array(this.gw * this.gh);
    const r = map.bodyR || 400;
    for (let y = 0; y < this.gh; y++) {
      for (let x = 0; x < this.gw; x++) grid[y * this.gw + x] = this.pointFree(map, t, x * this.node, y * this.node, r) ? 1 : 0;
    }
    this.grid = grid;
    this.gridMap = map;
    this.gridKey = key;
  }

  private nearestFree(c: Pt, x: number, y: number, radius: number): number {
    const grid = this.grid!;
    let best = -1;
    let bestD = Infinity;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const nx = c[0] + dx;
        const ny = c[1] + dy;
        if (nx < 0 || ny < 0 || nx >= this.gw || ny >= this.gh) continue;
        const j = ny * this.gw + nx;
        if (!grid[j]) continue;
        const d = Math.hypot(nx * this.node - x, ny * this.node - y);
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      }
    }
    return best;
  }

  /** Can the body stand at (x, y): centre on floor / grass away from pits, body clear of walls and the map edge. */
  private pointFree(map: EngineMapData, t: number, x: number, y: number, r: number): boolean {
    const W = map.nx * map.cell;
    const H = map.ny * map.cell;
    if (x <= 0 || y <= 0 || x >= W || y >= H) return false;
    const reach = r + WALL_PAD;
    const c = map.cell;
    const x0 = Math.floor((x - reach) / c);
    const x1 = Math.floor((x + reach) / c);
    const y0 = Math.floor((y - reach) / c);
    const y1 = Math.floor((y + reach) / c);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const qx = Math.max(cx * c, Math.min(x, (cx + 1) * c));
        const qy = Math.max(cy * c, Math.min(y, (cy + 1) * c));
        const d = Math.hypot(x - qx, y - qy);
        const cell = cellAt(map, cx, cy, t + COLLAPSE_LOOKAHEAD);
        if (cell === CellType.WALL && d < reach) return false;
        if ((cell === CellType.PIT || cell < 0) && d < PIT_MARGIN) return false;
      }
    }
    return true;
  }

  /** Straight walk a→b stays on free ground (samples every 100 mm; the first `skipMm` are not checked). */
  private clearLine(map: EngineMapData, t: number, ax: number, ay: number, bx: number, by: number, r: number, skipMm: number): boolean {
    const len = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(1, Math.ceil(len / LINE_STEP));
    for (let i = 1; i <= steps; i++) {
      const f = i / steps;
      if (f * len < skipMm) continue;
      if (!this.pointFree(map, t, ax + (bx - ax) * f, ay + (by - ay) * f, r)) return false;
    }
    return true;
  }
}

/** Cell type at tick t (collapsed cells are pits; -1 outside the map). */
function cellAt(map: EngineMapData, cx: number, cy: number, t: number): number {
  if (cx < 0 || cy < 0 || cx >= map.nx || cy >= map.ny) return -1;
  const i = cy * map.nx + cx;
  const w = map.waves[i];
  if (w >= 0 && t >= map.waveSteps[w]) return CellType.PIT;
  return map.cells[i];
}

function collapseKey(map: EngineMapData, t: number): number {
  let n = 0;
  for (const s of map.waveSteps) if (t >= s) n++;
  return n;
}

function vectorTo(x: number, y: number, tx: number, ty: number, last: boolean): Pt {
  const dx = tx - x;
  const dy = ty - y;
  const d = Math.hypot(dx, dy);
  if (d < 1) return [0, 0];
  // Final approach: scale the stick so this tick's walk ends on the destination (engine speed ∝ |v|)
  const mag = last ? Math.min(1000, Math.max(40, (d / RUN_V) * 1000)) : 1000;
  return [Math.round((dx / d) * mag), Math.round((dy / d) * mag)];
}

class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size() {
    return this.ids.length;
  }
  push(id: number, key: number) {
    const a = this.ids;
    const k = this.keys;
    let i = a.length;
    a.push(id);
    k.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      a[i] = a[p];
      k[i] = k[p];
      i = p;
    }
    a[i] = id;
    k[i] = key;
  }
  pop(): number {
    const a = this.ids;
    const k = this.keys;
    const top = a[0];
    const lastId = a.pop()!;
    const lastKey = k.pop()!;
    if (a.length) {
      let i = 0;
      const n = a.length;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const c = l + 1 < n && k[l + 1] < k[l] ? l + 1 : l;
        if (k[c] >= lastKey) break;
        a[i] = a[c];
        k[i] = k[c];
        i = c;
      }
      a[i] = lastId;
      k[i] = lastKey;
    }
    return top;
  }
}
