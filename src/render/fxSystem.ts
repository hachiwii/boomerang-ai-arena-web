import * as THREE from 'three';
import { DState, PState, TickSnapshot } from '../game/types';

interface ActiveBurst {
  kind: 'ring' | 'slash' | 'kick' | 'spark' | 'puff' | 'cube' | 'streak' | 'confetti' | 'ribbon';
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  rotY: number;
  scale0: number;
  scale1: number;
  color: THREE.Color;
  bornSec: number;
  lifeSec: number;
  spin: number;
  gravity: number;
  drag?: number;
  flutter?: number;
  phase?: number;
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

class TrailRibbon {
  private readonly points: { x: number; y: number; z: number }[] = [];
  private readonly maxPts: number;
  private readonly mesh: THREE.Mesh;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly geo: THREE.BufferGeometry;

  constructor(scene: THREE.Scene, colorHex: string, maxPts = 14) {
    this.maxPts = maxPts;
    const verts = new Float32Array(maxPts * 2 * 3);
    const colors = new Float32Array(maxPts * 2 * 3);
    const indices: number[] = [];
    const col = new THREE.Color(colorHex);
    const white = new THREE.Color('#ffffff');
    const c = new THREE.Color();

    for (let i = 0; i < maxPts; i++) {
      const t = i / (maxPts - 1);
      c.copy(col).lerp(white, (1 - t) * 0.45);
      for (let side = 0; side < 2; side++) {
        const idx = (i * 2 + side) * 3;
        colors[idx] = c.r;
        colors[idx + 1] = c.g;
        colors[idx + 2] = c.b;
      }
      if (i < maxPts - 1) {
        const a = i * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }

    this.geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(verts, 3);
    this.geo.setAttribute('position', this.posAttr);
    this.geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.geo.setIndex(indices);

    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.65,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  public push(x: number, y: number, z: number, halfWidth: number) {
    if (this.points.length > 0) {
      const p0 = this.points[0];
      if (Math.hypot(x - p0.x, z - p0.z) < 0.04) return;
    }
    this.points.unshift({ x, y, z });
    if (this.points.length > this.maxPts) this.points.pop();
    this.rebuild(halfWidth);
  }

  public clear() {
    this.points.length = 0;
    this.mesh.visible = false;
  }

  private rebuild(maxHalfW: number) {
    const n = this.points.length;
    if (n < 2) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;
    const arr = this.posAttr.array as Float32Array;
    for (let i = 0; i < this.maxPts; i++) {
      const j = Math.min(i, n - 1);
      const p = this.points[j];
      const prev = this.points[Math.max(0, j - 1)];
      const next = this.points[Math.min(n - 1, j + 1)];
      let dx = prev.x - next.x;
      let dz = prev.z - next.z;
      const len = Math.hypot(dx, dz) || 1;
      dx /= len;
      dz /= len;
      const px = -dz;
      const pz = dx;
      const t = j / (n - 1);
      const hw = i < n ? maxHalfW * (1 - t) : 0;

      const idx = i * 6;
      arr[idx] = p.x + px * hw;
      arr[idx + 1] = p.y;
      arr[idx + 2] = p.z + pz * hw;
      arr[idx + 3] = p.x - px * hw;
      arr[idx + 4] = p.y;
      arr[idx + 5] = p.z - pz * hw;
    }
    this.posAttr.needsUpdate = true;
  }

  public dispose(scene: THREE.Scene) {
    scene.remove(this.mesh);
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

function createCrescentArcGeo(): THREE.BufferGeometry {
  const seg = 20;
  const half = (62 * Math.PI) / 180;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= seg; i++) {
    const u = i / seg;
    const ang = -half + 2 * half * u;
    const wid = Math.pow(Math.sin(Math.PI * u), 0.7);
    const rIn = 1.0 - 0.52 * wid;
    const rOut = 1.0;
    pos.push(Math.cos(ang) * rIn, 0, Math.sin(ang) * rIn);
    pos.push(Math.cos(ang) * rOut, 0, Math.sin(ang) * rOut);
    if (i < seg) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
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

  // Radial translucent white fill + soft inner feathered halo + crisp outer edge ring (LoL Twitch style!)
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
 */
export class FXSystem {
  private readonly scene: THREE.Scene;
  private readonly rings: MeshPool;
  private readonly arcs: MeshPool;
  private readonly sparks: MeshPool;
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

  constructor(scene: THREE.Scene, slotColors: string[]) {
    this.scene = scene;

    const ringGeo = new THREE.RingGeometry(0.84, 1.0, 28);
    ringGeo.rotateX(-Math.PI / 2);
    this.rings = new MeshPool(scene, 36, ringGeo, new THREE.MeshBasicMaterial({
      color: '#ffffff',
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
    }));

    this.arcs = new MeshPool(scene, 10, createCrescentArcGeo(), new THREE.MeshBasicMaterial({
      color: '#ffffff',
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
    }));

    const sparkGeo = new THREE.OctahedronGeometry(0.14, 0);
    this.sparks = new MeshPool(scene, 96, sparkGeo, new THREE.MeshBasicMaterial({
      color: '#ffffff',
      transparent: true,
      opacity: 1.0,
    }));

    const puffGeo = new THREE.DodecahedronGeometry(0.28, 0);
    this.puffs = new MeshPool(scene, 64, puffGeo, new THREE.MeshBasicMaterial({
      color: '#fff8ec',
      transparent: true,
      opacity: 0.65,
      depthWrite: false,
    }));

    const cubeGeo = new THREE.BoxGeometry(0.1, 0.1, 0.1);
    this.cubes = new MeshPool(scene, 140, cubeGeo, new THREE.MeshBasicMaterial({
      color: '#ffffff',
      transparent: true,
      opacity: 1.0,
    }));

    const ribbonGeo = new THREE.PlaneGeometry(0.18, 0.072);
    this.ribbons = new MeshPool(scene, 180, ribbonGeo, new THREE.MeshBasicMaterial({
      color: '#ffffff',
      transparent: true,
      opacity: 1.0,
      side: THREE.DoubleSide,
    }));

    const streakGeo = new THREE.PlaneGeometry(2.0, 0.24);
    streakGeo.rotateX(-Math.PI / 2);
    this.streaks = new MeshPool(scene, 10, streakGeo, new THREE.MeshBasicMaterial({
      color: '#ffffff',
      transparent: true,
      opacity: 0.95,
      side: THREE.DoubleSide,
      depthWrite: false,
    }));

    for (const c of slotColors) {
      this.dartTrails.push(new TrailRibbon(scene, c, 15));
      this.dashTrails.push(new TrailRibbon(scene, '#ffffff', 10));
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
      scale0: 1.25,
      scale1: 1.55,
      color: this._white.clone(),
      bornSec: nowSec,
      lifeSec: 0.24,
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
      scale0: 1.1,
      scale1: 1.42,
      color: col,
      bornSec: nowSec,
      lifeSec: 0.28,
      spin: 2.0,
      gravity: 0,
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
      scale1: 1.28,
      color: this._white.clone(),
      bornSec: nowSec,
      lifeSec: 0.2,
      spin: 0,
      gravity: 0,
    });
  }

  public spawnKickHit(x: number, z: number, nowSec: number) {
    this.bursts.push({
      kind: 'ring',
      x,
      y: 0.08,
      z,
      vx: 0,
      vy: 0,
      vz: 0,
      rotY: 0,
      scale0: 0.35,
      scale1: 1.4,
      color: this._white.clone(),
      bornSec: nowSec,
      lifeSec: 0.26,
      spin: 0,
      gravity: 0,
    });
    this.spawnSparks(x, 0.55, z, 6, 3.6, this._yellow, nowSec, 0.28);
  }

  public spawnClash(x: number, z: number, colA: string, colB: string, nowSec: number) {
    this.bursts.push({
      kind: 'ring',
      x,
      y: 0.66,
      z,
      vx: 0,
      vy: 0,
      vz: 0,
      rotY: 0,
      scale0: 0.35,
      scale1: 1.8,
      color: this._white.clone(),
      bornSec: nowSec,
      lifeSec: 0.3,
      spin: 0,
      gravity: 0,
    });
    this.spawnSparks(x, 0.66, z, 6, 4.8, new THREE.Color(colA), nowSec, 0.38);
    this.spawnSparks(x, 0.66, z, 6, 4.8, new THREE.Color(colB), nowSec, 0.38);
  }

  public spawnBlock(x: number, z: number, colorHex: string, nowSec: number) {
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

  public spawnSliceHit(x: number, z: number, dx: number, dz: number, victimColor: string, killerColor: string, nowSec: number) {
    const ang = Math.atan2(dz, dx);
    const vc = new THREE.Color(victimColor);
    const kc = new THREE.Color(killerColor).lerp(this._white, 0.55);

    this.bursts.push({
      kind: 'streak',
      x: x + dx * 0.25,
      y: 0.42,
      z: z + dz * 0.25,
      vx: 0,
      vy: 0,
      vz: 0,
      rotY: -ang,
      scale0: 0.6,
      scale1: 2.3,
      color: kc,
      bornSec: nowSec,
      lifeSec: 0.22,
      spin: 0,
      gravity: 0,
    });
    this.bursts.push({
      kind: 'ring',
      x,
      y: 0.08,
      z,
      vx: 0,
      vy: 0,
      vz: 0,
      rotY: 0,
      scale0: 0.4,
      scale1: 1.9,
      color: kc,
      bornSec: nowSec,
      lifeSec: 0.34,
      spin: 0,
      gravity: 0,
    });
    this.spawnSparks(x, 0.55, z, 10, 5.2, kc, nowSec, 0.36);

    // Flying voxel cubes from the slice cut!
    const pale = vc.clone().lerp(this._white, 0.68);
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2;
      const spd = 1.4 + Math.random() * 3.2;
      this.bursts.push({
        kind: 'cube',
        x,
        y: 0.42,
        z,
        vx: dx * 2.2 + Math.cos(a) * spd,
        vy: 2.2 + Math.random() * 2.6,
        vz: dz * 2.2 + Math.sin(a) * spd,
        rotY: Math.random() * 6,
        scale0: 0.8 + Math.random() * 0.7,
        scale1: 0.1,
        color: i % 3 === 0 ? vc : pale,
        bornSec: nowSec,
        lifeSec: 0.62,
        spin: 8 + Math.random() * 8,
        gravity: 9.5,
      });
    }
  }

  public spawnDust(x: number, z: number, nowSec: number, count = 4, spread = 1.4) {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.7;
      const sp = spread * (0.5 + Math.random() * 0.7);
      this.bursts.push({
        kind: 'puff',
        x,
        y: 0.14,
        z,
        vx: Math.cos(a) * sp,
        vy: 0.6 + Math.random() * 0.6,
        vz: Math.sin(a) * sp,
        rotY: Math.random() * 6,
        scale0: 0.55,
        scale1: 1.25,
        color: this._white.clone(),
        bornSec: nowSec,
        lifeSec: 0.36,
        spin: 2,
        gravity: 0,
      });
    }
  }

  public spawnCatch(x: number, z: number, colorHex: string, nowSec: number) {
    this.bursts.push({
      kind: 'ring',
      x,
      y: 0.65,
      z,
      vx: 0,
      vy: 0,
      vz: 0,
      rotY: 0,
      scale0: 0.85,
      scale1: 0.25,
      color: new THREE.Color(colorHex).lerp(this._white, 0.5),
      bornSec: nowSec,
      lifeSec: 0.22,
      spin: 0,
      gravity: 0,
    });
  }

  public spawnTurn(x: number, z: number, colorHex: string, nowSec: number) {
    this.bursts.push({
      kind: 'ring',
      x,
      y: 0.66,
      z,
      vx: 0,
      vy: 0,
      vz: 0,
      rotY: 0,
      scale0: 0.3,
      scale1: 0.88,
      color: new THREE.Color(colorHex).lerp(this._white, 0.5),
      bornSec: nowSec,
      lifeSec: 0.26,
      spin: 0,
      gravity: 0,
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

  /**
   * Periodic festive ribbon-confetti burst tailored for the Winner Front Close-Up camera:
   * pops radially outward 360° around the celebrating winner and flutters slowly downward
   * right inside the close-up frame (deterministic per wave for crisp MP4 & GIF parity).
   */
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
  ) {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.5;
      const sp = speed * (0.55 + Math.random() * 0.65);
      this.bursts.push({
        kind: 'spark',
        x,
        y,
        z,
        vx: Math.cos(a) * sp,
        vy: 1.4 + Math.random() * 2.2,
        vz: Math.sin(a) * sp,
        rotY: Math.random() * 6,
        scale0: 1.0,
        scale1: 0.1,
        color: i % 2 === 0 ? color : this._white,
        bornSec: nowSec,
        lifeSec,
        spin: 10,
        gravity: 7.0,
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
    // 1. Reset pooled FX
    this.rings.reset();
    this.arcs.reset();
    this.sparks.reset();
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
        this.dartTrails[k].push(dx, 0.66, dz, d.st === DState.OUT ? 0.24 : 0.14);
      } else if (this.dartTrails[k]) {
        this.dartTrails[k].clear();
      }

      const p = curr.players[k];
      const p0 = prev.players[k];
      if (p.alive && p.st === PState.DASH && p.timer > 2 && p.timer <= 6 && this.dashTrails[k]) {
        const px = (p0.x + (p.x - p0.x) * alpha) / 1000;
        const pz = (p0.y + (p.y - p0.y) * alpha) / 1000;
        this.dashTrails[k].push(px, 0.45, pz, 0.28);
      } else if (this.dashTrails[k]) {
        this.dashTrails[k].clear();
      }

      // Continuous stun stars & recall pulsing rings!
      if (p.alive && p.st === PState.STUN) {
        const px = (p0.x + (p.x - p0.x) * alpha) / 1000;
        const pz = (p0.y + (p.y - p0.y) * alpha) / 1000;
        for (let j = 0; j < 3; j++) {
          const m = this.sparks.take();
          if (!m) break;
          const a = nowSec * 10 + j * 2.094;
          m.position.set(px + Math.cos(a) * 0.34, 1.48 + 0.05 * Math.sin(a * 2), pz + Math.sin(a) * 0.34);
          m.scale.setScalar(0.85);
          m.rotation.set(a, a * 0.7, 0);
          (m.material as THREE.MeshBasicMaterial).color.copy(this._yellow);
          (m.material as THREE.MeshBasicMaterial).opacity = 0.95;
        }
      }

      if (p.alive && p.st === PState.RECALL) {
        const px = (p0.x + (p.x - p0.x) * alpha) / 1000;
        const pz = (p0.y + (p.y - p0.y) * alpha) / 1000;
        const ph = (nowSec * 2.6) % 1;
        const rm = this.rings.take();
        if (rm) {
          rm.position.set(px, 0.06 + ph * 0.95, pz);
          const sc = 0.88 - 0.55 * ph;
          rm.scale.set(sc, 1, sc);
          (rm.material as THREE.MeshBasicMaterial).color.set('#7fd4ff');
          (rm.material as THREE.MeshBasicMaterial).opacity = Math.sin(Math.PI * ph) * 0.85;
        }
        const dm = this.rings.take();
        if (dm) {
          const ph2 = (nowSec * 3.2) % 1;
          dm.position.set(d.x / 1000, 0.06, d.y / 1000);
          const sc = 0.26 + 0.55 * ph2;
          dm.scale.set(sc, 1, sc);
          (dm.material as THREE.MeshBasicMaterial).color.set('#7fd4ff');
          (dm.material as THREE.MeshBasicMaterial).opacity = (1 - ph2) * 0.85;
        }
      }
    }

    // 3. Advance active bursts
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i];
      const age = nowSec - b.bornSec;
      if (age >= b.lifeSec) {
        this.bursts.splice(i, 1);
        continue;
      }
      const u = age / b.lifeSec;
      const e = 1 - Math.pow(1 - u, 3);
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
      } else {
        x = b.x + b.vx * age;
        y = Math.max(0.05, b.y + b.vy * age - 0.5 * b.gravity * age * age);
        z = b.z + b.vz * age;
      }
      const sc = b.scale0 + (b.scale1 - b.scale0) * e;
      const op = b.kind === 'ribbon' ? Math.max(0, 1 - Math.pow(Math.max(0, (u - 0.65) / 0.35), 2)) : Math.max(0, 1 - u * u);

      let m: THREE.Mesh | null = null;
      if (b.kind === 'ring') m = this.rings.take();
      else if (b.kind === 'slash' || b.kind === 'kick') m = this.arcs.take();
      else if (b.kind === 'spark') m = this.sparks.take();
      else if (b.kind === 'puff') m = this.puffs.take();
      else if (b.kind === 'cube' || b.kind === 'confetti') m = this.cubes.take();
      else if (b.kind === 'ribbon') m = this.ribbons.take();
      else if (b.kind === 'streak') m = this.streaks.take();

      if (!m) continue;
      m.position.set(x, y, z);
      if (b.kind === 'slash') {
        m.rotation.set(0, b.rotY + (0.6 - 1.2 * e), 0);
        m.scale.set(sc, 1, sc);
      } else if (b.kind === 'kick') {
        m.rotation.set(0, b.rotY, 0);
        m.scale.set(sc, 1, sc * 0.72);
      } else if (b.kind === 'ring') {
        m.rotation.set(0, 0, 0);
        m.scale.set(sc, 1, sc);
      } else if (b.kind === 'streak') {
        m.rotation.set(0, b.rotY, 0);
        m.scale.set(sc, 1, 1 - u * 0.5);
      } else if (b.kind === 'ribbon') {
        m.rotation.set(age * b.spin, b.rotY + age * b.spin * 0.65, Math.sin(age * 7.5 + (b.phase ?? 0)) * 0.9);
        m.scale.setScalar(sc);
      } else {
        m.rotation.set(age * b.spin, b.rotY + age * b.spin * 0.6, age * b.spin * 0.4);
        m.scale.setScalar(sc);
      }
      const mat = m.material as THREE.MeshBasicMaterial;
      mat.color.copy(b.color);
      mat.opacity = b.kind === 'puff' ? op * 0.65 : op;
    }

    // 4. Human tactical aim line & recall progress ring
    // (The crosshair itself is rendered via zero-latency OS hardware CSS cursor on #game-canvas)
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
    this.arcs.reset();
    this.sparks.reset();
    this.puffs.reset();
    this.cubes.reset();
    this.ribbons.reset();
    this.streaks.reset();
    for (const r of this.dartTrails) r.clear();
    for (const r of this.dashTrails) r.clear();
  }

  public dispose() {
    this.rings.dispose(this.scene);
    this.arcs.dispose(this.scene);
    this.sparks.dispose(this.scene);
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
