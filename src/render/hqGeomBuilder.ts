import * as THREE from 'three';
import { HqPalette, HqRockStyle } from './hqThemes';

/**
 * Deterministic fast PRNG (Mulberry32) so every map looks identical across
 * live play, replays, MP4 export, and GIF export.
 */
export class SeededRng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }

  public next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  public uniform(a: number, b: number): number {
    return a + (b - a) * this.next();
  }

  public int(a: number, bExclusive: number): number {
    return a + Math.floor(this.next() * Math.max(1, bExclusive - a));
  }

  public choice<T>(arr: readonly T[]): T {
    return arr[this.int(0, arr.length)];
  }

  public normal(mean = 0, std = 1): number {
    const u1 = Math.max(1e-7, this.next());
    const u2 = this.next();
    return mean + std * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
}

export type LinRGB = [number, number, number];
export type Vec3 = [number, number, number];

const _colCache = new Map<string, LinRGB>();
const _tmpColor = new THREE.Color();

export function hexLin(hex: string, scale = 1.0): LinRGB {
  let base = _colCache.get(hex);
  if (!base) {
    _tmpColor.set(hex);
    base = [_tmpColor.r, _tmpColor.g, _tmpColor.b];
    _colCache.set(hex, base);
  }
  if (scale === 1.0) return [base[0], base[1], base[2]];
  return [
    Math.min(1, Math.max(0, base[0] * scale)),
    Math.min(1, Math.max(0, base[1] * scale)),
    Math.min(1, Math.max(0, base[2] * scale)),
  ];
}

export function scaleLin(c: LinRGB, k: number): LinRGB {
  return [
    Math.min(1, Math.max(0, c[0] * k)),
    Math.min(1, Math.max(0, c[1] * k)),
    Math.min(1, Math.max(0, c[2] * k)),
  ];
}

export function lerpLin(a: LinRGB, b: LinRGB, t: number): LinRGB {
  const u = Math.min(1, Math.max(0, t));
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}

// Precomputed unit icospheres (subdivision 1 = 80 tris, subdivision 2 = 320 tris)
interface RawSphere {
  verts: Vec3[];
  tris: [number, number, number][];
}

function buildIcosphere(sub: number): RawSphere {
  const t = (1 + Math.sqrt(5)) / 2;
  const rawV: Vec3[] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  const norm = (v: Vec3): Vec3 => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const verts = rawV.map(norm);
  let tris: [number, number, number][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  for (let s = 0; s < sub; s++) {
    const midCache = new Map<string, number>();
    const mid = (a: number, b: number): number => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const hit = midCache.get(key);
      if (hit !== undefined) return hit;
      const va = verts[a];
      const vb = verts[b];
      const idx = verts.length;
      verts.push(norm([(va[0] + vb[0]) * 0.5, (va[1] + vb[1]) * 0.5, (va[2] + vb[2]) * 0.5]));
      midCache.set(key, idx);
      return idx;
    };
    const next: [number, number, number][] = [];
    for (const [a, b, c] of tris) {
      const ab = mid(a, b);
      const bc = mid(b, c);
      const ca = mid(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    tris = next;
  }
  return { verts, tris };
}

export const ICO0 = buildIcosphere(0);
export const ICO1 = buildIcosphere(1);
export const ICO2 = buildIcosphere(2);

export type BucketKind = 'solid' | 'smooth' | 'glow' | 'water' | 'foliage';

interface TriBucket {
  pos: number[];
  nrm: number[];
  col: number[];
}

/**
 * Vertex-color triangle accumulator in Blender coordinates `(bx, by, bz)` where
 * `by = -mapY`, `bz = up`, converted via proper right-handed rotation `(bx, bz, -by)`
 * directly into Three.js world space with exact face/vertex normals!
 */
export class HqMeshBuilder {
  private readonly buckets: Record<BucketKind, TriBucket> = {
    solid: { pos: [], nrm: [], col: [] },
    smooth: { pos: [], nrm: [], col: [] },
    glow: { pos: [], nrm: [], col: [] },
    water: { pos: [], nrm: [], col: [] },
    foliage: { pos: [], nrm: [], col: [] },
  };

  public hasAny(): boolean {
    return (
      this.buckets.solid.pos.length > 0 ||
      this.buckets.smooth.pos.length > 0 ||
      this.buckets.glow.pos.length > 0 ||
      this.buckets.water.pos.length > 0 ||
      this.buckets.foliage.pos.length > 0
    );
  }

  /** Push a flat-shaded triangle in Blender coords `(bx, by, bz)` -> Three `(bx, bz, -by)`. */
  public tri(p0: Vec3, p1: Vec3, p2: Vec3, c0: LinRGB, c1: LinRGB = c0, c2: LinRGB = c0, bucket: BucketKind = 'solid') {
    const b = this.buckets[bucket];
    const ax = p0[0], ay = p0[2], az = -p0[1];
    const bx = p1[0], by = p1[2], bz = -p1[1];
    const cx = p2[0], cy = p2[2], cz = -p2[1];

    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;

    b.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    b.nrm.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    b.col.push(c0[0], c0[1], c0[2], c1[0], c1[1], c1[2], c2[0], c2[1], c2[2]);
  }

  /** Push a smooth-shaded triangle with explicit Blender-space vertex normals. */
  public triSmooth(
    p0: Vec3,
    p1: Vec3,
    p2: Vec3,
    n0: Vec3,
    n1: Vec3,
    n2: Vec3,
    c0: LinRGB,
    c1: LinRGB,
    c2: LinRGB,
    bucket: BucketKind = 'smooth',
  ) {
    const b = this.buckets[bucket];
    b.pos.push(p0[0], p0[2], -p0[1], p1[0], p1[2], -p1[1], p2[0], p2[2], -p2[1]);
    b.nrm.push(n0[0], n0[2], -n0[1], n1[0], n1[2], -n1[1], n2[0], n2[2], -n2[1]);
    b.col.push(c0[0], c0[1], c0[2], c1[0], c1[1], c1[2], c2[0], c2[1], c2[2]);
  }

  public quad(
    p0: Vec3,
    p1: Vec3,
    p2: Vec3,
    p3: Vec3,
    c0: LinRGB,
    bucket: BucketKind = 'solid',
    c1: LinRGB = c0,
    c2: LinRGB = c0,
    c3: LinRGB = c0,
  ) {
    this.tri(p0, p1, p2, c0, c1, c2, bucket);
    this.tri(p0, p2, p3, c0, c2, c3, bucket);
  }

  /** Axis-aligned or rotated open-bottom box matching `props.box`. */
  public box(
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    z0: number,
    z1: number,
    col: LinRGB,
    opts?: { top?: LinRGB; bucket?: BucketKind; rz?: number; tiltX?: number; tiltY?: number },
  ) {
    const cx = (x0 + x1) * 0.5;
    const cy = (y0 + y1) * 0.5;
    const rz = opts?.rz ?? 0;
    const tx = opts?.tiltX ?? 0;
    const ty = opts?.tiltY ?? 0;
    const c = rz ? Math.cos(rz) : 1;
    const s = rz ? Math.sin(rz) : 0;
    const dxSpan = Math.max(1e-6, x1 - x0);
    const dySpan = Math.max(1e-6, y1 - y0);

    const R = (x: number, y: number, z: number): Vec3 => {
      let zz = z;
      if (z === z1 && (tx || ty)) {
        zz += (tx * (x - cx) * 2) / dxSpan + (ty * (y - cy) * 2) / dySpan;
      }
      if (rz) {
        const dx = x - cx;
        const dy = y - cy;
        return [cx + dx * c - dy * s, cy + dx * s + dy * c, zz];
      }
      return [x, y, zz];
    };

    const bk = opts?.bucket ?? 'solid';
    const top = opts?.top ?? col;
    this.quad(R(x0, y0, z1), R(x1, y0, z1), R(x1, y1, z1), R(x0, y1, z1), top, bk);
    this.quad(R(x0, y0, z0), R(x1, y0, z0), R(x1, y0, z1), R(x0, y0, z1), col, bk);
    this.quad(R(x1, y1, z0), R(x0, y1, z0), R(x0, y1, z1), R(x1, y1, z1), col, bk);
    this.quad(R(x1, y0, z0), R(x1, y1, z0), R(x1, y1, z1), R(x1, y0, z1), col, bk);
    this.quad(R(x0, y1, z0), R(x0, y0, z0), R(x0, y0, z1), R(x0, y1, z1), col, bk);
  }

  /** Stylized icosphere puff with vertical bottom->top gradient (`props.blob`). */
  public blob(
    x: number,
    y: number,
    z: number,
    rx: number,
    ry: number,
    rz: number,
    cLo: LinRGB,
    cHi: LinRGB,
    opts?: { sub?: 0 | 1 | 2; bucket?: BucketKind; smooth?: boolean; rotZ?: number; clampMinZ?: number },
  ) {
    const sph = opts?.sub === 0 ? ICO0 : opts?.sub === 1 ? ICO1 : ICO2;
    const smooth = opts?.smooth ?? true;
    const bk = opts?.bucket ?? (smooth ? 'smooth' : 'solid');
    const rotZ = opts?.rotZ ?? 0;
    const cr = rotZ ? Math.cos(rotZ) : 1;
    const sr = rotZ ? Math.sin(rotZ) : 0;
    const minZ = opts?.clampMinZ;

    const pts: Vec3[] = new Array(sph.verts.length);
    const nrms: Vec3[] = new Array(sph.verts.length);
    const cols: LinRGB[] = new Array(sph.verts.length);

    for (let i = 0; i < sph.verts.length; i++) {
      const v = sph.verts[i];
      let sx = v[0] * rx;
      let sy = v[1] * ry;
      let sz = v[2] * rz;
      if (minZ !== undefined && sz < minZ) sz = minZ;
      const wx = x + sx * cr - sy * sr;
      const wy = y + sx * sr + sy * cr;
      pts[i] = [wx, wy, z + sz];
      const nx = v[0] * cr - v[1] * sr;
      const ny = v[0] * sr + v[1] * cr;
      nrms[i] = [nx, ny, v[2]];
      cols[i] = lerpLin(cLo, cHi, v[2] * 0.5 + 0.5);
    }

    for (const [a, b, c] of sph.tris) {
      if (smooth && bk !== 'glow') {
        this.triSmooth(pts[a], pts[b], pts[c], nrms[a], nrms[b], nrms[c], cols[a], cols[b], cols[c], bk);
      } else {
        this.tri(pts[a], pts[b], pts[c], cols[a], cols[b], cols[c], bk);
      }
    }
  }

  /** Stacked polygon frustum rings matching `props.stack`. */
  public stack(
    cx: number,
    cy: number,
    levels: [number, number][],
    cols: LinRGB | LinRGB[],
    opts?: {
      n?: number;
      jitter?: number;
      rng?: SeededRng;
      ell?: number;
      rot0?: number;
      bucket?: BucketKind;
      cap?: LinRGB;
      smooth?: boolean;
    },
  ) {
    const n = opts?.n ?? 8;
    const jitter = opts?.jitter ?? 0;
    const rng = opts?.rng;
    const ell = opts?.ell ?? 1.0;
    const rot0 = opts?.rot0 ?? 0;
    const smooth = opts?.smooth ?? false;
    const bk = opts?.bucket ?? (smooth ? 'smooth' : 'solid');
    const colArr: LinRGB[] = Array.isArray(cols[0]) ? (cols as LinRGB[]) : [cols as LinRGB];

    const ang: number[] = [];
    const rj: number[] = [];
    for (let i = 0; i < n; i++) {
      ang.push(rot0 + (2 * Math.PI * (i + (rng && jitter ? rng.uniform(-0.25, 0.25) : 0))) / n);
      rj.push(1.0 + (rng && jitter ? rng.uniform(-jitter, jitter) : 0));
    }

    const rings: Vec3[][] = levels.map(([r, z]) => {
      const ring: Vec3[] = [];
      for (let i = 0; i < n; i++) {
        ring.push([cx + r * rj[i] * Math.cos(ang[i]), cy + r * rj[i] * Math.sin(ang[i]) * ell, z]);
      }
      return ring;
    });

    for (let k = 0; k < rings.length - 1; k++) {
      const a = rings[k];
      const b = rings[k + 1];
      const c = colArr[k % colArr.length];
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        if (smooth) {
          const ni: Vec3 = [Math.cos(ang[i]), Math.sin(ang[i]), 0];
          const nj: Vec3 = [Math.cos(ang[j]), Math.sin(ang[j]), 0];
          this.triSmooth(a[i], a[j], b[j], ni, nj, nj, c, c, c, bk);
          this.triSmooth(a[i], b[j], b[i], ni, nj, ni, c, c, c, bk);
        } else {
          this.quad(a[i], a[j], b[j], b[i], c, bk);
        }
      }
    }

    const top = rings[rings.length - 1];
    const tc = opts?.cap ?? colArr[(rings.length - 2 + colArr.length) % colArr.length];
    let sx = 0, sy = 0;
    for (const p of top) {
      sx += p[0];
      sy += p[1];
    }
    const ctr: Vec3 = [sx / n, sy / n, top[0][2]];
    for (let i = 0; i < n; i++) {
      this.tri(top[i], top[(i + 1) % n], ctr, tc, tc, tc, bk === 'smooth' ? 'solid' : bk);
    }
  }

  /** Curved tapered tube along a 3D polyline (`props.tube`). */
  public tube(
    pts: Vec3[],
    r0: number,
    col: LinRGB,
    opts?: { seg?: number; r1?: number; bucket?: BucketKind },
  ) {
    const seg = opts?.seg ?? 6;
    const r1 = opts?.r1 ?? r0;
    const bk = opts?.bucket ?? 'smooth';
    const n = pts.length;
    if (n < 2) return;

    const rings: Vec3[][] = [];
    const nrms: Vec3[][] = [];
    for (let i = 0; i < n; i++) {
      const prev = pts[Math.max(0, i - 1)];
      const next = pts[Math.min(n - 1, i + 1)];
      let dx = next[0] - prev[0];
      let dy = next[1] - prev[1];
      let dz = next[2] - prev[2];
      const dl = Math.hypot(dx, dy, dz) || 1;
      dx /= dl;
      dy /= dl;
      dz /= dl;
      // Pick arbitrary perpendicular vector
      const ux = Math.abs(dz) < 0.9 ? 0 : 1;
      const uy = 0;
      const uz = Math.abs(dz) < 0.9 ? 1 : 0;
      let wx = dy * uz - dz * uy;
      let wy = dz * ux - dx * uz;
      let wz = dx * uy - dy * ux;
      const wl = Math.hypot(wx, wy, wz) || 1;
      wx /= wl;
      wy /= wl;
      wz /= wl;
      const vx = wy * dz - wz * dy;
      const vy = wz * dx - wx * dz;
      const vz = wx * dy - wy * dx;

      const rr = r0 + ((r1 - r0) * i) / Math.max(1, n - 1);
      const ring: Vec3[] = [];
      const nr: Vec3[] = [];
      for (let j = 0; j < seg; j++) {
        const a = (2 * Math.PI * j) / seg;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const rx = ca * wx + sa * vx;
        const ry = ca * wy + sa * vy;
        const rz = ca * wz + sa * vz;
        ring.push([pts[i][0] + rr * rx, pts[i][1] + rr * ry, pts[i][2] + rr * rz]);
        nr.push([rx, ry, rz]);
      }
      rings.push(ring);
      nrms.push(nr);
    }

    for (let i = 0; i < n - 1; i++) {
      for (let j = 0; j < seg; j++) {
        const j2 = (j + 1) % seg;
        this.triSmooth(rings[i][j], rings[i][j2], rings[i + 1][j2], nrms[i][j], nrms[i][j2], nrms[i + 1][j2], col, col, col, bk);
        this.triSmooth(rings[i][j], rings[i + 1][j2], rings[i + 1][j], nrms[i][j], nrms[i + 1][j2], nrms[i + 1][j], col, col, col, bk);
      }
    }
    const last = rings[n - 1];
    const capP = pts[n - 1];
    for (let j = 0; j < seg; j++) {
      this.tri(last[j], last[(j + 1) % seg], capP, col, col, col, 'solid');
    }
  }

  /** Build Three.js Meshes for all non-empty buckets and return them along with materials. */
  public buildMeshes(opts?: {
    castShadow?: boolean;
    receiveShadow?: boolean;
    sharedMats?: Partial<Record<BucketKind, THREE.Material>>;
  }): { meshes: THREE.Mesh[]; ownedMaterials: THREE.Material[] } {
    const meshes: THREE.Mesh[] = [];
    const ownedMaterials: THREE.Material[] = [];
    const cast = opts?.castShadow ?? true;
    const recv = opts?.receiveShadow ?? true;

    const buildOne = (kind: BucketKind) => {
      const b = this.buckets[kind];
      if (b.pos.length === 0) return;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
      geo.computeBoundingSphere();

      let mat = opts?.sharedMats?.[kind];
      if (!mat) {
        if (kind === 'glow') {
          mat = new THREE.MeshBasicMaterial({ vertexColors: true });
        } else if (kind === 'water') {
          mat = new THREE.MeshBasicMaterial({
            vertexColors: true,
            transparent: true,
            opacity: 0.78,
            side: THREE.DoubleSide,
            depthWrite: false,
          });
        } else if (kind === 'foliage') {
          mat = new THREE.MeshLambertMaterial({
            vertexColors: true,
            side: THREE.DoubleSide,
          });
        } else {
          mat = new THREE.MeshLambertMaterial({
            vertexColors: true,
            flatShading: kind === 'solid',
          });
        }
        ownedMaterials.push(mat);
      }

      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = cast && kind !== 'water' && kind !== 'glow';
      mesh.receiveShadow = recv && kind !== 'water' && kind !== 'glow';
      meshes.push(mesh);
    };

    buildOne('solid');
    buildOne('smooth');
    buildOne('foliage');
    buildOne('glow');
    buildOne('water');
    return { meshes, ownedMaterials };
  }
}

// ------------------------------------------------------------------ Stylized Faceted Rock (`env.make_rock`)
export function addFacetedRock(
  mb: HqMeshBuilder,
  cx: number,
  cy: number,
  a: number,
  b: number,
  h: number,
  rng: SeededRng,
  pal: HqPalette,
  rock: HqRockStyle,
  opts?: { mossy?: boolean; rot?: number; z0?: number },
) {
  const n = rng.int(rock.n[0], rock.n[1] + 1);
  const rot = opts?.rot ?? rng.uniform(0, Math.PI);
  const baseAng = rng.uniform(0, 2 * Math.PI);
  const zOff = opts?.z0 ?? 0;
  const cr = Math.cos(rot);
  const sr = Math.sin(rot);
  const p = rock.p;
  const topSc = rng.uniform(rock.top[0], rock.top[1]);
  const midH = h * rng.uniform(0.45, 0.62);
  const midSc = rng.uniform(0.9, 1.0);
  const ox = rng.uniform(-0.1, 0.1) * a;
  const oy = rng.uniform(-0.1, 0.1) * b;
  const tx = rng.uniform(-0.18, 0.18);
  const ty = rng.uniform(-0.18, 0.18);

  const levelSpec: [number, number, number][] = [
    [-0.05, 1.0, 0.03],
    [midH, midSc, 0.06],
    [h * 0.92, topSc * 1.07, 0.08], // beveled shoulder ring!
    [h, topSc * 0.88, 0.09],
  ];

  const rings: Vec3[][] = [];
  for (let li = 0; li < levelSpec.length; li++) {
    const [z, sc, jit] = levelSpec[li];
    const ring: Vec3[] = [];
    for (let i = 0; i < n; i++) {
      const ang = baseAng + (2 * Math.PI * (i + rng.uniform(-0.16, 0.16))) / n;
      const ct = Math.cos(ang);
      const st = Math.sin(ang);
      const r = Math.pow(Math.pow(Math.abs(ct), p) + Math.pow(Math.abs(st), p), -1 / p);
      const k = sc * rng.uniform(1 - jit * 1.5, 1.0);
      let lx = a * r * ct * k;
      let ly = b * r * st * k;
      if (li >= 2) {
        lx += ox;
        ly += oy;
      }
      const zz = zOff + z + (li >= 2 ? tx * lx + ty * ly : 0) + (li > 0 ? rng.uniform(-0.03, 0.03) * h : 0);
      ring.push([cx + lx * cr - ly * sr, cy + lx * sr + ly * cr, zz]);
    }
    rings.push(ring);
  }

  const cTop = hexLin(pal.stone_top);
  const cLit = hexLin(pal.stone_lit);
  const cShade = hexLin(pal.stone_shade);
  const cMoss = hexLin(pal.moss);
  const cChamfer = hexLin('#FFF3D6');
  const sunX = -0.6;
  const sunY = 0.45;

  const shadeFace = (p0: Vec3, p1: Vec3, p2: Vec3, isChamfer: boolean): LinRGB => {
    const e1x = p1[0] - p0[0], e1y = p1[1] - p0[1], e1z = p1[2] - p0[2];
    const e2x = p2[0] - p0[0], e2y = p2[1] - p0[1], e2z = p2[2] - p0[2];
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;

    let col: LinRGB;
    if (nz > 0.65) {
      col = opts?.mossy && !isChamfer ? cMoss : cTop;
    } else {
      const f = Math.min(1, Math.max(0, (nx * sunX + ny * sunY) * 0.75 + 0.5));
      col = lerpLin(cShade, cLit, f);
      if (nz > 0.25) col = lerpLin(col, cTop, 0.5);
    }
    if (isChamfer && nz > 0.1) col = lerpLin(col, cChamfer, 0.48);
    const zc = (p0[2] + p1[2] + p2[2]) / 3 - zOff;
    if (zc < 0.14 && nz < 0.5) col = scaleLin(col, 0.86);
    return scaleLin(col, rng.uniform(0.96, 1.04));
  };

  for (let li = 0; li < rings.length - 1; li++) {
    const r0 = rings[li];
    const r1 = rings[li + 1];
    const isChamfer = li === 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const col = shadeFace(r0[i], r0[j], r1[j], isChamfer);
      mb.quad(r0[i], r0[j], r1[j], r1[i], col, 'solid');
    }
  }

  const topRing = rings[rings.length - 1];
  let sx = 0, sy = 0, sz = 0;
  for (const v of topRing) {
    sx += v[0];
    sy += v[1];
    sz += v[2];
  }
  const topCtr: Vec3 = [sx / n, sy / n, sz / n + h * 0.04];
  const capCol = opts?.mossy ? cMoss : cTop;
  for (let i = 0; i < n; i++) {
    mb.tri(topRing[i], topRing[(i + 1) % n], topCtr, scaleLin(capCol, rng.uniform(0.97, 1.03)), undefined, undefined, 'solid');
  }
}

// ------------------------------------------------------------------ Houses (`props.house`, `props.tower`)
const HOUSE_WALLS = ['#FBF1DC', '#F7E3BC', '#F6D9C6', '#F1EEE6', '#F8E7A8', '#EBD9BE', '#DDE8E2'];
const HOUSE_ROOFS = ['#E2643C', '#C9553A', '#F08048', '#B8473A', '#E86A4A', '#5F86B2', '#D9773F', '#A8504A'];
const HOUSE_DOORS = ['#7A5238', '#3F7F7A', '#9A3E38', '#5A6FA0', '#7A5238'];

function addGable(
  mb: HqMeshBuilder,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  zb: number,
  rh: number,
  roofHex: string,
  wallCol: LinRGB,
  alongX: boolean,
  ov = 0.04,
  rows = 4,
  th = 0.07,
) {
  const P = (u: number, v: number, z: number): Vec3 => (alongX ? [u, v, z] : [v, u, z]);
  const Q = (pts: [number, number, number][], c: LinRGB) => {
    const p = pts.map((q) => P(q[0], q[1], q[2]));
    if (alongX) mb.quad(p[0], p[1], p[2], p[3], c);
    else mb.quad(p[3], p[2], p[1], p[0], c);
  };
  const T = (pts: [number, number, number][], c: LinRGB) => {
    const p = pts.map((q) => P(q[0], q[1], q[2]));
    if (alongX) mb.tri(p[0], p[1], p[2], c);
    else mb.tri(p[2], p[1], p[0], c);
  };

  const [u0, u1, v0, v1] = alongX ? [x0, x1, y0, y1] : [y0, y1, x0, x1];
  const vm = (v0 + v1) * 0.5;
  const a0 = u0 - ov;
  const a1 = u1 + ov;
  const half = Math.max(0.05, (v1 - v0) * 0.5);
  const ze = zb - (ov * rh) / half;
  const zr = zb + rh;
  const e0 = v0 - ov;
  const e1 = v1 + ov;

  for (let k = 0; k < rows; k++) {
    const t0 = k / rows;
    const t1 = (k + 1) / rows;
    const kk = (k === 0 ? 0.86 : k % 2 ? 0.97 : 1.08) * (k === rows - 1 ? 1.2 : 1.0);
    const va1 = e0 + (vm - e0) * t0;
    const vb1 = e0 + (vm - e0) * t1;
    const za = ze + (zr - ze) * t0;
    const zb2 = ze + (zr - ze) * t1;
    Q([[a0, va1, za], [a1, va1, za], [a1, vb1, zb2], [a0, vb1, zb2]], hexLin(roofHex, kk * (alongX ? 1.05 : 1.08)));

    const va2 = e1 + (vm - e1) * t0;
    const vb2 = e1 + (vm - e1) * t1;
    Q([[a1, va2, za], [a0, va2, za], [a0, vb2, zb2], [a1, vb2, zb2]], hexLin(roofHex, kk * 0.8));
  }

  const dk = hexLin(roofHex, 0.66);
  Q([[a0, e0, ze - th], [a1, e0, ze - th], [a1, e0, ze], [a0, e0, ze]], dk);
  Q([[a1, e1, ze - th], [a0, e1, ze - th], [a0, e1, ze], [a1, e1, ze]], dk);
  Q([[a1, e0, ze - th], [a1, vm, zr - th], [a1, vm, zr], [a1, e0, ze]], dk);
  Q([[a1, e1, ze], [a1, vm, zr], [a1, vm, zr - th], [a1, e1, ze - th]], dk);
  Q([[a0, e0, ze], [a0, vm, zr], [a0, vm, zr - th], [a0, e0, ze - th]], dk);
  Q([[a0, e1, ze - th], [a0, vm, zr - th], [a0, vm, zr], [a0, e1, ze]], dk);
  T([[u1, v0, zb], [u1, v1, zb], [u1, vm, zr - 0.01]], wallCol);
  T([[u0, v1, zb], [u0, v0, zb], [u0, vm, zr - 0.01]], wallCol);
}

export function addHouse(
  mb: HqMeshBuilder,
  X0: number,
  Y0: number,
  Wd: number,
  Hd: number,
  rng: SeededRng,
  idx = 0,
  ins = 0.05,
  far = false,
  zOff = 0,
) {
  const x0 = X0 + ins;
  const x1 = X0 + Wd - ins;
  const y0 = Y0 + ins;
  const y1 = Y0 + Hd - ins;
  const short = Math.min(Wd, Hd);
  const hw = zOff + 0.74 + 0.15 * Math.min(short, 2.5) + rng.uniform(-0.04, 0.06);
  const rh = Math.min(0.6, 0.2 * short + 0.14);
  const wall = hexLin(HOUSE_WALLS[(idx * 2) % HOUSE_WALLS.length]);
  const roofHex = HOUSE_ROOFS[idx % HOUSE_ROOFS.length];
  const stone = hexLin('#B4A28E');
  const wood = hexLin('#7A5238');

  mb.box(x0 - 0.03, x1 + 0.03, y0 - 0.03, y1 + 0.03, zOff - 0.03, zOff + 0.14, stone);
  mb.box(x0, x1, y0, y1, zOff + 0.1, hw, wall);
  const alongX = Wd > Hd + 0.2 || (Math.abs(Wd - Hd) <= 0.2 && idx % 2 === 0);
  addGable(mb, x0, x1, y0, y1, hw, rh, roofHex, wall, alongX);

  mb.box(x0 - 0.012, x1 + 0.012, y0 - 0.014, y0, hw - 0.11, hw - 0.04, wood);
  for (const xx of [x0, x1 - 0.06]) {
    mb.box(xx - 0.006, xx + 0.066, y0 - 0.014, y0, zOff + 0.14, hw - 0.11, wood);
  }

  const wdt = x1 - x0;
  const ns = Math.max(1, Math.floor(wdt / 0.62));
  const sw = wdt / ns;
  const doorI = ns < 3 ? rng.int(0, ns) : rng.int(1, ns - 1);
  const doorc = hexLin(HOUSE_DOORS[idx % HOUSE_DOORS.length]);

  for (let i = 0; i < ns; i++) {
    const cx = x0 + (i + 0.5) * sw;
    if (i === doorI) {
      mb.box(cx - 0.18, cx + 0.18, y0 - 0.02, y0, zOff + 0.12, zOff + 0.7, hexLin('#FFF8EA'));
      mb.box(cx - 0.135, cx + 0.135, y0 - 0.034, y0, zOff + 0.12, zOff + 0.64, doorc, { top: scaleLin(doorc, 0.8) });
      mb.box(cx + 0.07, cx + 0.1, y0 - 0.045, y0 - 0.034, zOff + 0.36, zOff + 0.4, hexLin('#FFD86A'), { bucket: 'glow' });
      mb.box(cx - 0.2, cx + 0.2, y0 - 0.045, y0, zOff, zOff + 0.12, scaleLin(stone, 1.12));
    } else {
      const lit = rng.next() < 0.3;
      mb.box(cx - 0.16, cx + 0.16, y0 - 0.02, y0, zOff + 0.42, zOff + 0.8, hexLin('#FFFFFF'));
      mb.box(cx - 0.115, cx + 0.115, y0 - 0.03, y0, zOff + 0.465, zOff + 0.755, lit ? hexLin('#FFE39A') : hexLin('#7CC4EA'), {
        bucket: lit ? 'glow' : 'solid',
      });
      mb.box(cx - 0.012, cx + 0.012, y0 - 0.036, y0, zOff + 0.465, zOff + 0.755, hexLin('#FFFFFF'));
      mb.box(cx - 0.115, cx + 0.115, y0 - 0.036, y0, zOff + 0.6, zOff + 0.622, hexLin('#FFFFFF'));
      mb.box(cx - 0.17, cx + 0.17, y0 - 0.046, y0, zOff + 0.36, zOff + 0.425, wood);
      if (!far) {
        const flowerCols = ['#FF6A6A', '#FFD24A', '#FF9CC0', '#FFFFFF'];
        for (let k = 0; k < 4; k++) {
          const fx = cx - 0.12 + 0.08 * k;
          const fc = hexLin(flowerCols[rng.int(0, 4)]);
          mb.blob(fx, y0 - 0.03, zOff + 0.45, 0.036, 0.032, 0.036, fc, fc, { sub: 0, bucket: 'glow' });
        }
      }
    }
  }

  if (!alongX) {
    const xm = (x0 + x1) * 0.5;
    const zc = hw + rh * 0.32;
    const s = 0.085;
    mb.quad([xm, y0 - 0.012, zc - s], [xm + s, y0 - 0.012, zc], [xm, y0 - 0.012, zc + s], [xm - s, y0 - 0.012, zc], hexLin('#7CC4EA'));
  }

  const ym = (y0 + y1) * 0.5;
  for (const [xx, sg] of [
    [x1, 1],
    [x0, -1],
  ] as [number, number][]) {
    const [xa, xb] = sg > 0 ? [xx, xx + 0.02] : [xx - 0.02, xx];
    mb.box(xa, xb, ym - 0.15, ym + 0.15, zOff + 0.44, zOff + 0.78, hexLin('#FFFFFF'));
    const [xa2, xb2] = sg > 0 ? [xx, xx + 0.03] : [xx - 0.03, xx];
    mb.box(xa2, xb2, ym - 0.105, ym + 0.105, zOff + 0.485, zOff + 0.735, hexLin('#7CC4EA'));
  }

  const [chx, chy] = alongX
    ? [x0 + (x1 - x0) * (idx % 2 ? 0.24 : 0.76), y0 + (y1 - y0) * 0.64]
    : [x0 + (x1 - x0) * 0.66, y0 + (y1 - y0) * (idx % 2 ? 0.3 : 0.7)];
  mb.box(chx - 0.09, chx + 0.09, chy - 0.09, chy + 0.09, hw + rh * 0.3, hw + rh + 0.14, hexLin('#C98A6A'), {
    top: hexLin('#5A4A48'),
  });
  mb.box(chx - 0.11, chx + 0.11, chy - 0.11, chy + 0.11, hw + rh + 0.1, hw + rh + 0.16, hexLin('#E8D8C0'), {
    top: hexLin('#5A4A48'),
  });
}

export function addClockTower(mb: HqMeshBuilder, cx: number, cy: number, z: number, s: number) {
  const w = 0.55 * s;
  const h = 3.4 * s;
  mb.box(cx - w, cx + w, cy - w, cy + w, z - 0.2, z + h, hexLin('#F6E8CC'));
  mb.box(cx - w - 0.05, cx + w + 0.05, cy - w - 0.05, cy + w + 0.05, z + h * 0.62, z + h * 0.66, hexLin('#B4A28E'));
  mb.box(cx - w - 0.07, cx + w + 0.07, cy - w - 0.07, cy + w + 0.07, z + h, z + h + 0.1 * s, hexLin('#B4A28E'));
  mb.stack(
    cx,
    cy,
    [
      [w * 1.5, z + h + 0.1 * s],
      [w * 0.9, z + h + 0.9 * s],
      [0.02, z + h + 2.2 * s],
    ],
    [hexLin('#D3502E'), hexLin('#E2643C')],
    { n: 4, rot0: Math.PI / 4 },
  );
  // Clock dial on south face
  const rDial = 0.34 * s;
  const cyDial = cy - w - 0.025;
  const czDial = z + h * 0.82;
  const seg = 14;
  const cDial = hexLin('#FFF6DA');
  const ctr: Vec3 = [cx, cyDial, czDial];
  for (let i = 0; i < seg; i++) {
    const a0 = (2 * Math.PI * i) / seg;
    const a1 = (2 * Math.PI * (i + 1)) / seg;
    mb.tri(
      ctr,
      [cx + Math.cos(a0) * rDial, cyDial, czDial + Math.sin(a0) * rDial],
      [cx + Math.cos(a1) * rDial, cyDial, czDial + Math.sin(a1) * rDial],
      cDial,
      cDial,
      cDial,
      'glow',
    );
  }
  mb.box(cx - 0.02 * s, cx + 0.02 * s, cy - w - 0.05, cy - w - 0.03, czDial, czDial + 0.24 * s, hexLin('#3A2E38'));
  mb.box(cx, cx + 0.17 * s, cy - w - 0.05, cy - w - 0.03, czDial - 0.02 * s, czDial + 0.02 * s, hexLin('#3A2E38'));
  for (let k = 0; k < 3; k++) {
    const zz = z + h * (0.2 + 0.16 * k);
    mb.box(cx - 0.1 * s, cx + 0.1 * s, cy - w - 0.02, cy - w, zz, zz + 0.3 * s, hexLin('#7CC4EA'));
  }
}

// ------------------------------------------------------------------ Arena Trees (`props.tree`)
export function addArenaTree(
  mb: HqMeshBuilder,
  cx: number,
  cy: number,
  a: number,
  rng: SeededRng,
  opts?: {
    trunk?: [string, string];
    crown?: [string, string, string];
    h?: number;
    cr?: number;
    blobs?: number;
    flat?: number;
    z?: number;
    knot?: boolean;
    mush?: boolean;
  },
) {
  const tr = opts?.trunk ?? ['#8A5E44', '#6E4838'];
  const cw = opts?.crown ?? ['#2F8050', '#4FA65C', '#9AD476'];
  const h = opts?.h ?? 1.25;
  const cr = opts?.cr ?? 1.0;
  const blobs = opts?.blobs ?? 5;
  const flat = opts?.flat ?? 0.8;
  const z = opts?.z ?? 0;
  const knot = opts?.knot ?? true;
  const mush = opts?.mush ?? false;

  const c0 = hexLin(tr[0]);
  const c1 = hexLin(tr[1]);
  const r0 = a * 0.8;
  const rot0 = rng.uniform(0, 6.28);
  mb.stack(
    cx,
    cy,
    [
      [r0 * 1.22, z - 0.05],
      [r0 * 1.0, z + 0.14],
      [r0 * 0.84, z + h * 0.4],
      [r0 * 0.74, z + h * 0.78],
      [r0 * 0.7, z + h],
    ],
    [scaleLin(c1, 0.92), c0, scaleLin(c0, 1.06), c0],
    { n: 9, jitter: 0.07, rng, rot0, cap: c1 },
  );

  for (let k = 0; k < 5; k++) {
    const an = rot0 + (2 * Math.PI * (k + rng.uniform(-0.2, 0.2))) / 5;
    const rr = r0 * 1.02;
    mb.blob(cx + Math.cos(an) * rr, cy + Math.sin(an) * rr, z + 0.06, r0 * 0.36, r0 * 0.2, 0.17, c1, c0, {
      sub: 1,
      smooth: false,
      rotZ: an,
    });
  }

  if (knot) {
    const dk = hexLin('#3A2620');
    mb.blob(cx + r0 * 0.1, cy - r0 * 0.8, z + h * 0.5, r0 * 0.2, 0.05, r0 * 0.27, dk, dk, { sub: 1, smooth: false });
  }
  if (mush) {
    for (let k = 0; k < 2; k++) {
      const an = -Math.PI / 2 + (-0.7 + 1.5 * k);
      mb.blob(
        cx + Math.cos(an) * r0 * 0.86,
        cy + Math.sin(an) * r0 * 0.86,
        z + h * (0.3 + 0.16 * k),
        0.12,
        0.12,
        0.035,
        hexLin('#E8C89A'),
        hexLin('#FFF2D8'),
        { sub: 1, smooth: false },
      );
    }
  }

  const cA = hexLin(cw[0]);
  const cB = hexLin(cw[1]);
  const cC = hexLin(cw[2]);
  const R = a * 0.82 * cr;
  const top = z + h;
  mb.blob(cx, cy, top + R * 0.45 * flat, R * 0.8, R * 0.8, R * 0.8 * flat, cA, cB, { sub: 2, smooth: true });
  for (let k = 0; k < blobs - 1; k++) {
    const an = rot0 + (2 * Math.PI * k) / Math.max(1, blobs - 1);
    const rr = R * 0.6;
    const rb = R * rng.uniform(0.44, 0.56);
    mb.blob(cx + Math.cos(an) * rr, cy + Math.sin(an) * rr, top + R * rng.uniform(0.15, 0.6) * flat, rb, rb, rb * flat, cA, k % 2 ? cC : cB, {
      sub: 2,
      smooth: true,
    });
  }
  mb.blob(cx - R * 0.15, cy + R * 0.1, top + R * 1.0 * flat, R * 0.52, R * 0.52, R * 0.46 * flat, cB, cC, { sub: 2, smooth: true });
  mb.blob(cx + R * 0.3, cy - R * 0.2, top + R * 0.85 * flat, R * 0.36, R * 0.36, R * 0.32 * flat, cB, cC, { sub: 2, smooth: true });
}

// ------------------------------------------------------------------ Hoodoo & Mesa (`props.hoodoo`, `props.mesa`)
export function addHoodoo(
  mb: HqMeshBuilder,
  cx: number,
  cy: number,
  a: number,
  b: number,
  h: number,
  rng: SeededRng,
  bands: string[],
  opts?: { cap?: boolean; z?: number },
) {
  const n = rng.int(6, 9);
  const cols = bands.map((hex) => hexLin(hex));
  const k0 = rng.int(0, cols.length);
  const waist = rng.uniform(0.6, 0.72);
  const cap = opts?.cap ?? true;
  const z = opts?.z ?? 0;

  const lv: [number, number][] = [
    [1.0, -0.05],
    [0.97, 0.1],
    [0.86, 0.26],
    [waist + 0.08, 0.42],
    [waist, 0.56],
    [waist + 0.06, 0.68],
    [waist - 0.04, 0.8],
  ];
  if (cap) {
    lv.push([waist - 0.04, 0.83], [0.9, 0.84], [0.95, 0.93], [0.72, 1.0]);
  } else {
    lv.push([waist - 0.12, 0.9], [waist - 0.3, 1.0]);
  }
  const levels: [number, number][] = lv.map(([r, t]) => [a * r, z + h * t]);
  const cl: LinRGB[] = [];
  for (let i = 0; i < levels.length - 1; i++) cl.push(cols[(k0 + i) % cols.length]);
  if (cap && cl.length >= 2) {
    cl[cl.length - 2] = scaleLin(cols[k0 % cols.length], 1.08);
    cl[cl.length - 1] = scaleLin(cols[(k0 + 1) % cols.length], 1.12);
  }
  mb.stack(cx, cy, levels, cl, {
    n,
    jitter: 0.1,
    rng,
    ell: b / Math.max(1e-4, a),
    rot0: rng.uniform(0, 6.28),
    cap: scaleLin(cols[0], 1.15),
  });
}

export function addMesa(
  mb: HqMeshBuilder,
  cx: number,
  cy: number,
  a: number,
  b: number,
  h: number,
  rng: SeededRng,
  bands: string[],
  z = 0,
) {
  const cols = bands.map((hex) => hexLin(hex));
  const n = rng.int(7, 10);
  const lv: [number, number][] = [
    [1.0, -0.05],
    [0.98, 0.16],
    [0.93, 0.34],
    [0.9, 0.5],
    [0.74, 0.52],
    [0.72, 0.7],
    [0.68, 0.86],
    [0.64, 1.0],
  ];
  const levels: [number, number][] = lv.map(([r, t]) => [a * r, z + h * t]);
  const cl: LinRGB[] = [];
  for (let i = 0; i < levels.length - 1; i++) cl.push(cols[i % cols.length]);
  mb.stack(cx, cy, levels, cl, {
    n,
    jitter: 0.08,
    rng,
    ell: b / Math.max(1e-4, a),
    rot0: rng.uniform(0, 6.28),
    cap: scaleLin(cols[0], 1.18),
  });
}

// ------------------------------------------------------------------ Crates & Barrels (`sunset`)
export function addCrate(mb: HqMeshBuilder, cx: number, cy: number, s: number, z: number, rng: SeededRng, rz = 0) {
  const w = s * 0.5;
  const frame = hexLin('#8A5A3A');
  const panel = hexLin(rng.choice(['#D9A066', '#CF9458', '#E2AE74']));
  mb.box(cx - w, cx + w, cy - w, cy + w, z, z + s, frame, { rz });
  const ins = s * 0.13;
  const e = 0.012;
  const c = Math.cos(rz);
  const sn = Math.sin(rz);
  const R = (x: number, y: number, zz: number): Vec3 => [cx + x * c - y * sn, cy + x * sn + y * c, z + zz];
  mb.quad(R(-w + ins, -w + ins, s + e), R(w - ins, -w + ins, s + e), R(w - ins, w - ins, s + e), R(-w + ins, w - ins, s + e), scaleLin(panel, 1.06));
  const dirs: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  for (const [ux, uy] of dirs) {
    const px = -uy;
    const py = ux;
    const o = w + e;
    const S = (t: number, zz: number): Vec3 => R(ux * o + px * t, uy * o + py * t, zz);
    mb.quad(S(-w + ins, ins), S(w - ins, ins), S(w - ins, s - ins), S(-w + ins, s - ins), panel);
    const d = s * 0.075;
    mb.quad(
      R(ux * (o + e) + px * (-w + ins), uy * (o + e) + py * (-w + ins), ins),
      R(ux * (o + e) + px * (-w + ins + d), uy * (o + e) + py * (-w + ins + d), ins),
      R(ux * (o + e) + px * (w - ins), uy * (o + e) + py * (w - ins), s - ins),
      R(ux * (o + e) + px * (w - ins - d), uy * (o + e) + py * (w - ins - d), s - ins),
      frame,
    );
  }
}

export function addBarrel(mb: HqMeshBuilder, cx: number, cy: number, r: number, h: number, z: number) {
  const wood = hexLin('#C98A54');
  const hoop = hexLin('#5A4A48');
  const lv: [number, number][] = [
    [0.84, 0.0], [0.84, 0.1], [0.9, 0.1], [0.9, 0.17], [1.0, 0.36],
    [1.0, 0.64], [0.9, 0.83], [0.9, 0.9], [0.84, 0.9], [0.84, 1.0],
  ];
  const cl: LinRGB[] = [scaleLin(wood, 0.9), hoop, hoop, wood, scaleLin(wood, 1.08), wood, hoop, hoop, scaleLin(wood, 0.9)];
  mb.stack(cx, cy, lv.map(([a, t]) => [r * a, z + h * t]), cl, { n: 10, cap: scaleLin(wood, 1.15) });
}

// ------------------------------------------------------------------ Fountain (`oldtown`) & Bridge Posts
export function addFountain(mb: HqMeshBuilder, cx: number, cy: number, rx: number, ry: number) {
  const stone = hexLin('#E6D9C0');
  const stoneHi = hexLin('#F6EEDC');
  const dk = hexLin('#A89884');
  const n = 28;
  const out: [number, number][] = [
    [1.0 + 0.3 / rx, -0.02],
    [1.0 + 0.3 / rx, 0.13],
    [1.0 + 0.24 / rx, 0.17],
    [1.0 + 0.06 / rx, 0.17],
    [1.0, 0.12],
    [1.0 - 0.02 / rx, -0.5],
  ];
  const rings: Vec3[][] = out.map(([r, z]) => {
    const ring: Vec3[] = [];
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      ring.push([cx + rx * r * Math.cos(a), cy + ry * (1 + ((r - 1) * rx) / ry) * Math.sin(a), z]);
    }
    return ring;
  });
  const cols = [stone, scaleLin(stone, 0.92), stoneHi, scaleLin(stone, 0.9), dk];
  for (let k = 0; k < rings.length - 1; k++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const c = scaleLin(cols[k], i % 2 ? 1.0 : 0.94);
      mb.quad(rings[k][i], rings[k][j], rings[k + 1][j], rings[k + 1][i], c);
    }
  }
  const wz = -0.2;
  const cMid = hexLin('#8FE0F6');
  const cOut = hexLin('#3FA8E0');
  const ctr: Vec3 = [cx, cy, wz];
  for (let i = 0; i < n; i++) {
    const a0 = (2 * Math.PI * i) / n;
    const a1 = (2 * Math.PI * ((i + 1) % n)) / n;
    mb.tri(
      ctr,
      [cx + (rx + 0.45) * Math.cos(a0), cy + (ry + 0.45) * Math.sin(a0), wz],
      [cx + (rx + 0.45) * Math.cos(a1), cy + (ry + 0.45) * Math.sin(a1), wz],
      cMid,
      cOut,
      cOut,
      'glow',
    );
  }
  const cRip = hexLin('#DFF8FF');
  for (const [rr, wd] of [
    [0.52, 0.035],
    [0.8, 0.025],
  ] as [number, number][]) {
    for (let i = 0; i < n; i++) {
      if (i % 4 === 3) continue;
      const a0 = (2 * Math.PI * i) / n;
      const a1 = (2 * Math.PI * ((i + 1) % n)) / n;
      mb.quad(
        [cx + rx * rr * Math.cos(a0), cy + ry * rr * Math.sin(a0), wz + 0.008],
        [cx + rx * rr * Math.cos(a1), cy + ry * rr * Math.sin(a1), wz + 0.008],
        [cx + (rx * rr + wd) * Math.cos(a1), cy + (ry * rr + wd) * Math.sin(a1), wz + 0.008],
        [cx + (rx * rr + wd) * Math.cos(a0), cy + (ry * rr + wd) * Math.sin(a0), wz + 0.008],
        cRip,
        'glow',
      );
    }
  }
  const r0 = Math.min(rx, ry) * 0.26;
  mb.stack(
    cx,
    cy,
    [
      [r0 * 1.15, -0.5], [r0 * 1.15, -0.1], [r0, -0.06], [r0 * 0.9, 0.06],
      [r0 * 1.25, 0.1], [r0 * 1.3, 0.16], [r0 * 1.1, 0.17],
    ],
    [dk, stone, scaleLin(stone, 0.92), stoneHi, stone, stoneHi],
    { n: 10, cap: cMid },
  );
  mb.stack(cx, cy, [[r0 * 0.3, 0.16], [r0 * 0.24, 0.3], [r0 * 0.4, 0.33], [r0 * 0.4, 0.36]], [stone, stoneHi, stone], {
    n: 8,
    cap: cRip,
  });
  const wJet = hexLin('#DCF6FF');
  for (let k = 0; k < 8; k++) {
    const an = (2 * Math.PI * k) / 8 + 0.2;
    const pts: Vec3[] = [];
    for (let i = 0; i < 8; i++) {
      const t = i / 7;
      const rr = r0 * 0.3 + (Math.min(rx, ry) * 0.52 - r0 * 0.3) * t;
      const zz = 0.36 + 0.3 * Math.sin(Math.PI * Math.min(1.0, t * 1.25)) * (1 - t * 0.2) - 0.56 * Math.pow(t, 2.2);
      pts.push([cx + rr * Math.cos(an), cy + rr * Math.sin(an) * (ry / rx), zz]);
    }
    const px = -Math.sin(an) * 0.022;
    const py = Math.cos(an) * 0.022;
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i];
      const q = pts[i + 1];
      mb.quad([p[0] - px, p[1] - py, p[2]], [p[0] + px, p[1] + py, p[2]], [q[0] + px, q[1] + py, q[2]], [q[0] - px, q[1] - py, q[2]], wJet, 'water');
    }
  }
  mb.blob(cx, cy, 0.4, r0 * 0.3, r0 * 0.3, 0.07, cRip, hexLin('#FFFFFF'), { sub: 1, bucket: 'glow' });
}

export function addBridgePost(mb: HqMeshBuilder, x: number, y: number, h = 0.5) {
  const wood = hexLin('#8A5A3A');
  const dk = hexLin('#5E3E2C');
  mb.box(x - 0.055, x + 0.055, y - 0.055, y + 0.055, -0.05, h, wood, { top: scaleLin(wood, 1.2) });
  mb.box(x - 0.07, x + 0.07, y - 0.07, y + 0.07, h - 0.12, h - 0.06, hexLin('#E8D2A0'));
  mb.box(x - 0.07, x + 0.07, y - 0.07, y + 0.07, h, h + 0.04, dk);
}

// ------------------------------------------------------------------ Ground Details (`props.DETAILS`)
export function addDetailExtra(mb: HqMeshBuilder, kind: string, x: number, y: number, rng: SeededRng) {
  if (kind === 'cactus') {
    const g0 = hexLin('#4E9A5A');
    const g1 = hexLin('#8ED07A');
    if (rng.next() < 0.5) {
      const r = rng.uniform(0.07, 0.11);
      mb.blob(x, y, r * 0.8, r, r, r * 0.9, g0, g1, { sub: 1, smooth: false });
      mb.blob(x, y, r * 1.62, r * 0.3, r * 0.3, r * 0.22, hexLin('#FF7FA8'), hexLin('#FFC2D4'), { sub: 1, smooth: false });
    } else {
      const h = rng.uniform(0.2, 0.32);
      mb.blob(x, y, h * 0.5, 0.05, 0.05, h * 0.56, g0, g1, { sub: 1, smooth: false });
      const sg = rng.next() < 0.5 ? 1 : -1;
      mb.blob(x + sg * 0.07, y, h * 0.5, 0.045, 0.03, 0.03, g0, g0, { sub: 1, smooth: false });
      mb.blob(x + sg * 0.1, y, h * 0.66, 0.03, 0.03, h * 0.24, g0, g1, { sub: 1, smooth: false });
    }
  } else if (kind === 'dryshrub') {
    const c0 = hexLin('#8A7A46');
    const c1 = hexLin('#D6C27A');
    const cnt = rng.int(7, 12);
    for (let k = 0; k < cnt; k++) {
      const a = rng.uniform(0, 6.28);
      const L = rng.uniform(0.1, 0.2);
      const el = rng.uniform(0.5, 1.2);
      const tip: Vec3 = [x + Math.cos(a) * L * Math.cos(el), y + Math.sin(a) * L * Math.cos(el), L * Math.sin(el)];
      const w = 0.012;
      mb.tri([x - Math.sin(a) * w, y + Math.cos(a) * w, 0], [x + Math.sin(a) * w, y - Math.cos(a) * w, 0], tip, c0, c0, c1, 'foliage');
    }
  } else if (kind === 'mushroom') {
    const cap = hexLin(rng.choice(['#E8453C', '#E8453C', '#F0A23C', '#B86AD0']));
    const cnt = rng.int(1, 4);
    for (let k = 0; k < cnt; k++) {
      const ox = k ? rng.normal(0, 0.07) : 0;
      const oy = k ? rng.normal(0, 0.07) : 0;
      const h = rng.uniform(0.07, 0.13) * (k === 0 ? 1.0 : 0.7);
      const r = h * rng.uniform(0.7, 0.95);
      mb.stack(x + ox, y + oy, [[r * 0.3, 0], [r * 0.24, h]], hexLin('#FFF4E0'), { n: 6 });
      mb.blob(x + ox, y + oy, h, r, r, r * 0.6, cap, cap, { sub: 1, smooth: false, clampMinZ: -r * 0.08 });
      const wh = hexLin('#FFFFFF');
      for (let j = 0; j < 4; j++) {
        const an = (6.28 * j) / 4 + k;
        mb.blob(x + ox + Math.cos(an) * r * 0.5, y + oy + Math.sin(an) * r * 0.5, h + r * 0.44, r * 0.14, r * 0.14, r * 0.07, wh, wh, {
          sub: 1,
          smooth: false,
        });
      }
    }
  } else if (kind === 'fern') {
    const c0 = hexLin('#2F7E46');
    const c1 = hexLin('#8AD06A');
    const size = rng.uniform(0.2, 0.32);
    const cnt = rng.int(7, 11);
    for (let j = 0; j < cnt; j++) {
      const a = rng.uniform(0, 2 * Math.PI);
      const L = size * rng.uniform(0.7, 1.1);
      const wd = L * 0.2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const cm = lerpLin(c0, c1, rng.uniform(0.3, 1.0));
      mb.quad(
        [x, y, 0.01],
        [x + ca * L * 0.5 - sa * wd, y + sa * L * 0.5 + ca * wd, L * 0.5],
        [x + ca * L, y + sa * L, L * 0.22],
        [x + ca * L * 0.5 + sa * wd, y + sa * L * 0.5 - ca * wd, L * 0.5],
        c0,
        'foliage',
        cm,
        c1,
        cm,
      );
    }
  } else if (kind === 'heather') {
    const c0 = hexLin('#8E6CB4');
    const c1 = hexLin('#D9A6E8');
    const cnt = rng.int(4, 9);
    for (let k = 0; k < cnt; k++) {
      const ox = rng.normal(0, 0.1);
      const oy = rng.normal(0, 0.1);
      const r = rng.uniform(0.04, 0.075);
      mb.blob(x + ox, y + oy, r * 0.7, r, r, r * 0.9, c0, c1, { sub: 1, smooth: false });
    }
  } else if (kind === 'pots') {
    const r = rng.uniform(0.07, 0.1);
    mb.stack(
      x,
      y,
      [[r * 0.7, 0], [r, r * 1.5], [r * 1.1, r * 1.5], [r * 1.1, r * 1.8]],
      [hexLin('#C9704A'), hexLin('#E08A5E'), hexLin('#E08A5E')],
      { n: 8, cap: hexLin('#6A4A3A') },
    );
    if (rng.next() < 0.6) {
      const fc = hexLin(rng.choice(['#FF6A6A', '#FFD24A', '#FF9CC0', '#FFFFFF']));
      mb.blob(x, y, r * 2.4, r, r, r * 0.8, hexLin('#4FA65C'), hexLin('#8AD06A'), { sub: 1, smooth: false });
      for (let k = 0; k < 4; k++) {
        const an = (6.28 * k) / 4 + 0.4;
        mb.blob(x + Math.cos(an) * r * 0.6, y + Math.sin(an) * r * 0.6, r * 2.9, r * 0.32, r * 0.32, r * 0.26, fc, fc, {
          sub: 1,
          smooth: false,
        });
      }
    } else {
      mb.blob(x, y, r * 2.7, r * 0.9, r * 0.9, r * 1.3, hexLin('#3E8A56'), hexLin('#7CC46A'), { sub: 1, smooth: false });
    }
  } else if (kind === 'rubble') {
    const cnt = rng.int(1, 3);
    for (let k = 0; k < cnt; k++) {
      const ox = rng.normal(0, 0.1);
      const oy = rng.normal(0, 0.1);
      const s = rng.uniform(0.07, 0.12);
      const c = hexLin('#D6CCB4', rng.uniform(0.88, 1.06));
      mb.box(x + ox - s, x + ox + s, y + oy - s * 0.7, y + oy + s * 0.7, -0.02, s * rng.uniform(0.7, 1.2), c, {
        rz: rng.uniform(0, 3.14),
        tiltX: rng.uniform(-0.03, 0.03),
        tiltY: rng.uniform(-0.03, 0.03),
      });
    }
  }
}

// ------------------------------------------------------------------ Far Background Props & Signature Landmarks
export function addFarRoundTree(mb: HqMeshBuilder, x: number, y: number, z: number, s: number, rng: SeededRng, pal: [string, string, string], trunkHex: string) {
  const h = rng.uniform(0.85, 1.3) * s;
  mb.stack(x, y, [[0.14 * s, z - 0.08], [0.09 * s, z + h]], hexLin(trunkHex), { n: 6 });
  const cA = hexLin(pal[0]);
  const cB = hexLin(pal[1]);
  const cC = hexLin(pal[2]);
  const r = rng.uniform(0.48, 0.68) * s;
  mb.blob(x, y, z + h + r * 0.55, r, r, r * 0.88, cA, cB, { sub: 1 });
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2 + rng.uniform(0, 0.8);
    const rr = r * 0.52;
    const rb = r * rng.uniform(0.55, 0.72);
    mb.blob(x + Math.cos(a) * rr, y + Math.sin(a) * rr, z + h + r * rng.uniform(0.3, 0.72), rb, rb, rb * 0.85, cA, k % 2 ? cC : cB, { sub: 1 });
  }
}

export function addFarPine(mb: HqMeshBuilder, x: number, y: number, z: number, s: number, rng: SeededRng, pinePal: [string, string, string], trunkHex: string) {
  mb.stack(x, y, [[0.1 * s, z - 0.06], [0.07 * s, z + 0.5 * s]], hexLin(trunkHex), { n: 6 });
  const cols = [hexLin(pinePal[0]), hexLin(pinePal[1]), hexLin(pinePal[2])];
  const tiers = 3;
  for (let i = 0; i < tiers; i++) {
    const zb = z + (0.4 + i * 0.48) * s;
    const r = (0.64 - i * 0.14) * s;
    const h = (0.76 - i * 0.08) * s;
    mb.stack(x, y, [[r, zb], [0.03 * s, zb + h]], cols[i], { n: 7, rot0: i * 0.4 + rng.uniform(0, 0.4) });
  }
}

export function addFarBush(mb: HqMeshBuilder, x: number, y: number, z: number, s: number, rng: SeededRng, bushPal: [string, string]) {
  const c0 = hexLin(bushPal[0]);
  const c1 = hexLin(bushPal[1]);
  const r = 0.28 * s;
  mb.blob(x, y, z + r * 0.55, r, r, r * 0.72, c0, c1, { sub: 1 });
  for (let k = 0; k < 2; k++) {
    const a = rng.uniform(0, 6.28);
    const rb = r * rng.uniform(0.65, 0.85);
    mb.blob(x + Math.cos(a) * r * 0.65, y + Math.sin(a) * r * 0.65, z + rb * 0.5, rb, rb, rb * 0.7, c0, c1, { sub: 1 });
  }
}

export function addFarProp(
  mb: HqMeshBuilder,
  kind: string,
  x: number,
  y: number,
  z: number,
  s: number,
  rng: SeededRng,
  pal: HqPalette,
  treePal: [string, string, string],
) {
  if (kind === 'sakura') {
    const c = hexLin('#5A3A3A');
    mb.tube([[x, y, z - 0.05], [x + 0.04 * s, y, z + 0.5 * s], [x - 0.06 * s, y, z + 0.95 * s]], 0.11 * s, c, { r1: 0.07 * s });
    for (const sg of [-1, 1]) {
      mb.tube([[x, y, z + 0.5 * s], [x + sg * 0.3 * s, y + 0.05 * s, z + 0.9 * s], [x + sg * 0.5 * s, y, z + 1.15 * s]], 0.06 * s, c, {
        r1: 0.03 * s,
      });
    }
    const [cA, cB, cC] = treePal.map((h) => hexLin(h));
    const cnt = rng.int(6, 9);
    for (let k = 0; k < cnt; k++) {
      const a = rng.uniform(0, 6.28);
      const rr = rng.uniform(0.1, 0.62) * s;
      const r = rng.uniform(0.36, 0.56) * s;
      mb.blob(x + Math.cos(a) * rr, y + Math.sin(a) * rr, z + s * rng.uniform(1.05, 1.42), r, r, r * 0.62, cA, k % 3 ? cC : cB, { sub: 1 });
    }
  } else if (kind === 'palm') {
    const lean = rng.uniform(-0.35, 0.35) * s;
    const h = rng.uniform(1.5, 2.3) * s;
    const pts: Vec3[] = [0, 0.25, 0.5, 0.75, 1.0].map((t) => [x + lean * Math.pow(t, 1.6), y, z - 0.05 + h * t]);
    mb.tube(pts, 0.09 * s, hexLin('#A07A54'), { r1: 0.06 * s });
    const tx = x + lean;
    const tz = z + h;
    const g0 = hexLin('#3E9A58');
    const g1 = hexLin('#A4DC6A');
    for (let k = 0; k < 8; k++) {
      const a = (2 * Math.PI * k) / 8 + rng.uniform(-0.2, 0.2);
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const Lf = rng.uniform(0.7, 0.95) * s;
      const rows: [Vec3, Vec3, Vec3][] = [];
      const rowCols: LinRGB[] = [];
      for (let i = 0; i < 5; i++) {
        const t = i / 4;
        const r = Lf * t;
        const zz = tz + 0.22 * s * Math.sin(t * 2.2) - 0.5 * s * t * t;
        const w = 0.13 * s * Math.sin(Math.PI * (0.15 + 0.85 * t)) + 0.01;
        rows.push([
          [tx + ca * r - sa * w, y + sa * r + ca * w, zz - 0.04 * s],
          [tx + ca * r, y + sa * r, zz + 0.02 * s],
          [tx + ca * r + sa * w, y + sa * r - ca * w, zz - 0.04 * s],
        ]);
        rowCols.push(lerpLin(g0, g1, t));
      }
      for (let i = 0; i < 4; i++) {
        mb.quad(rows[i][0], rows[i][1], rows[i + 1][1], rows[i + 1][0], scaleLin(rowCols[i], 0.9), 'foliage', rowCols[i], rowCols[i + 1], scaleLin(rowCols[i + 1], 0.9));
        mb.quad(rows[i][1], rows[i][2], rows[i + 1][2], rows[i + 1][1], rowCols[i], 'foliage', scaleLin(rowCols[i], 0.9), scaleLin(rowCols[i + 1], 0.9), rowCols[i + 1]);
      }
    }
  } else if (kind === 'cactus') {
    const g0 = hexLin('#3F8A5A');
    const g1 = hexLin('#86C87A');
    const h = rng.uniform(0.9, 1.5) * s;
    const r = 0.13 * s;
    mb.tube([[x, y, z - 0.05], [x, y, z + h * 0.5], [x, y, z + h]], r, g0, { seg: 8, r1: r * 0.9 });
    mb.blob(x, y, z + h, r * 0.9, r * 0.9, r * 0.9, g0, g1, { sub: 1 });
    const arms = rng.choice([[-1], [1], [-1, 1]]);
    for (const sg of arms) {
      const zb = z + h * rng.uniform(0.35, 0.55);
      const ex = x + sg * 0.32 * s;
      mb.tube([[x, y, zb], [ex, y, zb], [ex, y, zb + 0.1 * s], [ex, y, zb + h * 0.35]], r * 0.7, g0, { seg: 7 });
      mb.blob(ex, y, zb + h * 0.35, r * 0.66, r * 0.66, r * 0.66, g0, g1, { sub: 1 });
    }
  } else if (kind === 'spire') {
    const bands = pal.spire_bands ?? ['#F2A070', '#D8704A', '#B8503E', '#F6C89A'];
    const a = rng.uniform(0.35, 0.6) * s;
    addHoodoo(mb, x, y, a, a * rng.uniform(0.8, 1.0), rng.uniform(1.6, 3.0) * s, rng, bands, { cap: rng.next() < 0.7, z: z - 0.1 });
  } else if (kind === 'juniper') {
    mb.tube([[x, y, z - 0.05], [x + 0.05 * s, y, z + 0.35 * s]], 0.07 * s, hexLin('#7A5E4A'));
    const g0 = hexLin('#4E7A4A');
    const g1 = hexLin('#9ABE6E');
    for (let k = 0; k < 3; k++) {
      const a = 2.1 * k + rng.uniform(0, 1);
      const r = rng.uniform(0.26, 0.38) * s;
      mb.blob(x + Math.cos(a) * 0.16 * s, y + Math.sin(a) * 0.16 * s, z + (0.42 + 0.12 * k) * s, r, r, r * 0.8, g0, g1, { sub: 1 });
    }
  } else if (kind === 'bare') {
    const c = hexLin('#8A7468');
    const h = rng.uniform(0.9, 1.4) * s;
    mb.tube([[x, y, z - 0.05], [x + 0.03 * s, y, z + h * 0.6], [x - 0.04 * s, y, z + h]], 0.07 * s, c, { r1: 0.025 * s });
    for (let k = 0; k < 4; k++) {
      const a = 1.6 * k + rng.uniform(0, 1);
      const zb = z + h * (0.4 + 0.13 * k);
      mb.tube(
        [[x, y, zb], [x + Math.cos(a) * 0.25 * s, y + Math.sin(a) * 0.25 * s, zb + 0.22 * s], [x + Math.cos(a) * 0.4 * s, y + Math.sin(a) * 0.4 * s, zb + 0.5 * s]],
        0.035 * s,
        c,
        { r1: 0.012 * s, seg: 5 },
      );
    }
  } else if (kind === 'cypress') {
    mb.tube([[x, y, z - 0.05], [x, y, z + 0.3 * s]], 0.06 * s, hexLin('#7A5E4A'));
    const h = rng.uniform(1.5, 2.3) * s;
    mb.blob(x, y, z + 0.2 * s + h * 0.5, 0.27 * s, 0.27 * s, h * 0.52, hexLin(pal.pine_pal[0]), hexLin(pal.pine_pal[2]), { sub: 1 });
  } else if (kind === 'heather') {
    addFarBush(mb, x, y, z, s * 1.3, rng, ['#8E6CB4', '#D9A6E8']);
  } else if (kind === 'house') {
    const w = rng.uniform(1.3, 2.0) * s;
    const d = rng.uniform(1.2, 1.7) * s;
    addHouse(mb, x - w * 0.5, y - d * 0.5, w, d, rng, rng.int(0, 50), 0.05, true, z);
  } else if (kind === 'bigtree') {
    const h = rng.uniform(1.6, 2.6) * s;
    const r = rng.uniform(0.2, 0.3) * s;
    mb.tube([[x, y, z - 0.1], [x + 0.03 * s, y, z + h * 0.5], [x, y, z + h]], r, hexLin('#6E4838'), { seg: 8, r1: r * 0.7 });
    const [cA, cB, cC] = treePal.map((h_) => hexLin(h_));
    const cnt = rng.int(6, 9);
    for (let k = 0; k < cnt; k++) {
      const a = rng.uniform(0, 6.28);
      const rr = rng.uniform(0.1, 0.75) * s;
      const rb = rng.uniform(0.6, 0.95) * s;
      mb.blob(x + Math.cos(a) * rr, y + Math.sin(a) * rr, z + h + s * rng.uniform(-0.1, 0.7), rb, rb, rb * 0.8, cA, k % 2 ? cC : cB, { sub: 1 });
    }
  } else if (kind === 'pine') {
    addFarPine(mb, x, y, z, s * 1.15, rng, pal.pine_pal, pal.trunk);
  } else {
    addFarRoundTree(mb, x, y, z, s, rng, treePal, pal.trunk);
  }
}

export function addLandmarkFeature(
  mb: HqMeshBuilder,
  fname: string,
  x: number,
  y: number,
  z: number,
  rng: SeededRng,
  pal: HqPalette,
) {
  const s = fname === 'shrooms' ? 1.2 : fname === 'arch' ? 1.1 : 1.0;
  if (fname === 'torii') {
    const red = hexLin('#E8432E');
    const dk = hexLin('#2E2630');
    const w = 1.25 * s;
    const h = 2.3 * s;
    for (const sg of [-1, 1]) {
      mb.stack(x + sg * w, y, [[0.13 * s, z - 0.1], [0.1 * s, z + h]], red, { n: 8 });
      mb.stack(x + sg * w, y, [[0.16 * s, z - 0.1], [0.16 * s, z + 0.22 * s]], dk, { n: 8 });
    }
    mb.box(x - w * 1.18, x + w * 1.18, y - 0.09 * s, y + 0.09 * s, z + h * 0.74, z + h * 0.82, red);
    mb.box(x - w * 1.4, x + w * 1.4, y - 0.11 * s, y + 0.11 * s, z + h * 0.96, z + h * 1.04, red);
    mb.box(x - w * 1.5, x + w * 1.5, y - 0.15 * s, y + 0.15 * s, z + h * 1.04, z + h * 1.11, dk);
    mb.box(x - 0.09 * s, x + 0.09 * s, y - 0.06 * s, y + 0.06 * s, z + h * 0.82, z + h * 0.96, red);
  } else if (fname === 'lantern') {
    const st = hexLin('#C9C4BC');
    const hi = hexLin('#E6E2DA');
    mb.stack(
      x,
      y,
      [
        [0.22 * s, z - 0.05], [0.2 * s, z + 0.1 * s], [0.09 * s, z + 0.14 * s],
        [0.08 * s, z + 0.62 * s], [0.2 * s, z + 0.68 * s], [0.2 * s, z + 0.74 * s],
      ],
      [st, hi, st, hi, st],
      { n: 6 },
    );
    mb.box(x - 0.12 * s, x + 0.12 * s, y - 0.12 * s, y + 0.12 * s, z + 0.74 * s, z + 0.96 * s, hexLin('#FFE08A'), { bucket: 'glow' });
    mb.stack(x, y, [[0.3 * s, z + 0.96 * s], [0.2 * s, z + 1.08 * s], [0.04 * s, z + 1.2 * s]], [st, hi], { n: 6 });
  } else if (fname === 'menhirs') {
    const st = [hexLin('#BCC6D4'), hexLin('#909CB2'), hexLin('#D8DEE8')];
    const R = 1.35 * s;
    for (let k = 0; k < 6; k++) {
      const a = (2 * Math.PI * k) / 6 + 0.3;
      const px = x + R * Math.cos(a);
      const py = y + R * Math.sin(a) * 0.8;
      const h = rng.uniform(1.1, 1.7) * s;
      mb.box(px - 0.2 * s, px + 0.2 * s, py - 0.13 * s, py + 0.13 * s, z - 0.1, z + h, st[k % 3], {
        top: st[2],
        rz: a + 1.57,
        tiltX: rng.uniform(-0.1, 0.1),
      });
    }
    for (const sg of [-1, 1]) {
      mb.box(x + sg * 0.45 * s - 0.17 * s, x + sg * 0.45 * s + 0.17 * s, y - 0.15 * s, y + 0.15 * s, z - 0.1, z + 1.7 * s, st[0], {
        top: st[2],
      });
    }
    mb.box(x - 0.75 * s, x + 0.75 * s, y - 0.18 * s, y + 0.18 * s, z + 1.7 * s, z + 1.98 * s, st[1], { top: st[2] });
  } else if (fname === 'lamp') {
    const wood = hexLin('#6E4838');
    mb.box(x - 0.05 * s, x + 0.05 * s, y - 0.05 * s, y + 0.05 * s, z - 0.05, z + 1.5 * s, wood);
    mb.box(x - 0.05 * s, x + 0.34 * s, y - 0.035 * s, y + 0.035 * s, z + 1.4 * s, z + 1.47 * s, wood);
    mb.box(x + 0.2 * s, x + 0.38 * s, y - 0.09 * s, y + 0.09 * s, z + 1.12 * s, z + 1.36 * s, hexLin('#FFD27A'), { bucket: 'glow' });
    mb.box(x + 0.17 * s, x + 0.41 * s, y - 0.12 * s, y + 0.12 * s, z + 1.36 * s, z + 1.4 * s, hexLin('#4A3430'));
  } else if (fname === 'columns') {
    const st = hexLin('#E6DCC4');
    const hi = hexLin('#F6EEDC');
    const hs = [2.0, 1.2, 2.2, 0.7];
    for (let k = 0; k < 4; k++) {
      const px = x + (k - 1.5) * 0.85 * s;
      const h = hs[k] * s * rng.uniform(0.9, 1.1);
      mb.stack(px, y, [[0.24 * s, z - 0.05], [0.24 * s, z + 0.12 * s], [0.17 * s, z + 0.14 * s], [0.15 * s, z + h]], [hi, st, scaleLin(st, 0.95)], {
        n: 10,
        cap: hi,
      });
      if (k === 0 || k === 2) {
        mb.box(px - 0.24 * s, px + 0.24 * s, y - 0.24 * s, y + 0.24 * s, z + h, z + h + 0.12 * s, hi);
      }
    }
    mb.box(x + 0.2 * s, x + 0.9 * s, y - 0.75 * s, y - 0.45 * s, z - 0.02, z + 0.26 * s, st, { rz: 0.4 });
  } else if (fname === 'arch') {
    const st = hexLin('#E0D6BE');
    const hi = hexLin('#F6EEDC');
    const w = 0.95 * s;
    const h = 1.9 * s;
    for (const sg of [-1, 1]) {
      mb.box(x + sg * w - 0.24 * s, x + sg * w + 0.24 * s, y - 0.24 * s, y + 0.24 * s, z - 0.1, z + h, st, { top: hi });
    }
    for (let k = 0; k < 9; k++) {
      if (k === 5 || k === 6) continue;
      const a0 = (Math.PI * k) / 9;
      const a1 = (Math.PI * (k + 1)) / 9;
      const V: [number, number][] = [
        [x + Math.cos(a0) * w * 0.76, z + h + Math.sin(a0) * w * 0.9 * 0.76],
        [x + Math.cos(a1) * w * 0.76, z + h + Math.sin(a1) * w * 0.9 * 0.76],
        [x + Math.cos(a1) * w * 1.24, z + h + Math.sin(a1) * w * 0.9 * 1.24],
        [x + Math.cos(a0) * w * 1.24, z + h + Math.sin(a0) * w * 0.9 * 1.24],
      ];
      const c = k % 2 ? hi : st;
      const f: Vec3[] = V.map((p) => [p[0], y - 0.22 * s, p[1]]);
      const b: Vec3[] = V.map((p) => [p[0], y + 0.22 * s, p[1]]);
      mb.quad(f[0], f[1], f[2], f[3], c);
      mb.quad(b[3], b[2], b[1], b[0], c);
      mb.quad(f[3], f[2], b[2], b[3], hi);
      mb.quad(f[1], f[0], b[0], b[1], scaleLin(st, 0.85));
    }
  } else if (fname === 'arch_rock') {
    const bands = pal.spire_bands ?? ['#F2A070', '#D8704A', '#B8503E', '#F6C89A'];
    const cols = bands.map((h) => hexLin(h));
    const w = 1.3 * s;
    addHoodoo(mb, x - w, y, 0.55 * s, 0.5 * s, 2.3 * s, rng, bands, { cap: false, z: z - 0.1 });
    addHoodoo(mb, x + w, y, 0.5 * s, 0.45 * s, 1.9 * s, rng, bands, { cap: false, z: z - 0.1 });
    for (let k = 0; k < 8; k++) {
      const t0 = k / 8;
      const t1 = (k + 1) / 8;
      const xa = x - w * 0.8 + 1.6 * w * t0;
      const xb = x - w * 0.8 + 1.6 * w * t1;
      const za = z + 1.9 * s + 0.5 * s * Math.sin(Math.PI * t0);
      const zb = z + 1.9 * s + 0.5 * s * Math.sin(Math.PI * t1);
      const th = 0.42 * s;
      const c = cols[k % cols.length];
      mb.quad([xa, y - 0.3 * s, za - th], [xb, y - 0.3 * s, zb - th], [xb, y - 0.3 * s, zb], [xa, y - 0.3 * s, za], c);
      mb.quad([xb, y + 0.3 * s, zb - th], [xa, y + 0.3 * s, za - th], [xa, y + 0.3 * s, za], [xb, y + 0.3 * s, zb], c);
      mb.quad([xa, y - 0.3 * s, za], [xb, y - 0.3 * s, zb], [xb, y + 0.3 * s, zb], [xa, y + 0.3 * s, za], scaleLin(cols[0], 1.15));
      mb.quad([xa, y + 0.3 * s, za - th], [xb, y + 0.3 * s, zb - th], [xb, y - 0.3 * s, zb - th], [xa, y - 0.3 * s, za - th], scaleLin(c, 0.7));
    }
  } else if (fname === 'spires') {
    for (let k = 0; k < 4; k++) {
      const a = 1.57 * k + rng.uniform(0, 1);
      addFarProp(mb, 'spire', x + Math.cos(a) * 0.9 * s, y + Math.sin(a) * 0.7 * s, z, s * rng.uniform(0.8, 1.3), rng, pal, pal.tree_pals[0][1]);
    }
  } else if (fname === 'tower') {
    addClockTower(mb, x, y, z, s * rng.uniform(0.95, 1.15));
  } else if (fname === 'shrooms') {
    for (let k = 0; k < 3; k++) {
      const a = 2.1 * k + rng.uniform(0, 1);
      const px = x + (k > 0 ? Math.cos(a) * 0.6 * s : 0);
      const py = y + (k > 0 ? Math.sin(a) * 0.6 * s : 0);
      const h = (k === 0 ? 1.5 : rng.uniform(0.6, 1.0)) * s;
      const r = h * 0.62;
      mb.stack(px, py, [[r * 0.26, z - 0.1], [r * 0.18, z + h * 0.6], [r * 0.2, z + h]], hexLin('#FFF4E0'), { n: 8, smooth: true });
      const cap = hexLin('#E8453C');
      mb.blob(px, py, z + h, r, r, r * 0.62, cap, cap, { sub: 2, smooth: true, clampMinZ: -r * 0.1 });
      const wh = hexLin('#FFFFFF');
      for (let j = 0; j < 7; j++) {
        const an = 0.9 * j + k;
        const rr = r * (0.3 + 0.08 * (j % 4));
        const dz = r * 0.62 * Math.sqrt(Math.max(0.05, 1 - (rr / r) * (rr / r))) - 0.01;
        mb.blob(px + Math.cos(an) * rr, py + Math.sin(an) * rr, z + h + dz, r * 0.13, r * 0.13, r * 0.05, wh, wh, { sub: 1 });
      }
    }
  }
}
