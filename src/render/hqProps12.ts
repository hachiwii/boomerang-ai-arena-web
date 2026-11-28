import * as THREE from 'three';
import { CellType, EngineMapData } from '../game/types';
import { addFarBush, hexLin, HqMeshBuilder, LinRGB, scaleLin, SeededRng, Vec3 } from './hqGeomBuilder';
import { HqPalette } from './hqThemes';

/**
 * Episode 12 props, ported from upstream `props12.py` (all coordinates in Blender space: x = map x, y = -map y,
 * z = up, metres):
 * - caldera: basalt hexagonal column clusters (+ ember glow at some feet), obsidian shards, glowing vents,
 *   far basalt / charred trees / ember bushes, volcano and smoking crater landmarks;
 * - harbor: fishing-gear piles (painted crates, lobster traps, hooped barrels, rope coils, buoys), pier edge beams and
 *   piles, rowboats, shells & dry grass, far sea stacks, lighthouse and moored sailboat landmarks;
 * - keeps: two castles (staggered brick walls, merlons, round corner towers with team-coloured roofs and waving team
 *   flags, gatehouses with lamps, team banners), plaza planters and low walls, far castle towers.
 *
 * Team colours follow the spec of the web port: the left castle belongs to team 0 (blue), the right one to team 1 (red).
 */

export const TEAM_BLUE = '#2E8CFF';
export const TEAM_RED = '#FF5B4D';
const ROOF_OF: Record<string, string> = { [TEAM_RED]: '#D9573F', [TEAM_BLUE]: '#4A78C8' };

type Col = LinRGB;

function C(h: string | Col, k = 1.0): Col {
  return typeof h === 'string' ? hexLin(h, k) : scaleLin(h, k);
}

/** Quad drawn from both sides (upstream single faces render two-sided in Blender). */
function quad2(mb: HqMeshBuilder, p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, col: Col, bucket: 'solid' | 'glow' = 'solid') {
  mb.quad(p0, p1, p2, p3, col, bucket);
  mb.quad(p3, p2, p1, p0, col, bucket);
}

function tri2(mb: HqMeshBuilder, p0: Vec3, p1: Vec3, p2: Vec3, col: Col, bucket: 'solid' | 'glow' = 'solid') {
  mb.tri(p0, p1, p2, col, col, col, bucket);
  mb.tri(p2, p1, p0, col, col, col, bucket);
}

/** Team flag / roof colours of the castle on the left or right half of the map. */
export function sideCols(left: boolean): { flag: string; roof: string } {
  const flag = left ? TEAM_BLUE : TEAM_RED;
  return { flag, roof: ROOF_OF[flag] ?? flag };
}

// ================================================================ caldera: basalt columns
export function hexCol(
  mb: HqMeshBuilder,
  cx: number,
  cy: number,
  r: number,
  h: number,
  side: Col,
  top: Col,
  z = 0,
  rot = 0,
  glow: Col | null = null,
) {
  mb.stack(cx, cy, [[r, z - 0.06], [r, z + h - 0.035], [r * 0.84, z + h]], [side, C(top, 0.82)], { n: 6, rot0: rot, cap: top });
  if (glow) mb.stack(cx, cy, [[r * 1.04, z - 0.02], [r * 1.04, z + 0.05]], glow, { n: 6, rot0: rot, bucket: 'glow' });
}

/** A wall rect (same wave) -> a cluster of stepped basalt hexagonal columns, tilted to one side, inside the cells. */
export function addBasalt(mb: HqMeshBuilder, X0: number, Y0: number, Wd: number, Hd: number, hk: number, rng: SeededRng, P: HqPalette) {
  const Sh = Math.min(Wd, Hd);
  let r = Sh < 0.75 ? 0.125 : 0.19;
  const dx = Math.sqrt(3) * r;
  const dy = 1.5 * r;
  const sideA = C(P.stone_side);
  const sideB = C(P.stone_shade);
  const top = C(P.stone_top);
  const m = 0.02;
  const cx = X0 + Wd / 2;
  const cy = Y0 + Hd / 2;
  const ang = rng.uniform(0, 6.28);
  const tx = Math.cos(ang);
  const ty = Math.sin(ang);
  const baseH = rng.uniform(1.35, 1.6) * hk;
  let pts: [number, number][] = [];
  let row = 0;
  for (let y = Y0 + m + r * 0.87; y <= Y0 + Hd - m - r * 0.87 + 1e-6; y += dy, row++) {
    for (let x = X0 + m + r + (row % 2 ? dx / 2 : 0); x <= X0 + Wd - m - r + 1e-6; x += dx) pts.push([x, y]);
  }
  if (!pts.length) {
    pts = [[cx, cy]];
    r = Math.min(Wd, Hd) / 2 - m;
  }
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const [x, y] of pts) {
    xmin = Math.min(xmin, x);
    xmax = Math.max(xmax, x);
    ymin = Math.min(ymin, y);
    ymax = Math.max(ymax, y);
  }
  const ox = cx - (xmin + xmax) / 2;
  const oy = cy - (ymin + ymax) / 2;
  const span = Math.max(Wd, Hd) / 2 + 1e-6;
  pts.forEach(([x0, y0], i) => {
    const x = x0 + ox;
    const y = y0 + oy;
    const s = ((x - cx) * tx + (y - cy) * ty) / span;
    const e = Math.max(Math.abs(x - cx) / (Wd / 2), Math.abs(y - cy) / (Hd / 2));
    let h = baseH * (1.0 + 0.22 * s - 0.18 * Math.max(0, e - 0.55)) + rng.uniform(-0.12, 0.12);
    h = Math.max(1.05 * hk, h);
    const sd = (i + rng.int(0, 2)) % 2 ? sideA : sideB;
    const rr = r * rng.uniform(0.93, 1.0);
    const sc = C(sd, rng.uniform(0.94, 1.05));
    const tc = C(top, rng.uniform(0.95, 1.05));
    const rot = Math.PI / 6 + rng.uniform(-0.08, 0.08);
    const glow = rng.next() < 0.35 ? C('#FF6A2A') : null;
    hexCol(mb, x, y, rr, h, sc, tc, 0, rot, glow);
  });
}

// ================================================================ harbor: fishing-gear piles
const WOOD_PAINT = ['#3FA7B5', '#2E6E9E', '#EDE6D6', '#E0573F', '#4FA87A'];

function paintedCrate(mb: HqMeshBuilder, cx: number, cy: number, s: number, h: number, z: number, col: string, rng: SeededRng, rz = 0) {
  const w = s / 2;
  const c = C(col, rng.uniform(0.95, 1.05));
  mb.box(cx - w, cx + w, cy - w, cy + w, z, z + h, c, { top: C(c, 1.1), rz });
  const dk = C(col, 0.62);
  const e = 0.008;
  const cr = Math.cos(rz);
  const sr = Math.sin(rz);
  const R = (x: number, y: number): [number, number] => [cx + x * cr - y * sr, cy + x * sr + y * cr];
  for (let k = 1; k <= 2; k++) {
    const zz = z + (h * k) / 3;
    for (const [ux, uy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
      const px = -uy;
      const py = ux;
      const o = w + e;
      const a = R(ux * o + px * -w, uy * o + py * -w);
      const b = R(ux * o + px * w, uy * o + py * w);
      mb.quad([a[0], a[1], zz - 0.012], [b[0], b[1], zz - 0.012], [b[0], b[1], zz + 0.012], [a[0], a[1], zz + 0.012], dk);
    }
  }
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const p = R(sx * (w - 0.025), sy * (w - 0.025));
    mb.box(p[0] - 0.032, p[0] + 0.032, p[1] - 0.032, p[1] + 0.032, z, z + h + 0.01, C('#6E4E3A'), { rz });
  }
}

function trap(mb: HqMeshBuilder, cx: number, cy: number, sx_: number, sy_: number, h: number, z: number) {
  const net = C('#4E6A6E');
  const frame = C('#C99A5E');
  mb.box(cx - sx_ / 2, cx + sx_ / 2, cy - sy_ / 2, cy + sy_ / 2, z, z + h, net, { top: C('#5E7E80') });
  for (const [ax, ay] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const x = cx + ax * (sx_ / 2 - 0.02);
    const y = cy + ay * (sy_ / 2 - 0.02);
    mb.box(x - 0.025, x + 0.025, y - 0.025, y + 0.025, z, z + h + 0.01, frame);
  }
  const e = 0.006;
  for (const zz of [z + 0.015, z + h - 0.015]) {
    mb.box(cx - sx_ / 2 - e, cx + sx_ / 2 + e, cy - sy_ / 2 - e, cy + sy_ / 2 + e, zz - 0.014, zz + 0.014, frame);
  }
  const line = C('#A8C4C0');
  for (let k = 1; k < 4; k++) {
    const t = k / 4;
    const x = cx - sx_ / 2 + sx_ * t;
    const yF = cy - sy_ / 2 - e;
    mb.quad([x - 0.006, yF, z], [x + 0.006, yF, z], [x + 0.006, yF, z + h], [x - 0.006, yF, z + h], line);
    const y = cy - sy_ / 2 + sy_ * t;
    const xE = cx + sx_ / 2 + e;
    mb.quad([xE, y - 0.006, z], [xE, y + 0.006, z], [xE, y + 0.006, z + h], [xE, y - 0.006, z + h], line);
  }
}

function barrel2(mb: HqMeshBuilder, cx: number, cy: number, r: number, h: number, z: number, hoop = '#2E5E8E') {
  const wood = C('#C08A58');
  const hp = C(hoop);
  const lv: [number, number][] = [[0.86, 0.0], [0.86, 0.1], [0.92, 0.1], [0.92, 0.17], [1.0, 0.36], [1.0, 0.64], [0.92, 0.83], [0.92, 0.9], [0.86, 0.9], [0.86, 1.0]];
  const cl = [C(wood, 0.9), hp, hp, wood, C(wood, 1.08), wood, hp, hp, C(wood, 0.9)];
  mb.stack(cx, cy, lv.map(([a, t]) => [r * a, z + h * t] as [number, number]), cl, { n: 10, cap: C(wood, 1.15) });
}

function buoy(mb: HqMeshBuilder, x: number, y: number, z: number, r: number) {
  mb.blob(x, y, z + r, r, r, r * 0.95, C('#E0503C'), C('#FFFFFF'), { sub: 1 });
  mb.box(x - 0.012, x + 0.012, y - 0.012, y + 0.012, z + r * 1.8, z + r * 2.4, C('#5A4A48'));
}

function ropeCoil(mb: HqMeshBuilder, x: number, y: number, z: number, r: number, turns = 2) {
  for (let k = 0; k < turns; k++) {
    const rr = r * (1.0 - 0.18 * k);
    const pts: Vec3[] = [];
    for (let i = 0; i < 15; i++) pts.push([x + rr * Math.cos((2 * Math.PI * i) / 14), y + rr * Math.sin((2 * Math.PI * i) / 14), z + 0.03 + 0.055 * k]);
    mb.tube(pts, 0.028, C('#E8D2A0'), { seg: 5 });
  }
}

/** A wall rect -> a pile of fishing gear taller than a person, inside the cells. */
export function addHarborPile(mb: HqMeshBuilder, X0: number, Y0: number, Wd: number, Hd: number, rng: SeededRng) {
  let nx = Math.max(1, Math.round(Wd / 1.0));
  let ny = Math.max(1, Math.round(Hd / 1.0));
  if (Math.min(Wd, Hd) < 0.75) {
    if (Wd >= Hd) {
      nx = Math.max(1, Math.round(Wd / 0.5));
      ny = 1;
    } else {
      nx = 1;
      ny = Math.max(1, Math.round(Hd / 0.5));
    }
  }
  const sx = Wd / nx;
  const sy = Hd / ny;
  const k0 = rng.int(0, 3);
  const paint = () => WOOD_PAINT[rng.int(0, WOOD_PAINT.length)];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const px = X0 + (i + 0.5) * sx;
      const py = Y0 + (j + 0.5) * sy;
      const s = Math.min(sx, sy) - 0.06;
      const kind = (k0 + i + j) % 3;
      if (s >= 0.8) {
        if (kind === 0) {
          paintedCrate(mb, px, py, s, s * 0.78, 0, paint(), rng, rng.uniform(-0.04, 0.04));
          const s2 = s * 0.56;
          const ox = rng.uniform(-0.12, 0.12) * s;
          const oy = rng.uniform(-0.12, 0.12) * s;
          paintedCrate(mb, px + ox, py + oy, s2, s2 * 0.8, s * 0.78, paint(), rng, rng.uniform(0.2, 0.6));
          ropeCoil(mb, px - ox * 1.6, py - oy * 1.6, s * 0.78, 0.12);
          buoy(mb, px + ox, py + oy, s * 0.78 + s2 * 0.8, 0.08);
        } else if (kind === 1) {
          const a = s / 2 - 0.01;
          const hh = 0.36;
          for (const [ax, ay] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
            trap(mb, px + (ax * a) / 2, py + (ay * a) / 2, a - 0.02, a - 0.02, hh, 0);
            trap(mb, px + (ax * a) / 2, py + (ay * a) / 2, a - 0.02, a - 0.02, hh, hh);
          }
          trap(mb, px + rng.uniform(-0.05, 0.05), py + rng.uniform(-0.05, 0.05), a, a * 0.9, hh * 0.9, 2 * hh);
          buoy(mb, px + a * 0.55, py - a * 0.4, 2 * hh, 0.075);
          buoy(mb, px - a * 0.5, py + a * 0.45, 2 * hh, 0.07);
        } else {
          const br = s * 0.24;
          for (const [ax, ay] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) barrel2(mb, px + ax * s * 0.24, py + ay * s * 0.24, br, s * 0.6, 0);
          barrel2(mb, px, py, br * 1.05, s * 0.55, s * 0.6, '#E0573F');
          buoy(mb, px + br * 0.2, py, s * 1.15, 0.07);
        }
      } else if (kind === 0) {
        barrel2(mb, px, py, s * 0.47, 0.6, 0);
        barrel2(mb, px, py, s * 0.45, 0.56, 0.6, '#E0573F');
        buoy(mb, px, py, 1.16, 0.065);
      } else if (kind === 1) {
        for (let k = 0; k < 3; k++) trap(mb, px + rng.uniform(-0.015, 0.015), py + rng.uniform(-0.015, 0.015), s, s, 0.38, 0.38 * k);
        ropeCoil(mb, px, py, 1.14, s * 0.3);
      } else {
        paintedCrate(mb, px, py, s, 0.5, 0, paint(), rng, rng.uniform(-0.05, 0.05));
        paintedCrate(mb, px, py, s * 0.9, 0.42, 0.5, paint(), rng, rng.uniform(0.15, 0.4));
        buoy(mb, px, py, 0.92, 0.08);
        mb.box(px - 0.02, px + 0.02, py - 0.02, py + 0.02, 0.9, 1.3, C('#8A6A4A'));
        mb.box(px - 0.05, px + 0.05, py - 0.012, py + 0.012, 1.18, 1.36, C('#E0573F'));
      }
    }
  }
}

/**
 * Pier edges touching the sea: a dark edge beam hanging into the water and a pile every metre (`build_piers`).
 * `builderFor(x, y)` returns the mesh builder of the collapse chunk of cell (x, y).
 */
export function addPierEdges(
  mapData: EngineMapData,
  deckCells: Int8Array,
  liq: Uint8Array,
  zLiq: number,
  builderFor: (x: number, y: number) => HqMeshBuilder,
) {
  const { nx, ny } = mapData;
  const cs = mapData.cell / 1000;
  const beam = C('#6E4A34');
  const pile = C('#7E5A40');
  const pileTop = C('#A88A66');
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      if (!deckCells[y * nx + x]) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const qx = x + dx;
        const qy = y + dy;
        if (qx < 0 || qy < 0 || qx >= nx || qy >= ny || !liq[qy * nx + qx]) continue;
        const mb = builderFor(x, y);
        let a: [number, number];
        let b: [number, number];
        if (dx) {
          const ex = (x + (dx > 0 ? 1 : 0)) * cs;
          a = [ex, -y * cs];
          b = [ex, -(y + 1) * cs];
        } else {
          const ey = -(y + (dy > 0 ? 1 : 0)) * cs;
          a = [x * cs, ey];
          b = [(x + 1) * cs, ey];
        }
        const o = 0.035;
        const nx_ = dx * o;
        const ny_ = -dy * o;
        quad2(mb, [a[0] + nx_, a[1] + ny_, zLiq - 0.15], [b[0] + nx_, b[1] + ny_, zLiq - 0.15], [b[0] + nx_, b[1] + ny_, 0.0], [a[0] + nx_, a[1] + ny_, 0.0], beam);
        quad2(mb, [a[0] + nx_ * 1.15, a[1] + ny_ * 1.15, -0.16], [b[0] + nx_ * 1.15, b[1] + ny_ * 1.15, -0.16], [b[0] + nx_ * 1.15, b[1] + ny_ * 1.15, -0.1], [a[0] + nx_ * 1.15, a[1] + ny_ * 1.15, -0.1], C(beam, 0.7));
        const k = dy ? x : y;
        if (k % 2 === 0) {
          const mx = (a[0] + b[0]) / 2 + dx * 0.09;
          const my = (a[1] + b[1]) / 2 - dy * 0.09;
          mb.stack(mx, my, [[0.075, zLiq - 0.4], [0.075, 0.03], [0.06, 0.06]], [pile, C(pile, 1.1)], { n: 8, cap: pileTop });
          mb.stack(mx, my, [[0.09, zLiq - 0.02], [0.09, zLiq + 0.05]], C('#3E6E5A'), { n: 8 });
        }
      }
    }
  }
}

/** A small rowboat moored in the sea (its rim stays below the pier deck). */
export function addRowboat(mb: HqMeshBuilder, x: number, y: number, z: number, rot: number) {
  const L = 0.62;
  const Wb = 0.24;
  const hull = C('#E8E2D2');
  const rim = C('#2E6E9E');
  const inner = C('#B88A5E');
  const n = 12;
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const R = (px: number, py: number, pz: number): Vec3 => [x + px * c - py * s, y + px * s + py * c, pz];
  const prof: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    const px = Math.cos(a) * L;
    let py = Math.sin(a) * Wb;
    if (px > 0) py *= 1 - 0.55 * (px / L) ** 2;
    prof.push([px, py]);
  }
  const lv: [number, number][] = [[0.55, z - 0.06], [0.9, z + 0.07], [1.0, z + 0.16]];
  const rings = lv.map(([k, zz]) => prof.map(([px, py]) => R(px * k, py * k, zz)));
  for (let li = 0; li < rings.length - 1; li++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      mb.quad(rings[li][i], rings[li][j], rings[li + 1][j], rings[li + 1][i], li === 0 ? hull : rim);
    }
  }
  const top = rings[rings.length - 1];
  const inn = prof.map(([px, py]) => R(px * 0.86, py * 0.8, z + 0.05));
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    mb.quad(top[i], top[j], inn[j], inn[i], C(rim, 1.15));
  }
  const ctr = R(0, 0, z + 0.05);
  for (let i = 0; i < n; i++) mb.tri(inn[i], inn[(i + 1) % n], ctr, inner, inner, inner);
  const p = R(0, 0, 0);
  mb.box(p[0] - 0.05, p[0] + 0.05, p[1] - 0.2, p[1] + 0.2, z + 0.09, z + 0.12, C('#8A6A4A'), { rz: rot });
  for (const sg of [-1, 1]) {
    mb.tube([R(-0.05, sg * 0.18, z + 0.16), R(0.25, sg * 0.5, z + 0.02)], 0.014, C('#C9A070'), { seg: 5 });
  }
}

/** Rowboats in the two biggest enclosed sea areas (>= 40 cells), moored at their most open spot. */
export function rowboatSpots(mapData: EngineMapData, liq: Uint8Array): { x: number; y: number; rot: number }[] {
  const { nx, ny } = mapData;
  const cs = mapData.cell / 1000;
  const seen = new Uint8Array(nx * ny);
  const comps: number[][] = [];
  for (let s0 = 0; s0 < nx * ny; s0++) {
    if (!liq[s0] || seen[s0]) continue;
    const st = [s0];
    const comp: number[] = [];
    seen[s0] = 1;
    while (st.length) {
      const c = st.pop()!;
      comp.push(c);
      const cx = c % nx;
      const cy = (c / nx) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = cx + dx;
        const yy = cy + dy;
        if (xx < 0 || yy < 0 || xx >= nx || yy >= ny) continue;
        const q = yy * nx + xx;
        if (liq[q] && !seen[q]) {
          seen[q] = 1;
          st.push(q);
        }
      }
    }
    if (comp.length >= 40) comps.push(comp);
  }
  comps.sort((a, b) => b.length - a.length);
  const out: { x: number; y: number; rot: number }[] = [];
  comps.slice(0, 2).forEach((comp, i) => {
    const cset = new Set(comp);
    const dLand = (c: number) => {
      const cx = c % nx;
      const cy = (c / nx) | 0;
      let d = 0;
      for (;;) {
        let all = true;
        for (let ey = -d - 1; ey <= d + 1 && all; ey++) {
          for (let ex = -d - 1; ex <= d + 1 && all; ex++) {
            const xx = cx + ex;
            const yy = cy + ey;
            if (xx < 0 || yy < 0 || xx >= nx || yy >= ny || !cset.has(yy * nx + xx)) all = false;
          }
        }
        if (!all) return d;
        d++;
      }
    };
    let best = comp[0];
    let bestK: [number, number] = [-1, -Infinity];
    for (const c of comp) {
      const k: [number, number] = [dLand(c), -Math.abs((c % nx) - nx / 2)];
      if (k[0] > bestK[0] || (k[0] === bestK[0] && k[1] > bestK[1])) {
        bestK = k;
        best = c;
      }
    }
    const xs = comp.map((c) => c % nx);
    const ys = comp.map((c) => (c / nx) | 0);
    const alongX = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys);
    const bx = ((best % nx) + 0.5) * cs;
    const by = -(((best / nx) | 0) + 0.5) * cs;
    out.push({ x: bx + (alongX ? 0.6 : 0) * (i ? 1 : -1), y: by, rot: alongX ? 0 : Math.PI / 2 });
  });
  return out;
}

// ================================================================ keeps: castles, plaza planters & low walls
export interface CastleFlag {
  /** Collapse-chunk cell the flag stands on (map cell coords) */
  cellX: number;
  cellY: number;
  geo: THREE.BufferGeometry;
}

function wallComponents(mapData: EngineMapData): [number, number][][] {
  const { nx, ny, cells } = mapData;
  const seen = new Uint8Array(nx * ny);
  const out: [number, number][][] = [];
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const i = y * nx + x;
      if (cells[i] !== CellType.WALL || seen[i]) continue;
      const st: [number, number][] = [[x, y]];
      const comp: [number, number][] = [];
      seen[i] = 1;
      while (st.length) {
        const [cx, cy] = st.pop()!;
        comp.push([cx, cy]);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const xx = cx + dx;
          const yy = cy + dy;
          if (xx < 0 || yy < 0 || xx >= nx || yy >= ny) continue;
          const q = yy * nx + xx;
          if (cells[q] === CellType.WALL && !seen[q]) {
            seen[q] = 1;
            st.push([xx, yy]);
          }
        }
      }
      out.push(comp);
    }
  }
  return out;
}

/** `_frames`: wall groups (merged across gate gaps <= 2 cells) that enclose a hollow box = castles; the rest. */
export function castleFrames(mapData: EngineMapData): {
  frames: { cells: Set<string>; box: [number, number, number, number] }[];
  others: [number, number][][];
} {
  const comps = wallComponents(mapData);
  const par = comps.map((_, i) => i);
  const find = (i: number): number => {
    while (par[i] !== i) {
      par[i] = par[par[i]];
      i = par[i];
    }
    return i;
  };
  for (let i = 0; i < comps.length; i++) {
    for (let j = i + 1; j < comps.length; j++) {
      let near = false;
      for (const a of comps[i]) {
        for (const b of comps[j]) {
          if (Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])) <= 3) {
            near = true;
            break;
          }
        }
        if (near) break;
      }
      if (near) par[find(i)] = find(j);
    }
  }
  const merged = new Map<number, [number, number][]>();
  comps.forEach((c, i) => {
    const r = find(i);
    const arr = merged.get(r) ?? [];
    arr.push(...c);
    merged.set(r, arr);
  });
  const frames: { cells: Set<string>; box: [number, number, number, number] }[] = [];
  for (const grp of merged.values()) {
    const xs = grp.map((c) => c[0]);
    const ys = grp.map((c) => c[1]);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs) + 1;
    const y0 = Math.min(...ys);
    const y1 = Math.max(...ys) + 1;
    if (x1 - x0 >= 5 && y1 - y0 >= 5 && grp.length < 0.7 * (x1 - x0) * (y1 - y0)) {
      frames.push({ cells: new Set(grp.map(([x, y]) => `${x},${y}`)), box: [x0, y0, x1, y1] });
    }
  }
  const others = comps.filter((comp) => !frames.some((f) => f.cells.has(`${comp[0][0]},${comp[0][1]}`)));
  return { frames, others };
}

function brickCell(mb: HqMeshBuilder, X0: number, Y0: number, cs: number, z0: number, z1: number, horiz: boolean, rng: SeededRng, stones: Col[], rowh = 0.23) {
  const nrow = Math.max(1, Math.round((z1 - z0) / rowh));
  const rh = (z1 - z0) / nrow;
  const j = 0.006;
  for (let k = 0; k < nrow; k++) {
    const za = z0 + k * rh + 0.006;
    const zb = z0 + (k + 1) * rh - 0.006;
    const col = C(stones[rng.int(0, stones.length)], rng.uniform(0.94, 1.05) * (k === 0 ? 0.9 : 1.0));
    let parts: [number, number, number, number][];
    if (k % 2 === 0) parts = [[X0, X0 + cs, Y0, Y0 + cs]];
    else if (horiz) parts = [[X0, X0 + cs / 2, Y0, Y0 + cs], [X0 + cs / 2, X0 + cs, Y0, Y0 + cs]];
    else parts = [[X0, X0 + cs, Y0, Y0 + cs / 2], [X0, X0 + cs, Y0 + cs / 2, Y0 + cs]];
    for (const [xa, xb, ya, yb] of parts) {
      const c2 = C(col, rng.uniform(0.96, 1.04));
      mb.box(xa + j, xb - j, ya + j, yb - j, za, zb, c2, { top: C(c2, 1.08) });
    }
  }
}

function merlonRow(mb: HqMeshBuilder, X0: number, Y0: number, cs: number, side: string, z: number, stones: Col[], cap: Col, depth = 0.15, hh = 0.24, full = false) {
  const sides = !full ? [side] : 'ns'.includes(side) ? ['n', 's'] : ['e', 'w'];
  for (const sd of sides) {
    const t0 = 0.22;
    const t1 = 0.78;
    if (sd === 'n' || sd === 's') {
      const [ya, yb] = sd === 'n' ? [Y0 + cs - depth, Y0 + cs] : [Y0, Y0 + depth];
      mb.box(X0 + cs * t0, X0 + cs * t1, ya, yb, z, z + hh, C(stones[0], 1.02), { top: cap });
    } else {
      const [xa, xb] = sd === 'e' ? [X0 + cs - depth, X0 + cs] : [X0, X0 + depth];
      mb.box(xa, xb, Y0 + cs * t0, Y0 + cs * t1, z, z + hh, C(stones[0], 1.02), { top: cap });
    }
  }
}

function banner(mb: HqMeshBuilder, X0: number, Y0: number, cs: number, outer: string, Hc: number, col: Col) {
  const w = 0.26;
  const h = 0.5;
  const top = Hc - 0.08;
  const c0 = col;
  const c1 = C('#FFE9A8');
  const P = (u: number, v: number, lift = 0): Vec3 => {
    const e = 0.014 + lift;
    if (outer === 'n' || outer === 's') {
      const yy = outer === 'n' ? Y0 + cs + e : Y0 - e;
      return [X0 + cs / 2 + u, yy, v];
    }
    const xx = outer === 'e' ? X0 + cs + e : X0 - e;
    return [xx, Y0 + cs / 2 + u, v];
  };
  quad2(mb, P(-w / 2, top - h), P(w / 2, top - h), P(w / 2, top), P(-w / 2, top), c0);
  tri2(mb, P(-w / 2, top - h), P(0, top - h - 0.1), P(w / 2, top - h), c0);
  quad2(mb, P(-0.05, top - 0.32, 0.004), P(0.05, top - 0.32, 0.004), P(0.05, top - 0.12, 0.004), P(-0.05, top - 0.12, 0.004), c1);
  quad2(mb, P(-0.1, top - 0.24, 0.006), P(0.1, top - 0.24, 0.006), P(0.1, top - 0.2, 0.006), P(-0.1, top - 0.2, 0.006), c1);
  quad2(mb, P(-w / 2 - 0.03, top - 0.01, 0.002), P(w / 2 + 0.03, top - 0.01, 0.002), P(w / 2 + 0.03, top + 0.03, 0.002), P(-w / 2 - 0.03, top + 0.03, 0.002), C('#5A4A48'));
}

/** Waving team flag on a tower pole: a 7 x 3 vertex sheet; `aFlagU` = distance from the pole (0..1). */
function flagGeometry(x: number, y: number, z: number, w: number, h: number, colHex: string, side: number, phase: number): THREE.BufferGeometry {
  const nu = 7;
  const nv = 3;
  const pos: number[] = [];
  const col: number[] = [];
  const fu: number[] = [];
  const ph: number[] = [];
  const white = C('#FFFFFF');
  for (let i = 0; i < nu; i++) {
    const u = i / (nu - 1);
    for (let j = 0; j < nv; j++) {
      const v = j / (nv - 1);
      // Blender (bx, by, bz) -> three (bx, bz, -by)
      pos.push(x + side * u * w, z - v * h, -y);
      const stripe = v > 0.42 && v < 0.58 && u > 0.25;
      const c = stripe ? white : C(colHex, 1.0 - 0.12 * v);
      col.push(c[0], c[1], c[2]);
      fu.push(u);
      ph.push(phase);
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < nu - 1; i++) {
    for (let j = 0; j < nv - 1; j++) {
      const a = i * nv + j;
      idx.push(a, a + nv, a + nv + 1, a, a + nv + 1, a + 1);
    }
  }
  // nv=3 rows of 2 quads each: the middle row vertex (j = 1) carries the white stripe colour
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('aFlagU', new THREE.Float32BufferAttribute(fu, 1));
  geo.setAttribute('aFlagPh', new THREE.Float32BufferAttribute(ph, 1));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** Shared waving-flag material: displacement in the vertex shader, driven by `uniforms.uGt` (game steps). */
export function createFlagMaterial(): THREE.MeshLambertMaterial & { userData: { uGt: { value: number } } } {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const uGt = { value: 0 };
  mat.userData.uGt = uGt;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uGt = uGt;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aFlagU;\nattribute float aFlagPh;\nuniform float uGt;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        float flagPh = uGt * 0.42 + aFlagPh;
        transformed.z -= 0.045 * sin(flagPh - aFlagU * 5.0) * aFlagU;
        transformed.y += 0.012 * sin(flagPh * 1.3 - aFlagU * 4.0) * aFlagU;`,
      );
  };
  mat.customProgramCacheKey = () => 'hq_flag_wave';
  return mat as THREE.MeshLambertMaterial & { userData: { uGt: { value: number } } };
}

function planter(mb: HqMeshBuilder, X0: number, Y0: number, Wd: number, Hd: number, rng: SeededRng, stones: Col[], cap: Col, dark: Col) {
  const cx = X0 + Wd / 2;
  const cy = Y0 + Hd / 2;
  const a = Wd / 2 - 0.03;
  const b = Hd / 2 - 0.03;
  mb.box(cx - a, cx + a, cy - b, cy + b, -0.04, 0.12, dark, { top: C(dark, 1.2) });
  for (let k = 0; k < 2; k++) {
    const za = 0.12 + k * 0.2;
    const zb = 0.12 + (k + 1) * 0.2;
    const n = 4;
    for (let i = 0; i < n; i++) {
      const t0 = i / n;
      const t1 = (i + 1) / n;
      const c = C(stones[(i + k) % 4], rng.uniform(0.95, 1.05));
      mb.box(cx - a + 2 * a * t0 + 0.004, cx - a + 2 * a * t1 - 0.004, cy - b + 0.004, cy + b - 0.004, za + 0.004, zb - 0.004, c, { top: C(c, 1.08) });
    }
  }
  mb.box(cx - a - 0.02, cx + a + 0.02, cy - b - 0.02, cy + b + 0.02, 0.52, 0.58, cap);
  mb.box(cx - a + 0.06, cx + a - 0.06, cy - b + 0.06, cy + b - 0.06, 0.58, 0.6, C('#6E4E3A'));
  const g0 = C('#2F8050');
  const g1 = C('#4FA65C');
  const g2 = C('#9AD476');
  const R = Math.min(a, b) * 0.86;
  mb.blob(cx, cy, 0.58 + R * 0.55, R * 0.55, R * 0.55, R * 0.5, g0, g1, { sub: 2 });
  mb.blob(cx, cy, 0.58 + R * 1.2, R, R, R * 0.78, g0, g2, { sub: 2 });
  const fl = ['#FFB7D0', '#FFE27A', '#FFFFFF'];
  for (let k = 0; k < 7; k++) {
    const an = (2 * Math.PI * k) / 7 + rng.uniform(0, 0.4);
    const el = rng.uniform(0.2, 0.9);
    const px = cx + Math.cos(an) * R * Math.cos(el) * 0.98;
    const py = cy + Math.sin(an) * R * Math.cos(el) * 0.98;
    const pz = 0.58 + R * 1.2 + R * 0.78 * Math.sin(el);
    mb.blob(px, py, pz, 0.03, 0.03, 0.025, C('#FFFFFF'), C(fl[k % 3]), { sub: 1 });
  }
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    mb.blob(cx + sx * (a - 0.1), cy + sy * (b - 0.1), 0.66, 0.08, 0.08, 0.06, C('#4FA65C'), C('#FF9CC0'), { sub: 1 });
  }
}

export interface CastleBuild {
  /** Wall cells handled here (not to be drawn as rocks) */
  used: Set<string>;
  flags: CastleFlag[];
}

/**
 * `build_castles`: castle frames cell by cell into per-chunk builders (`builderFor(cellX, cellY)`), plaza blocks as
 * whole rects (`commitRect(mb, cells)`), flags returned separately so they can wave.
 */
export function buildCastles(
  mapData: EngineMapData,
  rng: SeededRng,
  P: HqPalette,
  builderFor: (x: number, y: number) => HqMeshBuilder,
  commitRect: (mb: HqMeshBuilder, x0: number, y0: number, w: number, h: number) => void,
  rectsOf: (cells: [number, number][]) => [number, number, number, number][],
): CastleBuild {
  const { nx, ny, cells } = mapData;
  const cs = mapData.cell / 1000;
  const { frames, others } = castleFrames(mapData);
  const stones = [C(P.stone_lit), C(P.stone_top), C(P.stone_side), C(P.stone_lit)];
  const cap = C(P.stone_top, 1.04);
  const dark = C(P.stone_base);
  const Hw = 1.15;
  const isw = (x: number, y: number) => x >= 0 && y >= 0 && x < nx && y < ny && cells[y * nx + x] === CellType.WALL;
  const flags: CastleFlag[] = [];
  const used = new Set<string>();

  frames.forEach((fr, fi) => {
    const [bx0, by0, bx1, by1] = fr.box;
    const left = (bx0 + bx1) / 2 < nx / 2;
    const { flag, roof } = sideCols(left);
    const flagc = C(flag);
    const roofc = C(roof);
    const sorted = [...fr.cells].map((k) => k.split(',').map(Number) as [number, number]).sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]));
    const inSet = (x: number, y: number) => fr.cells.has(`${x},${y}`);
    for (const [x, y] of sorted) {
      used.add(`${x},${y}`);
      const mb = builderFor(x, y);
      const X0 = x * cs;
      const Y0 = -(y + 1) * cs;
      const nbH = isw(x - 1, y) || isw(x + 1, y);
      const nbV = isw(x, y - 1) || isw(x, y + 1);
      const onL = x === bx0;
      const onR = x === bx1 - 1;
      const onT = y === by0;
      const onB = y === by1 - 1;
      const corner = (onL || onR) && (onT || onB);
      let gate = false;
      if ((onT || onB) && !corner) gate = !isw(x - 1, y) || !isw(x + 1, y);
      if ((onL || onR) && !corner) gate = gate || !isw(x, y - 1) || !isw(x, y + 1);
      mb.box(X0 - 0.015, X0 + cs + 0.015, Y0 - 0.015, Y0 + cs + 0.015, -0.04, 0.12, dark, { top: C(dark, 1.2) });
      if (corner) {
        const ccx = X0 + cs / 2;
        const ccy = Y0 + cs / 2;
        const r = cs * 0.6;
        mb.stack(ccx, ccy, [[r, 0.1], [r, 0.6], [r * 0.98, 1.1], [r, 1.5]], [stones[0], C(stones[2], 1.02), stones[1]], { n: 14, cap });
        mb.stack(ccx, ccy, [[r, 1.5], [r * 1.12, 1.56], [r * 1.12, 1.64]], [C(dark, 1.3), cap], { n: 14, cap });
        mb.stack(ccx, ccy, [[r * 1.14, 1.64], [r * 0.66, 2.0], [r * 0.3, 2.3], [0.015, 2.62]], [roofc, C(roofc, 1.1), C(roofc, 1.2)], { n: 14 });
        for (let k = 0; k < 2; k++) {
          const a = -Math.PI / 2 + (k - 0.5) * 1.1;
          const px = ccx + Math.cos(a) * r;
          const py = ccy + Math.sin(a) * r;
          mb.box(px - 0.035, px + 0.035, py - 0.012, py + 0.012, 0.78, 1.0, C('#3A3448'), { rz: a + Math.PI / 2 });
        }
        // (flat 'solid' bucket on purpose: one mesh per wall chunk keeps the castle's draw calls low)
        mb.tube([[ccx, ccy, 2.56], [ccx, ccy, 3.0]], 0.014, C('#5A4A48'), { seg: 5, bucket: 'solid' });
        mb.blob(ccx, ccy, 3.01, 0.025, 0.025, 0.025, C('#E8C24A'), C('#FFE89A'), { sub: 1, smooth: false });
        const side = onL ? -1 : 1;
        flags.push({ cellX: x, cellY: y, geo: flagGeometry(ccx, ccy, 2.98, 0.4, 0.24, flag, side, flags.length * 1.7) });
        continue;
      }
      const Hc = Hw + (gate ? 0.2 : 0.0);
      brickCell(mb, X0, Y0, cs, 0.12, Hc, nbH && !nbV, rng, stones);
      mb.box(X0, X0 + cs, Y0, Y0 + cs, Hc - 0.02, Hc + 0.04, C(dark, 1.35), { top: C(cap, 0.96) });
      const outer = onL ? 'w' : onR ? 'e' : onT ? 'n' : 's';
      if (gate) {
        for (const [ax, ay] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const xa = X0 + ax * (cs - 0.15);
          const ya = Y0 + ay * (cs - 0.15);
          mb.box(xa, xa + 0.15, ya, ya + 0.15, Hc + 0.04, Hc + 0.3, C(stones[(ax + ay) % 4], 1.02), { top: cap });
        }
        const ox = outer === 'w' ? -1 : outer === 'e' ? 1 : 0;
        const oy = outer === 'n' ? 1 : outer === 's' ? -1 : 0;
        const lx = X0 + cs / 2 + ox * (cs / 2 + 0.03);
        const ly = Y0 + cs / 2 + oy * (cs / 2 + 0.03);
        mb.box(lx - 0.045, lx + 0.045, ly - 0.045, ly + 0.045, 0.86, 1.0, C('#FFD27A'), { bucket: 'glow' });
        mb.box(lx - 0.06, lx + 0.06, ly - 0.06, ly + 0.06, 1.0, 1.03, C('#3A3040'));
      } else {
        merlonRow(mb, X0, Y0, cs, outer, Hc + 0.04, stones, cap);
        const inner = { w: 'e', e: 'w', n: 's', s: 'n' }[outer]!;
        if (inner === 'n' || inner === 's') {
          const [ya, yb] = inner === 'n' ? [Y0 + cs - 0.06, Y0 + cs] : [Y0, Y0 + 0.06];
          mb.box(X0, X0 + cs, ya, yb, Hc + 0.04, Hc + 0.1, stones[1], { top: cap });
        } else {
          const [xa, xb] = inner === 'e' ? [X0 + cs - 0.06, X0 + cs] : [X0, X0 + 0.06];
          mb.box(xa, xb, Y0, Y0 + cs, Hc + 0.04, Hc + 0.1, stones[1], { top: cap });
        }
        const faceCam = outer === 's';
        const facePlaza = (outer === 'e' && left) || (outer === 'w' && !left);
        const isGate = (xx: number, yy: number) => inSet(xx, yy) && (!isw(xx - 1, yy) || !isw(xx + 1, yy)) && bx0 < xx && xx < bx1 - 1;
        let hang = false;
        if (faceCam) hang = isGate(x - 1, y) || isGate(x + 1, y);
        else if (facePlaza) {
          const L = by1 - by0;
          hang = y - by0 === Math.floor(L / 3) || y - by0 === L - 1 - Math.floor(L / 3);
        }
        if (hang) banner(mb, X0, Y0, cs, outer, Hc, flagc);
      }
    }
    void fi;
  });

  // Other wall blocks on the plaza: square ones = stone planters with a clipped round tree, strips = low battlements
  for (const comp of others) {
    for (const [x0, y0, w, h] of rectsOf(comp)) {
      const X0 = x0 * cs;
      const Y0 = -(y0 + h) * cs;
      const Wd = w * cs;
      const Hd = h * cs;
      const mb = new HqMeshBuilder();
      if (Math.min(Wd, Hd) >= 0.9) {
        planter(mb, X0, Y0, Wd, Hd, rng, stones, cap, dark);
      } else {
        for (let y = y0; y < y0 + h; y++) {
          for (let x = x0; x < x0 + w; x++) {
            brickCell(mb, x * cs, -(y + 1) * cs, cs, 0.0, 0.95, Wd > Hd, rng, stones);
            mb.box(x * cs, (x + 1) * cs, -(y + 1) * cs, -y * cs, 0.93, 0.98, C(dark, 1.35), { top: C(cap, 0.96) });
            merlonRow(mb, x * cs, -(y + 1) * cs, cs, Wd > Hd ? 'n' : 'e', 0.98, stones, cap, 0.14, 0.3, true);
          }
        }
        mb.box(X0 - 0.015, X0 + Wd + 0.015, Y0 - 0.015, Y0 + Hd + 0.015, -0.04, 0.1, dark, { top: C(dark, 1.2) });
      }
      commitRect(mb, x0, y0, w, h);
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) used.add(`${x},${y}`);
    }
  }
  return { used, flags };
}

// ================================================================ ground details (props.DETAILS)
/** Episode 12 details; returns false for kinds it doesn't know. */
export function addDetailExtra12(mb: HqMeshBuilder, kind: string, x: number, y: number, rng: SeededRng): boolean {
  if (kind === 'obsidian') {
    const cnt = rng.int(1, 4);
    const cols = ['#2E2A3A', '#3A3048', '#24202E'];
    for (let k = 0; k < cnt; k++) {
      const ox = rng.normal(0, 0.07);
      const oy = rng.normal(0, 0.07);
      const s = rng.uniform(0.04, 0.08);
      mb.box(x + ox - s, x + ox + s * 0.6, y + oy - s * 0.5, y + oy + s * 0.5, -0.02, s * rng.uniform(0.9, 1.6), C(cols[k % 3]), {
        top: C('#6A6488'),
        rz: rng.uniform(0, 3.14),
        tiltX: rng.uniform(-0.04, 0.04),
        tiltY: rng.uniform(-0.04, 0.04),
      });
    }
    return true;
  }
  if (kind === 'vent') {
    const n = rng.int(5, 8);
    const r0 = rng.uniform(0.08, 0.12);
    for (let k = 0; k < n; k++) {
      const a = (2 * Math.PI * k) / n + rng.uniform(-0.2, 0.2);
      const s = rng.uniform(0.035, 0.055);
      mb.blob(x + Math.cos(a) * r0, y + Math.sin(a) * r0, s * 0.4, s, s, s * 0.8, C('#3A3448'), C('#6E6478'), { sub: 1, smooth: false });
    }
    mb.blob(x, y, -0.005, r0 * 0.75, r0 * 0.75, 0.02, C('#FF6A1A'), C('#FFD24A'), { sub: 1, bucket: 'glow' });
    return true;
  }
  if (kind === 'shells') {
    const cnt = rng.int(1, 4);
    const cols = ['#FFF4EC', '#FFD6DC', '#FFE6C8', '#F2C6B4'];
    for (let k = 0; k < cnt; k++) {
      const ox = rng.normal(0, 0.08);
      const oy = rng.normal(0, 0.08);
      const r = rng.uniform(0.025, 0.04);
      const c = C(cols[rng.int(0, 4)]);
      mb.blob(x + ox, y + oy, r * 0.3, r, r * 0.8, r * 0.45, C(c, 0.9), c, { sub: 1, smooth: false, rotZ: rng.uniform(0, 6.28) });
    }
    if (rng.next() < 0.3) {
      const c = C(['#FF8A5A', '#FFB04A'][rng.int(0, 2)]);
      const a0 = rng.uniform(0, 6.28);
      for (let k = 0; k < 5; k++) {
        const a = a0 + (2 * Math.PI * k) / 5;
        const p1: Vec3 = [x + Math.cos(a + 0.5) * 0.02, y + Math.sin(a + 0.5) * 0.02, 0.012];
        const p2: Vec3 = [x + Math.cos(a) * 0.07, y + Math.sin(a) * 0.07, 0.008];
        const p3: Vec3 = [x + Math.cos(a - 0.5) * 0.02, y + Math.sin(a - 0.5) * 0.02, 0.012];
        tri2(mb, p1, p2, p3, c);
        tri2(mb, [x, y, 0.016], p1, p3, c);
      }
    }
    return true;
  }
  if (kind === 'drygrass') {
    const c0 = C('#B8B070');
    const c1 = C('#F2E6A8');
    const cnt = rng.int(7, 12);
    for (let k = 0; k < cnt; k++) {
      const a = rng.uniform(0, 6.28);
      const L = rng.uniform(0.1, 0.2);
      const el = rng.uniform(0.5, 1.2);
      const tip: Vec3 = [x + Math.cos(a) * L * Math.cos(el), y + Math.sin(a) * L * Math.cos(el), L * Math.sin(el)];
      const w = 0.012;
      mb.tri([x - Math.sin(a) * w, y + Math.cos(a) * w, 0], [x + Math.sin(a) * w, y - Math.cos(a) * w, 0], tip, c0, c0, c1, 'foliage');
    }
    return true;
  }
  return false;
}

export const DETAIL_DENSITY_12: Record<string, number> = { obsidian: 0.1, vent: 0.1, shells: 0.1, drygrass: 0.1 };

// ================================================================ far props & landmarks
function smoke(mb: HqMeshBuilder, x: number, y: number, z: number, s: number, rng: SeededRng, n = 6, drift: [number, number] = [0.35, 0.12]) {
  for (let k = 0; k < n; k++) {
    const t = k / Math.max(1, n - 1);
    const r = (0.32 + 0.55 * t) * s;
    const px = x + drift[0] * s * k * (1 + 0.4 * t) + rng.uniform(-0.08, 0.08) * s;
    const py = y + drift[1] * s * k;
    const pz = z + (0.25 + 0.62 * k) * s;
    const c0 = C('#8E7E90', 0.95 + 0.1 * t);
    const c1 = C('#D6CAD2');
    mb.blob(px, py, pz, r, r * 0.85, r * 0.72, c0, c1, { sub: 1 });
    if (k > 1) mb.blob(px + r * 0.6, py + r * 0.2, pz - r * 0.15, r * 0.6, r * 0.5, r * 0.45, c0, c1, { sub: 1 });
  }
}

function fanDisc(mb: HqMeshBuilder, x: number, y: number, z: number, rx: number, ry: number, n: number, cCenter: Col, cRim: Col, bucket: 'solid' | 'glow') {
  for (let i = 0; i < n; i++) {
    const a0 = (2 * Math.PI * i) / n;
    const a1 = (2 * Math.PI * (i + 1)) / n;
    mb.tri([x, y, z], [x + rx * Math.cos(a0), y + ry * Math.sin(a0), z], [x + rx * Math.cos(a1), y + ry * Math.sin(a1), z], cCenter, cRim, cRim, bucket);
  }
}

function volcano(mb: HqMeshBuilder, x: number, y: number, z: number, s: number, rng: SeededRng) {
  const bands = [C('#6E5E6E'), C('#5A4E62'), C('#7A6670'), C('#4E4458'), C('#665868')];
  const lv: [number, number][] = [
    [1.75 * s, z - 0.15],
    [1.55 * s, z + 0.35 * s],
    [1.2 * s, z + 1.1 * s],
    [0.9 * s, z + 1.9 * s],
    [0.7 * s, z + 2.5 * s],
    [0.62 * s, z + 2.7 * s],
    [0.5 * s, z + 2.62 * s],
  ];
  mb.stack(x, y, lv, bands, { n: 13, jitter: 0.07, rng, rot0: rng.uniform(0, 6.28), cap: C('#FF8A2A') });
  fanDisc(mb, x, y, z + 2.6 * s, 0.5 * s, 0.5 * s, 13, C('#FFE27A'), C('#FF6A1A'), 'glow');
  for (let k = 0; k < 3; k++) {
    const a = -Math.PI / 2 + (k - 1) * 0.75 + rng.uniform(-0.2, 0.2);
    const pts: Vec3[] = [];
    for (let i = 0; i < 7; i++) {
      const t = i / 6;
      const rr = (0.58 + 1.05 * t) * s;
      const zz = z + (2.62 - 2.45 * Math.pow(t, 0.95)) * s;
      const aa = a + 0.15 * Math.sin(t * 5 + k);
      pts.push([x + rr * Math.cos(aa), y + rr * Math.sin(aa), zz + 0.03]);
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i];
      const q = pts[i + 1];
      const dx = q[0] - p[0];
      const dy = q[1] - p[1];
      const nl = Math.hypot(dx, dy) || 1;
      const nx = -dy / nl;
      const ny = dx / nl;
      const w0 = (0.12 - (0.07 * i) / 6) * s;
      const w1 = (0.12 - (0.07 * (i + 1)) / 6) * s;
      quad2(
        mb,
        [p[0] - nx * w0, p[1] - ny * w0, p[2]],
        [p[0] + nx * w0, p[1] + ny * w0, p[2]],
        [q[0] + nx * w1, q[1] + ny * w1, q[2]],
        [q[0] - nx * w1, q[1] - ny * w1, q[2]],
        C(i % 2 ? '#FF7A2A' : '#FFB040'),
        'glow',
      );
    }
  }
  smoke(mb, x + 0.05 * s, y, z + 2.6 * s, s * 0.9, rng, 6);
}

function smokingCrater(mb: HqMeshBuilder, x: number, y: number, z: number, s: number, rng: SeededRng) {
  for (let k = 0; k < 9; k++) {
    const a = (2 * Math.PI * k) / 9;
    mb.blob(x + Math.cos(a) * 0.6 * s, y + Math.sin(a) * 0.5 * s, z + 0.1 * s, 0.26 * s, 0.24 * s, 0.24 * s, C('#3E3648'), C('#6E6478'), { sub: 1, smooth: false });
  }
  mb.blob(x, y, z + 0.02, 0.5 * s, 0.4 * s, 0.06 * s, C('#FF6A1A'), C('#FFD24A'), { sub: 1, bucket: 'glow' });
  smoke(mb, x, y, z + 0.1 * s, s * 0.75, rng, 6, [0.3, 0.15]);
}

function lighthouse(mb: HqMeshBuilder, x: number, y: number, z: number, s: number) {
  mb.stack(x, y, [[0.75 * s, z - 0.1], [0.7 * s, z + 0.3 * s], [0.55 * s, z + 0.36 * s]], [C('#B8AE9E'), C('#D8D0C0')], { n: 10, cap: C('#D8D0C0') });
  const H = 3.0 * s;
  const nb = 6;
  const lv: [number, number][] = [];
  const cols: Col[] = [];
  for (let k = 0; k <= nb; k++) {
    const t = k / nb;
    lv.push([(0.46 - 0.14 * t) * s, z + 0.36 * s + H * t]);
    if (k < nb) cols.push(k % 2 ? C('#E2503C') : C('#FFFFFF'));
  }
  mb.stack(x, y, lv, cols, { n: 14, smooth: true });
  const zt = z + 0.36 * s + H;
  mb.stack(x, y, [[0.48 * s, zt], [0.48 * s, zt + 0.08 * s]], C('#3A3440'), { n: 14 });
  for (let k = 0; k < 12; k++) {
    const a = (2 * Math.PI * k) / 12;
    const px = x + Math.cos(a) * 0.45 * s;
    const py = y + Math.sin(a) * 0.45 * s;
    mb.box(px - 0.015 * s, px + 0.015 * s, py - 0.015 * s, py + 0.015 * s, zt + 0.08 * s, zt + 0.28 * s, C('#3A3440'));
  }
  mb.stack(x, y, [[0.26 * s, zt + 0.08 * s], [0.26 * s, zt + 0.55 * s]], C('#FFE27A'), { n: 10, bucket: 'glow', cap: C('#FFE27A') });
  mb.stack(x, y, [[0.36 * s, zt + 0.55 * s], [0.2 * s, zt + 0.75 * s], [0.02 * s, zt + 0.95 * s]], [C('#D9473A'), C('#E8604A')], { n: 10 });
  mb.blob(x, y, zt + 1.0 * s, 0.05 * s, 0.05 * s, 0.05 * s, C('#3A3440'), C('#5A5060'), { sub: 1 });
}

function sailboat(mb: HqMeshBuilder, x: number, y: number, z: number, s: number) {
  fanDisc(mb, x, y, z + 0.03, 1.05 * s, 0.75 * s, 20, C('#4FB8DA'), C('#8FE0F0'), 'solid');
  mb.box(x - 1.1 * s, x - 0.35 * s, y - 0.62 * s, y - 0.4 * s, z - 0.05, z + 0.12 * s, C('#B8875A'), { top: C('#D8A870') });
  const hull = C('#FFFFFF');
  const rim = C('#2E6E9E');
  const m = 14;
  const prof: [number, number][] = [];
  for (let i = 0; i < m; i++) {
    const a = (2 * Math.PI * i) / m;
    const px = Math.cos(a) * 0.75 * s;
    let py = Math.sin(a) * 0.24 * s;
    if (px > 0) py *= 1 - 0.6 * (px / (0.75 * s)) ** 2;
    prof.push([px, py]);
  }
  const lv: [number, number][] = [[0.6, z - 0.02], [0.92, z + 0.14 * s], [1.0, z + 0.3 * s]];
  const rings = lv.map(([k, zz]) => prof.map(([px, py]) => [x + px * k, y + py * k, zz] as Vec3));
  for (let li = 0; li < 2; li++) {
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      mb.quad(rings[li][i], rings[li][j], rings[li + 1][j], rings[li + 1][i], li === 0 ? hull : rim);
    }
  }
  const top = rings[2];
  const ctr: Vec3 = [x, y, z + 0.24 * s];
  const deck = C('#C9A070');
  for (let i = 0; i < m; i++) mb.tri(top[i], top[(i + 1) % m], ctr, deck, deck, deck);
  mb.tube([[x - 0.05 * s, y, z + 0.2 * s], [x - 0.05 * s, y, z + 1.9 * s]], 0.03 * s, C('#8A6A4A'), { seg: 6 });
  tri2(mb, [x - 0.03 * s, y + 0.01, z + 0.45 * s], [x + 0.62 * s, y + 0.01, z + 0.45 * s], [x - 0.03 * s, y + 0.01, z + 1.8 * s], C('#FFF8EC'));
  tri2(mb, [x - 0.08 * s, y - 0.01, z + 0.5 * s], [x - 0.08 * s, y - 0.01, z + 1.5 * s], [x - 0.55 * s, y - 0.01, z + 0.5 * s], C('#F2E2C8'));
  tri2(mb, [x - 0.05 * s, y, z + 1.9 * s], [x + 0.25 * s, y, z + 1.84 * s], [x - 0.05 * s, y, z + 1.78 * s], C('#E0503C'));
}

function keepTower(mb: HqMeshBuilder, x: number, y: number, z: number, s: number, rng: SeededRng, midX: number) {
  const st = [C('#E6DED0'), C('#D2C8B8'), C('#EEE8DC')];
  const H = rng.uniform(2.4, 3.2) * s;
  const r = 0.5 * s;
  mb.stack(x, y, [[r * 1.05, z - 0.1], [r, z + H * 0.5], [r * 0.96, z + H]], [st[0], st[1]], { n: 14, smooth: true });
  mb.stack(x, y, [[r * 0.96, z + H], [r * 1.15, z + H + 0.1 * s], [r * 1.15, z + H + 0.25 * s]], [C('#A89E90'), st[2]], { n: 14, cap: st[2] });
  rng.int(0, 3);
  const roof = C(sideCols(x < midX).roof);
  mb.stack(x, y, [[r * 1.05, z + H + 0.25 * s], [0.02, z + H + 1.4 * s]], [roof], { n: 14 });
  for (let k = 0; k < 3; k++) {
    const a = -Math.PI / 2 + (k - 1) * 0.6;
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    mb.box(px - 0.05 * s, px + 0.05 * s, py - 0.02 * s, py + 0.02 * s, z + H * (0.35 + 0.2 * k), z + H * (0.35 + 0.2 * k) + 0.22 * s, C('#3A3448'), {
      rz: a + Math.PI / 2,
    });
  }
  mb.tube([[x, y, z + H + 1.35 * s], [x, y, z + H + 1.75 * s]], 0.02 * s, C('#5A4A48'), { seg: 5 });
  quad2(mb, [x, y, z + H + 1.73 * s], [x + 0.4 * s, y, z + H + 1.68 * s], [x + 0.4 * s, y, z + H + 1.5 * s], [x, y, z + H + 1.55 * s], roof);
}

/** Episode 12 signature landmarks on the outer islands; returns false for names it doesn't know. */
export function addLandmarkFeature12(mb: HqMeshBuilder, fname: string, x: number, y: number, z: number, rng: SeededRng, midX: number): boolean {
  if (fname === 'volcano') volcano(mb, x, y, z, 1.15, rng);
  else if (fname === 'smoke') smokingCrater(mb, x, y, z, 1.0, rng);
  else if (fname === 'lighthouse') lighthouse(mb, x, y, z, 1.0);
  else if (fname === 'boat') sailboat(mb, x, y, z, 1.0);
  else if (fname === 'keep_tower') keepTower(mb, x, y, z, 1.0, rng, midX);
  else return false;
  return true;
}

/** Episode 12 far props on the outer islands; returns false for kinds it doesn't know. */
export function addFarProp12(mb: HqMeshBuilder, kind: string, x: number, y: number, z: number, s: number, rng: SeededRng): boolean {
  if (kind === 'basalt') {
    const n = rng.int(3, 7);
    for (let k = 0; k < n; k++) {
      const a = rng.uniform(0, 6.28);
      const rr = k ? rng.uniform(0.0, 0.3) * s : 0.0;
      const h = rng.uniform(0.6, 1.5) * s * (k ? 1.0 : 1.25);
      hexCol(mb, x + Math.cos(a) * rr, y + Math.sin(a) * rr, 0.16 * s, h, C('#575670', rng.uniform(0.9, 1.1)), C('#9A92A0'), z, Math.PI / 6);
    }
    return true;
  }
  if (kind === 'charred') {
    const c = C('#3E3440');
    const h = rng.uniform(1.0, 1.5) * s;
    mb.tube([[x, y, z - 0.05], [x + 0.04 * s, y, z + h * 0.5], [x - 0.03 * s, y, z + h]], 0.09 * s, c, { r1: 0.03 * s });
    const nb = rng.int(2, 4);
    for (let k = 0; k < nb; k++) {
      const a = rng.uniform(0, 6.28);
      const zb = z + h * rng.uniform(0.45, 0.8);
      const L = rng.uniform(0.3, 0.5) * s;
      const tip: Vec3 = [x + Math.cos(a) * L, y + Math.sin(a) * L, zb + L * 0.6];
      mb.tube([[x, y, zb], tip], 0.04 * s, c, { r1: 0.012 * s });
      if (rng.next() < 0.5) mb.blob(tip[0], tip[1], tip[2], 0.035 * s, 0.035 * s, 0.035 * s, C('#FF6A1A'), C('#FFC24A'), { sub: 1, bucket: 'glow' });
    }
    return true;
  }
  if (kind === 'emberbush') {
    addFarBush(mb, x, y, z, s * 1.1 * 1.4, rng, ['#A8503E', '#F0904E']);
    return true;
  }
  if (kind === 'seastack') {
    const cols = [C('#D8C8B0'), C('#C0AE98'), C('#E6D8C0'), C('#B8A48E')];
    const h = rng.uniform(0.9, 1.7) * s;
    mb.stack(x, y, [[0.42 * s, z - 0.1], [0.38 * s, z + h * 0.4], [0.3 * s, z + h * 0.8], [0.26 * s, z + h]], cols, {
      n: 7,
      jitter: 0.12,
      rng,
      rot0: rng.uniform(0, 6.28),
      cap: C('#FFFFFF'),
    });
    addFarBush(mb, x + 0.1 * s, y, z + h, s * 0.5 * 1.4, rng, ['#5FAE70', '#8FCB7E']);
    return true;
  }
  return false;
}
