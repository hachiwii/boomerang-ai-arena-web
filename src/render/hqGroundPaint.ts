import * as THREE from 'three';
import { CellType, EngineMapData } from '../game/types';
import { SeededRng } from './hqGeomBuilder';
import { HqThemeSpec, RGB } from './hqThemes';

export interface BridgeSpec {
  bx: number; // map X center (meters)
  by: number; // map Y center (meters)
  ax: number; // bridge length axis unit X
  ay: number; // bridge length axis unit Y
  hl: number; // half length (meters)
  hw: number; // half width (meters)
}

export interface PaintedGroundResult {
  texture: THREE.CanvasTexture;
  mg: number;
  ppm: number;
  widthPx: number;
  heightPx: number;
  dirt: Float32Array; // [heightPx * widthPx] 0..1
  quiet: Float32Array; // [heightPx * widthPx] 0..1
  bridges: BridgeSpec[];
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function smoothstep(x: number, a: number, b: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/** Fast separable box blur (2 passes ≈ Gaussian) on a Float32Array image. */
function blur2D(src: Float32Array, w: number, h: number, radiusPx: number, passes = 2): Float32Array {
  const r = Math.max(1, Math.round(radiusPx));
  let cur = new Float32Array(src);
  let tmp = new Float32Array(w * h);

  for (let p = 0; p < passes; p++) {
    // Horizontal pass
    const inv = 1 / (2 * r + 1);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = cur[row] * (r + 1);
      for (let x = 1; x <= r; x++) acc += cur[row + Math.min(w - 1, x)];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc * inv;
        const addIdx = Math.min(w - 1, x + r + 1);
        const remIdx = Math.max(0, x - r);
        acc += cur[row + addIdx] - cur[row + remIdx];
      }
    }
    // Vertical pass
    for (let x = 0; x < w; x++) {
      let acc = tmp[x] * (r + 1);
      for (let y = 1; y <= r; y++) acc += tmp[Math.min(h - 1, y) * w + x];
      for (let y = 0; y < h; y++) {
        cur[y * w + x] = acc * inv;
        const addIdx = Math.min(h - 1, y + r + 1);
        const remIdx = Math.max(0, y - r);
        acc += tmp[addIdx * w + x] - tmp[remIdx * w + x];
      }
    }
  }
  return cur;
}

/** Fast 2-pass Chamfer Euclidean distance transform (returns distance in pixels from 0-mask pixels). */
function distanceToZero(mask: Uint8Array, w: number, h: number): Float32Array {
  const dist = new Float32Array(w * h);
  const INF = 1e6;
  for (let i = 0; i < w * h; i++) dist[i] = mask[i] ? INF : 0;

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let d = dist[row + x];
      if (d === 0) continue;
      if (x > 0) d = Math.min(d, dist[row + x - 1] + 1);
      if (y > 0) {
        d = Math.min(d, dist[row - w + x] + 1);
        if (x > 0) d = Math.min(d, dist[row - w + x - 1] + 1.4142);
        if (x + 1 < w) d = Math.min(d, dist[row - w + x + 1] + 1.4142);
      }
      dist[row + x] = d;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    const row = y * w;
    for (let x = w - 1; x >= 0; x--) {
      let d = dist[row + x];
      if (d === 0) continue;
      if (x + 1 < w) d = Math.min(d, dist[row + x + 1] + 1);
      if (y + 1 < h) {
        d = Math.min(d, dist[row + w + x] + 1);
        if (x + 1 < w) d = Math.min(d, dist[row + w + x + 1] + 1.4142);
        if (x > 0) d = Math.min(d, dist[row + w + x - 1] + 1.4142);
      }
      dist[row + x] = d;
    }
  }
  return dist;
}

/** Smooth bilinearly-upsampled value noise on [0..1]. */
function valueNoise2D(w: number, h: number, cellPx: number, rng: SeededRng): Float32Array {
  const gw = Math.max(2, Math.ceil(w / cellPx) + 2);
  const gh = Math.max(2, Math.ceil(h / cellPx) + 2);
  const grid = new Float32Array(gw * gh);
  for (let i = 0; i < grid.length; i++) grid[i] = rng.next();

  const out = new Float32Array(w * h);
  const inv = 1 / cellPx;
  for (let y = 0; y < h; y++) {
    const fy = y * inv;
    const iy = Math.floor(fy);
    const ty = fy - iy;
    const sy = ty * ty * (3 - 2 * ty);
    const r0 = iy * gw;
    const r1 = (iy + 1) * gw;
    const rowOut = y * w;
    for (let x = 0; x < w; x++) {
      const fx = x * inv;
      const ix = Math.floor(fx);
      const tx = fx - ix;
      const sx = tx * tx * (3 - 2 * tx);
      const v00 = grid[r0 + ix];
      const v10 = grid[r0 + ix + 1];
      const v01 = grid[r1 + ix];
      const v11 = grid[r1 + ix + 1];
      const top = v00 + (v10 - v00) * sx;
      const bot = v01 + (v11 - v01) * sx;
      out[rowOut + x] = top + (bot - top) * sy;
    }
  }
  return out;
}

/** Detect narrow wooden bridge segments on the cell grid (matching `ground_paint._bridges`). */
function detectBridges(mapData: EngineMapData, maxHalfWidthM: number): BridgeSpec[] {
  const { nx, ny, cells, cell } = mapData;
  const cs = cell / 1000;
  const maxThickCells = Math.max(1, Math.round((maxHalfWidthM * 2) / cs));
  const solid = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < nx && y < ny && cells[y * nx + x] !== CellType.PIT;

  const cand = new Uint8Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      if (!solid(x, y) || cells[y * nx + x] === CellType.WALL) continue;
      // Measure vertical thickness & horizontal thickness
      let vSpan = 1;
      for (let d = 1; d <= maxThickCells + 1 && solid(x, y - d); d++) vSpan++;
      for (let d = 1; d <= maxThickCells + 1 && solid(x, y + d); d++) vSpan++;
      let hSpan = 1;
      for (let d = 1; d <= maxThickCells + 1 && solid(x - d, y); d++) hSpan++;
      for (let d = 1; d <= maxThickCells + 1 && solid(x + d, y); d++) hSpan++;

      const horizBridge = vSpan <= maxThickCells && hSpan >= vSpan + 2;
      const vertBridge = hSpan <= maxThickCells && vSpan >= hSpan + 2;
      if (horizBridge || vertBridge) {
        cand[y * nx + x] = horizBridge ? 1 : 2;
      }
    }
  }

  const seen = new Uint8Array(nx * ny);
  const bridges: BridgeSpec[] = [];
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const tag = cand[y * nx + x];
      if (!tag || seen[y * nx + x]) continue;
      const stack: [number, number][] = [[x, y]];
      seen[y * nx + x] = 1;
      let minX = x, maxX = x, minY = y, maxY = y;
      let count = 0;
      while (stack.length > 0) {
        const [cx, cy] = stack.pop()!;
        count++;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const xx = cx + dx;
          const yy = cy + dy;
          if (xx >= 0 && yy >= 0 && xx < nx && yy < ny && !seen[yy * nx + xx] && cand[yy * nx + xx] === tag) {
            seen[yy * nx + xx] = 1;
            stack.push([xx, yy]);
          }
        }
      }
      if (count < 4) continue;
      const wM = (maxX - minX + 1) * cs;
      const hM = (maxY - minY + 1) * cs;
      const bx = (minX + maxX + 1) * 0.5 * cs;
      const by = (minY + maxY + 1) * 0.5 * cs;
      if (wM >= hM) {
        bridges.push({ bx, by, ax: 1, ay: 0, hl: wM * 0.5, hw: hM * 0.5 });
      } else {
        bridges.push({ bx, by, ax: 0, ay: 1, hl: hM * 0.5, hw: wM * 0.5 });
      }
    }
  }
  return bridges;
}

/**
 * Generates the painted procedural ground CanvasTexture + dirt/quiet auxiliary masks
 * faithfully porting `ground_paint.py` for all 10 open-source themes!
 */
export function paintHighQualityGround(
  mapData: EngineMapData,
  theme: HqThemeSpec,
  seed = 7,
): PaintedGroundResult {
  const cs = mapData.cell / 1000;
  const Wm = mapData.nx * cs;
  const Hm = mapData.ny * cs;
  const MG = 0.6;
  const PPM = 28; // crisp ~500-850px painted ground, builds in ~20ms
  const W = Math.max(64, Math.round((Wm + 2 * MG) * PPM));
  const H = Math.max(64, Math.round((Hm + 2 * MG) * PPM));
  const N = W * H;

  const rng = new SeededRng(seed);
  const C = theme.ground;
  const st = theme.gstyle;

  // Rasterize cell masks
  const solid = new Uint8Array(N);
  const wall = new Uint8Array(N);
  const tall = new Uint8Array(N);
  const pitInside = new Uint8Array(N);

  for (let py = 0; py < H; py++) {
    const my = py / PPM - MG;
    const gy = Math.floor(my / cs);
    const inY = gy >= 0 && gy < mapData.ny;
    const row = py * W;
    for (let px = 0; px < W; px++) {
      const mx = px / PPM - MG;
      const gx = Math.floor(mx / cs);
      if (inY && gx >= 0 && gx < mapData.nx) {
        const ct = mapData.cells[gy * mapData.nx + gx];
        if (ct === CellType.PIT) {
          pitInside[row + px] = 1;
        } else {
          solid[row + px] = 1;
          if (ct === CellType.WALL) wall[row + px] = 1;
          else if (ct === CellType.GRASS) tall[row + px] = 1;
        }
      }
    }
  }

  // Distance transforms (in meters)
  const dEdgePx = distanceToZero(solid, W, H);
  const notWall = new Uint8Array(N);
  for (let i = 0; i < N; i++) notWall[i] = wall[i] ? 0 : 1;
  const dWallPx = distanceToZero(notWall, W, H);

  // Multi-scale value noise
  const nBig = valueNoise2D(W, H, 2.2 * PPM, rng);
  const nMid = valueNoise2D(W, H, 0.9 * PPM, rng);
  const nSm = valueNoise2D(W, H, 0.34 * PPM, rng);
  const nFine = valueNoise2D(W, H, 0.13 * PPM, rng);

  // Worn organic dirt paths connecting spawns & arena center hub
  const dirtRaw = new Float32Array(N);
  const stamps: [number, number][] = [];
  if (mapData.spawns && mapData.spawns.length > 0) {
    for (const sp of mapData.spawns) stamps.push([sp[0] / 1000, sp[1] / 1000]);
  } else {
    // Fallback heuristic spawn corners when preview map has no explicit spawns
    stamps.push([Wm * 0.22, Hm * 0.25], [Wm * 0.78, Hm * 0.75], [Wm * 0.22, Hm * 0.75], [Wm * 0.78, Hm * 0.25]);
  }
  const hubX = Wm * 0.5;
  const hubY = Hm * 0.5;

  const paintBlob = (mx: number, my: number, radM: number, val: number) => {
    const cx = (mx + MG) * PPM;
    const cy = (my + MG) * PPM;
    const rPx = radM * PPM;
    const x0 = Math.max(0, Math.floor(cx - rPx));
    const x1 = Math.min(W - 1, Math.ceil(cx + rPx));
    const y0 = Math.max(0, Math.floor(cy - rPx));
    const y1 = Math.min(H - 1, Math.ceil(cy + rPx));
    const r2 = rPx * rPx;
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      const row = y * W;
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        if (dx * dx + dy * dy <= r2) {
          if (val > dirtRaw[row + x]) dirtRaw[row + x] = val;
        }
      }
    }
  };

  for (const [sx, sy] of stamps) {
    paintBlob(sx, sy, 0.72, 1.0);
    // Curved path toward hub (avoiding walls & pits softly)
    const steps = 26;
    const bend = (rng.next() - 0.5) * 1.1;
    const dx = hubX - sx;
    const dy = hubY - sy;
    const len = Math.hypot(dx, dy) || 1;
    const px = -dy / len;
    const py = dx / len;
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const arc = Math.sin(Math.PI * t) * bend;
      const wx = sx + dx * t + px * arc;
      const wy = sy + dy * t + py * arc;
      const gx = Math.floor(wx / cs);
      const gy = Math.floor(wy / cs);
      if (gx >= 0 && gy >= 0 && gx < mapData.nx && gy < mapData.ny && mapData.cells[gy * mapData.nx + gx] === CellType.FLOOR) {
        paintBlob(wx, wy, 0.42, 0.85);
      }
    }
  }
  paintBlob(hubX, hubY, 0.85, 0.8);

  const dirtF = blur2D(dirtRaw, W, H, 0.48 * PPM, 2);
  const dirt = new Float32Array(N);
  const quiet = new Float32Array(N);

  const tallFloat = new Float32Array(N);
  const wallFloat = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    tallFloat[i] = tall[i];
    wallFloat[i] = wall[i];
  }
  const tallF = blur2D(tallFloat, W, H, 0.12 * PPM, 2);
  const wsh = blur2D(wallFloat, W, H, 0.17 * PPM, 2);

  // Allocate float RGB buffer (0..255)
  const rgb = new Float32Array(N * 3);

  const mixRgb = (idx3: number, target: RGB, w: number) => {
    const u = clamp01(w);
    const iu = 1 - u;
    rgb[idx3] = rgb[idx3] * iu + target[0] * u;
    rgb[idx3 + 1] = rgb[idx3 + 1] * iu + target[1] * u;
    rgb[idx3 + 2] = rgb[idx3 + 2] * iu + target[2] * u;
  };

  for (let i = 0; i < N; i++) {
    const de = dEdgePx[i] / PPM;
    const dw = dWallPx[i] / PPM;
    const isSolid = solid[i] === 1;

    // Modulated organic dirt mask
    const df = dirtF[i] * (0.72 + 0.56 * nMid[i]) * (isSolid ? 1 : 0) * (1 - smoothstep(tallF[i], 0.25, 0.65));
    const dVal = smoothstep(df, 0.32, 0.54) * smoothstep(dw, 0.18, 0.48);
    dirt[i] = dVal;
    const qVal = clamp01((1 - dVal) * (1 - smoothstep(df, 0.12, 0.42)) * smoothstep(de, 0.15, 0.55));
    quiet[i] = qVal;

    const idx3 = i * 3;
    // Base grass/ground gradient
    let r = C.mid[0], g = C.mid[1], b = C.mid[2];
    const wLight = smoothstep(nBig[i] * 0.7 + nMid[i] * 0.3, 0.46, 0.72) * 0.82;
    r = r * (1 - wLight) + C.light[0] * wLight;
    g = g * (1 - wLight) + C.light[1] * wLight;
    b = b * (1 - wLight) + C.light[2] * wLight;

    const wDark = smoothstep(1 - (nBig[i] * 0.65 + nMid[i] * 0.35), 0.5, 0.76) * 0.78;
    r = r * (1 - wDark) + C.dark[0] * wDark;
    g = g * (1 - wDark) + C.dark[1] * wDark;
    b = b * (1 - wDark) + C.dark[2] * wDark;

    const wLush = smoothstep(nMid[i], 0.54, 0.76) * qVal * 0.55;
    r = r * (1 - wLush) + C.lush[0] * wLush;
    g = g * (1 - wLush) + C.lush[1] * wLush;
    b = b * (1 - wLush) + C.lush[2] * wLush;

    const wClover = smoothstep(nSm[i], 0.64, 0.82) * qVal * 0.38;
    r = r * (1 - wClover) + C.clover[0] * wClover;
    g = g * (1 - wClover) + C.clover[1] * wClover;
    b = b * (1 - wClover) + C.clover[2] * wClover;

    rgb[idx3] = r;
    rgb[idx3 + 1] = g;
    rgb[idx3 + 2] = b;

    // Dirt rim + worn dirt fill
    const rimD = smoothstep(df, 0.24, 0.34) * (1 - smoothstep(df, 0.38, 0.5));
    mixRgb(idx3, C.dirt_rim, rimD * 0.5);
    if (dVal > 0.001) {
      let dr = C.dirt[0], dg = C.dirt[1], db = C.dirt[2];
      const hi = smoothstep(nSm[i], 0.54, 0.72) * 0.75;
      dr = dr * (1 - hi) + C.dirt_hi[0] * hi;
      dg = dg * (1 - hi) + C.dirt_hi[1] * hi;
      db = db * (1 - hi) + C.dirt_hi[2] * hi;
      const lo = smoothstep(nFine[i], 0.66, 0.82) * 0.48;
      dr = dr * (1 - lo) + C.dirt_lo[0] * lo;
      dg = dg * (1 - lo) + C.dirt_lo[1] * lo;
      db = db * (1 - lo) + C.dirt_lo[2] * lo;
      rgb[idx3] = rgb[idx3] * (1 - dVal) + dr * dVal;
      rgb[idx3 + 1] = rgb[idx3 + 1] * (1 - dVal) + dg * dVal;
      rgb[idx3 + 2] = rgb[idx3 + 2] * (1 - dVal) + db * dVal;
    }

    // Dark under-grass bed
    mixRgb(idx3, C.tall, smoothstep(tallF[i], 0.28, 0.68));

    // Soft contact shadow around obstacles
    const ws = wsh[i];
    if (ws > 0.04) {
      mixRgb(idx3, C.dirt_lo, smoothstep(ws, 0.15, 0.6) * smoothstep(nSm[i], 0.5, 0.66) * 0.32);
      const shade = 1 - 0.22 * smoothstep(ws, 0.05, 0.7);
      rgb[idx3] *= shade;
      rgb[idx3 + 1] *= shade;
      rgb[idx3 + 2] *= shade;
    }

    // Island edge bright rim highlight
    const rim = (1 - smoothstep(de, 0.05, 0.22)) * (1 - dVal);
    mixRgb(idx3, C.rim, rim * 0.82);
  }

  // ---- Theme-specific ground layers (`gstyle`) ----
  if (st.pave) {
    const slab = C.slab ?? C.dirt;
    const slabHi = C.slab_hi ?? C.dirt_hi;
    const slabLo = C.slab_lo ?? C.dirt_lo;
    const joint = C.joint ?? C.dirt_lo;
    const rowH = 0.5;
    const tileTone = new Float32Array(N);
    const tileMask = new Float32Array(N);

    for (let yy0 = -MG; yy0 < Hm + MG; yy0 += rowH) {
      let xx0 = -MG - rng.uniform(0, 0.5);
      while (xx0 < Wm + MG) {
        const wd = rng.choice([0.5, 0.5, 0.75, 1.0]);
        const cxm = xx0 + wd * 0.5;
        const cym = yy0 + rowH * 0.5;
        const cxp = Math.min(W - 1, Math.max(0, Math.round((cxm + MG) * PPM)));
        const cyp = Math.min(H - 1, Math.max(0, Math.round((cym + MG) * PPM)));
        const cIdx = cyp * W + cxp;
        let want = 0;
        if (solid[cIdx]) {
          if (st.pave === 'near') {
            const dw = dWallPx[cIdx] / PPM;
            const dc = Math.hypot(cxm - Wm * 0.5, cym - Hm * 0.5);
            want = Math.max(smoothstep(dw, 0.95, 0.4) * 0.8, smoothstep(dc, 1.9, 1.1));
          } else {
            want = 1.0 - 0.75 * quiet[cIdx] * smoothstep(nMid[cIdx], 0.5, 0.7);
          }
        }
        if (want > rng.uniform(0.25, 0.6)) {
          const tone = rng.uniform(-1, 1);
          const x0p = Math.max(0, Math.round((xx0 + MG) * PPM + 1.5));
          const x1p = Math.min(W - 1, Math.round((xx0 + wd + MG) * PPM - 1.5));
          const y0p = Math.max(0, Math.round((yy0 + MG) * PPM + 1.5));
          const y1p = Math.min(H - 1, Math.round((yy0 + rowH + MG) * PPM - 1.5));
          for (let y = y0p; y <= y1p; y++) {
            const row = y * W;
            for (let x = x0p; x <= x1p; x++) {
              tileTone[row + x] = tone;
              tileMask[row + x] = 1;
            }
          }
        }
        xx0 += wd;
      }
    }
    const keep = blur2D(tileMask, W, H, 1.0, 1);
    for (let i = 0; i < N; i++) {
      if (!solid[i]) continue;
      const notTall = 1 - smoothstep(tallF[i], 0.3, 0.7);
      if (st.pave === 'all') {
        mixRgb(i * 3, joint, notTall * (1 - 0.8 * quiet[i] * smoothstep(nMid[i], 0.5, 0.7)));
      }
      const sl = clamp01(keep[i] * 1.25) * notTall;
      if (sl > 0.01) {
        const t = tileTone[i];
        let sr = slab[0], sg = slab[1], sb = slab[2];
        if (t > 0) {
          const k = t * 0.7;
          sr = sr * (1 - k) + slabHi[0] * k;
          sg = sg * (1 - k) + slabHi[1] * k;
          sb = sb * (1 - k) + slabHi[2] * k;
        } else if (t < 0) {
          const k = -t * 0.6;
          sr = sr * (1 - k) + slabLo[0] * k;
          sg = sg * (1 - k) + slabLo[1] * k;
          sb = sb * (1 - k) + slabLo[2] * k;
        }
        const wear = dirt[i] * 0.45;
        sr = sr * (1 - wear) + slabHi[0] * wear;
        sg = sg * (1 - wear) + slabHi[1] * wear;
        sb = sb * (1 - wear) + slabHi[2] * wear;
        const fine = 1 + (nFine[i] - 0.5) * 0.06;
        rgb[i * 3] = rgb[i * 3] * (1 - sl) + sr * fine * sl;
        rgb[i * 3 + 1] = rgb[i * 3 + 1] * (1 - sl) + sg * fine * sl;
        rgb[i * 3 + 2] = rgb[i * 3 + 2] * (1 - sl) + sb * fine * sl;
      }
    }
  }

  if (st.ring) {
    // Radial paving ring around small interior pits (oldtown fountain / stonecircle center)
    const visited = new Uint8Array(mapData.nx * mapData.ny);
    const slab = C.slab ?? C.dirt;
    const slabHi = C.slab_hi ?? C.dirt_hi;
    const joint = C.joint ?? C.dirt_lo;
    for (let gy = 0; gy < mapData.ny; gy++) {
      for (let gx = 0; gx < mapData.nx; gx++) {
        const idx = gy * mapData.nx + gx;
        if (mapData.cells[idx] !== CellType.PIT || visited[idx]) continue;
        const q: [number, number][] = [[gx, gy]];
        visited[idx] = 1;
        const comp: [number, number][] = [];
        let border = false;
        while (q.length > 0) {
          const [cx, cy] = q.pop()!;
          comp.push([cx, cy]);
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= mapData.nx || ny >= mapData.ny) {
              border = true;
            } else {
              const ni = ny * mapData.nx + nx;
              if (mapData.cells[ni] === CellType.PIT && !visited[ni]) {
                visited[ni] = 1;
                q.push([nx, ny]);
              }
            }
          }
        }
        if (border || comp.length < 4 || comp.length > 80) continue;
        let sx = 0, sy = 0;
        const pitMask = new Uint8Array(N);
        pitMask.fill(1);
        for (const [cx, cy] of comp) {
          sx += cx + 0.5;
          sy += cy + 0.5;
          const x0p = Math.max(0, Math.floor((cx * cs + MG) * PPM));
          const x1p = Math.min(W - 1, Math.ceil(((cx + 1) * cs + MG) * PPM));
          const y0p = Math.max(0, Math.floor((cy * cs + MG) * PPM));
          const y1p = Math.min(H - 1, Math.ceil(((cy + 1) * cs + MG) * PPM));
          for (let y = y0p; y <= y1p; y++) {
            const row = y * W;
            for (let x = x0p; x <= x1p; x++) pitMask[row + x] = 0;
          }
        }
        const pcx = (sx / comp.length) * cs;
        const pcy = (sy / comp.length) * cs;
        const dPitPx = distanceToZero(pitMask, W, H);
        for (let py = 0; py < H; py++) {
          const my = py / PPM - MG;
          const row = py * W;
          for (let px = 0; px < W; px++) {
            const i = row + px;
            if (!solid[i]) continue;
            const dpit = dPitPx[i] / PPM;
            if (dpit > 1.55) continue;
            const mx = px / PPM - MG;
            const ang = Math.atan2(my - pcy, mx - pcx);
            const band = Math.floor(dpit / 0.42);
            const nseg = 14 + band * 6;
            const tt = (ang / (2 * Math.PI) + 0.5) * nseg + band * 0.5;
            const frR = (dpit / 0.42) % 1;
            const jr = Math.min(frR, 1 - frR) * 0.42;
            const frT = ((tt % 1) + 1) % 1;
            const jt = (Math.min(frT, 1 - frT) / Math.max(1, nseg)) * 2 * Math.PI * (dpit + 1.5);
            const jn = Math.min(jr, jt);
            const zone = smoothstep(dpit, 1.5, 1.25);
            const hsh = Math.sin(Math.floor(tt) * 12.9898 + band * 78.233) * 43758.5453;
            const frac = hsh - Math.floor(hsh);
            const kS = frac * 0.8;
            let rr = slabHi[0] * (1 - kS) + slab[0] * kS;
            let rg = slabHi[1] * (1 - kS) + slab[1] * kS;
            let rb = slabHi[2] * (1 - kS) + slab[2] * kS;
            const kj = (1 - smoothstep(jn, 0.012, 0.036)) * 0.85;
            rr = rr * (1 - kj) + joint[0] * kj;
            rg = rg * (1 - kj) + joint[1] * kj;
            rb = rb * (1 - kj) + joint[2] * kj;
            rgb[i * 3] = rgb[i * 3] * (1 - zone) + rr * zone;
            rgb[i * 3 + 1] = rgb[i * 3 + 1] * (1 - zone) + rg * zone;
            rgb[i * 3 + 2] = rgb[i * 3 + 2] * (1 - zone) + rb * zone;
          }
        }
      }
    }
  }

  if (st.ripples) {
    for (let py = 0; py < H; py++) {
      const my = py / PPM - MG;
      const row = py * W;
      for (let px = 0; px < W; px++) {
        const i = row + px;
        if (!solid[i]) continue;
        const mx = px / PPM - MG;
        const ph = (my + 0.22 * Math.sin(mx * 1.1 + nBig[i] * 5.0) + (nMid[i] - 0.5) * 1.3) * ((2 * Math.PI) / 0.46);
        const sw = Math.sin(ph);
        const amp = smoothstep(nBig[i] * 0.6 + nSm[i] * 0.4, 0.38, 0.6) * (1 - dirt[i] * 0.8) * (1 - smoothstep(tallF[i], 0.2, 0.6));
        mixRgb(i * 3, C.light, smoothstep(sw, 0.35, 0.95) * amp * 0.55);
        mixRgb(i * 3, C.dark, smoothstep(-sw, 0.45, 0.98) * amp * 0.5);
      }
    }
  }

  if (st.strata) {
    const strataCol = C.strata ?? C.dark;
    for (let py = 0; py < H; py++) {
      const row = py * W;
      for (let px = 0; px < W; px++) {
        const i = row + px;
        if (!solid[i]) continue;
        const mx = px / PPM - MG;
        const f = nBig[i] * 3.2 + nMid[i] * 1.1 + mx * 0.05;
        const fr = (((f * 2.2) % 1) + 1) % 1;
        const line = (1 - smoothstep(Math.min(fr, 1 - fr), 0.02, 0.07)) * (1 - dirt[i]);
        mixRgb(i * 3, strataCol, line * 0.6);
        const f2 = (((f * 2.2) % 2) + 2) % 2;
        mixRgb(i * 3, C.light, smoothstep(f2, 0.9, 1.1) * (1 - smoothstep(f2, 1.9, 2.0)) * 0.22 * (1 - dirt[i]));
      }
    }
  }

  let bridges: BridgeSpec[] = [];
  const plankMask = new Uint8Array(N);
  if (st.planks) {
    bridges = detectBridges(mapData, st.planks);
    const wood = st.wood ?? [[178, 120, 78], [150, 98, 66], [206, 146, 96]];
    for (const br of bridges) {
      for (let py = 0; py < H; py++) {
        const my = py / PPM - MG;
        const row = py * W;
        for (let px = 0; px < W; px++) {
          const i = row + px;
          if (!solid[i]) continue;
          const mx = px / PPM - MG;
          const t = (mx - br.bx) * br.ax + (my - br.by) * br.ay;
          const u = (mx - br.bx) * -br.ay + (my - br.by) * br.ax;
          if (Math.abs(t) <= br.hl + 0.22 && Math.abs(u) <= br.hw + 0.16) {
            plankMask[i] = 1;
            const pid = Math.floor(t / 0.3);
            const hsh = Math.sin(pid * 12.9898) * 43758.5453;
            const frac = hsh - Math.floor(hsh);
            let wr = wood[0][0], wg = wood[0][1], wb = wood[0][2];
            const k1 = smoothstep(frac, 0.55, 0.9) * 0.8;
            wr = wr * (1 - k1) + wood[1][0] * k1;
            wg = wg * (1 - k1) + wood[1][1] * k1;
            wb = wb * (1 - k1) + wood[1][2] * k1;
            const k2 = smoothstep(frac, 0.45, 0.1) * 0.7;
            wr = wr * (1 - k2) + wood[2][0] * k2;
            wg = wg * (1 - k2) + wood[2][1] * k2;
            wb = wb * (1 - k2) + wood[2][2] * k2;
            const fr = (((t / 0.3) % 1) + 1) % 1;
            const seam = 1 - 0.45 * (1 - smoothstep(Math.min(fr, 1 - fr), 0.03, 0.09));
            const grain = 1 + 0.06 * Math.sin(u * 60 + pid * 3.1);
            wr *= seam * grain;
            wg *= seam * grain;
            wb *= seam * grain;
            const edge = 1 - smoothstep(dEdgePx[i] / PPM, 0.05, 0.11);
            const ke = edge * 0.85;
            rgb[i * 3] = wr * (1 - ke) + 96 * ke;
            rgb[i * 3 + 1] = wg * (1 - ke) + 62 * ke;
            rgb[i * 3 + 2] = wb * (1 - ke) + 44 * ke;
          }
        }
      }
    }
  }

  // Fine noise modulation
  for (let i = 0; i < N; i++) {
    const f = 1 + (nFine[i] - 0.5) * 0.07;
    rgb[i * 3] = Math.min(255, Math.max(0, rgb[i * 3] * f));
    rgb[i * 3 + 1] = Math.min(255, Math.max(0, rgb[i * 3 + 1] * f));
    rgb[i * 3 + 2] = Math.min(255, Math.max(0, rgb[i * 3 + 2] * f));
  }

  // Write pixel base onto offscreen Canvas2D for crisp painterly overlays (petals, roots, litter, heather, ticks, pebbles)
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const imgData = ctx.createImageData(W, H);
  const data = imgData.data;
  for (let i = 0; i < N; i++) {
    data[i * 4] = rgb[i * 3];
    data[i * 4 + 1] = rgb[i * 3 + 1];
    data[i * 4 + 2] = rgb[i * 3 + 2];
    data[i * 4 + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);

  const area = Wm * Hm;

  // Forest radiating tree roots around wall tiles
  if (st.roots) {
    const rc = C.root ?? [112, 84, 60];
    ctx.strokeStyle = `rgba(${rc[0]},${rc[1]},${rc[2]},0.65)`;
    ctx.lineCap = 'round';
    for (let gy = 0; gy < mapData.ny; gy++) {
      for (let gx = 0; gx < mapData.nx; gx++) {
        if (mapData.cells[gy * mapData.nx + gx] !== CellType.WALL) continue;
        if ((gx + gy) % 2 !== 0) continue;
        const cx = ((gx + 0.5) * cs + MG) * PPM;
        const cy = ((gy + 0.5) * cs + MG) * PPM;
        for (let k = 0; k < 4; k++) {
          let a = rng.uniform(0, 6.28);
          let x = cx + Math.cos(a) * cs * 0.42 * PPM;
          let y = cy + Math.sin(a) * cs * 0.42 * PPM;
          const L = rng.uniform(0.35, 0.72) * PPM;
          for (let j = 0; j < 4; j++) {
            a += rng.normal(0, 0.28);
            const nx = x + Math.cos(a) * (L / 4);
            const ny = y + Math.sin(a) * (L / 4);
            ctx.lineWidth = Math.max(1.2, (0.095 - 0.018 * j) * PPM);
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(nx, ny);
            ctx.stroke();
            x = nx;
            y = ny;
          }
        }
      }
    }
  }

  // Heather clusters
  if (st.heather) {
    const count = Math.round(area * 1.1);
    for (let t = 0; t < count; t++) {
      const px = rng.int(0, W);
      const py = rng.int(0, H);
      const i = py * W + px;
      if (!solid[i] || quiet[i] < 0.35 || dirt[i] > 0.2 || nMid[i] < 0.48) continue;
      const dots = rng.int(8, 18);
      for (let k = 0; k < dots; k++) {
        const ox = rng.normal(0, 0.2 * PPM);
        const oy = rng.normal(0, 0.2 * PPM);
        const r = rng.uniform(0.02, 0.045) * PPM;
        const col = st.heather[rng.int(0, st.heather.length)];
        ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},0.9)`;
        ctx.beginPath();
        ctx.ellipse(px + ox, py + oy, r, r * 1.3, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // Forest autumn leaf litter
  if (st.litter) {
    const count = Math.round(area * 8.5);
    for (let t = 0; t < count; t++) {
      const px = rng.int(0, W);
      const py = rng.int(0, H);
      const i = py * W + px;
      if (!solid[i] || wall[i] || (nSm[i] < 0.5 && rng.next() < 0.7)) continue;
      const a = rng.uniform(0, Math.PI);
      const L = rng.uniform(0.035, 0.06) * PPM;
      const w = rng.uniform(0.014, 0.024) * PPM;
      const col = st.litter[rng.int(0, st.litter.length)];
      const ca = Math.cos(a), sa = Math.sin(a);
      ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${rng.uniform(0.58, 0.92).toFixed(2)})`;
      ctx.beginPath();
      ctx.moveTo(px - ca * L, py - sa * L);
      ctx.lineTo(px - sa * w, py + ca * w);
      ctx.lineTo(px + ca * L, py + sa * L);
      ctx.lineTo(px + sa * w, py - ca * w);
      ctx.closePath();
      ctx.fill();
    }
  }

  // Sakura fallen petals on blossom theme!
  if (st.petals) {
    const count = Math.round(area * 44);
    for (let t = 0; t < count; t++) {
      const px = rng.int(0, W);
      const py = rng.int(0, H);
      const i = py * W + px;
      if (!solid[i] || wall[i]) continue;
      const dens = (0.25 + 0.75 * quiet[i]) * (0.5 + 0.9 * smoothstep(nMid[i], 0.4, 0.7));
      if (rng.next() > dens) continue;
      const a = rng.uniform(0, Math.PI);
      const L = rng.uniform(0.03, 0.056) * PPM;
      const w = rng.uniform(0.018, 0.028) * PPM;
      const col = st.petals[rng.int(0, st.petals.length)];
      const ca = Math.cos(a), sa = Math.sin(a);
      ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${rng.uniform(0.74, 0.98).toFixed(2)})`;
      ctx.beginPath();
      ctx.moveTo(px - ca * L, py - sa * L);
      ctx.lineTo(px - sa * w, py + ca * w);
      ctx.lineTo(px + ca * L, py + sa * L);
      ctx.lineTo(px + sa * w, py - ca * w);
      ctx.closePath();
      ctx.fill();
    }
  }

  // Painterly grass brush ticks & tiny road pebbles
  const nTick = Math.round(area * 14);
  const rgbaStr = (c: [number, number, number, number]) =>
    `rgba(${c[0]},${c[1]},${c[2]},${(c[3] / 255).toFixed(2)})`;
  const tickL = rgbaStr(C.tick_light);
  const tickD = rgbaStr(C.tick_dark);
  const pebA = rgbaStr(C.pebble_a);
  const pebB = rgbaStr(C.pebble_b);
  ctx.lineWidth = 1.4;

  for (let t = 0; t < nTick; t++) {
    const px = rng.int(0, W);
    const py = rng.int(0, H);
    const i = py * W + px;
    if (!solid[i] || wall[i] || plankMask[i]) continue;
    if (st.ticks === 'none' && dirt[i] <= 0.5) {
      if (rng.next() < 0.12) {
        const r = rng.uniform(0.014, 0.028) * PPM;
        ctx.fillStyle = rng.next() < 0.6 ? pebA : pebB;
        ctx.beginPath();
        ctx.ellipse(px, py, r, r * 0.8, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      continue;
    }
    if (dirt[i] > 0.5) {
      if (rng.next() < 0.25) {
        const r = rng.uniform(0.014, 0.03) * PPM;
        ctx.fillStyle = rng.next() < 0.6 ? pebA : pebB;
        ctx.beginPath();
        ctx.ellipse(px, py, r, r * 0.8, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      continue;
    }
    const L = rng.uniform(0.05, 0.11) * PPM;
    const a = rng.normal(-Math.PI * 0.5, 0.5);
    ctx.strokeStyle = rng.next() < 0.5 ? tickL : tickD;
    const blades = rng.next() < 0.5 ? [-0.3, 0, 0.3] : [0];
    for (const s of blades) {
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + Math.cos(a + s) * L, py + Math.sin(a + s) * L);
      ctx.stroke();
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.anisotropy = 4;
  texture.needsUpdate = true;

  return {
    texture,
    mg: MG,
    ppm: PPM,
    widthPx: W,
    heightPx: H,
    dirt,
    quiet,
    bridges,
  };
}
