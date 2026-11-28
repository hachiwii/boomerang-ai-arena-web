import * as THREE from 'three';
import { CellType, EngineMapData } from '../game/types';
import { HqLiquidSpec } from './hqThemes';

/**
 * Episode 12 liquid surfaces in pits (lava lake, harbour sea, castle ponds), ported from upstream
 * `liquid.py`, `liquid_drain.py` and `env.py build_liquid / set_liquids`, plus `scene_lib.mat_lava / mat_sea`.
 *
 * - Which cells carry liquid: pits enclosed by land that don't touch the map border (`where = enclosed`).
 * - Drain rule: every liquid cell follows the nearest bank (the latest-collapsing one when several touch it); lake
 *   centres follow the earliest neighbour, so a lake drains ring by ring as its banks fall. A group disappears
 *   (sinks 0.6 m over 10 steps) 4 steps after its wave collapses; meanwhile a molten / water curtain pours over every
 *   edge whose neighbour collapsed first.
 * - Rendering: the whole surface is ONE mesh (subdivided 4x per cell, padded under the banks) and every curtain is
 *   ONE more mesh; per-vertex drain steps + a game-time uniform hide / sink the right parts in the vertex shader,
 *   so collapsing costs no CPU and no extra draw calls.
 */

export const LIQUID_DRAIN_DELAY = 4.0;

/** Liquid flag per cell (`liquid.cells`): enclosed pit components of at least `minCells` cells. */
export function computeLiquidCells(mapData: EngineMapData, spec: HqLiquidSpec | null): Uint8Array {
  const { nx, ny, cells } = mapData;
  const out = new Uint8Array(nx * ny);
  if (!spec) return out;
  const seen = new Uint8Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const i0 = y * nx + x;
      if (cells[i0] !== CellType.PIT || seen[i0]) continue;
      const st = [i0];
      const comp: number[] = [];
      let border = false;
      seen[i0] = 1;
      while (st.length) {
        const q = st.pop()!;
        comp.push(q);
        const qx = q % nx;
        const qy = (q / nx) | 0;
        for (const [dx, dy] of NB4) {
          const rx = qx + dx;
          const ry = qy + dy;
          if (rx < 0 || ry < 0 || rx >= nx || ry >= ny) {
            border = true;
            continue;
          }
          const r = ry * nx + rx;
          if (cells[r] === CellType.PIT && !seen[r]) {
            seen[r] = 1;
            st.push(r);
          }
        }
      }
      if (spec.where === 'enclosed' && border) continue;
      if (comp.length < spec.minCells) continue;
      for (const q of comp) out[q] = 1;
    }
  }
  return out;
}

const NB4: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * `liquid_drain.cell_waves`: the collapse wave that decides when each liquid cell disappears (-1 = never).
 */
export function computeLiquidCellWaves(mapData: EngineMapData, liq: Uint8Array): Int32Array {
  const { nx, ny, cells, waves, waveSteps } = mapData;
  const N = nx * ny;
  const INF = 1e9;
  const out = new Int32Array(N).fill(-1);
  const landWave = (i: number) => {
    const w = waves[i];
    return w >= 0 && w < waveSteps.length ? w : INF;
  };
  const isLand = (x: number, y: number) => x >= 0 && y >= 0 && x < nx && y < ny && !liq[y * nx + x] && cells[y * nx + x] !== CellType.PIT;
  const tval = new Float64Array(N).fill(NaN);
  const has = (i: number) => !Number.isNaN(tval[i]);
  // Cells touching land (8-neighbourhood) follow the latest-collapsing bank around them
  const frontier0: number[] = [];
  for (let i = 0; i < N; i++) {
    if (!liq[i]) continue;
    const x = i % nx;
    const y = (i / nx) | 0;
    let best = -1;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if ((dx || dy) && isLand(x + dx, y + dy)) best = Math.max(best, landWave((y + dy) * nx + x + dx));
      }
    }
    if (best >= 0) {
      tval[i] = best;
      frontier0.push(i);
    }
  }
  // Lake centres follow the earliest-draining neighbour (once the lake has an opening, its middle drains)
  let frontier = frontier0;
  while (frontier.length) {
    const nxt = new Map<number, number>();
    for (const c of frontier) {
      const cx = c % nx;
      const cy = (c / nx) | 0;
      for (const [dx, dy] of NB4) {
        const qx = cx + dx;
        const qy = cy + dy;
        if (qx < 0 || qy < 0 || qx >= nx || qy >= ny) continue;
        const q = qy * nx + qx;
        if (!liq[q] || has(q)) continue;
        nxt.set(q, Math.min(nxt.get(q) ?? INF + 1, tval[c]));
      }
    }
    for (const [q, v] of nxt) tval[q] = v;
    frontier = [...nxt.keys()];
  }
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 10000) {
    changed = false;
    for (let c = 0; c < N; c++) {
      if (!liq[c] || !has(c)) continue;
      const cx = c % nx;
      const cy = (c / nx) | 0;
      let rim = false;
      for (let dy = -1; dy <= 1 && !rim; dy++) for (let dx = -1; dx <= 1 && !rim; dx++) if (isLand(cx + dx, cy + dy)) rim = true;
      if (rim) continue;
      let m = Infinity;
      for (const [dx, dy] of NB4) {
        const qx = cx + dx;
        const qy = cy + dy;
        if (qx < 0 || qy < 0 || qx >= nx || qy >= ny) continue;
        const q = qy * nx + qx;
        if (liq[q] && has(q)) m = Math.min(m, tval[q]);
      }
      if (m < tval[c]) {
        tval[c] = m;
        changed = true;
      }
    }
  }
  for (let i = 0; i < N; i++) {
    if (!liq[i]) continue;
    const v = has(i) ? tval[i] : INF;
    out[i] = v >= INF ? -1 : v;
  }
  return out;
}

/** 3-4 chamfer distance (in lattice steps) from every `inside` point to the nearest outside point. */
function chamfer(inside: Uint8Array, W: number, H: number): Float32Array {
  const INF = 1e6;
  const d = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) d[i] = inside[i] ? INF : 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!d[i]) continue;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 3);
      if (y > 0) {
        v = Math.min(v, d[i - W] + 3);
        if (x > 0) v = Math.min(v, d[i - W - 1] + 4);
        if (x < W - 1) v = Math.min(v, d[i - W + 1] + 4);
      }
      d[i] = v;
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      if (!d[i]) continue;
      let v = d[i];
      if (x < W - 1) v = Math.min(v, d[i + 1] + 3);
      if (y < H - 1) {
        v = Math.min(v, d[i + W] + 3);
        if (x < W - 1) v = Math.min(v, d[i + W + 1] + 4);
        if (x > 0) v = Math.min(v, d[i + W - 1] + 4);
      }
      d[i] = v;
    }
  }
  for (let i = 0; i < W * H; i++) d[i] /= 3;
  return d;
}

// ------------------------------------------------------------------ shaders
const NOISE_GLSL = /* glsl */ `
  float lqHash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  vec3 lqGrad(vec3 i) {
    float h = lqHash(i) * 6.2831853;
    float z = lqHash(i + vec3(19.19, 7.31, 3.17)) * 2.0 - 1.0;
    float r = sqrt(max(0.0, 1.0 - z * z));
    return vec3(r * cos(h), r * sin(h), z);
  }
  // Gradient (Perlin-style) noise in ~[-1, 1]: smooth, no value-noise blockiness
  float lqNoise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float n000 = dot(lqGrad(i), f);
    float n100 = dot(lqGrad(i + vec3(1.0, 0.0, 0.0)), f - vec3(1.0, 0.0, 0.0));
    float n010 = dot(lqGrad(i + vec3(0.0, 1.0, 0.0)), f - vec3(0.0, 1.0, 0.0));
    float n110 = dot(lqGrad(i + vec3(1.0, 1.0, 0.0)), f - vec3(1.0, 1.0, 0.0));
    float n001 = dot(lqGrad(i + vec3(0.0, 0.0, 1.0)), f - vec3(0.0, 0.0, 1.0));
    float n101 = dot(lqGrad(i + vec3(1.0, 0.0, 1.0)), f - vec3(1.0, 0.0, 1.0));
    float n011 = dot(lqGrad(i + vec3(0.0, 1.0, 1.0)), f - vec3(0.0, 1.0, 1.0));
    float n111 = dot(lqGrad(i + vec3(1.0, 1.0, 1.0)), f - vec3(1.0, 1.0, 1.0));
    return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
  }
  // Blender-style fBm noise texture (scale, detail octaves, roughness), remapped to ~0..1 around 0.5
  float lqFbm(vec2 p, float w, float scale, int oct, float rough) {
    vec3 q = vec3(p * scale, w);
    float a = 1.0;
    float s = 0.0;
    float n = 0.0;
    for (int k = 0; k < 4; k++) {
      if (k >= oct) break;
      s += a * lqNoise(q);
      n += a;
      a *= rough;
      q = q * 2.02 + vec3(17.1, 9.3, 3.7);
    }
    return 0.5 + 0.75 * s / n;
  }
`;

const SHEET_VERT = /* glsl */ `
  attribute float aGone;
  attribute float aWave;
  attribute vec4 aCol;
  uniform float uGt;
  uniform float uFreeze;
  varying vec2 vXZ;
  varying vec4 vCol;
  void main() {
    vec3 p = position;
    if (aGone >= 0.0 && aWave <= uFreeze) {
      float u = (uGt - aGone) / 10.0;
      if (u >= 1.0) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        return;
      }
      if (u > 0.0) p.y -= 0.6 * u * u;
    }
    vXZ = vec2(position.x, -position.z);
    vCol = aCol;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const LAVA_FRAG = /* glsl */ `
  uniform float uTime;
  varying vec2 vXZ;
  varying vec4 vCol;
  ${NOISE_GLSL}
  vec3 lqHex(float r, float g, float b) { return pow(vec3(r, g, b) / 255.0, vec3(2.2)); }
  // Bubbles: one feature point per cell that swells and pops on its own cycle (like a 4D Voronoi slice moving in time)
  float lqBubbles(vec2 p, float t) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float b = 0.0;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 g = vec2(float(x), float(y));
        vec3 c = vec3(i + g, 1.3);
        vec2 o = vec2(lqHash(c), lqHash(c + 5.1)) * 0.8 + 0.1;
        float ph = fract(t * (0.25 + 0.2 * lqHash(c + 2.7)) + lqHash(c + 9.4));
        float life = smoothstep(0.0, 0.25, ph) * (1.0 - smoothstep(0.55, 0.62, ph));
        float r = 0.05 + 0.11 * ph;
        float d = length(g + o - f);
        b = max(b, (1.0 - smoothstep(r * 0.55, r, d)) * life);
      }
    }
    return b;
  }
  void main() {
    float t = uTime;
    vec2 v = vXZ + vec2(0.035, 0.02) * t;
    float edge = vCol.a;
    float n1 = lqFbm(v, t * 0.05, 0.7, 3, 0.55);
    float n2 = lqFbm(v, t * 0.09, 2.6, 2, 0.5);
    float f = n1 * 0.62 + n2 * 0.38;
    float crust = smoothstep(0.47, 0.57, f) * clamp(1.0 - smoothstep(0.55, 0.95, edge), 0.0, 1.0);
    float hot = smoothstep(0.45, 0.7, n2);
    vec3 bright = mix(lqHex(242.0, 64.0, 14.0), lqHex(255.0, 138.0, 34.0), hot);
    bright = mix(bright, lqHex(255.0, 184.0, 72.0), smoothstep(0.7, 1.0, edge) * 0.7);
    float bub = lqBubbles(vXZ * 2.2, t) * smoothstep(0.35, 0.55, n1) * (1.0 - crust * 0.7);
    vec3 em = mix(bright, lqHex(42.0, 20.0, 24.0), crust);
    em = mix(em, lqHex(255.0, 210.0, 122.0), bub);
    vec3 base = mix(lqHex(255.0, 122.0, 42.0), lqHex(62.0, 44.0, 56.0), crust);
    float strength = (1.0 - crust) * 0.85 + 0.3;
    // Lit diffuse part (crust catches the sun & sky) + emission, like the upstream principled + emission mix
    vec3 col = base * (0.25 + 0.55 * crust) + em * strength;
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const SEA_FRAG = /* glsl */ `
  uniform float uTime;
  varying vec2 vXZ;
  varying vec4 vCol;
  ${NOISE_GLSL}
  vec3 lqHex(float r, float g, float b) { return pow(vec3(r, g, b) / 255.0, vec3(2.2)); }
  void main() {
    float t = uTime;
    vec2 v = vXZ + vec2(0.05, -0.03) * t;
    float edge = vCol.a;
    vec3 col = vCol.rgb;
    float n1 = lqFbm(v * vec2(1.0, 2.2), t * 0.12, 1.6, 2, 0.5);
    float n2 = lqFbm(v, t * 0.2, 4.0, 1, 0.5);
    float glint = smoothstep(0.58, 0.64, n1) * (1.0 - smoothstep(0.66, 0.72, n1));
    col = mix(col, lqHex(189.0, 242.0, 244.0), glint * 0.55);
    col = mix(col, lqHex(30.0, 111.0, 168.0), smoothstep(0.45, 0.7, n2) * 0.12);
    float foam = smoothstep(0.72, 0.92, edge) * smoothstep(0.32, 0.5, n2) + smoothstep(0.93, 0.99, edge);
    col = mix(col, lqHex(244.0, 252.0, 255.0), min(foam, 1.0));
    gl_FragColor = vec4(col * 0.98, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const CURTAIN_VERT = /* glsl */ `
  attribute float aFrom;
  attribute float aFromWave;
  attribute float aTo;
  attribute float aToWave;
  attribute vec4 aCol;
  uniform float uGt;
  uniform float uFreeze;
  varying vec4 vCol;
  varying vec2 vUv2;
  void main() {
    bool fromGone = aFrom >= 0.0 && aFromWave <= uFreeze && uGt >= aFrom;
    bool toGone = aTo >= 0.0 && aToWave <= uFreeze && uGt >= aTo + 3.0;
    if (!fromGone || toGone) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    vCol = aCol;
    vUv2 = vec2(position.x + position.z, position.y);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const CURTAIN_FRAG = /* glsl */ `
  uniform float uTime;
  varying vec4 vCol;
  varying vec2 vUv2;
  ${NOISE_GLSL}
  void main() {
    float n = 0.5 + 0.6 * lqNoise(vec3(vUv2.x * 3.0, (vUv2.y + uTime * 1.6) * 0.55 * 3.0, 0.5));
    float flow = smoothstep(0.36, 0.64, n) * 0.6 + 0.4;
    gl_FragColor = vec4(vCol.rgb, vCol.a * flow);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function linHex(hex: string): [number, number, number] {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

export class LiquidSurface {
  public readonly root = new THREE.Group();
  public readonly spec: HqLiquidSpec;
  public readonly cells: Uint8Array;
  public readonly cellWave: Int32Array;
  private readonly mapData: EngineMapData;
  private readonly sheetMat: THREE.ShaderMaterial | null = null;
  private readonly curtainMat: THREE.ShaderMaterial | null = null;
  private readonly geos: THREE.BufferGeometry[] = [];

  constructor(mapData: EngineMapData, spec: HqLiquidSpec) {
    this.mapData = mapData;
    this.spec = spec;
    this.cells = computeLiquidCells(mapData, spec);
    this.cellWave = computeLiquidCellWaves(mapData, this.cells);
    let any = false;
    for (let i = 0; i < this.cells.length; i++) if (this.cells[i]) any = true;
    if (!any) return;
    this.sheetMat = new THREE.ShaderMaterial({
      uniforms: { uGt: { value: 0 }, uFreeze: { value: 1e9 }, uTime: { value: 0 } },
      vertexShader: SHEET_VERT,
      fragmentShader: spec.kind === 'lava' ? LAVA_FRAG : SEA_FRAG,
    });
    this.curtainMat = new THREE.ShaderMaterial({
      uniforms: { uGt: { value: 0 }, uFreeze: { value: 1e9 }, uTime: { value: 0 } },
      vertexShader: CURTAIN_VERT,
      fragmentShader: CURTAIN_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.buildSheet();
    this.buildCurtains();
  }

  private goneStep(w: number): number {
    return w >= 0 && w < this.mapData.waveSteps.length ? this.mapData.waveSteps[w] + LIQUID_DRAIN_DELAY : -1;
  }

  private waveStep(w: number): number {
    return w >= 0 && w < this.mapData.waveSteps.length ? this.mapData.waveSteps[w] : -1;
  }

  private buildSheet() {
    const { nx, ny, cell } = this.mapData;
    const cs = cell / 1000;
    const up = 4;
    const q = cs / up;
    const W = nx * up;
    const H = ny * up;
    const L = new Uint8Array(W * H);
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        if (!this.cells[y * nx + x]) continue;
        for (let i = 0; i < up; i++) for (let j = 0; j < up; j++) L[(y * up + i) * W + x * up + j] = 1;
      }
    }
    // Lattice points whose four surrounding sub-cells are all liquid
    const VW = W + 1;
    const VH = H + 1;
    const vin = new Uint8Array(VW * VH);
    for (let i = 1; i < VH - 1; i++) {
      for (let j = 1; j < VW - 1; j++) {
        vin[i * VW + j] = L[(i - 1) * W + j - 1] & L[i * W + j - 1] & L[(i - 1) * W + j] & L[i * W + j];
      }
    }
    const dv = chamfer(vin, VW, VH);
    const isLava = this.spec.kind === 'lava';
    const shallow = linHex('#4FCFD6');
    const deep = linHex('#2A86C8');
    const z = this.spec.z;
    const pad = Math.max(1, Math.ceil(0.15 / q));

    // Group sub-cells by their drain wave
    const groups = new Map<number, number[]>();
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const c = y * nx + x;
        if (!this.cells[c]) continue;
        const w = this.cellWave[c];
        let arr = groups.get(w);
        if (!arr) groups.set(w, (arr = []));
        arr.push(c);
      }
    }
    const pos: number[] = [];
    const col: number[] = [];
    const gone: number[] = [];
    const wav: number[] = [];
    const idx: number[] = [];
    for (const [w, gcells] of groups) {
      const G = new Uint8Array(W * H);
      for (const c of gcells) {
        const x = c % nx;
        const y = (c / nx) | 0;
        for (let i = 0; i < up; i++) for (let j = 0; j < up; j++) G[(y * up + i) * W + x * up + j] = 1;
      }
      let D = G;
      for (let k = 0; k < pad; k++) {
        const E = D.slice();
        for (let i = 0; i < H; i++) {
          for (let j = 0; j < W; j++) {
            if (D[i * W + j]) continue;
            if ((i > 0 && D[(i - 1) * W + j]) || (i < H - 1 && D[(i + 1) * W + j]) || (j > 0 && D[i * W + j - 1]) || (j < W - 1 && D[i * W + j + 1])) {
              E[i * W + j] = 1;
            }
          }
        }
        D = E;
      }
      const gStep = this.goneStep(w);
      const wStep = this.waveStep(w);
      const vmap = new Map<number, number>();
      const vid = (i: number, j: number) => {
        const key = i * VW + j;
        let v = vmap.get(key);
        if (v !== undefined) return v;
        v = pos.length / 3;
        vmap.set(key, v);
        pos.push(j * q, z, i * q);
        const d = dv[key] * q;
        const edge = Math.max(0, Math.min(1, 1 - d / 0.7));
        if (isLava) col.push(1, 1, 1, edge);
        else {
          const t = Math.max(0, Math.min(1, d / 1.3));
          col.push(shallow[0] + (deep[0] - shallow[0]) * t, shallow[1] + (deep[1] - shallow[1]) * t, shallow[2] + (deep[2] - shallow[2]) * t, edge);
        }
        gone.push(gStep);
        wav.push(wStep);
        return v;
      };
      for (let i = 0; i < H; i++) {
        for (let j = 0; j < W; j++) {
          const k = i * W + j;
          if (!D[k] || (L[k] && !G[k])) continue;
          const a = vid(i, j);
          const b = vid(i + 1, j);
          const c = vid(i + 1, j + 1);
          const d = vid(i, j + 1);
          idx.push(a, b, c, a, c, d);
        }
      }
    }
    if (!idx.length || !this.sheetMat) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aCol', new THREE.Float32BufferAttribute(col, 4));
    geo.setAttribute('aGone', new THREE.Float32BufferAttribute(gone, 1));
    geo.setAttribute('aWave', new THREE.Float32BufferAttribute(wav, 1));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    this.geos.push(geo);
    const mesh = new THREE.Mesh(geo, this.sheetMat);
    mesh.name = 'liquid_sheet';
    mesh.frustumCulled = false;
    this.root.add(mesh);
  }

  private buildCurtains() {
    const { nx, ny, cell, cells, waves, waveSteps } = this.mapData;
    const cs = cell / 1000;
    const z = this.spec.z;
    const cols = this.spec.kind === 'lava' ? [linHex('#FF9A2E'), linHex('#E2481A')] : [linHex('#EAF6FF'), linHex('#BFE2F5')];
    const landWave = (i: number) => (waves[i] >= 0 && waves[i] < waveSteps.length ? waves[i] : -1);
    const pos: number[] = [];
    const col: number[] = [];
    const aFrom: number[] = [];
    const aFromWave: number[] = [];
    const aTo: number[] = [];
    const aToWave: number[] = [];
    const idx: number[] = [];
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const c = y * nx + x;
        if (!this.cells[c]) continue;
        const wc = this.cellWave[c];
        for (const [dx, dy] of NB4) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= nx || yy >= ny) continue;
          const n = yy * nx + xx;
          let wn: number;
          if (this.cells[n]) wn = this.cellWave[n];
          else if (cells[n] !== CellType.PIT) wn = landWave(n);
          else continue;
          if (wn < 0 || (wc >= 0 && wn >= wc)) continue;
          // Edge endpoints in map metres + outward direction (dx, dy)
          let ax: number, ay: number, bx: number, by: number;
          if (dx) {
            const ex = (x + (dx > 0 ? 1 : 0)) * cs;
            ax = ex;
            ay = y * cs;
            bx = ex;
            by = (y + 1) * cs;
          } else {
            const ey = (y + (dy > 0 ? 1 : 0)) * cs;
            ax = x * cs;
            ay = ey;
            bx = (x + 1) * cs;
            by = ey;
          }
          const fromG = wn >= 0 ? waveSteps[wn] + LIQUID_DRAIN_DELAY : -1;
          const toG = wc >= 0 ? waveSteps[wc] + LIQUID_DRAIN_DELAY : -1;
          const base = pos.length / 3;
          const rows = 9;
          for (let i = 0; i < rows; i++) {
            const t = i / (rows - 1);
            const out = 0.03 + 0.55 * Math.pow(t, 1.4);
            const zz = z + 0.01 - 5.0 * Math.pow(t, 1.15);
            const al = 0.95 * Math.pow(1 - t, 0.8);
            for (let k = 0; k < 2; k++) {
              const px = (k ? bx : ax) + dx * out;
              const py = (k ? by : ay) + dy * out;
              pos.push(px, zz, py);
              const cc = cols[(i + k) % 2];
              col.push(cc[0], cc[1], cc[2], al);
              aFrom.push(fromG);
              aFromWave.push(wn >= 0 ? waveSteps[wn] : -1);
              aTo.push(toG);
              aToWave.push(wc >= 0 ? waveSteps[wc] : -1);
            }
          }
          for (let i = 0; i < rows - 1; i++) {
            const a = base + 2 * i;
            idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
          }
        }
      }
    }
    if (!idx.length || !this.curtainMat) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aCol', new THREE.Float32BufferAttribute(col, 4));
    geo.setAttribute('aFrom', new THREE.Float32BufferAttribute(aFrom, 1));
    geo.setAttribute('aFromWave', new THREE.Float32BufferAttribute(aFromWave, 1));
    geo.setAttribute('aTo', new THREE.Float32BufferAttribute(aTo, 1));
    geo.setAttribute('aToWave', new THREE.Float32BufferAttribute(aToWave, 1));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    this.geos.push(geo);
    const mesh = new THREE.Mesh(geo, this.curtainMat);
    mesh.name = 'liquid_curtains';
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    this.root.add(mesh);
  }

  /** Advance animation & drain state. `freezeT`: collapse waves scheduled after this tick never fall (match over). */
  public update(gt: number, elapsedSec: number, freezeT?: number) {
    const fz = freezeT === undefined ? 1e9 : freezeT;
    for (const m of [this.sheetMat, this.curtainMat]) {
      if (!m) continue;
      m.uniforms.uGt.value = gt;
      m.uniforms.uFreeze.value = fz;
      m.uniforms.uTime.value = elapsedSec;
    }
  }

  /** Liquid surface height (m) under a map point at game tick `gt`, or null (no liquid there / already drained). */
  public zAt(xMm: number, yMm: number, gt: number, freezeT?: number): number | null {
    const { nx, ny, cell, waveSteps } = this.mapData;
    const gx = Math.floor(xMm / cell);
    const gy = Math.floor(yMm / cell);
    if (gx < 0 || gy < 0 || gx >= nx || gy >= ny) return this.spec.where === 'all' ? this.spec.z : null;
    const c = gy * nx + gx;
    if (!this.cells[c]) return null;
    const w = this.cellWave[c];
    if (w < 0 || w >= waveSteps.length) return this.spec.z;
    if (freezeT !== undefined && waveSteps[w] > freezeT) return this.spec.z;
    return gt < waveSteps[w] + LIQUID_DRAIN_DELAY ? this.spec.z : null;
  }

  public dispose() {
    for (const g of this.geos) g.dispose();
    this.sheetMat?.dispose();
    this.curtainMat?.dispose();
  }
}
