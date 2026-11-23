import { hexLin, HqMeshBuilder, lerpLin, LinRGB, scaleLin, SeededRng, Vec3 } from './hqGeomBuilder';
import { HqPalette } from './hqThemes';

export interface DecorIslandSpec {
  name: string;
  rx: number;
  ry: number;
  seed: number;
  cliffH: number;
  depth: number;
  taperK: number;
  lobes: number;
}

/**
 * Exact outer floating island templates ported from `prep.py` (`DECOR`) in
 * `chen-006/meow-ai-arena`.
 */
export const DECOR_ISLAND_SPECS: Record<string, DecorIslandSpec> = {
  m00: { name: 'm00', rx: 2.6, ry: 4.6, seed: 200, cliffH: 3.4, depth: 12.0, taperK: 0.35, lobes: 6 },
  m01: { name: 'm01', rx: 2.4, ry: 4.2, seed: 201, cliffH: 3.4, depth: 12.0, taperK: 0.35, lobes: 6 },
  m02: { name: 'm02', rx: 8.5, ry: 2.4, seed: 202, cliffH: 3.4, depth: 12.0, taperK: 0.35, lobes: 6 },
  m03: { name: 'm03', rx: 3.0, ry: 2.0, seed: 203, cliffH: 3.4, depth: 12.0, taperK: 0.35, lobes: 6 },
  m04: { name: 'm04', rx: 2.6, ry: 1.8, seed: 204, cliffH: 3.4, depth: 12.0, taperK: 0.35, lobes: 6 },
  m05: { name: 'm05', rx: 10.5, ry: 2.6, seed: 205, cliffH: 3.4, depth: 12.0, taperK: 0.35, lobes: 6 },
  m06: { name: 'm06', rx: 3.0, ry: 5.6, seed: 206, cliffH: 3.4, depth: 12.0, taperK: 0.35, lobes: 6 },
  m07: { name: 'm07', rx: 2.8, ry: 5.2, seed: 207, cliffH: 3.4, depth: 12.0, taperK: 0.35, lobes: 6 },
  s00: { name: 's00', rx: 0.9, ry: 0.7, seed: 300, cliffH: 0.6, depth: 3.0, taperK: 0.6, lobes: 3 },
  s01: { name: 's01', rx: 0.6, ry: 0.5, seed: 301, cliffH: 0.6, depth: 3.0, taperK: 0.6, lobes: 3 },
  s02: { name: 's02', rx: 1.2, ry: 0.8, seed: 302, cliffH: 0.6, depth: 3.0, taperK: 0.6, lobes: 3 },
  s03: { name: 's03', rx: 0.5, ry: 0.45, seed: 303, cliffH: 0.6, depth: 3.0, taperK: 0.6, lobes: 3 },
};

export interface TopSurfaceSample {
  lx: number;
  ly: number;
  edgeDist: number;
}

interface TopTriRef {
  x0: number;
  y0: number;
  e0: number;
  x1: number;
  y1: number;
  e1: number;
  x2: number;
  y2: number;
  e2: number;
}

interface SkirtEdge {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

interface VoronoiColData {
  colOffset: number;
  facet: number;
  ledge1: number;
  ledge2: number;
}

interface CachedIslandTemplate {
  spec: DecorIslandSpec;
  nx: number;
  ny: number;
  x0: number;
  y0: number;
  res: number;
  sdf: Float32Array;
  gradX: Float32Array;
  gradY: Float32Array;
  topTris: TopTriRef[];
  /** Ordered closed boundary loops in CCW order (solid on left, void on right). */
  loops: [number, number][][];
  topSamples: TopSurfaceSample[];
  area: number;
  voroPts: [number, number][];
  voroRnd: [number, number, number, number][];
  keelSeed: number;
}

const _templateCache = new Map<string, CachedIslandTemplate>();

function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

function smoothstep(x: number, e0: number, e1: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Deterministic smooth 2D value noise in [-1, 1]. */
function hash2i(ix: number, iy: number, seed: number): number {
  let h = (Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1442695041)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (((h ^ (h >>> 16)) >>> 0) / 4294967295) * 2 - 1;
}

function valueNoise2D(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2i(ix, iy, seed);
  const b = hash2i(ix + 1, iy, seed);
  const c = hash2i(ix, iy + 1, seed);
  const d = hash2i(ix + 1, iy + 1, seed);
  return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
}

function fbm2D(x: number, y: number, seed: number): number {
  return (
    valueNoise2D(x, y, seed) * 0.62 +
    valueNoise2D(x * 2.03 + 17.1, y * 2.03 - 9.4, seed + 31) * 0.28 +
    valueNoise2D(x * 4.11 - 5.3, y * 4.11 + 13.7, seed + 67) * 0.1
  );
}

/** Separable 5-tap Gaussian blur on a 2D Float32Array grid. */
function blur2D(src: Float32Array, nx: number, ny: number, passes: number): Float32Array {
  let a = new Float32Array(src);
  let b = new Float32Array(src.length);
  const w0 = 0.06136, w1 = 0.24477, w2 = 0.38774;
  for (let p = 0; p < passes; p++) {
    // Horizontal
    for (let y = 0; y < ny; y++) {
      const row = y * nx;
      for (let x = 0; x < nx; x++) {
        const xm2 = x >= 2 ? x - 2 : 0;
        const xm1 = x >= 1 ? x - 1 : 0;
        const xp1 = x + 1 < nx ? x + 1 : nx - 1;
        const xp2 = x + 2 < nx ? x + 2 : nx - 1;
        b[row + x] =
          a[row + xm2] * w0 +
          a[row + xm1] * w1 +
          a[row + x] * w2 +
          a[row + xp1] * w1 +
          a[row + xp2] * w0;
      }
    }
    // Vertical
    for (let y = 0; y < ny; y++) {
      const ym2 = (y >= 2 ? y - 2 : 0) * nx;
      const ym1 = (y >= 1 ? y - 1 : 0) * nx;
      const y0 = y * nx;
      const yp1 = (y + 1 < ny ? y + 1 : ny - 1) * nx;
      const yp2 = (y + 2 < ny ? y + 2 : ny - 1) * nx;
      for (let x = 0; x < nx; x++) {
        a[y0 + x] =
          b[ym2 + x] * w0 +
          b[ym1 + x] * w1 +
          b[y0 + x] * w2 +
          b[yp1 + x] * w1 +
          b[yp2 + x] * w0;
      }
    }
  }
  return a;
}

/** Fast 2-pass Chamfer Euclidean-like distance transform (in meters) for a binary mask. */
function computeSignedDistance(mask: Uint8Array, nx: number, ny: number, res: number): Float32Array {
  const INF = 1e6;
  const dIn = new Float32Array(nx * ny);
  const dOut = new Float32Array(nx * ny);
  for (let i = 0; i < nx * ny; i++) {
    dIn[i] = mask[i] ? INF : 0;
    dOut[i] = mask[i] ? 0 : INF;
  }
  const runChamfer = (d: Float32Array) => {
    const ortho = res;
    const diag = res * 1.41421356;
    for (let y = 0; y < ny; y++) {
      const r = y * nx;
      for (let x = 0; x < nx; x++) {
        let v = d[r + x];
        if (v === 0) continue;
        if (x > 0) v = Math.min(v, d[r + x - 1] + ortho);
        if (y > 0) {
          const rp = r - nx;
          v = Math.min(v, d[rp + x] + ortho);
          if (x > 0) v = Math.min(v, d[rp + x - 1] + diag);
          if (x + 1 < nx) v = Math.min(v, d[rp + x + 1] + diag);
        }
        d[r + x] = v;
      }
    }
    for (let y = ny - 1; y >= 0; y--) {
      const r = y * nx;
      for (let x = nx - 1; x >= 0; x--) {
        let v = d[r + x];
        if (v === 0) continue;
        if (x + 1 < nx) v = Math.min(v, d[r + x + 1] + ortho);
        if (y + 1 < ny) {
          const rn = r + nx;
          v = Math.min(v, d[rn + x] + ortho);
          if (x + 1 < nx) v = Math.min(v, d[rn + x + 1] + diag);
          if (x > 0) v = Math.min(v, d[rn + x - 1] + diag);
        }
        d[r + x] = v;
      }
    }
  };
  runChamfer(dIn);
  runChamfer(dOut);

  const sdf = new Float32Array(nx * ny);
  for (let i = 0; i < nx * ny; i++) {
    const raw = dIn[i] - dOut[i];
    sdf[i] = mask[i] ? raw - res * 0.5 : raw + res * 0.5;
  }
  return blur2D(sdf, nx, ny, 2);
}

/** Sample bilinear value from grid. */
function sampleGrid(grid: Float32Array, nx: number, ny: number, x0: number, y0: number, res: number, x: number, y: number): number {
  const gx = clamp((x - x0) / res, 0, nx - 1.0001);
  const gy = clamp((y - y0) / res, 0, ny - 1.0001);
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  const fx = gx - ix;
  const fy = gy - iy;
  const r0 = iy * nx + ix;
  const r1 = r0 + nx;
  const a = grid[r0] + (grid[r0 + 1] - grid[r0]) * fx;
  const b = grid[r1] + (grid[r1 + 1] - grid[r1]) * fx;
  return a + (b - a) * fy;
}

/**
 * Chain unordered directed Marching-Squares boundary segments into closed CCW loops
 * so adjacent cliff quads can compute exact angle-threshold (`sharp_deg=33°`) normals.
 */
function chainSegmentsIntoLoops(edges: SkirtEdge[]): [number, number][][] {
  const keyOf = (x: number, y: number) => `${Math.round(x * 2000)}_${Math.round(y * 2000)}`;
  const nextMap = new Map<string, { ax: number; ay: number; bx: number; by: number; used: boolean }[]>();
  const all = edges.map((e) => ({ ...e, used: false }));
  for (const e of all) {
    const k = keyOf(e.ax, e.ay);
    let arr = nextMap.get(k);
    if (!arr) {
      arr = [];
      nextMap.set(k, arr);
    }
    arr.push(e);
  }

  const loops: [number, number][][] = [];
  for (const start of all) {
    if (start.used) continue;
    const loop: [number, number][] = [];
    let cur: typeof start | undefined = start;
    let guard = 0;
    while (cur && !cur.used && guard++ < all.length + 4) {
      cur.used = true;
      loop.push([cur.ax, cur.ay]);
      const candidates = nextMap.get(keyOf(cur.bx, cur.by));
      cur = candidates?.find((c) => !c.used);
    }
    if (loop.length >= 3) {
      loops.push(loop);
    }
  }
  return loops;
}

/**
 * Builds & caches the organic multi-lobe 2D SDF, watertight Marching-Squares top triangulation,
 * closed boundary contours, and Voronoi column layout for a `DECOR` island spec.
 */
function getIslandTemplate(spec: DecorIslandSpec): CachedIslandTemplate {
  const cached = _templateCache.get(spec.name);
  if (cached) return cached;

  const isSmall = spec.name.startsWith('s');
  const res = isSmall ? 0.14 : 0.34;
  const pad = isSmall ? 0.9 : 1.5;
  const W = spec.rx * 2 + pad * 2;
  const H = spec.ry * 2 + pad * 2;
  const nx = Math.max(12, Math.ceil(W / res) + 1);
  const ny = Math.max(12, Math.ceil(H / res) + 1);
  const x0 = -((nx - 1) * res) * 0.5;
  const y0 = -((ny - 1) * res) * 0.5;

  // 1. Multi-lobe organic silhouette matching `prep.py` `blob_mask`
  const rng = new SeededRng(spec.seed * 7919 + 17);
  const lobes: [number, number, number, number][] = [];
  for (let k = 0; k < spec.lobes; k++) {
    const cx = rng.uniform(-0.44, 0.44) * spec.rx;
    const cy = rng.uniform(-0.44, 0.44) * spec.ry;
    const ax = rng.uniform(0.48, 0.72) * spec.rx;
    const ay = rng.uniform(0.48, 0.72) * spec.ry;
    lobes.push([cx, cy, ax, ay]);
  }
  // Ensure center cohesion so island doesn't accidentally split into disconnected specks
  const centerScale = isSmall ? 0.78 : 0.56;
  lobes.push([0, 0, spec.rx * centerScale, spec.ry * centerScale]);

  const rawField = new Float32Array(nx * ny);
  for (let iy = 0; iy < ny; iy++) {
    const y = y0 + iy * res;
    const row = iy * nx;
    for (let ix = 0; ix < nx; ix++) {
      const x = x0 + ix * res;
      let f = -10;
      for (let k = 0; k < lobes.length; k++) {
        const [cx, cy, ax, ay] = lobes[k];
        const dx = (x - cx) / ax;
        const dy = (y - cy) / ay;
        const v = 1 - dx * dx - dy * dy;
        if (v > f) f = v;
      }
      const n = valueNoise2D(x * 0.72, y * 0.72, spec.seed + 5) * 0.14;
      rawField[row + ix] = f + n;
    }
  }

  // Smooth corner rounding (`round_mask` corner_r ≈ 0.30m)
  const smoothField = blur2D(rawField, nx, ny, isSmall ? 2 : 3);
  const mask = new Uint8Array(nx * ny);
  for (let iy = 1; iy < ny - 1; iy++) {
    const row = iy * nx;
    for (let ix = 1; ix < nx - 1; ix++) {
      mask[row + ix] = smoothField[row + ix] > 0.02 ? 1 : 0;
    }
  }

  // Keep only the largest connected component (avoids stray floating pixel specks)
  const compId = new Int32Array(nx * ny);
  let bestId = 0;
  let bestCount = 0;
  let nextId = 1;
  const qx: number[] = [];
  const qy: number[] = [];
  for (let iy = 1; iy < ny - 1; iy++) {
    for (let ix = 1; ix < nx - 1; ix++) {
      const idx = iy * nx + ix;
      if (!mask[idx] || compId[idx]) continue;
      const cid = nextId++;
      let count = 0;
      qx.length = 0;
      qy.length = 0;
      qx.push(ix);
      qy.push(iy);
      compId[idx] = cid;
      while (qx.length > 0) {
        const cx = qx.pop()!;
        const cy = qy.pop()!;
        count++;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const xx = cx + dx;
          const yy = cy + dy;
          if (xx <= 0 || yy <= 0 || xx >= nx - 1 || yy >= ny - 1) continue;
          const ni = yy * nx + xx;
          if (mask[ni] && !compId[ni]) {
            compId[ni] = cid;
            qx.push(xx);
            qy.push(yy);
          }
        }
      }
      if (count > bestCount) {
        bestCount = count;
        bestId = cid;
      }
    }
  }
  for (let i = 0; i < nx * ny; i++) {
    mask[i] = compId[i] === bestId ? 1 : 0;
  }

  // 2. Smooth 2D signed distance field `sdf` (> 0 inside, < 0 outside, 0 on exact coast)
  const sdf = computeSignedDistance(mask, nx, ny, res);
  // Nudge exact zeros off grid nodes so Marching Squares never creates zero-length degenerate edges
  const eps = res * 0.035;
  for (let i = 0; i < sdf.length; i++) {
    if (Math.abs(sdf[i]) < eps) sdf[i] = sdf[i] >= 0 ? eps : -eps;
  }

  // Precompute smooth inward gradient ∇sdf for organic medial-axis keel tapering
  const gradX = new Float32Array(nx * ny);
  const gradY = new Float32Array(nx * ny);
  for (let iy = 1; iy < ny - 1; iy++) {
    const r = iy * nx;
    for (let ix = 1; ix < nx - 1; ix++) {
      gradX[r + ix] = (sdf[r + ix + 1] - sdf[r + ix - 1]) / (2 * res);
      gradY[r + ix] = (sdf[r + ix + nx] - sdf[r + ix - nx]) / (2 * res);
    }
  }

  // 3. Watertight Marching-Squares-clipped top surface triangulation + boundary edges
  // Standard CCW polygon clipping of each grid cell against `sdf >= 0`!
  const topTris: TopTriRef[] = [];
  const skirtEdges: SkirtEdge[] = [];
  const topSamples: TopSurfaceSample[] = [];
  let area = 0;

  for (let iy = 0; iy < ny - 1; iy++) {
    const cy0 = y0 + iy * res;
    const cy1 = cy0 + res;
    const r0 = iy * nx;
    const r1 = r0 + nx;
    for (let ix = 0; ix < nx - 1; ix++) {
      const cx0 = x0 + ix * res;
      const cx1 = cx0 + res;
      // Cell corners in CCW order (Blender +Z up): BL -> BR -> TR -> TL
      const cX = [cx0, cx1, cx1, cx0];
      const cY = [cy0, cy0, cy1, cy1];
      const cV = [sdf[r0 + ix], sdf[r0 + ix + 1], sdf[r1 + ix + 1], sdf[r1 + ix]];

      let insideCount = 0;
      for (let k = 0; k < 4; k++) if (cV[k] > 0) insideCount++;
      if (insideCount === 0) continue;

      if (insideCount === 4) {
        topTris.push({
          x0: cX[0], y0: cY[0], e0: cV[0],
          x1: cX[1], y1: cY[1], e1: cV[1],
          x2: cX[2], y2: cY[2], e2: cV[2],
        });
        topTris.push({
          x0: cX[0], y0: cY[0], e0: cV[0],
          x1: cX[2], y1: cY[2], e1: cV[2],
          x2: cX[3], y2: cY[3], e2: cV[3],
        });
        const midE = (cV[0] + cV[1] + cV[2] + cV[3]) * 0.25;
        area += res * res;
        if (midE > (isSmall ? 0.16 : 0.42)) {
          topSamples.push({ lx: cx0 + res * 0.5, ly: cy0 + res * 0.5, edgeDist: midE });
        }
        continue;
      }

      // Partial boundary cell: build CCW clipped polygon(s) + exact zero-crossing skirt edges!
      const polyX: number[] = [];
      const polyY: number[] = [];
      const polyE: number[] = [];
      const crossPts: [number, number, boolean][] = []; // [x, y, enteringInside]

      for (let k = 0; k < 4; k++) {
        const kn = (k + 1) & 3;
        const va = cV[k];
        const vb = cV[kn];
        const aIn = va > 0;
        const bIn = vb > 0;
        if (aIn) {
          polyX.push(cX[k]);
          polyY.push(cY[k]);
          polyE.push(va);
        }
        if (aIn !== bIn) {
          const t = va / (va - vb);
          const px = cX[k] + (cX[kn] - cX[k]) * t;
          const py = cY[k] + (cY[kn] - cY[k]) * t;
          polyX.push(px);
          polyY.push(py);
          polyE.push(0);
          crossPts.push([px, py, !aIn]);
        }
      }

      // Handle saddle case cleanly (2 opposite inside corners: BL+TR or BR+TL)
      const isSaddle = insideCount === 2 && ((cV[0] > 0 && cV[2] > 0) || (cV[1] > 0 && cV[3] > 0));
      if (isSaddle && crossPts.length === 4) {
        const centerVal = (cV[0] + cV[1] + cV[2] + cV[3]) * 0.25;
        if (centerVal <= 0) {
          // Two separate corner triangles!
          for (let k = 0; k < 4; k++) {
            if (cV[k] <= 0) continue;
            const kp = (k + 3) & 3;
            const kn = (k + 1) & 3;
            const t1 = cV[k] / (cV[k] - cV[kn]);
            const x1 = cX[k] + (cX[kn] - cX[k]) * t1;
            const y1 = cY[k] + (cY[kn] - cY[k]) * t1;
            const t2 = cV[k] / (cV[k] - cV[kp]);
            const x2 = cX[k] + (cX[kp] - cX[k]) * t2;
            const y2 = cY[k] + (cY[kp] - cY[k]) * t2;
            topTris.push({ x0: cX[k], y0: cY[k], e0: cV[k], x1, y1, e1: 0, x2, y2, e2: 0 });
            // Boundary edge in CCW order around solid has solid on LEFT: (x1,y1) -> (x2,y2)
            skirtEdges.push({ ax: x1, ay: y1, bx: x2, by: y2 });
          }
          continue;
        }
      }

      // Standard non-saddle (or connected saddle): fan triangulate CCW polygon
      if (polyX.length >= 3) {
        for (let k = 1; k < polyX.length - 1; k++) {
          topTris.push({
            x0: polyX[0], y0: polyY[0], e0: polyE[0],
            x1: polyX[k], y1: polyY[k], e1: polyE[k],
            x2: polyX[k + 1], y2: polyY[k + 1], e2: polyE[k + 1],
          });
        }
      }

      // Extract directed CCW boundary edges (solid on left, void on right: exiting -> entering)
      for (let k = 0; k < polyX.length; k++) {
        const kn = (k + 1) % polyX.length;
        if (polyE[k] === 0 && polyE[kn] === 0) {
          skirtEdges.push({ ax: polyX[k], ay: polyY[k], bx: polyX[kn], by: polyY[kn] });
        }
      }
      area += res * res * (insideCount / 4);
    }
  }

  const loops = chainSegmentsIntoLoops(skirtEdges);

  // 4. Voronoi column seeds matching `terrain.py` `voronoi_columns(col_spacing = 0.8)`
  const colSpacing = isSmall ? 0.45 : 0.82;
  const nCols = Math.max(8, Math.round((W * H) / (colSpacing * colSpacing)));
  const vrng = new SeededRng(spec.seed * 3571 + 29);
  const voroPts: [number, number][] = [];
  const voroRnd: [number, number, number, number][] = [];
  for (let i = 0; i < nCols; i++) {
    voroPts.push([x0 + vrng.next() * W, y0 + vrng.next() * H]);
    voroRnd.push([
      vrng.uniform(-1, 1),
      vrng.uniform(-1, 1),
      vrng.uniform(-1, 1),
      vrng.uniform(-1, 1),
    ]);
  }

  const tpl: CachedIslandTemplate = {
    spec,
    nx,
    ny,
    x0,
    y0,
    res,
    sdf,
    gradX,
    gradY,
    topTris,
    loops,
    topSamples,
    area,
    voroPts,
    voroRnd,
    keelSeed: spec.seed + 37,
  };
  _templateCache.set(spec.name, tpl);
  return tpl;
}

function queryVoronoi(tpl: CachedIslandTemplate, x: number, y: number): VoronoiColData {
  let bestIdx = 0;
  let bestD2 = Infinity;
  const pts = tpl.voroPts;
  for (let i = 0; i < pts.length; i++) {
    const dx = x - pts[i][0];
    const dy = y - pts[i][1];
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestIdx = i;
    }
  }
  const r = tpl.voroRnd[bestIdx];
  const dx = x - pts[bestIdx][0];
  const dy = y - pts[bestIdx][1];
  const colOffset = r[0] * 0.75 + (r[1] * dx + r[2] * dy) * 1.05;
  const ledge1 = 0.55 + (r[1] * 0.5 + 0.5) * 0.9;
  const ledge2 = ledge1 + 0.72 + (r[2] * 0.5 + 0.5) * 0.9;
  return { colOffset, facet: r[3], ledge1, ledge2 };
}

/**
 * Advect a boundary point `(x, y)` inward along the smooth 2D SDF gradient `∇sdf` by `dist` meters.
 * Automatically stops cleanly at the local medial-axis ridge (`|∇sdf| → 0`) so concave lobes
 * taper organically into a downward mountain keel without EVER folding or self-intersecting!
 */
function advectInward(tpl: CachedIslandTemplate, x: number, y: number, dist: number): [number, number] {
  if (Math.abs(dist) < 1e-4) return [x, y];
  const steps = Math.max(1, Math.ceil(Math.abs(dist) / 0.22));
  const ds = dist / steps;
  let px = x;
  let py = y;
  for (let s = 0; s < steps; s++) {
    const gx = sampleGrid(tpl.gradX, tpl.nx, tpl.ny, tpl.x0, tpl.y0, tpl.res, px, py);
    const gy = sampleGrid(tpl.gradY, tpl.nx, tpl.ny, tpl.x0, tpl.y0, tpl.res, px, py);
    const gLen = Math.hypot(gx, gy);
    if (gLen < 0.08) break; // Reached medial axis spine!
    // Damping near medial ridge keeps neighboring vertices cleanly separated
    const damp = clamp((gLen - 0.08) / 0.52, 0.08, 1.0);
    px += (gx / gLen) * ds * damp;
    py += (gy / gLen) * ds * damp;
  }
  return [px, py];
}

export interface BuiltDecorIslandInfo {
  /** Interior top-surface candidate points in world Blender coords `(wx, wy, edgeDist)`. */
  topWorldPoints: { wx: number; wy: number; edgeDist: number }[];
  area: number;
  /** Outermost contour points in world Blender coords `(wx, wy)` (used for waterfall anchor). */
  rimWorldPoints: [number, number][];
}

/**
 * Emits one high-craft organic outer floating island into `mb` (using the smooth vertex-color bucket
 * with `sharp_deg = 33°` mixed smooth/crisp normals) matching `prep.py` + `terrain.py` + `env.py`!
 */
export function buildOriginalDecorIsland(
  mb: HqMeshBuilder,
  specName: string,
  worldX: number,
  worldY: number,
  worldZ: number,
  rotDeg: number,
  pal: HqPalette,
): BuiltDecorIslandInfo {
  const spec = DECOR_ISLAND_SPECS[specName] ?? DECOR_ISLAND_SPECS.m03;
  const tpl = getIslandTemplate(spec);

  const rad = (rotDeg * Math.PI) / 180;
  const cosR = Math.cos(rad);
  const sinR = Math.sin(rad);
  const toWorld = (lx: number, ly: number, lz: number): Vec3 => [
    worldX + cosR * lx - sinR * ly,
    worldY + sinR * lx + cosR * ly,
    worldZ + lz,
  ];
  const rotVec = (vx: number, vy: number, vz: number): Vec3 => [
    cosR * vx - sinR * vy,
    sinR * vx + cosR * vy,
    vz,
  ];

  // Exact `mat_terrain` palette colors in linear RGB
  const cGrass = hexLin(pal.grass);
  const cGrass2 = hexLin(pal.grass2);
  const cRim = hexLin(pal.grass_rim);
  const cLip = hexLin(pal.lip);
  const cSoil = hexLin(pal.soil);
  const cRockA = hexLin(pal.rock_a);
  const cRockB = hexLin(pal.rock_b);
  const cRockC = hexLin(pal.rock_c);
  const cRockDeep = hexLin(pal.rock_deep);
  const cLedgeHi = hexLin(pal.ledge_hi);
  const cRockUnder = hexLin(pal.rock_under);
  const cHaze = hexLin(pal.haze);

  /** Exact `SL._haze(col, Z, -1.6, -11.0, 0.88)` height-fog fade into cloud sea. */
  const applyHaze = (col: LinRGB, wz: number): LinRGB => {
    const t = smoothstep(wz, -1.6, -11.0) * 0.88;
    return t > 0.002 ? lerpLin(col, cHaze, t) : col;
  };

  /** Exact `mat_terrain` top grass shader (continuous 2D Perlin noise + bright edge rim). */
  const evalGrassColor = (wx: number, wy: number, wz: number, edgeDist: number): LinRGB => {
    const n1 = fbm2D(wx * 0.22, wy * 0.22, 101) * 0.5 + 0.5;
    let col = lerpLin(cGrass, cGrass2, smoothstep(n1, 0.43, 0.63));
    const rimT = smoothstep(edgeDist, 0.26, 0.04);
    if (rimT > 0.002) col = lerpLin(col, cRim, rimT);
    return applyHaze(col, wz);
  };

  /** Exact `mat_terrain` cliff shader (depth ramp + column facet + ledge_hi + rock_under + soil/lip). */
  const evalCliffColor = (depth: number, wz: number, nz: number, facet: number): LinRGB => {
    const f = clamp(depth / 7.0, 0, 1);
    let rock: LinRGB;
    if (f <= 0.04) rock = cRockA;
    else if (f <= 0.2) rock = lerpLin(cRockA, cRockB, (f - 0.04) / 0.16);
    else if (f <= 0.42) rock = lerpLin(cRockB, cRockC, (f - 0.2) / 0.22);
    else if (f <= 0.75) rock = lerpLin(cRockC, cRockDeep, (f - 0.42) / 0.33);
    else rock = cRockDeep;

    // Per-column brightness/hue variation (`facet * 0.09`)
    const vScale = 1.0 + facet * 0.095;
    rock = [
      clamp(rock[0] * (vScale + facet * 0.012), 0, 1),
      clamp(rock[1] * vScale, 0, 1),
      clamp(rock[2] * (vScale - facet * 0.012), 0, 1),
    ];

    // Upward-facing horizontal ledge highlight (`nz ∈ [0.25, 0.6]`)
    const hiT = smoothstep(nz, 0.25, 0.6) * 0.52;
    if (hiT > 0.002) rock = lerpLin(rock, cLedgeHi, hiT);

    // Underside cool rock shadow (`nz ∈ [-0.15, -0.6]`)
    const unT = smoothstep(nz, -0.15, -0.6);
    if (unT > 0.002) rock = lerpLin(rock, cRockUnder, unT);

    // Soil & grass overhang lip near top
    const soilMix = lerpLin(cSoil, rock, smoothstep(depth, 0.18, 0.34));
    const side = lerpLin(cLip, soilMix, smoothstep(depth, 0.07, 0.16));
    return applyHaze(side, wz);
  };

  // Compute outward horizontal normal at any contour point `(lx, ly)` from `-∇sdf`
  const outwardNormal2D = (lx: number, ly: number): [number, number] => {
    const gx = sampleGrid(tpl.gradX, tpl.nx, tpl.ny, tpl.x0, tpl.y0, tpl.res, lx, ly);
    const gy = sampleGrid(tpl.gradY, tpl.nx, tpl.ny, tpl.x0, tpl.y0, tpl.res, lx, ly);
    const len = Math.hypot(gx, gy) || 1;
    return [-gx / len, -gy / len];
  };

  // ------------------------------------------------------------------
  // 1. Emit smooth organic grass top surface (watertight Marching Squares)
  // ------------------------------------------------------------------
  const topNormalAt = (lx: number, ly: number, edgeDist: number): Vec3 => {
    // Gently curve the outer 0.16m of grass downward into the rounded lip (`lip_round`)
    if (edgeDist >= 0.16) return [0, 0, 1];
    const [ox, oy] = outwardNormal2D(lx, ly);
    const t = 1 - edgeDist / 0.16;
    const tilt = t * t * 0.42;
    const nz = Math.sqrt(Math.max(0.01, 1 - tilt * tilt));
    return rotVec(ox * tilt, oy * tilt, nz);
  };

  for (let i = 0; i < tpl.topTris.length; i++) {
    const tr = tpl.topTris[i];
    const p0 = toWorld(tr.x0, tr.y0, 0);
    const p1 = toWorld(tr.x1, tr.y1, 0);
    const p2 = toWorld(tr.x2, tr.y2, 0);
    const n0 = topNormalAt(tr.x0, tr.y0, tr.e0);
    const n1 = topNormalAt(tr.x1, tr.y1, tr.e1);
    const n2 = topNormalAt(tr.x2, tr.y2, tr.e2);
    const c0 = evalGrassColor(p0[0], p0[1], p0[2], tr.e0);
    const c1 = evalGrassColor(p1[0], p1[1], p1[2], tr.e1);
    const c2 = evalGrassColor(p2[0], p2[1], p2[2], tr.e2);
    mb.triSmooth(p0, p1, p2, n0, n1, n2, c0, c1, c2, 'smooth');
  }

  // ------------------------------------------------------------------
  // 2. Emit rounded grass lip + soil + Voronoi columnar cliff + ledges + tapered keel
  //    with exact `sharp_deg = 33°` auto-smooth normals!
  // ------------------------------------------------------------------
  const isSmall = spec.name.startsWith('s');
  const maxSdf = (() => {
    let m = 0.3;
    for (let i = 0; i < tpl.sdf.length; i++) if (tpl.sdf[i] > m) m = tpl.sdf[i];
    return m;
  })();
  const rawDepth = Math.min(
    spec.depth,
    spec.cliffH + Math.pow(Math.max(maxSdf, 0.35) / spec.taperK, 1 / 1.25) + 0.55,
  );
  // Keep tiny floating stones (`s00..s03`) chunky rather than overly elongated icicles
  const actualDepth = isSmall ? Math.min(rawDepth, (spec.rx + spec.ry) * 0.95) : rawDepth;
  const zbot = -actualDepth;
  void zbot;

  // Vertical profile levels (depth `u` below `z = 0`):
  // 0..2: rounded grass lip + soil undercut
  // 3..6: Voronoi columnar cliff with staggered horizontal ledges
  // 7..N: organic tapered rough keel down to `actualDepth`
  const uBands: number[] = isSmall
    ? [0.0, 0.045, 0.13, 0.25, 0.52, actualDepth * 0.46, actualDepth * 0.72, actualDepth * 0.92, actualDepth]
    : [
        0.0,
        0.055,
        0.145,
        0.27,
        0.65,
        1.25,
        2.05,
        Math.min(spec.cliffH, actualDepth * 0.54),
        actualDepth * 0.64,
        actualDepth * 0.78,
        actualDepth * 0.91,
        actualDepth,
      ];
  const nRings = uBands.length;
  const colAmp = isSmall ? 0.06 : 0.14;
  const ledgeStep = isSmall ? 0.035 : 0.075;
  const roughAmp = isSmall ? 0.12 : 0.28;
  const SHARP_COS = Math.cos((33 * Math.PI) / 180); // exact `sharp_deg=33`!

  const rimWorldPoints: [number, number][] = [];

  for (const loop of tpl.loops) {
    const N = loop.length;
    if (N < 3) continue;

    // Collect world rim points for waterfall anchor
    for (let i = 0; i < N; i++) {
      const wp = toWorld(loop[i][0], loop[i][1], 0);
      rimWorldPoints.push([wp[0], wp[1]]);
    }

    // Query Voronoi column data for each perimeter vertex
    const vData: VoronoiColData[] = new Array(N);
    for (let i = 0; i < N; i++) {
      vData[i] = queryVoronoi(tpl, loop[i][0], loop[i][1]);
    }

    // Compute 3D world positions for `[ring][i]`
    const ringPos: Vec3[][] = Array.from({ length: nRings }, () => new Array<Vec3>(N));
    for (let r = 0; r < nRings; r++) {
      const u = uBands[r];
      const baseTaper =
        (u > 0.15 ? 0.035 : 0) +
        (u > spec.cliffH ? spec.taperK * Math.pow(u - spec.cliffH, 1.25) : 0);

      for (let i = 0; i < N; i++) {
        const [bx, by] = loop[i];
        if (r === 0) {
          ringPos[0][i] = toWorld(bx, by, 0);
          continue;
        }
        const vd = vData[i];
        let inset = baseTaper;
        if (r === 1) {
          // Slight outward pillow overhang on grass lip
          inset = -0.025;
        } else if (u > 0.15) {
          const w = clamp((u - 0.15) / 0.22, 0, 1);
          inset += vd.colOffset * colAmp * w;
          if (u > vd.ledge1) inset += ledgeStep;
          if (u > vd.ledge2) inset += ledgeStep * 0.8;
        }
        if (u > spec.cliffH) {
          const kRough = clamp((u - spec.cliffH) / 1.8, 0, 1);
          const rn = valueNoise2D(bx * 0.55 + u * 0.35, by * 0.55 - u * 0.28, tpl.keelSeed);
          inset += rn * roughAmp * kRough;
        }
        // Final ring converges cleanly toward medial spine
        if (r === nRings - 1) {
          inset = Math.max(inset, maxSdf * 1.15);
        }
        const [ax, ay] = advectInward(tpl, bx, by, inset);
        ringPos[r][i] = toWorld(ax, ay, -u);
      }
    }

    // Compute per-quad face normals `fn[r][i]` for quad `(r,i)-(r+1,i)-(r+1,i+1)-(r,i+1)`
    // Note: loop is CCW around solid, so moving from `i -> i+1` goes CCW (right-to-left viewed from outside).
    // Going `(r,i) -> (r+1,i) -> (r+1,i+1)` has outward normal!
    const nBands = nRings - 1;
    const fn: Vec3[][] = Array.from({ length: nBands }, () => new Array<Vec3>(N));
    for (let r = 0; r < nBands; r++) {
      for (let i = 0; i < N; i++) {
        const j = (i + 1) % N;
        const p0 = ringPos[r][i];
        const p1 = ringPos[r + 1][i];
        const p2 = ringPos[r + 1][j];
        const p3 = ringPos[r][j];
        // Average both diagonals for clean quad normal
        const ux = p2[0] - p0[0], uy = p2[1] - p0[1], uz = p2[2] - p0[2];
        const vx = p3[0] - p1[0], vy = p3[1] - p1[1], vz = p3[2] - p1[2];
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        const nl = Math.hypot(nx, ny, nz);
        if (nl < 1e-6) {
          const [ox, oy] = outwardNormal2D(loop[i][0], loop[i][1]);
          const rn = rotVec(ox, oy, 0);
          nx = rn[0];
          ny = rn[1];
          nz = rn[2];
        } else {
          nx /= nl;
          ny /= nl;
          nz /= nl;
        }
        fn[r][i] = [nx, ny, nz];
      }
    }

    // Angle-threshold (`sharp_deg = 33°`) vertex normal helper for quad `(r, i)` at corner `(vr, vi)`
    const cornerNormal = (r: number, i: number, vr: number, vi: number): Vec3 => {
      // Top rim seamlessly shares the curved grass-lip normal with the top Marching Squares mesh!
      if (vr === 0) {
        return topNormalAt(loop[vi][0], loop[vi][1], 0);
      }
      const selfN = fn[r][i];
      let sx = selfN[0];
      let sy = selfN[1];
      let sz = selfN[2];
      // Check up to 4 quads touching vertex `(vr, vi)`
      const iPrev = (vi + N - 1) % N;
      const rChoices = vr > 0 && vr < nBands ? [vr - 1, vr] : vr === 0 ? [0] : [nBands - 1];
      const iChoices = [iPrev, vi];
      for (const rr of rChoices) {
        for (const ii of iChoices) {
          if (rr === r && ii === i) continue;
          const nb = fn[rr][ii];
          const dot = selfN[0] * nb[0] + selfN[1] * nb[1] + selfN[2] * nb[2];
          // Force smooth across lip bands (vr <= 2), angle-threshold 33° on rock cliff!
          if (vr <= 2 || dot >= SHARP_COS) {
            sx += nb[0];
            sy += nb[1];
            sz += nb[2];
          }
        }
      }
      const l = Math.hypot(sx, sy, sz) || 1;
      return [sx / l, sy / l, sz / l];
    };

    // Emit all skirt quads into the `smooth` bucket (respects our exact per-corner smooth/sharp normals!)
    for (let r = 0; r < nBands; r++) {
      const uTop = uBands[r];
      const uBot = uBands[r + 1];
      for (let i = 0; i < N; i++) {
        const j = (i + 1) % N;
        const p0 = ringPos[r][i];
        const p1 = ringPos[r + 1][i];
        const p2 = ringPos[r + 1][j];
        const p3 = ringPos[r][j];

        const n0 = cornerNormal(r, i, r, i);
        const n1 = cornerNormal(r, i, r + 1, i);
        const n2 = cornerNormal(r, i, r + 1, j);
        const n3 = cornerNormal(r, i, r, j);

        const fcI = vData[i].facet;
        const fcJ = vData[j].facet;
        const c0 = r === 0 ? evalGrassColor(p0[0], p0[1], p0[2], 0) : evalCliffColor(uTop, p0[2], n0[2], fcI);
        const c1 = evalCliffColor(uBot, p1[2], n1[2], fcI);
        const c2 = evalCliffColor(uBot, p2[2], n2[2], fcJ);
        const c3 = r === 0 ? evalGrassColor(p3[0], p3[1], p3[2], 0) : evalCliffColor(uTop, p3[2], n3[2], fcJ);

        mb.triSmooth(p0, p1, p2, n0, n1, n2, c0, c1, c2, 'smooth');
        mb.triSmooth(p0, p2, p3, n0, n2, n3, c0, c2, c3, 'smooth');
      }
    }

    // Close bottom underside keel cleanly so upward-looking close-up cameras never see inside
    const botRing = ringPos[nRings - 1];
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < N; i++) {
      cx += botRing[i][0];
      cy += botRing[i][1];
      cz += botRing[i][2];
    }
    const tip: Vec3 = [cx / N, cy / N, cz / N - (isSmall ? 0.22 : 0.45)];
    const tipN: Vec3 = [0, 0, -1];
    const tipC = applyHaze(scaleLin(cRockUnder, 0.92), tip[2]);
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      const a = botRing[i];
      const b = botRing[j];
      const ca = applyHaze(cRockUnder, a[2]);
      const cb = applyHaze(cRockUnder, b[2]);
      mb.triSmooth(a, tip, b, tipN, tipN, tipN, ca, tipC, cb, 'smooth');
    }
  }

  // Transform interior prop-placement samples to world Blender coords
  const topWorldPoints = tpl.topSamples.map((s) => {
    const wp = toWorld(s.lx, s.ly, 0);
    return { wx: wp[0], wy: wp[1], edgeDist: s.edgeDist };
  });

  return { topWorldPoints, area: tpl.area, rimWorldPoints };
}
