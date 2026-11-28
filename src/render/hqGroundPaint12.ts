import * as THREE from 'three';
import { CellType, EngineMapData } from '../game/types';
import { SeededRng } from './hqGeomBuilder';
import { computeLiquidCells } from './hqLiquid';
import { HqThemeSpec, RGB } from './hqThemes';

/**
 * Episode 12 ground layers, ported from upstream `ground_paint._ep12_layers` (caldera `ash`, harbor `deck`,
 * keeps `castle`). Runs after the regular HQ ground paint and only for themes that ask for these styles, with its
 * own RNG, so the 10 episode-11 themes are untouched.
 *
 * - ash: light ash / dark basalt patches, glowing cracks (a third of them growing out of the lava bank), cooled-lava
 *   plates (Voronoi edges), heat-baked rim around the lava lake, pumice dots. Also returns a glow mask used as the
 *   ground material's emissive map (the cracks and the lava bank glow; cliffs don't).
 * - deck: land strips narrower than 2 x deck metres touching the sea become wooden piers (boards across the pier,
 *   seams, staggered board ends, nails, dark edge beams); stone quay slabs around the piers and the water, coping.
 * - castle: square-tiled castle floors, a slab plaza between the castles, a ringed inlay with an eight-point star on the
 *   last-collapsing zone, stone coping around the ponds.
 */

export interface Ep12GroundArgs {
  mapData: EngineMapData;
  theme: HqThemeSpec;
  ctx: CanvasRenderingContext2D;
  TW: number;
  TH: number;
  hiPPM: number;
  MG: number;
  /** Low-resolution (PPM px/m) fields from the base paint */
  W: number;
  H: number;
  PPM: number;
  tallF: Float32Array;
  dirt: Float32Array;
  nBig: Float32Array;
  nMid: Float32Array;
  nSm: Float32Array;
  nFine: Float32Array;
  seed: number;
}

export interface Ep12GroundResult {
  /** Emissive mask for the ground material (ash only). Same UV layout as the ground texture. */
  glowTexture: THREE.CanvasTexture | null;
  /** Low-res (W x H) mask: no grass strokes here (planks, slabs, tiles, inlay, coping). */
  notick: Uint8Array;
  /** Per-cell pier deck: 0 none, 1 east-west, 2 north-south (harbor only). */
  deckCells: Int8Array | null;
}

export function wantsEp12Ground(theme: HqThemeSpec): boolean {
  const st = theme.gstyle;
  return Boolean(st.ash || st.deck || st.castle);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** `_ss` (works with a > b too: reversed ramp). */
function ss(x: number, a: number, b: number): number {
  const t = clamp01((x - a) / (b - a + 1e-9));
  return t * t * (3 - 2 * t);
}

function fract(x: number): number {
  return x - Math.floor(x);
}

/** Chamfer (1, sqrt2) distance in pixels from every pixel with mask = 1 to the nearest mask = 0 pixel. */
function distToZero(mask: Uint8Array, w: number, h: number): Float32Array {
  const d = new Float32Array(w * h);
  const INF = 1e6;
  for (let i = 0; i < w * h; i++) d[i] = mask[i] ? INF : 0;
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) {
      let v = d[r + x];
      if (v === 0) continue;
      if (x > 0) v = Math.min(v, d[r + x - 1] + 1);
      if (y > 0) {
        v = Math.min(v, d[r - w + x] + 1);
        if (x > 0) v = Math.min(v, d[r - w + x - 1] + 1.4142);
        if (x + 1 < w) v = Math.min(v, d[r - w + x + 1] + 1.4142);
      }
      d[r + x] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    const r = y * w;
    for (let x = w - 1; x >= 0; x--) {
      let v = d[r + x];
      if (v === 0) continue;
      if (x + 1 < w) v = Math.min(v, d[r + x + 1] + 1);
      if (y + 1 < h) {
        v = Math.min(v, d[r + w + x] + 1);
        if (x + 1 < w) v = Math.min(v, d[r + w + x + 1] + 1.4142);
        if (x > 0) v = Math.min(v, d[r + w + x - 1] + 1.4142);
      }
      d[r + x] = v;
    }
  }
  return d;
}

function boxBlur(src: Float32Array, w: number, h: number, radiusPx: number, passes = 2): Float32Array {
  const r = Math.max(1, Math.round(radiusPx));
  const cur = new Float32Array(src);
  const tmp = new Float32Array(w * h);
  const inv = 1 / (2 * r + 1);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = cur[row] * (r + 1);
      for (let x = 1; x <= r; x++) acc += cur[row + Math.min(w - 1, x)];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc * inv;
        acc += cur[row + Math.min(w - 1, x + r + 1)] - cur[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = tmp[x] * (r + 1);
      for (let y = 1; y <= r; y++) acc += tmp[Math.min(h - 1, y) * w + x];
      for (let y = 0; y < h; y++) {
        cur[y * w + x] = acc * inv;
        acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
  }
  return cur;
}

/** Exact 1-D squared distance transform (Felzenszwalb) helper for the cell-level deck detection. */
function edt(mask: Uint8Array, w: number, h: number): Float32Array {
  // distance from each 1-pixel to the nearest 0-pixel (pixels), exact
  const INF = 1e12;
  const f = new Float64Array(Math.max(w, h));
  const out = new Float64Array(w * h);
  const v = new Int32Array(Math.max(w, h));
  const z = new Float64Array(Math.max(w, h) + 1);
  const dt1 = (n: number, get: (i: number) => number, set: (i: number, val: number) => void) => {
    for (let i = 0; i < n; i++) f[i] = get(i);
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      set(q, (q - v[k]) * (q - v[k]) + f[v[k]]);
    }
  };
  for (let i = 0; i < w * h; i++) out[i] = mask[i] ? INF : 0;
  for (let x = 0; x < w; x++) dt1(h, (i) => out[i * w + x], (i, val) => (out[i * w + x] = val));
  for (let y = 0; y < h; y++) dt1(w, (i) => out[y * w + i], (i, val) => (out[y * w + i] = val));
  const res = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) res[i] = Math.sqrt(out[i]);
  return res;
}

function mixInto(px: Float32Array, i3: number, c: ArrayLike<number>, f: number) {
  const u = clamp01(f);
  if (u <= 0) return;
  px[i3] += (c[0] - px[i3]) * u;
  px[i3 + 1] += (c[1] - px[i3 + 1]) * u;
  px[i3 + 2] += (c[2] - px[i3 + 2]) * u;
}

/** Bilinear sampler for the low-resolution base-paint fields. */
function makeLowSampler(W: number, H: number, PPM: number, MG: number) {
  return (arr: Float32Array, mx: number, my: number): number => {
    const fx = Math.min(W - 1.001, Math.max(0, (mx + MG) * PPM));
    const fy = Math.min(H - 1.001, Math.max(0, (my + MG) * PPM));
    const ix = fx | 0;
    const iy = fy | 0;
    const tx = fx - ix;
    const ty = fy - iy;
    const i = iy * W + ix;
    const a = arr[i] + (arr[i + 1] - arr[i]) * tx;
    const b = arr[i + W] + (arr[i + W + 1] - arr[i + W]) * tx;
    return a + (b - a) * ty;
  };
}

/** Stone slab rows (`_slab_layer`): returns slab rects [x0, y0, x1, y1, tone] in metres for slabs whose centre wants one. */
function slabRects(
  rng: SeededRng,
  wantAt: (mx: number, my: number) => number,
  Wm: number,
  Hm: number,
  MG: number,
  rowh: number,
  sq: boolean,
): [number, number, number, number, number][] {
  const out: [number, number, number, number, number][] = [];
  const widths = [0.5, 0.5, 0.75, 1.0];
  let yy0 = -MG;
  let row = 0;
  while (yy0 < Hm + MG) {
    let xx0 = -MG - (sq ? rowh * 0.5 * (row % 2) : rng.uniform(0, 0.5));
    while (xx0 < Wm + MG) {
      const wd = sq ? rowh : rng.choice(widths);
      const cx = xx0 + wd * 0.5;
      const cy = yy0 + rowh * 0.5;
      if (wantAt(cx, cy) > rng.uniform(0.25, 0.6)) out.push([xx0, yy0, xx0 + wd, yy0 + rowh, rng.uniform(-1, 1)]);
      xx0 += wd;
    }
    yy0 += rowh;
    row++;
  }
  return out;
}

function slabColor(C: HqThemeSpec['ground'], tone: number, nFine: number): [number, number, number] {
  const base = C.slab ?? C.dirt;
  const hi = C.slab_hi ?? C.dirt_hi;
  const lo = C.slab_lo ?? C.dirt_lo;
  let r = base[0];
  let g = base[1];
  let b = base[2];
  const th = clamp01(tone) * 0.7;
  r += (hi[0] - r) * th;
  g += (hi[1] - g) * th;
  b += (hi[2] - b) * th;
  const tl = clamp01(-tone) * 0.6;
  r += (lo[0] - r) * tl;
  g += (lo[1] - g) * tl;
  b += (lo[2] - b) * tl;
  const k = 1 + (nFine - 0.5) * 0.06;
  return [r * k, g * k, b * k];
}

export function paintEp12Ground(a: Ep12GroundArgs): Ep12GroundResult {
  const { mapData, theme, ctx, TW, TH, hiPPM, MG, W, H, PPM } = a;
  const st = theme.gstyle;
  const C = theme.ground;
  const rng = new SeededRng(a.seed + 900);
  const { nx, ny, cells } = mapData;
  const cs = mapData.cell / 1000;
  const Wm = nx * cs;
  const Hm = ny * cs;
  const sample = makeLowSampler(W, H, PPM, MG);
  const notick = new Uint8Array(W * H);
  const markNotick = (mx: number, my: number) => {
    const ix = Math.round((mx + MG) * PPM);
    const iy = Math.round((my + MG) * PPM);
    if (ix >= 0 && iy >= 0 && ix < W && iy < H) notick[iy * W + ix] = 1;
  };
  const cellAt = (mx: number, my: number): number => {
    const gx = Math.floor(mx / cs);
    const gy = Math.floor(my / cs);
    if (gx < 0 || gy < 0 || gx >= nx || gy >= ny) return CellType.PIT;
    return cells[gy * nx + gx];
  };
  const liqCells = computeLiquidCells(mapData, theme.liquid ?? { kind: 'water', z: -0.4, where: 'enclosed', minCells: 1 });
  const liqAt = (mx: number, my: number): boolean => {
    const gx = Math.floor(mx / cs);
    const gy = Math.floor(my / cs);
    return gx >= 0 && gy >= 0 && gx < nx && gy < ny && liqCells[gy * nx + gx] === 1;
  };

  let glowTexture: THREE.CanvasTexture | null = null;
  let deckCells: Int8Array | null = null;

  // ================================================================ ash (caldera) — composited at half resolution
  if (st.ash) {
    const MW = Math.max(16, Math.round(TW / 2));
    const MH = Math.max(16, Math.round(TH / 2));
    const mppm = MW / (Wm + 2 * MG);
    const N = MW * MH;
    const mxOf = (px: number) => (px + 0.5) / mppm - MG;
    const myOf = (py: number) => (py + 0.5) / mppm - MG;
    const solid = new Uint8Array(N);
    const wall = new Uint8Array(N);
    const liq = new Uint8Array(N);
    const notLiq = new Uint8Array(N);
    for (let py = 0; py < MH; py++) {
      const my = myOf(py);
      for (let px = 0; px < MW; px++) {
        const mx = mxOf(px);
        const i = py * MW + px;
        const ct = cellAt(mx, my);
        if (ct !== CellType.PIT) solid[i] = 1;
        if (ct === CellType.WALL) wall[i] = 1;
        if (liqAt(mx, my)) liq[i] = 1;
        notLiq[i] = liq[i] ? 0 : 1;
      }
    }
    const dLiq = distToZero(notLiq, MW, MH); // px to nearest liquid pixel
    for (let i = 0; i < N; i++) dLiq[i] /= mppm;
    const okp = new Float32Array(N);
    const nMidM = new Float32Array(N);
    const nSmM = new Float32Array(N);
    const dirtM = new Float32Array(N);
    for (let py = 0; py < MH; py++) {
      const my = myOf(py);
      for (let px = 0; px < MW; px++) {
        const mx = mxOf(px);
        const i = py * MW + px;
        const tf = sample(a.tallF, mx, my);
        const dt = sample(a.dirt, mx, my);
        dirtM[i] = dt;
        nMidM[i] = sample(a.nMid, mx, my);
        nSmM[i] = sample(a.nSm, mx, my);
        okp[i] = solid[i] * (1 - ss(tf, 0.2, 0.5)) * (1 - ss(dt, 0.3, 0.6)) * (1 - wall[i]);
      }
    }

    // Cracks: random walks of 0.1 m steps; every third one grows out of the lava bank, heading away from the lake
    const crkCanvas = document.createElement('canvas');
    crkCanvas.width = MW;
    crkCanvas.height = MH;
    const cctx = crkCanvas.getContext('2d')!;
    cctx.lineCap = 'round';
    cctx.lineJoin = 'round';
    const ringPx: number[] = [];
    let lcx = 0;
    let lcy = 0;
    let lcn = 0;
    for (let i = 0; i < N; i++) {
      if (liq[i]) {
        lcx += i % MW;
        lcy += (i / MW) | 0;
        lcn++;
      } else if (solid[i] && dLiq[i] < 0.045) ringPx.push(i);
    }
    if (lcn) {
      lcx /= lcn;
      lcy /= lcn;
    } else {
      lcx = MW / 2;
      lcy = MH / 2;
    }
    let solidArea = 0;
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) if (cells[y * nx + x] !== CellType.PIT) solidArea += cs * cs;
    const step = 0.1 * mppm;
    const crisp: { pts: [number, number][]; branches: [number, number, number, number][] }[] = [];
    const nCracks = Math.floor(solidArea * 0.35);
    for (let k = 0; k < nCracks; k++) {
      let x: number;
      let y: number;
      let ang: number;
      if (ringPx.length && k % 3 === 0) {
        const j = ringPx[rng.int(0, ringPx.length)];
        x = j % MW;
        y = (j / MW) | 0;
        ang = Math.atan2(y - lcy, x - lcx) + rng.normal(0, 0.5);
      } else {
        x = rng.int(0, MW);
        y = rng.int(0, MH);
        const i0 = (y | 0) * MW + (x | 0);
        if (okp[i0] < 0.5 || nMidM[i0] < 0.5) continue;
        ang = rng.uniform(0, 6.28);
      }
      const pts: [number, number][] = [[x, y]];
      const branches: [number, number, number, number][] = [];
      const nst = rng.int(6, 16);
      for (let s = 0; s < nst; s++) {
        ang += rng.normal(0, 0.3) + (rng.next() < 0.2 ? rng.choice([-0.9, 0.9]) : 0);
        x += Math.cos(ang) * step;
        y += Math.sin(ang) * step;
        if (!(x >= 0 && x < MW && y >= 0 && y < MH) || okp[(y | 0) * MW + (x | 0)] < 0.4) break;
        pts.push([x, y]);
        if (rng.next() < 0.25) {
          const b = ang + rng.choice([-1, 1]) * rng.uniform(0.6, 1.1);
          branches.push([x, y, x + Math.cos(b) * step, y + Math.sin(b) * step]);
        }
      }
      if (pts.length >= 2) crisp.push({ pts, branches });
    }
    const lwMain = Math.max(1, (2 / 80) * mppm);
    for (const c of crisp) {
      cctx.strokeStyle = 'rgb(255,255,255)';
      cctx.lineWidth = lwMain;
      cctx.beginPath();
      cctx.moveTo(c.pts[0][0], c.pts[0][1]);
      for (let i = 1; i < c.pts.length; i++) cctx.lineTo(c.pts[i][0], c.pts[i][1]);
      cctx.stroke();
      cctx.strokeStyle = 'rgb(150,150,150)';
      cctx.lineWidth = Math.max(0.8, lwMain * 0.5);
      for (const [x0, y0, x1, y1] of c.branches) {
        cctx.beginPath();
        cctx.moveTo(x0, y0);
        cctx.lineTo(x1, y1);
        cctx.stroke();
      }
    }
    const crkData = cctx.getImageData(0, 0, MW, MH).data;

    // Cooled-lava plates: Voronoi edges in noisy zones and around the lake
    const zone = new Float32Array(N);
    const zoneIdx: number[] = [];
    for (let i = 0; i < N; i++) {
      let zv = ss(nMidM[i] * 0.75 + nSmM[i] * 0.25, 0.6, 0.7) * okp[i];
      zv = Math.max(zv, (1 - ss(dLiq[i], 0.15, 0.5)) * okp[i] * 0.4);
      zone[i] = zv;
      if (zv > 0.05) zoneIdx.push(i);
    }
    const net = new Float32Array(N);
    if (zoneIdx.length) {
      const npt = Math.max(4, Math.floor((zoneIdx.length / mppm / mppm) * 3.6));
      const bucket = Math.max(2, Math.round(0.6 * mppm));
      const BW = Math.ceil(MW / bucket) + 1;
      const BH = Math.ceil(MH / bucket) + 1;
      const grid: number[][] = Array.from({ length: BW * BH }, () => []);
      const sx = new Float32Array(npt);
      const sy = new Float32Array(npt);
      for (let k = 0; k < npt; k++) {
        const i = zoneIdx[rng.int(0, zoneIdx.length)];
        sx[k] = (i % MW) + rng.uniform(-0.5, 0.5);
        sy[k] = ((i / MW) | 0) + rng.uniform(-0.5, 0.5);
        const bx = Math.max(0, Math.min(BW - 1, Math.floor(sx[k] / bucket)));
        const by = Math.max(0, Math.min(BH - 1, Math.floor(sy[k] / bucket)));
        grid[by * BW + bx].push(k);
      }
      for (const i of zoneIdx) {
        const x = i % MW;
        const y = (i / MW) | 0;
        const bx = Math.floor(x / bucket);
        const by = Math.floor(y / bucket);
        let d1 = Infinity;
        let d2 = Infinity;
        for (let r = 1; r <= 3; r++) {
          for (let yy = by - r; yy <= by + r; yy++) {
            if (yy < 0 || yy >= BH) continue;
            for (let xx = bx - r; xx <= bx + r; xx++) {
              if (xx < 0 || xx >= BW) continue;
              if (r > 1 && Math.abs(xx - bx) < r && Math.abs(yy - by) < r) continue;
              for (const k of grid[yy * BW + xx]) {
                const d = Math.hypot(sx[k] - x, sy[k] - y);
                if (d < d1) {
                  d2 = d1;
                  d1 = d;
                } else if (d < d2) d2 = d;
              }
            }
          }
          if (d2 < (r - 0.5) * bucket) break;
        }
        if (d2 < Infinity) {
          const gap = (d2 - d1) / mppm;
          net[i] = (1 - ss(gap, 0.004 * 80 / mppm, 0.014 * 80 / mppm)) * zone[i] * 0.85;
        }
      }
    }
    const core = new Float32Array(N);
    for (let i = 0; i < N; i++) core[i] = Math.max((crkData[i * 4] / 255) * okp[i], net[i]);
    let halo = boxBlur(core, MW, MH, Math.max(1, 0.045 * mppm * 0.85), 2);
    const hv: number[] = [];
    for (let i = 0; i < N; i += 3) if (halo[i] > 0.01) hv.push(halo[i]);
    hv.sort((p, q) => p - q);
    const p90 = hv.length ? hv[Math.floor(hv.length * 0.9)] : 1;
    const hk = 1 / Math.max(1e-6, p90);
    halo = halo.map((v) => clamp01(v * hk));

    // Compose all ash mixes into one RGBA layer drawn over the 2K canvas (alpha compositing == sequential mixes)
    const layer = new ImageData(MW, MH);
    const ld = layer.data;
    const glowImg = new ImageData(MW, MH);
    const gd = glowImg.data;
    const light = C.light;
    const dark = C.dark;
    const heatC = C.heat ?? [196, 104, 76];
    const glowC = C.glow ?? [255, 150, 60];
    const haloDark: RGB = [58, 44, 50];
    for (let py = 0; py < MH; py++) {
      const my = myOf(py);
      for (let px = 0; px < MW; px++) {
        const i = py * MW + px;
        const fs = solid[i];
        if (!fs) continue;
        const mx = mxOf(px);
        const nb = sample(a.nBig, mx, my);
        let cr = 0;
        let cg = 0;
        let cb = 0;
        let al = 0;
        const over = (c: readonly number[], f: number) => {
          const u = clamp01(f);
          if (u <= 0) return;
          cr = c[0] * u + cr * (1 - u);
          cg = c[1] * u + cg * (1 - u);
          cb = c[2] * u + cb * (1 - u);
          al = u + al * (1 - u);
        };
        over(light, ss(nb * 0.55 + nMidM[i] * 0.45, 0.52, 0.7) * (1 - dirtM[i] * 0.5) * 0.6);
        over(dark, ss(nMidM[i] * 0.7 + nSmM[i] * 0.3, 0.4, 0.26) * 0.45);
        const h = halo[i];
        over(haloDark, ss(h, 0.04, 0.35) * 0.6);
        over(heatC, ss(h, 0.4, 0.95) * 0.55);
        over(glowC, core[i] * 0.95);
        const heat = 1 - ss(dLiq[i], 0.0, 0.55);
        over(heatC, heat * 0.65);
        over(glowC, (1 - ss(dLiq[i], 0.0, 0.12)) * 0.7);
        if (al > 0.002) {
          ld[i * 4] = cr / al;
          ld[i * 4 + 1] = cg / al;
          ld[i * 4 + 2] = cb / al;
          ld[i * 4 + 3] = al * 255;
        }
        const gv = clamp01(core[i] * 0.9 + ss(h, 0.4, 0.95) * 0.25 + (1 - ss(dLiq[i], 0.0, 0.14)) * 0.8 + heat * 0.15);
        const g8 = gv * 255;
        gd[i * 4] = g8;
        gd[i * 4 + 1] = g8;
        gd[i * 4 + 2] = g8;
        gd[i * 4 + 3] = 255;
      }
    }
    const lc = document.createElement('canvas');
    lc.width = MW;
    lc.height = MH;
    lc.getContext('2d')!.putImageData(layer, 0, 0);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(lc, 0, 0, TW, TH);
    // Crisp crack cores on top at full resolution
    const k2 = TW / MW;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = `rgba(${glowC[0]},${glowC[1]},${glowC[2]},0.9)`;
    ctx.lineWidth = Math.max(1.2, (2 / 80) * hiPPM);
    for (const c of crisp) {
      ctx.beginPath();
      ctx.moveTo(c.pts[0][0] * k2, c.pts[0][1] * k2);
      for (let i = 1; i < c.pts.length; i++) ctx.lineTo(c.pts[i][0] * k2, c.pts[i][1] * k2);
      ctx.stroke();
    }
    ctx.restore();
    const gc = document.createElement('canvas');
    gc.width = MW;
    gc.height = MH;
    gc.getContext('2d')!.putImageData(glowImg, 0, 0);
    glowTexture = new THREE.CanvasTexture(gc);
    glowTexture.colorSpace = THREE.NoColorSpace;
    glowTexture.wrapS = THREE.ClampToEdgeWrapping;
    glowTexture.wrapT = THREE.ClampToEdgeWrapping;
    glowTexture.needsUpdate = true;

    // Scattered pumice / scoria dots
    const nDots = Math.floor(solidArea * 22);
    const pa = C.pebble_a;
    const pb = C.pebble_b;
    for (let k = 0; k < nDots; k++) {
      const mx = rng.uniform(-MG, Wm + MG);
      const my = rng.uniform(-MG, Hm + MG);
      const ct = cellAt(mx, my);
      if (ct === CellType.PIT || ct === CellType.WALL) continue;
      const ip = Math.min(MH - 1, Math.max(0, Math.floor((my + MG) * mppm))) * MW + Math.min(MW - 1, Math.max(0, Math.floor((mx + MG) * mppm)));
      if (dLiq[ip] < 0.15) continue;
      const r = rng.uniform(0.01, 0.028) * hiPPM;
      const c = rng.next() < 0.65 ? pa : pb;
      ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${(c[3] / 255).toFixed(2)})`;
      ctx.beginPath();
      ctx.ellipse((mx + MG) * hiPPM, (my + MG) * hiPPM, r, r * 0.8, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ================================================================ deck / castle — per pixel at full resolution
  if (st.deck || st.castle) {
    const img = ctx.getImageData(0, 0, TW, TH);
    const d = img.data;
    const N = TW * TH;
    const px3 = new Float32Array(3);
    const mxOf = (px: number) => (px + 0.5) / hiPPM - MG;
    const myOf = (py: number) => (py + 0.5) / hiPPM - MG;
    const notLiq = new Uint8Array(N);
    const solidHi = new Uint8Array(N);
    for (let py = 0; py < TH; py++) {
      const my = myOf(py);
      for (let px = 0; px < TW; px++) {
        const mx = mxOf(px);
        const i = py * TW + px;
        notLiq[i] = liqAt(mx, my) ? 0 : 1;
        solidHi[i] = cellAt(mx, my) !== CellType.PIT ? 1 : 0;
      }
    }
    const dLiq = distToZero(notLiq, TW, TH);
    for (let i = 0; i < N; i++) dLiq[i] /= hiPPM;
    const load = (i: number) => {
      px3[0] = d[i * 4];
      px3[1] = d[i * 4 + 1];
      px3[2] = d[i * 4 + 2];
    };
    const store = (i: number) => {
      d[i * 4] = px3[0];
      d[i * 4 + 1] = px3[1];
      d[i * 4 + 2] = px3[2];
    };
    const tallAt = (mx: number, my: number) => sample(a.tallF, mx, my);

    // ---------------------------------------------------------------- deck (harbor piers)
    if (st.deck) {
      const rM = st.deck;
      const up = 4;
      const q = cs / up;
      const SW = nx * up;
      const SH = ny * up;
      const sc = new Uint8Array(SW * SH);
      for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) sc[y * SW + x] = cells[((y / up) | 0) * nx + ((x / up) | 0)] !== CellType.PIT ? 1 : 0;
      const dIn = edt(sc, SW, SH);
      const coreM = new Uint8Array(SW * SH);
      let anyCore = false;
      for (let i = 0; i < SW * SH; i++) {
        coreM[i] = dIn[i] * q >= rM ? 1 : 0;
        if (coreM[i]) anyCore = true;
      }
      const notCore = new Uint8Array(SW * SH);
      for (let i = 0; i < SW * SH; i++) notCore[i] = coreM[i] ? 0 : 1;
      const dOut = anyCore ? edt(notCore, SW, SH) : null;
      const narrow = new Uint8Array(nx * ny);
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          let cnt = 0;
          for (let i = 0; i < up; i++) {
            for (let j = 0; j < up; j++) {
              const s = (y * up + i) * SW + x * up + j;
              const opened = dOut ? dOut[s] * q <= rM : false;
              if (sc[s] && !opened) cnt++;
            }
          }
          narrow[y * nx + x] = cnt / (up * up) > 0.5 ? 1 : 0;
        }
      }
      const nearLiq = new Uint8Array(nx * ny);
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const i = y * nx + x;
          if (liqCells[i]) nearLiq[i] = 1;
          else if ((x > 0 && liqCells[i - 1]) || (x < nx - 1 && liqCells[i + 1]) || (y > 0 && liqCells[i - nx]) || (y < ny - 1 && liqCells[i + nx])) nearLiq[i] = 1;
        }
      }
      const deckC = new Uint8Array(nx * ny);
      const seen = new Uint8Array(nx * ny);
      for (let s0 = 0; s0 < nx * ny; s0++) {
        if (!narrow[s0] || seen[s0]) continue;
        const st0 = [s0];
        const comp: number[] = [];
        seen[s0] = 1;
        let touches = false;
        while (st0.length) {
          const c = st0.pop()!;
          comp.push(c);
          if (nearLiq[c]) touches = true;
          const cx = c % nx;
          const cy = (c / nx) | 0;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const xx = cx + dx;
            const yy = cy + dy;
            if (xx < 0 || yy < 0 || xx >= nx || yy >= ny) continue;
            const n = yy * nx + xx;
            if (narrow[n] && !seen[n]) {
              seen[n] = 1;
              st0.push(n);
            }
          }
        }
        if (touches && comp.length >= 6) for (const c of comp) deckC[c] = 1;
      }
      // Board direction: along the longer run through the cell
      const runH = new Int32Array(nx * ny);
      const runV = new Int32Array(nx * ny);
      for (let y = 0; y < ny; y++) {
        let x = 0;
        while (x < nx) {
          if (!deckC[y * nx + x]) {
            x++;
            continue;
          }
          let k = x;
          while (k < nx && deckC[y * nx + k]) k++;
          for (let j = x; j < k; j++) runH[y * nx + j] = k - x;
          x = k;
        }
      }
      for (let x = 0; x < nx; x++) {
        let y = 0;
        while (y < ny) {
          if (!deckC[y * nx + x]) {
            y++;
            continue;
          }
          let k = y;
          while (k < ny && deckC[k * nx + x]) k++;
          for (let j = y; j < k; j++) runV[j * nx + x] = k - y;
          y = k;
        }
      }
      deckCells = new Int8Array(nx * ny);
      for (let i = 0; i < nx * ny; i++) if (deckC[i]) deckCells[i] = runH[i] >= runV[i] * 0.8 ? 1 : 2;

      const deckAt = (mx: number, my: number): number => {
        const gx = Math.floor(mx / cs);
        const gy = Math.floor(my / cs);
        if (gx < 0 || gy < 0 || gx >= nx || gy >= ny) return 0;
        return deckCells![gy * nx + gx];
      };
      const deckHi = new Uint8Array(N);
      const notDeck = new Uint8Array(N);
      for (let py = 0; py < TH; py++) {
        const my = myOf(py);
        for (let px = 0; px < TW; px++) {
          const i = py * TW + px;
          deckHi[i] = solidHi[i] && deckAt(mxOf(px), my) ? 1 : 0;
          notDeck[i] = deckHi[i] ? 0 : 1;
        }
      }
      const dSea = distToZero(deckHi, TW, TH); // inside deck: px to nearest non-deck
      const dDeck = distToZero(notDeck, TW, TH); // outside deck: px to nearest deck
      const wood = st.wood ?? [
        [196, 150, 104],
        [170, 124, 86],
        [216, 174, 124],
      ];
      const bw = 0.26;
      for (let py = 0; py < TH; py++) {
        const my = myOf(py);
        for (let px = 0; px < TW; px++) {
          const i = py * TW + px;
          if (!deckHi[i]) continue;
          const mx = mxOf(px);
          const ew = deckAt(mx, my) === 1;
          const t = ew ? mx : my;
          const u = ew ? my : mx;
          const pid = Math.floor(t / bw);
          const hsh = fract(Math.sin(pid * 12.9898) * 43758.5453);
          px3[0] = wood[0][0];
          px3[1] = wood[0][1];
          px3[2] = wood[0][2];
          mixInto(px3, 0, wood[1], ss(hsh, 0.55, 0.9) * 0.8);
          mixInto(px3, 0, wood[2], ss(hsh, 0.45, 0.1) * 0.7);
          const fr = fract(t / bw);
          let k = 1 - 0.5 * (1 - ss(Math.min(fr, 1 - fr), 0.03, 0.09));
          const fu = fract((u + hsh * 2.1) / 2.1);
          k *= 1 - 0.35 * (1 - ss(Math.min(fu, 1 - fu), 0.004, 0.012));
          k *= 1 + 0.05 * Math.sin(u * 47 + pid * 3.1) + (sample(a.nFine, mx, my) - 0.5) * 0.08;
          px3[0] *= k;
          px3[1] *= k;
          px3[2] *= k;
          const um = ((u % 0.7) + 0.7) % 0.7;
          const nail = 1 - ss(Math.hypot((fr - 0.5) * bw, um - 0.35), 0.012, 0.022);
          mixInto(px3, 0, [110, 84, 70], nail * 0.7);
          mixInto(px3, 0, [110, 74, 52], (1 - ss(dSea[i] / hiPPM, 0.05, 0.12)) * 0.85);
          mixInto(px3, 0, [236, 214, 176], sample(a.dirt, mx, my) * 0.25);
          store(i);
          markNotick(mx, my);
        }
      }
      // Quay: stone slabs within 1.3 m of a pier and 0.9 m of the water, then the coping along the water
      const wantAt = (mx: number, my: number): number => {
        const ix = Math.min(TW - 1, Math.max(0, Math.floor((mx + MG) * hiPPM)));
        const iy = Math.min(TH - 1, Math.max(0, Math.floor((my + MG) * hiPPM)));
        const i = iy * TW + ix;
        if (!solidHi[i] || deckHi[i]) return 0;
        if (!(dDeck[i] / hiPPM < 1.3 || dLiq[i] < 0.9)) return 0;
        return 1 - ss(tallAt(mx, my), 0.2, 0.5);
      };
      const joint = C.joint ?? C.dirt_lo;
      for (let py = 0; py < TH; py++) {
        const my = myOf(py);
        for (let px = 0; px < TW; px++) {
          const mx = mxOf(px);
          const w = wantAt(mx, my);
          if (w <= 0) continue;
          const i = py * TW + px;
          load(i);
          mixInto(px3, 0, joint, ss(w, 0.3, 0.8) * 0.9);
          store(i);
        }
      }
      const rects = slabRects(rng, wantAt, Wm, Hm, MG, 0.5, false);
      const inset = 2.5 * (hiPPM / 80);
      for (const [x0, y0, x1, y1, tone] of rects) {
        const pa = Math.max(0, Math.ceil((x0 + MG) * hiPPM + inset));
        const pb = Math.min(TW - 1, Math.floor((x1 + MG) * hiPPM - inset));
        const qa = Math.max(0, Math.ceil((y0 + MG) * hiPPM + inset));
        const qb = Math.min(TH - 1, Math.floor((y1 + MG) * hiPPM - inset));
        for (let py = qa; py <= qb; py++) {
          const my = myOf(py);
          for (let px = pa; px <= pb; px++) {
            const mx = mxOf(px);
            const w = wantAt(mx, my);
            if (w <= 0) continue;
            const i = py * TW + px;
            const sc3 = slabColor(C, tone, sample(a.nFine, mx, my));
            load(i);
            mixInto(px3, 0, sc3, w);
            store(i);
            if (w > 0.4) markNotick(mx, my);
          }
        }
      }
      const cop = C.slab_hi ?? C.dirt_hi;
      for (let i = 0; i < N; i++) {
        if (!solidHi[i] || deckHi[i]) continue;
        const f = (1 - ss(dLiq[i], 0.05, 0.13)) * 0.9;
        if (f <= 0) continue;
        load(i);
        mixInto(px3, 0, cop, f);
        store(i);
      }
    }

    // ---------------------------------------------------------------- castle (keeps)
    if (st.castle) {
      // Wall groups (walls within a 2-cell gate gap merge) whose bounding box is a hollow frame = castles
      const wallDil = new Uint8Array(nx * ny);
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          let hit = false;
          for (let dy = -1; dy <= 1 && !hit; dy++) {
            for (let dx = -1; dx <= 1 && !hit; dx++) {
              const xx = x + dx;
              const yy = y + dy;
              if (xx >= 0 && yy >= 0 && xx < nx && yy < ny && cells[yy * nx + xx] === CellType.WALL) hit = true;
            }
          }
          wallDil[y * nx + x] = hit ? 1 : 0;
        }
      }
      const lab = new Int32Array(nx * ny).fill(-1);
      let nl = 0;
      for (let s0 = 0; s0 < nx * ny; s0++) {
        if (!wallDil[s0] || lab[s0] >= 0) continue;
        const stk = [s0];
        lab[s0] = nl;
        while (stk.length) {
          const c = stk.pop()!;
          const cx = c % nx;
          const cy = (c / nx) | 0;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const xx = cx + dx;
            const yy = cy + dy;
            if (xx < 0 || yy < 0 || xx >= nx || yy >= ny) continue;
            const n = yy * nx + xx;
            if (wallDil[n] && lab[n] < 0) {
              lab[n] = nl;
              stk.push(n);
            }
          }
        }
        nl++;
      }
      const floorC = new Uint8Array(nx * ny);
      const boxes: [number, number, number, number][] = [];
      for (let l = 0; l < nl; l++) {
        let x0 = nx;
        let x1 = -1;
        let y0 = ny;
        let y1 = -1;
        let cnt = 0;
        for (let i = 0; i < nx * ny; i++) {
          if (lab[i] !== l || cells[i] !== CellType.WALL) continue;
          const x = i % nx;
          const y = (i / nx) | 0;
          x0 = Math.min(x0, x);
          x1 = Math.max(x1, x);
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
          cnt++;
        }
        if (!cnt) continue;
        const bw = x1 - x0 + 1;
        const bh = y1 - y0 + 1;
        if (bw >= 5 && bh >= 5 && cnt < 0.7 * bw * bh) {
          for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) floorC[y * nx + x] = 1;
          boxes.push([x0, y0, x1 + 1, y1 + 1]);
        }
      }
      const isFloor = (mx: number, my: number): boolean => {
        const gx = Math.floor(mx / cs);
        const gy = Math.floor(my / cs);
        if (gx < 0 || gy < 0 || gx >= nx || gy >= ny) return false;
        const i = gy * nx + gx;
        return floorC[i] === 1 && cells[i] !== CellType.PIT && cells[i] !== CellType.WALL;
      };
      const joint = C.joint ?? C.dirt_lo;
      // Castle floors: joint colour then staggered 25 cm square tiles
      for (let py = 0; py < TH; py++) {
        const my = myOf(py);
        for (let px = 0; px < TW; px++) {
          const mx = mxOf(px);
          if (!isFloor(mx, my)) continue;
          const i = py * TW + px;
          load(i);
          mixInto(px3, 0, joint, 1);
          store(i);
          markNotick(mx, my);
        }
      }
      const tiles = slabRects(rng, (mx, my) => (isFloor(mx, my) ? 2 : 0), Wm, Hm, MG, 0.25, true);
      const tileInset = 1.5 * (hiPPM / 80);
      const paintRects = (
        rects: [number, number, number, number, number][],
        ins: number,
        wantFn: (mx: number, my: number) => number,
        tint: (c: [number, number, number], mx: number, my: number) => void,
      ) => {
        for (const [x0, y0, x1, y1, tone] of rects) {
          const pa = Math.max(0, Math.ceil((x0 + MG) * hiPPM + ins));
          const pb = Math.min(TW - 1, Math.floor((x1 + MG) * hiPPM - ins));
          const qa = Math.max(0, Math.ceil((y0 + MG) * hiPPM + ins));
          const qb = Math.min(TH - 1, Math.floor((y1 + MG) * hiPPM - ins));
          for (let py = qa; py <= qb; py++) {
            const my = myOf(py);
            for (let px = pa; px <= pb; px++) {
              const mx = mxOf(px);
              const w = Math.min(1, wantFn(mx, my));
              if (w <= 0) continue;
              const i = py * TW + px;
              const sc3 = slabColor(C, tone, sample(a.nFine, mx, my));
              tint(sc3, mx, my);
              load(i);
              mixInto(px3, 0, sc3, w);
              store(i);
              if (w > 0.4) markNotick(mx, my);
            }
          }
        }
      };
      paintRects(tiles, tileInset, (mx, my) => (isFloor(mx, my) ? 1 : 0), (c, mx, my) => {
        const dt = sample(a.dirt, mx, my) * 0.3;
        c[0] += (236 - c[0]) * dt;
        c[1] += (226 - c[1]) * dt;
        c[2] += (204 - c[2]) * dt;
      });
      // Plaza between the castles: an ellipse of slabs with a noisy rim
      const lefts = boxes.filter((b) => (b[0] + b[2]) / 2 < nx / 2);
      const rights = boxes.filter((b) => (b[0] + b[2]) / 2 >= nx / 2);
      const xa = lefts.length ? Math.max(...lefts.map((b) => b[2])) * cs : Wm * 0.25;
      const xb = rights.length ? Math.min(...rights.map((b) => b[0])) * cs : Wm * 0.75;
      const rx = Math.max(1, (xb - xa) / 2 - 1);
      const ry = Hm * 0.32;
      const plazaWant = (mx: number, my: number): number => {
        const ct = cellAt(mx, my);
        if (ct === CellType.PIT || isFloor(mx, my)) return 0;
        const ell = Math.hypot((mx - (xa + xb) / 2) / rx, (my - Hm / 2) / ry);
        return ss(ell + (sample(a.nMid, mx, my) - 0.5) * 0.35, 1.05, 0.85) * (1 - ss(tallAt(mx, my), 0.2, 0.5));
      };
      const pcx = (xa + xb) / 2;
      const px0 = Math.max(0, Math.floor((pcx - rx * 1.3 + MG) * hiPPM));
      const px1 = Math.min(TW - 1, Math.ceil((pcx + rx * 1.3 + MG) * hiPPM));
      const py0 = Math.max(0, Math.floor((Hm / 2 - ry * 1.3 + MG) * hiPPM));
      const py1 = Math.min(TH - 1, Math.ceil((Hm / 2 + ry * 1.3 + MG) * hiPPM));
      for (let py = py0; py <= py1; py++) {
        const my = myOf(py);
        for (let px = px0; px <= px1; px++) {
          const mx = mxOf(px);
          const w = plazaWant(mx, my);
          if (w <= 0.001) continue;
          const i = py * TW + px;
          load(i);
          mixInto(px3, 0, joint, ss(w, 0.3, 0.8) * 0.85);
          store(i);
        }
      }
      const plaza = slabRects(rng, plazaWant, Wm, Hm, MG, 0.5, false);
      const slabHi = C.slab_hi ?? C.dirt_hi;
      paintRects(plaza, 2.5 * (hiPPM / 80), plazaWant, (c, mx, my) => {
        const dt = sample(a.dirt, mx, my) * 0.4;
        c[0] += (slabHi[0] - c[0]) * dt;
        c[1] += (slabHi[1] - c[1]) * dt;
        c[2] += (slabHi[2] - c[2]) * dt;
      });
      // Last-collapsing zone (the final plaza): ringed inlay with an eight-point star
      const { waves } = mapData;
      let wmax = -1;
      let solidCnt = 0;
      for (let i = 0; i < nx * ny; i++) {
        if (cells[i] !== CellType.PIT) solidCnt++;
        if (waves[i] > wmax) wmax = waves[i];
      }
      if (wmax >= 0) {
        const fz = new Uint8Array(nx * ny);
        let fzn = 0;
        let fcx = 0;
        let fcy = 0;
        for (let i = 0; i < nx * ny; i++) {
          if (waves[i] === wmax && cells[i] !== CellType.PIT) {
            fz[i] = 1;
            fzn++;
            fcx += (i % nx) + 0.5;
            fcy += ((i / nx) | 0) + 0.5;
          }
        }
        if (fzn && fzn < 0.4 * solidCnt) {
          const ccx = (fcx / fzn) * cs;
          const ccy = (fcy / fzn) * cs;
          let bx0 = nx;
          let bx1 = 0;
          let by0 = ny;
          let by1 = 0;
          for (let i = 0; i < nx * ny; i++) {
            if (!fz[i]) continue;
            bx0 = Math.min(bx0, i % nx);
            bx1 = Math.max(bx1, i % nx);
            by0 = Math.min(by0, (i / nx) | 0);
            by1 = Math.max(by1, (i / nx) | 0);
          }
          const qx0 = Math.max(0, Math.floor((bx0 * cs + MG) * hiPPM) - 2);
          const qx1 = Math.min(TW - 1, Math.ceil(((bx1 + 1) * cs + MG) * hiPPM) + 2);
          const qy0 = Math.max(0, Math.floor((by0 * cs + MG) * hiPPM) - 2);
          const qy1 = Math.min(TH - 1, Math.ceil(((by1 + 1) * cs + MG) * hiPPM) + 2);
          const LW = qx1 - qx0 + 1;
          const LH = qy1 - qy0 + 1;
          const fzp = new Uint8Array(LW * LH);
          for (let py = qy0; py <= qy1; py++) {
            for (let px = qx0; px <= qx1; px++) {
              const gx = Math.floor(mxOf(px) / cs);
              const gy = Math.floor(myOf(py) / cs);
              fzp[(py - qy0) * LW + px - qx0] =
                gx >= 0 && gy >= 0 && gx < nx && gy < ny && fz[gy * nx + gx] && solidHi[py * TW + px] ? 1 : 0;
            }
          }
          const din = distToZero(fzp, LW, LH);
          const slab = C.slab ?? C.dirt;
          const slabLo = C.slab_lo ?? C.dirt_lo;
          const emb = C.emblem ?? [196, 120, 96];
          const emb2 = C.emblem2 ?? [232, 196, 120];
          for (let py = qy0; py <= qy1; py++) {
            const my = myOf(py);
            for (let px = qx0; px <= qx1; px++) {
              const li = (py - qy0) * LW + px - qx0;
              const dn = din[li] / hiPPM;
              const kk = ss(dn, 0.0, 0.02);
              if (kk <= 0) continue;
              const mx = mxOf(px);
              const rr = Math.hypot(mx - ccx, my - ccy);
              const ang = Math.atan2(my - ccy, mx - ccx);
              const inl = new Float32Array([slabHi[0], slabHi[1], slabHi[2]]);
              const ringi = Math.floor(rr / 0.42);
              mixInto(inl, 0, slab, (ringi % 2) * 0.8);
              const fr = fract(rr / 0.42);
              mixInto(inl, 0, joint, (1 - ss(Math.min(fr, 1 - fr), 0.015, 0.05)) * 0.8);
              const nseg = 8 + ringi * 4;
              const ft = fract((ang / (2 * Math.PI) + 0.5) * nseg + ringi * 0.5);
              mixInto(inl, 0, joint, (1 - ss((Math.min(ft, 1 - ft) * rr * 6.28) / Math.max(nseg, 1), 0.006, 0.02)) * 0.7);
              const star = Math.pow(Math.abs(Math.cos(ang * 4)), 6) * 0.62 + 0.28;
              mixInto(inl, 0, emb, ss(rr, star + 0.03, star - 0.03));
              mixInto(inl, 0, emb2, ss(rr, 0.2, 0.14));
              const band = ss(dn, 0.0, 0.02) * (1 - ss(dn, 0.2, 0.24));
              mixInto(inl, 0, slabLo, band * 0.9);
              mixInto(inl, 0, joint, (1 - ss(Math.abs(dn - 0.22), 0.0, 0.015)) * 0.8);
              const i = py * TW + px;
              load(i);
              mixInto(px3, 0, inl, kk);
              store(i);
              if (kk > 0.3) markNotick(mx, my);
            }
          }
        }
      }
      // Pond coping: a ring of pale stones and a joint line along the water
      for (let py = 0; py < TH; py++) {
        const my = myOf(py);
        for (let px = 0; px < TW; px++) {
          const i = py * TW + px;
          if (!solidHi[i]) continue;
          const dl = dLiq[i];
          if (dl > 0.2) continue;
          const cop = 1 - ss(dl, 0.04, 0.12);
          load(i);
          mixInto(px3, 0, slabHi, cop * 0.95);
          mixInto(px3, 0, joint, (1 - ss(Math.abs(dl - 0.13), 0.0, 0.02)) * 0.7);
          store(i);
          if (cop > 0.3) markNotick(mxOf(px), my);
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  return { glowTexture, notick, deckCells };
}
