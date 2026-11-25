import * as THREE from 'three';
import { DState, PState, PlayerSnapshot, DartSnapshot } from '../game/types';
import {
  buildSlicedHalves,
  buildVoxelDartMesh,
  buildVoxelPartGeometry,
  CHAR_SCALE,
  createVoxelMaterial,
  disposeVoxelDartMesh,
  getOutlineMaterial,
  VOX_U,
  VoxelModelData,
} from './voxelBuilder';

export const WINNER_CELEBRATE_DELAY_TICKS = 4.0; // Wait 4 logic frames after last enemy dies before celebrating

function clamp(x: number, a = 0, b = 1): number {
  return x < a ? a : x > b ? b : x;
}
function ease(t: number): number {
  const u = clamp(t);
  return u * u * (3 - 2 * u);
}
function eout(t: number): number {
  const u = clamp(t);
  return 1 - Math.pow(1 - u, 3);
}
function bump(t: number): number {
  return Math.sin(Math.PI * clamp(t));
}

export type PitFallKind = 'walk' | 'kick' | 'ground';

export interface RigDeathEffectCallbacks {
  onCloudSplash?: (x: number, z: number) => void;
  onPoof?: (x: number, y: number, z: number, size: number) => void;
}

export interface SliceAnimState {
  active: boolean;
  startTick: number;
  x: number;
  z: number;
  yaw: number;
  dx: number;
  dz: number;
  sx: number;
  sz: number;
  landUpper: boolean;
  landLower: boolean;
  poofFired: boolean;
}

export interface FallAnimState {
  active: boolean;
  startTick: number;
  x: number;
  z: number;
  vx: number;
  vz: number;
  kicked: boolean;
  kind: PitFallKind;
  splashFired: boolean;
}

export interface SlashFallAnimState {
  startTick: number;
  x: number;
  z: number;
  dx: number;
  dz: number;
  poofFired: boolean;
}

let _softShadowTex: THREE.CanvasTexture | null = null;
function getSoftShadowTexture(): THREE.CanvasTexture {
  if (_softShadowTex) return _softShadowTex;
  const sz = 128;
  const cvs = document.createElement('canvas');
  cvs.width = sz;
  cvs.height = sz;
  const ctx = cvs.getContext('2d')!;
  const half = sz * 0.5;
  const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
  grad.addColorStop(0.0, 'rgba(18, 22, 38, 1.0)');
  grad.addColorStop(0.32, 'rgba(18, 22, 38, 0.86)');
  grad.addColorStop(0.62, 'rgba(18, 22, 38, 0.36)');
  grad.addColorStop(0.86, 'rgba(18, 22, 38, 0.08)');
  grad.addColorStop(1.0, 'rgba(18, 22, 38, 0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, sz, sz);
  const tex = new THREE.CanvasTexture(cvs);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  _softShadowTex = tex;
  return tex;
}

/**
 * Exact port of chars.py make_blur_disc: translucent radial disc with 3 brighter sector wedges
 * rendered just beneath a flying boomerang in high graphics quality.
 */
function buildDartBlurDiscMesh(colorHex: string, r = 0.56, alphaScale = 1.0): THREE.Mesh {
  const seg = 56;
  const col = new THREE.Color(colorHex).lerp(new THREE.Color('#ffffff'), 0.45);
  const radii: [number, number][] = [
    [0.14, 0.0],
    [0.5, 0.26 * alphaScale],
    [0.85, 0.34 * alphaScale],
    [1.0, 0.0],
  ];
  const pos: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  for (const [rr, a] of radii) {
    for (let k = 0; k < seg; k++) {
      const ang = (2 * Math.PI * k) / seg;
      pos.push(r * rr * Math.cos(ang), 0, r * rr * Math.sin(ang));
      const c3 = Math.max(0, Math.cos(ang * 3));
      const fa = a * (0.45 + 0.55 * c3 * c3);
      colors.push(col.r, col.g, col.b, fa);
    }
  }
  for (let j = 0; j < radii.length - 1; j++) {
    for (let k = 0; k < seg; k++) {
      const k2 = (k + 1) % seg;
      const a0 = j * seg + k;
      const a1 = j * seg + k2;
      const b0 = (j + 1) * seg + k;
      const b1 = (j + 1) * seg + k2;
      indices.push(a0, a1, b1, a0, b1, b0);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
  geo.setIndex(indices);

  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 1.0,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.visible = false;
  mesh.frustumCulled = false;
  return mesh;
}

const FALL_HANG: Record<PitFallKind, number> = {
  walk: 6.0,
  kick: 0.4,
  ground: 0.0,
};
const FALL_G = 0.05;
const FALL_SPLASH_Y = -10.5;
const SLICE_UP_GO = 1.3;
const SLICE_LOW_GO = 0.32;
const SLICE_POOF = 16.0;
const SLICE_LIFE = 19.5;

/**
 * Hierarchical voxel character rig with smooth 240Hz+ procedural animation
 * ported from pose.py, chars.py, & chars_voxel.py.
 */
export class CharacterRig {
  public readonly seat: number;
  public readonly model: VoxelModelData;
  public readonly color: string;
  public readonly ringColor: string;
  public readonly root = new THREE.Group();
  public readonly rigRoot = new THREE.Group();
  public readonly heldDart: THREE.Group;
  public flyingDart: THREE.Group;
  public dartBlurDisc: THREE.Mesh;
  public readonly groundRing: THREE.Mesh;
  public readonly shadowBlob: THREE.Mesh;
  public readonly shadowBlob2: THREE.Mesh;
  public readonly dashCdRing: THREE.Mesh;

  private highQuality: boolean;
  private dartOutline: boolean;
  private parts = new Map<string, THREE.Group>();
  private restPos = new Map<string, THREE.Vector3>();
  private partMaterials: THREE.MeshLambertMaterial[] = [];
  private flyingDartMat: THREE.MeshLambertMaterial | null = null;

  // Pre-built sliced halves (lazy built on boomerang kill!)
  private slicedUpper: THREE.Group | null = null;
  private slicedLower: THREE.Group | null = null;
  private slicedMat: THREE.MeshLambertMaterial | null = null;
  private sliceCutY = 0.36;
  public sliceState: SliceAnimState | null = null;
  public fallState: FallAnimState | null = null;
  public slashFallState: SlashFallAnimState | null = null;

  // Action animation timers (in game ticks, continuous float)
  public lastThrowTick = -999;
  public lastSlashTick = -999;
  public lastKickTick = -999;
  public lastCatchTick = -999;
  public lastPickTick = -999;
  public lastDashEndTick = -999;
  public lastStunTick = -999;
  public lastStunFaceYaw: number | null = null;
  public lastDartLandTick = -999;
  /** Training ground: last tick an invincible target was hit (white flash); stays -999 in every other mode. */
  public lastHurtTick = -999;
  public actionDirAngle = 0;

  // Smoothed continuous walk phase and facing
  private walkDist = 0;
  private prevX = 0;
  private prevZ = 0;
  private initializedPos = false;
  private smoothedYaw = 0;
  private stealthBlend = 0;
  private visibilityAlpha = 1;

  // Projected sun-ray ground shadow offset per unit height: (-sunDx/sunDy, -sunDz/sunDy)
  private sunProjX = -0.35;
  private sunProjZ = -0.28;
  private sunShadowYaw = 0;
  private sunShadowStretch = 1.18;

  // Scratch vectors & quaternions to guarantee ZERO per-frame allocations at 240Hz+!
  private readonly _tmpDir = new THREE.Vector3();
  private readonly _downVec = new THREE.Vector3(0, -1, 0);
  private readonly _upVec = new THREE.Vector3(0, 1, 0);
  private readonly _axisD = new THREE.Vector3();
  private readonly _tmpQuat = new THREE.Quaternion();
  private readonly _qYaw = new THREE.Quaternion();
  private readonly _qRoll = new THREE.Quaternion();
  private readonly _qSpin = new THREE.Quaternion();
  private readonly _baseTint = new THREE.Color(1, 1, 1);
  private readonly _grassTint = new THREE.Color(0.62, 0.84, 0.72);
  private readonly _flashColor = new THREE.Color(1, 1, 1);

  constructor(
    seat: number,
    model: VoxelModelData,
    ringColor: string,
    isHuman: boolean,
    parentScene: THREE.Scene,
    highQuality = true,
    dartOutline = true,
  ) {
    this.seat = seat;
    this.model = model;
    this.color = model.color;
    this.ringColor = ringColor;
    this.highQuality = highQuality;
    this.dartOutline = dartOutline;

    const baseScale = CHAR_SCALE * (model.scale || 1.0);
    this.rigRoot.scale.setScalar(baseScale);
    this.root.add(this.rigRoot);

    const omat = getOutlineMaterial();

    // Per-character cloned material so we can tint grass stealth / hit flash without affecting other chars
    const charMat = createVoxelMaterial(0.16).clone();
    this.partMaterials.push(charMat);

    // Build each voxel part
    for (const [nm, part] of Object.entries(model.parts)) {
      const { mainGeo, outlineGeo } = buildVoxelPartGeometry(part, VOX_U);
      const grp = new THREE.Group();
      grp.name = nm;
      const mesh = new THREE.Mesh(mainGeo, charMat);
      mesh.castShadow = false;
      grp.add(mesh);
      if (outlineGeo) {
        const om = new THREE.Mesh(outlineGeo, omat);
        grp.add(om);
      }
      const rx = part.pivot[0] * VOX_U;
      const ry = part.pivot[2] * VOX_U;
      const rz = -part.pivot[1] * VOX_U;
      this.restPos.set(nm, new THREE.Vector3(rx, ry, rz));
      grp.position.set(rx, ry, rz);
      this.parts.set(nm, grp);
    }

    // Assemble hierarchy exactly like chars_voxel.py
    const body = this.parts.get('body');
    const head = this.parts.get('head');
    for (const [nm, grp] of this.parts.entries()) {
      let par: THREE.Object3D = this.rigRoot;
      let refName: string | null = null;
      if (
        nm === 'hairback' ||
        nm === 'tailL' ||
        nm === 'tailR' ||
        nm === 'face_open' ||
        nm === 'face_tight' ||
        nm === 'face_happy'
      ) {
        if (head) {
          par = head;
          refName = 'head';
        }
      } else if (nm === 'armA' || nm === 'armB' || nm === 'tail') {
        if (body) {
          par = body;
          refName = 'body';
        }
      }
      par.add(grp);
      if (refName) {
        const rSelf = this.restPos.get(nm)!;
        const rPar = this.restPos.get(refName)!;
        grp.position.set(rSelf.x - rPar.x, rSelf.y - rPar.y, rSelf.z - rPar.z);
      }
    }

    // Held boomerang attached to armA
    this.heldDart = buildVoxelDartMesh(this.color, 0.74);
    const armA = this.parts.get('armA');
    if (armA) {
      armA.add(this.heldDart);
      this.heldDart.position.set(0.05, -(model.arm_len || 3.0) * VOX_U, 0.08);
      this.heldDart.rotation.set(Math.PI * 0.42, 0.2, 0.25);
    } else {
      this.rigRoot.add(this.heldDart);
    }

    // World-space flying / ground boomerang + HQ spinning motion-blur disc
    this.flyingDart = buildVoxelDartMesh(this.color, 1.42, this.dartOutline);
    this.flyingDart.visible = false;
    const dartFirstMesh = this.flyingDart.children[0] as THREE.Mesh | undefined;
    if (dartFirstMesh && dartFirstMesh.material instanceof THREE.MeshLambertMaterial) {
      this.flyingDartMat = dartFirstMesh.material;
    }
    parentScene.add(this.flyingDart);

    this.dartBlurDisc = buildDartBlurDiscMesh(
      this.color,
      this.dartOutline ? 0.55 : 0.56,
      this.dartOutline ? 0.5 : 1.0,
    );
    parentScene.add(this.dartBlurDisc);

    // Sun-aligned soft radial ground shadows (blob + blob2 for separated upper sliced half!)
    const blobGeo = new THREE.PlaneGeometry(1.18, 1.18);
    blobGeo.rotateX(-Math.PI / 2);
    const blobMat = new THREE.MeshBasicMaterial({
      map: getSoftShadowTexture(),
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    });
    this.shadowBlob = new THREE.Mesh(blobGeo, blobMat);
    this.shadowBlob.position.y = 0.014;
    this.shadowBlob.renderOrder = 1;
    parentScene.add(this.shadowBlob);

    this.shadowBlob2 = new THREE.Mesh(blobGeo, blobMat.clone());
    this.shadowBlob2.position.y = 0.014;
    this.shadowBlob2.renderOrder = 1;
    this.shadowBlob2.visible = false;
    parentScene.add(this.shadowBlob2);

    // Colored foot ring (slightly bolder & bright highlight for Human player!)
    const ringGeo = new THREE.RingGeometry(isHuman ? 0.38 : 0.37, isHuman ? 0.49 : 0.45, 28);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: ringColor,
      transparent: true,
      opacity: isHuman ? 0.92 : 0.78,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.groundRing = new THREE.Mesh(ringGeo, ringMat);
    this.groundRing.position.y = 0.022;
    parentScene.add(this.groundRing);

    // Dash cooldown ring
    const cdGeo = new THREE.RingGeometry(0.51, 0.57, 28);
    cdGeo.rotateX(-Math.PI / 2);
    const cdMat = new THREE.MeshBasicMaterial({
      color: '#ffffff',
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    this.dashCdRing = new THREE.Mesh(cdGeo, cdMat);
    this.dashCdRing.position.y = 0.024;
    this.dashCdRing.visible = false;
    parentScene.add(this.dashCdRing);

    parentScene.add(this.root);
    this.setFace('open');
    this.setSunDirection(10, 24, 8);
  }

  public setHighQuality(hq: boolean) {
    this.highQuality = hq;
    if (!hq) {
      this.dartBlurDisc.visible = false;
      this.shadowBlob2.visible = false;
    }
  }

  public setDartOutline(enabled: boolean, parentScene: THREE.Scene) {
    if (this.dartOutline === enabled) return;
    this.dartOutline = enabled;

    const prevDart = this.flyingDart;
    const prevDisc = this.dartBlurDisc;

    const nextDart = buildVoxelDartMesh(this.color, 1.42, enabled);
    nextDart.visible = prevDart.visible;
    nextDart.position.copy(prevDart.position);
    nextDart.rotation.copy(prevDart.rotation);
    nextDart.scale.copy(prevDart.scale);
    const firstMesh = nextDart.children[0] as THREE.Mesh | undefined;
    const nextMat =
      firstMesh && firstMesh.material instanceof THREE.MeshLambertMaterial ? firstMesh.material : null;
    if (nextMat && this.flyingDartMat) {
      nextMat.emissiveIntensity = this.flyingDartMat.emissiveIntensity;
    }

    const nextDisc = buildDartBlurDiscMesh(this.color, enabled ? 0.55 : 0.56, enabled ? 0.5 : 1.0);
    nextDisc.visible = prevDisc.visible;
    nextDisc.position.copy(prevDisc.position);
    nextDisc.rotation.copy(prevDisc.rotation);
    nextDisc.scale.copy(prevDisc.scale);

    parentScene.remove(prevDart);
    parentScene.remove(prevDisc);
    disposeVoxelDartMesh(prevDart);
    prevDisc.geometry.dispose();
    (prevDisc.material as THREE.Material).dispose();

    this.flyingDart = nextDart;
    this.flyingDartMat = nextMat;
    this.dartBlurDisc = nextDisc;
    parentScene.add(nextDart);
    parentScene.add(nextDisc);
  }

  /** Aligns the character's soft ground shadow with the active map's directional sun ray. */
  public setSunDirection(dx: number, dy: number, dz: number) {
    const safeY = Math.max(4, Math.abs(dy));
    let px = -dx / safeY;
    let pz = -dz / safeY;
    const len = Math.hypot(px, pz);
    const maxLen = 1.05;
    if (len > maxLen) {
      px = (px / len) * maxLen;
      pz = (pz / len) * maxLen;
    }
    this.sunProjX = px;
    this.sunProjZ = pz;
    this.sunShadowYaw = Math.atan2(px, pz);
    this.sunShadowStretch = 1.0 + Math.min(0.48, Math.hypot(px, pz) * 0.48);
  }

  public setFace(which: 'open' | 'tight' | 'happy') {
    const fOpen = this.parts.get('face_open');
    const fTight = this.parts.get('face_tight');
    const fHappy = this.parts.get('face_happy');
    if (fOpen) fOpen.visible = which === 'open';
    if (fTight) fTight.visible = which === 'tight';
    if (fHappy) fHappy.visible = which === 'happy';
  }

  public triggerSlice(
    parentScene: THREE.Scene,
    tick: number,
    x: number,
    z: number,
    yaw: number,
    dx: number,
    dz: number,
    landUpper = true,
    landLower = true,
  ) {
    if (!this.slicedUpper || !this.slicedLower) {
      const built = buildSlicedHalves(this.model, this.color);
      this.slicedUpper = built.upper;
      this.slicedLower = built.lower;
      this.slicedMat = built.material;
      this.sliceCutY = built.cutY;
      parentScene.add(this.slicedUpper);
      parentScene.add(this.slicedLower);
    }
    const len = Math.hypot(dx, dz) || 1;
    const ndx = dx / len;
    const ndz = dz / len;
    // Perpendicular direction pointing toward camera (+Z) so both cut faces turn toward viewer!
    let sx = -ndz;
    let sz = ndx;
    if (sz < -0.01 || (Math.abs(sz) <= 0.01 && this.seat % 2 === 1)) {
      sx = ndz;
      sz = -ndx;
    }
    this.sliceState = {
      active: true,
      startTick: tick,
      x,
      z,
      yaw,
      dx: ndx,
      dz: ndz,
      sx,
      sz,
      landUpper,
      landLower,
      poofFired: false,
    };
    this.root.visible = false;
    this.groundRing.visible = false;
    this.dashCdRing.visible = false;
    this.slicedUpper.visible = true;
    this.slicedLower.visible = true;
  }

  public triggerSlashDeath(tick: number, x: number, z: number, dx: number, dz: number) {
    const len = Math.hypot(dx, dz) || 1;
    this.slashFallState = {
      startTick: tick,
      x,
      z,
      dx: dx / len,
      dz: dz / len,
      poofFired: false,
    };
    this.groundRing.visible = false;
    this.dashCdRing.visible = false;
  }

  public triggerPitFall(
    tick: number,
    x: number,
    z: number,
    vx: number,
    vz: number,
    kicked: boolean,
    kind: PitFallKind = kicked ? 'kick' : 'walk',
  ) {
    this.fallState = {
      active: true,
      startTick: tick,
      x,
      z,
      vx,
      vz,
      kicked,
      kind,
      splashFired: false,
    };
    this.groundRing.visible = false;
    this.dashCdRing.visible = false;
    this.shadowBlob.visible = false;
    this.shadowBlob2.visible = false;
  }

  /**
   * Resets transient animation & death states so replay timeline scrubbing can
   * cleanly jump forward or backward without rebuilding voxel geometry.
   */
  public resetDynamicState() {
    this.sliceState = null;
    this.fallState = null;
    this.slashFallState = null;
    if (this.slicedUpper) this.slicedUpper.visible = false;
    if (this.slicedLower) this.slicedLower.visible = false;
    this.dartBlurDisc.visible = false;
    this.shadowBlob2.visible = false;
    this.lastThrowTick = -999;
    this.lastSlashTick = -999;
    this.lastKickTick = -999;
    this.lastCatchTick = -999;
    this.lastPickTick = -999;
    this.lastDashEndTick = -999;
    this.lastStunTick = -999;
    this.lastStunFaceYaw = null;
    this.lastDartLandTick = -999;
    this.lastHurtTick = -999;
    this.walkDist = 0;
    this.initializedPos = false;
    this.stealthBlend = 0;
    this.visibilityAlpha = 1;
    const baseScale = CHAR_SCALE * (this.model.scale || 1.0);
    this.rigRoot.scale.setScalar(baseScale);
    this.root.rotation.set(0, 0, 0);
    this.root.visible = true;
    this.shadowBlob.visible = true;
    this.groundRing.visible = true;
    this.dashCdRing.visible = false;
    this.heldDart.rotation.set(Math.PI * 0.42, 0.2, 0.25);
    this.setFace('open');
  }

  public update(
    prevP: PlayerSnapshot,
    currP: PlayerSnapshot,
    prevD: DartSnapshot,
    currD: DartSnapshot,
    alpha: number,
    gt: number,
    currTick: number,
    isWinner: boolean,
    matchOver: boolean,
    hiddenFromHuman: boolean,
    inGrassStealth: boolean,
    onGround: boolean,
    frameDt: number,
    winnerFaceYaw?: number | null,
    deathEvents?: RigDeathEffectCallbacks,
  ) {
    // Track dash stop transitions automatically when STOP event isn't caught
    if (prevP.st === PState.DASH && currP.st !== PState.DASH && this.lastDashEndTick < currTick - 0.5) {
      this.lastDashEndTick = currTick;
    }

    // 1. Update flying / ground boomerang + HQ blur disc
    this.updateDart(prevD, currD, alpha, gt, currTick, hiddenFromHuman);

    // 2. Handle death animations
    if (!currP.alive) {
      this.heldDart.visible = false;
      this.dashCdRing.visible = false;
      if (this.sliceState?.active && this.slicedUpper && this.slicedLower) {
        this.updateSliceAnim(gt, deathEvents);
        return;
      }
      if (this.fallState?.active) {
        this.updatePitFallAnim(gt, deathEvents);
        return;
      }
      if (this.slashFallState) {
        this.updateSlashDeathAnim(gt, deathEvents);
        return;
      }
      this.root.visible = false;
      this.shadowBlob.visible = false;
      this.shadowBlob2.visible = false;
      this.groundRing.visible = false;
      return;
    }

    this.shadowBlob2.visible = false;

    // 3. Alive character interpolation (smooth 240Hz+!)
    const x = (prevP.x + (currP.x - prevP.x) * alpha) / 1000;
    const z = (prevP.y + (currP.y - prevP.y) * alpha) / 1000;

    if (!this.initializedPos) {
      this.prevX = x;
      this.prevZ = z;
      const rad = (currP.face / 100) * (Math.PI / 180);
      this.smoothedYaw = Math.PI * 0.5 - rad;
      this.initializedPos = true;
    }

    const stepDist = Math.hypot(x - this.prevX, z - this.prevZ);
    this.prevX = x;
    this.prevZ = z;
    if (currP.st === PState.FREE || currP.st === PState.THROW || currP.st === PState.THROWN) {
      this.walkDist += stepDist;
    }

    // Smooth visibility fade if hidden in grass from human
    const targetVis = hiddenFromHuman ? 0 : 1;
    this.visibilityAlpha += (targetVis - this.visibilityAlpha) * Math.min(1, frameDt * 18);
    if (this.visibilityAlpha < 0.02) {
      this.root.visible = false;
      this.shadowBlob.visible = false;
      this.groundRing.visible = false;
      this.dashCdRing.visible = false;
      return;
    }
    this.root.visible = true;

    const hq = this.highQuality;

    // Facing yaw interpolation
    const faceDeg0 = prevP.face / 100;
    const faceDeg1 = currP.face / 100;
    const dDeg = ((faceDeg1 - faceDeg0 + 540) % 360) - 180;
    const interpDeg = faceDeg0 + dDeg * alpha;
    let targetYaw = Math.PI * 0.5 - (interpDeg * Math.PI) / 180;

    // Face the kicker while stunned in HQ (pose.py:401-404)
    if (hq && currP.st === PState.STUN && this.lastStunFaceYaw !== null) {
      targetYaw = this.lastStunFaceYaw;
    }

    // Wait 4 logic frames after the last enemy dies before turning and celebrating;
    // during those 4 frames, maintain current action animation or stand still cleanly.
    const celebrateStartTick = currTick + WINNER_CELEBRATE_DELAY_TICKS;
    const celebrateNow = matchOver && isWinner && gt >= celebrateStartTick;

    if (celebrateNow) {
      targetYaw = winnerFaceYaw ?? 0; // Turn toward camera to celebrate!
    }

    const dYaw = ((targetYaw - this.smoothedYaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    this.smoothedYaw += dYaw * Math.min(1, frameDt * 24);

    // Speed & running hop factor (after matchOver, settle running stride smoothly to standstill)
    const speedMps = (Math.hypot(currP.vx, currP.vy) / 1000) * 20;
    const rawRf =
      currP.st === PState.FREE || currP.st === PState.THROW || currP.st === PState.THROWN
        ? clamp(speedMps / 5.0, 0, 1.15)
        : 0;
    const rf = matchOver ? rawRf * clamp(1 - Math.max(0, gt - currTick) / 1.5) : rawRf;
    const ph = (this.walkDist / 0.72) * Math.PI;
    const sinP = Math.sin(ph);
    const cosP = Math.cos(ph);
    const breath = Math.sin(gt * 0.42 + this.seat * 1.7);

    // Base procedural pose values
    let posY = 0.055 * Math.abs(sinP) * rf;
    let lean = 0.2 * rf;
    let roll = 0.05 * sinP * rf;
    let twist = 0;
    let sx = 1;
    let sy = 1 + 0.012 * breath * (1 - rf);
    let sz = 1;
    let bodyDy = 0.025 * Math.abs(sinP) * rf;
    let headPitch = -0.06 * rf;
    let headYaw = 0;
    let headRoll = 0.05 * sinP * rf;
    let hairBack = 0.45 * rf + 0.06 * Math.sin(2 * ph) * rf + 0.03 * breath;
    let hairSide = 0.08 * sinP * rf;
    let faceMode: 'open' | 'tight' | 'happy' = 'open';
    let flash = 0;

    // Arms & legs target offsets
    let armAF = -0.14 * sinP * rf;
    let armASide = 0.25;
    let armAU = 0.28 + 0.02 * rf;
    let armBF = 0.14 * sinP * rf;
    let armBSide = -0.25;
    let armBU = 0.28 + 0.02 * rf;
    let footAPitch = -0.55 * sinP * rf;
    let footBPitch = 0.55 * sinP * rf;
    let footALift = 0.04 * Math.max(0, cosP) * rf;
    let footBLift = 0.04 * Math.max(0, -cosP) * rf;

    // ---- State-specific procedural poses (ported from pose.py!) ----
    if (currP.st === PState.THROW) {
      lean = -0.18;
      twist = 0.75;
      sy = 0.91;
      sx = 1.06;
      armAF = -0.3;
      armAU = 0.75;
      armBF = 0.25;
      armBU = 0.42;
      headYaw = -0.32;
    } else if (currP.st === PState.THROWN || (this.lastThrowTick > -900 && gt >= this.lastThrowTick && gt - this.lastThrowTick < 4.5)) {
      const r = clamp((gt - this.lastThrowTick) / 4.5);
      const w = 1 - ease(r);
      lean += 0.42 * w;
      twist += -0.78 * w;
      armAF = armAF * (1 - w) + 0.48 * w;
      armAU = armAU * (1 - w) + 0.42 * w;
      armBF = armBF * (1 - w) - 0.24 * w;
      posY += 0.04 * bump(r * 2);
    }

    if (currP.st === PState.SLASH && !matchOver && gt - this.lastSlashTick >= 5.0) {
      lean = -0.12;
      twist = 1.05;
      sy = 0.9;
      sx = 1.06;
      armAF = -0.2;
      armASide = 0.4;
      armAU = 0.54;
    } else if ((!matchOver && currP.st === PState.SLASHED) || (this.lastSlashTick > -900 && gt >= this.lastSlashTick && gt - this.lastSlashTick < 5.0)) {
      const r = clamp((gt - this.lastSlashTick) / 5.0);
      const sw = eout(clamp((gt - this.lastSlashTick) / 1.8));
      const w = 1 - ease(Math.max(0, r - 0.35) / 0.65);
      twist = (1.05 - 2.2 * sw) * w;
      lean += 0.35 * bump(r) * w;
      const th = ((105 - 190 * sw) * Math.PI) / 180;
      armAF = 0.4 * Math.cos(th) * w + armAF * (1 - w);
      armASide = 0.4 * Math.sin(th) * w + armASide * (1 - w);
      armAU = 0.44 * w + armAU * (1 - w);
    }

    if (currP.st === PState.KICK && gt - this.lastKickTick >= 4.5) {
      sy = 0.86;
      sx = 1.08;
      lean = 0.12;
    } else if (currP.st === PState.KICKED || (this.lastKickTick > -900 && gt >= this.lastKickTick && gt - this.lastKickTick < 4.5)) {
      const r = clamp((gt - this.lastKickTick) / 4.5);
      const w = bump(r);
      posY += 0.14 * w;
      lean = -0.45 * w;
      footAPitch = -1.45 * w;
      footALift = 0.14 * w;
      armAF = -0.22 * w;
      armBF = -0.22 * w;
      headPitch = 0.24 * w;
    }

    if (currP.st === PState.DASH) {
      if (currP.timer > 6) {
        sy = 0.82;
        sx = 1.12;
        sz = 1.12;
        lean = 0.16;
      } else if (currP.timer > 2) {
        lean = 0.82;
        sy = 0.9;
        sx = 0.9;
        sz = 1.28;
        armAF = -0.28;
        armBF = -0.28;
        armAU = 0.42;
        armBU = 0.42;
        headPitch = -0.5;
        hairBack = 1.25;
      } else {
        lean = -0.15;
        sy = 0.94;
        sx = 1.06;
      }
    } else if (hq && this.lastDashEndTick > -900 && gt >= this.lastDashEndTick && gt - this.lastDashEndTick < 3.5) {
      // HQ damped spring stop recoil after dash (pose.py:362-365)
      const r = (gt - this.lastDashEndTick) / 3.5;
      const q = Math.exp(-r * 3.2) * Math.cos(r * 5.5);
      lean -= 0.3 * q;
      sy *= 1 - 0.12 * q;
      sx *= 1 + 0.1 * q;
      hairBack -= 0.5 * q;
    }

    // HQ catch damped squash & pick bend-down poses (pose.py:375-386)
    if (hq && this.lastCatchTick > -900 && gt >= this.lastCatchTick && gt - this.lastCatchTick < 3.5) {
      const r = (gt - this.lastCatchTick) / 3.5;
      const q = Math.exp(-r * 3.5) * Math.cos(r * 6.0);
      sy *= 1 - 0.12 * q;
      sx *= 1 + 0.08 * q;
    }
    if (hq && this.lastPickTick > -900 && gt >= this.lastPickTick && gt - this.lastPickTick < 3.4) {
      const b = bump((gt - this.lastPickTick) / 3.4);
      sy *= 1 - 0.24 * b;
      sx *= 1 + 0.1 * b;
      lean += 0.25 * b;
      armAF = armAF * (1 - b) + 0.16 * b;
      armAU = armAU * (1 - b) + 0.12 * b;
    }

    if (currP.st === PState.STUN) {
      const fl = Math.sin(gt * 2.4);
      posY += 0.2 * Math.sin(clamp((12 - currP.timer) / 12) * Math.PI);
      lean = -0.7;
      roll = 0.14 * fl;
      armAF = -0.06;
      armAU = 0.72 + 0.08 * fl;
      armBF = -0.06;
      armBU = 0.72 - 0.08 * fl;
      footAPitch = -0.45 + 0.2 * fl;
      footBPitch = -0.35 - 0.2 * fl;
      headPitch = 0.3;
      hairBack = -0.6;
      faceMode = 'tight';
      if (hq && this.lastStunTick > -900 && gt >= this.lastStunTick) {
        const u = Math.max(0, gt - this.lastStunTick);
        const sq = Math.exp(-u / 1.3);
        sy = 1 - 0.26 * sq + 0.06 * (1 - sq);
        sx = 1 + 0.2 * sq;
        flash = Math.max(flash, clamp(1 - u / 1.4) * 0.8);
      } else if (currP.timer >= 10) {
        flash = 0.65;
      }
    }

    if (currP.st === PState.RECALL) {
      armAF = 0.1;
      armAU = 0.88 + 0.04 * Math.sin(gt * 1.7);
      armBF = 0.06;
      armBU = 0.36;
      headPitch = -0.24;
      sy = 1.04 + 0.018 * Math.sin(gt * 1.7);
      lean = -0.04;
      hairBack = 0.14 + 0.06 * Math.sin(gt * 1.2);
    }

    // Training ground: invincible target got hit → white flash + a quick squash
    if (this.lastHurtTick > -900 && gt >= this.lastHurtTick) {
      const u = gt - this.lastHurtTick;
      flash = Math.max(flash, clamp(1 - u / 3.2) * 0.95);
      const sq = clamp(1 - u / 2.4);
      sy *= 1 - 0.14 * sq;
      sx *= 1 + 0.1 * sq;
      if (faceMode === 'open') faceMode = u < 4 ? 'tight' : faceMode;
    }

    // Grass stealth crouch & tint
    const targetStealth = inGrassStealth ? 1 : 0;
    this.stealthBlend += (targetStealth - this.stealthBlend) * Math.min(1, frameDt * 12);
    if (this.stealthBlend > 0.01) {
      sy *= 1 - 0.18 * this.stealthBlend;
      lean += 0.1 * this.stealthBlend;
    }

    // Victory celebration bounce (starts cleanly 4 logic frames after final kill)!
    if (celebrateNow) {
      const celDt = Math.max(0, gt - celebrateStartTick);
      const celBlend = ease(clamp(celDt / 1.6));
      const jp = ((celDt * 0.14) % 1 + 1) % 1;
      const jz = Math.sin(Math.PI * jp);
      const land = hq ? Math.exp(-jp * 9.0) + Math.exp(-(1 - jp) * 9.0) : 0;
      posY = 0.36 * jz;
      lean = lean * (1 - celBlend) - 0.05 * celBlend;
      roll = roll * (1 - celBlend);
      twist = twist * (1 - celBlend);
      sx = 1 - 0.05 * jz + 0.1 * land;
      sy = 1 + 0.1 * jz - 0.16 * land;
      sz = 1;
      armASide = armASide * (1 - celBlend) + 0.25 * celBlend;
      armBSide = armBSide * (1 - celBlend) - 0.25 * celBlend;
      armAU = armAU * (1 - celBlend) + 0.88 * celBlend;
      armBU = armBU * (1 - celBlend) + 0.88 * celBlend;
      armAF = armAF * (1 - celBlend) + 0.04 * celBlend;
      armBF = armBF * (1 - celBlend) + 0.04 * celBlend;
      footAPitch = footAPitch * (1 - celBlend);
      footBPitch = footBPitch * (1 - celBlend);
      footALift = footALift * (1 - celBlend);
      footBLift = footBLift * (1 - celBlend);
      headPitch = headPitch * (1 - celBlend) - 0.18 * celBlend;
      headYaw = headYaw * (1 - celBlend);
      headRoll = 0.09 * Math.sin(celDt * 0.65) * celBlend;
      hairBack = hq ? 0.25 * jz : 0.03 * breath;
      hairSide = 0;
      flash = 0;
      faceMode = 'happy';
      if (hq) {
        this.heldDart.rotation.set(Math.PI * 0.5, celDt * 0.55, 0);
      }
    } else {
      this.heldDart.rotation.set(Math.PI * 0.42, 0.2, 0.25);
    }

    // Apply transforms to root
    this.root.position.set(x, posY, z);
    this.root.rotation.set(lean, this.smoothedYaw, roll, 'YXZ');
    const baseScale = CHAR_SCALE * (this.model.scale || 1.0);
    this.rigRoot.scale.set(baseScale * sx, baseScale * sy, baseScale * sz);

    // Apply transforms to parts
    this.applyBodyPose(
      bodyDy,
      twist,
      headPitch,
      headYaw,
      headRoll,
      hairBack,
      hairSide,
      armAF,
      armASide,
      armAU,
      armBF,
      armBSide,
      armBU,
      footAPitch,
      footBPitch,
      footALift,
      footBLift,
    );

    this.setFace(faceMode);
    this.heldDart.visible = currD.st === DState.HAND;

    // Tint / flash
    for (const mat of this.partMaterials) {
      mat.color.copy(this._baseTint).lerp(this._grassTint, this.stealthBlend);
      if (flash > 0.01) {
        mat.emissive.copy(this._flashColor);
        mat.emissiveIntensity = 0.5 + flash * 0.85;
      } else {
        mat.emissive.setRGB(0.16, 0.16, 0.16);
        mat.emissiveIntensity = 0.45;
      }
    }

    // Shadow blob & colored ground ring (hide when over pit during dash/stun!)
    if (!onGround) {
      this.shadowBlob.visible = false;
      this.groundRing.visible = false;
      this.dashCdRing.visible = false;
    } else {
      this.shadowBlob.visible = true;
      const bs = Math.max(0.42, 1 - posY * 0.22);
      const liftShift = 0.16 + posY * 0.45;
      this.shadowBlob.position.set(x + this.sunProjX * liftShift, 0.014, z + this.sunProjZ * liftShift);
      this.shadowBlob.rotation.set(0, this.sunShadowYaw, 0);
      this.shadowBlob.scale.set(bs, 1, bs * this.sunShadowStretch);
      const heightFade = 1 / (1 + posY * 0.85);
      (this.shadowBlob.material as THREE.MeshBasicMaterial).opacity =
        0.42 * heightFade * (1 - 0.25 * this.stealthBlend) * this.visibilityAlpha;

      this.groundRing.visible = true;
      this.groundRing.position.set(x, 0.022, z);
      (this.groundRing.material as THREE.MeshBasicMaterial).opacity =
        (1 - 0.72 * this.stealthBlend) * 0.86 * this.visibilityAlpha;

      if (currP.cd > 0) {
        this.dashCdRing.visible = true;
        this.dashCdRing.position.set(x, 0.024, z);
        const pct = currP.cd / 20;
        this.dashCdRing.scale.set(0.85 + 0.15 * pct, 1, 0.85 + 0.15 * pct);
        (this.dashCdRing.material as THREE.MeshBasicMaterial).opacity = 0.45 * pct * this.visibilityAlpha;
      } else {
        this.dashCdRing.visible = false;
      }
    }
  }

  private applyBodyPose(
    bodyDy: number,
    twist: number,
    headPitch: number,
    headYaw: number,
    headRoll: number,
    hairBack: number,
    hairSide: number,
    armAF: number,
    armASide: number,
    armAU: number,
    armBF: number,
    armBSide: number,
    armBU: number,
    footAPitch: number,
    footBPitch: number,
    footALift: number,
    footBLift: number,
  ) {
    const body = this.parts.get('body');
    if (body) {
      body.position.set(0, bodyDy, 0);
      body.rotation.set(0, twist, 0);
    }
    const head = this.parts.get('head');
    if (head) {
      const rh = this.restPos.get('head')!;
      head.position.set(rh.x, rh.y + bodyDy, rh.z);
      head.rotation.set(headPitch, headYaw + twist * 0.5, headRoll);
    }
    const hairback = this.parts.get('hairback');
    if (hairback) {
      hairback.rotation.set(hairBack * (this.model.hair_swing || 1.0), hairSide * 0.5, 0);
    }
    const tailL = this.parts.get('tailL');
    if (tailL) {
      tailL.rotation.set(hairBack * 1.05, hairSide * 0.4, -(0.04 + hairBack * 0.25));
    }
    const tailR = this.parts.get('tailR');
    if (tailR) {
      tailR.rotation.set(hairBack * 1.05, hairSide * 0.4, 0.04 + hairBack * 0.25);
    }
    const tail = this.parts.get('tail');
    if (tail) {
      tail.rotation.set(-(this.model.tail_rest || 0) + hairBack * 0.45, hairSide * 1.2, 0);
    }

    this.aimArm('armA', armAF, armASide, armAU, 1);
    this.aimArm('armB', armBF, armBSide, armBU, -1);

    const footA = this.parts.get('footA');
    if (footA) {
      const rfA = this.restPos.get('footA')!;
      footA.position.set(rfA.x, rfA.y + footALift, rfA.z);
      footA.rotation.set(footAPitch, 0, 0);
    }
    const footB = this.parts.get('footB');
    if (footB) {
      const rfB = this.restPos.get('footB')!;
      footB.position.set(rfB.x, rfB.y + footBLift, rfB.z);
      footB.rotation.set(footBPitch, 0, 0);
    }
  }

  private aimArm(name: string, f: number, sd: number, u: number, sg: number) {
    const arm = this.parts.get(name);
    if (!arm) return;
    const dx = (sd * sg - 0.22) * sg;
    const dy = u - 0.42;
    const dz = f;
    this._tmpDir.set(dx, dy, dz);
    const len = this._tmpDir.length();
    if (len < 1e-4) {
      this._tmpDir.set(0, -1, 0);
    } else {
      this._tmpDir.divideScalar(len);
    }
    this._tmpQuat.setFromUnitVectors(this._downVec, this._tmpDir);
    arm.quaternion.copy(this._tmpQuat);
    const stretch = 1 + 0.25 * clamp((len - 0.14) / 0.35);
    arm.scale.set(1, stretch, 1);
  }

  private updateDart(
    prevD: DartSnapshot,
    currD: DartSnapshot,
    alpha: number,
    gt: number,
    currTick: number,
    hiddenFromHuman: boolean,
  ) {
    const hq = this.highQuality;
    const wasFlying = prevD.st === DState.OUT || prevD.st === DState.BACK || prevD.st === DState.CALL;
    if (wasFlying && (currD.st === DState.GROUND || currD.st === DState.RISE)) {
      if (this.lastDartLandTick < currTick - 0.5) {
        this.lastDartLandTick = currTick;
      }
    }

    if (currD.st === DState.HAND || currD.st === DState.GONE) {
      this.flyingDart.visible = false;
      this.dartBlurDisc.visible = false;
      return;
    }

    const usePrev = prevD.st !== DState.HAND && prevD.st !== DState.GONE;
    const x = (usePrev ? prevD.x + (currD.x - prevD.x) * alpha : currD.x) / 1000;
    const z = (usePrev ? prevD.y + (currD.y - prevD.y) * alpha : currD.y) / 1000;

    this.flyingDart.visible = true;
    const flying = currD.st === DState.OUT || currD.st === DState.BACK || currD.st === DState.CALL;
    let dartGlow = 0;

    if (flying) {
      let y = 0.66;
      if (hq && currD.st === DState.BACK && currD.age < 4) {
        // Apex hang lift at boomerang turnaround (pose.py:653-655)
        y += 0.22 * bump((currD.age + alpha) / 3.6);
      } else if (currD.st === DState.CALL) {
        y += 0.08 * Math.sin(gt * 1.4);
      }
      const spin = gt * 2.15 + this.seat * 1.3;
      this.flyingDart.position.set(x, y, z);
      this.flyingDart.rotation.set(0, spin, hq ? 0.12 : 0);
      const sc = !hq && currD.st === DState.BACK && currD.age < 3 ? 1.08 + 0.08 * Math.sin(gt * 2.5) : 1.0;
      this.flyingDart.scale.setScalar(sc);

      // HQ spinning translucent blur disc (positioned cleanly beneath dual outline shells when enabled)
      if (hq) {
        this.dartBlurDisc.visible = true;
        this.dartBlurDisc.position.set(x, y - (this.dartOutline ? 0.098 : 0.01), z);
        this.dartBlurDisc.rotation.set(0, spin * 0.37, 0);
      } else {
        this.dartBlurDisc.visible = false;
      }
    } else if (currD.st === DState.RISE) {
      this.dartBlurDisc.visible = false;
      const prog = clamp(1 - (currD.left - alpha) / 12);
      if (hq) {
        const y = 0.06 + 0.34 * prog * prog + 0.03 * Math.sin(gt * 3.0);
        const tilt = 0.22 * Math.sin(gt * 2.7) * (1 - prog);
        const baseSpin = 2.15 * Math.max(0, this.lastDartLandTick) + this.seat * 1.3 + 6.0;
        this.flyingDart.position.set(x, y, z);
        this.flyingDart.rotation.set(tilt, baseSpin + 10.0 * prog * prog, tilt * 0.6);
        this.flyingDart.scale.setScalar(0.84 + prog * 0.16);
        const sGlow = Math.sin(gt * 2.4);
        dartGlow = 0.35 + 0.35 * sGlow * sGlow;
      } else {
        const jx = 0.035 * Math.sin(gt * 4.5) * (0.3 + prog);
        const jz = 0.035 * Math.cos(gt * 5.2) * (0.3 + prog);
        this.flyingDart.position.set(x + jx, 0.1 + prog * 0.45, z + jz);
        this.flyingDart.rotation.set(0.18 * (1 - prog), gt * (0.4 + prog * 1.8), 0);
        this.flyingDart.scale.setScalar(0.95 + prog * 0.15);
      }
    } else {
      // Ground dart (double bounce + wobble settle in HQ, pose.py:668-680!)
      this.dartBlurDisc.visible = false;
      const u = gt - this.lastDartLandTick;
      if (hq && this.lastDartLandTick > -900 && u >= 0 && u < 9) {
        const e = Math.exp(-u / 3.2);
        const y = 0.065 + 0.38 * Math.abs(Math.cos(u * 0.85)) * e;
        const tilt = 0.5 * Math.sin(u * 1.4) * e;
        const spin = 2.15 * this.lastDartLandTick + this.seat * 1.3 + 6.0 * (1 - Math.exp(-u / 3.0));
        this.flyingDart.position.set(x, y, z);
        this.flyingDart.rotation.set(tilt, spin, tilt * 0.6);
        this.flyingDart.scale.setScalar(0.84);
      } else {
        this.flyingDart.position.set(x, this.dartOutline ? 0.12 : 0.08, z);
        const settleSpin = hq && this.lastDartLandTick > -900 ? 2.15 * this.lastDartLandTick + this.seat * 1.3 + 6.0 : this.seat * 1.1;
        this.flyingDart.rotation.set(0.12, settleSpin, 0);
        this.flyingDart.scale.setScalar(hq ? 0.84 : 0.92);
      }
    }

    if (this.flyingDartMat) {
      this.flyingDartMat.emissiveIntensity = 0.14 + dartGlow * 0.85;
    }
    void hiddenFromHuman;
  }

  private updateSliceAnim(gt: number, deathEvents?: RigDeathEffectCallbacks) {
    const H = this.sliceState!;
    const upper = this.slicedUpper!;
    const lower = this.slicedLower!;
    const u = Math.max(0, gt - H.startTick);
    const hq = this.highQuality;
    const life = hq ? SLICE_LIFE : 22;
    const poofT = hq ? SLICE_POOF : 17;

    if (u > life) {
      upper.visible = false;
      lower.visible = false;
      this.shadowBlob.visible = false;
      this.shadowBlob2.visible = false;
      return;
    }

    // Faithful port of pose.py slice_curve(u) + chars_voxel.py _apply_slice!
    const carry =
      0.11 * (1 - Math.exp(-u / 0.3)) + (SLICE_UP_GO - 0.11) * (1 - Math.exp(-Math.max(0, u - 0.4) / 2.6));
    const lift = 0.08 * bump(u / 1.8);
    const v = u - 0.9;
    let thUp = 0;
    if (v <= 0) thUp = 0.05 * clamp(u / 0.6);
    else if (v < 3.6) thUp = 0.05 + (Math.PI * 0.5 + 0.12 - 0.05) * Math.pow(ease(v / 3.6), 1.3);
    else thUp = Math.PI * 0.5 + 0.12 * Math.cos((v - 3.6) * 1.6) * Math.exp(-(v - 3.6) / 1.5);

    const w = u - 3.0;
    let thLow = 0;
    if (w <= 0) thLow = 0.045 * Math.sin(u * 2.6) * clamp(u / 0.8);
    else if (w < 2.8) thLow = Math.PI * 0.5 * Math.pow(ease(w / 2.8), 1.7);
    else thLow = Math.PI * 0.5 - 0.1 * Math.abs(Math.sin((w - 2.8) * 1.5)) * Math.exp(-(w - 2.8) / 1.2);

    const fadeScale = 1 - ease((u - poofT) / (life - poofT));
    const baseS = CHAR_SCALE * (this.model.scale || 1.0) * fadeScale;

    // Trigger poof FX on each grounded half when disappearing in HQ (pose.py:771-774)
    if (hq && u >= poofT && !H.poofFired) {
      H.poofFired = true;
      if (H.landUpper) {
        deathEvents?.onPoof?.(H.x + H.dx * SLICE_UP_GO, 0.25, H.z + H.dz * SLICE_UP_GO, 0.7);
      }
      if (H.landLower) {
        deathEvents?.onPoof?.(H.x + H.sx * SLICE_LOW_GO * 0.6, 0.25, H.z + H.sz * SLICE_LOW_GO * 0.6, 0.7);
      }
    }

    // Impact white flash on sliced halves in HQ (pose.py:100)
    if (this.slicedMat) {
      const flash = hq ? 0.75 * clamp(1 - (u - 0.2) / 0.9) : 0;
      if (flash > 0.01) {
        this.slicedMat.emissive.copy(this._flashColor);
        this.slicedMat.emissiveIntensity = 0.45 + flash * 0.9;
      } else {
        this.slicedMat.emissive.setRGB(0.2, 0.2, 0.2);
        this.slicedMat.emissiveIntensity = 0.45;
      }
    }

    const tau = Math.max(0, u - 0.9);
    const G = 0.03;

    if (hq) {
      // Exact world-axis roll around dart flight vector d so both flat cut faces flip toward camera (+s)!
      this._axisD.set(H.dx, 0, H.dz).normalize();
      const crossDot = -H.dz * H.sx + H.dx * H.sz;
      const sg = crossDot >= 0 ? 1 : -1;
      const yawUp = 0.35 * eout(tau / 6);

      // Upper half: slides along dart direction, flips away from camera (cut face turns toward viewer), falls into pit if !landUpper!
      let upperY = this.sliceCutY + lift - 0.5 * G * tau * tau;
      if (tau <= 0 || carry < 0.24) {
        upperY = Math.max(upperY, this.sliceCutY);
      } else if (H.landUpper) {
        upperY = Math.max(upperY, 0.18);
      }
      const upX = H.x + H.dx * carry;
      const upZ = H.z + H.dz * carry;
      upper.visible = upperY > -9.0 && baseS > 0.01;
      upper.position.set(upX, upperY, upZ);
      this._qYaw.setFromAxisAngle(this._upVec, H.yaw);
      this._qRoll.setFromAxisAngle(this._axisD, -sg * thUp);
      this._qSpin.setFromAxisAngle(this._upVec, yawUp * sg);
      upper.quaternion.copy(this._qSpin).multiply(this._qRoll).multiply(this._qYaw);
      upper.scale.setScalar(baseS);

      // Lower half: wobbles then tips toward camera (+s), falls into pit if !landLower!
      let lowerY = 0.02;
      if (!H.landLower) {
        const vl = Math.max(0, u - 4.5);
        lowerY = 0.02 - 0.5 * G * vl * vl;
      }
      const lowTipOff = Math.min(1.0, thLow / 1.5) * 0.14;
      lower.visible = lowerY > -9.0 && baseS > 0.01;
      lower.position.set(H.x + H.sx * lowTipOff, lowerY, H.z + H.sz * lowTipOff);
      this._qRoll.setFromAxisAngle(this._axisD, sg * thLow);
      lower.quaternion.copy(this._qRoll).multiply(this._qYaw);
      lower.scale.setScalar(baseS);

      // Dual independent ground shadows (chars_voxel.py:323-342)
      const ga = clamp(1 - (u - poofT) / 2.5) * 0.42;
      if (H.landLower && ga > 0.01) {
        this.shadowBlob.visible = true;
        this.shadowBlob.position.set(H.x + H.sx * lowTipOff * 1.4, 0.015, H.z + H.sz * lowTipOff * 1.4);
        this.shadowBlob.rotation.set(0, 0, 0);
        this.shadowBlob.scale.set(0.95, 1, 0.95);
        (this.shadowBlob.material as THREE.MeshBasicMaterial).opacity = ga;
      } else {
        this.shadowBlob.visible = false;
      }
      if (H.landUpper && ga > 0.01 && carry >= 0.24) {
        this.shadowBlob2.visible = true;
        this.shadowBlob2.position.set(upX, 0.015, upZ);
        this.shadowBlob2.rotation.set(0, 0, 0);
        this.shadowBlob2.scale.set(0.88, 1, 0.88);
        const hgtFade = Math.max(0.3, 1 - Math.max(0, upperY - 0.18) * 1.2);
        (this.shadowBlob2.material as THREE.MeshBasicMaterial).opacity = ga * hgtFade;
      } else {
        this.shadowBlob2.visible = false;
      }
    } else {
      const upperY = Math.max(0.18, this.sliceCutY + lift - 0.03 * tau * tau);
      upper.position.set(H.x + H.dx * carry, upperY, H.z + H.dz * carry);
      upper.rotation.set(thUp, H.yaw + 0.35 * eout(tau / 6), 0, 'YXZ');
      upper.scale.setScalar(baseS);

      lower.position.set(H.x, 0.02, H.z);
      lower.rotation.set(thLow, H.yaw, 0, 'YXZ');
      lower.scale.setScalar(baseS);

      this.shadowBlob.visible = true;
      this.shadowBlob.position.set(H.x, 0.015, H.z);
      (this.shadowBlob.material as THREE.MeshBasicMaterial).opacity = 0.25 * fadeScale;
      this.shadowBlob2.visible = false;
    }
  }

  private updateSlashDeathAnim(gt: number, deathEvents?: RigDeathEffectCallbacks) {
    const S = this.slashFallState!;
    const u = Math.max(0, gt - S.startTick);
    const hq = this.highQuality;
    const life = hq ? 10.5 : 12;
    if (u > life) {
      this.root.visible = false;
      this.shadowBlob.visible = false;
      return;
    }
    this.root.visible = true;
    const dist = 2.7 * (1 - Math.exp(-u / 4.5));
    const curX = S.x + S.dx * dist;
    const curZ = S.z + S.dz * dist;
    const y = Math.max(0, 0.4 * u - 0.026 * u * u);

    // Disappear poof at u=8.6 (pose.py:776-777)
    if (hq && u >= 8.6 && !S.poofFired) {
      S.poofFired = true;
      deathEvents?.onPoof?.(curX, y + 0.5, curZ, 1.0);
    }

    const sc = 1 - ease((u - (hq ? 7.5 : 8)) / (hq ? 3.0 : 4));
    const sq = hq ? Math.exp(-u / 0.9) : 0;
    const baseScale = CHAR_SCALE * (this.model.scale || 1.0) * sc;
    this.root.position.set(curX, y, curZ);
    this.root.rotation.set(-0.62 * u, this.smoothedYaw, 0.2 * u, 'YXZ');
    this.rigRoot.scale.set(baseScale * (1 + 0.2 * sq), baseScale * (1 - 0.2 * sq), baseScale);

    if (hq) {
      const fl = Math.sin(u * 2.2);
      this.applyBodyPose(
        0,
        0,
        0.2,
        0,
        0.1 * fl,
        0.9,
        0.2 * fl,
        0,
        0.32,
        0.68 + 0.08 * fl,
        0,
        -0.32,
        0.68 - 0.08 * fl,
        -0.45 * fl,
        0.45 * fl,
        0.04,
        0.04,
      );
      const flash = clamp(1 - (u - 0.65) / 0.7);
      for (const mat of this.partMaterials) {
        if (flash > 0.01) {
          mat.emissive.copy(this._flashColor);
          mat.emissiveIntensity = 0.5 + flash * 0.85;
        } else {
          mat.emissive.setRGB(0.16, 0.16, 0.16);
          mat.emissiveIntensity = 0.45;
        }
      }
    }

    this.setFace('tight');
    this.shadowBlob.visible = sc > 0.05;
    this.shadowBlob.position.set(curX, 0.015, curZ);
    (this.shadowBlob.material as THREE.MeshBasicMaterial).opacity = 0.28 * sc;
  }

  private updatePitFallAnim(gt: number, deathEvents?: RigDeathEffectCallbacks) {
    const F = this.fallState!;
    const u = Math.max(0, gt - F.startTick);
    const hq = this.highQuality;

    if (!hq) {
      const y = -0.055 * u * u - 0.08 * u;
      if (y < -12) {
        this.root.visible = false;
        return;
      }
      this.root.visible = true;
      const drift = (F.kicked ? 1.8 : 1.1) * (1 - Math.exp(-u / 3.5));
      const sc = Math.max(0.25, 1 - 0.55 * clamp(-y / 12));
      const baseScale = CHAR_SCALE * (this.model.scale || 1.0) * sc;
      this.root.position.set(F.x + F.vx * drift, y, F.z + F.vz * drift);
      this.root.rotation.set(
        F.kicked ? -0.25 * u : 0.35 * u,
        this.smoothedYaw + 0.12 * u,
        0.2 * Math.sin(u * 1.8),
        'YXZ',
      );
      this.rigRoot.scale.setScalar(baseScale);
      this.setFace('tight');
      return;
    }

    // Faithful 3-mode pit-fall port of pose.py:561-632 (walk / kick / ground)
    const kind = F.kind;
    const hang = FALL_HANG[kind];
    const f = Math.max(0, u - hang);
    const y = -0.5 * FALL_G * f * f - (kind === 'ground' ? 0.05 * f : 0);
    if (y < -13.5) {
      this.root.visible = false;
      return;
    }
    this.root.visible = true;

    const drift = (kind === 'kick' ? 3.2 : 2.2) * (1 - Math.exp(-u / 3.0));
    const curX = F.x + F.vx * drift;
    const curZ = F.z + F.vz * drift;

    // Trigger billowing cloud-sea splash when passing y = -10.5 (pose.py:781-783)
    if (y <= FALL_SPLASH_Y && !F.splashFired) {
      F.splashFired = true;
      deathEvents?.onCloudSplash?.(curX, curZ);
    }

    const sc = 1 - 0.55 * clamp(-y / 12.0);
    const fl = Math.sin(u * 2.2);
    let sx = 1;
    let sy = 1;
    let lean = 0;
    let roll = 0;
    let spin = 0;
    let headPitch = 0.2;
    let headRoll = 0.1 * fl;
    let hairBack = 1.4;
    let hairSide = 0.2 * fl;
    let armAF = 0;
    let armASide = 0.3;
    let armAU = 0.8 + 0.08 * fl;
    let armBF = 0;
    let armBSide = -0.3;
    let armBU = 0.8 - 0.08 * fl;
    let footAPitch = -0.4 * fl;
    let footBPitch = 0.4 * fl;
    let footALift = 0.04;
    let footBLift = 0.04;
    let posY = y;

    if (kind === 'walk' && u < hang) {
      // Teetering on cliff edge: escalating sway + windmilling arms + back foot kicked up!
      const a = u / hang;
      const sw = Math.sin(u * 3.4) * (0.25 + 0.35 * a);
      posY = 0.02 * bump(a);
      lean = sw + 0.5 * a * a;
      sy = 1.04;
      sx = 0.97;
      armAF = 0.12 * Math.cos(u * 4.2);
      armASide = 0.36;
      armAU = 0.62 + 0.24 * Math.sin(u * 4.2);
      armBF = 0.12 * Math.cos(u * 4.2 + 2.6);
      armBSide = -0.36;
      armBU = 0.62 + 0.24 * Math.sin(u * 4.2 + 2.6);
      footAPitch = -0.25;
      footBPitch = 0.72 + 0.25 * a;
      footALift = 0;
      footBLift = 0.1 + 0.05 * Math.sin(u * 3.4);
      headPitch = 0.25 * sw;
      headRoll = 0.08 * fl;
      hairBack = 0.3 - sw;
    } else {
      sy = 1.06;
      sx = 0.94;
      roll = 0.25 * fl;
      if (kind === 'walk') {
        // Head-first forward tumble after losing balance
        lean = 0.5 + (0.5 + 0.2 * f + 0.004 * f * f);
        spin = 0.05 * f;
      } else if (kind === 'kick') {
        // Face-up backward tumble with flailing limbs
        lean = -0.75 - (0.15 * u + 0.004 * u * u);
        footAPitch = -0.75 + 0.28 * fl;
        footBPitch = -0.55 - 0.28 * fl;
        footALift = 0.12 + 0.05 * fl;
        footBLift = 0.06 - 0.05 * fl;
        headPitch = 0.3;
      } else {
        // Ground collapsed underneath: startled squash then arms straight up spinning down
        const q = Math.exp(-u / 1.6);
        sy = 1.06 - 0.2 * q;
        sx = 0.94 + 0.12 * q;
        lean = -0.1 - 0.02 * f;
        spin = 0.08 * f;
        armAF = 0.05;
        armASide = 0.26;
        armAU = 0.9 + 0.06 * fl;
        armBF = 0.05;
        armBSide = -0.26;
        armBU = 0.9 - 0.06 * fl;
      }
    }

    const baseScale = CHAR_SCALE * (this.model.scale || 1.0) * sc;
    this.root.position.set(curX, posY, curZ);
    this.root.rotation.set(lean, this.smoothedYaw + spin, roll, 'YXZ');
    this.rigRoot.scale.set(baseScale * sx, baseScale * sy, baseScale);

    this.applyBodyPose(
      0,
      0,
      headPitch,
      0,
      headRoll,
      hairBack,
      hairSide,
      armAF,
      armASide,
      armAU,
      armBF,
      armBSide,
      armBU,
      footAPitch,
      footBPitch,
      footALift,
      footBLift,
    );
    this.setFace('tight');
    for (const mat of this.partMaterials) {
      mat.emissive.setRGB(0.16, 0.16, 0.16);
      mat.emissiveIntensity = 0.45;
    }
  }

  public dispose(parentScene: THREE.Scene) {
    parentScene.remove(this.root);
    parentScene.remove(this.flyingDart);
    parentScene.remove(this.dartBlurDisc);
    parentScene.remove(this.shadowBlob);
    parentScene.remove(this.shadowBlob2);
    parentScene.remove(this.groundRing);
    parentScene.remove(this.dashCdRing);
    this.dartBlurDisc.geometry.dispose();
    (this.dartBlurDisc.material as THREE.Material).dispose();
    (this.shadowBlob2.material as THREE.Material).dispose();
    if (this.slicedUpper) parentScene.remove(this.slicedUpper);
    if (this.slicedLower) parentScene.remove(this.slicedLower);
    if (this.slicedMat) this.slicedMat.dispose();
    disposeVoxelDartMesh(this.flyingDart);
    disposeVoxelDartMesh(this.heldDart);
    for (const m of this.partMaterials) m.dispose();
  }
}
