import * as THREE from 'three';
import { CellType, EngineMapData } from '../game/types';
import {
  applyCloseupOcclusionStep,
  ArenaMapUpdateOpts,
  disposeOccluderEntries,
  IArenaMap,
  OccluderEntry,
} from './hqMapBuilder';
import { getTheme, ThemeConfig } from './themes';

interface TileInstanceRef {
  idx: number;
  cx: number;
  cz: number;
  baseY: number;
  scaleX: number;
  scaleY: number;
  scaleZ: number;
  rotY: number;
  wave: number;
  rndA: number;
  rndB: number;
  baseColor: THREE.Color;
  modified?: boolean;
  /** 0 = intact/warning, 1 = actively dropping, 2 = fallen out of sight */
  shadowState?: 0 | 1 | 2;
}

function hash2(x: number, y: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return h - Math.floor(h);
}

interface WallClusterBatch {
  bodyMesh: THREE.InstancedMesh;
  topMesh: THREE.InstancedMesh;
  bodyTiles: TileInstanceRef[];
  topTiles: TileInstanceRef[];
}

/**
 * Builds a stylized floating-island 3D arena matching the official 10 map themes,
 * using InstancedMeshes so the entire island renders in minimal draw calls (240Hz+ ready!)
 * while supporting smooth per-wave collapse warning shake/glow, falling tiles, and
 * close-up foreground occlusion semi-transparency.
 */
export class ArenaMap3D implements IArenaMap {
  public readonly root = new THREE.Group();
  public readonly mapData: EngineMapData;
  public readonly theme: ThemeConfig;
  public readonly widthM: number;
  public readonly heightM: number;

  private floorMesh!: THREE.InstancedMesh;
  private cliffMesh!: THREE.InstancedMesh;
  private wallClusters: WallClusterBatch[] = [];
  private wallSharedGeos: THREE.BufferGeometry[] = [];
  private grassMesh: THREE.InstancedMesh | null = null;
  private cloudMesh!: THREE.InstancedMesh;
  private ambientMesh: THREE.InstancedMesh | null = null;

  private floorTiles: TileInstanceRef[] = [];
  private cliffTiles: TileInstanceRef[] = [];
  private grassTiles: TileInstanceRef[] = [];
  private readonly occluders: OccluderEntry[] = [];
  private cloudData: { x: number; y: number; z: number; sx: number; sy: number; sz: number; speed: number }[] = [];
  private ambientData: { x: number; y: number; z: number; vx: number; vy: number; vz: number; phase: number; s: number }[] = [];

  private readonly _dummy = new THREE.Object3D();
  private readonly _tmpCol = new THREE.Color();
  private readonly _warnCol = new THREE.Color('#ff5a2b');
  private readonly _dirScratch = new THREE.Vector3();
  private lastShadowBakeGt = -9999;

  constructor(mapData: EngineMapData, themeName: string) {
    this.mapData = mapData;
    this.theme = getTheme(themeName);
    const cellM = mapData.cell / 1000;
    this.widthM = mapData.nx * cellM;
    this.heightM = mapData.ny * cellM;

    this.buildTerrain();
    this.buildWalls();
    this.buildGrass();
    this.buildClouds();
    this.buildAmbientParticles();
  }

  private buildTerrain() {
    const { nx, ny, cells, waves, cell } = this.mapData;
    const cs = cell / 1000;
    const T = this.theme;

    const colA = new THREE.Color(T.groundA);
    const colB = new THREE.Color(T.groundB);
    const colRim = new THREE.Color(T.groundRim);
    const colCliffTop = new THREE.Color(T.cliffTop);
    const colCliffMid = new THREE.Color(T.cliffMid);
    const colCliffDeep = new THREE.Color(T.cliffDeep);

    const solidCoords: { gx: number; gy: number; isEdge: boolean; isGrass: boolean; wave: number }[] = [];
    for (let gy = 0; gy < ny; gy++) {
      for (let gx = 0; gx < nx; gx++) {
        const ct = cells[gy * nx + gx];
        if (ct === CellType.PIT) continue;
        // Edge detection for cliff rim highlights
        let isEdge = false;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ax = gx + dx;
          const ay = gy + dy;
          if (ax < 0 || ay < 0 || ax >= nx || ay >= ny || cells[ay * nx + ax] === CellType.PIT) {
            isEdge = true;
            break;
          }
        }
        solidCoords.push({ gx, gy, isEdge, isGrass: ct === CellType.GRASS, wave: waves[gy * nx + gx] });
      }
    }

    const count = Math.max(1, solidCoords.length);

    // Top surface slab (chunky cohesive island top!)
    const floorGeo = new THREE.BoxGeometry(cs * 1.005, 0.28, cs * 1.005);
    const floorMat = new THREE.MeshLambertMaterial({ color: '#ffffff' });
    this.floorMesh = new THREE.InstancedMesh(floorGeo, floorMat, count);
    this.floorMesh.receiveShadow = true;

    // Cohesive solid floating-island rock cliff underside (overlaps cleanly with zero gaps!)
    const cliffGeo = new THREE.CylinderGeometry(cs * 0.8, cs * 0.62, 1.75, 4);
    cliffGeo.rotateY(Math.PI / 4);
    const cliffMat = new THREE.MeshLambertMaterial({ color: '#ffffff', flatShading: true });
    this.cliffMesh = new THREE.InstancedMesh(cliffGeo, cliffMat, count);

    solidCoords.forEach((sc, idx) => {
      const cx = (sc.gx + 0.5) * cs;
      const cz = (sc.gy + 0.5) * cs;
      const r1 = hash2(sc.gx, sc.gy);
      const r2 = hash2(sc.gx + 31, sc.gy + 17);

      // Subtle checkerboard / organic patch color variation
      const patch = Math.sin(sc.gx * 0.45 + sc.gy * 0.35) * 0.5 + 0.5;
      const c = colA.clone().lerp(colB, patch * 0.65 + r1 * 0.35);
      if (sc.isEdge) c.lerp(colRim, 0.24);
      if (sc.isGrass) c.multiplyScalar(0.86);

      const yJitter = (r2 - 0.5) * 0.01;
      this._dummy.position.set(cx, -0.14 + yJitter, cz);
      this._dummy.rotation.set(0, 0, 0);
      this._dummy.scale.set(1, 1, 1);
      this._dummy.updateMatrix();
      this.floorMesh.setMatrixAt(idx, this._dummy.matrix);
      this.floorMesh.setColorAt(idx, c);
      this.floorTiles.push({
        idx,
        cx,
        cz,
        baseY: -0.14 + yJitter,
        scaleX: 1,
        scaleY: 1,
        scaleZ: 1,
        rotY: 0,
        wave: sc.wave,
        rndA: r1,
        rndB: r2,
        baseColor: c,
      });

      // Cliff underside column (deeper toward center of island!)
      const cliffScaleY = sc.isEdge ? 0.78 + r1 * 0.35 : 1.05 + r1 * 0.5;
      const cliffCol = colCliffTop.clone().lerp(sc.isEdge ? colCliffMid : colCliffDeep, 0.28 + r2 * 0.45);
      const cliffY = -0.24 - 0.94 * cliffScaleY;
      this._dummy.position.set(cx, cliffY, cz);
      this._dummy.rotation.set(0, 0, 0);
      this._dummy.scale.set(1.06, cliffScaleY, 1.06);
      this._dummy.updateMatrix();
      this.cliffMesh.setMatrixAt(idx, this._dummy.matrix);
      this.cliffMesh.setColorAt(idx, cliffCol);
      this.cliffTiles.push({
        idx,
        cx,
        cz,
        baseY: cliffY,
        scaleX: 1.06,
        scaleY: cliffScaleY,
        scaleZ: 1.06,
        rotY: 0,
        wave: sc.wave,
        rndA: r1,
        rndB: r2,
        baseColor: cliffCol,
      });
    });

    this.floorMesh.instanceMatrix.needsUpdate = true;
    if (this.floorMesh.instanceColor) this.floorMesh.instanceColor.needsUpdate = true;
    this.cliffMesh.instanceMatrix.needsUpdate = true;
    if (this.cliffMesh.instanceColor) this.cliffMesh.instanceColor.needsUpdate = true;

    this.root.add(this.floorMesh);
    this.root.add(this.cliffMesh);
  }

  private buildWalls() {
    const { nx, ny, cells, waves, cell } = this.mapData;
    const cs = cell / 1000;
    const T = this.theme;

    const walls: { gx: number; gy: number; wave: number }[] = [];
    for (let gy = 0; gy < ny; gy++) {
      for (let gx = 0; gx < nx; gx++) {
        if (cells[gy * nx + gx] === CellType.WALL) {
          walls.push({ gx, gy, wave: waves[gy * nx + gx] });
        }
      }
    }
    if (walls.length === 0) return;

    let bodyGeo: THREE.BufferGeometry;
    let topGeo: THREE.BufferGeometry;
    let baseH = 0.88;
    let topOffset = 0.48;

    switch (T.wallKind) {
      case 'ice':
        bodyGeo = new THREE.CylinderGeometry(cs * 0.22, cs * 0.56, 1.25, 5);
        topGeo = new THREE.ConeGeometry(cs * 0.34, 0.45, 5);
        baseH = 1.25;
        topOffset = 0.72;
        break;
      case 'menhir':
        bodyGeo = new THREE.BoxGeometry(cs * 0.88, 1.32, cs * 0.88);
        topGeo = new THREE.BoxGeometry(cs * 0.68, 0.22, cs * 0.68);
        baseH = 1.32;
        topOffset = 0.72;
        break;
      case 'houses':
        bodyGeo = new THREE.BoxGeometry(cs * 0.98, 0.96, cs * 0.98);
        topGeo = new THREE.ConeGeometry(cs * 0.76, 0.62, 4);
        topGeo.rotateY(Math.PI / 4);
        baseH = 0.96;
        topOffset = 0.76;
        break;
      case 'trees':
        bodyGeo = new THREE.CylinderGeometry(cs * 0.24, cs * 0.34, 0.9, 6);
        topGeo = new THREE.DodecahedronGeometry(cs * 0.74, 0);
        baseH = 0.9;
        topOffset = 0.68;
        break;
      case 'crates':
        bodyGeo = new THREE.BoxGeometry(cs * 0.94, 0.84, cs * 0.94);
        topGeo = new THREE.BoxGeometry(cs * 0.98, 0.14, cs * 0.98);
        baseH = 0.84;
        topOffset = 0.44;
        break;
      case 'hoodoo':
        bodyGeo = new THREE.CylinderGeometry(cs * 0.44, cs * 0.56, 1.15, 6);
        topGeo = new THREE.CylinderGeometry(cs * 0.54, cs * 0.42, 0.28, 6);
        baseH = 1.15;
        topOffset = 0.64;
        break;
      case 'masonry':
        bodyGeo = new THREE.BoxGeometry(cs * 0.96, 1.0, cs * 0.96);
        topGeo = new THREE.BoxGeometry(cs * 0.86, 0.18, cs * 0.86);
        baseH = 1.0;
        topOffset = 0.54;
        break;
      default: // boulder & garden
        bodyGeo = new THREE.CylinderGeometry(cs * 0.44, cs * 0.58, 0.94, 6);
        topGeo = new THREE.CylinderGeometry(cs * 0.4, cs * 0.5, 0.22, 6);
        baseH = 0.94;
        topOffset = 0.5;
        break;
    }

    this.wallSharedGeos.push(bodyGeo, topGeo);

    const cSide = new THREE.Color(T.wallSide);
    const cTop = new THREE.Color(T.wallTop);
    const cAcc = new THREE.Color(T.wallAccent);

    // Group walls into compact 4x4 spatial clusters sharing ONE opaque body/top material pair
    // (lazy-cloned ONLY on the 1-2 clusters actively blocking a close-up camera -> 240Hz+ everywhere!).
    const sharedBodyMat = new THREE.MeshLambertMaterial({ color: '#ffffff', flatShading: true });
    const sharedTopMat = new THREE.MeshLambertMaterial({ color: '#ffffff', flatShading: true });

    const clusterMap = new Map<string, { gx: number; gy: number; wave: number }[]>();
    for (const w of walls) {
      const key = `${Math.floor(w.gx / 4)}_${Math.floor(w.gy / 4)}`;
      let arr = clusterMap.get(key);
      if (!arr) {
        arr = [];
        clusterMap.set(key, arr);
      }
      arr.push(w);
    }

    for (const [, list] of clusterMap) {
      const bodyMesh = new THREE.InstancedMesh(bodyGeo, sharedBodyMat, list.length);
      const topMesh = new THREE.InstancedMesh(topGeo, sharedTopMat, list.length);
      bodyMesh.castShadow = true;
      bodyMesh.receiveShadow = true;
      topMesh.castShadow = true;

      const bodyTiles: TileInstanceRef[] = [];
      const topTiles: TileInstanceRef[] = [];
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, maxY = 0.8;

      list.forEach((w, idx) => {
        const cx = (w.gx + 0.5) * cs;
        const cz = (w.gy + 0.5) * cs;
        const r1 = hash2(w.gx * 3 + 7, w.gy * 5 + 11);
        const r2 = hash2(w.gx * 7 + 19, w.gy * 2 + 3);
        const hScale = T.wallKind === 'houses' || T.wallKind === 'crates' ? 0.95 + r1 * 0.12 : 0.84 + r1 * 0.34;
        const rot = T.wallKind === 'houses' || T.wallKind === 'masonry' || T.wallKind === 'crates' ? 0 : r2 * Math.PI * 2;
        const by = (baseH * hScale) * 0.5;

        const bc = cSide.clone().lerp(cAcc, r2 * 0.28);
        this._dummy.position.set(cx, by, cz);
        this._dummy.rotation.set(0, rot, 0);
        this._dummy.scale.set(1, hScale, 1);
        this._dummy.updateMatrix();
        bodyMesh.setMatrixAt(idx, this._dummy.matrix);
        bodyMesh.setColorAt(idx, bc);
        bodyTiles.push({
          idx,
          cx,
          cz,
          baseY: by,
          scaleX: 1,
          scaleY: hScale,
          scaleZ: 1,
          rotY: rot,
          wave: w.wave,
          rndA: r1,
          rndB: r2,
          baseColor: bc,
        });

        const ty = baseH * hScale + (topOffset - baseH * 0.5);
        const tc = cTop.clone().lerp(cAcc, r1 * 0.35);
        const ts = T.wallKind === 'trees' ? 0.92 + r2 * 0.26 : 1.0;
        this._dummy.position.set(cx, ty, cz);
        this._dummy.rotation.set(0, rot, 0);
        this._dummy.scale.set(ts, ts, ts);
        this._dummy.updateMatrix();
        topMesh.setMatrixAt(idx, this._dummy.matrix);
        topMesh.setColorAt(idx, tc);
        topTiles.push({
          idx,
          cx,
          cz,
          baseY: ty,
          scaleX: ts,
          scaleY: ts,
          scaleZ: ts,
          rotY: rot,
          wave: w.wave,
          rndA: r1,
          rndB: r2,
          baseColor: tc,
        });

        minX = Math.min(minX, cx - cs * 0.5);
        maxX = Math.max(maxX, cx + cs * 0.5);
        minZ = Math.min(minZ, cz - cs * 0.5);
        maxZ = Math.max(maxZ, cz + cs * 0.5);
        maxY = Math.max(maxY, ty + cs * 0.65);
      });

      bodyMesh.instanceMatrix.needsUpdate = true;
      if (bodyMesh.instanceColor) bodyMesh.instanceColor.needsUpdate = true;
      topMesh.instanceMatrix.needsUpdate = true;
      if (topMesh.instanceColor) topMesh.instanceColor.needsUpdate = true;

      this.root.add(bodyMesh);
      this.root.add(topMesh);
      this.wallClusters.push({ bodyMesh, topMesh, bodyTiles, topTiles });

      this.occluders.push({
        meshes: [bodyMesh, topMesh],
        opaqueMaterials: [sharedBodyMat, sharedTopMat],
        fadeMaterials: null,
        baseOpacities: [1, 1],
        box: new THREE.Box3(new THREE.Vector3(minX, 0, minZ), new THREE.Vector3(maxX, maxY, maxZ)),
        isGrass: false,
        minOpacity: 0.24,
        curOpacity: 1.0,
        usingFade: false,
        wave: list[0].wave,
      });
    }
  }

  private buildGrass() {
    const { nx, ny, cells, waves, cell } = this.mapData;
    const cs = cell / 1000;
    const T = this.theme;

    const grassCells: { gx: number; gy: number; wave: number }[] = [];
    for (let gy = 0; gy < ny; gy++) {
      for (let gx = 0; gx < nx; gx++) {
        if (cells[gy * nx + gx] === CellType.GRASS) {
          grassCells.push({ gx, gy, wave: waves[gy * nx + gx] });
        }
      }
    }
    if (grassCells.length === 0) return;

    // 3 stylized tufts per grass cell (high visual lushness, 1 single draw call!)
    const perCell = 3;
    const total = grassCells.length * perCell;
    const tuftGeo = new THREE.ConeGeometry(0.11, 0.56, 4);
    tuftGeo.translate(0, 0.28, 0);
    const tuftMat = new THREE.MeshLambertMaterial({ color: '#ffffff', flatShading: true });
    this.grassMesh = new THREE.InstancedMesh(tuftGeo, tuftMat, total);

    const cMid = new THREE.Color(T.grassMid);
    const cTip = new THREE.Color(T.grassTip);
    const cAcc = T.grassAccent ? new THREE.Color(T.grassAccent) : cTip;

    let idx = 0;
    for (const g of grassCells) {
      const baseCx = (g.gx + 0.5) * cs;
      const baseCz = (g.gy + 0.5) * cs;
      for (let k = 0; k < perCell; k++) {
        const r1 = hash2(g.gx * 11 + k * 7, g.gy * 13 + k * 3);
        const r2 = hash2(g.gx * 5 + k * 19, g.gy * 17 + k * 23);
        const ang = (k / perCell) * Math.PI * 2 + r1 * 1.4;
        const rad = 0.08 + r2 * 0.14;
        const cx = baseCx + Math.cos(ang) * rad;
        const cz = baseCz + Math.sin(ang) * rad;
        const sy = 0.78 + r1 * 0.42;
        const sx = 0.85 + r2 * 0.3;
        const col = r2 > 0.82 && T.grassAccent ? cAcc.clone() : cMid.clone().lerp(cTip, r1 * 0.7);

        this._dummy.position.set(cx, 0, cz);
        this._dummy.rotation.set(0, r1 * Math.PI * 2, 0);
        this._dummy.scale.set(sx, sy, sx);
        this._dummy.updateMatrix();
        this.grassMesh.setMatrixAt(idx, this._dummy.matrix);
        this.grassMesh.setColorAt(idx, col);
        this.grassTiles.push({
          idx,
          cx,
          cz,
          baseY: 0,
          scaleX: sx,
          scaleY: sy,
          scaleZ: sx,
          rotY: r1 * Math.PI * 2,
          wave: g.wave,
          rndA: r1,
          rndB: r2,
          baseColor: col,
        });
        idx++;
      }
    }

    this.grassMesh.instanceMatrix.needsUpdate = true;
    if (this.grassMesh.instanceColor) this.grassMesh.instanceColor.needsUpdate = true;
    this.root.add(this.grassMesh);
  }

  private buildClouds() {
    const T = this.theme;
    const count = 46;
    const geo = new THREE.SphereGeometry(1.0, 12, 8);
    const mat = new THREE.MeshLambertMaterial({
      color: '#ffffff',
      emissive: new THREE.Color(T.cloud),
      emissiveIntensity: 0.48,
      flatShading: false,
    });
    this.cloudMesh = new THREE.InstancedMesh(geo, mat, count);

    const cMain = new THREE.Color(T.cloud);
    const cShade = new THREE.Color(T.cloudShade);
    const cx0 = this.widthM * 0.5;
    const cz0 = this.heightM * 0.5;

    for (let i = 0; i < count; i++) {
      const r1 = hash2(i * 3.1, 1.7);
      const r2 = hash2(i * 7.3, 4.9);
      const r3 = hash2(i * 11.7, 9.1);
      const x = cx0 + (r1 - 0.5) * (this.widthM + 36);
      const z = cz0 + (r2 - 0.5) * (this.heightM + 28);
      const y = -8.2 - r3 * 4.2;
      const sx = 2.8 + r1 * 3.8;
      const sy = 0.85 + r3 * 0.85;
      const sz = 2.4 + r2 * 3.2;
      const speed = 0.24 + r3 * 0.32;
      this.cloudData.push({ x, y, z, sx, sy, sz, speed });

      this._dummy.position.set(x, y, z);
      this._dummy.rotation.set(0, r1 * Math.PI, 0);
      this._dummy.scale.set(sx, sy, sz);
      this._dummy.updateMatrix();
      this.cloudMesh.setMatrixAt(i, this._dummy.matrix);
      this.cloudMesh.setColorAt(i, cMain.clone().lerp(cShade, r3 * 0.35));
    }

    this.cloudMesh.instanceMatrix.needsUpdate = true;
    if (this.cloudMesh.instanceColor) this.cloudMesh.instanceColor.needsUpdate = true;
    this.root.add(this.cloudMesh);
  }

  private buildAmbientParticles() {
    const cols = this.theme.ambientParticles;
    if (!cols || cols.length === 0) return;
    const count = 42;
    const geo = new THREE.PlaneGeometry(0.14, 0.14);
    const mat = new THREE.MeshBasicMaterial({
      color: '#ffffff',
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.78,
    });
    this.ambientMesh = new THREE.InstancedMesh(geo, mat, count);
    for (let i = 0; i < count; i++) {
      const r1 = hash2(i, 12.3);
      const r2 = hash2(i, 45.6);
      const r3 = hash2(i, 78.9);
      this.ambientData.push({
        x: r1 * (this.widthM + 6) - 3,
        y: 1.0 + r3 * 6.5,
        z: r2 * (this.heightM + 6) - 3,
        vx: 0.35 + r1 * 0.4,
        vy: -0.55 - r3 * 0.45,
        vz: 0.2 + r2 * 0.3,
        phase: r1 * Math.PI * 2,
        s: 0.7 + r2 * 0.7,
      });
      this.ambientMesh.setColorAt(i, new THREE.Color(cols[i % cols.length]));
    }
    if (this.ambientMesh.instanceColor) this.ambientMesh.instanceColor.needsUpdate = true;
    this.root.add(this.ambientMesh);
  }

  /**
   * Update collapsing tiles, grass sway, drifting clouds, and ambient petals/snow at 240Hz+.
   */
  public update(
    gt: number,
    elapsedSec: number,
    opts?: ArenaMapUpdateOpts,
  ): boolean {
    const { waveSteps, colWarn } = this.mapData;
    const freezeT = opts?.freezeCollapseAtTick;
    let shadowDirty = false;
    let anyShadowWallDropping = false;

    const updateGroup = (
      mesh: THREE.InstancedMesh | null,
      tiles: TileInstanceRef[],
      sway: boolean,
      warnTint: boolean,
      trackShadow = false,
    ) => {
      if (!mesh || tiles.length === 0) return;
      let dirtyMat = false;
      let dirtyCol = false;

      for (let i = 0; i < tiles.length; i++) {
        const ti = tiles[i];
        const w = ti.wave;
        const fallStep = w >= 0 && w < waveSteps.length ? waveSteps[w] : -1;

        // Once the match/replay has ended (freezeT !== undefined), tiles that had NOT yet
        // fallen at freezeT stop warning/collapsing completely, while tiles already mid-fall
        // smoothly finish dropping into the clouds.
        const alreadyFalling = fallStep >= 0 && (freezeT !== undefined ? fallStep <= freezeT : gt >= fallStep);
        if (alreadyFalling && gt >= fallStep) {
          // Falling into the cloud sea!
          ti.modified = true;
          const u = gt - fallStep;
          if (u < 35) {
            const drop = 0.045 * u * u + 0.06 * u;
            this._dummy.position.set(ti.cx, ti.baseY - drop, ti.cz);
            this._dummy.rotation.set(
              (ti.rndA - 0.5) * u * 0.14,
              ti.rotY + (ti.rndB - 0.5) * u * 0.1,
              (ti.rndB - 0.5) * u * 0.14,
            );
            const sc = Math.max(0.01, 1 - u / 35);
            this._dummy.scale.set(ti.scaleX * sc, ti.scaleY * sc, ti.scaleZ * sc);
            this._dummy.updateMatrix();
            mesh.setMatrixAt(ti.idx, this._dummy.matrix);
            dirtyMat = true;
            if (trackShadow) {
              anyShadowWallDropping = true;
              if (ti.shadowState !== 1) {
                ti.shadowState = 1;
                shadowDirty = true;
              }
            }
          } else {
            this._dummy.position.set(ti.cx, -100, ti.cz);
            this._dummy.scale.set(0.0001, 0.0001, 0.0001);
            this._dummy.updateMatrix();
            mesh.setMatrixAt(ti.idx, this._dummy.matrix);
            dirtyMat = true;
            if (trackShadow && ti.shadowState !== 2) {
              ti.shadowState = 2;
              shadowDirty = true;
            }
          }
          continue;
        }

        if (freezeT === undefined && fallStep >= 0 && gt >= fallStep - colWarn) {
          // Collapse warning: shake + urgent orange-red pulse!
          ti.modified = true;
          const warnSec = Math.max(0, (gt - (fallStep - colWarn)) * 0.05);
          const prog = Math.min(1, warnSec / (Math.max(1, colWarn) * 0.05));
          const amp = (0.014 + 0.032 * prog) * prog;
          const jx = Math.sin(warnSec * 46 + ti.rndA * 20) * amp;
          const jz = Math.cos(warnSec * 52 + ti.rndB * 20) * amp;
          this._dummy.position.set(ti.cx + jx, ti.baseY - 0.03 * prog, ti.cz + jz);
          this._dummy.rotation.set(0, ti.rotY, 0);
          this._dummy.scale.set(ti.scaleX, ti.scaleY, ti.scaleZ);
          this._dummy.updateMatrix();
          mesh.setMatrixAt(ti.idx, this._dummy.matrix);
          dirtyMat = true;

          if (warnTint) {
            // Exact phase integral of ω(t) = 10 + 14 * prog(t) rad/s (1.59 → 3.82 Hz)
            const pulse = 0.35 + 0.5 * (0.5 + 0.5 * Math.sin(warnSec * (10 + 7 * prog)));
            this._tmpCol.copy(ti.baseColor).lerp(this._warnCol, pulse * (0.35 + 0.55 * prog));
            mesh.setColorAt(ti.idx, this._tmpCol);
            dirtyCol = true;
          }
          if (trackShadow && (ti.shadowState ?? 0) !== 0) {
            ti.shadowState = 0;
            shadowDirty = true;
          }
          continue;
        }

        if (ti.modified) {
          // Restore intact tile transform & original color after rewinding/restarting replay!
          ti.modified = false;
          if (!sway) {
            this._dummy.position.set(ti.cx, ti.baseY, ti.cz);
            this._dummy.rotation.set(0, ti.rotY, 0);
            this._dummy.scale.set(ti.scaleX, ti.scaleY, ti.scaleZ);
            this._dummy.updateMatrix();
            mesh.setMatrixAt(ti.idx, this._dummy.matrix);
            dirtyMat = true;
          }
          if (warnTint) {
            mesh.setColorAt(ti.idx, ti.baseColor);
            dirtyCol = true;
          }
          if (trackShadow && (ti.shadowState ?? 0) !== 0) {
            ti.shadowState = 0;
            shadowDirty = true;
          }
        }

        if (sway) {
          const bend = Math.sin(elapsedSec * 2.4 + ti.cx * 0.9 + ti.rndA * 6) * 0.14;
          this._dummy.position.set(ti.cx, ti.baseY, ti.cz);
          this._dummy.rotation.set(bend, ti.rotY, bend * 0.6);
          this._dummy.scale.set(ti.scaleX, ti.scaleY, ti.scaleZ);
          this._dummy.updateMatrix();
          mesh.setMatrixAt(ti.idx, this._dummy.matrix);
          dirtyMat = true;
        }
      }

      if (dirtyMat) mesh.instanceMatrix.needsUpdate = true;
      if (dirtyCol && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    };

    updateGroup(this.floorMesh, this.floorTiles, false, true);
    updateGroup(this.cliffMesh, this.cliffTiles, false, false);
    for (let c = 0; c < this.wallClusters.length; c++) {
      const wc = this.wallClusters[c];
      updateGroup(wc.bodyMesh, wc.bodyTiles, false, true, true);
      updateGroup(wc.topMesh, wc.topTiles, false, false, true);
    }
    updateGroup(this.grassMesh, this.grassTiles, !opts?.pauseGrass, false);

    if (!shadowDirty && anyShadowWallDropping && Math.abs(gt - this.lastShadowBakeGt) >= 1.5) {
      shadowDirty = true;
    }
    if (shadowDirty) {
      this.lastShadowBakeGt = gt;
    }

    // Gentle cloud drift (optionally paused for compact GIF capture)
    if (!opts?.pauseClouds) {
      const wrapW = this.widthM + 36;
      const minX = this.widthM * 0.5 - wrapW * 0.5;
      for (let i = 0; i < this.cloudData.length; i++) {
        const c = this.cloudData[i];
        const x = minX + ((((c.x + elapsedSec * c.speed - minX) % wrapW) + wrapW) % wrapW);
        this._dummy.position.set(x, c.y + Math.sin(elapsedSec * 0.5 + i) * 0.18, c.z);
        this._dummy.rotation.set(0, i * 0.5, 0);
        this._dummy.scale.set(c.sx, c.sy, c.sz);
        this._dummy.updateMatrix();
        this.cloudMesh.setMatrixAt(i, this._dummy.matrix);
      }
      this.cloudMesh.instanceMatrix.needsUpdate = true;
    }

    // Ambient falling petals / snow / leaves (optionally hidden for compact GIF capture)
    if (this.ambientMesh) {
      if (opts?.hideAmbient) {
        this.ambientMesh.visible = false;
      } else {
        this.ambientMesh.visible = true;
        for (let i = 0; i < this.ambientData.length; i++) {
          const p = this.ambientData[i];
          const y = ((p.y + elapsedSec * p.vy) % 7.5 + 7.5) % 7.5 + 0.3;
          const x = ((p.x + elapsedSec * p.vx + Math.sin(elapsedSec * 1.8 + p.phase) * 0.5) % (this.widthM + 6) + (this.widthM + 6)) % (this.widthM + 6) - 3;
          const z = ((p.z + elapsedSec * p.vz) % (this.heightM + 6) + (this.heightM + 6)) % (this.heightM + 6) - 3;
          this._dummy.position.set(x, y, z);
          this._dummy.rotation.set(elapsedSec * 2 + p.phase, elapsedSec * 1.4, p.phase);
          this._dummy.scale.setScalar(p.s);
          this._dummy.updateMatrix();
          this.ambientMesh.setMatrixAt(i, this._dummy.matrix);
        }
        this.ambientMesh.instanceMatrix.needsUpdate = true;
      }
    }
    return shadowDirty;
  }

  public updateCloseupOcclusion(
    camPos: THREE.Vector3,
    focusPos: THREE.Vector3,
    blend: number,
    dt: number,
  ) {
    applyCloseupOcclusionStep(this.occluders, camPos, focusPos, blend, dt, this._dirScratch);
  }

  public dispose() {
    disposeOccluderEntries(this.occluders);
    const geos = new Set<THREE.BufferGeometry>(this.wallSharedGeos);
    const mats = new Set<THREE.Material>();
    this.root.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        geos.add(obj.geometry);
        if (Array.isArray(obj.material)) obj.material.forEach((m) => mats.add(m));
        else mats.add(obj.material);
      }
    });
    geos.forEach((g) => g.dispose());
    mats.forEach((m) => m.dispose());
  }
}
