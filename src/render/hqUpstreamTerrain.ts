import * as THREE from 'three';
import { CellType, EngineMapData } from '../game/types';
import { HqPalette } from './hqThemes';

type Vec3 = [number, number, number];
type LinRGB = [number, number, number];

class LocalRng {
  private s: number;
  constructor(seed: number) {
    this.s = (seed >>> 0) || 1;
  }
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  uniform(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(a: number, b: number): number {
    return a + Math.floor(this.next() * (b - a));
  }
}

function hexLin(hex: string): LinRGB {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

function smoothstep(x: number, a: number, b: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a + 1e-9)));
  return t * t * (3 - 2 * t);
}

function lerp3(a: LinRGB, b: LinRGB, t: number): LinRGB {
  const k = Math.max(0, Math.min(1, t));
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

interface UpstreamPalLin {
  lip: LinRGB;
  soil: LinRGB;
  rockA: LinRGB;
  rockB: LinRGB;
  rockC: LinRGB;
  rockDeep: LinRGB;
  rockUnder: LinRGB;
  ledgeHi: LinRGB;
  haze: LinRGB;
}

function makePalLin(P: HqPalette): UpstreamPalLin {
  return {
    lip: hexLin(P.lip),
    soil: hexLin(P.soil),
    rockA: hexLin(P.rock_a),
    rockB: hexLin(P.rock_b),
    rockC: hexLin(P.rock_c),
    rockDeep: hexLin(P.rock_deep),
    rockUnder: hexLin(P.rock_under),
    ledgeHi: hexLin(P.ledge_hi),
    haze: hexLin(P.haze),
  };
}

/**
 * Exact port of upstream `env.py:mat_terrain` cliff & underside shading:
 * depth ramp (rock_a -> rock_b -> rock_c -> rock_deep), per-Voronoi-column HSV shift,
 * upward ledge highlight (`ledge_hi`), downward underside tint (`rock_under`),
 * grass lip / soil top bands, and bottom aerial mist haze fade.
 */
function evalCliffColor(depth: number, ny: number, facet: number, pal: UpstreamPalLin): LinRGB {
  const t = Math.max(0, Math.min(1, depth / 7.0));
  let col: LinRGB;
  if (t <= 0.04) {
    col = pal.rockA;
  } else if (t <= 0.2) {
    col = lerp3(pal.rockA, pal.rockB, (t - 0.04) / 0.16);
  } else if (t <= 0.42) {
    col = lerp3(pal.rockB, pal.rockC, (t - 0.2) / 0.22);
  } else if (t <= 0.75) {
    col = lerp3(pal.rockC, pal.rockDeep, (t - 0.42) / 0.33);
  } else {
    col = pal.rockDeep;
  }

  // Per-Voronoi column brightness & subtle hue shift (env.py:85-86)
  const valK = 1.0 + facet * 0.09;
  const hueShift = facet * 0.015;
  let r = Math.max(0, col[0] * (valK + hueShift));
  let g = Math.max(0, col[1] * valK);
  let b = Math.max(0, col[2] * (valK - hueShift));
  col = [r, g, b];

  // Upward-facing horizontal shelf highlight (env.py:89)
  const ledgeF = smoothstep(ny, 0.25, 0.6) * 0.5;
  if (ledgeF > 0.001) col = lerp3(col, pal.ledgeHi, ledgeF);

  // Downward-facing underside shading (env.py:90)
  const underF = smoothstep(-ny, 0.15, 0.6);
  if (underF > 0.001) col = lerp3(col, pal.rockUnder, underF);

  // Soil & grass lip bands near top rim (env.py:91-92)
  const soilToRock = smoothstep(depth, 0.2, 0.34);
  col = lerp3(pal.soil, col, soilToRock);
  const lipToSoil = smoothstep(depth, 0.09, 0.17);
  col = lerp3(pal.lip, col, lipToSoil);

  // Deep bottom mist haze fade into sky (env.py:97)
  const hazeF = smoothstep(depth, 1.6, 11.0) * 0.88;
  if (hazeF > 0.001) col = lerp3(col, pal.haze, hazeF);

  return col;
}

// =====================================================================================
// 2D Signal Processing: Separable Gaussian Blur, Coarse Noise, Exact O(N) EDT
// =====================================================================================

function gaussianBlur2D(src: Float32Array, nx: number, ny: number, sigma: number): Float32Array {
  if (sigma <= 0.15) return new Float32Array(src);
  const rad = Math.max(1, Math.ceil(sigma * 2.5));
  const kSize = rad * 2 + 1;
  const kernel = new Float32Array(kSize);
  const inv2s2 = 1 / (2 * sigma * sigma);
  let kSum = 0;
  for (let i = -rad; i <= rad; i++) {
    const w = Math.exp(-i * i * inv2s2);
    kernel[i + rad] = w;
    kSum += w;
  }
  for (let i = 0; i < kSize; i++) kernel[i] /= kSum;

  const tmp = new Float32Array(nx * ny);
  // Horizontal pass
  for (let y = 0; y < ny; y++) {
    const row = y * nx;
    for (let x = 0; x < nx; x++) {
      let acc = 0;
      for (let k = -rad; k <= rad; k++) {
        const xx = x + k < 0 ? 0 : x + k >= nx ? nx - 1 : x + k;
        acc += src[row + xx] * kernel[k + rad];
      }
      tmp[row + x] = acc;
    }
  }
  // Vertical pass
  const out = new Float32Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    const row = y * nx;
    for (let x = 0; x < nx; x++) {
      let acc = 0;
      for (let k = -rad; k <= rad; k++) {
        const yy = y + k < 0 ? 0 : y + k >= ny ? ny - 1 : y + k;
        acc += tmp[yy * nx + x] * kernel[k + rad];
      }
      out[row + x] = acc;
    }
  }
  return out;
}

/** Smooth 2D coarse noise normalized to [-1, 1] (port of terrain.py:coarse_noise). */
function coarseNoise2D(nx: number, ny: number, cellPx: number, seed: number): Float32Array {
  const rng = new LocalRng(seed);
  const c = Math.max(1, Math.round(cellPx));
  const gx = Math.max(2, Math.ceil(nx / c) + 3);
  const gy = Math.max(2, Math.ceil(ny / c) + 3);
  const grid = new Float32Array(gx * gy);
  for (let i = 0; i < grid.length; i++) grid[i] = rng.uniform(-1, 1);

  const out = new Float32Array(nx * ny);
  let maxAbs = 1e-6;
  for (let y = 0; y < ny; y++) {
    const fy = y / c + 1;
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    const sy = ty * ty * (3 - 2 * ty);
    const iy0 = Math.max(0, Math.min(gy - 1, y0));
    const iy1 = Math.max(0, Math.min(gy - 1, y0 + 1));
    const row = y * nx;
    for (let x = 0; x < nx; x++) {
      const fx = x / c + 1;
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const sx = tx * tx * (3 - 2 * tx);
      const ix0 = Math.max(0, Math.min(gx - 1, x0));
      const ix1 = Math.max(0, Math.min(gx - 1, x0 + 1));
      const a = grid[iy0 * gx + ix0] * (1 - sx) + grid[iy0 * gx + ix1] * sx;
      const b = grid[iy1 * gx + ix0] * (1 - sx) + grid[iy1 * gx + ix1] * sx;
      const v = a * (1 - sy) + b * sy;
      out[row + x] = v;
      const av = Math.abs(v);
      if (av > maxAbs) maxAbs = av;
    }
  }
  const inv = 1 / maxAbs;
  for (let i = 0; i < out.length; i++) out[i] *= inv;
  return out;
}

/** Felzenszwalb-Huttenlocher exact O(n) 1D squared Euclidean distance transform. */
function edt1d(f: Float32Array, d: Float32Array, n: number, v: Int32Array, z: Float32Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -1e20;
  z[1] = 1e20;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = 1e20;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/** Exact 2D Euclidean distance transform to `targetVal` (0 or 1) in pixels. */
function edt2d(mask: Uint8Array, nx: number, ny: number, targetVal: 0 | 1): Float32Array {
  const INF = 1e12;
  const maxDim = Math.max(nx, ny);
  const f = new Float32Array(maxDim);
  const d = new Float32Array(maxDim);
  const v = new Int32Array(maxDim);
  const z = new Float32Array(maxDim + 1);
  const tmp = new Float32Array(nx * ny);

  // Pass 1: columns
  for (let x = 0; x < nx; x++) {
    for (let y = 0; y < ny; y++) {
      f[y] = mask[y * nx + x] === targetVal ? 0 : INF;
    }
    edt1d(f, d, ny, v, z);
    for (let y = 0; y < ny; y++) tmp[y * nx + x] = d[y];
  }

  // Pass 2: rows
  const out = new Float32Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    const row = y * nx;
    for (let x = 0; x < nx; x++) f[x] = tmp[row + x];
    edt1d(f, d, nx, v, z);
    for (let x = 0; x < nx; x++) out[row + x] = Math.sqrt(d[x]);
  }
  return out;
}

/** Exact port of terrain.py:signed_dist_2d(mask, res). */
function signedDist2D(mask: Uint8Array, nx: number, ny: number, res: number): Float32Array {
  const inside = edt2d(mask, nx, ny, 0);
  const outside = edt2d(mask, nx, ny, 1);
  const raw = new Float32Array(nx * ny);
  for (let i = 0; i < raw.length; i++) {
    const d = (inside[i] - outside[i]) * res;
    raw[i] = mask[i] ? d - res * 0.5 : d + res * 0.5;
  }
  return gaussianBlur2D(raw, nx, ny, 1.2);
}

/** Exact port of terrain.py:round_mask(m, corner_r, res, seed, edge_wobble). */
function roundMask(
  mask: Uint8Array,
  nx: number,
  ny: number,
  cornerR: number,
  res: number,
  seed: number,
  edgeWobble: number,
): Uint8Array {
  if (cornerR <= 0) return new Uint8Array(mask);
  const src = new Float32Array(nx * ny);
  for (let i = 0; i < src.length; i++) src[i] = mask[i];
  const mb = gaussianBlur2D(src, nx, ny, cornerR / res);
  if (edgeWobble > 0) {
    const noise = coarseNoise2D(nx, ny, Math.max(2, Math.round(1.6 / res)), seed + 11);
    const amp = edgeWobble * 2.0;
    for (let i = 0; i < mb.length; i++) mb[i] += noise[i] * amp;
  }
  const out = new Uint8Array(nx * ny);
  for (let i = 0; i < mb.length; i++) out[i] = mb[i] > 0.5 ? 1 : 0;
  return out;
}

// =====================================================================================
// Spatial-Hash 2D Voronoi Columns (port of terrain.py:voronoi_columns)
// =====================================================================================

interface VoronoiField {
  sample(wx: number, wz: number): {
    id: number;
    col: number;
    facet: number;
    ledge1: number;
    ledge2: number;
    evalAt(x: number, z: number): number;
  };
}

function createVoronoiField(
  x0: number,
  z0: number,
  spanX: number,
  spanZ: number,
  spacing: number,
  seed: number,
): VoronoiField {
  const rng = new LocalRng(seed + 29);
  const n = Math.max(4, Math.floor((spanX * spanZ) / (spacing * spacing)));
  const px = new Float32Array(n);
  const pz = new Float32Array(n);
  const r0 = new Float32Array(n);
  const r1 = new Float32Array(n);
  const r2 = new Float32Array(n);
  const r3 = new Float32Array(n);

  const cellSz = Math.max(0.25, spacing);
  const gxN = Math.max(1, Math.ceil(spanX / cellSz));
  const gzN = Math.max(1, Math.ceil(spanZ / cellSz));
  const buckets: number[][] = Array.from({ length: gxN * gzN }, () => []);

  for (let i = 0; i < n; i++) {
    const lx = rng.uniform(0, spanX);
    const lz = rng.uniform(0, spanZ);
    px[i] = x0 + lx;
    pz[i] = z0 + lz;
    r0[i] = rng.uniform(-1, 1);
    r1[i] = rng.uniform(-1, 1);
    r2[i] = rng.uniform(-1, 1);
    r3[i] = rng.uniform(-1, 1);
    const bx = Math.min(gxN - 1, Math.max(0, Math.floor(lx / cellSz)));
    const bz = Math.min(gzN - 1, Math.max(0, Math.floor(lz / cellSz)));
    buckets[bz * gxN + bx].push(i);
  }

  return {
    sample(wx: number, wz: number) {
      const bx = Math.min(gxN - 1, Math.max(0, Math.floor((wx - x0) / cellSz)));
      const bz = Math.min(gzN - 1, Math.max(0, Math.floor((wz - z0) / cellSz)));
      let best = 0;
      let bestD2 = 1e30;
      for (let rad = 1; rad <= 3; rad++) {
        let found = false;
        const xMin = Math.max(0, bx - rad);
        const xMax = Math.min(gxN - 1, bx + rad);
        const zMin = Math.max(0, bz - rad);
        const zMax = Math.min(gzN - 1, bz + rad);
        for (let iz = zMin; iz <= zMax; iz++) {
          const row = iz * gxN;
          for (let ix = xMin; ix <= xMax; ix++) {
            const arr = buckets[row + ix];
            for (let j = 0; j < arr.length; j++) {
              const id = arr[j];
              const dx = wx - px[id];
              const dz = wz - pz[id];
              const d2 = dx * dx + dz * dz;
              if (d2 < bestD2) {
                bestD2 = d2;
                best = id;
                found = true;
              }
            }
          }
        }
        if (found) break;
      }
      if (bestD2 > 1e29) {
        for (let id = 0; id < n; id++) {
          const dx = wx - px[id];
          const dz = wz - pz[id];
          const d2 = dx * dx + dz * dz;
          if (d2 < bestD2) {
            bestD2 = d2;
            best = id;
          }
        }
      }
      const id = best;
      const dx = wx - px[id];
      const dz = wz - pz[id];
      const col = r0[id] * 0.75 + (r1[id] * dx + r2[id] * dz) * 1.1;
      const ledge1 = 0.55 + (r1[id] * 0.5 + 0.5) * 0.9;
      const ledge2 = ledge1 + 0.7 + (r2[id] * 0.5 + 0.5) * 0.9;
      return {
        id,
        col,
        facet: r3[id],
        ledge1,
        ledge2,
        evalAt(x: number, z: number) {
          return r0[id] * 0.75 + (r1[id] * (x - px[id]) + r2[id] * (z - pz[id])) * 1.1;
        },
      };
    },
  };
}

// =====================================================================================
// Island Mesh Builder: Rounded Top + Curved Grass Lip + Voronoi Prism Cliffs + Tapered Underside
// =====================================================================================

interface BuildIslandOpts {
  mask: Uint8Array;
  nx: number;
  ny: number;
  x0: number;
  z0: number;
  res: number;
  cx: number;
  cz: number;
  Wm: number;
  Hm: number;
  mg: number;
  pal: UpstreamPalLin;
  voro: VoronoiField;
  topMat: THREE.Material;
  cliffMat: THREE.Material;
  seed: number;
  cliffH: number;
  taperK: number;
  taperP: number;
  depthMax: number;
  roughAmp: number;
  colAmp: number;
  ledge: number;
  lipRound: number;
  undersideStride: number;
}

interface ContourSeg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  nax: number;
  naz: number;
  nbx: number;
  nbz: number;
  cid: number;
  colA: number;
  colB: number;
  facet: number;
  ledge1: number;
  ledge2: number;
  kA: string;
  kB: string;
}

function buildIslandGeometries(opts: BuildIslandOpts): {
  topMesh: THREE.Mesh | null;
  cliffMesh: THREE.Mesh | null;
  s2: Float32Array;
} {
  const {
    mask,
    nx,
    ny,
    x0,
    z0,
    res,
    cx,
    cz,
    Wm,
    Hm,
    mg,
    pal,
    voro,
    topMat,
    cliffMat,
    seed,
    cliffH,
    taperK,
    taperP,
    depthMax,
    roughAmp,
    colAmp,
    ledge,
    lipRound,
    undersideStride,
  } = opts;

  let anySolid = false;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) {
      anySolid = true;
      break;
    }
  }
  const s2 = anySolid ? signedDist2D(mask, nx, ny, res) : new Float32Array(nx * ny).fill(-1);
  if (!anySolid) return { topMesh: null, cliffMesh: null, s2 };

  const sampleS2 = (wx: number, wz: number): number => {
    const fx = (wx - x0) / res - 0.5;
    const fz = (wz - z0) / res - 0.5;
    const ix0 = Math.max(0, Math.min(nx - 2, Math.floor(fx)));
    const iz0 = Math.max(0, Math.min(ny - 2, Math.floor(fz)));
    const tx = Math.max(0, Math.min(1, fx - ix0));
    const tz = Math.max(0, Math.min(1, fz - iz0));
    const r0 = iz0 * nx;
    const r1 = r0 + nx;
    const a = s2[r0 + ix0] * (1 - tx) + s2[r0 + ix0 + 1] * tx;
    const b = s2[r1 + ix0] * (1 - tx) + s2[r1 + ix0 + 1] * tx;
    return a * (1 - tz) + b * tz;
  };

  // Smooth unit outward normal (-grad s2 / |grad s2|)
  const sampleOutNormal = (wx: number, wz: number): [number, number] => {
    const h = res * 0.75;
    const gx = (sampleS2(wx + h, wz) - sampleS2(wx - h, wz)) / (2 * h);
    const gz = (sampleS2(wx, wz + h) - sampleS2(wx, wz - h)) / (2 * h);
    const len = Math.hypot(gx, gz);
    if (len < 1e-5) return [0, 1];
    return [-gx / len, -gz / len];
  };

  const uvU = (wx: number) => (wx + mg) / (Wm + 2 * mg);
  const uvV = (wz: number) => 1.0 - (wz + mg) / (Hm + 2 * mg);

  const lipDrop = Math.min(0.055, lipRound * 0.72);
  const topYAt = (sVal: number): number => {
    if (sVal >= lipRound) return 0;
    const t = Math.max(0, Math.min(1, 1 - sVal / lipRound));
    return -lipDrop * t * t;
  };
  const topNormalAt = (wx: number, wz: number, sVal: number): Vec3 => {
    if (sVal >= lipRound) return [0, 1, 0];
    const t = Math.max(0, Math.min(1, 1 - sVal / lipRound));
    const [ox, oz] = sampleOutNormal(wx, wz);
    const slope = (2 * lipDrop * t) / Math.max(1e-4, lipRound);
    const inv = 1 / Math.hypot(slope, 1);
    return [ox * slope * inv, inv, oz * slope * inv];
  };

  const topPos: number[] = [];
  const topNrm: number[] = [];
  const topUv: number[] = [];

  const pushTopTri = (ax: number, az: number, sa: number, bx: number, bz: number, sb: number, dx: number, dz: number, sd: number) => {
    const na = topNormalAt(ax, az, sa);
    const nb = topNormalAt(bx, bz, sb);
    const nd = topNormalAt(dx, dz, sd);
    topPos.push(ax - cx, topYAt(sa), az - cz, bx - cx, topYAt(sb), bz - cz, dx - cx, topYAt(sd), dz - cz);
    topNrm.push(na[0], na[1], na[2], nb[0], nb[1], nb[2], nd[0], nd[1], nd[2]);
    topUv.push(uvU(ax), uvV(az), uvU(bx), uvV(bz), uvU(dx), uvV(dz));
  };

  const segs: ContourSeg[] = [];
  const ptKey = (x: number, z: number) => `${Math.round(x * 2000)},${Math.round(z * 2000)}`;

  const recordSeg = (ax: number, az: number, bx: number, bz: number) => {
    const segLen = Math.hypot(bx - ax, bz - az);
    if (segLen < 1e-4) return;
    const mx = (ax + bx) * 0.5;
    const mz = (az + bz) * 0.5;
    const v = voro.sample(mx, mz);
    const [nax, naz] = sampleOutNormal(ax, az);
    const [nbx, nbz] = sampleOutNormal(bx, bz);
    segs.push({
      ax,
      az,
      bx,
      bz,
      nax,
      naz,
      nbx,
      nbz,
      cid: v.id,
      colA: v.evalAt(ax, az),
      colB: v.evalAt(bx, bz),
      facet: v.facet,
      ledge1: v.ledge1,
      ledge2: v.ledge2,
      kA: ptKey(ax, az),
      kB: ptKey(bx, bz),
    });
  };

  // Exact zero-ambiguity triangle clipping of each cell's 4 sub-wedges against s2 >= 0
  const clipWedge = (
    xA: number, zA: number, vA: number,
    xB: number, zB: number, vB: number,
    xC: number, zC: number, vC: number,
  ) => {
    const iA = vA >= 0 ? 1 : 0;
    const iB = vB >= 0 ? 1 : 0;
    const iC = vC >= 0 ? 1 : 0;
    const sum = iA + iB + iC;
    if (sum === 0) return;
    if (sum === 3) {
      pushTopTri(xA, zA, vA, xB, zB, vB, xC, zC, vC);
      return;
    }
    // Rotate vertices cyclically so inside vertex/vertices come first
    let ax = xA, az = zA, va = vA;
    let bx = xB, bz = zB, vb = vB;
    let cx_ = xC, cz_ = zC, vc = vC;
    if (sum === 1) {
      if (iB) {
        ax = xB; az = zB; va = vB;
        bx = xC; bz = zC; vb = vC;
        cx_ = xA; cz_ = zA; vc = vA;
      } else if (iC) {
        ax = xC; az = zC; va = vC;
        bx = xA; bz = zA; vb = vA;
        cx_ = xB; cz_ = zB; vc = vB;
      }
      const tab = va / (va - vb);
      const tac = va / (va - vc);
      const pabX = ax + (bx - ax) * tab;
      const pabZ = az + (bz - az) * tab;
      const pacX = ax + (cx_ - ax) * tac;
      const pacZ = az + (cz_ - az) * tac;
      pushTopTri(ax, az, va, pabX, pabZ, 0, pacX, pacZ, 0);
      recordSeg(pabX, pabZ, pacX, pacZ);
    } else {
      // sum === 2: rotate so the single outside vertex is C
      if (!iA) {
        ax = xB; az = zB; va = vB;
        bx = xC; bz = zC; vb = vC;
        cx_ = xA; cz_ = zA; vc = vA;
      } else if (!iB) {
        ax = xC; az = zC; va = vC;
        bx = xA; bz = zA; vb = vA;
        cx_ = xB; cz_ = zB; vc = vB;
      }
      const tbc = vb / (vb - vc);
      const tac = va / (va - vc);
      const pbcX = bx + (cx_ - bx) * tbc;
      const pbcZ = bz + (cz_ - bz) * tbc;
      const pacX = ax + (cx_ - ax) * tac;
      const pacZ = az + (cz_ - az) * tac;
      pushTopTri(ax, az, va, bx, bz, vb, pbcX, pbcZ, 0);
      pushTopTri(ax, az, va, pbcX, pbcZ, 0, pacX, pacZ, 0);
      recordSeg(pbcX, pbcZ, pacX, pacZ);
    }
  };

  // Sweep grid cells: merge flat interior runs into wide strips, clip boundary cells smoothly
  for (let iy = 0; iy < ny - 1; iy++) {
    const row0 = iy * nx;
    const row1 = row0 + nx;
    const pz0 = z0 + (iy + 0.5) * res;
    const pz1 = pz0 + res;

    let runStart = -1;
    const flushFlatRun = (runEnd: number) => {
      if (runStart < 0) return;
      const rx0 = x0 + (runStart + 0.5) * res;
      const rx1 = x0 + (runEnd + 0.5) * res;
      topPos.push(
        rx0 - cx, 0, pz0 - cz,
        rx0 - cx, 0, pz1 - cz,
        rx1 - cx, 0, pz1 - cz,
        rx0 - cx, 0, pz0 - cz,
        rx1 - cx, 0, pz1 - cz,
        rx1 - cx, 0, pz0 - cz,
      );
      for (let k = 0; k < 6; k++) topNrm.push(0, 1, 0);
      topUv.push(
        uvU(rx0), uvV(pz0),
        uvU(rx0), uvV(pz1),
        uvU(rx1), uvV(pz1),
        uvU(rx0), uvV(pz0),
        uvU(rx1), uvV(pz1),
        uvU(rx1), uvV(pz0),
      );
      runStart = -1;
    };

    for (let ix = 0; ix < nx - 1; ix++) {
      const v0 = s2[row0 + ix];
      const v1 = s2[row0 + ix + 1];
      const v2 = s2[row1 + ix + 1];
      const v3 = s2[row1 + ix];
      if (v0 >= lipRound && v1 >= lipRound && v2 >= lipRound && v3 >= lipRound) {
        if (runStart < 0) runStart = ix;
        continue;
      }
      flushFlatRun(ix);
      if (v0 < 0 && v1 < 0 && v2 < 0 && v3 < 0) continue;

      const px0 = x0 + (ix + 0.5) * res;
      const px1 = px0 + res;
      if (v0 >= 0 && v1 >= 0 && v2 >= 0 && v3 >= 0) {
        pushTopTri(px0, pz0, v0, px0, pz1, v3, px1, pz1, v2);
        pushTopTri(px0, pz0, v0, px1, pz1, v2, px1, pz0, v1);
        continue;
      }
      const xm = (px0 + px1) * 0.5;
      const zm = (pz0 + pz1) * 0.5;
      const vm = 0.25 * (v0 + v1 + v2 + v3);
      // 4 sub-wedges around cell center (CCW from +Y = upward normal)
      clipWedge(xm, zm, vm, px1, pz0, v1, px0, pz0, v0);
      clipWedge(xm, zm, vm, px1, pz1, v2, px1, pz0, v1);
      clipWedge(xm, zm, vm, px0, pz1, v3, px1, pz1, v2);
      clipWedge(xm, zm, vm, px0, pz0, v0, px0, pz1, v3);
    }
    flushFlatRun(nx - 1);
  }

  // ---- Build Voronoi Prism Cliffs + Smooth Lip + Vertical Column Ridges + Ledges ----
  const cliffPos: number[] = [];
  const cliffNrm: number[] = [];
  const cliffCol: number[] = [];

  const pushFlatQuad = (p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, facet: number) => {
    const e1x = p1[0] - p0[0], e1y = p1[1] - p0[1], e1z = p1[2] - p0[2];
    const e2x = p2[0] - p0[0], e2y = p2[1] - p0[1], e2z = p2[2] - p0[2];
    let nX = e1y * e2z - e1z * e2y;
    let nY = e1z * e2x - e1x * e2z;
    let nZ = e1x * e2y - e1y * e2x;
    const nl = Math.hypot(nX, nY, nZ) || 1;
    nX /= nl;
    nY /= nl;
    nZ /= nl;

    const c0 = evalCliffColor(-p0[1], nY, facet, pal);
    const c1 = evalCliffColor(-p1[1], nY, facet, pal);
    const c2 = evalCliffColor(-p2[1], nY, facet, pal);
    const c3 = evalCliffColor(-p3[1], nY, facet, pal);

    cliffPos.push(
      p0[0] - cx, p0[1], p0[2] - cz,
      p1[0] - cx, p1[1], p1[2] - cz,
      p2[0] - cx, p2[1], p2[2] - cz,
      p0[0] - cx, p0[1], p0[2] - cz,
      p2[0] - cx, p2[1], p2[2] - cz,
      p3[0] - cx, p3[1], p3[2] - cz,
    );
    for (let k = 0; k < 6; k++) cliffNrm.push(nX, nY, nZ);
    cliffCol.push(
      c0[0], c0[1], c0[2],
      c1[0], c1[1], c1[2],
      c2[0], c2[1], c2[2],
      c0[0], c0[1], c0[2],
      c2[0], c2[1], c2[2],
      c3[0], c3[1], c3[2],
    );
  };

  // Profile evaluator for a Voronoi column at depth u (terrain.py:118-131 + sunlit rock ledges)
  // Clamped cleanly below corner_r (~0.22m) so tight convex corners and tiny islets never fold over!
  const maxSafeInset = cliffH > 1.0 ? 0.20 : 0.11;
  const evalColumnInset = (u: number, colVal: number, l1: number, l2: number): number => {
    if (u <= lipDrop + 0.001) return 0;
    if (u <= 0.15) {
      // Gentle outward belly of the rounded grass lip (smax lip_round)
      const f = (u - lipDrop) / Math.max(1e-4, 0.15 - lipDrop);
      return -0.015 * Math.sin(f * Math.PI);
    }
    const w = Math.min(1, (u - 0.15) / 0.22);
    // Gentle progressive inward taper down the cliff + per-column Voronoi plane offset
    let ins = 0.025 + (u - 0.15) * 0.065 + colVal * colAmp * w;
    // Refined outward-stepping rock terraces at ledge1/ledge2 catch warm `PAL.ledge_hi` glints
    if (u >= l1) ins -= ledge * 0.55;
    if (u >= l2) ins -= ledge * 0.45;
    // Short tuck at the very foot so the cliff cleanly meets the inverted-mountain underbelly
    if (u > cliffH) {
      ins += (u - cliffH) * 0.28;
    }
    return Math.max(-0.04, Math.min(maxSafeInset, ins));
  };

  // Build per-segment depth rings (including exact per-column ledge1/ledge2 steps + clean base seal!)
  const skirtDrop = cliffH > 1.0 ? 0.22 : 0.14;
  const cliffFootU = cliffH + skirtDrop;
  const startMap = new Map<string, ContourSeg>();
  for (const s of segs) startMap.set(s.kA, s);

  for (const s of segs) {
    const l1 = Math.max(0.35, Math.min(cliffH - 0.22, s.ledge1));
    const hasL2 = s.ledge2 < cliffH - 0.18 && s.ledge2 > l1 + 0.28;
    const l2 = hasL2 ? s.ledge2 : cliffH + 10;

    // Ordered depth profile rings from grass lip down through Voronoi ledges to cliff foot
    const us: number[] = [lipDrop, 0.095, 0.15, 0.28];
    if (l1 > 0.35 && l1 < cliffH - 0.15) {
      us.push(l1 - 0.025, l1 + 0.04);
    }
    if (hasL2) {
      us.push(l2 - 0.025, l2 + 0.04);
    }
    us.push(cliffH, cliffFootU);

    for (let k = 0; k < us.length - 1; k++) {
      const u0 = us[k];
      const u1 = us[k + 1];
      const inA0 = evalColumnInset(u0, s.colA, l1, l2);
      const inB0 = evalColumnInset(u0, s.colB, l1, l2);
      const inA1 = evalColumnInset(u1, s.colA, l1, l2);
      const inB1 = evalColumnInset(u1, s.colB, l1, l2);

      // Quad (A0 -> A1 -> B1 -> B0) faces OUTWARD along (-dz, 0, +dx)
      const p0: Vec3 = [s.ax - s.nax * inA0, -u0, s.az - s.naz * inA0];
      const p1: Vec3 = [s.ax - s.nax * inA1, -u1, s.az - s.naz * inA1];
      const p2: Vec3 = [s.bx - s.nbx * inB1, -u1, s.bz - s.nbz * inB1];
      const p3: Vec3 = [s.bx - s.nbx * inB0, -u0, s.bz - s.nbz * inB0];
      pushFlatQuad(p0, p1, p2, p3, s.facet);
    }

    // Crisp vertical prism ridge cap where adjacent segments belong to different Voronoi columns!
    const next = startMap.get(s.kB);
    if (next && next.cid !== s.cid) {
      const nl1 = Math.max(0.35, Math.min(cliffH - 0.22, next.ledge1));
      const nl2 = next.ledge2 < cliffH - 0.18 && next.ledge2 > nl1 + 0.28 ? next.ledge2 : cliffH + 10;
      const capUs = [0.15, 0.35, 0.75, 1.15, 1.55, cliffH, cliffFootU].filter((u) => u <= cliffFootU + 1e-4);
      const tx = s.bx - s.ax;
      const tz = s.bz - s.az;
      for (let k = 0; k < capUs.length - 1; k++) {
        const u0 = capUs[k];
        const u1 = capUs[k + 1];
        const d10 = evalColumnInset(u0, s.colB, l1, l2);
        const d20 = evalColumnInset(u0, next.colA, nl1, nl2);
        const d11 = evalColumnInset(u1, s.colB, l1, l2);
        const d21 = evalColumnInset(u1, next.colA, nl1, nl2);
        if (Math.abs(d20 - d10) < 0.002 && Math.abs(d21 - d11) < 0.002) continue;

        const a0: Vec3 = [s.bx - s.nbx * d10, -u0, s.bz - s.nbz * d10];
        const a1: Vec3 = [s.bx - s.nbx * d11, -u1, s.bz - s.nbz * d11];
        const b1: Vec3 = [s.bx - s.nbx * d21, -u1, s.bz - s.nbz * d21];
        const b0: Vec3 = [s.bx - s.nbx * d20, -u0, s.bz - s.nbz * d20];
        // Ensure ridge cap normal faces outward (toward the more recessed column)
        const e1x = a1[0] - a0[0], e1y = a1[1] - a0[1], e1z = a1[2] - a0[2];
        const e2x = b1[0] - a0[0], e2y = b1[1] - a0[1], e2z = b1[2] - a0[2];
        const nx_ = e1y * e2z - e1z * e2y;
        const nz_ = e1x * e2y - e1y * e2x;
        const avgDiff = (d20 - d10) + (d21 - d11);
        const wantSign = avgDiff >= 0 ? 1 : -1;
        if ((nx_ * tx + nz_ * tz) * wantSign >= 0) {
          pushFlatQuad(a0, a1, b1, b0, (s.facet + next.facet) * 0.5);
        } else {
          pushFlatQuad(b0, b1, a1, a0, (s.facet + next.facet) * 0.5);
        }
      }
    }
  }

  // ---- Build Tapered Inverted-Mountain Underside (exact closed-form solution of terrain.py:119!) ----
  const underNoise = coarseNoise2D(nx, ny, Math.max(2, Math.round(0.9 / res)), seed + 37);
  const underOffset = cliffH > 1.0 ? 0.10 : 0.05; // Sits snugly inside cliff base so skirt & underside seal 100% watertight
  const invTaperP = 1 / taperP;

  const evalUnderY = (ix: number, iy: number, sVal: number): number => {
    const excess = Math.max(0, sVal - underOffset);
    const taperDepth = Math.pow(excess / taperK, invTaperP);
    const roughBlend = Math.min(1, taperDepth / 2.0);
    const n = underNoise[iy * nx + ix];
    const u = Math.min(depthMax, cliffH - 0.02 + taperDepth + n * roughAmp * roughBlend * 1.35);
    return -u;
  };

  const pushUnderTri = (p0: Vec3, p1: Vec3, p2: Vec3, facet: number) => {
    const e1x = p1[0] - p0[0], e1y = p1[1] - p0[1], e1z = p1[2] - p0[2];
    const e2x = p2[0] - p0[0], e2y = p2[1] - p0[1], e2z = p2[2] - p0[2];
    let nX = e1y * e2z - e1z * e2y;
    let nY = e1z * e2x - e1x * e2z;
    let nZ = e1x * e2y - e1y * e2x;
    const nl = Math.hypot(nX, nY, nZ) || 1;
    nX /= nl;
    nY /= nl;
    nZ /= nl;

    const c0 = evalCliffColor(-p0[1], nY, facet, pal);
    const c1 = evalCliffColor(-p1[1], nY, facet, pal);
    const c2 = evalCliffColor(-p2[1], nY, facet, pal);
    cliffPos.push(
      p0[0] - cx, p0[1], p0[2] - cz,
      p1[0] - cx, p1[1], p1[2] - cz,
      p2[0] - cx, p2[1], p2[2] - cz,
    );
    for (let k = 0; k < 3; k++) cliffNrm.push(nX, nY, nZ);
    cliffCol.push(c0[0], c0[1], c0[2], c1[0], c1[1], c1[2], c2[0], c2[1], c2[2]);
  };

  const st = Math.max(1, undersideStride);
  for (let iy = 0; iy < ny - 1; iy += st) {
    const iy1 = Math.min(ny - 1, iy + st);
    const pz0 = z0 + (iy + 0.5) * res;
    const pz1 = z0 + (iy1 + 0.5) * res;
    for (let ix = 0; ix < nx - 1; ix += st) {
      const ix1 = Math.min(nx - 1, ix + st);
      const s00 = s2[iy * nx + ix];
      const s10 = s2[iy * nx + ix1];
      const s11 = s2[iy1 * nx + ix1];
      const s01 = s2[iy1 * nx + ix];
      if (s00 < underOffset && s10 < underOffset && s11 < underOffset && s01 < underOffset) continue;

      const px0 = x0 + (ix + 0.5) * res;
      const px1 = x0 + (ix1 + 0.5) * res;
      const y00 = evalUnderY(ix, iy, s00);
      const y10 = evalUnderY(ix1, iy, s10);
      const y11 = evalUnderY(ix1, iy1, s11);
      const y01 = evalUnderY(ix, iy1, s01);
      const f = underNoise[iy * nx + ix] * 0.6;

      // Reversed winding relative to top mesh -> normal points downward/outward (-Y)!
      if (s00 >= underOffset && s10 >= underOffset && s11 >= underOffset && s01 >= underOffset) {
        pushUnderTri([px0, y00, pz0], [px1, y11, pz1], [px0, y01, pz1], f);
        pushUnderTri([px0, y00, pz0], [px1, y10, pz0], [px1, y11, pz1], f);
      } else {
        // Clip partial underside boundary cells cleanly along s2 = underOffset
        const clipUnder = (
          aX: number, aZ: number, aY: number, aS: number,
          bX: number, bZ: number, bY: number, bS: number,
          cX: number, cZ: number, cY: number, cS: number,
        ) => {
          const dA = aS - underOffset;
          const dB = bS - underOffset;
          const dC = cS - underOffset;
          const iA = dA >= 0 ? 1 : 0;
          const iB = dB >= 0 ? 1 : 0;
          const iC = dC >= 0 ? 1 : 0;
          const sum = iA + iB + iC;
          if (sum === 0) return;
          if (sum === 3) {
            pushUnderTri([aX, aY, aZ], [bX, bY, bZ], [cX, cY, cZ], f);
            return;
          }
          let p0x = aX, p0z = aZ, p0y = aY, v0 = dA;
          let p1x = bX, p1z = bZ, p1y = bY, v1 = dB;
          let p2x = cX, p2z = cZ, p2y = cY, v2 = dC;
          if (sum === 1) {
            if (iB) {
              p0x = bX; p0z = bZ; p0y = bY; v0 = dB;
              p1x = cX; p1z = cZ; p1y = cY; v1 = dC;
              p2x = aX; p2z = aZ; p2y = aY; v2 = dA;
            } else if (iC) {
              p0x = cX; p0z = cZ; p0y = cY; v0 = dC;
              p1x = aX; p1z = aZ; p1y = aY; v1 = dA;
              p2x = bX; p2z = bZ; p2y = bY; v2 = dB;
            }
            const t1 = v0 / (v0 - v1);
            const t2 = v0 / (v0 - v2);
            pushUnderTri(
              [p0x, p0y, p0z],
              [p0x + (p1x - p0x) * t1, -(cliffH - 0.02), p0z + (p1z - p0z) * t1],
              [p0x + (p2x - p0x) * t2, -(cliffH - 0.02), p0z + (p2z - p0z) * t2],
              f,
            );
          } else {
            if (!iA) {
              p0x = bX; p0z = bZ; p0y = bY; v0 = dB;
              p1x = cX; p1z = cZ; p1y = cY; v1 = dC;
              p2x = aX; p2z = aZ; p2y = aY; v2 = dA;
            } else if (!iB) {
              p0x = cX; p0z = cZ; p0y = cY; v0 = dC;
              p1x = aX; p1z = aZ; p1y = aY; v1 = dA;
              p2x = bX; p2z = bZ; p2y = bY; v2 = dB;
            }
            const t1 = v1 / (v1 - v2);
            const t2 = v0 / (v0 - v2);
            const q1: Vec3 = [p1x + (p2x - p1x) * t1, -(cliffH - 0.02), p1z + (p2z - p1z) * t1];
            const q2: Vec3 = [p0x + (p2x - p0x) * t2, -(cliffH - 0.02), p0z + (p2z - p0z) * t2];
            pushUnderTri([p0x, p0y, p0z], [p1x, p1y, p1z], q1, f);
            pushUnderTri([p0x, p0y, p0z], q1, q2, f);
          }
        };
        clipUnder(px0, pz0, y00, s00, px1, pz1, y11, s11, px0, pz1, y01, s01);
        clipUnder(px0, pz0, y00, s00, px1, pz0, y10, s10, px1, pz1, y11, s11);
      }
    }
  }

  let topMesh: THREE.Mesh | null = null;
  let cliffMesh: THREE.Mesh | null = null;
  if (topPos.length > 0) {
    const topGeo = new THREE.BufferGeometry();
    topGeo.setAttribute('position', new THREE.Float32BufferAttribute(topPos, 3));
    topGeo.setAttribute('normal', new THREE.Float32BufferAttribute(topNrm, 3));
    topGeo.setAttribute('uv', new THREE.Float32BufferAttribute(topUv, 2));
    topGeo.computeBoundingSphere();
    topMesh = new THREE.Mesh(topGeo, topMat);
    topMesh.receiveShadow = true;
  }
  if (cliffPos.length > 0) {
    const cliffGeo = new THREE.BufferGeometry();
    cliffGeo.setAttribute('position', new THREE.Float32BufferAttribute(cliffPos, 3));
    cliffGeo.setAttribute('normal', new THREE.Float32BufferAttribute(cliffNrm, 3));
    cliffGeo.setAttribute('color', new THREE.Float32BufferAttribute(cliffCol, 3));
    cliffGeo.computeBoundingSphere();
    cliffMesh = new THREE.Mesh(cliffGeo, cliffMat);
    cliffMesh.castShadow = false;
    cliffMesh.receiveShadow = false;
  }
  return { topMesh, cliffMesh, s2 };
}

// =====================================================================================
// Irregular Voronoi Collapse Fracturing (exact port of terrain.py:fracture)
// =====================================================================================

function labelConnectedComponents(mask: Uint8Array, nx: number, ny: number): { comp: Int32Array; count: number } {
  const N = nx * ny;
  const comp = new Int32Array(N);
  const queue = new Int32Array(N);
  let count = 0;
  for (let i = 0; i < N; i++) {
    if (!mask[i] || comp[i]) continue;
    count++;
    let head = 0;
    let tail = 0;
    comp[i] = count;
    queue[tail++] = i;
    while (head < tail) {
      const cur = queue[head++];
      const x = cur % nx;
      const y = (cur - x) / nx;
      if (x > 0 && mask[cur - 1] && !comp[cur - 1]) { comp[cur - 1] = count; queue[tail++] = cur - 1; }
      if (x + 1 < nx && mask[cur + 1] && !comp[cur + 1]) { comp[cur + 1] = count; queue[tail++] = cur + 1; }
      if (y > 0 && mask[cur - nx] && !comp[cur - nx]) { comp[cur - nx] = count; queue[tail++] = cur - nx; }
      if (y + 1 < ny && mask[cur + nx] && !comp[cur + nx]) { comp[cur + nx] = count; queue[tail++] = cur + nx; }
    }
  }
  return { comp, count };
}

function fractureRegion(
  region: Uint8Array,
  nx: number,
  ny: number,
  res: number,
  seed: number,
  pieceArea = 1.7,
  warp = 0.14,
): { lab: Int32Array; count: number } {
  const N = nx * ny;
  const rng = new LocalRng(seed);
  const lab = new Int32Array(N).fill(-1);
  const { comp, count: nc } = labelConnectedComponents(region, nx, ny);
  if (nc === 0) return { lab, count: 0 };

  const cellPx = Math.max(2, Math.round(0.45 / res));
  const n1 = coarseNoise2D(nx, ny, cellPx, seed + 1);
  const n2 = coarseNoise2D(nx, ny, cellPx, seed + 2);
  for (let i = 0; i < N; i++) {
    n1[i] *= warp;
    n2[i] *= warp;
  }

  const pixArea = res * res;
  const subMask = new Uint8Array(N);
  let pieceCount = 0;

  // Group pixel indices by connected component
  const compPixels: number[][] = Array.from({ length: nc + 1 }, () => []);
  for (let i = 0; i < N; i++) {
    if (comp[i] > 0) compPixels[comp[i]].push(i);
  }

  for (let c = 1; c <= nc; c++) {
    const pixels = compPixels[c];
    const area = pixels.length * pixArea;
    if (area < 0.02) continue;
    const nSeeds = Math.max(1, Math.min(pixels.length, Math.round(area / pieceArea)));
    // Fisher-Yates partial shuffle for unique random seeds inside the component
    const seedX = new Float32Array(nSeeds);
    const seedY = new Float32Array(nSeeds);
    const picked = new Set<number>();
    for (let s = 0; s < nSeeds; s++) {
      let pIdx = pixels[rng.int(0, pixels.length)];
      let guard = 0;
      while (picked.has(pIdx) && guard++ < 20) {
        pIdx = pixels[rng.int(0, pixels.length)];
      }
      picked.add(pIdx);
      const sx = pIdx % nx;
      const sy = (pIdx - sx) / nx;
      seedX[s] = sx * res;
      seedY[s] = sy * res;
    }

    // Assign each pixel to nearest seed from warped coordinates
    const seedBins: number[][] = Array.from({ length: nSeeds }, () => []);
    for (let p = 0; p < pixels.length; p++) {
      const idx = pixels[p];
      const x = idx % nx;
      const y = (idx - x) / nx;
      const qx = x * res + n1[idx];
      const qy = y * res + n2[idx];
      let best = 0;
      let bestD2 = 1e30;
      for (let s = 0; s < nSeeds; s++) {
        const dx = qx - seedX[s];
        const dy = qy - seedY[s];
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = s;
        }
      }
      seedBins[best].push(idx);
    }

    // Split disconnected sub-pieces within each seed bin and drop tiny slivers (< 0.04 m^2)
    for (let s = 0; s < nSeeds; s++) {
      const bin = seedBins[s];
      if (bin.length * pixArea < 0.04) continue;
      for (let p = 0; p < bin.length; p++) subMask[bin[p]] = 1;
      // Local BFS over bin pixels
      const visited = new Uint8Array(bin.length);
      const idxToBin = new Map<number, number>();
      for (let p = 0; p < bin.length; p++) idxToBin.set(bin[p], p);
      const q: number[] = [];
      for (let p = 0; p < bin.length; p++) {
        if (visited[p]) continue;
        visited[p] = 1;
        q.length = 0;
        q.push(bin[p]);
        let head = 0;
        while (head < q.length) {
          const cur = q[head++];
          const cx = cur % nx;
          const cy = (cur - cx) / nx;
          const nbrs = [
            cx > 0 ? cur - 1 : -1,
            cx + 1 < nx ? cur + 1 : -1,
            cy > 0 ? cur - nx : -1,
            cy + 1 < ny ? cur + nx : -1,
          ];
          for (const nb of nbrs) {
            if (nb < 0 || !subMask[nb]) continue;
            const bp = idxToBin.get(nb);
            if (bp !== undefined && !visited[bp]) {
              visited[bp] = 1;
              q.push(nb);
            }
          }
        }
        if (q.length * pixArea >= 0.04) {
          for (let j = 0; j < q.length; j++) lab[q[j]] = pieceCount;
          pieceCount++;
        }
      }
      for (let p = 0; p < bin.length; p++) subMask[bin[p]] = 0;
    }
  }

  // Merge any orphaned pixels in `region` into nearest labeled piece via multi-source BFS
  if (pieceCount > 0) {
    const queue = new Int32Array(N);
    let head = 0;
    let tail = 0;
    let hasOrphan = false;
    for (let i = 0; i < N; i++) {
      if (lab[i] >= 0) queue[tail++] = i;
      else if (region[i]) hasOrphan = true;
    }
    if (hasOrphan) {
      while (head < tail) {
        const cur = queue[head++];
        const id = lab[cur];
        const x = cur % nx;
        const y = (cur - x) / nx;
        const nbrs = [
          x > 0 ? cur - 1 : -1,
          x + 1 < nx ? cur + 1 : -1,
          y > 0 ? cur - nx : -1,
          y + 1 < ny ? cur + nx : -1,
        ];
        for (const nb of nbrs) {
          if (nb >= 0 && region[nb] && lab[nb] < 0) {
            lab[nb] = id;
            queue[tail++] = nb;
          }
        }
      }
    }
  }

  return { lab, count: pieceCount };
}

// =====================================================================================
// Public Entry Point for HqArenaMap3D (Edge Beautify Mode)
// =====================================================================================

export interface UpstreamFracturePiece {
  wave: number;
  cx: number;
  cz: number;
  dIn: number;
  topMesh: THREE.Mesh | null;
  cliffMesh: THREE.Mesh | null;
}

export interface UpstreamTerrainResult {
  /** Intact rounded island states: stateTerrains[k] = island after waves 0..k-1 have collapsed. */
  stateTerrains: THREE.Group[];
  /** Irregular Voronoi collapse chunks for waves 0..R-1. */
  pieces: UpstreamFracturePiece[];
  /** Maps grid cell (gy * map.nx + gx) -> piece index in `pieces` (-1 for permanent core or pit). */
  cellPieceIndex: Int32Array;
  /** Signed distance field of state0 (positive inside smooth rounded island, 0 on rim). */
  sampleState0S2: (wx: number, wz: number) => number;
  /** Smooth outward unit normal on state0 rim. */
  sampleState0OutNormal: (wx: number, wz: number) => [number, number];
}

export function buildUpstreamTerrain(
  mapData: EngineMapData,
  pal: HqPalette,
  mg: number,
  seed: number,
  sharedTopMat: THREE.Material,
  sharedCliffMat: THREE.Material,
): UpstreamTerrainResult {
  const { nx: mapNx, ny: mapNy, cells, waves, cell, nwave } = mapData;
  const cs = cell / 1000;
  const Wm = mapNx * cs;
  const Hm = mapNy * cs;
  const R = Math.max(0, nwave);

  // Adaptive resolution: crisp 0.085m on standard maps, up to 0.125m on huge 64x32 training maps
  const maxSpan = Math.max(Wm, Hm);
  const res = Math.max(0.085, Math.min(0.125, maxSpan / 225));
  const margin = Math.max(0.65, cs + 0.25);
  const x0 = -margin;
  const z0 = -margin;
  const gNx = Math.round((Wm + 2 * margin) / res);
  const gNy = Math.round((Hm + 2 * margin) / res);
  const gN = gNx * gNy;

  // Upstream `prep.py:35`: corner_r = min(0.36, 0.44 * cell)
  const cornerR = Math.min(0.36, 0.44 * cs);
  const palLin = makePalLin(pal);
  const mainVoro = createVoronoiField(x0, z0, gNx * res, gNy * res, 0.62, seed);

  // 1. Rasterize & round nested solid masks[0..R] (exact port of prep.py:125-132)
  const masks: Uint8Array[] = [];
  for (let k = 0; k <= R; k++) {
    const raw = new Uint8Array(gN);
    for (let iy = 0; iy < gNy; iy++) {
      const wy = z0 + (iy + 0.5) * res;
      const cy = Math.floor(wy / cs);
      if (cy < 0 || cy >= mapNy) continue;
      const row = iy * gNx;
      const mapRow = cy * mapNx;
      for (let ix = 0; ix < gNx; ix++) {
        const wx = x0 + (ix + 0.5) * res;
        const cx = Math.floor(wx / cs);
        if (cx < 0 || cx >= mapNx) continue;
        const idx = mapRow + cx;
        if (cells[idx] === CellType.PIT) continue;
        const w = waves[idx];
        if (w >= 0 && w < k) continue;
        raw[row + ix] = 1;
      }
    }
    const m2 = roundMask(raw, gNx, gNy, cornerR, res, seed, 0.03);
    if (k > 0) {
      const prev = masks[k - 1];
      for (let i = 0; i < gN; i++) m2[i] &= prev[i];
    }
    masks.push(m2);
  }

  // 2. Build intact rounded island meshes state[0..R]
  const stateTerrains: THREE.Group[] = [];
  let state0S2: Float32Array = new Float32Array(gN).fill(-1);
  const undersideStride = maxSpan > 22 ? 4 : 3;

  for (let k = 0; k <= R; k++) {
    const built = buildIslandGeometries({
      mask: masks[k],
      nx: gNx,
      ny: gNy,
      x0,
      z0,
      res,
      cx: 0,
      cz: 0,
      Wm,
      Hm,
      mg,
      pal: palLin,
      voro: mainVoro,
      topMat: sharedTopMat,
      cliffMat: sharedCliffMat,
      seed,
      cliffH: 1.9,
      taperK: 0.26,
      taperP: 1.35,
      depthMax: 9.0,
      roughAmp: 0.22,
      colAmp: 0.11,
      ledge: 0.06,
      lipRound: 0.07,
      undersideStride,
    });
    if (k === 0) state0S2 = built.s2;
    const grp = new THREE.Group();
    if (built.topMesh) grp.add(built.topMesh);
    if (built.cliffMesh) grp.add(built.cliffMesh);
    grp.visible = k === 0;
    stateTerrains.push(grp);
  }

  // 3. Fracture each collapsing wave region = masks[w] & ~masks[w + 1] into irregular rock chunks (prep.py:139-158)
  const pieces: UpstreamFracturePiece[] = [];
  const cellPieceIndex = new Int32Array(mapNx * mapNy).fill(-1);
  const pad = Math.max(3, Math.round(0.38 / res));

  for (let w = 0; w < R; w++) {
    const mCurr = masks[w];
    const mNext = masks[w + 1];
    const region = new Uint8Array(gN);
    let any = false;
    for (let i = 0; i < gN; i++) {
      if (mCurr[i] && !mNext[i]) {
        region[i] = 1;
        any = true;
      }
    }
    if (!any) continue;

    const { lab, count } = fractureRegion(region, gNx, gNy, res, seed + 100 + w, 1.7, 0.14);
    if (count === 0) continue;

    // Distance to remaining intact land masks[w + 1] (prep.py:144)
    let anyNext = false;
    for (let i = 0; i < gN; i++) {
      if (mNext[i]) {
        anyNext = true;
        break;
      }
    }
    const dInMap = anyNext ? edt2d(mNext, gNx, gNy, 1) : null;

    // Gather pixel bboxes & centroids per piece
    const pMinX = new Int32Array(count).fill(gNx);
    const pMaxX = new Int32Array(count).fill(-1);
    const pMinY = new Int32Array(count).fill(gNy);
    const pMaxY = new Int32Array(count).fill(-1);
    const pSumX = new Float64Array(count);
    const pSumY = new Float64Array(count);
    const pCnt = new Int32Array(count);

    for (let iy = 0; iy < gNy; iy++) {
      const row = iy * gNx;
      for (let ix = 0; ix < gNx; ix++) {
        const id = lab[row + ix];
        if (id < 0) continue;
        if (ix < pMinX[id]) pMinX[id] = ix;
        if (ix > pMaxX[id]) pMaxX[id] = ix;
        if (iy < pMinY[id]) pMinY[id] = iy;
        if (iy > pMaxY[id]) pMaxY[id] = iy;
        pSumX[id] += ix;
        pSumY[id] += iy;
        pCnt[id]++;
      }
    }

    const waveBasePiece = pieces.length;
    const localToGlobal = new Int32Array(count).fill(-1);

    for (let j = 0; j < count; j++) {
      if (pCnt[j] === 0) continue;
      const pid = pieces.length;
      localToGlobal[j] = pid;

      const xA = Math.max(0, pMinX[j] - pad);
      const xB = Math.min(gNx - 1, pMaxX[j] + pad);
      const yA = Math.max(0, pMinY[j] - pad);
      const yB = Math.min(gNy - 1, pMaxY[j] + pad);
      const cNx = xB - xA + 1;
      const cNy = yB - yA + 1;
      const crop = new Uint8Array(cNx * cNy);
      for (let iy = yA; iy <= yB; iy++) {
        const sRow = iy * gNx;
        const dRow = (iy - yA) * cNx;
        for (let ix = xA; ix <= xB; ix++) {
          if (lab[sRow + ix] === j) crop[dRow + (ix - xA)] = 1;
        }
      }

      const mxPx = pSumX[j] / pCnt[j];
      const myPx = pSumY[j] / pCnt[j];
      const pcx = x0 + (mxPx + 0.5) * res;
      const pcz = z0 + (myPx + 0.5) * res;
      const dIn = dInMap
        ? dInMap[Math.min(gNy - 1, Math.max(0, Math.round(myPx))) * gNx + Math.min(gNx - 1, Math.max(0, Math.round(mxPx)))] * res
        : 3.0;

      const cropX0 = x0 + xA * res;
      const cropZ0 = z0 + yA * res;
      const smoothCrop = roundMask(crop, cNx, cNy, 0.035, res, seed + 500 + pid, 0);
      const pieceVoro = createVoronoiField(cropX0, cropZ0, cNx * res, cNy * res, 0.4, seed + 500 + pid);

      // Upstream prep.py:50-52 exact fracture chunk parameters!
      const built = buildIslandGeometries({
        mask: smoothCrop,
        nx: cNx,
        ny: cNy,
        x0: cropX0,
        z0: cropZ0,
        res,
        cx: pcx,
        cz: pcz,
        Wm,
        Hm,
        mg,
        pal: palLin,
        voro: pieceVoro,
        topMat: sharedTopMat,
        cliffMat: sharedCliffMat,
        seed: seed + 500 + pid,
        cliffH: 0.55,
        taperK: 0.95,
        taperP: 1.1,
        depthMax: 1.9,
        roughAmp: 0.3,
        colAmp: 0.05,
        ledge: 0.03,
        lipRound: 0.055,
        undersideStride: 2,
      });

      pieces.push({
        wave: w,
        cx: pcx,
        cz: pcz,
        dIn,
        topMesh: built.topMesh,
        cliffMesh: built.cliffMesh,
      });
    }

    // Map every wave-w grid cell to the irregular piece underneath it (so obstacles & tall grass ride it!)
    for (let gy = 0; gy < mapNy; gy++) {
      for (let gx = 0; gx < mapNx; gx++) {
        const idx = gy * mapNx + gx;
        if (cells[idx] === CellType.PIT || waves[idx] !== w) continue;
        const wx = (gx + 0.5) * cs;
        const wz = (gy + 0.5) * cs;
        const ix = Math.min(gNx - 1, Math.max(0, Math.floor((wx - x0) / res)));
        const iy = Math.min(gNy - 1, Math.max(0, Math.floor((wz - z0) / res)));
        const lid = lab[iy * gNx + ix];
        if (lid >= 0 && localToGlobal[lid] >= 0) {
          cellPieceIndex[idx] = localToGlobal[lid];
        } else {
          // Rounded-off corner cell fallback: assign to nearest piece in this wave
          let bestPid = waveBasePiece;
          let bestD2 = 1e30;
          for (let pid = waveBasePiece; pid < pieces.length; pid++) {
            const dx = wx - pieces[pid].cx;
            const dz = wz - pieces[pid].cz;
            const d2 = dx * dx + dz * dz;
            if (d2 < bestD2) {
              bestD2 = d2;
              bestPid = pid;
            }
          }
          if (bestPid < pieces.length) cellPieceIndex[idx] = bestPid;
        }
      }
    }
  }

  const sampleState0S2 = (wx: number, wz: number): number => {
    const fx = (wx - x0) / res - 0.5;
    const fz = (wz - z0) / res - 0.5;
    const ix0 = Math.max(0, Math.min(gNx - 2, Math.floor(fx)));
    const iz0 = Math.max(0, Math.min(gNy - 2, Math.floor(fz)));
    const tx = Math.max(0, Math.min(1, fx - ix0));
    const tz = Math.max(0, Math.min(1, fz - iz0));
    const r0 = iz0 * gNx;
    const r1 = r0 + gNx;
    const a = state0S2[r0 + ix0] * (1 - tx) + state0S2[r0 + ix0 + 1] * tx;
    const b = state0S2[r1 + ix0] * (1 - tx) + state0S2[r1 + ix0 + 1] * tx;
    return a * (1 - tz) + b * tz;
  };

  const sampleState0OutNormal = (wx: number, wz: number): [number, number] => {
    const h = res * 0.75;
    const gx = (sampleState0S2(wx + h, wz) - sampleState0S2(wx - h, wz)) / (2 * h);
    const gz = (sampleState0S2(wx, wz + h) - sampleState0S2(wx, wz - h)) / (2 * h);
    const len = Math.hypot(gx, gz);
    if (len < 1e-5) return [0, 1];
    return [-gx / len, -gz / len];
  };

  return {
    stateTerrains,
    pieces,
    cellPieceIndex,
    sampleState0S2,
    sampleState0OutNormal,
  };
}
