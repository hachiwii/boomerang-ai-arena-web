import * as THREE from 'three';
import { CellType, EngineMapData } from '../game/types';
import {
  addArenaTree,
  addBarrel,
  addBridgePost,
  addCrate,
  addDetailExtra,
  addFacetedRock,
  addFarBush,
  addFarPine,
  addFarProp,
  addFarRoundTree,
  addFountain,
  addHoodoo,
  addHouse,
  addLandmarkFeature,
  addMesa,
  BucketKind,
  hexLin,
  HqMeshBuilder,
  ICO1,
  lerpLin,
  LinRGB,
  scaleLin,
  SeededRng,
  Vec3,
} from './hqGeomBuilder';
import { BridgeSpec, PaintedGroundResult, paintHighQualityGround } from './hqGroundPaint';
import { buildOriginalDecorIsland } from './hqOuterIsland';
import { getHqTheme, HqThemeSpec } from './hqThemes';
import { buildUpstreamTerrain } from './hqUpstreamTerrain';

export interface ArenaMover {
  x: number;
  z: number;
  speed: number;
}

export interface ArenaMapUpdateOpts {
  pauseClouds?: boolean;
  hideAmbient?: boolean;
  pauseGrass?: boolean;
  pauseWaterfall?: boolean;
  freezeCollapseAtTick?: number;
  movers?: readonly ArenaMover[];
  onCollapseDust?: (
    x: number,
    y: number,
    z: number,
    count: number,
    spread: number,
    sizeScale: number,
    alpha0: number,
    riseVy: number,
  ) => void;
}

export interface IArenaMap {
  readonly root: THREE.Group;
  readonly mapData: EngineMapData;
  readonly widthM: number;
  readonly heightM: number;
  /** Returns `true` when static shadow-casting obstacles changed and the cached shadow map should be refreshed. */
  update(gt: number, elapsedSec: number, opts?: ArenaMapUpdateOpts): boolean;
  updateCloseupOcclusion(
    camPos: THREE.Vector3,
    focusPos: THREE.Vector3,
    blend: number,
    dt: number,
  ): void;
  /** Show / hide decorative background floating islands (mobile matches hide them to declutter). */
  setBackdropVisible?(visible: boolean): void;
  dispose(): void;
}

/**
 * Shared-material lazy-clone occluder entry:
 * During normal gameplay every mesh shares the arena's tiny shared material pool (zero WebGL state churn!).
 * Only when a foreground mesh actually blocks the close-up camera does it lazily clone & swap to its
 * translucent `fadeMaterials`, then swap right back to `opaqueMaterials` once clear!
 */
export interface OccluderEntry {
  meshes: THREE.Mesh[];
  opaqueMaterials: THREE.Material[];
  fadeMaterials: THREE.Material[] | null;
  baseOpacities: number[];
  box: THREE.Box3;
  isGrass: boolean;
  /** When true (outer background floating islands), hide meshes outright instead of semi-transparent fade! */
  hideOnOcclude?: boolean;
  hiddenByOcclude?: boolean;
  minOpacity: number;
  curOpacity: number;
  usingFade: boolean;
  wave: number;
}

/** Ray-vs-expanded-AABB slab intersection test for segment P(t) = cam + t*dir, t in [tMin, tMax]. */
export function segmentIntersectsExpandedBox(
  cam: THREE.Vector3,
  dir: THREE.Vector3,
  tMin: number,
  tMax: number,
  box: THREE.Box3,
  pad: number,
): boolean {
  let lo = tMin;
  let hi = tMax;
  if (hi <= lo) return false;

  const minX = box.min.x - pad;
  const maxX = box.max.x + pad;
  const minY = box.min.y - pad * 0.5;
  const maxY = box.max.y + pad * 0.65;
  const minZ = box.min.z - pad;
  const maxZ = box.max.z + pad;

  const checkAxis = (orig: number, d: number, bMin: number, bMax: number): boolean => {
    if (Math.abs(d) < 1e-6) return orig >= bMin && orig <= bMax;
    let t1 = (bMin - orig) / d;
    let t2 = (bMax - orig) / d;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > lo) lo = t1;
    if (t2 < hi) hi = t2;
    return lo <= hi;
  };

  return (
    checkAxis(cam.x, dir.x, minX, maxX) &&
    checkAxis(cam.y, dir.y, minY, maxY) &&
    checkAxis(cam.z, dir.z, minZ, maxZ)
  );
}

/** Shared occlusion fade updater used by BOTH Low Quality and High Quality arenas! */
export function applyCloseupOcclusionStep(
  entries: OccluderEntry[],
  camPos: THREE.Vector3,
  focusPos: THREE.Vector3,
  blend: number,
  dt: number,
  _dirScratch: THREE.Vector3,
) {
  const active = blend > 0.12;
  let dist = 0;
  if (active) {
    _dirScratch.subVectors(focusPos, camPos);
    dist = _dirScratch.length();
    if (dist > 0.3) _dirScratch.divideScalar(dist);
  }
  const strength = active ? Math.min(1, Math.max(0, (blend - 0.12) / 0.42)) : 0;
  const smoothK = dt > 0 ? 1 - Math.exp(-Math.min(0.1, dt) * 14) : 1;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];

    // Background outer floating islands: completely hide while blocking close-up camera!
    if (e.hideOnOcclude) {
      let hit = false;
      if (active && dist > 0.5) {
        const tMax = dist - 0.45;
        if (tMax > -0.3) {
          hit = segmentIntersectsExpandedBox(camPos, _dirScratch, -0.35, tMax, e.box, 0.85);
        }
      }
      if (hit !== Boolean(e.hiddenByOcclude)) {
        e.hiddenByOcclude = hit;
        for (let k = 0; k < e.meshes.length; k++) {
          e.meshes[k].visible = !hit;
        }
      }
      continue;
    }

    if (!active && !e.usingFade && e.curOpacity >= 0.999) continue;

    let hit = false;
    if (strength > 0.01 && dist > 0.6) {
      const pad = e.isGrass ? 0.24 : 0.46;
      const stopBefore = e.isGrass ? 0.95 : 0.36;
      const tMax = dist - stopBefore;
      if (tMax > 0.15) {
        hit = segmentIntersectsExpandedBox(camPos, _dirScratch, 0.05, tMax, e.box, pad);
      }
    }

    const targetOp = hit ? 1.0 - (1.0 - e.minOpacity) * strength : 1.0;
    const prev = e.curOpacity;
    const next = Math.abs(targetOp - prev) < 0.008 ? targetOp : prev + (targetOp - prev) * smoothK;
    e.curOpacity = next;

    const wantFade = next < 0.985;
    if (wantFade) {
      if (!e.fadeMaterials) {
        e.fadeMaterials = e.opaqueMaterials.map((m) => {
          const cl = m.clone();
          cl.transparent = true;
          cl.depthWrite = false;
          return cl;
        });
      }
      if (!e.usingFade) {
        e.usingFade = true;
        for (let k = 0; k < e.meshes.length; k++) {
          e.meshes[k].material = e.fadeMaterials[k];
        }
      }
      for (let k = 0; k < e.fadeMaterials.length; k++) {
        e.fadeMaterials[k].opacity = e.baseOpacities[k] * next;
      }
    } else if (e.usingFade) {
      e.usingFade = false;
      for (let k = 0; k < e.meshes.length; k++) {
        e.meshes[k].material = e.opaqueMaterials[k];
      }
    }
  }
}

export function disposeOccluderEntries(entries: OccluderEntry[]) {
  for (const e of entries) {
    if (e.fadeMaterials) {
      for (const m of e.fadeMaterials) m.dispose();
      e.fadeMaterials = null;
    }
  }
}

interface CollapseChunk {
  id: number;
  wave: number;
  /** Terrain slab (top + cliff) — hidden while wave is intact, shown ONLY when wave enters warning/fall! */
  terrainGroup: THREE.Group;
  /** Always-mounted obstacle & tall-grass container riding with this chunk's pivot `(cx, 0, cz)`! */
  propMount: THREE.Group;
  topMesh: THREE.Mesh | null;
  cliffMesh: THREE.Mesh | null;
  cx: number;
  cz: number;
  distFromCenter: number;
  rnd: [number, number, number, number, number, number];
  usingWarnMat: boolean;
  modified: boolean;
  hasShadowCaster: boolean;
  /** 0 = intact/warning, 1 = actively dropping, 2 = fallen out of sight */
  shadowState: 0 | 1 | 2;
  warnDustFired: boolean;
  fallDustFired: boolean;
}

interface WaveBundle {
  wave: number;
  /** Single merged static top + cliff mesh for the ENTIRE intact wave (only 2 draw calls!) */
  intactTerrain: THREE.Group;
  /** Single merged static surface details for this wave (only 1-2 draw calls!) */
  intactDetails: THREE.Group;
  chunks: CollapseChunk[];
  mode: 'intact' | 'active' | 'fallen';
}

interface GrassClusterRef {
  group: THREE.Group;
  cx: number;
  cz: number;
  phase: number;
}

interface CloudInfo {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  rotY: number;
  speed: number;
}

interface AmbientBit {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  phase: number;
  s: number;
}

function hashSeed(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Greedy connected wall components (4-connected). */
function getWallComponents(mapData: EngineMapData): [number, number][][] {
  const { nx, ny, cells } = mapData;
  const seen = new Uint8Array(nx * ny);
  const out: [number, number][][] = [];
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const i = y * nx + x;
      if (cells[i] !== CellType.WALL || seen[i]) continue;
      const st: [number, number][] = [[x, y]];
      const comp: [number, number][] = [];
      seen[i] = 1;
      while (st.length > 0) {
        const [cx, cy] = st.pop()!;
        comp.push([cx, cy]);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const xx = cx + dx, yy = cy + dy;
          if (xx >= 0 && yy >= 0 && xx < nx && yy < ny) {
            const ni = yy * nx + xx;
            if (cells[ni] === CellType.WALL && !seen[ni]) {
              seen[ni] = 1;
              st.push([xx, yy]);
            }
          }
        }
      }
      out.push(comp);
    }
  }
  return out;
}

/** Split a set of wall cells greedily into maximal rectangles `(x0, y0, w, h)` within the same wave. */
function rectsOfCells(
  cells: [number, number][],
  mapData: EngineMapData,
  maxSpan = 99,
): [number, number, number, number][] {
  const left = new Set<string>(cells.map(([x, y]) => `${x},${y}`));
  const waveOf = (x: number, y: number) => mapData.waves[y * mapData.nx + x];
  const sorted = cells.slice().sort((a, b) => (a[1] !== b[1] ? a[1] - b[1] : a[0] - b[0]));
  const out: [number, number, number, number][] = [];
  for (const [x, y] of sorted) {
    if (!left.has(`${x},${y}`)) continue;
    const wv = waveOf(x, y);
    let w = 1;
    while (w < maxSpan && left.has(`${x + w},${y}`) && waveOf(x + w, y) === wv) w++;
    let h = 1;
    while (h < maxSpan) {
      let ok = true;
      for (let xx = x; xx < x + w; xx++) {
        if (!left.has(`${xx},${y + h}`) || waveOf(xx, y + h) !== wv) {
          ok = false;
          break;
        }
      }
      if (!ok) break;
      h++;
    }
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) left.delete(`${xx},${yy}`);
    }
    out.push([x, y, w, h]);
  }
  return out;
}

/** Build a fluffy multi-puff cloud BufferGeometry (4 merged soft spheres) for single-draw-call instancing. */
function buildFluffyCloudGeometry(): THREE.BufferGeometry {
  const puffs: [number, number, number, number, number, number][] = [
    [0, 0, 0, 1.0, 0.56, 0.85],
    [-0.72, -0.08, 0.14, 0.68, 0.44, 0.64],
    [0.74, -0.06, -0.1, 0.66, 0.42, 0.62],
    [0.14, 0.24, 0.08, 0.62, 0.46, 0.58],
  ];
  const pos: number[] = [];
  const nrm: number[] = [];
  const sph = ICO1;
  for (const [ox, oy, oz, rx, ry, rz] of puffs) {
    for (const [a, b, c] of sph.tris) {
      const va = sph.verts[a], vb = sph.verts[b], vc = sph.verts[c];
      pos.push(
        ox + va[0] * rx, oy + va[1] * ry, oz + va[2] * rz,
        ox + vb[0] * rx, oy + vb[1] * ry, oz + vb[2] * rz,
        ox + vc[0] * rx, oy + vc[1] * ry, oz + vc[2] * rz,
      );
      nrm.push(va[0], va[1], va[2], vb[0], vb[1], vb[2], vc[0], vc[1], vc[2]);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.computeBoundingSphere();
  return geo;
}

/**
 * High-Quality Arena Builder faithfully porting `chen-006/meow-ai-arena` into 240Hz-capable WebGL2:
 * - Wave-merged intact terrain + details (~15-25 draw calls instead of 1,200+!)
 * - Active-wave 4x4 rock chunks swap in ONLY during the brief collapse warning + fall window
 * - Tiny shared material pool (7 opaque materials + 2 active-warning materials) with lazy cloning
 *   ONLY for the 1-2 obstacles currently blocking a close-up camera!
 */
export class HqArenaMap3D implements IArenaMap {
  public readonly root = new THREE.Group();
  public readonly mapData: EngineMapData;
  public readonly hqTheme: HqThemeSpec;
  public readonly widthM: number;
  public readonly heightM: number;

  private readonly chunks: CollapseChunk[] = [];
  private readonly waveBundles = new Map<number, WaveBundle>();
  private readonly stateTerrains: THREE.Group[] = [];
  private upstreamRim: {
    sampleS2: (wx: number, wz: number) => number;
    sampleOutNormal: (wx: number, wz: number) => [number, number];
  } | null = null;
  private readonly edgeBeautify: boolean;
  private readonly cellChunkId: Int32Array;
  private readonly occluders: OccluderEntry[] = [];
  private readonly grassClusters: GrassClusterRef[] = [];
  private readonly groundResult: PaintedGroundResult;

  // Shared arena materials (zero per-mesh WebGL material rebind churn!)
  private readonly sharedTopMat: THREE.MeshLambertMaterial;
  private readonly sharedCliffMat: THREE.MeshLambertMaterial;
  private readonly warnTopMat: THREE.MeshLambertMaterial;
  private readonly warnCliffMat: THREE.MeshLambertMaterial;
  private readonly sharedBucketMats: Record<BucketKind, THREE.Material>;

  private cloudMesh!: THREE.InstancedMesh;
  private cloudData: CloudInfo[] = [];
  private readonly backdropGroups: THREE.Object3D[] = [];
  private ambientMesh: THREE.InstancedMesh | null = null;
  private ambientData: AmbientBit[] = [];
  private waterfallGroup: THREE.Group | null = null;
  private waterfallStreaks: THREE.Mesh[] = [];
  private waterfallMist: THREE.Mesh[] = [];

  private readonly _dummy = new THREE.Object3D();
  private readonly _dirScratch = new THREE.Vector3();
  private readonly _warnCol = new THREE.Color('#ff5d1f');
  private readonly _black = new THREE.Color(0x000000);
  private readonly waveMaxDist = new Map<number, number>();
  private lastShadowBakeGt = -9999;

  constructor(mapData: EngineMapData, themeName: string, edgeBeautify = false) {
    this.mapData = mapData;
    this.hqTheme = getHqTheme(themeName);
    this.edgeBeautify = edgeBeautify;
    const cs = mapData.cell / 1000;
    this.widthM = mapData.nx * cs;
    this.heightM = mapData.ny * cs;
    this.cellChunkId = new Int32Array(mapData.nx * mapData.ny).fill(-1);

    const seed = hashSeed(`${mapData.name}_${themeName}_hq`);
    const rng = new SeededRng(seed);

    // 1. Crisp 2K procedural painted ground texture + aux masks + bridges
    this.groundResult = paintHighQualityGround(mapData, this.hqTheme, seed + 13);

    // Create shared material palette (7 opaque + 2 warning materials total for the whole arena!)
    // When edgeBeautify is active, cliff meshes carry explicit per-vertex smooth/faceted normals.
    this.sharedTopMat = new THREE.MeshLambertMaterial({ map: this.groundResult.texture });
    this.sharedCliffMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: !edgeBeautify });
    this.warnTopMat = new THREE.MeshLambertMaterial({ map: this.groundResult.texture });
    this.warnCliffMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: !edgeBeautify });
    this.sharedBucketMats = {
      solid: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
      smooth: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: false }),
      foliage: new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }),
      glow: new THREE.MeshBasicMaterial({ vertexColors: true }),
      water: new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.78,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    };

    // 2. Build wave-merged intact terrain + compact 4x4 (or upstream rounded/fractured) collapse chunks
    if (this.edgeBeautify) {
      this.buildUpstreamTerrainWavesAndChunks(rng, seed);
    } else {
      this.buildTerrainWavesAndChunks(rng);
    }

    // 3. Build detailed themed obstacles (each individually occludable with lazy material clone!)
    this.buildObstacles(rng);

    // 4. Build lush multi-segment curved tall grass + tip flowers (compact 4x4 clusters)
    this.buildTallGrass(rng);

    // 5. Build field features (fountain, bridge posts & ropes) & wave-merged ground details
    this.buildFieldAndDetails(rng);

    // 6. Build merged distant outer islands + nearby occludable flanking islands + landmarks + waterfall
    this.buildOuterDecor(rng);

    // 7. Build fluffy multi-puff cloud sea & ambient floating petals/snow/leaves
    this.buildClouds(rng);
    this.buildAmbientParticles(rng);
  }

  private getChunkForCell(gx: number, gy: number): CollapseChunk {
    const { nx, ny } = this.mapData;
    const cx = Math.max(0, Math.min(nx - 1, gx));
    const cy = Math.max(0, Math.min(ny - 1, gy));
    const cid = this.cellChunkId[cy * nx + cx];
    if (cid >= 0 && cid < this.chunks.length) return this.chunks[cid];
    return this.chunks[0];
  }

  private getChunkForWorld(mx: number, my: number): CollapseChunk {
    const cs = this.mapData.cell / 1000;
    return this.getChunkForCell(Math.floor(mx / cs), Math.floor(my / cs));
  }

  private registerOccluder(meshes: THREE.Mesh[], wave: number, isGrass = false, hideOnOcclude = false): OccluderEntry | null {
    const box = new THREE.Box3();
    const opaqueMaterials: THREE.Material[] = [];
    const baseOpacities: number[] = [];
    for (const m of meshes) {
      m.updateMatrixWorld(true);
      m.geometry.computeBoundingBox();
      if (m.geometry.boundingBox) {
        const mb = m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld);
        box.union(mb);
      }
      const mat = m.material as THREE.Material;
      opaqueMaterials.push(mat);
      baseOpacities.push(mat.opacity);
    }
    if (box.isEmpty()) return null;
    const entry: OccluderEntry = {
      meshes,
      opaqueMaterials,
      fadeMaterials: null,
      baseOpacities,
      box,
      isGrass,
      hideOnOcclude,
      hiddenByOcclude: false,
      minOpacity: isGrass ? 0.34 : 0.24,
      curOpacity: 1.0,
      usingFade: false,
      wave,
    };
    this.occluders.push(entry);
    return entry;
  }

  private buildUpstreamTerrainWavesAndChunks(rng: SeededRng, seed: number) {
    const { nx, ny, cells, waves, nwave } = this.mapData;
    const { mg } = this.groundResult;

    const up = buildUpstreamTerrain(
      this.mapData,
      this.hqTheme.pal,
      mg,
      seed + 3,
      this.sharedTopMat,
      this.sharedCliffMat,
    );
    this.upstreamRim = {
      sampleS2: up.sampleState0S2,
      sampleOutNormal: up.sampleState0OutNormal,
    };

    for (const grp of up.stateTerrains) {
      this.root.add(grp);
      this.stateTerrains.push(grp);
    }

    // Create empty intactTerrain wrappers + intactDetails groups per wave (-1..nwave-1)
    const ensureBundle = (w: number) => {
      if (this.waveBundles.has(w)) return;
      const intactTerrain = new THREE.Group();
      const intactDetails = new THREE.Group();
      this.root.add(intactDetails);
      this.waveBundles.set(w, {
        wave: w,
        intactTerrain,
        intactDetails,
        chunks: [],
        mode: 'intact',
      });
    };
    ensureBundle(-1);
    for (let w = 0; w < nwave; w++) ensureBundle(w);

    // Chunk 0: permanent core mount (for permanent obstacles/tall grass)
    const permMount = new THREE.Group();
    const permTerrain = new THREE.Group();
    permTerrain.visible = false;
    this.root.add(permMount);
    this.root.add(permTerrain);
    const permChunk: CollapseChunk = {
      id: 0,
      wave: -1,
      terrainGroup: permTerrain,
      propMount: permMount,
      topMesh: null,
      cliffMesh: null,
      cx: 0,
      cz: 0,
      distFromCenter: 0,
      rnd: [rng.next(), rng.next(), rng.next(), rng.next(), rng.next(), rng.next()],
      usingWarnMat: false,
      modified: false,
      hasShadowCaster: false,
      shadowState: 0,
      warnDustFired: false,
      fallDustFired: false,
    };
    this.chunks.push(permChunk);
    this.waveBundles.get(-1)?.chunks.push(permChunk);

    // Irregular Voronoi fracture pieces become CollapseChunks 1..M
    for (let i = 0; i < up.pieces.length; i++) {
      const p = up.pieces[i];
      const chunkId = this.chunks.length;
      const propMount = new THREE.Group();
      propMount.position.set(p.cx, 0, p.cz);
      this.root.add(propMount);

      const terrainGroup = new THREE.Group();
      terrainGroup.position.set(p.cx, 0, p.cz);
      terrainGroup.visible = false;
      if (p.topMesh) terrainGroup.add(p.topMesh);
      if (p.cliffMesh) terrainGroup.add(p.cliffMesh);
      this.root.add(terrainGroup);

      this.waveMaxDist.set(p.wave, Math.max(this.waveMaxDist.get(p.wave) ?? 0.1, p.dIn));

      const chunk: CollapseChunk = {
        id: chunkId,
        wave: p.wave,
        terrainGroup,
        propMount,
        topMesh: p.topMesh,
        cliffMesh: p.cliffMesh,
        cx: p.cx,
        cz: p.cz,
        distFromCenter: p.dIn,
        rnd: [rng.next(), rng.next(), rng.next(), rng.next(), rng.next(), rng.next()],
        usingWarnMat: false,
        modified: false,
        hasShadowCaster: false,
        shadowState: 0,
        warnDustFired: false,
        fallDustFired: false,
      };
      this.chunks.push(chunk);
      ensureBundle(p.wave);
      this.waveBundles.get(p.wave)?.chunks.push(chunk);
    }

    // Bind every solid grid cell to its permanent core (0) or irregular Voronoi fracture chunk (1 + pieceIdx)
    for (let gy = 0; gy < ny; gy++) {
      for (let gx = 0; gx < nx; gx++) {
        const idx = gy * nx + gx;
        if (cells[idx] === CellType.PIT) continue;
        const w = waves[idx];
        if (w < 0) {
          this.cellChunkId[idx] = 0;
        } else {
          const pIdx = up.cellPieceIndex[idx];
          this.cellChunkId[idx] = pIdx >= 0 ? 1 + pIdx : 0;
        }
      }
    }
  }

  private buildTerrainWavesAndChunks(rng: SeededRng) {
    const { nx, ny, cells, waves, cell } = this.mapData;
    const cs = cell / 1000;
    const P = this.hqTheme.pal;
    const { mg } = this.groundResult;
    const Wm = this.widthM;
    const Hm = this.heightM;

    const isSolid = (gx: number, gy: number) =>
      gx >= 0 && gy >= 0 && gx < nx && gy < ny && cells[gy * nx + gx] !== CellType.PIT;
    const waveAt = (gx: number, gy: number) =>
      gx >= 0 && gy >= 0 && gx < nx && gy < ny ? waves[gy * nx + gx] : -99;

    // Group solid cells into compact 4x4 collapse chunks per wave (wave -1 = single core chunk 0)
    const chunkCellsMap = new Map<string, { wave: number; cells: [number, number][] }>();
    chunkCellsMap.set('perm', { wave: -1, cells: [] });
    const waveCellsMap = new Map<number, [number, number][]>();
    waveCellsMap.set(-1, []);

    for (let gy = 0; gy < ny; gy++) {
      for (let gx = 0; gx < nx; gx++) {
        const idx = gy * nx + gx;
        if (cells[idx] === CellType.PIT) continue;
        const w = waves[idx];
        let wArr = waveCellsMap.get(w);
        if (!wArr) {
          wArr = [];
          waveCellsMap.set(w, wArr);
        }
        wArr.push([gx, gy]);

        // 4x4 cell collapse blocks (2m x 2m natural rock chunks!) -> ~8-16 chunks per wave instead of 70!
        const key = w < 0 ? 'perm' : `w${w}_${Math.floor(gx / 4)}_${Math.floor(gy / 4)}`;
        let entry = chunkCellsMap.get(key);
        if (!entry) {
          entry = { wave: w, cells: [] };
          chunkCellsMap.set(key, entry);
        }
        entry.cells.push([gx, gy]);
      }
    }

    const chunkList = Array.from(chunkCellsMap.values());
    chunkList.forEach((info, cid) => {
      for (const [gx, gy] of info.cells) this.cellChunkId[gy * nx + gx] = cid;
    });

    const cLip = hexLin(P.lip);
    const cSoil = hexLin(P.soil);
    const cRockA = hexLin(P.rock_a);
    const cRockB = hexLin(P.rock_b);
    const cRockC = hexLin(P.rock_c);
    const cRockDeep = hexLin(P.rock_deep);
    const cRockUnder = hexLin(P.rock_under);

    const uvU = (wx: number) => (wx + mg) / (Wm + 2 * mg);
    const uvV = (wz: number) => 1.0 - (wz + mg) / (Hm + 2 * mg);

    const vertNoise = (wx: number, wz: number): number => {
      const qx = Math.round(wx * 20) * 0.05;
      const qz = Math.round(wz * 20) * 0.05;
      const h = Math.sin(qx * 3.71 + qz * 5.23) * 43758.5453;
      return h - Math.floor(h);
    };

    // Global outer-pit outward normal table so all adjacent cliffs share identical 3D vertices (100% watertight!)
    const globalOuterOut = new Map<string, [number, number]>();
    const vKey = (wx: number, wz: number) => `${Math.round(wx * 40)}_${Math.round(wz * 40)}`;
    const accumGlobalOut = (wx: number, wz: number, ox: number, oz: number) => {
      const k = vKey(wx, wz);
      let cur = globalOuterOut.get(k);
      if (!cur) {
        cur = [0, 0];
        globalOuterOut.set(k, cur);
      }
      cur[0] += ox;
      cur[1] += oz;
    };

    const rBevel = cs * 0.32;
    for (let gy = 0; gy < ny; gy++) {
      for (let gx = 0; gx < nx; gx++) {
        if (!isSolid(gx, gy)) continue;
        const x0 = gx * cs, x1 = (gx + 1) * cs, z0 = gy * cs, z1 = (gy + 1) * cs;
        const pitN = !isSolid(gx, gy - 1);
        const pitS = !isSolid(gx, gy + 1);
        const pitW = !isSolid(gx - 1, gy);
        const pitE = !isSolid(gx + 1, gy);
        const bevelNW = pitN && pitW;
        const bevelNE = pitN && pitE;
        const bevelSE = pitS && pitE;
        const bevelSW = pitS && pitW;

        if (pitN) { accumGlobalOut(bevelNW ? x0 + rBevel : x0, z0, 0, -1); accumGlobalOut(bevelNE ? x1 - rBevel : x1, z0, 0, -1); }
        if (bevelNE) { accumGlobalOut(x1 - rBevel, z0, 0.7071, -0.7071); accumGlobalOut(x1, z0 + rBevel, 0.7071, -0.7071); }
        if (pitE) { accumGlobalOut(x1, bevelNE ? z0 + rBevel : z0, 1, 0); accumGlobalOut(x1, bevelSE ? z1 - rBevel : z1, 1, 0); }
        if (bevelSE) { accumGlobalOut(x1, z1 - rBevel, 0.7071, 0.7071); accumGlobalOut(x1 - rBevel, z1, 0.7071, 0.7071); }
        if (pitS) { accumGlobalOut(bevelSE ? x1 - rBevel : x1, z1, 0, 1); accumGlobalOut(bevelSW ? x0 + rBevel : x0, z1, 0, 1); }
        if (bevelSW) { accumGlobalOut(x0 + rBevel, z1, -0.7071, 0.7071); accumGlobalOut(x0, z1 - rBevel, -0.7071, 0.7071); }
        if (pitW) { accumGlobalOut(x0, bevelSW ? z1 - rBevel : z1, -1, 0); accumGlobalOut(x0, bevelNW ? z0 + rBevel : z0, -1, 0); }
        if (bevelNW) { accumGlobalOut(x0, z0 + rBevel, -0.7071, -0.7071); accumGlobalOut(x0 + rBevel, z0, -0.7071, -0.7071); }
      }
    }

    const globalCornerPos = (wx: number, wz: number, inset: number, y: number): Vec3 => {
      if (inset === 0) return [wx, y, wz];
      const v = globalOuterOut.get(vKey(wx, wz));
      if (!v) return [wx, y, wz];
      const len = Math.hypot(v[0], v[1]) || 1;
      return [wx - (v[0] / len) * inset, y, wz - (v[1] / len) * inset];
    };

    // Helper: construct top + cliff BufferGeometries for a cell subset centered at `(cx, cz)`
    const buildTerrainGeos = (
      cellList: [number, number][],
      wave: number,
      cx: number,
      cz: number,
      splitByChunkId: number | null, // null = wave-merged intact mesh (only edges bordering pit or OTHER wave!)
    ): { topMesh: THREE.Mesh | null; cliffMesh: THREE.Mesh | null } => {
      const topPos: number[] = [];
      const topNrm: number[] = [];
      const topUv: number[] = [];
      const cliffPos: number[] = [];
      const cliffNrm: number[] = [];
      const cliffCol: number[] = [];

      const pushTopTri = (ax: number, az: number, bx: number, bz: number, dx: number, dz: number) => {
        topPos.push(ax - cx, 0, az - cz, bx - cx, 0, bz - cz, dx - cx, 0, dz - cz);
        topNrm.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
        topUv.push(uvU(ax), uvV(az), uvU(bx), uvV(bz), uvU(dx), uvV(dz));
      };

      const pushCliffQuad = (p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, col: LinRGB) => {
        const ax = p0[0] - cx, ay = p0[1], az = p0[2] - cz;
        const bx = p1[0] - cx, by = p1[1], bz = p1[2] - cz;
        const ex = p2[0] - cx, ey = p2[1], ez = p2[2] - cz;
        const fx = p3[0] - cx, fy = p3[1], fz = p3[2] - cz;
        const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
        const e2x = ex - ax, e2y = ey - ay, e2z = ez - az;
        let nx_ = e1y * e2z - e1z * e2y;
        let ny_ = e1z * e2x - e1x * e2z;
        let nz_ = e1x * e2y - e1y * e2x;
        const nl = Math.hypot(nx_, ny_, nz_) || 1;
        nx_ /= nl;
        ny_ /= nl;
        nz_ /= nl;
        cliffPos.push(ax, ay, az, bx, by, bz, ex, ey, ez, ax, ay, az, ex, ey, ez, fx, fy, fz);
        for (let k = 0; k < 6; k++) {
          cliffNrm.push(nx_, ny_, nz_);
          cliffCol.push(col[0], col[1], col[2]);
        }
      };

      const addDiff = (nx_: number, ny_: number) => {
        if (!isSolid(nx_, ny_)) return { exposed: true, outerPit: true };
        const nw = waveAt(nx_, ny_);
        if (nw !== wave) return { exposed: true, outerPit: false };
        if (splitByChunkId !== null && wave >= 0) {
          if (this.cellChunkId[ny_ * nx + nx_] !== splitByChunkId) return { exposed: true, outerPit: false };
        }
        return { exposed: false, outerPit: false };
      };

      interface ExposedSeg { ax: number; az: number; bx: number; bz: number; outerPit: boolean; seed: number }
      const exposedSegs: ExposedSeg[] = [];

      for (const [gx, gy] of cellList) {
        const x0 = gx * cs, x1 = (gx + 1) * cs, z0 = gy * cs, z1 = (gy + 1) * cs;
        const mx = (x0 + x1) * 0.5, mz = (z0 + z1) * 0.5;
        const pitN = !isSolid(gx, gy - 1);
        const pitS = !isSolid(gx, gy + 1);
        const pitW = !isSolid(gx - 1, gy);
        const pitE = !isSolid(gx + 1, gy);
        const bevelNW = pitN && pitW;
        const bevelNE = pitN && pitE;
        const bevelSE = pitS && pitE;
        const bevelSW = pitS && pitW;

        const dN = addDiff(gx, gy - 1);
        const dE = addDiff(gx + 1, gy);
        const dS = addDiff(gx, gy + 1);
        const dW = addDiff(gx - 1, gy);

        const segs: { ax: number; az: number; bx: number; bz: number; outerPit: boolean; exposed: boolean; seed: number }[] = [
          { ax: bevelNW ? x0 + rBevel : x0, az: z0, bx: bevelNE ? x1 - rBevel : x1, bz: z0, outerPit: dN.outerPit, exposed: dN.exposed, seed: gx * 13 + gy * 31 + 1 },
        ];
        if (bevelNE) segs.push({ ax: x1 - rBevel, az: z0, bx: x1, bz: z0 + rBevel, outerPit: true, exposed: true, seed: gx * 17 + gy * 29 + 2 });
        segs.push({ ax: x1, az: bevelNE ? z0 + rBevel : z0, bx: x1, bz: bevelSE ? z1 - rBevel : z1, outerPit: dE.outerPit, exposed: dE.exposed, seed: gx * 19 + gy * 37 + 3 });
        if (bevelSE) segs.push({ ax: x1, az: z1 - rBevel, bx: x1 - rBevel, bz: z1, outerPit: true, exposed: true, seed: gx * 23 + gy * 41 + 4 });
        segs.push({ ax: bevelSE ? x1 - rBevel : x1, az: z1, bx: bevelSW ? x0 + rBevel : x0, bz: z1, outerPit: dS.outerPit, exposed: dS.exposed, seed: gx * 29 + gy * 43 + 5 });
        if (bevelSW) segs.push({ ax: x0 + rBevel, az: z1, bx: x0, bz: z1 - rBevel, outerPit: true, exposed: true, seed: gx * 31 + gy * 47 + 6 });
        segs.push({ ax: x0, az: bevelSW ? z1 - rBevel : z1, bx: x0, bz: bevelNW ? z0 + rBevel : z0, outerPit: dW.outerPit, exposed: dW.exposed, seed: gx * 37 + gy * 53 + 7 });
        if (bevelNW) segs.push({ ax: x0, az: z0 + rBevel, bx: x0 + rBevel, bz: z0, outerPit: true, exposed: true, seed: gx * 41 + gy * 59 + 8 });

        for (const s of segs) {
          pushTopTri(mx, mz, s.bx, s.bz, s.ax, s.az);
          if (s.exposed) exposedSegs.push({ ax: s.ax, az: s.az, bx: s.bx, bz: s.bz, outerPit: s.outerPit, seed: s.seed });
        }
      }

      for (const es of exposedSegs) {
        const { ax, az, bx, bz, outerPit, seed: facetSeed } = es;
        const fNoise = Math.sin(facetSeed * 12.9898) * 43758.5453;
        const fv = fNoise - Math.floor(fNoise);
        const shade = 0.94 + fv * 0.12;
        const va = vertNoise(ax, az);
        const vb = vertNoise(bx, bz);
        const depthA = outerPit ? 1.75 + va * 0.38 : 1.18;
        const depthB = outerPit ? 1.75 + vb * 0.38 : 1.18;
        const yStart = outerPit ? 0.0 : -0.012;

        const bands: [number, number, number, number, LinRGB][] = outerPit
          ? [
              [yStart, yStart, 0.0, 0.0, scaleLin(cLip, shade)],
              [-0.12, -0.12, 0.0, 0.0, scaleLin(cSoil, shade)],
              [-0.28, -0.28, 0.015, 0.015, scaleLin(cRockA, shade)],
              [-0.76, -0.76, 0.06 + va * 0.02, 0.06 + vb * 0.02, scaleLin(cRockB, shade)],
              [-1.28, -1.28, 0.14 + va * 0.035, 0.14 + vb * 0.035, scaleLin(cRockC, shade * 0.97)],
              [-depthA, -depthB, 0.28 + va * 0.05, 0.28 + vb * 0.05, scaleLin(cRockDeep, shade * 0.94)],
              [-depthA - 0.32, -depthB - 0.32, 0.52, 0.52, scaleLin(cRockUnder, shade * 0.94)],
            ]
          : [
              [yStart, yStart, 0.0, 0.0, scaleLin(cLip, shade)],
              [-0.12, -0.12, 0.0, 0.0, scaleLin(cSoil, shade)],
              [-0.3, -0.3, 0.0, 0.0, scaleLin(cRockA, shade)],
              [-0.78, -0.78, 0.0, 0.0, scaleLin(cRockB, shade)],
              [-depthA, -depthB, 0.0, 0.0, scaleLin(cRockC, shade * 0.96)],
            ];

        for (let k = 0; k < bands.length - 1; k++) {
          const [ya0, yb0, inA0, inB0, col] = bands[k];
          const [ya1, yb1, inA1, inB1] = bands[k + 1];
          const p0 = outerPit ? globalCornerPos(ax, az, inA0, ya0) : ([ax, ya0, az] as Vec3);
          const p1 = outerPit ? globalCornerPos(bx, bz, inB0, yb0) : ([bx, yb0, bz] as Vec3);
          const p2 = outerPit ? globalCornerPos(bx, bz, inB1, yb1) : ([bx, yb1, bz] as Vec3);
          const p3 = outerPit ? globalCornerPos(ax, az, inA1, ya1) : ([ax, ya1, az] as Vec3);
          pushCliffQuad(p0, p1, p2, p3, col);
        }
      }

      let topMesh: THREE.Mesh | null = null;
      let cliffMesh: THREE.Mesh | null = null;
      if (topPos.length > 0) {
        const topGeo = new THREE.BufferGeometry();
        topGeo.setAttribute('position', new THREE.Float32BufferAttribute(topPos, 3));
        topGeo.setAttribute('normal', new THREE.Float32BufferAttribute(topNrm, 3));
        topGeo.setAttribute('uv', new THREE.Float32BufferAttribute(topUv, 2));
        topGeo.computeBoundingSphere();
        topMesh = new THREE.Mesh(topGeo, this.sharedTopMat);
        topMesh.receiveShadow = true;
      }
      if (cliffPos.length > 0) {
        const cliffGeo = new THREE.BufferGeometry();
        cliffGeo.setAttribute('position', new THREE.Float32BufferAttribute(cliffPos, 3));
        cliffGeo.setAttribute('normal', new THREE.Float32BufferAttribute(cliffNrm, 3));
        cliffGeo.setAttribute('color', new THREE.Float32BufferAttribute(cliffCol, 3));
        cliffGeo.computeBoundingSphere();
        cliffMesh = new THREE.Mesh(cliffGeo, this.sharedCliffMat);
        cliffMesh.castShadow = false;
        cliffMesh.receiveShadow = false;
      }
      return { topMesh, cliffMesh };
    };

    // 1. Build 1 merged intact mesh per wave (ONLY ~14 draw calls for the ENTIRE island!)
    for (const [wave, cellList] of waveCellsMap) {
      const intactTerrain = new THREE.Group();
      const intactDetails = new THREE.Group();
      const { topMesh, cliffMesh } = buildTerrainGeos(cellList, wave, 0, 0, null);
      if (topMesh) intactTerrain.add(topMesh);
      if (cliffMesh) intactTerrain.add(cliffMesh);
      this.root.add(intactTerrain);
      this.root.add(intactDetails);
      this.waveBundles.set(wave, {
        wave,
        intactTerrain,
        intactDetails,
        chunks: [],
        mode: 'intact',
      });
    }

    // 2. Build 4x4 rock collapse chunks for each collapsing wave (hidden until wave enters warning/fall!)
    chunkList.forEach((info, chunkIdx) => {
      let sx = 0, sz = 0;
      for (const [gx, gy] of info.cells) {
        sx += (gx + 0.5) * cs;
        sz += (gy + 0.5) * cs;
      }
      const nCells = Math.max(1, info.cells.length);
      const cx = info.wave < 0 ? 0 : sx / nCells;
      const cz = info.wave < 0 ? 0 : sz / nCells;

      const propMount = new THREE.Group();
      propMount.position.set(cx, 0, cz);
      this.root.add(propMount);

      const terrainGroup = new THREE.Group();
      terrainGroup.position.set(cx, 0, cz);
      terrainGroup.visible = false; // Hidden while intact!
      this.root.add(terrainGroup);

      let topMesh: THREE.Mesh | null = null;
      let cliffMesh: THREE.Mesh | null = null;
      if (info.wave >= 0) {
        const res = buildTerrainGeos(info.cells, info.wave, cx, cz, chunkIdx);
        topMesh = res.topMesh;
        cliffMesh = res.cliffMesh;
        if (topMesh) terrainGroup.add(topMesh);
        if (cliffMesh) terrainGroup.add(cliffMesh);
      }

      const distFromCenter = Math.hypot(cx - Wm * 0.5, cz - Hm * 0.5);
      if (info.wave >= 0) {
        this.waveMaxDist.set(info.wave, Math.max(this.waveMaxDist.get(info.wave) ?? 0.1, distFromCenter));
      }

      const chunk: CollapseChunk = {
        id: chunkIdx,
        wave: info.wave,
        terrainGroup,
        propMount,
        topMesh,
        cliffMesh,
        cx,
        cz,
        distFromCenter,
        rnd: [rng.next(), rng.next(), rng.next(), rng.next(), rng.next(), rng.next()],
        usingWarnMat: false,
        modified: false,
        hasShadowCaster: false,
        shadowState: 0,
        warnDustFired: false,
        fallDustFired: false,
      };
      this.chunks.push(chunk);
      this.waveBundles.get(info.wave)?.chunks.push(chunk);
    });
  }

  private buildObstacles(rng: SeededRng) {
    const cs = this.mapData.cell / 1000;
    const P = this.hqTheme.pal;
    const R = this.hqTheme.rock;
    const used = new Set<string>();

    const commitObstacle = (mb: HqMeshBuilder, worldX: number, worldZ: number) => {
      if (!mb.hasAny()) return;
      const chunk = this.getChunkForWorld(worldX, worldZ);
      const { meshes } = mb.buildMeshes({
        castShadow: true,
        receiveShadow: true,
        sharedMats: this.sharedBucketMats,
      });
      const localGrp = new THREE.Group();
      localGrp.position.set(-chunk.cx, 0, -chunk.cz);
      for (const m of meshes) localGrp.add(m);
      chunk.propMount.add(localGrp);
      chunk.hasShadowCaster = true;
      this.registerOccluder(meshes, chunk.wave, false);
    };

    // Optional per-map tree cells (training ground): drawn as arena trees whatever the theme's rock kind is
    const treeSet = new Set(this.mapData.treeCells ?? []);
    if (treeSet.size > 0) {
      const nx = this.mapData.nx;
      const isTree = (x: number, y: number) =>
        x >= 0 && y >= 0 && x < nx && y < this.mapData.ny && treeSet.has(y * nx + x) && this.mapData.cells[y * nx + x] === CellType.WALL;
      const treeCrowns: [string, string, string][] = [
        P.crown_pal ?? ['#2F8050', '#4FA65C', '#9AD476'],
        ['#2F8050', '#5CB058', '#BCE070'],
        ['#22705A', '#3C9670', '#86CCA0'],
      ];
      const k1 = Math.max(1, Math.round(1.0 / cs));
      for (let y = 0; y < this.mapData.ny; y++) {
        for (let x = 0; x < nx; x++) {
          if (!isTree(x, y) || used.has(`${x},${y}`)) continue;
          // one tree per k1×k1 block (1 m trunk), single leftover cells get a small tree
          let size = 1;
          let ok = true;
          for (let i = 0; i < k1 && ok; i++) for (let j = 0; j < k1 && ok; j++) if (!isTree(x + i, y + j) || used.has(`${x + i},${y + j}`)) ok = false;
          if (ok) size = k1;
          const tx = (x + size * 0.5) * cs;
          const tz = (y + size * 0.5) * cs;
          const mb = new HqMeshBuilder();
          addArenaTree(mb, tx, -tz, size * cs * 0.5, rng, {
            crown: rng.choice(treeCrowns),
            h: rng.uniform(1.2, 1.4),
            cr: rng.uniform(1.6, 1.85),
            mush: rng.next() < 0.6,
          });
          commitObstacle(mb, tx, tz);
          for (let i = 0; i < size; i++) for (let j = 0; j < size; j++) used.add(`${x + i},${y + j}`);
        }
      }
    }
    const components = treeSet.size > 0
      ? getWallComponents(this.mapData)
          .map((comp) => comp.filter(([x, y]) => !treeSet.has(y * this.mapData.nx + x)))
          .filter((comp) => comp.length > 0)
      : getWallComponents(this.mapData);

    if (R.kind === 'garden') {
      const k1 = Math.max(1, Math.round(1.0 / cs));
      const midX = (this.widthM * 0.5) / cs;
      const midY = (this.heightM * 0.5) / cs;
      for (const comp of components) {
        const cset = new Set(comp.map(([x, y]) => `${x},${y}`));
        const cands: [number, number][] = [];
        for (const [x, y] of comp) {
          let ok = true;
          for (let i = 0; i < k1 && ok; i++) {
            for (let j = 0; j < k1 && ok; j++) {
              if (!cset.has(`${x + i},${y + j}`)) ok = false;
            }
          }
          if (ok) cands.push([x, y]);
        }
        if (cands.length === 0) continue;
        cands.sort((a, b) => (b[0] - midX) ** 2 + (b[1] - midY) ** 2 - ((a[0] - midX) ** 2 + (a[1] - midY) ** 2));
        const [x0, y0] = cands[0];
        const tx = (x0 + k1 * 0.5) * cs;
        const ty = -(y0 + k1 * 0.5) * cs;
        const a = (k1 * cs) * 0.5;
        const mb = new HqMeshBuilder();
        mb.stack(tx, ty, [[a * 1.08, -0.05], [a * 1.04, 0.24], [a * 0.86, 0.36]], [hexLin(P.stone_side), hexLin(P.stone_lit)], {
          n: 7,
          jitter: 0.08,
          rng,
          cap: hexLin(P.moss),
        });
        addArenaTree(mb, tx, ty, a * 0.6, rng, {
          trunk: ['#6E4A48', '#553838'],
          crown: ['#E06C98', '#F7A6C0', '#FFE2EC'],
          h: 1.2,
          cr: 2.3,
          z: 0.32,
          knot: false,
          blobs: 6,
        });
        commitObstacle(mb, tx, -ty);
        for (let i = 0; i < k1; i++) for (let j = 0; j < k1; j++) used.add(`${x0 + i},${y0 + j}`);
      }
    } else if (R.kind === 'houses') {
      let hIdx = 1;
      for (const comp of components) {
        // Group houses within same chunk into one occluder batch to keep draw calls ultra-low!
        const chunkBuilders = new Map<number, { mb: HqMeshBuilder; wx: number; wz: number }>();
        for (const [x0, y0, w, h] of rectsOfCells(comp, this.mapData, 4)) {
          const wx = (x0 + w * 0.5) * cs;
          const wz = (y0 + h * 0.5) * cs;
          const cid = this.getChunkForWorld(wx, wz).id;
          let entry = chunkBuilders.get(cid);
          if (!entry) {
            entry = { mb: new HqMeshBuilder(), wx, wz };
            chunkBuilders.set(cid, entry);
          }
          addHouse(entry.mb, x0 * cs, -(y0 + h) * cs, w * cs, h * cs, rng, hIdx++);
        }
        for (const [, entry] of chunkBuilders) commitObstacle(entry.mb, entry.wx, entry.wz);
        for (const [x, y] of comp) used.add(`${x},${y}`);
      }
    } else if (R.kind === 'trees') {
      const k1 = Math.max(1, Math.round(1.0 / cs));
      const crownChoices: [string, string, string][] = [
        P.crown_pal ?? ['#2F8050', '#4FA65C', '#9AD476'],
        ['#2F8050', '#5CB058', '#BCE070'],
        ['#22705A', '#3C9670', '#86CCA0'],
      ];
      for (const comp of components) {
        for (const [x0, y0, w, h] of rectsOfCells(comp, this.mapData, 4)) {
          const nx = Math.max(1, Math.floor(w / k1));
          const ny = Math.max(1, Math.floor(h / k1));
          const sw = (w * cs) / nx;
          const sh = (h * cs) / ny;
          for (let jy = 0; jy < ny; jy++) {
            for (let jx = 0; jx < nx; jx++) {
              const tx = x0 * cs + (jx + 0.5) * sw;
              const tz = y0 * cs + (jy + 0.5) * sh;
              const mb = new HqMeshBuilder();
              addArenaTree(mb, tx, -tz, Math.min(sw, sh) * 0.5, rng, {
                crown: rng.choice(crownChoices),
                h: rng.uniform(1.2, 1.4),
                cr: rng.uniform(1.6, 1.85),
                mush: rng.next() < 0.6,
              });
              commitObstacle(mb, tx, tz);
            }
          }
        }
        for (const [x, y] of comp) used.add(`${x},${y}`);
      }
    } else if (R.kind === 'masonry') {
      const isW = (x: number, y: number) =>
        x >= 0 && y >= 0 && x < this.mapData.nx && y < this.mapData.ny && this.mapData.cells[y * this.mapData.nx + x] === CellType.WALL;
      const stones = [hexLin(P.stone_lit), hexLin(P.stone_top), hexLin(P.stone_side), hexLin(P.stone_lit, 1.06)];
      const dark = hexLin(P.stone_base);
      const moss = hexLin(P.moss);
      const ch = 0.29;

      for (const comp of components) {
        for (const [rx, ry, rw, rh] of rectsOfCells(comp, this.mapData, 4)) {
          const mb = new HqMeshBuilder();
          for (let y = ry; y < ry + rh; y++) {
            for (let x = rx; x < rx + rw; x++) {
              const nb =
                (isW(x + 1, y) ? 1 : 0) + (isW(x - 1, y) ? 1 : 0) + (isW(x, y + 1) ? 1 : 0) + (isW(x, y - 1) ? 1 : 0);
              const f = 0.5 + 0.5 * Math.sin(x * 0.83 + 1.3) * Math.cos(y * 0.97 + 0.4);
              const nc = Math.min(5, Math.max(2, 3 + Math.round(1.7 * f) + (nb >= 3 ? 1 : 0) - (nb <= 1 ? 1 : 0)));
              const X0 = x * cs;
              const Y0 = -(y + 1) * cs;
              const horiz = isW(x - 1, y) || isW(x + 1, y);
              mb.box(X0 + 0.03, X0 + cs - 0.03, Y0 + 0.03, Y0 + cs - 0.03, -0.03, nc * ch - 0.03, dark);
              for (let k = 0; k < nc; k++) {
                const z0 = k * ch + 0.008;
                const z1 = (k + 1) * ch - 0.008;
                const last = k === nc - 1;
                const j = 0.006;
                const blk = (xa: number, xb: number, ya: number, yb: number) => {
                  const col = scaleLin(rng.choice(stones), rng.uniform(0.93, 1.05) * (k === 0 ? 0.92 : 1.0));
                  const topc = last && rng.next() < R.mossy ? moss : scaleLin(col, 1.1);
                  mb.box(xa + j, xb - j, ya + j, yb - j, z0, z1, col, {
                    top: topc,
                    rz: last ? rng.uniform(-0.07, 0.07) : 0,
                  });
                };
                if ((k + x + y) % 2 === 0) blk(X0, X0 + cs, Y0, Y0 + cs);
                else if (horiz) {
                  blk(X0, X0 + cs * 0.5, Y0, Y0 + cs);
                  blk(X0 + cs * 0.5, X0 + cs, Y0, Y0 + cs);
                } else {
                  blk(X0, X0 + cs, Y0, Y0 + cs * 0.5);
                  blk(X0, X0 + cs, Y0 + cs * 0.5, Y0 + cs);
                }
              }
            }
          }
          commitObstacle(mb, (rx + rw * 0.5) * cs, (ry + rh * 0.5) * cs);
        }
        for (const [x, y] of comp) used.add(`${x},${y}`);
      }
    }

    const remCells: [number, number][] = [];
    for (let y = 0; y < this.mapData.ny; y++) {
      for (let x = 0; x < this.mapData.nx; x++) {
        if (this.mapData.cells[y * this.mapData.nx + x] === CellType.WALL && !used.has(`${x},${y}`)) {
          remCells.push([x, y]);
        }
      }
    }

    const maxc = Math.max(1, Math.round(2.0 / cs));
    for (const [x0, y0, w, h] of rectsOfCells(remCells, this.mapData, maxc)) {
      const X0 = x0 * cs;
      const Y0 = -(y0 + h) * cs;
      const Wd = w * cs;
      const Hd = h * cs;
      const cx = X0 + Wd * 0.5;
      const cy = Y0 + Hd * 0.5;
      const Lg = Math.max(Wd, Hd);
      const Sh = Math.min(Wd, Hd);
      const hk = R.h;
      const mb = new HqMeshBuilder();

      if (R.kind === 'hoodoo') {
        const bands = R.bands ?? ['#FFE2A8', '#F2B470', '#E0905A', '#FBD08C'];
        if (Sh >= 1.9) {
          addMesa(mb, cx, cy, Wd * 0.5 - 0.04, Hd * 0.5 - 0.04, 1.3 * hk, rng, bands);
          const sx = rng.choice([-1, 1]);
          const sy = rng.choice([-1, 1]);
          addHoodoo(mb, cx + sx * Wd * 0.14, cy + sy * Hd * 0.12, Wd * 0.2, Hd * 0.2, 0.75 * hk, rng, bands, { z: 1.25 * hk });
        } else if (Lg / Math.max(0.01, Sh) >= 1.6) {
          const big = rng.next() < 0.5;
          const defs: [number, number, number][] = [[0.28, 0.27, 1.75], [0.76, 0.22, 1.15]];
          defs.forEach(([t0, sc, hh], k) => {
            const t = big ? t0 : 1 - t0;
            if (Wd > Hd) addHoodoo(mb, X0 + Wd * t, cy, Wd * sc, Hd * 0.46, hh * hk * (0.7 + 0.3 * Math.min(1, Sh)), rng, bands, { cap: k === 0 });
            else addHoodoo(mb, cx, Y0 + Hd * t, Wd * 0.46, Hd * sc, hh * hk * (0.7 + 0.3 * Math.min(1, Sh)), rng, bands, { cap: k === 0 });
          });
        } else {
          addHoodoo(mb, cx, cy, Wd * 0.5 - 0.03, Hd * 0.5 - 0.03, (1.05 + 0.75 * Math.min(1, Sh)) * hk * rng.uniform(0.92, 1.08), rng, bands);
        }
      } else if (R.kind === 'crates') {
        const cnx = Math.max(1, Math.round(Wd / 1.0));
        const cny = Math.max(1, Math.round(Hd / 1.0));
        const sx = Wd / cnx;
        const sy = Hd / cny;
        for (let j = 0; j < cny; j++) {
          for (let i = 0; i < cnx; i++) {
            const px = X0 + (i + 0.5) * sx;
            const py = Y0 + (j + 0.5) * sy;
            const s = Math.min(sx, sy) - 0.1;
            if (s >= 0.8 && rng.next() < 0.3) {
              const br = s * 0.24;
              for (const [ox, oy] of [[-0.24, -0.2], [0.24, -0.16], [0.0, 0.24]]) addBarrel(mb, px + ox * s, py + oy * s, br, s * 0.62, 0);
              addBarrel(mb, px, py - 0.04 * s, br * 0.92, s * 0.55, s * 0.62);
            } else {
              addCrate(mb, px, py, s, 0, rng, rng.uniform(-0.06, 0.06));
              const s2 = s * rng.uniform(0.5, 0.6);
              addCrate(mb, px + rng.uniform(-0.1, 0.1) * s, py + rng.uniform(-0.1, 0.1) * s, s2, s + 0.012, rng, rng.uniform(0.2, 0.7));
            }
          }
        }
      } else if (R.kind === 'menhir') {
        const mr = { ...R, n: [4, 6] as [number, number], p: 4.5, top: [0.5, 0.68] as [number, number] };
        if (Sh >= 0.9) {
          addFacetedRock(mb, cx, cy, Wd * 0.4, Hd * 0.38, rng.uniform(1.9, 2.25) * hk, rng, P, mr, { rot: rng.uniform(-0.3, 0.3) });
          for (let k = 0; k < 2; k++) {
            const sx = rng.choice([-1, 1]), sy = rng.choice([-1, 1]);
            addFacetedRock(mb, cx + sx * Wd * 0.33, cy + sy * Hd * 0.33, 0.15, 0.13, rng.uniform(0.35, 0.6), rng, P, mr);
          }
        } else if (Lg >= 1.4) {
          const Hh = rng.uniform(1.45, 1.6) * hk;
          for (const sg of [-1, 1]) {
            if (Wd > Hd) addFacetedRock(mb, cx + sg * (Wd * 0.5 - 0.3), cy, 0.27, Hd * 0.42, Hh, rng, P, mr, { rot: rng.uniform(-0.1, 0.1) });
            else addFacetedRock(mb, cx, cy + sg * (Hd * 0.5 - 0.3), Wd * 0.42, 0.27, Hh, rng, P, mr, { rot: rng.uniform(-0.1, 0.1) });
          }
          if (Lg >= 1.9) {
            addFacetedRock(mb, cx, cy, Wd > Hd ? Wd * 0.2 : Wd * 0.38, Wd > Hd ? Hd * 0.38 : Hd * 0.2, Hh * 0.8, rng, P, mr);
          }
          const lintelStyle = { ...mr, top: [0.92, 0.98] as [number, number], n: [4, 5] as [number, number], p: 6.0 };
          addFacetedRock(mb, cx, cy, Wd > Hd ? Wd * 0.5 - 0.02 : Wd * 0.46, Wd > Hd ? Hd * 0.46 : Hd * 0.5 - 0.02, 0.32, rng, P, lintelStyle, {
            rot: 0,
            z0: Hh - 0.04,
          });
        } else if (Lg >= 0.9) {
          [-1, 1].forEach((sg, k) => {
            const hh = (k === 0 ? 1.7 : 1.15) * hk * rng.uniform(0.92, 1.08);
            if (Wd > Hd) addFacetedRock(mb, cx + sg * Wd * 0.25, cy, Wd * 0.23, Hd * 0.42, hh, rng, P, mr, { rot: rng.uniform(-0.15, 0.15) });
            else addFacetedRock(mb, cx, cy + sg * Hd * 0.25, Wd * 0.42, Hd * 0.23, hh, rng, P, mr, { rot: rng.uniform(-0.15, 0.15) });
          });
        } else {
          addFacetedRock(mb, cx, cy, Wd * 0.44, Hd * 0.4, rng.uniform(1.0, 1.4) * hk, rng, P, mr, { rot: rng.uniform(-0.2, 0.2) });
        }
      } else {
        const hkEff = (0.55 + 0.45 * Math.min(1, Sh)) * hk;
        const parts: [number, number, number, number, number, boolean][] = [];
        const ratio = Lg / Math.max(1e-5, Sh);
        if (ratio >= 1.6) {
          if (Wd > Hd) {
            parts.push([X0 + Wd * 0.28, cy, Wd * 0.27, Hd * 0.47, rng.uniform(1.05, 1.3) * hkEff, true]);
            parts.push([X0 + Wd * 0.76, cy + rng.uniform(-0.03, 0.03), Wd * 0.23, Hd * 0.44, rng.uniform(0.6, 0.8) * hkEff, false]);
          } else {
            parts.push([cx, Y0 + Hd * 0.28, Wd * 0.47, Hd * 0.27, rng.uniform(1.05, 1.3) * hkEff, true]);
            parts.push([cx + rng.uniform(-0.03, 0.03), Y0 + Hd * 0.76, Wd * 0.44, Hd * 0.23, rng.uniform(0.6, 0.8) * hkEff, false]);
          }
          if (rng.next() < 0.5) {
            for (const p of parts) { p[0] = 2 * cx - p[0]; p[1] = 2 * cy - p[1]; }
          }
        } else if (Wd * Hd <= 1.3) {
          parts.push([cx, cy, Wd * 0.47, Hd * 0.47, rng.uniform(0.95, 1.2) * hkEff, true]);
        } else {
          const sx = rng.choice([-1, 1]), sy = rng.choice([-1, 1]);
          const A = Wd * 0.5 - 0.03, B = Hd * 0.5 - 0.03;
          const bw = A * 0.62, bh = B * 0.62;
          parts.push([cx + sx * (A - bw), cy + sy * (B - bh), bw, bh, rng.uniform(1.15, 1.4) * hkEff, true]);
          const mw = A * 0.46, mh = B * 0.46;
          parts.push([cx - sx * (A - mw), cy - sy * (B - mh), mw, mh, rng.uniform(0.75, 0.95) * hkEff, false]);
          parts.push([cx - sx * (A - mw * 0.82), cy + sy * (B - mh * 0.82), mw * 0.82, mh * 0.82, rng.uniform(0.5, 0.68) * hkEff, false]);
          parts.push([cx + sx * (A - mw * 0.8), cy - sy * (B - mh * 0.8), mw * 0.8, mh * 0.8, rng.uniform(0.55, 0.75) * hkEff, false]);
        }
        for (const [px, py, a, b, hh, main] of parts) {
          addFacetedRock(mb, px, py, a, b, hh, rng, P, R, { mossy: main && rng.next() < R.mossy, rot: rng.uniform(-0.25, 0.25) });
        }
        if (Sh >= 0.7) {
          const smCount = rng.int(1, 3);
          for (let k = 0; k < smCount; k++) {
            const sx = rng.choice([-1, 1]), sy = rng.choice([-1, 1]);
            const r = rng.uniform(0.1, 0.16);
            addFacetedRock(mb, cx + sx * (Wd * 0.5 - r), cy + sy * (Hd * 0.5 - r), r, r * rng.uniform(0.8, 1.0), rng.uniform(0.16, 0.3), rng, P, R);
          }
        }
      }

      commitObstacle(mb, cx, -cy);
    }
  }

  private buildTallGrass(rng: SeededRng) {
    const { nx, ny, cells, cell } = this.mapData;
    const cs = cell / 1000;
    const P = this.hqTheme.pal;

    const grassSet = new Set<string>();
    const grassCells: [number, number][] = [];
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        if (cells[y * nx + x] === CellType.GRASS) {
          grassSet.add(`${x},${y}`);
          grassCells.push([x, y]);
        }
      }
    }
    if (grassCells.length === 0) return;

    const baseCol = hexLin(P.tall_base);
    const midCol = hexLin(P.tall_mid);
    const tipCol = hexLin(P.tall_tip);
    const flowerCols = P.tall_flower.map((h) => hexLin(h));

    const openDist = (x: number, y: number, fx: number, fy: number): number => {
      let d = 1.0;
      if (!grassSet.has(`${x - 1},${y}`)) d = Math.min(d, fx);
      if (!grassSet.has(`${x + 1},${y}`)) d = Math.min(d, 1 - fx);
      if (!grassSet.has(`${x},${y - 1}`)) d = Math.min(d, fy);
      if (!grassSet.has(`${x},${y + 1}`)) d = Math.min(d, 1 - fy);
      const cxOpen = (!grassSet.has(`${x - 1},${y}`) && fx < 0.3) || (!grassSet.has(`${x + 1},${y}`) && fx > 0.7);
      const cyOpen = (!grassSet.has(`${x},${y - 1}`) && fy < 0.3) || (!grassSet.has(`${x},${y + 1}`) && fy > 0.7);
      if (cxOpen && cyOpen) {
        const ex = fx < 0.5 ? fx : 1 - fx;
        const ey = fy < 0.5 ? fy : 1 - fy;
        d = Math.min(d, 0.3 - Math.hypot(0.3 - ex, 0.3 - ey));
      }
      return d * cs;
    };

    // Group grass cells into responsive 2x2 cell tufts (1m x 1m) for crisp mover-parting interaction!
    const clusters = new Map<string, [number, number][]>();
    for (const [x, y] of grassCells) {
      const cid = this.getChunkForCell(x, y).id;
      const key = `${cid}_${Math.floor(x / 2)}_${Math.floor(y / 2)}`;
      let arr = clusters.get(key);
      if (!arr) {
        arr = [];
        clusters.set(key, arr);
      }
      arr.push([x, y]);
    }

    const bladesPerCell = Math.max(8, Math.round(86 * cs * cs));

    for (const [, list] of clusters) {
      let avgX = 0, avgZ = 0;
      for (const [x, y] of list) {
        avgX += (x + 0.5) * cs;
        avgZ += (y + 0.5) * cs;
      }
      avgX /= list.length;
      avgZ /= list.length;

      const chunk = this.getChunkForCell(list[0][0], list[0][1]);
      const mb = new HqMeshBuilder();

      for (const [x, y] of list) {
        for (let i = 0; i < bladesPerCell; i++) {
          const fx = rng.uniform(-0.03, 1.03);
          const fy = rng.uniform(-0.03, 1.03);
          const ed = openDist(x, y, fx, fy);
          if (ed < -0.02 || (ed < 0.1 && rng.next() < 0.35)) continue;

          const kEdge = Math.min(1, Math.max(0, ed) / 0.28);
          const hgt = rng.uniform(0.38, 0.66) * (0.6 + 0.4 * kEdge);
          const wid = rng.uniform(0.052, 0.09);
          const ang = rng.uniform(0, Math.PI * 2);
          const ox = fx - 0.5;
          const oy = fy - 0.5;
          const lean = hgt * (rng.uniform(0.08, 0.2) + (1 - kEdge) * 0.35);
          const la = Math.atan2(-oy, ox) + rng.normal(0, 0.6);

          const bx = (x + fx) * cs - avgX;
          const by = -((y + fy) * cs - avgZ);
          const ca = Math.cos(ang), sa = Math.sin(ang);
          const lx = Math.cos(la) * lean, ly = Math.sin(la) * lean;

          const v0: Vec3 = [bx - ca * wid, by - sa * wid, -0.02];
          const v1: Vec3 = [bx + ca * wid, by + sa * wid, -0.02];
          const v2: Vec3 = [bx + lx * 0.3 - ca * wid * 0.75, by + ly * 0.3 - sa * wid * 0.75, hgt * 0.45];
          const v3: Vec3 = [bx + lx * 0.3 + ca * wid * 0.75, by + ly * 0.3 + sa * wid * 0.75, hgt * 0.45];
          const v4: Vec3 = [bx + lx * 0.75 - ca * wid * 0.35, by + ly * 0.75 - sa * wid * 0.35, hgt * 0.82];
          const v5: Vec3 = [bx + lx * 0.75 + ca * wid * 0.35, by + ly * 0.75 + sa * wid * 0.35, hgt * 0.82];
          const v6: Vec3 = [bx + lx, by + ly, hgt];

          const sh = 1 + rng.uniform(-0.07, 0.07);
          const m2 = scaleLin(midCol, sh);
          const t2 = scaleLin(tipCol, sh);
          const mt = lerpLin(m2, t2, 0.5);

          mb.quad(v0, v1, v3, v2, baseCol, 'foliage', baseCol, m2, m2);
          mb.quad(v2, v3, v5, v4, m2, 'foliage', m2, mt, mt);
          mb.tri(v4, v5, v6, mt, mt, t2, 'foliage');

          if (flowerCols.length > 0 && kEdge > 0.28 && rng.next() < 0.095) {
            const fc = rng.choice(flowerCols);
            const r = rng.uniform(0.042, 0.06);
            mb.blob(bx + lx, by + ly, hgt + 0.012, r, r, r * 0.75, fc, scaleLin(fc, 1.12), {
              sub: 0,
              smooth: false,
            });
          }
        }
      }

      if (!mb.hasAny()) continue;
      const { meshes } = mb.buildMeshes({
        castShadow: false,
        receiveShadow: true,
        sharedMats: this.sharedBucketMats,
      });
      const gGrp = new THREE.Group();
      gGrp.position.set(avgX - chunk.cx, 0, avgZ - chunk.cz);
      for (const m of meshes) gGrp.add(m);
      chunk.propMount.add(gGrp);

      this.grassClusters.push({ group: gGrp, cx: avgX, cz: avgZ, phase: rng.uniform(0, Math.PI * 2) });
      this.registerOccluder(meshes, chunk.wave, true);
    }
  }

  private buildFieldAndDetails(rng: SeededRng) {
    const { nx, ny, cells, waves, cell } = this.mapData;
    const cs = cell / 1000;
    const P = this.hqTheme.pal;
    const det = this.hqTheme.detail;
    const { dirt, quiet, ppm, mg, widthPx, heightPx, bridges } = this.groundResult;

    // Group ALL ground surface details by WAVE (only ~6-7 merged meshes instead of 380!)
    const waveBuilders = new Map<number, HqMeshBuilder>();
    const getWaveB = (wave: number) => {
      let b = waveBuilders.get(wave);
      if (!b) {
        b = new HqMeshBuilder();
        waveBuilders.set(wave, b);
      }
      return b;
    };
    const waveOfWorld = (mx: number, my: number): number => {
      const gx = Math.max(0, Math.min(nx - 1, Math.floor(mx / cs)));
      const gy = Math.max(0, Math.min(ny - 1, Math.floor(my / cs)));
      return waves[gy * nx + gx];
    };

    const sampleAux = (arr: Float32Array, mx: number, my: number): number => {
      const ix = Math.round((mx + mg) * ppm);
      const iy = Math.round((my + mg) * ppm);
      if (ix < 0 || iy < 0 || ix >= widthPx || iy >= heightPx) return 0;
      return arr[iy * widthPx + ix];
    };

    const cellAt = (mx: number, my: number): number => {
      const gx = Math.floor(mx / cs);
      const gy = Math.floor(my / cs);
      if (gx < 0 || gy < 0 || gx >= nx || gy >= ny) return CellType.PIT;
      return cells[gy * nx + gx];
    };

    const okFloor = (mx: number, my: number, margin = 0.2): boolean => {
      if (cellAt(mx, my) !== CellType.FLOOR) return false;
      for (const [dx, dy] of [[-margin, 0], [margin, 0], [0, -margin], [0, margin]]) {
        const ct = cellAt(mx + dx, my + dy);
        if (ct === CellType.WALL || ct === CellType.PIT) return false;
      }
      return true;
    };

    // Fountain (`oldtown`)
    if (this.hqTheme.field.includes('fountain')) {
      const seen = new Uint8Array(nx * ny);
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const i = y * nx + x;
          if (cells[i] !== CellType.PIT || seen[i]) continue;
          const st: [number, number][] = [[x, y]];
          const comp: [number, number][] = [];
          let border = false;
          seen[i] = 1;
          while (st.length > 0) {
            const [cx, cy] = st.pop()!;
            comp.push([cx, cy]);
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const xx = cx + dx, yy = cy + dy;
              if (xx < 0 || yy < 0 || xx >= nx || yy >= ny) border = true;
              else {
                const ni = yy * nx + xx;
                if (cells[ni] === CellType.PIT && !seen[ni]) { seen[ni] = 1; st.push([xx, yy]); }
              }
            }
          }
          if (border || comp.length < 6 || comp.length > 80) continue;
          let minX = nx, maxX = 0, minY = ny, maxY = 0;
          for (const [cx, cy] of comp) {
            if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
            if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
          }
          addFountain(getWaveB(-1), ((minX + maxX + 1) * cs) * 0.5, -((minY + maxY + 1) * cs) * 0.5, ((maxX - minX + 1) * cs) * 0.5, ((maxY - minY + 1) * cs) * 0.5);
        }
      }
    }

    // Bridge posts & draped ropes (`sunset`, `canyon`)
    if (this.hqTheme.field.includes('bridges')) {
      const ropeCol = hexLin('#E8D2A0');
      for (const br of bridges as BridgeSpec[]) {
        const px = -br.ay, py = br.ax;
        const hl2 = Math.max(0.2, br.hl - 0.12);
        const w = waveOfWorld(br.bx, br.by);
        const mb = getWaveB(w);
        for (const sa of [-1, 1]) {
          for (const sp of [-1, 1]) {
            const mx = br.bx + br.ax * hl2 * sa + px * (br.hw - 0.03) * sp;
            const my = br.by + br.ay * hl2 * sa + py * (br.hw - 0.03) * sp;
            addBridgePost(mb, mx, -my);
          }
        }
        for (const sp of [-1, 1]) {
          const pts: Vec3[] = [];
          for (let i = 0; i < 9; i++) {
            const t = i / 8;
            const u = (t * 2 - 1) * hl2;
            const sag = 0.46 - 0.62 * Math.pow(Math.max(0, 1 - (2 * t - 1) ** 2), 0.8);
            const off = br.hw + 0.03 + 0.05 * (1 - (2 * t - 1) ** 2);
            pts.push([br.bx + br.ax * u + px * off * sp, -(br.by + br.ay * u + py * off * sp), sag]);
          }
          mb.tube(pts, 0.022, ropeCol, { seg: 5 });
        }
      }
    }

    const gDark = hexLin(P.tuft_dark);
    const gLight = hexLin(P.tuft_light);
    const flMain = P.flower_main.map((h) => hexLin(h));
    const flAcc = P.flower_acc.map((h) => hexLin(h));
    const flCore = hexLin(P.flower_core);
    const leafCols = P.leaf_fall.map((h) => hexLin(h));
    const p0Col = hexLin(P.plant0);
    const p1Col = hexLin(P.plant1);
    const pebbleBase = hexLin(P.stone_lit);

    const addTuft = (mx: number, my: number, s = 1.0, lean?: [number, number], nOpt?: number) => {
      const mb = getWaveB(waveOfWorld(mx, my));
      const cnt = nOpt ?? rng.int(4, 7);
      for (let k = 0; k < cnt; k++) {
        const a = rng.uniform(0, Math.PI * 2);
        const h = rng.uniform(0.08, 0.16) * s;
        const w = 0.02 * s;
        const ox = rng.normal(0, 0.03 * s);
        const oy = rng.normal(0, 0.03 * s);
        let lx = Math.cos(a) * h * 0.45;
        let ly = Math.sin(a) * h * 0.45;
        if (lean) { lx += lean[0] * h * 0.7; ly += lean[1] * h * 0.7; }
        const bx = mx + ox, by = -(my + oy);
        const tipC = lerpLin(gDark, gLight, rng.uniform(0.2, 1.0));
        mb.tri([bx - w * Math.sin(a), by + w * Math.cos(a), -0.01], [bx + w * Math.sin(a), by - w * Math.cos(a), -0.01], [bx + lx, by - ly, h], gDark, gDark, tipC, 'foliage');
      }
    };

    let floorCells = 0;
    for (let i = 0; i < cells.length; i++) if (cells[i] === CellType.FLOOR) floorCells++;
    const area = floorCells * cs * cs;
    const wallRects = rectsOfCells(getWallComponents(this.mapData).flat(), this.mapData, Math.max(1, Math.round(2.0 / cs)));

    for (const ex of det.extras) {
      if (ex === 'pots' || ex === 'rubble') {
        for (const [x0, y0, w, h] of wallRects) {
          const reps = 1 + Math.floor(w * cs);
          for (let k = 0; k < reps; k++) {
            let mx: number, my: number;
            if (ex === 'pots') {
              if (rng.next() < 0.45) continue;
              mx = (x0 + rng.uniform(0.1, 0.9) * w) * cs;
              my = (y0 + h) * cs + 0.13;
            } else {
              if (rng.next() < 0.5) continue;
              const side = rng.int(0, 4);
              const t = rng.uniform(0.05, 0.95);
              if (side === 0) { mx = (x0 + t * w) * cs; my = y0 * cs - 0.2; }
              else if (side === 1) { mx = (x0 + t * w) * cs; my = (y0 + h) * cs + 0.2; }
              else if (side === 2) { mx = x0 * cs - 0.2; my = (y0 + t * h) * cs; }
              else { mx = (x0 + w) * cs + 0.2; my = (y0 + t * h) * cs; }
            }
            if (okFloor(mx, my, 0.1)) addDetailExtra(getWaveB(waveOfWorld(mx, my)), ex, mx, -my, rng);
          }
        }
      } else {
        const densMap: Record<string, number> = { cactus: 0.06, dryshrub: 0.14, mushroom: 0.16, fern: 0.16, heather: 0.14 };
        const nTries = Math.round(area * (densMap[ex] ?? 0.1) * 3);
        for (let t = 0; t < nTries; t++) {
          const mx = rng.uniform(0, this.widthM);
          const my = rng.uniform(0, this.heightM);
          if (!okFloor(mx, my, 0.22) || sampleAux(dirt, mx, my) > 0.15) continue;
          if (rng.next() > 0.15 + 0.85 * sampleAux(quiet, mx, my)) continue;
          if (rng.next() < 0.65) continue;
          addDetailExtra(getWaveB(waveOfWorld(mx, my)), ex, mx, -my, rng);
        }
      }
    }

    const nTuft = Math.round(area * det.tuft * 0.72);
    for (let t = 0; t < nTuft; t++) {
      const mx = rng.uniform(0, this.widthM), my = rng.uniform(0, this.heightM);
      if (okFloor(mx, my, 0.12) && rng.next() > sampleAux(dirt, mx, my) * 0.9) addTuft(mx, my, rng.uniform(0.8, 1.3));
    }

    const nFl = Math.round(area * det.flower);
    for (let t = 0; t < nFl; t++) {
      const mx = rng.uniform(0, this.widthM), my = rng.uniform(0, this.heightM);
      if (!okFloor(mx, my, 0.25) || sampleAux(dirt, mx, my) > 0.2) continue;
      if (rng.next() > 0.25 + 0.75 * sampleAux(quiet, mx, my)) continue;
      const col = rng.next() < 0.8 ? rng.choice(flMain) : rng.choice(flAcc);
      const spread = rng.uniform(0.14, 0.3);
      const cnt = rng.int(5, 12);
      for (let j = 0; j < cnt; j++) {
        const fx = mx + rng.normal(0, spread), fy = my + rng.normal(0, spread);
        if (!okFloor(fx, fy, 0.1)) continue;
        const r = rng.uniform(0.032, 0.048), z = rng.uniform(0.05, 0.12);
        const mb = getWaveB(waveOfWorld(fx, fy));
        mb.blob(fx, -fy, z, r, r, r * 0.6, col, col, { sub: 0, smooth: false });
        mb.blob(fx, -fy, z + r * 0.35, r * 0.4, r * 0.4, r * 0.5, flCore, flCore, { sub: 0, smooth: false });
        addTuft(fx, fy, 0.55, undefined, 2);
      }
    }

    const nPeb = Math.round(area * det.pebble);
    for (let t = 0; t < nPeb; t++) {
      const mx = rng.uniform(0, this.widthM), my = rng.uniform(0, this.heightM);
      const d = sampleAux(dirt, mx, my);
      if (!okFloor(mx, my, 0.15) || d <= 0.15 || d >= 0.9 || rng.next() < 0.5) continue;
      const mb = getWaveB(waveOfWorld(mx, my));
      const cnt = rng.int(1, 4);
      for (let j = 0; j < cnt; j++) {
        const ox = rng.normal(0, 0.08), oy = rng.normal(0, 0.08);
        const r = rng.uniform(0.03, 0.065);
        const c = scaleLin(pebbleBase, rng.uniform(0.85, 1.08));
        mb.blob(mx + ox, -(my + oy), 0.006, r * 1.25, r, r * 0.55, c, c, { sub: 0, smooth: false, rotZ: rng.uniform(0, 6.28) });
      }
    }

    const nLeaf = Math.round(area * det.leaf);
    for (let t = 0; t < nLeaf; t++) {
      const mx = rng.uniform(0, this.widthM), my = rng.uniform(0, this.heightM);
      if (!okFloor(mx, my, 0.1)) continue;
      const mb = getWaveB(waveOfWorld(mx, my));
      const a = rng.uniform(0, 6.28);
      const L = rng.uniform(0.07, 0.11), w = rng.uniform(0.03, 0.045);
      const ca = Math.cos(a), sa = Math.sin(a);
      mb.quad([mx - ca * L, -my - sa * L, 0.014], [mx - sa * w, -my + ca * w, 0.022], [mx + ca * L, -my + sa * L, 0.014], [mx + sa * w, -my - ca * w, 0.022], rng.choice(leafCols), 'foliage');
    }

    for (const [x0, y0, w, h] of wallRects) {
      const reps = 2 + Math.floor((w + h) * cs * 0.9);
      for (let k = 0; k < reps; k++) {
        const side = rng.int(0, 4);
        const t = rng.uniform(0.08, 0.92);
        let mx: number, my: number;
        if (side === 0) { mx = (x0 + t * w) * cs; my = y0 * cs - 0.04; }
        else if (side === 1) { mx = (x0 + t * w) * cs; my = (y0 + h) * cs + 0.04; }
        else if (side === 2) { mx = x0 * cs - 0.04; my = (y0 + t * h) * cs; }
        else { mx = (x0 + w) * cs + 0.04; my = (y0 + t * h) * cs; }
        if (cellAt(mx, my) !== CellType.FLOOR) continue;
        const mb = getWaveB(waveOfWorld(mx, my));
        const size = rng.uniform(0.16, 0.25);
        const blades = rng.int(5, 8);
        for (let j = 0; j < blades; j++) {
          const a = rng.uniform(0, Math.PI * 2);
          const L = size * rng.uniform(0.7, 1.1);
          const wd = L * 0.22;
          const ca = Math.cos(a), sa = Math.sin(a);
          const cm = lerpLin(p0Col, p1Col, rng.uniform(0.3, 1.0));
          mb.quad([mx, -my, 0.01], [mx + ca * L * 0.5 - sa * wd, -my + sa * L * 0.5 + ca * wd, L * 0.55], [mx + ca * L, -my + sa * L, L * 0.32], [mx + ca * L * 0.5 + sa * wd, -my + sa * L * 0.5 - ca * wd, L * 0.55], p0Col, 'foliage', cm, p1Col, cm);
        }
      }
    }

    const edgeProb = Math.min(1, det.tuft / 1.3);
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const ct = cells[y * nx + x];
        if (ct === CellType.WALL || ct === CellType.PIT) continue;
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as [number, number][]) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < nx && yy < ny && cells[yy * nx + xx] !== CellType.PIT) continue;
          if (rng.next() > edgeProb) continue;
          const cnt = Math.max(1, Math.round(rng.uniform(0.9, 2.0) * cs));
          for (let k = 0; k < cnt; k++) {
            const t = rng.uniform(0.14, 0.86);
            let mx = dx !== 0 ? (x + 0.5 + dx * 0.5) * cs - dx * 0.05 : (x + t) * cs;
            let my = dy !== 0 ? (y + 0.5 + dy * 0.5) * cs - dy * 0.05 : (y + t) * cs;
            let leanDir: [number, number] = [dx, dy];
            if (this.upstreamRim) {
              const s2 = this.upstreamRim.sampleS2(mx, my);
              const [ox, oz] = this.upstreamRim.sampleOutNormal(mx, my);
              leanDir = [ox, oz];
              if (s2 < 0.03) {
                // Keep overhanging grass tufts anchored cleanly onto the rounded upstream rim (never floating off rounded corners)
                const pushIn = 0.055 - s2;
                mx -= ox * pushIn;
                my -= oz * pushIn;
                if (this.upstreamRim.sampleS2(mx, my) < 0.0) continue;
              }
            }
            addTuft(mx, my, rng.uniform(1.0, 1.45), leanDir, 4);
          }
        }
      }
    }

    // Commit 1 merged detail mesh group per wave (sharing arena materials!)
    for (const [wave, mb] of waveBuilders) {
      if (!mb.hasAny()) continue;
      const bundle = this.waveBundles.get(wave);
      if (!bundle) continue;
      const { meshes } = mb.buildMeshes({
        castShadow: false,
        receiveShadow: true,
        sharedMats: this.sharedBucketMats,
      });
      for (const m of meshes) bundle.intactDetails.add(m);
    }
  }

  private buildOuterDecor(rng: SeededRng) {
    const Wm = this.widthM;
    const Hm = this.heightM;
    const D = this.hqTheme.decor;
    const P = this.hqTheme.pal;

    // Exact outer floating island layout from `env.py` `auto_decor(Wm, Hm)`!
    interface DecorSlot {
      nm: string;
      x: number;
      y: number;
      z: number;
      rot: number;
      kind: 'mixed' | 'trees' | 'bushes' | 'none';
      pri: number;
      occludable: boolean;
    }
    const slots: DecorSlot[] = [
      { nm: 'm06', x: -4.9, y: -Hm * 0.5 + 0.3, z: 1.5 + D.dz, rot: 0, kind: 'mixed', pri: 3, occludable: true },
      { nm: 'm07', x: Wm + 4.8, y: -Hm * 0.5 - 0.3, z: 1.2 + D.dz, rot: 180, kind: 'trees', pri: 2, occludable: true },
      { nm: 'm00', x: 1.0 + Wm * 0.05, y: 4.8, z: -1.8, rot: 90, kind: 'trees', pri: 1, occludable: false },
      { nm: 'm01', x: Wm - 1.0 - Wm * 0.05, y: 5.0, z: -2.2, rot: 95, kind: 'mixed', pri: 0, occludable: false },
      { nm: 'm03', x: -2.2, y: -(Hm + 2.8), z: -0.3, rot: 20, kind: 'bushes', pri: 6, occludable: true },
      { nm: 'm04', x: Wm + 2.4, y: -(Hm + 3.0), z: -0.5, rot: -15, kind: 'bushes', pri: 7, occludable: true },
      { nm: 's01', x: -1.0, y: 1.4, z: -3.0, rot: 0, kind: 'none', pri: 9, occludable: false },
      { nm: 's03', x: Wm + 1.0, y: 1.1, z: -2.5, rot: 0, kind: 'none', pri: 9, occludable: false },
      { nm: 's00', x: Wm * 0.3, y: -(Hm + 3.4), z: -2.2, rot: 30, kind: 'none', pri: 9, occludable: false },
    ];
    if (Wm > 20) slots.push({ nm: 'm02', x: Wm * 0.5, y: 6.6, z: -3.6, rot: 0, kind: 'mixed', pri: 4, occludable: false });
    if (Hm > 13.5) {
      slots.push({ nm: 'm04', x: -5.6, y: -Hm - 0.5, z: 0.6, rot: 60, kind: 'trees', pri: 8, occludable: false });
      slots.push({ nm: 'm03', x: Wm + 5.6, y: -Hm - 0.8, z: 0.4, rot: 200, kind: 'mixed', pri: 8, occludable: false });
    }

    const sortedForFeats = slots
      .map((s, idx) => ({ idx, pri: s.pri, kind: s.kind }))
      .filter((s) => s.kind !== 'none')
      .sort((a, b) => a.pri - b.pri);
    const featFor = new Map<number, string>();
    D.features.forEach((fname, fi) => {
      if (fi < sortedForFeats.length) featFor.set(sortedForFeats[fi].idx, fname);
    });

    const pickTreePal = (): [string, string, string] => {
      const tot = P.tree_pals.reduce((acc, [w]) => acc + w, 0);
      let r = rng.next() * tot;
      for (const [w, pal] of P.tree_pals) { r -= w; if (r <= 0) return pal; }
      return P.tree_pals[P.tree_pals.length - 1][1];
    };
    const pickMixKind = (): string | null => {
      if (!D.mix || D.mix.length === 0) return null;
      const tot = D.mix.reduce((acc, [w]) => acc + w, 0);
      let r = rng.next() * tot;
      for (const [w, k] of D.mix) { r -= w; if (r <= 0) return k; }
      return D.mix[D.mix.length - 1][1];
    };

    const fCols = P.flower_main.map((h) => hexLin(h));
    const spaceMap: Record<string, number> = { house: 1.7, bigtree: 1.25, spire: 1.1, sakura: 1.1, palm: 1.0 };
    const arenaCenterX = Wm * 0.5;
    const arenaCenterY = -Hm * 0.5;

    let m06RimWorld: [number, number][] = [];
    let m06Occluder: OccluderEntry | null = null;

    slots.forEach((sl, si) => {
      // Every outer floating island gets its own lightweight group & hideOnOcclude entry so ANY
      // background island blocking a close-up lens (from any angle!) cleanly hides outright!
      const mb = new HqMeshBuilder();

      // Faithful original multi-lobe SDF + Voronoi columnar cliff + sharp_deg=33° floating island!
      const built = buildOriginalDecorIsland(mb, sl.nm, sl.x, sl.y, sl.z, sl.rot, P);
      if (si === 0 && sl.nm === 'm06') {
        m06RimWorld = built.rimWorldPoints;
      }

      const topPts = built.topWorldPoints;
      const placed: [number, number][] = [];

      if (topPts.length > 0 && sl.kind !== 'none') {
        // Place theme landmark feature closest to arena center on prime flat interior (`env.py` L869-880)
        const fname = featFor.get(si);
        if (fname) {
          let maxEdge = 0;
          for (let i = 0; i < topPts.length; i++) if (topPts[i].edgeDist > maxEdge) maxEdge = topPts[i].edgeDist;
          const need = Math.min(0.75, maxEdge * 0.85);
          let bestIdx = 0;
          let bestScore = Infinity;
          for (let i = 0; i < topPts.length; i++) {
            const p = topPts[i];
            const d2 = (p.wx - arenaCenterX) ** 2 + (p.wy - arenaCenterY) ** 2 + (p.edgeDist < need ? 1e6 : 0);
            if (d2 < bestScore) {
              bestScore = d2;
              bestIdx = i;
            }
          }
          const fp = topPts[bestIdx];
          addLandmarkFeature(mb, fname, fp.wx, fp.wy, sl.z + 0.01, rng, P);
          placed.push(
            [fp.wx, fp.wy],
            [fp.wx + 1.2, fp.wy],
            [fp.wx - 1.2, fp.wy],
            [fp.wx, fp.wy + 0.9],
            [fp.wx, fp.wy - 0.9],
          );
        }

        // Fisher-Yates shuffle indices for organic tree/prop scattering strictly inside real island outline
        const perm = new Int32Array(topPts.length);
        for (let i = 0; i < perm.length; i++) perm[i] = i;
        for (let i = perm.length - 1; i > 0; i--) {
          const j = rng.int(0, i + 1);
          const tmp = perm[i];
          perm[i] = perm[j];
          perm[j] = tmp;
        }

        const nTarget = Math.max(1, Math.round((built.area / 2.6) * D.density)) + placed.length;
        for (let pi = 0; pi < perm.length && placed.length < nTarget; pi++) {
          const p = topPts[perm[pi]];
          let tk: string | null = null;
          if (D.mix && (sl.kind !== 'bushes' || !D.bushes)) tk = pickMixKind();
          const gap = tk ? (spaceMap[tk] ?? 0.95) : 0.95;
          if (placed.some(([qx, qy]) => (p.wx - qx) ** 2 + (p.wy - qy) ** 2 < gap * gap)) continue;
          placed.push([p.wx, p.wy]);
          const sc = rng.uniform(0.9, 1.35) * (sl.kind === 'bushes' && tk ? 0.75 : 1.0);
          if (tk === 'pine' || (tk === null && sl.kind !== 'bushes' && rng.next() < D.pines * (sl.kind === 'mixed' ? 1.0 : 0.5))) {
            addFarPine(mb, p.wx, p.wy, sl.z, sc * 1.15, rng, P.pine_pal, P.trunk);
          } else if (tk === null && sl.kind === 'bushes') {
            addFarBush(mb, p.wx, p.wy, sl.z, sc * 1.4, rng, P.bush_pal);
          } else if (tk === null || tk === 'round') {
            addFarRoundTree(mb, p.wx, p.wy, sl.z, sc, rng, pickTreePal(), P.trunk);
          } else {
            addFarProp(mb, tk, p.wx, p.wy, sl.z, sc, rng, P, pickTreePal());
          }
        }

        if (D.bushes) {
          let bPlaced = 0;
          const bLimit = Math.min(10, Math.round(built.area * 0.22));
          for (let pi = 0; pi < perm.length && bPlaced < bLimit; pi += 2) {
            const p = topPts[perm[pi]];
            if (placed.some(([qx, qy]) => (p.wx - qx) ** 2 + (p.wy - qy) ** 2 < 0.7 * 0.7)) continue;
            placed.push([p.wx, p.wy]);
            addFarBush(mb, p.wx, p.wy, sl.z, rng.uniform(0.7, 1.15), rng, P.bush_pal);
            bPlaced++;
          }
        }

        const flPatches = Math.max(1, Math.min(10, Math.round(built.area * 0.16)));
        for (let k = 0; k < flPatches; k++) {
          const p = topPts[rng.int(0, topPts.length)];
          const col = rng.choice(fCols);
          for (let j = 0; j < 4; j++) {
            const r = rng.uniform(0.032, 0.048);
            mb.blob(
              p.wx + rng.normal(0, 0.1),
              p.wy + rng.normal(0, 0.1),
              sl.z + rng.uniform(0.035, 0.095),
              r,
              r,
              r * 0.7,
              col,
              col,
              { sub: 1, smooth: true },
            );
          }
        }
      }

      const { meshes } = mb.buildMeshes({ castShadow: false, receiveShadow: true, sharedMats: this.sharedBucketMats });
      const grp = new THREE.Group();
      for (const m of meshes) grp.add(m);
      this.root.add(grp);
      this.backdropGroups.push(grp);
      const occ = this.registerOccluder(meshes, -1, false, true);
      if (si === 0 && sl.nm === 'm06') {
        m06Occluder = occ;
      }
    });

    // Animated cascading waterfall anchored cleanly to the exact organic east cliff edge of `m06`!
    if (D.waterfall) {
      const wf = new THREE.Group();
      const targetAlongY = -Hm * 0.56;
      let wfX = -4.9 + 2.8;
      let wfZ = Hm * 0.56;
      if (m06RimWorld.length > 0) {
        let bestX = -Infinity;
        let bestY = targetAlongY;
        for (const [rx, ry] of m06RimWorld) {
          if (Math.abs(ry - targetAlongY) < 0.65 && rx > bestX) {
            bestX = rx;
            bestY = ry;
          }
        }
        if (bestX > -Infinity) {
          wfX = bestX - 0.04;
          wfZ = -bestY;
        }
      }
      const topY = 1.5 + D.dz;
      const drop = 11.5;

      const ribGeo = new THREE.PlaneGeometry(0.72, drop, 1, 8);
      const posAttr = ribGeo.getAttribute('position');
      for (let i = 0; i < posAttr.count; i++) {
        const yLocal = posAttr.getY(i);
        const t = (drop * 0.5 - yLocal) / drop;
        posAttr.setZ(i, Math.sin(Math.min(1, t * 2.2) * Math.PI * 0.5) * 0.55);
      }
      ribGeo.computeVertexNormals();
      const rib = new THREE.Mesh(
        ribGeo,
        new THREE.MeshBasicMaterial({ color: '#7CE0FA', transparent: true, opacity: 0.76, side: THREE.DoubleSide, depthWrite: false }),
      );
      rib.position.set(wfX, topY - drop * 0.5, wfZ);
      rib.rotation.y = Math.PI * 0.5;
      wf.add(rib);

      const streakGeo = new THREE.PlaneGeometry(0.14, 1.35);
      const streakMat = new THREE.MeshBasicMaterial({ color: '#EFFBFF', transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false });
      for (let i = 0; i < 6; i++) {
        const sm = new THREE.Mesh(streakGeo, streakMat);
        sm.rotation.y = Math.PI * 0.5;
        sm.userData = { wfX: wfX + 0.52, wfZ: wfZ + ((i % 3) - 1) * 0.2, topY, drop, phase: i / 6 };
        wf.add(sm);
        this.waterfallStreaks.push(sm);
      }

      const mistGeo = new THREE.IcosahedronGeometry(0.32, 0);
      const mistMat = new THREE.MeshBasicMaterial({ color: '#F4FDFF', transparent: true, opacity: 0.72, depthWrite: false });
      for (let i = 0; i < 4; i++) {
        const isTop = i < 2;
        const mm = new THREE.Mesh(mistGeo, mistMat);
        mm.position.set(wfX + (isTop ? 0.25 : 0.65) + (i % 2 - 0.5) * 0.18, isTop ? topY - 0.1 : topY - drop + 0.6, wfZ + ((i % 2) - 0.5) * 0.26);
        mm.scale.setScalar(isTop ? 0.75 : 1.35);
        mm.userData = { baseY: mm.position.y, phase: i * 1.5, baseScale: mm.scale.x };
        wf.add(mm);
        this.waterfallMist.push(mm);
      }

      this.waterfallGroup = wf;
      this.root.add(wf);
      this.backdropGroups.push(wf);
      // Hide the waterfall together with `m06` if `m06` blocks a close-up camera!
      if (m06Occluder) {
        const occ = m06Occluder as OccluderEntry;
        wf.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            occ.meshes.push(obj);
          }
        });
      }
    }
  }

  private buildClouds(rng: SeededRng) {
    const P = this.hqTheme.pal;
    const count = 68;
    const geo = buildFluffyCloudGeometry();
    const mat = new THREE.MeshLambertMaterial({
      color: '#ffffff',
      emissive: new THREE.Color(P.cloud),
      emissiveIntensity: 0.52,
    });
    this.cloudMesh = new THREE.InstancedMesh(geo, mat, count);

    const cMain = new THREE.Color(P.cloud);
    const cShade = new THREE.Color(P.cloud_shade);
    const cx0 = this.widthM * 0.5;
    const cz0 = this.heightM * 0.5;

    for (let i = 0; i < count; i++) {
      const high = i >= 54;
      const x = cx0 + (rng.next() - 0.5) * (this.widthM * 3.4 + 34);
      const z = cz0 + (rng.next() - 0.5) * (this.heightM * 3.0 + 30) - (high ? 4 : 0);
      const y = high ? -7.8 - rng.next() * 1.8 : -11.5 - rng.next() * 3.8;
      const szBase = high ? rng.uniform(1.6, 2.9) : rng.uniform(2.5, 5.2);
      const sx = szBase * rng.uniform(0.95, 1.3);
      const sy = szBase * rng.uniform(0.55, 0.8);
      const sz = szBase * rng.uniform(0.85, 1.15);
      const rotY = rng.uniform(0, Math.PI * 2);
      const speed = high ? 0.34 : 0.2;
      this.cloudData.push({ x, y, z, sx, sy, sz, rotY, speed });

      this._dummy.position.set(x, y, z);
      this._dummy.rotation.set(0, rotY, 0);
      this._dummy.scale.set(sx, sy, sz);
      this._dummy.updateMatrix();
      this.cloudMesh.setMatrixAt(i, this._dummy.matrix);
      this.cloudMesh.setColorAt(i, cMain.clone().lerp(cShade, rng.next() * 0.38));
    }
    this.cloudMesh.instanceMatrix.needsUpdate = true;
    if (this.cloudMesh.instanceColor) this.cloudMesh.instanceColor.needsUpdate = true;
    this.root.add(this.cloudMesh);
  }

  private buildAmbientParticles(rng: SeededRng) {
    const amb = this.hqTheme.ambient;
    if (!amb || amb.cols.length === 0) return;
    const count = Math.max(12, Math.min(64, Math.round((amb.n * (this.widthM * this.heightM)) / 216)));
    const s0 = amb.size * 2.2;
    const geo = new THREE.PlaneGeometry(s0, s0 * 0.65);
    const mat = new THREE.MeshBasicMaterial({ color: '#ffffff', side: THREE.DoubleSide, transparent: true, opacity: 0.84 });
    this.ambientMesh = new THREE.InstancedMesh(geo, mat, count);
    for (let i = 0; i < count; i++) {
      this.ambientData.push({
        x: rng.uniform(-3, this.widthM + 3),
        y: rng.uniform(0.5, 6.2),
        z: rng.uniform(-3, this.heightM + 3),
        vx: (0.32 + rng.next() * 0.38) * amb.speed,
        vy: -(0.48 + rng.next() * 0.42) * amb.speed,
        vz: (0.16 + rng.next() * 0.28) * amb.speed,
        phase: rng.uniform(0, Math.PI * 2),
        s: rng.uniform(0.68, 1.12),
      });
      this.ambientMesh.setColorAt(i, new THREE.Color(amb.cols[i % amb.cols.length]));
    }
    if (this.ambientMesh.instanceColor) this.ambientMesh.instanceColor.needsUpdate = true;
    this.root.add(this.ambientMesh);
  }

  public update(gt: number, elapsedSec: number, opts?: ArenaMapUpdateOpts): boolean {
    const { waveSteps, colWarn } = this.mapData;
    const freezeT = opts?.freezeCollapseAtTick;

    let maxWarnEmissive = 0;
    let shadowDirty = false;
    let anyShadowObstacleDropping = false;

    // 0. In upstream edgeBeautify mode, swap intact rounded island state[0..R] once waves enter warning/fall!
    if (this.stateTerrains.length > 0) {
      let activeState = 0;
      for (let w = 0; w < waveSteps.length; w++) {
        const fallStep = waveSteps[w];
        const frozenIntact = freezeT !== undefined && fallStep > freezeT;
        if (!frozenIntact && gt >= fallStep - colWarn) {
          activeState = Math.min(this.stateTerrains.length - 1, w + 1);
        }
      }
      for (let k = 0; k < this.stateTerrains.length; k++) {
        this.stateTerrains[k].visible = k === activeState;
      }
    }

    // 1. Wave-level swap between ultra-fast merged intact mesh & compact 4x4 (or fractured Voronoi) active-collapse chunks!
    for (const [wave, bundle] of this.waveBundles) {
      if (wave < 0 || wave >= waveSteps.length) continue;
      const fallStep = waveSteps[wave];
      const frozenIntact = freezeT !== undefined && fallStep > freezeT;
      const inWarning = !frozenIntact && gt >= fallStep - colWarn && gt < fallStep;
      const isFalling = !frozenIntact && gt >= fallStep;

      if (!inWarning && !isFalling) {
        // Wave is completely intact -> single merged intactTerrain + intactDetails (2-4 draw calls!)
        if (bundle.mode !== 'intact') {
          bundle.mode = 'intact';
          bundle.intactTerrain.visible = true;
          bundle.intactDetails.visible = true;
          for (const ch of bundle.chunks) {
            ch.terrainGroup.visible = false;
            ch.propMount.visible = true;
            ch.propMount.position.set(ch.cx, 0, ch.cz);
            ch.propMount.rotation.set(0, 0, 0);
            ch.propMount.scale.setScalar(1);
            if (ch.usingWarnMat) {
              ch.usingWarnMat = false;
              if (ch.topMesh) ch.topMesh.material = this.sharedTopMat;
              if (ch.cliffMesh) ch.cliffMesh.material = this.sharedCliffMat;
            }
            ch.modified = false;
            ch.warnDustFired = false;
            ch.fallDustFired = false;
            if (ch.hasShadowCaster && ch.shadowState !== 0) {
              ch.shadowState = 0;
              shadowDirty = true;
            }
          }
        }
        continue;
      }

      // Active warning or falling wave -> hide merged intact slab, animate compact 4x4 chunks!
      bundle.mode = 'active';
      bundle.intactTerrain.visible = false;
      bundle.intactDetails.visible = false;

      const maxD = this.waveMaxDist.get(wave) ?? 1;
      const warnDurSec = Math.max(1, colWarn) * 0.05;
      let anyVisible = false;

      for (const ch of bundle.chunks) {
        if (isFalling) {
          const delay = (1 - ch.distFromCenter / maxD) * 4.5 + ch.rnd[0] * 1.8;
          const u = gt - fallStep;
          if (u < delay) {
            anyVisible = true;
            const amp = 0.032;
            // Continue continuously from the exact end-of-warning phase & frequency (54 rad/s)
            const ph = 43 * warnDurSec + u * 0.05 * 54 + ch.rnd[1] * 20;
            const px = ch.cx + Math.sin(ph) * amp;
            const pz = ch.cz + Math.cos(ph * 1.3) * amp;
            const rx = Math.sin(ph * 0.9) * 0.04;
            const rz = Math.cos(ph * 1.1) * 0.04;
            ch.terrainGroup.visible = true;
            ch.propMount.visible = true;
            ch.terrainGroup.position.set(px, -0.05, pz);
            ch.terrainGroup.rotation.set(rx, 0, rz);
            ch.terrainGroup.scale.setScalar(1);
            ch.propMount.position.set(px, -0.05, pz);
            ch.propMount.rotation.set(rx, 0, rz);
            ch.propMount.scale.setScalar(1);
            if (!ch.usingWarnMat) {
              ch.usingWarnMat = true;
              if (ch.topMesh) ch.topMesh.material = this.warnTopMat;
              if (ch.cliffMesh) ch.cliffMesh.material = this.warnCliffMat;
            }
            maxWarnEmissive = Math.max(maxWarnEmissive, 0.5);
            if (ch.hasShadowCaster && ch.shadowState !== 0) {
              ch.shadowState = 0;
              shadowDirty = true;
            }
          } else {
            const tau = (u - delay) / 20;
            const drop = 0.5 * 14.5 * tau * tau + 0.65 * tau;
            if (drop < 18) {
              if (!ch.fallDustFired) {
                ch.fallDustFired = true;
                opts?.onCollapseDust?.(ch.cx, -0.15, ch.cz, 2, 0.52, 0.58 + 0.22 * ch.rnd[1], 0.76, -0.35);
              }
              anyVisible = true;
              const ox = ch.cx - this.widthM * 0.5;
              const oz = ch.cz - this.heightM * 0.5;
              const L = Math.hypot(ox, oz) || 1;
              const out = 0.48 * tau;
              const px = ch.cx + (ox / L) * out;
              const py = -0.06 - drop;
              const pz = ch.cz + (oz / L) * out;
              const ax = ch.rnd[4] * Math.PI * 2;
              const ang = (0.35 + 1.5 * ch.rnd[5]) * tau * 1.5;
              const rx = Math.cos(ax) * ang;
              const ry = (ch.rnd[2] - 0.5) * tau;
              const rz = Math.sin(ax) * ang;
              const sc = Math.max(0.05, 1 - tau * 0.25);

              ch.terrainGroup.visible = true;
              ch.propMount.visible = true;
              ch.terrainGroup.position.set(px, py, pz);
              ch.terrainGroup.rotation.set(rx, ry, rz);
              ch.terrainGroup.scale.setScalar(sc);
              ch.propMount.position.set(px, py, pz);
              ch.propMount.rotation.set(rx, ry, rz);
              ch.propMount.scale.setScalar(sc);
              if (ch.usingWarnMat) {
                ch.usingWarnMat = false;
                if (ch.topMesh) ch.topMesh.material = this.sharedTopMat;
                if (ch.cliffMesh) ch.cliffMesh.material = this.sharedCliffMat;
              }
              if (ch.hasShadowCaster) {
                anyShadowObstacleDropping = true;
                if (ch.shadowState !== 1) {
                  ch.shadowState = 1;
                  shadowDirty = true;
                }
              }
            } else {
              ch.terrainGroup.visible = false;
              ch.propMount.visible = false;
              if (ch.hasShadowCaster && ch.shadowState !== 2) {
                ch.shadowState = 2;
                shadowDirty = true;
              }
            }
          }
        } else {
          // Warning tremor + orange glow pulse
          ch.fallDustFired = false;
          if (!ch.warnDustFired) {
            ch.warnDustFired = true;
            opts?.onCollapseDust?.(ch.cx, 0.04, ch.cz, 1, 0.14, 0.34, 0.52, 0.12);
          }
          anyVisible = true;
          const warnSec = Math.max(0, (gt - (fallStep - colWarn)) * 0.05);
          const prog = Math.min(1, warnSec / warnDurSec);
          const amp = (0.01 + 0.032 * prog) * prog;
          // Exact phase integral of ω(t) = 32 + 22 * prog(t) rad/s (5.09 → 8.59 Hz)
          const ph = warnSec * (32 + 11 * prog) + ch.rnd[1] * 20;
          const px = ch.cx + Math.sin(ph) * amp;
          const py = -0.02 - 0.04 * prog * prog;
          const pz = ch.cz + Math.cos(ph * 1.25) * amp;
          const tilt = (0.012 + 0.04 * prog) * prog;
          const rx = Math.sin(ph * 0.8 + ch.rnd[2] * 6) * tilt;
          const rz = Math.cos(ph * 1.1 + ch.rnd[3] * 6) * tilt;

          ch.terrainGroup.visible = true;
          ch.propMount.visible = true;
          ch.terrainGroup.position.set(px, py, pz);
          ch.terrainGroup.rotation.set(rx, 0, rz);
          ch.terrainGroup.scale.setScalar(1);
          ch.propMount.position.set(px, py, pz);
          ch.propMount.rotation.set(rx, 0, rz);
          ch.propMount.scale.setScalar(1);

          if (!ch.usingWarnMat) {
            ch.usingWarnMat = true;
            if (ch.topMesh) ch.topMesh.material = this.warnTopMat;
            if (ch.cliffMesh) ch.cliffMesh.material = this.warnCliffMat;
          }
          // Exact phase integral of ω(t) = 9 + 14 * prog(t) rad/s (1.43 → 3.66 Hz)
          const pulse = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(warnSec * (9 + 7 * prog)));
          maxWarnEmissive = Math.max(maxWarnEmissive, pulse * (0.18 + 0.42 * prog));
          if (ch.hasShadowCaster && ch.shadowState !== 0) {
            ch.shadowState = 0;
            shadowDirty = true;
          }
        }
      }

      if (!anyVisible && isFalling) bundle.mode = 'fallen';
    }

    if (!shadowDirty && anyShadowObstacleDropping && Math.abs(gt - this.lastShadowBakeGt) >= 1.5) {
      shadowDirty = true;
    }
    if (shadowDirty) {
      this.lastShadowBakeGt = gt;
    }

    if (maxWarnEmissive > 0.001) {
      this.warnTopMat.emissive.copy(this._warnCol).multiplyScalar(maxWarnEmissive);
      this.warnCliffMat.emissive.copy(this._warnCol).multiplyScalar(maxWarnEmissive);
    } else {
      this.warnTopMat.emissive.copy(this._black);
      this.warnCliffMat.emissive.copy(this._black);
    }

    // 2. Tall-grass breeze sway + interactive player/dart brush-parting (env.py:1101-1122)
    const movers = opts?.movers;
    const pushR = 1.08;
    for (let i = 0; i < this.grassClusters.length; i++) {
      const g = this.grassClusters[i];
      const sw = opts?.pauseGrass ? 0 : Math.sin(elapsedSec * 2.3 + g.cx * 0.7 + g.phase) * 0.075;
      let best = 0;
      let ux = 0;
      let uz = 0;
      let sp = 0;
      if (movers && movers.length > 0) {
        for (let m = 0; m < movers.length; m++) {
          const mv = movers[m];
          const dx = g.cx - mv.x;
          const dz = g.cz - mv.z;
          if (Math.abs(dx) > pushR || Math.abs(dz) > pushR) continue;
          const d = Math.hypot(dx, dz);
          const k = 1 - d / pushR;
          if (k > best) {
            best = k;
            sp = mv.speed;
            if (d > 1e-4) {
              ux = dx / d;
              uz = dz / d;
            } else {
              ux = 0;
              uz = 0;
            }
          }
        }
      }
      if (best > 0) {
        const k = Math.pow(best, 1.3);
        const tilt = 0.34 * k + 0.09 * k * Math.sin(gt * 2.3 + g.phase) * Math.min(1, sp / 0.08);
        g.group.rotation.set(sw + uz * tilt, 0, sw * 0.65 - ux * tilt);
        g.group.scale.set(1 + 0.1 * k, 1 - 0.3 * k, 1 + 0.1 * k);
      } else {
        g.group.rotation.set(sw, 0, sw * 0.65);
        g.group.scale.set(1, 1, 1);
      }
    }

    // 3. Animated cascading waterfall (frozen cleanly at resting pose when `pauseWaterfall` is set!)
    if (this.waterfallGroup) {
      const wfSec = opts?.pauseWaterfall ? 0 : elapsedSec;
      for (let i = 0; i < this.waterfallStreaks.length; i++) {
        const sm = this.waterfallStreaks[i];
        const ud = sm.userData as { wfX: number; wfZ: number; topY: number; drop: number; phase: number };
        const t = (((wfSec * 0.62 + ud.phase) % 1) + 1) % 1;
        const y = ud.topY - t * ud.drop;
        const curveOut = Math.sin(Math.min(1, t * 2.2) * Math.PI * 0.5) * 0.55;
        sm.position.set(ud.wfX - 0.52 + curveOut + 0.04, y, ud.wfZ);
      }
      for (let i = 0; i < this.waterfallMist.length; i++) {
        const mm = this.waterfallMist[i];
        const ud = mm.userData as { baseY: number; phase: number; baseScale: number };
        const p = Math.sin(wfSec * 3.1 + ud.phase);
        mm.position.y = ud.baseY + p * 0.14;
        mm.scale.setScalar(ud.baseScale * (0.9 + 0.16 * p));
      }
    }

    // 4. Fluffy cloud drift
    if (!opts?.pauseClouds) {
      const wrapW = this.widthM * 3.4 + 34;
      const minX = this.widthM * 0.5 - wrapW * 0.5;
      for (let i = 0; i < this.cloudData.length; i++) {
        const c = this.cloudData[i];
        const x = minX + ((((c.x + elapsedSec * c.speed - minX) % wrapW) + wrapW) % wrapW);
        this._dummy.position.set(x, c.y + Math.sin(elapsedSec * 0.45 + i) * 0.16, c.z);
        this._dummy.rotation.set(0, c.rotY, 0);
        this._dummy.scale.set(c.sx, c.sy, c.sz);
        this._dummy.updateMatrix();
        this.cloudMesh.setMatrixAt(i, this._dummy.matrix);
      }
      this.cloudMesh.instanceMatrix.needsUpdate = true;
    }

    // 5. Ambient floating petals / snow / autumn leaves
    if (this.ambientMesh) {
      if (opts?.hideAmbient) {
        this.ambientMesh.visible = false;
      } else {
        this.ambientMesh.visible = true;
        const spanW = this.widthM + 6;
        const spanH = this.heightM + 6;
        for (let i = 0; i < this.ambientData.length; i++) {
          const p = this.ambientData[i];
          const y = (((p.y + elapsedSec * p.vy) % 6.2) + 6.2) % 6.2 + 0.25;
          const x = (((p.x + elapsedSec * p.vx + Math.sin(elapsedSec * 1.7 + p.phase) * 0.45 + 3) % spanW) + spanW) % spanW - 3;
          const z = (((p.z + elapsedSec * p.vz + 3) % spanH) + spanH) % spanH - 3;
          this._dummy.position.set(x, y, z);
          this._dummy.rotation.set(elapsedSec * 2.1 + p.phase, elapsedSec * 1.5, p.phase);
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

  public setBackdropVisible(visible: boolean) {
    for (const g of this.backdropGroups) g.visible = visible;
  }

  public dispose() {
    disposeOccluderEntries(this.occluders);
    this.groundResult.texture.dispose();
    const geos = new Set<THREE.BufferGeometry>();
    const mats = new Set<THREE.Material>([
      this.sharedTopMat,
      this.sharedCliffMat,
      this.warnTopMat,
      this.warnCliffMat,
      ...Object.values(this.sharedBucketMats),
    ]);
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
