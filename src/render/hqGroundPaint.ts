import * as THREE from 'three';
import { CellType, EngineMapData } from '../game/types';
import { SeededRng } from './hqGeomBuilder';
import { paintEp12Ground, wantsEp12Ground } from './hqGroundPaint12';
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
  ppm: number; // Aux grid resolution (low-res dirt/quiet masks for prop placement)
  widthPx: number;
  heightPx: number;
  texWidthPx: number;
  texHeightPx: number;
  dirt: Float32Array;
  quiet: Float32Array;
  bridges: BridgeSpec[];
  /** Episode 12 caldera: emissive mask (glowing cracks & lava bank), same UV layout as `texture`. */
  glowTexture?: THREE.CanvasTexture | null;
  /** Episode 12 harbor: per-cell pier deck (0 none, 1 east-west, 2 north-south). */
  deckCells?: Int8Array | null;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function smoothstep(x: number, a: number, b: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

function rgbStr(c: RGB, alpha = 1): string {
  if (alpha >= 0.995) return `rgb(${c[0]},${c[1]},${c[2]})`;
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha.toFixed(2)})`;
}

function mix3(a: RGB, b: RGB, t: number): RGB {
  const u = clamp01(t);
  return [
    Math.round(a[0] + (b[0] - a[0]) * u),
    Math.round(a[1] + (b[1] - a[1]) * u),
    Math.round(a[2] + (b[2] - a[2]) * u),
  ];
}

/** Fast separable box blur (2 passes ≈ Gaussian) on a Float32Array image. */
function blur2D(src: Float32Array, w: number, h: number, radiusPx: number, passes = 2): Float32Array {
  const r = Math.max(1, Math.round(radiusPx));
  const cur = new Float32Array(src);
  const tmp = new Float32Array(w * h);

  for (let p = 0; p < passes; p++) {
    const inv = 1 / (2 * r + 1);
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

/** Fast 2-pass Chamfer Euclidean distance transform (distance in pixels from 0-mask pixels). */
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
      out[rowOut + x] = v00 + (v10 - v00) * sx + (v01 + (v11 - v01) * sx - (v00 + (v10 - v00) * sx)) * sy;
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
      let vSpan = 1;
      for (let d = 1; d <= maxThickCells + 1 && solid(x, y - d); d++) vSpan++;
      for (let d = 1; d <= maxThickCells + 1 && solid(x, y + d); d++) vSpan++;
      let hSpan = 1;
      for (let d = 1; d <= maxThickCells + 1 && solid(x - d, y); d++) hSpan++;
      for (let d = 1; d <= maxThickCells + 1 && solid(x + d, y); d++) hSpan++;

      const horizBridge = vSpan <= maxThickCells && hSpan >= vSpan + 2;
      const vertBridge = hSpan <= maxThickCells && vSpan >= hSpan + 2;
      if (horizBridge || vertBridge) cand[y * nx + x] = horizBridge ? 1 : 2;
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
          const xx = cx + dx, yy = cy + dy;
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
      if (wM >= hM) bridges.push({ bx, by, ax: 1, ay: 0, hl: wM * 0.5, hw: hM * 0.5 });
      else bridges.push({ bx, by, ax: 0, ay: 1, hl: hM * 0.5, hw: wM * 0.5 });
    }
  }
  return bridges;
}

/**
 * Two-resolution crisp procedural ground texture generator (~1800-2048px sharp output in ~35ms!):
 * - Computes smooth spatial fields (grass variation, dirt paths, wall AO, rim highlight) on a fast 24 px/m grid
 * - Upscales smoothly onto a 2K (~80-96 px/m) Canvas2D and paints ALL crisp sharp theme details
 *   (cobblestone slabs & joints, radial fountain bricks, wooden planks & wood grain, sand ripples,
 *   canyon strata & cracks, sakura petals, heather, leaf litter, roots, grass strokes & pebbles)
 *   directly at full 2K resolution with anisotropy = 8 so close-up shots stay razor-sharp!
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

  // Stage 1: Fast low-frequency spatial masks at 24 px/m (~10ms)
  const PPM = 24;
  const W = Math.max(64, Math.round((Wm + 2 * MG) * PPM));
  const H = Math.max(64, Math.round((Hm + 2 * MG) * PPM));
  const N = W * H;

  // Stage 2: High-resolution crisp 2K target canvas (~80-96 px/m, capped at 2048px wide)
  const hiPPM = Math.min(96, Math.max(64, Math.floor(2048 / (Wm + 2 * MG))));
  const TW = Math.round((Wm + 2 * MG) * hiPPM);
  const TH = Math.round((Hm + 2 * MG) * hiPPM);

  const rng = new SeededRng(seed);
  const C = theme.ground;
  const st = theme.gstyle;

  const solid = new Uint8Array(N);
  const wall = new Uint8Array(N);
  const tall = new Uint8Array(N);

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
        if (ct !== CellType.PIT) {
          solid[row + px] = 1;
          if (ct === CellType.WALL) wall[row + px] = 1;
          else if (ct === CellType.GRASS) tall[row + px] = 1;
        }
      }
    }
  }

  const dEdgePx = distanceToZero(solid, W, H);
  const notWall = new Uint8Array(N);
  for (let i = 0; i < N; i++) notWall[i] = wall[i] ? 0 : 1;
  const dWallPx = distanceToZero(notWall, W, H);

  const nBig = valueNoise2D(W, H, 2.2 * PPM, rng);
  const nMid = valueNoise2D(W, H, 0.9 * PPM, rng);
  const nSm = valueNoise2D(W, H, 0.34 * PPM, rng);
  const nFine = valueNoise2D(W, H, 0.14 * PPM, rng);

  // Worn organic dirt paths connecting spawns & arena center hub
  const dirtRaw = new Float32Array(N);
  const stamps: [number, number][] = [];
  if (mapData.spawns && mapData.spawns.length > 0) {
    for (const sp of mapData.spawns) stamps.push([sp[0] / 1000, sp[1] / 1000]);
  } else {
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
        if (dx * dx + dy * dy <= r2 && val > dirtRaw[row + x]) dirtRaw[row + x] = val;
      }
    }
  };

  for (const [sx, sy] of stamps) {
    paintBlob(sx, sy, 0.72, 1.0);
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

  // Paint smooth organic base onto low-res canvas first, then upscale smoothly onto 2K canvas
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
    const df = dirtF[i] * (0.72 + 0.56 * nMid[i]) * (isSolid ? 1 : 0) * (1 - smoothstep(tallF[i], 0.25, 0.65));
    const dVal = smoothstep(df, 0.32, 0.54) * smoothstep(dw, 0.18, 0.48);
    dirt[i] = dVal;
    const qVal = clamp01((1 - dVal) * (1 - smoothstep(df, 0.12, 0.42)) * smoothstep(de, 0.15, 0.55));
    quiet[i] = qVal;

    const idx3 = i * 3;
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

    mixRgb(idx3, C.tall, smoothstep(tallF[i], 0.28, 0.68));
    const ws = wsh[i];
    if (ws > 0.04) {
      mixRgb(idx3, C.dirt_lo, smoothstep(ws, 0.15, 0.6) * smoothstep(nSm[i], 0.5, 0.66) * 0.32);
      const shade = 1 - 0.22 * smoothstep(ws, 0.05, 0.7);
      rgb[idx3] *= shade;
      rgb[idx3 + 1] *= shade;
      rgb[idx3 + 2] *= shade;
    }

    // Smooth island edge bright rim highlight
    const rim = (1 - smoothstep(de, 0.05, 0.22)) * (1 - dVal);
    mixRgb(idx3, C.rim, rim * 0.82);

    // Sand ripples & canyon strata painted cleanly on base
    if (st.ripples && isSolid) {
      const mx = (i % W) / PPM - MG;
      const my = Math.floor(i / W) / PPM - MG;
      const ph = (my + 0.22 * Math.sin(mx * 1.1 + nBig[i] * 5.0) + (nMid[i] - 0.5) * 1.3) * ((2 * Math.PI) / 0.46);
      const sw = Math.sin(ph);
      const amp = smoothstep(nBig[i] * 0.6 + nSm[i] * 0.4, 0.38, 0.6) * (1 - dVal * 0.8) * (1 - smoothstep(tallF[i], 0.2, 0.6));
      mixRgb(idx3, C.light, smoothstep(sw, 0.35, 0.95) * amp * 0.58);
      mixRgb(idx3, C.dark, smoothstep(-sw, 0.45, 0.98) * amp * 0.52);
    }
    if (st.strata && isSolid) {
      const mx = (i % W) / PPM - MG;
      const f = nBig[i] * 3.2 + nMid[i] * 1.1 + mx * 0.05;
      const fr = (((f * 2.2) % 1) + 1) % 1;
      const line = (1 - smoothstep(Math.min(fr, 1 - fr), 0.02, 0.07)) * (1 - dVal);
      mixRgb(idx3, C.strata ?? C.dark, line * 0.62);
      const f2 = (((f * 2.2) % 2) + 2) % 2;
      mixRgb(idx3, C.light, smoothstep(f2, 0.9, 1.1) * (1 - smoothstep(f2, 1.9, 2.0)) * 0.22 * (1 - dVal));
    }

    const fine = 1 + (nFine[i] - 0.5) * 0.07;
    rgb[idx3] = Math.min(255, Math.max(0, rgb[idx3] * fine));
    rgb[idx3 + 1] = Math.min(255, Math.max(0, rgb[idx3 + 1] * fine));
    rgb[idx3 + 2] = Math.min(255, Math.max(0, rgb[idx3 + 2] * fine));
  }

  // Blit smooth low-frequency base onto the high-resolution 2K canvas
  const lowCanvas = document.createElement('canvas');
  lowCanvas.width = W;
  lowCanvas.height = H;
  const lowCtx = lowCanvas.getContext('2d')!;
  const lowImg = lowCtx.createImageData(W, H);
  const ld = lowImg.data;
  for (let i = 0; i < N; i++) {
    ld[i * 4] = rgb[i * 3];
    ld[i * 4 + 1] = rgb[i * 3 + 1];
    ld[i * 4 + 2] = rgb[i * 3 + 2];
    ld[i * 4 + 3] = 255;
  }
  lowCtx.putImageData(lowImg, 0, 0);

  const canvas = document.createElement('canvas');
  canvas.width = TW;
  canvas.height = TH;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(lowCanvas, 0, 0, TW, TH);

  // Helpers mapping world meters (mx, my) -> 2K canvas pixels & querying low-res masks
  const toX = (mx: number) => (mx + MG) * hiPPM;
  const toY = (my: number) => (my + MG) * hiPPM;
  const lowIdxAt = (mx: number, my: number): number => {
    const ix = Math.min(W - 1, Math.max(0, Math.round((mx + MG) * PPM)));
    const iy = Math.min(H - 1, Math.max(0, Math.round((my + MG) * PPM)));
    return iy * W + ix;
  };
  const cellAt = (mx: number, my: number): number => {
    const gx = Math.floor(mx / cs);
    const gy = Math.floor(my / cs);
    if (gx < 0 || gy < 0 || gx >= mapData.nx || gy >= mapData.ny) return CellType.PIT;
    return mapData.cells[gy * mapData.nx + gx];
  };

  // ---- High-Resolution 2K Crisp Theme Vector Layers ----

  // 1. Stone Paving Slabs (`oldtown`, `ruins`) — razor-sharp individual blocks + mortar joints!
  if (st.pave) {
    const slab = C.slab ?? C.dirt;
    const slabHi = C.slab_hi ?? C.dirt_hi;
    const slabLo = C.slab_lo ?? C.dirt_lo;
    const joint = C.joint ?? C.dirt_lo;
    const rowH = 0.5;
    const padPx = Math.max(1.8, 0.024 * hiPPM);

    if (st.pave === 'all') {
      // Subtle mortar base over non-grass floor cells
      for (let gy = 0; gy < mapData.ny; gy++) {
        for (let gx = 0; gx < mapData.nx; gx++) {
          const ct = mapData.cells[gy * mapData.nx + gx];
          if (ct !== CellType.FLOOR && ct !== CellType.WALL) continue;
          const li = lowIdxAt((gx + 0.5) * cs, (gy + 0.5) * cs);
          const alpha = clamp01(1 - 0.78 * quiet[li] * smoothstep(nMid[li], 0.5, 0.7));
          if (alpha > 0.08) {
            ctx.fillStyle = rgbStr(joint, alpha * 0.72);
            ctx.fillRect(toX(gx * cs), toY(gy * cs), cs * hiPPM + 0.5, cs * hiPPM + 0.5);
          }
        }
      }
    }

    for (let yy0 = -MG; yy0 < Hm + MG; yy0 += rowH) {
      let xx0 = -MG - rng.uniform(0, 0.5);
      while (xx0 < Wm + MG) {
        const wd = rng.choice([0.5, 0.5, 0.75, 1.0]);
        const cxm = xx0 + wd * 0.5;
        const cym = yy0 + rowH * 0.5;
        const li = lowIdxAt(cxm, cym);
        let want = 0;
        if (solid[li] && tallF[li] < 0.45) {
          if (st.pave === 'near') {
            const dw = dWallPx[li] / PPM;
            const dc = Math.hypot(cxm - Wm * 0.5, cym - Hm * 0.5);
            want = Math.max(smoothstep(dw, 0.95, 0.4) * 0.85, smoothstep(dc, 1.9, 1.1));
          } else {
            want = 1.0 - 0.72 * quiet[li] * smoothstep(nMid[li], 0.5, 0.7);
          }
        }
        if (want > rng.uniform(0.24, 0.58)) {
          const tone = rng.uniform(-1, 1);
          let col = tone >= 0 ? mix3(slab, slabHi, tone * 0.72) : mix3(slab, slabLo, -tone * 0.62);
          col = mix3(col, slabHi, dirt[li] * 0.42);
          const x = toX(xx0) + padPx;
          const y = toY(yy0) + padPx;
          const w = wd * hiPPM - padPx * 2;
          const h = rowH * hiPPM - padPx * 2;
          if (w > 2 && h > 2) {
            // Crisp dark mortar outline + subtle top-left sunlit stone bevel
            ctx.fillStyle = rgbStr(joint, 0.78);
            ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
            ctx.fillStyle = rgbStr(col);
            ctx.fillRect(x, y, w, h);
            ctx.fillStyle = 'rgba(255,255,255,0.16)';
            ctx.fillRect(x, y, w, Math.max(1.5, h * 0.08));
            ctx.fillStyle = 'rgba(0,0,0,0.09)';
            ctx.fillRect(x, y + h - Math.max(1.5, h * 0.08), w, Math.max(1.5, h * 0.08));
          }
        }
        xx0 += wd;
      }
    }
  }

  // 2. Radial Fountain / Stone-Circle Paving Ring (`oldtown`, `heath`) — razor-sharp radial bricks at 2K!
  if (st.ring) {
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
            if (nx < 0 || ny < 0 || nx >= mapData.nx || ny >= mapData.ny) border = true;
            else {
              const ni = ny * mapData.nx + nx;
              if (mapData.cells[ni] === CellType.PIT && !visited[ni]) {
                visited[ni] = 1;
                q.push([nx, ny]);
              }
            }
          }
        }
        if (border || comp.length < 4 || comp.length > 80) continue;
        let minX = mapData.nx, maxX = 0, minY = mapData.ny, maxY = 0;
        for (const [cx, cy] of comp) {
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;
        }
        const pcx = ((minX + maxX + 1) * cs) * 0.5;
        const pcy = ((minY + maxY + 1) * cs) * 0.5;
        const baseR = Math.max((maxX - minX + 1), (maxY - minY + 1)) * cs * 0.5;
        const cxPx = toX(pcx);
        const cyPx = toY(pcy);

        const nBands = 3;
        const bandW = 0.44;
        ctx.lineWidth = Math.max(1.8, 0.025 * hiPPM);
        ctx.strokeStyle = rgbStr(joint, 0.9);
        for (let b = 0; b < nBands; b++) {
          const r0 = (baseR + b * bandW) * hiPPM;
          const r1 = (baseR + (b + 1) * bandW) * hiPPM;
          const nseg = 16 + b * 6;
          for (let s = 0; s < nseg; s++) {
            const a0 = ((s + b * 0.5) / nseg) * Math.PI * 2;
            const a1 = ((s + 1 + b * 0.5) / nseg) * Math.PI * 2;
            const hsh = Math.sin(s * 12.9898 + b * 78.233) * 43758.5453;
            const frac = hsh - Math.floor(hsh);
            ctx.fillStyle = rgbStr(mix3(slabHi, slab, frac * 0.8));
            ctx.beginPath();
            ctx.arc(cxPx, cyPx, r1, a0, a1);
            ctx.arc(cxPx, cyPx, r0, a1, a0, true);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
          }
        }
      }
    }
  }

  // 3. Canyon Crisp Cracks (`canyon`)
  if (st.strata) {
    const area = Wm * Hm;
    ctx.strokeStyle = rgbStr(C.strata ?? C.dark, 0.55);
    ctx.lineWidth = Math.max(1.2, 0.02 * hiPPM);
    ctx.lineCap = 'round';
    const nCracks = Math.round(area * 0.35);
    for (let t = 0; t < nCracks; t++) {
      let mx = rng.uniform(0, Wm);
      let my = rng.uniform(0, Hm);
      if (cellAt(mx, my) !== CellType.FLOOR) continue;
      let a = rng.uniform(0, Math.PI * 2);
      ctx.beginPath();
      ctx.moveTo(toX(mx), toY(my));
      const segs = rng.int(3, 7);
      for (let k = 0; k < segs; k++) {
        a += rng.normal(0, 0.6);
        mx += Math.cos(a) * 0.16;
        my += Math.sin(a) * 0.16;
        ctx.lineTo(toX(mx), toY(my));
      }
      ctx.stroke();
    }
  }

  // 4. Wooden Bridge Planks (`sunset`, `canyon`) — razor-sharp individual timber planks + wood grain + side beams!
  let bridges: BridgeSpec[] = [];
  if (st.planks) {
    bridges = detectBridges(mapData, st.planks);
    const wood = st.wood ?? [[178, 120, 78], [150, 98, 66], [206, 146, 96]];
    const beamCol: RGB = [96, 62, 44];
    for (const br of bridges) {
      ctx.save();
      ctx.translate(toX(br.bx), toY(br.by));
      ctx.rotate(Math.atan2(br.ay, br.ax));
      const hlPx = (br.hl + 0.12) * hiPPM;
      const hwPx = (br.hw + 0.02) * hiPPM;
      const plankW = 0.28 * hiPPM;
      const seamPx = Math.max(1.8, 0.022 * hiPPM);

      // Dark under-seam backdrop
      ctx.fillStyle = 'rgb(68,42,28)';
      ctx.fillRect(-hlPx, -hwPx, hlPx * 2, hwPx * 2);

      let pid = 0;
      for (let tx = -hlPx; tx < hlPx; tx += plankW) {
        const w = Math.min(plankW - seamPx, hlPx - tx);
        if (w <= 1) continue;
        const hsh = Math.sin(pid * 12.9898 + 3.1) * 43758.5453;
        const frac = hsh - Math.floor(hsh);
        let col = wood[0];
        if (frac > 0.55) col = mix3(wood[0], wood[1], (frac - 0.55) / 0.45 * 0.85);
        else if (frac < 0.45) col = mix3(wood[0], wood[2], (0.45 - frac) / 0.45 * 0.75);
        ctx.fillStyle = rgbStr(col);
        ctx.fillRect(tx, -hwPx, w, hwPx * 2);
        // Crisp fine wood grain streaks
        ctx.strokeStyle = 'rgba(72,42,24,0.16)';
        ctx.lineWidth = Math.max(1, 0.012 * hiPPM);
        for (let g = -3; g <= 3; g++) {
          const gy = (g / 3.5) * hwPx * 0.85;
          ctx.beginPath();
          ctx.moveTo(tx + 1, gy);
          ctx.lineTo(tx + w - 1, gy + Math.sin(pid + g) * 2.5);
          ctx.stroke();
        }
        pid++;
      }
      // Side timber edge beams
      const beamH = Math.max(4, 0.08 * hiPPM);
      ctx.fillStyle = rgbStr(beamCol);
      ctx.fillRect(-hlPx, -hwPx, hlPx * 2, beamH);
      ctx.fillRect(-hlPx, hwPx - beamH, hlPx * 2, beamH);
      ctx.restore();
    }
  }

  const area = Wm * Hm;

  // 5. Forest Radiating Tree Roots (`forest`) at 2K
  if (st.roots) {
    const rc = C.root ?? [112, 84, 60];
    ctx.strokeStyle = rgbStr(rc, 0.68);
    ctx.lineCap = 'round';
    for (let gy = 0; gy < mapData.ny; gy++) {
      for (let gx = 0; gx < mapData.nx; gx++) {
        if (mapData.cells[gy * mapData.nx + gx] !== CellType.WALL) continue;
        if ((gx + gy) % 2 !== 0) continue;
        const cx = toX((gx + 0.5) * cs);
        const cy = toY((gy + 0.5) * cs);
        for (let k = 0; k < 4; k++) {
          let a = rng.uniform(0, 6.28);
          let x = cx + Math.cos(a) * cs * 0.42 * hiPPM;
          let y = cy + Math.sin(a) * cs * 0.42 * hiPPM;
          const L = rng.uniform(0.35, 0.72) * hiPPM;
          for (let j = 0; j < 4; j++) {
            a += rng.normal(0, 0.28);
            const nx = x + Math.cos(a) * (L / 4);
            const ny = y + Math.sin(a) * (L / 4);
            ctx.lineWidth = Math.max(2, (0.095 - 0.018 * j) * hiPPM);
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

  // 6. Heather Blooms (`heath`) at 2K
  if (st.heather) {
    const count = Math.round(area * 1.1);
    for (let t = 0; t < count; t++) {
      const mx = rng.uniform(0, Wm);
      const my = rng.uniform(0, Hm);
      const li = lowIdxAt(mx, my);
      if (!solid[li] || quiet[li] < 0.35 || dirt[li] > 0.2 || nMid[li] < 0.48) continue;
      const px = toX(mx), py = toY(my);
      const dots = rng.int(8, 18);
      for (let k = 0; k < dots; k++) {
        const ox = rng.normal(0, 0.2 * hiPPM);
        const oy = rng.normal(0, 0.2 * hiPPM);
        const r = rng.uniform(0.02, 0.044) * hiPPM;
        ctx.fillStyle = rgbStr(st.heather[rng.int(0, st.heather.length)], 0.9);
        ctx.beginPath();
        ctx.ellipse(px + ox, py + oy, r, r * 1.3, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // 7. Forest Fallen Autumn Litter (`forest`) at 2K
  if (st.litter) {
    const count = Math.round(area * 8.5);
    for (let t = 0; t < count; t++) {
      const mx = rng.uniform(0, Wm);
      const my = rng.uniform(0, Hm);
      const li = lowIdxAt(mx, my);
      if (!solid[li] || wall[li] || (nSm[li] < 0.5 && rng.next() < 0.7)) continue;
      const px = toX(mx), py = toY(my);
      const a = rng.uniform(0, Math.PI);
      const L = rng.uniform(0.035, 0.06) * hiPPM;
      const w = rng.uniform(0.014, 0.024) * hiPPM;
      const ca = Math.cos(a), sa = Math.sin(a);
      ctx.fillStyle = rgbStr(st.litter[rng.int(0, st.litter.length)], rng.uniform(0.6, 0.92));
      ctx.beginPath();
      ctx.moveTo(px - ca * L, py - sa * L);
      ctx.lineTo(px - sa * w, py + ca * w);
      ctx.lineTo(px + ca * L, py + sa * L);
      ctx.lineTo(px + sa * w, py - ca * w);
      ctx.closePath();
      ctx.fill();
    }
  }

  // 8. Sakura Petals (`blossom`) — crisp sharp petals at 2K!
  if (st.petals) {
    const count = Math.round(area * 44);
    for (let t = 0; t < count; t++) {
      const mx = rng.uniform(0, Wm);
      const my = rng.uniform(0, Hm);
      const li = lowIdxAt(mx, my);
      if (!solid[li] || wall[li]) continue;
      const dens = (0.25 + 0.75 * quiet[li]) * (0.5 + 0.9 * smoothstep(nMid[li], 0.4, 0.7));
      if (rng.next() > dens) continue;
      const px = toX(mx), py = toY(my);
      const a = rng.uniform(0, Math.PI);
      const L = rng.uniform(0.03, 0.056) * hiPPM;
      const w = rng.uniform(0.018, 0.028) * hiPPM;
      const ca = Math.cos(a), sa = Math.sin(a);
      ctx.fillStyle = rgbStr(st.petals[rng.int(0, st.petals.length)], rng.uniform(0.76, 0.98));
      ctx.beginPath();
      ctx.moveTo(px - ca * L, py - sa * L);
      ctx.lineTo(px - sa * w, py + ca * w);
      ctx.lineTo(px + ca * L, py + sa * L);
      ctx.lineTo(px + sa * w, py - ca * w);
      ctx.closePath();
      ctx.fill();
    }
  }

  // Episode 12 layers (caldera ash, harbor piers, keeps castle floors) — own RNG, only for those themes
  const ep12 = wantsEp12Ground(theme)
    ? paintEp12Ground({
        mapData,
        theme,
        ctx,
        TW,
        TH,
        hiPPM,
        MG,
        W,
        H,
        PPM,
        tallF,
        dirt,
        nBig,
        nMid,
        nSm,
        nFine,
        seed,
      })
    : null;
  const notick = ep12?.notick ?? null;

  // 9. Crisp Painterly Grass Strokes & Road Pebbles at 2K!
  const nTick = Math.round(area * 15);
  const rgbaStr = (c: [number, number, number, number]) =>
    `rgba(${c[0]},${c[1]},${c[2]},${(c[3] / 255).toFixed(2)})`;
  const tickL = rgbaStr(C.tick_light);
  const tickD = rgbaStr(C.tick_dark);
  const pebA = rgbaStr(C.pebble_a);
  const pebB = rgbaStr(C.pebble_b);
  ctx.lineWidth = Math.max(1.5, 0.018 * hiPPM);
  ctx.lineCap = 'round';

  for (let t = 0; t < nTick; t++) {
    const mx = rng.uniform(0, Wm);
    const my = rng.uniform(0, Hm);
    const li = lowIdxAt(mx, my);
    if (!solid[li] || wall[li]) continue;
    if (notick && notick[li]) continue;
    const px = toX(mx), py = toY(my);
    if (st.ticks === 'none' && dirt[li] <= 0.5) {
      if (rng.next() < 0.14) {
        const r = rng.uniform(0.014, 0.028) * hiPPM;
        ctx.fillStyle = rng.next() < 0.6 ? pebA : pebB;
        ctx.beginPath();
        ctx.ellipse(px, py, r, r * 0.8, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      continue;
    }
    if (dirt[li] > 0.5) {
      if (rng.next() < 0.25) {
        const r = rng.uniform(0.014, 0.03) * hiPPM;
        ctx.fillStyle = rng.next() < 0.6 ? pebA : pebB;
        ctx.beginPath();
        ctx.ellipse(px, py, r, r * 0.8, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      continue;
    }
    const L = rng.uniform(0.055, 0.115) * hiPPM;
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
  texture.anisotropy = 8;
  texture.needsUpdate = true;

  return {
    texture,
    mg: MG,
    ppm: PPM,
    widthPx: W,
    heightPx: H,
    texWidthPx: TW,
    texHeightPx: TH,
    dirt,
    quiet,
    bridges,
    glowTexture: ep12?.glowTexture ?? null,
    deckCells: ep12?.deckCells ?? null,
  };
}
