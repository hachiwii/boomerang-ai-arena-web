import * as THREE from 'three';
import { DState, PState, TickSnapshot } from '../game/types';

// Exact camera-facing tilt for 58° overhead camera: Rx(+32°) aims XZ normal (+Y) straight at camera!
const CAM_TILT_X = Math.PI * 0.5 - (58 * Math.PI) / 180;

interface ActiveBurst {
  kind:
    | 'ring'
    | 'disc'
    | 'star'
    | 'slash'
    | 'kick'
    | 'spark'
    | 'puff'
    | 'cube'
    | 'streak'
    | 'confetti'
    | 'ribbon';
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  rotY: number;
  scale0: number;
  scale1: number;
  scaleZ?: number;
  color: THREE.Color;
  bornSec: number;
  lifeSec: number;
  spin: number;
  gravity: number;
  flat?: boolean;
  alpha0?: number;
  drag?: number;
  flutter?: number;
  phase?: number;
  yFloor?: number;
}

class MeshPool {
  public readonly meshes: THREE.Mesh[] = [];
  private cursor = 0;

  constructor(
    scene: THREE.Scene,
    count: number,
    geo: THREE.BufferGeometry,
    baseMat: THREE.MeshBasicMaterial,
  ) {
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(geo, baseMat.clone());
      m.visible = false;
      m.frustumCulled = false;
      scene.add(m);
      this.meshes.push(m);
    }
  }

  public reset() {
    for (let i = 0; i < this.cursor; i++) {
      this.meshes[i].visible = false;
    }
    this.cursor = 0;
  }

  public take(): THREE.Mesh | null {
    if (this.cursor >= this.meshes.length) return null;
    const m = this.meshes[this.cursor++];
    m.visible = true;
    return m;
  }

  public dispose(scene: THREE.Scene) {
    if (this.meshes.length > 0) this.meshes[0].geometry.dispose();
    for (const m of this.meshes) {
      scene.remove(m);
      (m.material as THREE.Material).dispose();
    }
  }
}

type TrailPointKind = 'out' | 'return' | 'dash';

const RIBBON_ROWS: readonly [number, number][] = [
  [-1.0, 0.0],
  [-0.45, 1.0],
  [0.0, 1.0],
  [0.45, 1.0],
  [1.0, 0.0],
];

/**
 * 5-row feathered ribbon ported from render_bl.py Ribbon:
 * - Outbound dart: wide solid bright white core + feathered colored edges
 * - Return / recall dart: narrower, subtler core, dashed segments
 * - Dash wind stream: crisp white core with smooth post-dash fade-out
 */
class TrailRibbon {
  private readonly points: { x: number; y: number; z: number; kind: TrailPointKind }[] = [];
  private readonly maxPts: number;
  private readonly baseCol: THREE.Color;
  private readonly mesh: THREE.Mesh;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly colAttr: THREE.BufferAttribute;
  private readonly geo: THREE.BufferGeometry;
  private highQuality: boolean;
  private fadeAlpha = 1.0;

  constructor(scene: THREE.Scene, colorHex: string, maxPts = 16, highQuality = true) {
    this.maxPts = maxPts;
    this.baseCol = new THREE.Color(colorHex);
    this.highQuality = highQuality;

    const m = RIBBON_ROWS.length;
    const verts = new Float32Array(maxPts * m * 3);
    const colors = new Float32Array(maxPts * m * 4);
    const indices: number[] = [];

    for (let i = 0; i < maxPts - 1; i++) {
      for (let r = 0; r < m - 1; r++) {
        const a = i * m + r;
        indices.push(a, a + 1, a + 1 + m, a, a + 1 + m, a + m);
      }
    }

    this.geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(verts, 3);
    this.colAttr = new THREE.BufferAttribute(colors, 4);
    this.geo.setAttribute('position', this.posAttr);
    this.geo.setAttribute('color', this.colAttr);
    this.geo.setIndex(indices);

    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 1.0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  public setHighQuality(hq: boolean) {
    this.highQuality = hq;
  }

  public push(x: number, y: number, z: number, kind: TrailPointKind) {
    this.fadeAlpha = 1.0;
    if (this.points.length > 0) {
      const p0 = this.points[0];
      if (Math.hypot(x - p0.x, z - p0.z) < 0.04) {
        p0.kind = kind;
        return;
      }
    }
    this.points.unshift({ x, y, z, kind });
    if (this.points.length > this.maxPts) this.points.pop();
    this.rebuild();
  }

  /** Smoothly fades out an active trail (e.g. post-dash wind dissipation over 0.15s in HQ). */
  public fadeOut(dtSec: number, durationSec = 0.15) {
    if (this.points.length < 2) {
      this.clear();
      return;
    }
    this.fadeAlpha = Math.max(0, this.fadeAlpha - dtSec / Math.max(0.02, durationSec));
    if (this.fadeAlpha <= 0.02) {
      this.clear();
      return;
    }
    this.rebuild();
  }

  public clear() {
    this.points.length = 0;
    this.fadeAlpha = 1.0;
    this.mesh.visible = false;
  }

  private rebuild() {
    const n = this.points.length;
    if (n < 2) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;
    const pos = this.posAttr.array as Float32Array;
    const col = this.colAttr.array as Float32Array;
    const m = RIBBON_ROWS.length;
    const cr = this.baseCol.r;
    const cg = this.baseCol.g;
    const cb = this.baseCol.b;
    const fAlpha = this.fadeAlpha;
    const hq = this.highQuality;

    for (let i = 0; i < this.maxPts; i++) {
      const j = Math.min(i, n - 1);
      const p = this.points[j];
      const prev = this.points[Math.max(0, j - 1)];
      const next = this.points[Math.min(n - 1, j + 1)];
      let dx = prev.x - next.x;
      let dz = prev.z - next.z;
      const len = Math.hypot(dx, dz);
      let px = 0;
      let pz = 0;
      if (len > 1e-5) {
        dx /= len;
        dz /= len;
        px = -dz;
        pz = dx;
      }
      const t = j / Math.max(1, n - 1);

      let hw = 0;
      let al = 0;
      let core = 0;
      if (i < n) {
        if (p.kind === 'dash') {
          hw = 0.30 * Math.pow(1 - t, 0.6);
          al = 0.54 * Math.pow(1 - t, 1.4) * fAlpha;
          core = hq ? 0.9 : 0.4;
        } else if (p.kind === 'out') {
          const fade = Math.pow(1 - t, 1.25);
          hw = 0.27 * (0.25 + 0.75 * Math.pow(1 - t, 0.8));
          al = (hq ? 0.92 : 0.65) * fade * fAlpha;
          core = hq ? 0.7 : 0.35;
        } else {
          // Return / recall: narrower, subtler, segmented dashed look in HQ (render_bl.py trail_style)
          const fade = Math.pow(1 - t, 1.25);
          const dash = hq ? 0.45 + 0.55 * (((j >> 1) % 2 === 0) ? 1.0 : 0.25) : 1.0;
          hw = 0.15 * (0.3 + 0.7 * Math.pow(1 - t, 0.8));
          al = (hq ? 0.75 : 0.55) * fade * dash * fAlpha;
          core = hq ? 0.15 : 0.15;
        }
      }

      for (let r = 0; r < m; r++) {
        const [u, edgeA] = RIBBON_ROWS[r];
        const vIdx = i * m + r;
        const pOff = vIdx * 3;
        pos[pOff] = p.x + px * hw * u;
        pos[pOff + 1] = p.y + (r === 2 ? 0.004 : 0);
        pos[pOff + 2] = p.z + pz * hw * u;

        const cOff = vIdx * 4;
        if (r === 2) {
          col[cOff] = cr + (1 - cr) * core;
          col[cOff + 1] = cg + (1 - cg) * core;
          col[cOff + 2] = cb + (1 - cb) * core;
          col[cOff + 3] = al;
        } else {
          col[cOff] = cr;
          col[cOff + 1] = cg;
          col[cOff + 2] = cb;
          col[cOff + 3] = al * (hq ? edgeA * 0.8 : edgeA * 0.85);
        }
      }
    }
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
  }

  public dispose(scene: THREE.Scene) {
    scene.remove(this.mesh);
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/** Exact port of fx.py _ring_mesh: 4-band feathered ring in XZ plane. */
function createFeatheredRingGeo(rIn = 0.88): THREE.BufferGeometry {
  const seg = 44;
  const bands: [number, number][] = [
    [rIn - 0.08, 0.0],
    [rIn, 1.0],
    [1.0, 1.0],
    [1.06, 0.0],
  ];
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  for (const [r, a] of bands) {
    for (let k = 0; k < seg; k++) {
      const t = (2 * Math.PI * k) / seg;
      pos.push(r * Math.cos(t), 0, r * Math.sin(t));
      col.push(1, 1, 1, a);
    }
  }
  for (let j = 0; j < bands.length - 1; j++) {
    for (let k = 0; k < seg; k++) {
      const k2 = (k + 1) % seg;
      const a0 = j * seg + k;
      const a1 = j * seg + k2;
      const b0 = (j + 1) * seg + k;
      const b1 = (j + 1) * seg + k2;
      idx.push(a0, a1, b1, a0, b1, b0);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  geo.setIndex(idx);
  return geo;
}

/** Exact port of fx.py _disc_mesh: soft radial glowing disc in XZ plane. */
function createGlowDiscGeo(): THREE.BufferGeometry {
  const seg = 32;
  const pos: number[] = [0, 0, 0];
  const col: number[] = [1, 1, 1, 1];
  const idx: number[] = [];
  for (const [r, a] of [
    [0.5, 0.75],
    [1.0, 0.0],
  ]) {
    for (let k = 0; k < seg; k++) {
      const t = (2 * Math.PI * k) / seg;
      pos.push(r * Math.cos(t), 0, r * Math.sin(t));
      col.push(1, 1, 1, a);
    }
  }
  for (let k = 0; k < seg; k++) {
    const k2 = (k + 1) % seg;
    idx.push(0, 1 + k, 1 + k2);
    idx.push(1 + k, 1 + seg + k, 1 + seg + k2, 1 + k, 1 + seg + k2, 1 + k2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  geo.setIndex(idx);
  return geo;
}

/** Exact port of fx.py _star_mesh: comic starburst / 4-point spark in XZ plane. */
function createStarGeo(spikes = 8, rIn = 0.3, alt = 0.62): THREE.BufferGeometry {
  const pos: number[] = [0, 0, 0];
  const col: number[] = [1, 1, 1, 1];
  const idx: number[] = [];
  const n = spikes * 2;
  for (let k = 0; k < n; k++) {
    const t = (2 * Math.PI * k) / n;
    const r = k % 2 === 0 ? ((k >> 1) % 2 === 0 ? 1.0 : alt) : rIn;
    pos.push(r * Math.cos(t), 0, r * Math.sin(t));
    col.push(1, 1, 1, k % 2 === 1 ? 1.0 : 0.85);
  }
  for (let k = 0; k < n; k++) {
    idx.push(0, 1 + k, 1 + ((k + 1) % n));
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  geo.setIndex(idx);
  return geo;
}

/** Exact port of fx.py _arc_mesh: feathered crescent slash arc in XZ plane facing +X. */
function createCrescentArcGeo(): THREE.BufferGeometry {
  const seg = 26;
  const half = (62 * Math.PI) / 180;
  const r0 = 0.5;
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= seg; i++) {
    const u = i / seg;
    const ang = -half + 2 * half * u;
    const wid = Math.pow(Math.sin(Math.PI * u), 0.7);
    const ri = 1.0 - (1.0 - r0) * wid;
    const a = (0.15 + 0.85 * u) * Math.min(1.0, wid * 3.0);
    const rows: [number, number][] = [
      [ri, 0.0],
      [ri * 0.5 + 0.5, a * 0.75],
      [0.985, a],
      [1.03, 0.0],
    ];
    for (const [r, al] of rows) {
      pos.push(Math.cos(ang) * r, 0, Math.sin(ang) * r);
      col.push(1, 1, 1, al);
    }
  }
  for (let i = 0; i < seg; i++) {
    for (let j = 0; j < 3; j++) {
      const a0 = i * 4 + j;
      idx.push(a0, a0 + 1, a0 + 5, a0, a0 + 5, a0 + 4);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  geo.setIndex(idx);
  return geo;
}

/** Exact port of fx.py _streak_mesh: sharp tapered horizontal slice streak in XZ plane. */
function createFeatheredStreakGeo(): THREE.BufferGeometry {
  const n = 12;
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const x = -1.0 + 2.0 * u;
    const w = Math.pow(Math.sin(Math.PI * u), 0.6);
    const edge = Math.min(1.0, w * 2.5);
    for (const [zz, a] of [
      [-1.0, 0.0],
      [0.0, 1.0],
      [1.0, 0.0],
    ]) {
      pos.push(x, 0, zz * w);
      col.push(1, 1, 1, a * edge);
    }
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < 2; j++) {
      const a0 = i * 3 + j;
      idx.push(a0, a0 + 3, a0 + 4, a0, a0 + 4, a0 + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  geo.setIndex(idx);
  return geo;
}

const STEALTH_SEE_RADIUS_M = 2.5; // Exact cf.see_r = 2500mm from dart.hpp

function createStealthRingTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const half = size * 0.5;

  const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
  grad.addColorStop(0.0, 'rgba(255, 255, 255, 0.055)');
  grad.addColorStop(0.76, 'rgba(255, 255, 255, 0.075)');
  grad.addColorStop(0.92, 'rgba(255, 255, 255, 0.21)');
  grad.addColorStop(0.962, 'rgba(255, 255, 255, 0.88)');
  grad.addColorStop(0.985, 'rgba(255, 255, 255, 0.92)');
  grad.addColorStop(1.0, 'rgba(255, 255, 255, 0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Zero-allocation pooled 3D FX system + human aim reticle, recall progress & grass stealth ring.
 * In high graphics quality, restores all upstream Blender fx.py / render_bl.py effects:
 * feathered 5-row dashed/cored ribbons, starbursts & glow discs, 4-point star sparks, cloud sea splash,
 * poof smoke puffs, collapse dust, and dual-ring colored recall aura.
 */
export class FXSystem {
  private readonly scene: THREE.Scene;
  private readonly slotColors: THREE.Color[];
  private highQuality: boolean;

  private readonly rings: MeshPool;
  private readonly discs: MeshPool;
  private readonly stars: MeshPool;
  private readonly arcs: MeshPool;
  private readonly sparks: MeshPool;
  private readonly starSparks: MeshPool;
  private readonly puffs: MeshPool;
  private readonly cubes: MeshPool;
  private readonly ribbons: MeshPool;
  private readonly streaks: MeshPool;

  private readonly dartTrails: TrailRibbon[] = [];
  private readonly dashTrails: TrailRibbon[] = [];
  private readonly bursts: ActiveBurst[] = [];

  // Human tactical reticle, aim line, recall ring, and grass stealth detection ring (2.5m)
  private readonly reticleGroup = new THREE.Group();
  private readonly aimLine: THREE.Line;
  private readonly aimLinePositions = new Float32Array(6);
  private readonly recallRing: THREE.Mesh;
  private readonly stealthRing: THREE.Mesh;
  private readonly stealthTex: THREE.CanvasTexture;
  private stealthAlpha = 0;
  private lastNowSec = 0;

  private readonly _white = new THREE.Color('#ffffff');
  private readonly _yellow = new THREE.Color('#ffe066');
  private readonly _tmpCol = new THREE.Color();

  constructor(scene: THREE.Scene, slotColors: string[], highQuality = true) {
    this.scene = scene;
    this.slotColors = slotColors.map((c) => new THREE.Color(c));
    this.highQuality = highQuality;

    const vcolMat = (opacity = 1.0) =>
      new THREE.MeshBasicMaterial({
        color: '#ffffff',
        vertexColors: true,
        transparent: true,
        opacity,
        side: THREE.DoubleSide,
        depthWrite: false,
      });

    this.rings = new MeshPool(scene, 40, createFeatheredRingGeo(0.88), vcolMat(0.95));
    this.discs = new MeshPool(scene, 16, createGlowDiscGeo(), vcolMat(0.95));
    this.stars = new MeshPool(scene, 16, createStarGeo(8, 0.3, 0.62), vcolMat(1.0));
    this.arcs = new MeshPool(scene, 12, createCrescentArcGeo(), vcolMat(0.95));
    this.streaks = new MeshPool(scene, 14, createFeatheredStreakGeo(), vcolMat(1.0));
    this.starSparks = new MeshPool(scene, 110, createStarGeo(4, 0.22, 1.0), vcolMat(1.0));

    const sparkGeo = new THREE.OctahedronGeometry(0.14, 0);
    this.sparks = new MeshPool(
      scene,
      96,
      sparkGeo,
      new THREE.MeshBasicMaterial({
        color: '#ffffff',
        transparent: true,
        opacity: 1.0,
      }),
    );

    const puffGeo = new THREE.IcosahedronGeometry(0.28, 1);
    this.puffs = new MeshPool(
      scene,
      110,
      puffGeo,
      new THREE.MeshBasicMaterial({
        color: '#fffbf2',
        transparent: true,
        opacity: 0.72,
        depthWrite: false,
      }),
    );

    const cubeGeo = new THREE.BoxGeometry(0.1, 0.1, 0.1);
    this.cubes = new MeshPool(
      scene,
      140,
      cubeGeo,
      new THREE.MeshBasicMaterial({
        color: '#ffffff',
        transparent: true,
        opacity: 1.0,
      }),
    );

    const ribbonGeo = new THREE.PlaneGeometry(0.18, 0.072);
    this.ribbons = new MeshPool(
      scene,
      180,
      ribbonGeo,
      new THREE.MeshBasicMaterial({
        color: '#ffffff',
        transparent: true,
        opacity: 1.0,
        side: THREE.DoubleSide,
      }),
    );

    for (const c of slotColors) {
      this.dartTrails.push(new TrailRibbon(scene, c, 16, highQuality));
      this.dashTrails.push(new TrailRibbon(scene, '#ffffff', 11, highQuality));
    }

    // Human aim reticle
    const outerR = new THREE.RingGeometry(0.22, 0.29, 24);
    outerR.rotateX(-Math.PI / 2);
    const outerM = new THREE.Mesh(
      outerR,
      new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.92, depthWrite: false }),
    );
    const innerDot = new THREE.CircleGeometry(0.06, 12);
    innerDot.rotateX(-Math.PI / 2);
    const dotM = new THREE.Mesh(
      innerDot,
      new THREE.MeshBasicMaterial({ color: '#3D7EFF', transparent: true, opacity: 0.95, depthWrite: false }),
    );
    this.reticleGroup.add(outerM, dotM);
    this.reticleGroup.position.y = 0.04;
    this.reticleGroup.visible = false;
    scene.add(this.reticleGroup);

    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(this.aimLinePositions, 3));
    const lineMat = new THREE.LineBasicMaterial({
      color: '#9ec5ff',
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    });
    this.aimLine = new THREE.Line(lineGeo, lineMat);
    this.aimLine.visible = false;
    scene.add(this.aimLine);

    // Recall charge ring around player
    const rcGeo = new THREE.RingGeometry(0.56, 0.72, 32);
    rcGeo.rotateX(-Math.PI / 2);
    this.recallRing = new THREE.Mesh(
      rcGeo,
      new THREE.MeshBasicMaterial({
        color: '#6bb6ff',
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.recallRing.position.y = 0.05;
    this.recallRing.visible = false;
    scene.add(this.recallRing);

    // Grass stealth detection range circle (exact 2.5m radius = cf.see_r, translucent white LoL Twitch style)
    this.stealthTex = createStealthRingTexture();
    const stGeo = new THREE.CircleGeometry(STEALTH_SEE_RADIUS_M, 64);
    stGeo.rotateX(-Math.PI / 2);
    this.stealthRing = new THREE.Mesh(
      stGeo,
      new THREE.MeshBasicMaterial({
        map: this.stealthTex,
        color: '#ffffff',
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.stealthRing.position.y = 0.048;
    this.stealthRing.renderOrder = 1;
    this.stealthRing.visible = false;
    scene.add(this.stealthRing);
  }

  public setHighQuality(hq: boolean) {
    this.highQuality = hq;
    for (const r of this.dartTrails) r.setHighQuality(hq);
    for (const r of this.dashTrails) r.setHighQuality(hq);
  }

  public spawnSlash(x: number, z: number, angleRad: number, colorHex: string, nowSec: number) {
    const col = new THREE.Color(colorHex).lerp(this._white, 0.45);
    this.bursts.push({
      kind: 'slash',
      x,
      y: 0.55,
      z,
      vx: 0,
      vy: 0,
      vz: 0,
      rotY: -angleRad,
      scale0: 1.29,
      scale1: 1.5,
      color: this._white.clone(),
      bornSec: nowSec,
      lifeSec: 0.28,
      spin: 2.2,
      gravity: 0,
    });
    this.bursts.push({
      kind: 'slash',
      x,
      y: 0.5,
      z,
      vx: 0,
      vy: 0,
      vz: 0,
      rotY: -angleRad - 0.25,
      scale0: 1.11,
      scale1: 1.35,
      color: col,
      bornSec: nowSec,
      lifeSec: 0.32,
      spin: 2.0,
      gravity: 0,
      alpha0: 0.8,
    });
  }

  public spawnKick(x: number, z: number, angleRad: number, nowSec: number) {
    this.bursts.push({
      kind: 'kick',
      x,
      y: 0.4,
      z,
      vx: 0,
      vy: 0,
      vz: 0,
      rotY: -angleRad,
      scale0: 0.8,
      scale1: 1.2,
      color: this._white.clone(),
      bornSec: nowSec,
      lifeSec: 0.22,
      spin: 0,
      gravity: 0,
      alpha0: 0.85,
    });
  }

  public spawnKickHit(x: number, z: number, nowSec: number) {
    if (this.highQuality) {
      this.bursts.push({
        kind: 'star',
        x,
        y: 0.55,
        z,
        vx: 0,
        vy: 0,
        vz: 0,
        rotY: nowSec * 1.7,
        scale0: 0.22,
        scale1: 0.82,
        color: this._white.clone(),
        bornSec: nowSec,
        lifeSec: 0.22,
        spin: 0,
        gravity: 0,
        flat: false,
      });
    }
    this.bursts.push({
      kind: 'ring',
      x,
      y: 0.06,
      z,
      vx: 0,
      vy: 0,
      vz: 0,
      rotY: 0,
      scale0: 0.4,
      scale1: 1.4,
      color: this._white.clone(),
      bornSec: nowSec,
      lifeSec: 0.28,
      spin: 0,
      gravity: 0,
      alpha0: 0.75,
    });
    this.spawnSparks(x, 0.55, z, 6, 3.6, this._yellow, nowSec, 0.3, 0.14);
  }

  public spawnDrop(x: number, z: number, nowSec: number) {
    if (this.highQuality) {
      this.bursts.push({
        kind: 'star',
        x,
        y: 0.3,
        z,
        vx: 0,
        vy: 0,
        vz: 0,
        rotY: nowSec * 3.1,
        scale0: 0.14,
        scale1: 0.44,
        color: this._yellow.clone().lerp(this._white, 0.5),
        bornSec: nowSec,
        lifeSec: 0.16,
        spin: 0,
        gravity: 0,
        flat: false,
      });
    }
    this.spawnDust(x, z, nowSec, 3, 0.9, 0.72, 0.72);
  }

  public spawnClash(x: number, z: number, colA: string, colB: string, nowSec: number) {
    if (this.highQuality) {
      this.bursts.push({
        kind: 'disc',
        x,
        y: 0.66,
        z,
        vx: 0,
        vy: 0,
        vz: 0,
        rotY: 0,
        scale0: 0.25,
        scale1: 0.95,
        color: this._white.clone(),
        bornSec: nowSec,
        lifeSec: 0.14,
        spin: 0,
        gravity: 0,
        alpha0: 0.65,
      });
      this.bursts.push({
        kind: 'star',
        x,
        y: 0.68,
        z,
        vx: 0,
        vy: 0,
        vz: 0,
        rotY: 0.4 + nowSec * 2.3,
        scale0: 0.28,
        scale1: 1.05,
        color: this._yellow.clone().lerp(this._white, 0.6),
        bornSec: nowSec,
        lifeSec: 0.27,
        spin: 0.4,
        gravity: 0,
        flat: false,
      });
    }
    this.bursts.push({
      kind: 'ring',
      x,
      y: 0.66,
      z,
      vx: 0,
      vy: 0,
      vz: 0,
      rotY: 0,
      scale0: 0.4,
      scale1: 1.7,
      color: this._white.clone(),
      bornSec: nowSec,
      lifeSec: 0.3,
      spin: 0,
      gravity: 0,
      alpha0: 0.82,
    });
    const ca = new THREE.Color(colA).lerp(this._white, 0.25);
    const cb = new THREE.Color(colB).lerp(this._white, 0.25);
    this.spawnSparks(x, 0.66, z, 10, 4.8, ca, nowSec, 0.42, 0.17, cb);
  }

  public spawnBlock(x: number, z: number, colorHex: string, nowSec: number, dartColorHex?: string) {
    if (this.highQuality) {
      this.spawnClash(x, z, colorHex, dartColorHex || '#ffe066', nowSec);
      return;
    }
    this.bursts.push({
      kind: 'ring',
      x,
      y: 0.6,
      z,
      vx: 0,
      vy: 0,
      vz: 0,
      rotY: 0,
      scale0: 0.3,
      scale1: 1.35,
      color: this._yellow.clone(),
      bornSec: nowSec,
      lifeSec: 0.26,
      spin: 0,
      gravity: 0,
    });
    this.spawnSparks(x, 0.6, z, 8, 4.4, new THREE.Color(colorHex), nowSec, 0.32);
  }

  /**
   * Non-sliced impact burst (melee slash kill — fx.py:257-266):
   * glow disc + dual counter-rotated comic 8-point starbursts + ground ring + sparks.
   */
  public spawnHit(x: number, z: number, killerColor: string, nowSec: number) {
    const c = new THREE.Color(killerColor);
    const cl = c.clone().lerp(this._white, 0.45);
    if (this.highQuality) {
      this.bursts.push({
        kind: 'disc',
        x,
        y: 0.6,
        z,
        vx: 0,
        vy: 0,
        vz: 0,
        rotY: 0,
        scale0: 0.25,
        scale1: 1.05,
        color: this._white.clone(),
        bornSec: nowSec,
        lifeSec: 0.15,
        spin: 0,
        gravity: 0,
        alpha0: 0.42,
      });
      this.bursts.push({
        kind: 'star',
        x,
        y: 0.62,
        z,
        vx: 0,
        vy: 0,
        vz: 0,
        rotY: nowSec * 1.7,
        scale0: 0.3,
        scale1: 1.3,
        color: c.clone().lerp(this._white, 0.2),
        bornSec: nowSec,
        lifeSec: 0.27,
        spin: 0.25,
        gravity: 0,
        flat: false,
      });
      this.bursts.push({
        kind: 'star',
        x,
        y: 0.65,
        z,
        vx: 0,
        vy: 0,
        vz: 0,
        rotY: nowSec * 1.7 + 0.39,
        scale0: 0.2,
        scale1: 0.74,
        color: this._white.clone(),
        bornSec: nowSec,
        lifeSec: 0.23,
        spin: -0.25,
        gravity: 0,
        flat: false,
      });
    }
    this.bursts.push({
      kind: 'ring',
      x,
      y: 0.06,
      z,
      vx: 0,
      vy: 0,
      vz: 0,
      rotY: 0,
      scale0: 0.5,
      scale1: 2.0,
      color: cl,
      bornSec: nowSec,
      lifeSec: 0.33,
      spin: 0,
      gravity: 0,
      alpha0: 0.85,
    });
    this.spawnSparks(x, 0.6, z, 8, 5.0, cl, nowSec, 0.4, 0.17, this._white);
  }

  public spawnSliceHit(
    x: number,
    z: number,
    dx: number,
    dz: number,
    victimColor: string,
    killerColor: string,
    nowSec: number,
  ) {
    const ang = Math.atan2(dz, dx);
    const vc = new THREE.Color(victimColor);
    const kc = new THREE.Color(killerColor).lerp(this._white, 0.55);
    const waistY = 0.38;

    // Double-layered feathered slice streak (colored outer + razor-sharp white inner core, fx.py:277-279)
    this.bursts.push({
      kind: 'streak',
      x: x + dx * 0.25,
      y: waistY,
      z: z + dz * 0.25,
      vx: 0,
      vy: 0,
      vz: 0,
      rotY: -ang,
      scale0: 0.55,
      scale1: 2.4,
      scaleZ: 0.2,
      color: kc,
      bornSec: nowSec,
      lifeSec: 0.22,
      spin: 0,
      gravity: 0,
      alpha0: 0.92,
    });
    if (this.highQuality) {
      this.bursts.push({
        kind: 'streak',
        x: x + dx * 0.25,
        y: waistY + 0.02,
        z: z + dz * 0.25,
        vx: 0,
        vy: 0,
        vz: 0,
        rotY: -ang,
        scale0: 0.5,
        scale1: 2.2,
        scaleZ: 0.08,
        color: this._white.clone(),
        bornSec: nowSec,
        lifeSec: 0.2,
        spin: 0,
        gravity: 0,
        alpha0: 1.0,
      });
      this.bursts.push({
        kind: 'ring',
        x,
        y: waistY,
        z,
        vx: 0,
        vy: 0,
        vz: 0,
        rotY: 0,
        scale0: 0.35,
        scale1: 1.1,
        color: this._white.clone(),
        bornSec: nowSec,
        lifeSec: 0.18,
        spin: 0,
        gravity: 0,
        alpha0: 0.72,
      });
    }
    this.bursts.push({
      kind: 'ring',
      x,
      y: 0.06,
      z,
      vx: 0,
      vy: 0,
      vz: 0,
      rotY: 0,
      scale0: 0.45,
      scale1: 1.95,
      color: kc,
      bornSec: nowSec,
      lifeSec: 0.34,
      spin: 0,
      gravity: 0,
      alpha0: 0.85,
    });
    this.spawnSparks(x, 0.55, z, 9, 5.2, kc, nowSec, 0.38, 0.17, this._white);

    // Flying voxel cubes spraying along slice direction
    const pale = vc.clone().lerp(this._white, 0.68);
    const sx = -dz;
    const sz = dx;
    for (let i = 0; i < 10; i++) {
      const r1 = Math.random();
      const r2 = Math.random();
      const sg = i % 2 === 0 ? 1 : -1;
      const alongV = 2.0 * (0.4 + r2);
      const outV = sg * (0.8 + 1.1 * r2);
      this.bursts.push({
        kind: 'cube',
        x: x + dx * ((r1 - 0.3) * 0.25),
        y: waistY,
        z: z + dz * ((r1 - 0.3) * 0.25),
        vx: dx * alongV + sx * outV,
        vy: 1.8 + r1 * 2.2,
        vz: dz * alongV + sz * outV,
        rotY: Math.random() * 6,
        scale0: 0.75 + r2 * 0.55,
        scale1: 0.08,
        color: i % 3 === 0 ? vc : pale,
        bornSec: nowSec,
        lifeSec: 0.62,
        spin: 6 + r1 * 7,
        gravity: 9.2,
      });
    }
  }

  public spawnDust(
    x: number,
    z: number,
    nowSec: number,
    count = 4,
    spread = 1.4,
    sizeScale = 1.0,
    alpha0 = 0.75,
    y0 = 0.14,
  ) {
    for (let i = 0; i < count; i++) {
      const a = (i / Math.max(1, count)) * Math.PI * 2 + Math.random() * 0.7;
      const sp = spread * (0.5 + Math.random() * 0.7);
      this.bursts.push({
        kind: 'puff',
        x,
        y: y0,
        z,
        vx: Math.cos(a) * sp,
        vy: 0.55 + Math.random() * 0.55,
        vz: Math.sin(a) * sp,
        rotY: Math.random() * 6,
        scale0: 0.55 * sizeScale,
        scale1: 1.25 * sizeScale,
        color: this._white.clone(),
        bornSec: nowSec,
        lifeSec: 0.4,
        spin: 2,
        gravity: 0,
        alpha0,
        drag: 2.2,
      });
    }
  }

  /** Collapse crack / breakaway dust (fx.py:381-398). */
  public spawnCollapseDust(
    x: number,
    y: number,
    z: number,
    nowSec: number,
    count: number,
    spread: number,
    sizeScale: number,
    alpha0: number,
    riseVy = -0.35,
  ) {
    if (!this.highQuality) return;
    for (let i = 0; i < count; i++) {
      const a = (i / Math.max(1, count)) * Math.PI * 2 + Math.random() * 1.4;
      const sp = spread * (0.55 + Math.random() * 0.75);
      this.bursts.push({
        kind: 'puff',
        x,
        y,
        z,
        vx: Math.cos(a) * sp,
        vy: riseVy + Math.random() * 0.25,
        vz: Math.sin(a) * sp,
        rotY: Math.random() * 6,
        scale0: 0.55 * sizeScale,
        scale1: 1.35 * sizeScale,
        color: this._white.clone(),
        bornSec: nowSec,
        lifeSec: count === 1 ? 0.28 : 0.5,
        spin: 1.5,
        gravity: 0,
        alpha0,
        drag: 2.4,
        yFloor: -20,
      });
    }
  }

  /** Disappear "poof" cloud + tilted ring + sparks (fx.py:322-327). */
  public spawnPoof(x: number, y: number, z: number, colorHex: string, nowSec: number, size = 1.0) {
    if (!this.highQuality) return;
    const cl = new THREE.Color(colorHex).lerp(this._white, 0.45);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.random() * 0.5;
      const sp = 1.4 * size * (0.6 + Math.random() * 0.65);
      this.bursts.push({
        kind: 'puff',
        x,
        y: Math.max(0.08, y - 0.15),
        z,
        vx: Math.cos(a) * sp,
        vy: 0.45 + Math.random() * 0.4,
        vz: Math.sin(a) * sp,
        rotY: Math.random() * 6,
        scale0: 0.6 * size,
        scale1: 1.5 * size,
        color: this._white.clone(),
        bornSec: nowSec,
        lifeSec: 0.46,
        spin: 1.8,
        gravity: 0,
        alpha0: 0.9,
        drag: 2.5,
      });
    }
    this.bursts.push({
      kind: 'ring',
      x,
      y,
      z,
      vx: 0,
      vy: 0,
      vz: 0,
      rotY: 0,
      scale0: 0.3 * size,
      scale1: 1.3 * size,
      color: cl,
      bornSec: nowSec,
      lifeSec: 0.36,
      spin: 0,
      gravity: 0,
      flat: false,
      alpha0: 0.82,
    });
    this.spawnSparks(x, y, z, 7, 3.8 * size, cl, nowSec, 0.44, 0.16 * size, this._white);
  }

  /** Pit-fall start head cry sparks (fx.py:334-335). */
  public spawnFallCry(x: number, z: number, nowSec: number) {
    if (!this.highQuality) return;
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + Math.random() * 0.6;
      const sp = 0.85 + Math.random() * 0.5;
      this.bursts.push({
        kind: 'spark',
        x,
        y: 1.35,
        z,
        vx: Math.cos(a) * sp,
        vy: 2.2 + Math.random() * 1.1,
        vz: Math.sin(a) * sp,
        rotY: Math.random() * 6,
        scale0: 0.12,
        scale1: 0.04,
        color: this._white.clone(),
        bornSec: nowSec,
        lifeSec: 0.32,
        spin: 6,
        gravity: 5.5,
        flat: false,
      });
    }
  }

  /** Cloud-sea impact plume when a falling victim hits y = -10.5 (fx.py:328-333). */
  public spawnCloudSplash(x: number, z: number, nowSec: number, y = -10.5) {
    if (!this.highQuality) return;
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + Math.random() * 0.45;
      const sp = 2.6 * (0.65 + Math.random() * 0.65);
      this.bursts.push({
        kind: 'puff',
        x,
        y: y - 0.3,
        z,
        vx: Math.cos(a) * sp,
        vy: 1.1 + Math.random() * 0.7,
        vz: Math.sin(a) * sp,
        rotY: Math.random() * 6,
        scale0: 1.8,
        scale1: 4.3,
        color: this._white.clone(),
        bornSec: nowSec,
        lifeSec: 0.78,
        spin: 1.0,
        gravity: 0,
        alpha0: 0.92,
        drag: 2.2,
        yFloor: -25,
      });
    }
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.random() * 0.7;
      const sp = 0.9 * (0.6 + Math.random() * 0.6);
      this.bursts.push({
        kind: 'puff',
        x,
        y: y - 0.1,
        z,
        vx: Math.cos(a) * sp,
        vy: 2.0 + Math.random() * 0.7,
        vz: Math.sin(a) * sp,
        rotY: Math.random() * 6,
        scale0: 1.3,
        scale1: 3.1,
        color: this._white.clone(),
        bornSec: nowSec,
        lifeSec: 0.6,
        spin: 1.2,
        gravity: 0,
        alpha0: 0.88,
        drag: 2.0,
        yFloor: -25,
      });
    }
    this.bursts.push({
      kind: 'ring',
      x,
      y: y + 0.12,
      z,
      vx: 0,
      vy: 0,
      vz: 0,
      rotY: 0,
      scale0: 0.6,
      scale1: 2.9,
      color: this._white.clone(),
      bornSec: nowSec,
      lifeSec: 0.44,
      spin: 0,
      gravity: 0,
      alpha0: 0.8,
      yFloor: -25,
    });
  }

  public spawnCatch(x: number, z: number, colorHex: string, nowSec: number) {
    const cl = new THREE.Color(colorHex).lerp(this._white, 0.45);
    this.bursts.push({
      kind: 'ring',
      x,
      y: 0.72,
      z,
      vx: 0,
      vy: 0,
      vz: 0,
      rotY: 0,
      scale0: 0.78,
      scale1: 0.25,
      color: cl,
      bornSec: nowSec,
      lifeSec: 0.24,
      spin: 0,
      gravity: 0,
      alpha0: 0.85,
    });
    if (this.highQuality) {
      this.spawnSparks(x, 0.8, z, 4, 2.2, this._white, nowSec, 0.26, 0.11);
    }
  }

  public spawnTurn(x: number, z: number, colorHex: string, nowSec: number) {
    this.bursts.push({
      kind: 'ring',
      x,
      y: 0.82,
      z,
      vx: 0,
      vy: 0,
      vz: 0,
      rotY: 0,
      scale0: 0.3,
      scale1: 0.88,
      color: new THREE.Color(colorHex).lerp(this._white, 0.45),
      bornSec: nowSec,
      lifeSec: 0.28,
      spin: 0,
      gravity: 0,
      alpha0: 0.82,
    });
  }

  public spawnConfetti(x: number, z: number, winnerColor: string, nowSec: number) {
    const palette = [
      new THREE.Color(winnerColor),
      new THREE.Color('#ffffff'),
      new THREE.Color('#ffe066'),
      new THREE.Color('#ff8fa8'),
      new THREE.Color('#7fd8ff'),
    ];
    for (let i = 0; i < 48; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 1.0 + Math.random() * 3.8;
      this.bursts.push({
        kind: 'confetti',
        x,
        y: 1.15,
        z,
        vx: Math.cos(a) * sp,
        vy: 3.4 + Math.random() * 4.0,
        vz: Math.sin(a) * sp,
        rotY: Math.random() * 6,
        scale0: 1.0,
        scale1: 0.7,
        color: palette[i % palette.length],
        bornSec: nowSec,
        lifeSec: 2.2,
        spin: 7 + Math.random() * 8,
        gravity: 4.2,
      });
    }
  }

  public spawnWinnerConfettiBurst(
    x: number,
    z: number,
    winnerColorHex: string,
    nowSec: number,
    waveIndex = 0,
  ) {
    const palette = [
      new THREE.Color(winnerColorHex),
      new THREE.Color('#ffe04d'),
      new THREE.Color('#ff5c93'),
      new THREE.Color('#4cd8ff'),
      new THREE.Color('#6cf283'),
      new THREE.Color('#ff8c38'),
      new THREE.Color('#c38bff'),
      new THREE.Color('#ffffff'),
    ];
    const hash = (k: number) => {
      const s = Math.sin(k * 127.1 + waveIndex * 311.7) * 43758.5453;
      return s - Math.floor(s);
    };
    const count = 32;
    for (let i = 0; i < count; i++) {
      const r1 = hash(i * 3 + 1);
      const r2 = hash(i * 3 + 2);
      const r3 = hash(i * 3 + 3);
      const ang = (i / count) * Math.PI * 2 + (r1 - 0.5) * 0.28 + waveIndex * 0.45;
      const startR = 0.22 + r2 * 0.2;
      const horizSp = 1.65 + r1 * 1.75;
      const vy = 1.25 + r2 * 0.95;
      const sc = 0.85 + r3 * 0.45;
      this.bursts.push({
        kind: 'ribbon',
        x: x + Math.cos(ang) * startR,
        y: 0.88 + r3 * 0.34,
        z: z + Math.sin(ang) * startR,
        vx: Math.cos(ang) * horizSp,
        vy,
        vz: Math.sin(ang) * horizSp,
        rotY: ang + r1 * Math.PI,
        scale0: sc,
        scale1: sc * 0.82,
        color: palette[(i + waveIndex) % palette.length],
        bornSec: nowSec,
        lifeSec: 1.75 + r3 * 0.45,
        spin: 6.5 + r2 * 7.5,
        gravity: 2.15,
        drag: 1.85,
        flutter: 0.08 + r1 * 0.06,
        phase: r3 * Math.PI * 2,
      });
    }
  }

  private spawnSparks(
    x: number,
    y: number,
    z: number,
    count: number,
    speed: number,
    color: THREE.Color,
    nowSec: number,
    lifeSec: number,
    starSize = 0.15,
    color2?: THREE.Color,
  ) {
    const hq = this.highQuality;
    for (let i = 0; i < count; i++) {
      const a = (i / Math.max(1, count)) * Math.PI * 2 + Math.random() * 0.5;
      const sp = speed * (0.55 + Math.random() * 0.65);
      const col = color2 ? (i % 2 === 1 ? color2 : color) : i % 2 === 0 ? color : this._white;
      const sz = hq ? starSize * (0.7 + Math.random() * 0.6) : 1.0;
      this.bursts.push({
        kind: 'spark',
        x,
        y,
        z,
        vx: Math.cos(a) * sp,
        vy: 1.4 + Math.random() * 2.2,
        vz: Math.sin(a) * sp,
        rotY: Math.random() * 6,
        scale0: sz,
        scale1: hq ? sz * 0.35 : 0.1,
        color: col.clone(),
        bornSec: nowSec,
        lifeSec,
        spin: hq ? 8 : 10,
        gravity: 6.8,
        flat: false,
        drag: hq ? 2.4 : undefined,
      });
    }
  }

  public update(
    nowSec: number,
    prev: TickSnapshot,
    curr: TickSnapshot,
    alpha: number,
    humanSeat: number,
    aimX: number,
    aimZ: number,
    hasMouse: boolean,
    humanInGrass = false,
    spottedByAny = false,
  ) {
    const dt = Math.max(0.001, Math.min(0.08, nowSec - this.lastNowSec));
    this.lastNowSec = nowSec;
    const hq = this.highQuality;

    // 1. Reset pooled FX
    this.rings.reset();
    this.discs.reset();
    this.stars.reset();
    this.arcs.reset();
    this.sparks.reset();
    this.starSparks.reset();
    this.puffs.reset();
    this.cubes.reset();
    this.ribbons.reset();
    this.streaks.reset();

    // 2. Update dart & dash ribbons
    for (let k = 0; k < curr.n; k++) {
      const d = curr.darts[k];
      const d0 = prev.darts[k];
      const flying = d.st === DState.OUT || d.st === DState.BACK || d.st === DState.CALL;
      if (flying && this.dartTrails[k]) {
        const usePrev = d0.st !== DState.HAND && d0.st !== DState.GONE;
        const dx = (usePrev ? d0.x + (d.x - d0.x) * alpha : d.x) / 1000;
        const dz = (usePrev ? d0.y + (d.y - d0.y) * alpha : d.y) / 1000;
        let dy = 0.66;
        if (hq && d.st === DState.BACK && d.age < 4) {
          const hangU = Math.min(1, Math.max(0, (d.age + alpha) / 3.6));
          dy += 0.22 * Math.sin(Math.PI * hangU);
        }
        this.dartTrails[k].push(dx, dy, dz, d.st === DState.OUT ? 'out' : 'return');
      } else if (this.dartTrails[k]) {
        this.dartTrails[k].clear();
      }

      const p = curr.players[k];
      const p0 = prev.players[k];
      if (p.alive && p.st === PState.DASH && p.timer > 2 && p.timer <= 6 && this.dashTrails[k]) {
        const px = (p0.x + (p.x - p0.x) * alpha) / 1000;
        const pz = (p0.y + (p.y - p0.y) * alpha) / 1000;
        this.dashTrails[k].push(px, 0.45, pz, 'dash');
      } else if (this.dashTrails[k]) {
        if (hq && p.alive) {
          this.dashTrails[k].fadeOut(dt, 0.15);
        } else {
          this.dashTrails[k].clear();
        }
      }

      // Continuous stun stars (camera-tilted 4-point stars in HQ!)
      if (p.alive && p.st === PState.STUN) {
        const px = (p0.x + (p.x - p0.x) * alpha) / 1000;
        const pz = (p0.y + (p.y - p0.y) * alpha) / 1000;
        for (let j = 0; j < 3; j++) {
          const m = hq ? this.starSparks.take() : this.sparks.take();
          if (!m) break;
          const a = nowSec * 10.5 + j * 2.094;
          m.position.set(px + Math.cos(a) * 0.34, 1.5 + 0.05 * Math.sin(a * 2), pz + Math.sin(a) * 0.31);
          if (hq) {
            m.rotation.order = 'XYZ';
            m.rotation.set(CAM_TILT_X, nowSec * 8 + j, 0);
            m.scale.setScalar(0.15);
          } else {
            m.rotation.set(a, a * 0.7, 0);
            m.scale.setScalar(0.85);
          }
          (m.material as THREE.MeshBasicMaterial).color.copy(this._yellow);
          (m.material as THREE.MeshBasicMaterial).opacity = 0.95;
        }
      }

      // Continuous recall aura (dual phase-offset rising colored rings + dart glow disc in HQ!)
      if (p.alive && p.st === PState.RECALL) {
        const px = (p0.x + (p.x - p0.x) * alpha) / 1000;
        const pz = (p0.y + (p.y - p0.y) * alpha) / 1000;
        const baseC = this.slotColors[k] ?? this._white;
        this._tmpCol.copy(baseC).lerp(this._white, 0.4);
        const colHex = hq ? this._tmpCol : null;

        const ringCount = hq ? 2 : 1;
        for (let j = 0; j < ringCount; j++) {
          const ph = ((nowSec * 3.33 + j * 0.5) % 1 + 1) % 1;
          const rm = this.rings.take();
          if (rm) {
            rm.rotation.set(0, 0, 0);
            rm.position.set(px, 0.04 + ph * 1.0, pz);
            const sc = 0.85 - 0.6 * ph;
            rm.scale.set(sc, 1, sc);
            const rMat = rm.material as THREE.MeshBasicMaterial;
            if (colHex) rMat.color.copy(colHex);
            else rMat.color.set('#7fd4ff');
            rMat.opacity = Math.sin(Math.PI * ph) * 0.78;
          }
        }
        const dm = this.rings.take();
        if (dm) {
          const ph2 = ((nowSec * 4.0) % 1 + 1) % 1;
          dm.rotation.set(0, 0, 0);
          dm.position.set(d.x / 1000, 0.04, d.y / 1000);
          const sc = 0.25 + 0.52 * ph2;
          dm.scale.set(sc, 1, sc);
          const dMat = dm.material as THREE.MeshBasicMaterial;
          if (colHex) dMat.color.copy(colHex);
          else dMat.color.set('#7fd4ff');
          dMat.opacity = (1 - ph2) * 0.82;
        }
        if (hq) {
          const gd = this.discs.take();
          if (gd) {
            const prog = Math.max(0, Math.min(1, 1 - p.timer / 12));
            gd.rotation.set(0, 0, 0);
            gd.position.set(d.x / 1000, 0.025, d.y / 1000);
            gd.scale.set(0.55, 1, 0.55);
            const gMat = gd.material as THREE.MeshBasicMaterial;
            gMat.color.copy(this._tmpCol);
            gMat.opacity = 0.28 + 0.28 * prog;
          }
        }
      }
    }

    // 3. Advance active bursts
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i];
      const age = nowSec - b.bornSec;
      if (age < 0 || age >= b.lifeSec) {
        if (age >= b.lifeSec) this.bursts.splice(i, 1);
        continue;
      }
      const u = age / b.lifeSec;
      const e = 1 - Math.pow(1 - u, 3);
      const floorY = b.yFloor ?? 0.05;
      let x: number;
      let y: number;
      let z: number;
      if (b.kind === 'ribbon') {
        const k = b.drag ?? 1.85;
        const damped = (1 - Math.exp(-k * age)) / k;
        const fl = (b.flutter ?? 0.1) * Math.sin(age * 6.5 + (b.phase ?? 0)) * Math.min(1, age * 2);
        x = b.x + b.vx * damped + fl;
        z = b.z + b.vz * damped + fl * 0.7;
        y = Math.max(0.04, b.y + b.vy * age - 0.5 * b.gravity * age * age);
      } else if (b.drag && b.drag > 0) {
        const k = b.drag;
        const damped = (1 - Math.exp(-k * age)) / k;
        x = b.x + b.vx * damped;
        z = b.z + b.vz * damped;
        y = Math.max(floorY, b.y + b.vy * age - 0.5 * b.gravity * age * age);
      } else {
        x = b.x + b.vx * age;
        y = Math.max(floorY, b.y + b.vy * age - 0.5 * b.gravity * age * age);
        z = b.z + b.vz * age;
      }
      const sc = b.scale0 + (b.scale1 - b.scale0) * e;
      const baseAlpha = b.alpha0 ?? 1.0;
      const op =
        b.kind === 'ribbon'
          ? Math.max(0, 1 - Math.pow(Math.max(0, (u - 0.65) / 0.35), 2))
          : b.kind === 'slash' || b.kind === 'kick'
            ? Math.min(1, u / 0.14) * Math.max(0, 1 - Math.max(0, (u - 0.3) / 0.7))
            : b.kind === 'star'
              ? Math.max(0, 1 - Math.pow(Math.max(0, (u - 0.35) / 0.65), 1.3))
              : Math.max(0, 1 - u * u);

      let m: THREE.Mesh | null = null;
      if (b.kind === 'ring') m = this.rings.take();
      else if (b.kind === 'disc') m = this.discs.take();
      else if (b.kind === 'star') m = this.stars.take();
      else if (b.kind === 'slash' || b.kind === 'kick') m = this.arcs.take();
      else if (b.kind === 'spark') m = hq ? this.starSparks.take() : this.sparks.take();
      else if (b.kind === 'puff') m = this.puffs.take();
      else if (b.kind === 'cube' || b.kind === 'confetti') m = this.cubes.take();
      else if (b.kind === 'ribbon') m = this.ribbons.take();
      else if (b.kind === 'streak') m = this.streaks.take();

      if (!m) continue;
      m.position.set(x, y, z);
      m.rotation.order = 'XYZ';

      if (b.kind === 'slash') {
        m.rotation.set(0, b.rotY + (0.65 - 1.15 * e), 0);
        m.scale.set(sc, 1, sc);
      } else if (b.kind === 'kick') {
        m.rotation.set(0, b.rotY, 0);
        m.scale.set(sc, 1, sc * 0.75);
      } else if (b.kind === 'ring') {
        m.rotation.set(b.flat === false ? CAM_TILT_X : 0, 0, 0);
        m.scale.set(sc, 1, sc);
      } else if (b.kind === 'disc') {
        m.rotation.set(b.flat === false ? CAM_TILT_X : 0, 0, 0);
        m.scale.set(sc, 1, sc);
      } else if (b.kind === 'star') {
        m.rotation.set(CAM_TILT_X, b.rotY + age * b.spin, 0);
        m.scale.set(sc, 1, sc);
      } else if (b.kind === 'streak') {
        const sy = b.scaleZ ?? 0.2;
        m.rotation.set(0, b.rotY, 0);
        m.scale.set(sc, 1, sy * (1 - u * 0.35));
      } else if (b.kind === 'spark' && hq) {
        m.rotation.set(CAM_TILT_X, b.rotY + age * b.spin, 0);
        m.scale.set(sc, 1, sc);
      } else if (b.kind === 'ribbon') {
        m.rotation.set(age * b.spin, b.rotY + age * b.spin * 0.65, Math.sin(age * 7.5 + (b.phase ?? 0)) * 0.9);
        m.scale.setScalar(sc);
      } else {
        m.rotation.set(age * b.spin, b.rotY + age * b.spin * 0.6, age * b.spin * 0.4);
        m.scale.setScalar(sc);
      }
      const mat = m.material as THREE.MeshBasicMaterial;
      mat.color.copy(b.color);
      mat.opacity = (b.kind === 'puff' ? op * 0.72 : op) * baseAlpha;
    }

    // 4. Human tactical aim line & recall progress ring
    this.reticleGroup.visible = false;
    if (humanSeat >= 0 && !curr.over && curr.players[humanSeat]?.alive && hasMouse) {
      const hp0 = prev.players[humanSeat];
      const hp1 = curr.players[humanSeat];
      const hd = curr.darts[humanSeat];
      const hx = (hp0.x + (hp1.x - hp0.x) * alpha) / 1000;
      const hz = (hp0.y + (hp1.y - hp0.y) * alpha) / 1000;

      const dx = aimX - hx;
      const dz = aimZ - hz;
      const dist = Math.hypot(dx, dz) || 1;
      const maxLen = hd.st === DState.HAND ? Math.min(dist, 7.2) : Math.min(dist, 3.0);
      this.aimLinePositions[0] = hx;
      this.aimLinePositions[1] = 0.06;
      this.aimLinePositions[2] = hz;
      this.aimLinePositions[3] = hx + (dx / dist) * maxLen;
      this.aimLinePositions[4] = 0.06;
      this.aimLinePositions[5] = hz + (dz / dist) * maxLen;
      (this.aimLine.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      const aimLineCol =
        hd.st === DState.HAND
          ? '#8ec2ff'
          : hd.st === DState.OUT || hd.st === DState.BACK || hd.st === DState.CALL
            ? '#ffe066'
            : '#ff6e6e';
      (this.aimLine.material as THREE.LineBasicMaterial).color.set(aimLineCol);
      this.aimLine.visible = true;

      if (hp1.st === PState.RECALL) {
        const prog = Math.max(0, Math.min(1, 1 - hp1.timer / 12));
        this.recallRing.visible = true;
        this.recallRing.position.set(hx, 0.05, hz);
        const s = 0.75 + prog * 0.45;
        this.recallRing.scale.set(s, 1, s);
      } else {
        this.recallRing.visible = false;
      }
    } else {
      this.aimLine.visible = false;
      this.recallRing.visible = false;
    }

    // 5. Grass stealth detection range circle (2.5m translucent white ring around human while in grass)
    const showStealth = humanSeat >= 0 && !curr.over && curr.players[humanSeat]?.alive === 1 && humanInGrass;
    const targetAlpha = showStealth ? 1 : 0;
    const fadeK = 1 - Math.exp(-dt * 14);
    this.stealthAlpha += (targetAlpha - this.stealthAlpha) * fadeK;
    if (this.stealthAlpha > 0.01 && humanSeat >= 0 && curr.players[humanSeat]) {
      const hp0 = prev.players[humanSeat];
      const hp1 = curr.players[humanSeat];
      const hx = (hp0.x + (hp1.x - hp0.x) * alpha) / 1000;
      const hz = (hp0.y + (hp1.y - hp0.y) * alpha) / 1000;
      this.stealthRing.visible = true;
      this.stealthRing.position.set(hx, 0.048, hz);
      const pulse = spottedByAny
        ? 0.86 + 0.14 * Math.sin(nowSec * 9.5)
        : 0.72 + 0.06 * Math.sin(nowSec * 3.0);
      const stMat = this.stealthRing.material as THREE.MeshBasicMaterial;
      stMat.opacity = this.stealthAlpha * pulse;
    } else {
      this.stealthRing.visible = false;
      if (!showStealth) this.stealthAlpha = 0;
    }
  }

  public clearAll() {
    this.bursts.length = 0;
    this.rings.reset();
    this.discs.reset();
    this.stars.reset();
    this.arcs.reset();
    this.sparks.reset();
    this.starSparks.reset();
    this.puffs.reset();
    this.cubes.reset();
    this.ribbons.reset();
    this.streaks.reset();
    for (const r of this.dartTrails) r.clear();
    for (const r of this.dashTrails) r.clear();
  }

  public dispose() {
    this.rings.dispose(this.scene);
    this.discs.dispose(this.scene);
    this.stars.dispose(this.scene);
    this.arcs.dispose(this.scene);
    this.sparks.dispose(this.scene);
    this.starSparks.dispose(this.scene);
    this.puffs.dispose(this.scene);
    this.cubes.dispose(this.scene);
    this.ribbons.dispose(this.scene);
    this.streaks.dispose(this.scene);
    for (const r of this.dartTrails) r.dispose(this.scene);
    for (const r of this.dashTrails) r.dispose(this.scene);
    this.scene.remove(this.reticleGroup);
    this.scene.remove(this.aimLine);
    this.scene.remove(this.recallRing);
    this.scene.remove(this.stealthRing);
    this.stealthRing.geometry.dispose();
    (this.stealthRing.material as THREE.Material).dispose();
    this.stealthTex.dispose();
  }
}
