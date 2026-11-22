import * as THREE from 'three';
import { CauseType, DState, PState, PlayerSnapshot, DartSnapshot } from '../game/types';
import {
  buildSlicedHalves,
  buildVoxelDartMesh,
  buildVoxelPartGeometry,
  CHAR_SCALE,
  createVoxelMaterial,
  getOutlineMaterial,
  VOX_U,
  VoxelModelData,
} from './voxelBuilder';

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
}

export interface FallAnimState {
  active: boolean;
  startTick: number;
  x: number;
  z: number;
  vx: number;
  vz: number;
  kicked: boolean;
}

/**
 * Hierarchical voxel character rig with smooth 240Hz+ procedural animation
 * ported from pose.py & chars_voxel.py.
 */
export class CharacterRig {
  public readonly seat: number;
  public readonly model: VoxelModelData;
  public readonly color: string;
  public readonly ringColor: string;
  public readonly root = new THREE.Group();
  public readonly rigRoot = new THREE.Group();
  public readonly heldDart: THREE.Group;
  public readonly flyingDart: THREE.Group;
  public readonly groundRing: THREE.Mesh;
  public readonly shadowBlob: THREE.Mesh;
  public readonly dashCdRing: THREE.Mesh;

  private parts = new Map<string, THREE.Group>();
  private restPos = new Map<string, THREE.Vector3>();
  private partMaterials: THREE.MeshLambertMaterial[] = [];

  // Pre-built sliced halves (lazy built on boomerang kill!)
  private slicedUpper: THREE.Group | null = null;
  private slicedLower: THREE.Group | null = null;
  private sliceCutY = 0.36;
  public sliceState: SliceAnimState | null = null;
  public fallState: FallAnimState | null = null;
  public slashFallState: { startTick: number; x: number; z: number; dx: number; dz: number } | null = null;

  // Action animation timers (in game ticks, continuous float)
  public lastThrowTick = -999;
  public lastSlashTick = -999;
  public lastKickTick = -999;
  public lastCatchTick = -999;
  public lastPickTick = -999;
  public actionDirAngle = 0;

  // Smoothed continuous walk phase and facing
  private walkDist = 0;
  private prevX = 0;
  private prevZ = 0;
  private initializedPos = false;
  private smoothedYaw = 0;
  private stealthBlend = 0;
  private visibilityAlpha = 1;

  // Scratch vectors to guarantee ZERO per-frame allocations at 240Hz+!
  private readonly _tmpDir = new THREE.Vector3();
  private readonly _downVec = new THREE.Vector3(0, -1, 0);
  private readonly _tmpQuat = new THREE.Quaternion();
  private readonly _baseTint = new THREE.Color(1, 1, 1);
  private readonly _grassTint = new THREE.Color(0.62, 0.84, 0.72);
  private readonly _flashColor = new THREE.Color(1, 1, 1);

  constructor(
    seat: number,
    model: VoxelModelData,
    ringColor: string,
    isHuman: boolean,
    parentScene: THREE.Scene,
  ) {
    this.seat = seat;
    this.model = model;
    this.color = model.color;
    this.ringColor = ringColor;

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
      mesh.castShadow = true;
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

    // World-space flying / ground boomerang
    this.flyingDart = buildVoxelDartMesh(this.color, 1.42);
    this.flyingDart.visible = false;
    parentScene.add(this.flyingDart);

    // Ground contact shadow blob
    const blobGeo = new THREE.CircleGeometry(0.46, 20);
    blobGeo.rotateX(-Math.PI / 2);
    const blobMat = new THREE.MeshBasicMaterial({
      color: '#1b1628',
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
    });
    this.shadowBlob = new THREE.Mesh(blobGeo, blobMat);
    this.shadowBlob.position.y = 0.015;
    parentScene.add(this.shadowBlob);

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

    // Dash cooldown ring (subtle inner arc for human / all players)
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
  ) {
    if (!this.slicedUpper || !this.slicedLower) {
      const built = buildSlicedHalves(this.model, this.color);
      this.slicedUpper = built.upper;
      this.slicedLower = built.lower;
      this.sliceCutY = built.cutY;
      parentScene.add(this.slicedUpper);
      parentScene.add(this.slicedLower);
    }
    const len = Math.hypot(dx, dz) || 1;
    const ndx = dx / len;
    const ndz = dz / len;
    // Perpendicular direction pointing toward camera (+Z)
    let sx = -ndz;
    let sz = ndx;
    if (sz < -0.01) {
      sx = ndz;
      sz = -ndx;
    }
    this.sliceState = { active: true, startTick: tick, x, z, yaw, dx: ndx, dz: ndz, sx, sz };
    this.root.visible = false;
    this.groundRing.visible = false;
    this.dashCdRing.visible = false;
    this.slicedUpper.visible = true;
    this.slicedLower.visible = true;
  }

  public triggerSlashDeath(tick: number, x: number, z: number, dx: number, dz: number) {
    const len = Math.hypot(dx, dz) || 1;
    this.slashFallState = { startTick: tick, x, z, dx: dx / len, dz: dz / len };
    this.groundRing.visible = false;
    this.dashCdRing.visible = false;
  }

  public triggerPitFall(tick: number, x: number, z: number, vx: number, vz: number, kicked: boolean) {
    this.fallState = { active: true, startTick: tick, x, z, vx, vz, kicked };
    this.groundRing.visible = false;
    this.dashCdRing.visible = false;
    this.shadowBlob.visible = false;
  }

  public update(
    prevP: PlayerSnapshot,
    currP: PlayerSnapshot,
    prevD: DartSnapshot,
    currD: DartSnapshot,
    alpha: number,
    gt: number,
    isWinner: boolean,
    matchOver: boolean,
    hiddenFromHuman: boolean,
    inGrassStealth: boolean,
    onGround: boolean,
    frameDt: number,
  ) {
    // 1. Update flying / ground boomerang
    this.updateDart(prevD, currD, alpha, gt, hiddenFromHuman);

    // 2. Handle death animations
    if (!currP.alive) {
      this.heldDart.visible = false;
      this.dashCdRing.visible = false;
      if (this.sliceState?.active && this.slicedUpper && this.slicedLower) {
        this.updateSliceAnim(gt);
        return;
      }
      if (this.fallState?.active) {
        this.updatePitFallAnim(gt);
        return;
      }
      if (this.slashFallState) {
        this.updateSlashDeathAnim(gt);
        return;
      }
      this.root.visible = false;
      this.shadowBlob.visible = false;
      this.groundRing.visible = false;
      return;
    }

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

    // Facing yaw interpolation
    const faceDeg0 = prevP.face / 100;
    const faceDeg1 = currP.face / 100;
    let dDeg = ((faceDeg1 - faceDeg0 + 540) % 360) - 180;
    const interpDeg = faceDeg0 + dDeg * alpha;
    let targetYaw = Math.PI * 0.5 - (interpDeg * Math.PI) / 180;

    if (matchOver && isWinner) {
      targetYaw = 0; // Turn toward camera to celebrate!
    }

    let dYaw = ((targetYaw - this.smoothedYaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    this.smoothedYaw += dYaw * Math.min(1, frameDt * 24);

    // Speed & running hop factor
    const speedMps = Math.hypot(currP.vx, currP.vy) / 1000 * 20; // m/s (full run = 5 m/s)
    const rf =
      currP.st === PState.FREE || currP.st === PState.THROW || currP.st === PState.THROWN
        ? clamp(speedMps / 5.0, 0, 1.15)
        : 0;
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
      // Windup before releasing dart
      lean = -0.18;
      twist = 0.75;
      sy = 0.91;
      sx = 1.06;
      armAF = -0.3;
      armAU = 0.75;
      armBF = 0.25;
      armBU = 0.42;
      headYaw = -0.32;
    } else if (currP.st === PState.THROWN || gt - this.lastThrowTick < 4.5) {
      const r = clamp((gt - this.lastThrowTick) / 4.5);
      const w = 1 - ease(r);
      lean += 0.42 * w;
      twist += -0.78 * w;
      armAF = armAF * (1 - w) + 0.48 * w;
      armAU = armAU * (1 - w) + 0.42 * w;
      armBF = armBF * (1 - w) - 0.24 * w;
      posY += 0.04 * bump(r * 2);
    }

    if (currP.st === PState.SLASH) {
      lean = -0.12;
      twist = 1.05;
      sy = 0.9;
      sx = 1.06;
      armAF = -0.2;
      armASide = 0.4;
      armAU = 0.54;
    } else if (currP.st === PState.SLASHED || gt - this.lastSlashTick < 5.0) {
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

    if (currP.st === PState.KICK) {
      sy = 0.86;
      sx = 1.08;
      lean = 0.12;
    } else if (currP.st === PState.KICKED || gt - this.lastKickTick < 4.5) {
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
        // Pre-dash crouch
        sy = 0.82;
        sx = 1.12;
        sz = 1.12;
        lean = 0.16;
      } else if (currP.timer > 2) {
        // High-speed dash lunge
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
        // Dash recovery bounce
        lean = -0.15;
        sy = 0.94;
        sx = 1.06;
      }
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
      if (currP.timer >= 10) flash = 0.65;
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

    // Grass stealth crouch & tint
    const targetStealth = inGrassStealth ? 1 : 0;
    this.stealthBlend += (targetStealth - this.stealthBlend) * Math.min(1, frameDt * 12);
    if (this.stealthBlend > 0.01) {
      sy *= 1 - 0.18 * this.stealthBlend;
      lean += 0.1 * this.stealthBlend;
    }

    // Victory celebration bounce!
    if (matchOver && isWinner) {
      const jp = ((gt * 0.14) % 1 + 1) % 1;
      const jz = Math.sin(Math.PI * jp);
      posY = 0.36 * jz;
      sy = 1 + 0.1 * jz;
      sx = 1 - 0.05 * jz;
      armAU = 0.88;
      armBU = 0.88;
      armAF = 0.04;
      armBF = 0.04;
      headPitch = -0.18;
      headRoll = 0.09 * Math.sin(gt * 0.65);
      faceMode = 'happy';
    }

    // Apply transforms to root
    this.root.position.set(x, posY, z);
    this.root.rotation.set(lean, this.smoothedYaw, roll, 'YXZ');
    const baseScale = CHAR_SCALE * (this.model.scale || 1.0);
    this.rigRoot.scale.set(baseScale * sx, baseScale * sy, baseScale * sz);

    // Apply transforms to parts
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

    // Rotate arms toward target hand vectors
    this.aimArm('armA', armAF, armASide, armAU, 1);
    this.aimArm('armB', armBF, armBSide, armBU, -1);

    // Swing legs
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

    this.setFace(faceMode);
    this.heldDart.visible = currD.st === DState.HAND;

    // Tint / flash
    for (const mat of this.partMaterials) {
      mat.color.copy(this._baseTint).lerp(this._grassTint, this.stealthBlend);
      if (flash > 0.01) {
        mat.emissive.copy(this._flashColor);
        mat.emissiveIntensity = 0.5 + flash * 0.8;
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
      const bs = Math.max(0.35, 1 - posY * 0.35);
      this.shadowBlob.position.set(x, 0.015, z);
      this.shadowBlob.scale.set(bs, 1, bs);
      (this.shadowBlob.material as THREE.MeshBasicMaterial).opacity = 0.34 * this.visibilityAlpha;

      this.groundRing.visible = true;
      this.groundRing.position.set(x, 0.022, z);
      (this.groundRing.material as THREE.MeshBasicMaterial).opacity =
        (1 - 0.72 * this.stealthBlend) * 0.86 * this.visibilityAlpha;

      // Dash cooldown ring indicator
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

  private aimArm(name: string, f: number, sd: number, u: number, sg: number) {
    const arm = this.parts.get(name);
    if (!arm) return;
    // Map (forward, side, height) into local Three.js arm direction (+Z forward, +Y up, +X left)
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
    hiddenFromHuman: boolean,
  ) {
    if (currD.st === DState.HAND || currD.st === DState.GONE) {
      this.flyingDart.visible = false;
      return;
    }
    // If dart just left hand on this tick, avoid snapping from an old position
    const usePrev = prevD.st !== DState.HAND && prevD.st !== DState.GONE;
    const x = (usePrev ? prevD.x + (currD.x - prevD.x) * alpha : currD.x) / 1000;
    const z = (usePrev ? prevD.y + (currD.y - prevD.y) * alpha : currD.y) / 1000;

    this.flyingDart.visible = true;
    const flying = currD.st === DState.OUT || currD.st === DState.BACK || currD.st === DState.CALL;
    if (flying) {
      const bob = currD.st === DState.CALL ? 0.08 * Math.sin(gt * 1.4) : 0;
      this.flyingDart.position.set(x, 0.66 + bob, z);
      this.flyingDart.rotation.set(0, gt * 2.3 + this.seat * 1.3, 0);
      const sc = currD.st === DState.BACK && currD.age < 3 ? 1.08 + 0.08 * Math.sin(gt * 2.5) : 1.0;
      this.flyingDart.scale.setScalar(sc);
    } else if (currD.st === DState.RISE) {
      // Shaking and levitating slightly during recall channel!
      const prog = clamp(1 - currD.left / 12);
      const jx = 0.035 * Math.sin(gt * 4.5) * (0.3 + prog);
      const jz = 0.035 * Math.cos(gt * 5.2) * (0.3 + prog);
      this.flyingDart.position.set(x + jx, 0.1 + prog * 0.45, z + jz);
      this.flyingDart.rotation.set(0.18 * (1 - prog), gt * (0.4 + prog * 1.8), 0);
      this.flyingDart.scale.setScalar(0.95 + prog * 0.15);
    } else {
      // Ground dart
      this.flyingDart.position.set(x, 0.09, z);
      this.flyingDart.rotation.set(0.14, this.seat * 1.1, 0);
      this.flyingDart.scale.setScalar(0.92);
    }
    void hiddenFromHuman;
  }

  private updateSliceAnim(gt: number) {
    const H = this.sliceState!;
    const upper = this.slicedUpper!;
    const lower = this.slicedLower!;
    const u = Math.max(0, gt - H.startTick);
    const LIFE = 22;
    const POOF = 17;
    if (u > LIFE) {
      upper.visible = false;
      lower.visible = false;
      this.shadowBlob.visible = false;
      return;
    }

    // Faithful port of pose.py slice_curve(u)!
    const carry = 0.12 * (1 - Math.exp(-u / 0.3)) + 1.15 * (1 - Math.exp(-Math.max(0, u - 0.4) / 2.6));
    const lift = 0.09 * bump(u / 1.8);
    const v = u - 0.9;
    let thUp = 0;
    if (v <= 0) thUp = 0.05 * clamp(u / 0.6);
    else if (v < 3.6) thUp = 0.05 + (Math.PI * 0.5 + 0.12 - 0.05) * Math.pow(ease(v / 3.6), 1.3);
    else thUp = Math.PI * 0.5 + 0.12 * Math.cos((v - 3.6) * 1.6) * Math.exp(-(v - 3.6) / 1.5);

    const w = u - 3.0;
    let thLow = 0;
    if (w <= 0) thLow = 0.05 * Math.sin(u * 2.6) * clamp(u / 0.8);
    else if (w < 2.8) thLow = Math.PI * 0.5 * Math.pow(ease(w / 2.8), 1.7);
    else thLow = Math.PI * 0.5 - 0.1 * Math.abs(Math.sin((w - 2.8) * 1.5)) * Math.exp(-(w - 2.8) / 1.2);

    const fadeScale = 1 - ease((u - POOF) / (LIFE - POOF));
    const baseS = CHAR_SCALE * (this.model.scale || 1.0) * fadeScale;

    // Upper half slides along dart direction and falls onto the ground
    const tau = Math.max(0, u - 0.9);
    const upperY = Math.max(0.18, this.sliceCutY + lift - 0.03 * tau * tau);
    upper.position.set(H.x + H.dx * carry, upperY, H.z + H.dz * carry);
    upper.rotation.set(thUp, H.yaw + 0.35 * eout(tau / 6), 0, 'YXZ');
    upper.scale.setScalar(baseS);

    // Lower half wobbles then tips forward toward camera
    lower.position.set(H.x, 0.02, H.z);
    lower.rotation.set(thLow, H.yaw, 0, 'YXZ');
    lower.scale.setScalar(baseS);

    this.shadowBlob.visible = true;
    this.shadowBlob.position.set(H.x, 0.015, H.z);
    (this.shadowBlob.material as THREE.MeshBasicMaterial).opacity = 0.25 * fadeScale;
  }

  private updateSlashDeathAnim(gt: number) {
    const S = this.slashFallState!;
    const u = Math.max(0, gt - S.startTick);
    if (u > 12) {
      this.root.visible = false;
      this.shadowBlob.visible = false;
      return;
    }
    this.root.visible = true;
    const dist = 2.6 * (1 - Math.exp(-u / 4.2));
    const y = Math.max(0, 0.42 * u - 0.028 * u * u);
    const sc = 1 - ease((u - 8) / 4);
    const baseScale = CHAR_SCALE * (this.model.scale || 1.0) * sc;
    this.root.position.set(S.x + S.dx * dist, y, S.z + S.dz * dist);
    this.root.rotation.set(-0.62 * u, this.smoothedYaw, 0.2 * u, 'YXZ');
    this.rigRoot.scale.setScalar(baseScale);
    this.setFace('tight');
    this.shadowBlob.visible = sc > 0.05;
    this.shadowBlob.position.set(S.x + S.dx * dist, 0.015, S.z + S.dz * dist);
    (this.shadowBlob.material as THREE.MeshBasicMaterial).opacity = 0.28 * sc;
  }

  private updatePitFallAnim(gt: number) {
    const F = this.fallState!;
    const u = Math.max(0, gt - F.startTick);
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
    this.root.rotation.set(F.kicked ? -0.25 * u : 0.35 * u, this.smoothedYaw + 0.12 * u, 0.2 * Math.sin(u * 1.8), 'YXZ');
    this.rigRoot.scale.setScalar(baseScale);
    this.setFace('tight');
  }

  public dispose(parentScene: THREE.Scene) {
    parentScene.remove(this.root);
    parentScene.remove(this.flyingDart);
    parentScene.remove(this.shadowBlob);
    parentScene.remove(this.groundRing);
    parentScene.remove(this.dashCdRing);
    if (this.slicedUpper) parentScene.remove(this.slicedUpper);
    if (this.slicedLower) parentScene.remove(this.slicedLower);
    for (const m of this.partMaterials) m.dispose();
  }
}
