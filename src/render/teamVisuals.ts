import * as THREE from 'three';
import { EngineMapData, GameEvent, PlayerSnapshot, SlotConfig, TickSnapshot } from '../game/types';
import { VoxelModelData } from './voxelBuilder';

/**
 * Episode 12 (5v5 team matches) on-field visuals, ported from upstream `modes_bl.py` (control-point circles),
 * `fx.py` (respawn beam) and the world-anchored parts of `hud.py` (point badges, respawn countdown, king hearts),
 * plus `chars_voxel.add_crown` (pixel crown on the kings' heads, applied to the voxel model).
 *
 * Team colours: team 0 (left, seats 0-4) blue, team 1 (right, seats 5-9) red.
 * Everything lives in the 3D scene (meshes + camera-facing sprites) so it also shows in offline video export.
 * Draw calls: control points 2 (all circles + all progress arcs) + 3 badge sprites; respawn ring / badge / beam only
 * while someone is waiting; king hearts 1 sprite per king.
 */

export const TEAM_COLORS: readonly [string, string] = ['#2E8CFF', '#FF5B4D'];
const TEAM_LIN = TEAM_COLORS.map((h) => new THREE.Color(h));
const WHITE = new THREE.Color('#FFFFFF');
const GOLD = '#FFC93A';

export function isTeamMatchSetup(mapData: EngineMapData | null, slots: readonly SlotConfig[]): boolean {
  return Boolean((mapData && (mapData.mode === 3 || mapData.mode === 4 || mapData.mode === 5)) || slots.some((s) => s.side === 0 || s.side === 1));
}

/** Team of a seat: slot side, else the engine's player team, else the seat range (0-4 left, 5-9 right). */
export function seatTeam(slots: readonly SlotConfig[], k: number, p?: PlayerSnapshot | null): 0 | 1 {
  const s = slots[k]?.side;
  if (s === 0 || s === 1) return s;
  if (p && (p.team === 0 || p.team === 1)) return p.team;
  return k < 5 ? 0 : 1;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
function eout(t: number): number {
  const u = clamp01(t);
  return 1 - Math.pow(1 - u, 3);
}
function ease(t: number): number {
  const u = clamp01(t);
  return u * u * (3 - 2 * u);
}

/**
 * `chars_voxel.add_crown`: a gold pixel crown (team-coloured gem in front) on top of the head part, sized to this
 * character's head. It is part of the head, so it moves with the head and splits with it when the king is sliced.
 * Returns a deep copy; the input model is not modified.
 */
export function withCrown(model: VoxelModelData, gemHex: string): VoxelModelData {
  const M = JSON.parse(JSON.stringify(model)) as VoxelModelData;
  const head = M.parts.head;
  if (!head || !head.voxels.length) return M;
  const vox = new Map<string, string>();
  for (const [x, y, z, c] of head.voxels) vox.set(`${x},${y},${z}`, c);
  const paint = new Map<string, string>();
  for (const [x, y, z, d, c] of head.paint) paint.set(`${x},${y},${z},${d}`, c);
  let ks = head.voxels.filter((v) => v[0] >= -3 && v[0] <= 2);
  if (!ks.length) ks = head.voxels;
  const xs = head.voxels.map((v) => v[0]);
  const ys = head.voxels.map((v) => v[1]);
  const x0 = Math.max(Math.min(...xs), -4);
  const x1 = Math.min(Math.max(...xs) + 1, 4);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys) + 1;
  const zc = ks.map((v) => v[2]).sort((a, b) => a - b);
  const ztop = zc[Math.floor(zc.length * 0.97)] + 1;
  const gold = GOLD;
  const hi = '#FFE68A';
  const sh = '#D99A1C';
  const xa = x0;
  const xb = x1;
  const wide = y1 - y0 > 6;
  const ya = wide ? y0 + 1 : y0;
  const yb = wide ? y1 - 1 : y1;
  const z0 = ztop;
  for (let x = xa; x < xb; x++) {
    for (let y = ya; y < yb; y++) {
      const edge = x === xa || x === xb - 1 || y === ya || y === yb - 1;
      if (edge) {
        vox.set(`${x},${y},${z0}`, sh);
        vox.set(`${x},${y},${z0 + 1}`, gold);
      }
    }
  }
  const mx = (xa + xb - 1) / 2;
  const my = (ya + yb - 1) / 2;
  const tips = new Map<string, [number, number, number]>();
  const tip = (x: number, y: number, h: number) => tips.set(`${x},${y},${h}`, [x, y, h]);
  for (const x of [xa, xb - 1]) for (const y of [ya, yb - 1]) tip(x, y, 1);
  for (const x of [Math.floor(mx), Math.ceil(mx)]) {
    tip(x, ya, 2);
    tip(x, yb - 1, 2);
  }
  for (const y of [Math.floor(my), Math.ceil(my)]) {
    tip(xa, y, 1);
    tip(xb - 1, y, 1);
  }
  for (const [x, y, h] of tips.values()) {
    for (let dz = 0; dz < h; dz++) vox.set(`${x},${y},${z0 + 2 + dz}`, dz === h - 1 ? hi : gold);
  }
  for (const x of [Math.floor(mx), Math.ceil(mx)]) {
    vox.set(`${x},${ya},${z0 + 1}`, gemHex);
    paint.set(`${x},${ya},${z0 + 1},3`, gemHex);
  }
  head.voxels = [...vox].map(([k, c]) => {
    const [x, y, z] = k.split(',').map(Number);
    return [x, y, z, c] as [number, number, number, string];
  });
  head.paint = [...paint].map(([k, c]) => {
    const [x, y, z, d] = k.split(',').map(Number);
    return [x, y, z, d, c] as [number, number, number, number, string];
  });
  M.key = `${model.key}__crown_${gemHex}`;
  return M;
}

// ------------------------------------------------------------------ geometry helpers
function annulusGeo(rIn: number, rOut: number, seg = 72): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let k = 0; k < seg; k++) {
    const a = (2 * Math.PI * k) / seg;
    pos.push(rOut * Math.cos(a), 0, rOut * Math.sin(a), rIn * Math.cos(a), 0, rIn * Math.sin(a));
  }
  for (let k = 0; k < seg; k++) {
    const k2 = (k + 1) % seg;
    idx.push(2 * k, 2 * k2, 2 * k2 + 1, 2 * k, 2 * k2 + 1, 2 * k + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

/** Arc positions from 12 o'clock (map north = -z) clockwise as seen from above, `frac` of a full turn. */
function writeArc(arr: Float32Array, off: number, cx: number, y: number, cz: number, rIn: number, rOut: number, seg: number, frac: number) {
  for (let k = 0; k <= seg; k++) {
    const th = 2 * Math.PI * frac * (k / seg);
    const s = Math.sin(th);
    const c = Math.cos(th);
    const o = off + k * 6;
    arr[o] = cx + rOut * s;
    arr[o + 1] = y;
    arr[o + 2] = cz - rOut * c;
    arr[o + 3] = cx + rIn * s;
    arr[o + 4] = y;
    arr[o + 5] = cz - rIn * c;
  }
}

function arcIndex(seg: number, base: number, out: number[]) {
  for (let k = 0; k < seg; k++) {
    const a = base + 2 * k;
    out.push(a, a + 2, a + 3, a, a + 3, a + 1);
  }
}

/** Open cylinder (radius 1, height 1) with alpha fading from 1 at the bottom to 0 at the top (`fx._beam_mesh`). */
function beamGeo(seg = 14): THREE.BufferGeometry {
  const rows = [0, 0.25, 0.6, 1];
  const alph = [1, 0.7, 0.3, 0];
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  rows.forEach((h, zi) => {
    for (let k = 0; k < seg; k++) {
      const a = (2 * Math.PI * k) / seg;
      pos.push(Math.cos(a), h, Math.sin(a));
      col.push(1, 1, 1, alph[zi]);
    }
  });
  for (let zi = 0; zi < rows.length - 1; zi++) {
    for (let k = 0; k < seg; k++) {
      const k2 = (k + 1) % seg;
      idx.push(zi * seg + k, zi * seg + k2, (zi + 1) * seg + k2, zi * seg + k, (zi + 1) * seg + k2, (zi + 1) * seg + k);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.setIndex(idx);
  return g;
}

function glowMat(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
}

function spriteMat(tex: THREE.Texture): THREE.SpriteMaterial {
  return new THREE.SpriteMaterial({ map: tex, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true, toneMapped: false });
}

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// ------------------------------------------------------------------ 2D badges (hud.py, drawn into sprite canvases)
function heartPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, offX = 0) {
  ctx.beginPath();
  for (let i = 0; i <= 60; i++) {
    const t = (2 * Math.PI * i) / 60;
    const hx = 16 * Math.pow(Math.sin(t), 3);
    const hy = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
    const px = cx + hx * r + offX;
    const py = cy + hy * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/** `hud.heart`: filled = team colour with a white edge and a highlight; empty = grey; broken = cracked down the middle. */
function drawHeart(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, filled: boolean, col: string, alpha: number, broken: boolean, glow: boolean) {
  if (alpha <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  const r = s / 34;
  heartPath(ctx, x, y, r * 1.18);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  heartPath(ctx, x, y, r);
  if (filled) {
    let [cr, cg, cb] = rgb(col);
    if (glow) {
      cr = Math.round(cr * 0.45 + 255 * 0.55);
      cg = Math.round(cg * 0.45 + 255 * 0.55);
      cb = Math.round(cb * 0.45 + 255 * 0.55);
    }
    ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.beginPath();
    ctx.ellipse(x - s * 0.22, y - s * 0.2, s * 0.09, s * 0.09, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fillStyle = 'rgb(206,198,190)';
    ctx.fill();
  }
  if (broken) {
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = Math.max(2, s * 0.09);
    ctx.beginPath();
    ctx.moveTo(x, y - s * 0.4);
    ctx.lineTo(x - s * 0.1, y - s * 0.08);
    ctx.lineTo(x + s * 0.1, y + s * 0.13);
    ctx.lineTo(x, y + s * 0.48);
    ctx.stroke();
  }
  ctx.restore();
}

class CanvasSprite {
  public readonly canvas: HTMLCanvasElement;
  public readonly ctx: CanvasRenderingContext2D;
  public readonly tex: THREE.CanvasTexture;
  public readonly sprite: THREE.Sprite;
  public key = '';

  constructor(w: number, h: number, scene: THREE.Scene, renderOrder: number) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.generateMipmaps = false;
    this.sprite = new THREE.Sprite(spriteMat(this.tex));
    this.sprite.visible = false;
    this.sprite.renderOrder = renderOrder;
    this.sprite.frustumCulled = false;
    scene.add(this.sprite);
  }

  /** Constant on-screen size: `px` pixels tall for a viewport `viewH` pixels tall. */
  public setScreenHeight(px: number, viewH: number, fovDeg: number) {
    const frac = px / Math.max(1, viewH);
    const s = 2 * frac * Math.tan((fovDeg * Math.PI) / 360);
    this.sprite.scale.set((s * this.canvas.width) / this.canvas.height, s, 1);
  }

  public dispose(scene: THREE.Scene) {
    scene.remove(this.sprite);
    this.tex.dispose();
    (this.sprite.material as THREE.Material).dispose();
  }
}

interface PointState {
  x: number;
  z: number;
  r: number;
  name: string;
  /** vertex ranges in the circle mesh: [start, count] for base, edge, outer white edge */
  base: [number, number];
  edge: [number, number];
  edge2: [number, number];
  label: CanvasSprite;
  flashTick: number;
}

interface SeatRespawn {
  ringBg: THREE.Mesh;
  arc: THREE.Mesh;
  arcPos: Float32Array;
  badge: CanvasSprite;
  beam: THREE.Mesh;
  baseRing: THREE.Mesh;
  respawnTick: number;
  respawnX: number;
  respawnZ: number;
  avatar: HTMLImageElement | null;
}

interface KingState {
  seat: number;
  team: 0 | 1;
  hearts: CanvasSprite;
  lossTick: number;
}

export interface TeamVisualsFrame {
  prev: TickSnapshot;
  curr: TickSnapshot;
  alpha: number;
  gt: number;
  camera: THREE.PerspectiveCamera;
  viewH: number;
  /** Seat hidden from the local player (grass fog) */
  hidden: (k: number) => boolean;
  /** Liquid surface height under a map point (m) or null */
  liquidZAt: (xMm: number, yMm: number, gt: number) => number | null;
  /** Solid ground under a map point at this tick */
  solidAt: (xMm: number, yMm: number, tick: number) => boolean;
}

export class TeamVisuals {
  private readonly scene: THREE.Scene;
  private readonly mapData: EngineMapData;
  private readonly slots: readonly SlotConfig[];
  private readonly teams: (0 | 1)[];
  private readonly mode: number;
  private readonly capture: number;
  private readonly respawnSteps: number;
  private readonly kingLives: number;
  private readonly disposables: { dispose(): void }[] = [];

  // control points
  private points: PointState[] = [];
  private circleMesh: THREE.Mesh | null = null;
  private circleCol: THREE.BufferAttribute | null = null;
  private arcMesh: THREE.Mesh | null = null;
  private arcPos: THREE.BufferAttribute | null = null;
  private arcCol: THREE.BufferAttribute | null = null;
  private readonly arcSeg = 72;

  // respawn
  private seats: (SeatRespawn | null)[] = [];

  // kings
  private kings: KingState[] = [];

  private readonly _tmpA = new THREE.Color();
  private readonly _tmpB = new THREE.Color();
  private readonly _tmpC = new THREE.Color();

  constructor(scene: THREE.Scene, mapData: EngineMapData, slots: readonly SlotConfig[], initial: TickSnapshot) {
    this.scene = scene;
    this.mapData = mapData;
    this.slots = slots;
    this.mode = mapData.mode ?? 3;
    this.capture = Math.max(1, mapData.capture ?? 20);
    this.respawnSteps = Math.max(1, mapData.respawn ?? 60);
    this.kingLives = Math.max(1, mapData.kingLives ?? 3);
    this.teams = slots.map((_, k) => seatTeam(slots, k, initial.players[k]));
    if (this.mode === 4 && mapData.points?.length) this.buildPoints();
    if (this.mode === 4) this.buildRespawn();
    if (this.mode === 5 && mapData.kings) this.buildKings();
  }

  public teamOf(k: number): 0 | 1 {
    return this.teams[k] ?? (k < 5 ? 0 : 1);
  }

  public teamColor(k: number): string {
    return TEAM_COLORS[this.teamOf(k)];
  }

  // ---------------------------------------------------------------- control points (modes_bl.Points)
  private buildPoints() {
    const pts = this.mapData.points ?? [];
    const SEG = 72;
    const pos: number[] = [];
    const idx: number[] = [];
    const ring = (cx: number, cz: number, y: number, rIn: number, rOut: number): [number, number] => {
      const start = pos.length / 3;
      for (let k = 0; k < SEG; k++) {
        const a = (2 * Math.PI * k) / SEG;
        pos.push(cx + rOut * Math.cos(a), y, cz + rOut * Math.sin(a), cx + rIn * Math.cos(a), y, cz + rIn * Math.sin(a));
      }
      for (let k = 0; k < SEG; k++) {
        const k2 = (k + 1) % SEG;
        idx.push(start + 2 * k, start + 2 * k2, start + 2 * k2 + 1, start + 2 * k, start + 2 * k2 + 1, start + 2 * k + 1);
      }
      return [start, SEG * 2];
    };
    const disc = (cx: number, cz: number, y: number, r: number): [number, number] => {
      const start = pos.length / 3;
      pos.push(cx, y, cz);
      for (let k = 0; k < SEG; k++) {
        const a = (2 * Math.PI * k) / SEG;
        pos.push(cx + r * Math.cos(a), y, cz + r * Math.sin(a));
      }
      for (let k = 0; k < SEG; k++) idx.push(start, start + 1 + k, start + 1 + ((k + 1) % SEG));
      return [start, SEG + 1];
    };
    pts.forEach((p) => {
      const x = p.x / 1000;
      const z = p.y / 1000;
      const r = p.r / 1000;
      // just above the ground, under the players' foot discs (0.022) and shadows (0.014)
      const base = disc(x, z, 0.006, r);
      const edge = ring(x, z, 0.01, r - 0.11, r + 0.02);
      const edge2 = ring(x, z, 0.009, r + 0.02, r + 0.07);
      const label = new CanvasSprite(128, 128, this.scene, 995);
      label.sprite.center.set(0.5, 0.18);
      label.sprite.position.set(x, 0.05, z - r - 0.15);
      this.points.push({ x, z, r, name: p.name, base, edge, edge2, label, flashTick: -999 });
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.circleCol = new THREE.BufferAttribute(new Float32Array((pos.length / 3) * 4), 4);
    this.circleCol.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('color', this.circleCol);
    geo.setIndex(idx);
    const mat = glowMat();
    this.circleMesh = new THREE.Mesh(geo, mat);
    this.circleMesh.renderOrder = -2;
    this.circleMesh.frustumCulled = false;
    this.scene.add(this.circleMesh);
    this.disposables.push(geo, mat);

    // progress arcs (all points in one mesh)
    const seg = this.arcSeg;
    const nv = pts.length * (seg + 1) * 2;
    const apos = new Float32Array(nv * 3);
    const aidx: number[] = [];
    for (let i = 0; i < pts.length; i++) arcIndex(seg, i * (seg + 1) * 2, aidx);
    const ageo = new THREE.BufferGeometry();
    this.arcPos = new THREE.BufferAttribute(apos, 3);
    this.arcPos.setUsage(THREE.DynamicDrawUsage);
    this.arcCol = new THREE.BufferAttribute(new Float32Array(nv * 4), 4);
    this.arcCol.setUsage(THREE.DynamicDrawUsage);
    ageo.setAttribute('position', this.arcPos);
    ageo.setAttribute('color', this.arcCol);
    ageo.setIndex(aidx);
    const amat = glowMat();
    this.arcMesh = new THREE.Mesh(ageo, amat);
    this.arcMesh.renderOrder = -1;
    this.arcMesh.frustumCulled = false;
    this.scene.add(this.arcMesh);
    this.disposables.push(ageo, amat);
  }

  private setRange(attr: THREE.BufferAttribute, [start, count]: [number, number], c: THREE.Color, a: number) {
    const arr = attr.array as Float32Array;
    for (let i = start; i < start + count; i++) {
      arr[i * 4] = c.r;
      arr[i * 4 + 1] = c.g;
      arr[i * 4 + 2] = c.b;
      arr[i * 4 + 3] = a;
    }
  }

  private drawPointBadge(ps: PointState, own: number, tk: number, pr: number, pop: number) {
    const key = `${own}|${tk}|${Math.round(pr * 48)}|${Math.round(pop * 10)}`;
    if (ps.label.key === key) return;
    ps.label.key = key;
    const ctx = ps.label.ctx;
    const S = 128;
    ctx.clearRect(0, 0, S, S);
    const c0 = S / 2;
    const r = 26 + 7 * pop;
    ctx.fillStyle = 'rgba(30,40,70,0.28)';
    ctx.beginPath();
    ctx.ellipse(c0, c0 + 6, r + 7, r + 6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,252,246,0.94)';
    ctx.beginPath();
    ctx.arc(c0, c0, r + 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = own >= 0 ? TEAM_COLORS[own] : '#B4B0AA';
    ctx.beginPath();
    ctx.arc(c0, c0, r, 0, Math.PI * 2);
    ctx.fill();
    if (tk >= 0 && pr > 0) {
      ctx.strokeStyle = TEAM_COLORS[tk];
      ctx.lineWidth = 8;
      ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.arc(c0, c0, r + 6, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * Math.min(1, pr));
      ctx.stroke();
    }
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `900 ${Math.round(r * 1.25)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ps.name, c0, c0 + 2);
    ps.label.tex.needsUpdate = true;
  }

  private updatePoints(f: TeamVisualsFrame) {
    if (!this.circleCol || !this.arcPos || !this.arcCol) return;
    const { prev, curr, alpha, gt } = f;
    const white = WHITE;
    const tmp = this._tmpA;
    const col = this._tmpB;
    const tc = this._tmpC;
    const seg = this.arcSeg;
    const apos = this.arcPos.array as Float32Array;
    const acol = this.arcCol.array as Float32Array;
    this.points.forEach((ps, i) => {
      const own = curr.owner?.[i] ?? -1;
      const tk = curr.taking?.[i] ?? -1;
      const p1 = curr.prog?.[i] ?? 0;
      const p0 = prev.prog?.[i] ?? 0;
      const progF = tk >= 0 && p1 > 0 ? (p0 <= p1 ? p0 + (p1 - p0) * alpha : p1) : 0;
      const pr = Math.min(1, progF / this.capture);
      col.copy(own >= 0 ? TEAM_LIN[own] : white);
      const u = gt - (ps.flashTick + 1);
      const fl = ps.flashTick > -900 && u >= 0 && u < 12 ? 1 - u / 12 : 0;
      // mat_emit_alpha(strength=1.4): emissive colour brighter than the plain team colour
      tmp.copy(col).lerp(white, fl * 0.8).multiplyScalar(1.4);
      this.setRange(this.circleCol!, ps.base, col.multiplyScalar(1.4), (own >= 0 ? 0.2 : 0.1) + 0.25 * fl);
      this.setRange(this.circleCol!, ps.edge, tmp, 0.95);
      this.setRange(this.circleCol!, ps.edge2, white, 0.7);
      const off = i * (seg + 1) * 2;
      const frac = tk >= 0 ? pr : 0;
      writeArc(apos, off * 3, ps.x, 0.012, ps.z, ps.r - 0.42, ps.r - 0.17, seg, frac > 0.004 ? frac : 0);
      tc.copy(tk >= 0 ? TEAM_LIN[tk] : white).multiplyScalar(1.4);
      for (let v = 0; v < (seg + 1) * 2; v++) {
        const o = (off + v) * 4;
        acol[o] = tc.r;
        acol[o + 1] = tc.g;
        acol[o + 2] = tc.b;
        acol[o + 3] = frac > 0.004 ? 0.95 : 0;
      }
      // badge: hud._point_badge, pops on a flip
      const pop = ps.flashTick > -900 && gt - (ps.flashTick + 1) >= 0 && gt - (ps.flashTick + 1) < 10 ? 1 - (gt - ps.flashTick - 1) / 10 : 0;
      this.drawPointBadge(ps, own, tk, tk >= 0 ? pr : 0, pop);
      ps.label.setScreenHeight(Math.max(40, f.viewH * 0.062), f.viewH, f.camera.fov);
      ps.label.sprite.visible = true;
    });
    this.circleCol.needsUpdate = true;
    this.arcPos.needsUpdate = true;
    this.arcCol.needsUpdate = true;
  }

  // ---------------------------------------------------------------- respawn (countdown ring, badge, light beam)
  private buildRespawn() {
    const bgGeo = annulusGeo(0.5, 0.6, 48);
    const bgMat = new THREE.MeshBasicMaterial({ color: '#FFFFFF', transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    const bGeo = beamGeo();
    const ringGeo = annulusGeo(0.88, 1.0, 48);
    this.disposables.push(bgGeo, bgMat, bGeo, ringGeo);
    const seg = 48;
    for (let k = 0; k < this.slots.length; k++) {
      const ringBg = new THREE.Mesh(bgGeo, bgMat.clone());
      ringBg.visible = false;
      ringBg.renderOrder = 2;
      this.scene.add(ringBg);
      const arcPos = new Float32Array((seg + 1) * 2 * 3);
      const ag = new THREE.BufferGeometry();
      const pa = new THREE.BufferAttribute(arcPos, 3);
      pa.setUsage(THREE.DynamicDrawUsage);
      ag.setAttribute('position', pa);
      const ai: number[] = [];
      arcIndex(seg, 0, ai);
      ag.setIndex(ai);
      const arc = new THREE.Mesh(ag, new THREE.MeshBasicMaterial({ color: this.teamColor(k), transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
      arc.visible = false;
      arc.frustumCulled = false;
      arc.renderOrder = 3;
      this.scene.add(arc);
      const badge = new CanvasSprite(128, 128, this.scene, 994);
      badge.sprite.center.set(0.5, 0.0);
      const bm = glowMat();
      bm.color.set(new THREE.Color(this.teamColor(k)).lerp(new THREE.Color('#FFFFFF'), 0.35));
      const beam = new THREE.Mesh(bGeo, bm);
      beam.visible = false;
      beam.renderOrder = 6;
      beam.frustumCulled = false;
      this.scene.add(beam);
      const baseRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: this.teamColor(k), transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
      baseRing.visible = false;
      baseRing.renderOrder = 3;
      this.scene.add(baseRing);
      let avatar: HTMLImageElement | null = null;
      const url = this.slots[k]?.avatar;
      if (url) {
        avatar = new Image();
        avatar.crossOrigin = 'anonymous';
        avatar.onload = () => {
          const st = this.seats[k];
          if (st) st.badge.key = '';
        };
        avatar.src = url;
      }
      this.seats.push({ ringBg, arc, arcPos, badge, beam, baseRing, respawnTick: -999, respawnX: 0, respawnZ: 0, avatar });
    }
  }

  private drawRespawnBadge(k: number, st: SeatRespawn, rem: number, sec: number) {
    const key = `${Math.round(rem * 36)}|${sec}|${st.avatar?.complete ? 1 : 0}`;
    if (st.badge.key === key) return;
    st.badge.key = key;
    const ctx = st.badge.ctx;
    const S = 128;
    ctx.clearRect(0, 0, S, S);
    const c0 = S / 2;
    const r = 30;
    const tc = this.teamColor(k);
    ctx.fillStyle = 'rgba(255,252,246,0.92)';
    ctx.beginPath();
    ctx.arc(c0, c0, r + 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = tc;
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.arc(c0, c0, r + 4.5, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * clamp01(rem));
    ctx.stroke();
    ctx.save();
    ctx.beginPath();
    ctx.arc(c0, c0, r, 0, Math.PI * 2);
    ctx.clip();
    if (st.avatar && st.avatar.complete && st.avatar.naturalWidth > 0) {
      ctx.filter = 'grayscale(1) brightness(1.05)';
      ctx.drawImage(st.avatar, c0 - r, c0 - r, 2 * r, 2 * r);
      ctx.filter = 'none';
    } else {
      ctx.fillStyle = '#8E8A96';
      ctx.fillRect(c0 - r, c0 - r, 2 * r, 2 * r);
      ctx.fillStyle = '#FFFFFF';
      ctx.font = `800 26px system-ui, -apple-system, "Segoe UI", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const nm = this.slots[k]?.displayName || this.mapData.names?.[k] || `${k}`;
      ctx.fillText(nm.slice(0, 2).toUpperCase(), c0, c0 + 1);
    }
    ctx.restore();
    ctx.fillStyle = tc;
    ctx.beginPath();
    ctx.arc(c0 + r + 1, c0 + r - 7, 15, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `900 22px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(sec), c0 + r + 1, c0 + r - 6);
    st.badge.tex.needsUpdate = true;
  }

  private updateRespawn(f: TeamVisualsFrame) {
    const { curr, gt } = f;
    const seg = 48;
    for (let k = 0; k < this.seats.length; k++) {
      const st = this.seats[k];
      if (!st) continue;
      const p = curr.players[k];
      let ringVis = false;
      let badgeVis = false;
      let beamVis = false;
      let baseVis = false;
      if (p && p.alive === 0 && p.timer > 0 && !curr.over) {
        const nxt = curr.t + p.timer; // respawn tick
        const deadT = p.deadT >= 0 ? p.deadT : curr.t;
        const a = ease((gt - deadT - 12) / 6) * (1 - ease((gt - nxt + 1) / 2));
        const rem = clamp01((nxt - gt) / this.respawnSteps);
        const sec = Math.max(1, Math.ceil((nxt - gt) / 20 - 1e-6));
        const x = p.x / 1000;
        const z = p.y / 1000;
        if (a > 0.02) {
          const lz = f.liquidZAt(p.x, p.y, curr.t);
          const solid = f.solidAt(p.x, p.y, curr.t);
          const y = lz !== null ? lz + 0.02 : 0.03;
          if (lz !== null || solid) {
            ringVis = true;
            st.ringBg.position.set(x, y, z);
            (st.ringBg.material as THREE.MeshBasicMaterial).opacity = 0.5 * a;
            writeArc(st.arcPos, 0, x, y + 0.004, z, 0.5, 0.6, seg, rem);
            (st.arc.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
            (st.arc.material as THREE.MeshBasicMaterial).opacity = 0.95 * a;
          }
          badgeVis = true;
          this.drawRespawnBadge(k, st, rem, sec);
          st.badge.sprite.position.set(x, (lz !== null ? lz : 0) + 0.9, z);
          (st.badge.sprite.material as THREE.SpriteMaterial).opacity = a;
          st.badge.setScreenHeight(Math.max(36, f.viewH * 0.055), f.viewH, f.camera.fov);
        }
        // Light beam falling onto the respawn point during the last 12 steps (fx.py respawn, u < 0)
        const u = gt - nxt;
        if (u >= -12 && u < 0) {
          const base = this.mapData.bases?.[k];
          if (base) {
            const w = clamp01((u + 12) / 10);
            const rr = 0.75 - 0.35 * w;
            beamVis = true;
            st.beam.position.set(base[0] / 1000, 0, base[1] / 1000);
            st.beam.scale.set(rr, 4.5, rr);
            (st.beam.material as THREE.MeshBasicMaterial).opacity = 0.55 * w;
            baseVis = true;
            const s = 1.3 - 0.75 * w;
            st.baseRing.position.set(base[0] / 1000, 0.04, base[1] / 1000);
            st.baseRing.scale.set(s, 1, s);
            const bm = st.baseRing.material as THREE.MeshBasicMaterial;
            bm.color.copy(TEAM_LIN[this.teamOf(k)]).lerp(WHITE, 0.3);
            bm.opacity = 0.9 * w;
          }
        }
      }
      // After the respawn: the beam spreads and fades (u < 5)
      const ur = gt - st.respawnTick;
      if (st.respawnTick > -900 && ur >= 0 && ur < 5 && p?.alive === 1) {
        beamVis = true;
        const rr = 0.4 + 0.5 * eout(ur / 5);
        st.beam.position.set(st.respawnX, 0, st.respawnZ);
        st.beam.scale.set(rr, Math.max(0.01, 4.5 * (1 - ur / 5)), rr);
        const bm = st.beam.material as THREE.MeshBasicMaterial;
        bm.opacity = 0.6 * (1 - ur / 5);
      }
      st.ringBg.visible = ringVis;
      st.arc.visible = ringVis;
      st.badge.sprite.visible = badgeVis;
      st.beam.visible = beamVis;
      st.baseRing.visible = baseVis;
    }
  }

  // ---------------------------------------------------------------- kings (hud._king_hearts)
  private buildKings() {
    const [kl, kr] = this.mapData.kings ?? [-1, -1];
    for (const seat of [kl, kr]) {
      if (seat < 0 || seat >= this.slots.length) continue;
      const hearts = new CanvasSprite(208, 80, this.scene, 996);
      hearts.sprite.center.set(0.5, -0.35);
      this.kings.push({ seat, team: this.teamOf(seat), hearts, lossTick: -999 });
    }
  }

  private drawHearts(ks: KingState, n: number, brk: number, blink: boolean) {
    const tot = this.kingLives;
    const key = `${n}|${Math.round(brk * 20)}|${blink ? 1 : 0}`;
    if (ks.hearts.key === key) return;
    ks.hearts.key = key;
    const ctx = ks.hearts.ctx;
    const W = ks.hearts.canvas.width;
    const H = ks.hearts.canvas.height;
    ctx.clearRect(0, 0, W, H);
    const gap = Math.min(46, (W - 24) / Math.max(1, tot));
    const hs = gap * 0.87;
    const x0 = W / 2 - (gap * (tot - 1)) / 2;
    const col = TEAM_COLORS[ks.team];
    const yc = 52;
    for (let i = 0; i < tot; i++) {
      if (i < n) drawHeart(ctx, x0 + i * gap, yc, hs, true, col, 1, false, blink);
      else if (i === n && brk > 0) {
        const u = 1 - brk;
        drawHeart(ctx, x0 + i * gap, yc - 30 * u, hs * (1 + 0.4 * u), true, col, brk, true, false);
      } else drawHeart(ctx, x0 + i * gap, yc, hs, false, col, 1, false, false);
    }
    ks.hearts.tex.needsUpdate = true;
  }

  private updateKings(f: TeamVisualsFrame) {
    const { prev, curr, alpha, gt } = f;
    for (const ks of this.kings) {
      const p1 = curr.players[ks.seat];
      const p0 = prev.players[ks.seat] ?? p1;
      if (!p1) continue;
      const dead = p1.alive === 0;
      const deadT = p1.deadT >= 0 ? p1.deadT : curr.t;
      if ((dead && gt > deadT + 14) || f.hidden(ks.seat)) {
        ks.hearts.sprite.visible = false;
        continue;
      }
      const n = dead ? 0 : Math.max(0, p1.lives ?? this.kingLives);
      let brk = 0;
      if (ks.lossTick > -900 && gt - (ks.lossTick + 1) >= 0 && gt - (ks.lossTick + 1) < 14) brk = 1 - (gt - ks.lossTick - 1) / 14;
      if (dead) brk = Math.max(brk, clamp01(1 - (gt - deadT - 1) / 14));
      const blink = !dead && (p1.inv ?? 0) > 0 && Math.floor(gt / 1.5) % 2 === 0;
      this.drawHearts(ks, n, brk, blink);
      const x = (dead ? p1.x : p0.x + (p1.x - p0.x) * alpha) / 1000;
      const z = (dead ? p1.y : p0.y + (p1.y - p0.y) * alpha) / 1000;
      ks.hearts.sprite.position.set(x, 1.52, z);
      const a = clamp01((gt + 6) / 6);
      (ks.hearts.sprite.material as THREE.SpriteMaterial).opacity = a;
      ks.hearts.setScreenHeight(Math.max(40, f.viewH * 0.075), f.viewH, f.camera.fov);
      ks.hearts.sprite.visible = true;
    }
  }

  /** Invulnerability blink for a king seat (`pose.py`: flash 0.62 / 0.08 alternating every 1.5 steps), else 0. */
  public kingFlash(k: number, p: PlayerSnapshot | undefined, gt: number): number {
    if (this.mode !== 5 || !p || p.alive !== 1 || !((p.inv ?? 0) > 0)) return 0;
    if (!this.kings.some((ks) => ks.seat === k)) return 0;
    return Math.floor(gt / 1.5) % 2 === 0 ? 0.62 : 0.08;
  }

  // ---------------------------------------------------------------- events & frame
  /** Feed one tick's engine events (CAPTURE / RESPAWN / LIFE). */
  public onEvents(events: readonly GameEvent[], tick: number) {
    for (const ev of events) {
      if (ev.name === 'CAPTURE') {
        const ps = this.points[ev.a];
        if (ps) ps.flashTick = tick - 1;
      } else if (ev.name === 'RESPAWN') {
        const st = this.seats[ev.a];
        if (st) {
          st.respawnTick = tick;
          st.respawnX = ev.b / 1000;
          st.respawnZ = ev.c / 1000;
        }
      } else if (ev.name === 'LIFE') {
        const ks = this.kings.find((q) => q.seat === ev.a);
        if (ks) ks.lossTick = tick - 1;
      }
    }
  }

  /** Rebuild the short-lived animation state after a replay seek (events of the last ~20 ticks). */
  public rebuildFromHistory(ticks: readonly TickSnapshot[], idx: number) {
    for (const ps of this.points) ps.flashTick = -999;
    for (const st of this.seats) if (st) st.respawnTick = -999;
    for (const ks of this.kings) ks.lossTick = -999;
    for (let i = Math.max(1, idx - 24); i <= idx; i++) this.onEvents(ticks[i].events, ticks[i].t);
  }

  public update(f: TeamVisualsFrame) {
    if (this.points.length) this.updatePoints(f);
    if (this.seats.length) this.updateRespawn(f);
    if (this.kings.length) this.updateKings(f);
  }

  public dispose() {
    for (const ps of this.points) ps.label.dispose(this.scene);
    if (this.circleMesh) this.scene.remove(this.circleMesh);
    if (this.arcMesh) this.scene.remove(this.arcMesh);
    for (const st of this.seats) {
      if (!st) continue;
      this.scene.remove(st.ringBg, st.arc, st.beam, st.baseRing);
      (st.ringBg.material as THREE.Material).dispose();
      st.arc.geometry.dispose();
      (st.arc.material as THREE.Material).dispose();
      (st.beam.material as THREE.Material).dispose();
      (st.baseRing.material as THREE.Material).dispose();
      st.badge.dispose(this.scene);
    }
    for (const ks of this.kings) ks.hearts.dispose(this.scene);
    for (const d of this.disposables) d.dispose();
    this.points = [];
    this.seats = [];
    this.kings = [];
  }
}
