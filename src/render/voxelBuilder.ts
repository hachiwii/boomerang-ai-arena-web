import * as THREE from 'three';

export interface VoxelPartData {
  pivot: [number, number, number];
  outline: boolean;
  voxels: [number, number, number, string][];
  paint: [number, number, number, number, string][];
  slabs: [number, number, number, number, number, number, string][];
}

export interface VoxelModelData {
  key: string;
  unit: number;
  hz: number;
  scale: number;
  arm_len: number;
  hair_swing: number;
  tail_rest: number;
  palette: Record<string, string>;
  color: string;
  label: string;
  parts: Record<string, VoxelPartData>;
}

const DIRS: readonly [number, number, number][] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

const QUADS: readonly (readonly [number, number, number][])[] = [
  [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]],
  [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
  [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
  [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
  [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]],
];

// Directional shading baked slightly into voxel normals + Three.js lighting gives super crisp chibi look
const FACE_SHADE = [0.95, 0.90, 0.86, 1.02, 1.06, 0.78];

export const VOX_U = 0.07;
export const CHAR_SCALE = 1.26;
const OUTLINE_W = 0.0125;
const OUTLINE_RGB: [number, number, number] = [0.18, 0.133, 0.22]; // #2E2238

function parseHexToLinear(hex: string): [number, number, number] {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

// Convert voxkit (vx, vy, vz) -> Three.js right-handed (vx, vz, -vy)
function mapVoxPos(x: number, y: number, z: number): [number, number, number] {
  return [x, z, -y];
}

function mapVoxDir(dx: number, dy: number, dz: number): [number, number, number] {
  return [dx, dz, -dy];
}

function vkey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

export interface BuiltPartMeshes {
  group: THREE.Group;
  mainMesh: THREE.Mesh;
  outlineMesh: THREE.Mesh | null;
}

const sharedVoxMatCache = new Map<string, THREE.MeshLambertMaterial>();

export function createVoxelMaterial(emissiveFactor = 0.16): THREE.MeshLambertMaterial {
  const key = `vox_${emissiveFactor}`;
  let m = sharedVoxMatCache.get(key);
  if (!m) {
    m = new THREE.MeshLambertMaterial({
      vertexColors: true,
      flatShading: true,
    });
    // Slightly brighten dark backfaces just like VOX_EMIT in chars_voxel.py
    m.emissive.setRGB(emissiveFactor, emissiveFactor, emissiveFactor);
    m.emissiveIntensity = 0.45;
    sharedVoxMatCache.set(key, m);
  }
  return m;
}

let sharedOutlineMat: THREE.MeshBasicMaterial | null = null;
export function getOutlineMaterial(): THREE.MeshBasicMaterial {
  if (!sharedOutlineMat) {
    sharedOutlineMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.FrontSide, // Quads are wound reversed in inverted hull
    });
  }
  return sharedOutlineMat;
}

/**
 * Compile a VoxelPartData into Three.js BufferGeometry + inverted-hull outline geometry.
 * Exact port of voxkit.VPart.mesh() + chars_voxel.build_part().
 */
export function buildVoxelPartGeometry(
  part: VoxelPartData,
  unit = VOX_U,
  outlineWidth = OUTLINE_W,
): { mainGeo: THREE.BufferGeometry; outlineGeo: THREE.BufferGeometry | null } {
  const voxMap = new Map<string, string>();
  for (const [x, y, z, col] of part.voxels) {
    voxMap.set(vkey(x, y, z), col);
  }
  const paintMap = new Map<string, string>();
  for (const [x, y, z, d, col] of part.paint) {
    paintMap.set(`${x},${y},${z},${d}`, col);
  }

  const colCache = new Map<string, [number, number, number]>();
  const getCol = (hex: string) => {
    let v = colCache.get(hex);
    if (!v) {
      v = parseHexToLinear(hex);
      colCache.set(hex, v);
    }
    return v;
  };

  const [px, py, pz] = part.pivot;

  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  // For inverted-hull outline: track exposed voxel quads and per-corner normal directions
  const exposedQuads: { corners: [number, number, number][]; col: [number, number, number] }[] = [];
  const cornerDirs = new Map<string, Set<number>>();

  let vIdx = 0;

  for (const [x, y, z, baseHex] of part.voxels) {
    for (let d = 0; d < 6; d++) {
      const [dx, dy, dz] = DIRS[d];
      if (voxMap.has(vkey(x + dx, y + dy, z + dz))) continue;

      const hex = paintMap.get(`${x},${y},${z},${d}`) ?? baseHex;
      const [cr, cg, cb] = getCol(hex);
      const sh = FACE_SHADE[d];
      const [nx, ny, nz] = mapVoxDir(dx, dy, dz);

      const q = QUADS[d];
      const corners: [number, number, number][] = [];
      for (let i = 0; i < 4; i++) {
        const cx = x + q[i][0];
        const cy = y + q[i][1];
        const cz = z + q[i][2];
        corners.push([cx, cy, cz]);

        const [tx, ty, tz] = mapVoxPos((cx - px) * unit, (cy - py) * unit, (cz - pz) * unit);
        positions.push(tx, ty, tz);
        normals.push(nx, ny, nz);
        colors.push(Math.min(1, cr * sh), Math.min(1, cg * sh), Math.min(1, cb * sh));

        if (outlineWidth > 0 && part.outline) {
          const ck = vkey(cx, cy, cz);
          let s = cornerDirs.get(ck);
          if (!s) {
            s = new Set<number>();
            cornerDirs.set(ck, s);
          }
          s.add(d);
        }
      }
      indices.push(vIdx, vIdx + 1, vIdx + 2, vIdx, vIdx + 2, vIdx + 3);
      vIdx += 4;

      if (outlineWidth > 0 && part.outline) {
        exposedQuads.push({ corners, col: [cr, cg, cb] });
      }
    }
  }

  // Thin slabs (eyes, mouth, glasses, hood cords, trim)
  for (const [x0, x1, y0, y1, z0, z1, hex] of part.slabs) {
    const [cr, cg, cb] = getCol(hex);
    for (let d = 0; d < 6; d++) {
      const [dx, dy, dz] = DIRS[d];
      const [nx, ny, nz] = mapVoxDir(dx, dy, dz);
      const q = QUADS[d];
      const sh = FACE_SHADE[d];
      for (let i = 0; i < 4; i++) {
        const cx = q[i][0] ? x1 : x0;
        const cy = q[i][1] ? y1 : y0;
        const cz = q[i][2] ? z1 : z0;
        const [tx, ty, tz] = mapVoxPos((cx - px) * unit, (cy - py) * unit, (cz - pz) * unit);
        positions.push(tx, ty, tz);
        normals.push(nx, ny, nz);
        colors.push(Math.min(1, cr * sh), Math.min(1, cg * sh), Math.min(1, cb * sh));
      }
      indices.push(vIdx, vIdx + 1, vIdx + 2, vIdx, vIdx + 2, vIdx + 3);
      vIdx += 4;
    }
  }

  const mainGeo = new THREE.BufferGeometry();
  mainGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  mainGeo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  mainGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  mainGeo.setIndex(indices);

  let outlineGeo: THREE.BufferGeometry | null = null;
  if (outlineWidth > 0 && part.outline && exposedQuads.length > 0) {
    const oPos: number[] = [];
    const oCol: number[] = [];
    const oIdx: number[] = [];
    let ov = 0;
    for (const eq of exposedQuads) {
      const [cr, cg, cb] = eq.col;
      const or = cr * 0.2 + OUTLINE_RGB[0] * 0.8;
      const og = cg * 0.2 + OUTLINE_RGB[1] * 0.8;
      const ob = cb * 0.2 + OUTLINE_RGB[2] * 0.8;
      for (let i = 0; i < 4; i++) {
        const [cx, cy, cz] = eq.corners[i];
        const ds = cornerDirs.get(vkey(cx, cy, cz))!;
        let ox = 0;
        let oy = 0;
        let oz = 0;
        for (const dd of ds) {
          ox += DIRS[dd][0];
          oy += DIRS[dd][1];
          oz += DIRS[dd][2];
        }
        ox = Math.max(-1, Math.min(1, ox));
        oy = Math.max(-1, Math.min(1, oy));
        oz = Math.max(-1, Math.min(1, oz));
        const vx = (cx - px) * unit + ox * outlineWidth;
        const vy = (cy - py) * unit + oy * outlineWidth;
        const vz = (cz - pz) * unit + oz * outlineWidth;
        const [tx, ty, tz] = mapVoxPos(vx, vy, vz);
        oPos.push(tx, ty, tz);
        oCol.push(or, og, ob);
      }
      // Reversed winding for inverted hull!
      oIdx.push(ov + 3, ov + 2, ov + 1, ov + 3, ov + 1, ov);
      ov += 4;
    }
    outlineGeo = new THREE.BufferGeometry();
    outlineGeo.setAttribute('position', new THREE.Float32BufferAttribute(oPos, 3));
    outlineGeo.setAttribute('color', new THREE.Float32BufferAttribute(oCol, 3));
    outlineGeo.setIndex(oIdx);
  }

  return { mainGeo, outlineGeo };
}

function mixHex(hex: string, weight: number, target = 255): string {
  const h = hex.replace('#', '');
  let out = '#';
  for (let i = 0; i < 6; i += 2) {
    const v = parseInt(h.slice(i, i + 2), 16);
    const m = Math.round(v * (1 - weight) + target * weight);
    out += Math.max(0, Math.min(255, m)).toString(16).padStart(2, '0');
  }
  return out;
}

const DART_CELL = 0.058;

/**
 * Exact 3-blade voxel boomerang from chars_voxel.py dart_part() + make_dart()!
 */
export function buildVoxelDartMesh(colorHex: string, scale = 1.0): THREE.Group {
  const main = colorHex;
  const light = mixHex(colorHex, 0.5, 255);
  const deep = mixHex(colorHex, 0.28, 20);
  const voxels: [number, number, number, string][] = [];
  const blades = 3;
  const n = 6;

  for (let i = -n; i <= n; i++) {
    for (let j = -n; j <= n; j++) {
      const x = i * DART_CELL;
      const y = j * DART_CELL;
      const r = Math.hypot(x, y);
      if (r < 0.085) {
        voxels.push([i, j, 0, r > 0.03 ? '#FFFFFF' : main]);
        continue;
      }
      let best: [number, number, number] | null = null;
      for (let b = 0; b < blades; b++) {
        const a0 = (2 * Math.PI * b) / blades;
        for (let k = 0; k <= 40; k++) {
          const t = k / 40;
          const rr = 0.05 + 0.26 * t;
          const ang = a0 + 0.8 * Math.pow(t, 1.25);
          const d = Math.hypot(x - rr * Math.cos(ang), y - rr * Math.sin(ang));
          const w = 0.074 * (1.0 - 0.32 * t);
          if (d < w && (best === null || d / w < best[0])) {
            const side = x * Math.cos(ang) + y * Math.sin(ang) - rr;
            best = [d / w, t, side];
          }
        }
      }
      if (best !== null) {
        const col = best[1] > 0.8 ? light : best[2] < -0.012 ? deep : main;
        voxels.push([i, j, 0, col]);
      }
    }
  }

  const part: VoxelPartData = {
    pivot: [0.5, 0.5, 0.5],
    outline: true,
    voxels,
    paint: [],
    slabs: [],
  };

  const { mainGeo, outlineGeo } = buildVoxelPartGeometry(part, DART_CELL * scale, 0.012);
  const group = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    flatShading: true,
    emissive: new THREE.Color('#ffffff'),
    emissiveIntensity: 0.14,
  });
  group.add(new THREE.Mesh(mainGeo, mat));
  if (outlineGeo) {
    group.add(new THREE.Mesh(outlineGeo, getOutlineMaterial()));
  }
  return group;
}

/**
 * Build the sliced upper & lower voxel halves of a character at the waist (just like chars_voxel.py build_slice!).
 */
export function buildSlicedHalves(model: VoxelModelData, colorHex: string): {
  upper: THREE.Group;
  lower: THREE.Group;
  cutY: number;
} {
  const bodyPart = model.parts['body'];
  let minZ = 999;
  let maxZ = -999;
  for (const [, , z] of bodyPart.voxels) {
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const zb = minZ + Math.floor((maxZ + 1 - minZ) * 0.65 + 0.5);
  const cutHex = mixHex(colorHex, 0.72, 255);

  const upperGroup = new THREE.Group();
  const lowerGroup = new THREE.Group();
  const mat = createVoxelMaterial(0.2);
  const omat = getOutlineMaterial();

  for (const [nm, part] of Object.entries(model.parts)) {
    if (nm.startsWith('face_') && nm !== 'face_tight') continue;
    const voxSet = new Map<string, string>();
    for (const [x, y, z, c] of part.voxels) voxSet.set(vkey(x, y, z), c);

    const upPart: VoxelPartData = { pivot: [0, 0, zb], outline: part.outline, voxels: [], paint: [], slabs: [] };
    const loPart: VoxelPartData = { pivot: [0, 0, 0], outline: part.outline, voxels: [], paint: [], slabs: [] };

    for (const [x, y, z, c] of part.voxels) {
      const isUp = z >= zb;
      const target = isUp ? upPart : loPart;
      target.voxels.push([x, y, z, c]);
      // Paint newly exposed cut face cleanly
      if (isUp && voxSet.has(vkey(x, y, z - 1)) && z - 1 < zb) {
        target.paint.push([x, y, z, 5, cutHex]); // NZ face
      } else if (!isUp && voxSet.has(vkey(x, y, z + 1)) && z + 1 >= zb) {
        target.paint.push([x, y, z, 4, cutHex]); // PZ face
      }
    }
    for (const p of part.paint) {
      const target = p[2] >= zb ? upPart : loPart;
      target.paint.push(p);
    }
    for (const sl of part.slabs) {
      const midZ = (sl[4] + sl[5]) * 0.5;
      if (Math.abs(midZ - zb) < 0.25) continue;
      (midZ >= zb ? upPart : loPart).slabs.push(sl);
    }

    if (upPart.voxels.length > 0 || upPart.slabs.length > 0) {
      const { mainGeo, outlineGeo } = buildVoxelPartGeometry(upPart, VOX_U, OUTLINE_W);
      upperGroup.add(new THREE.Mesh(mainGeo, mat));
      if (outlineGeo) upperGroup.add(new THREE.Mesh(outlineGeo, omat));
    }
    if (loPart.voxels.length > 0 || loPart.slabs.length > 0) {
      const { mainGeo, outlineGeo } = buildVoxelPartGeometry(loPart, VOX_U, OUTLINE_W);
      lowerGroup.add(new THREE.Mesh(mainGeo, mat));
      if (outlineGeo) lowerGroup.add(new THREE.Mesh(outlineGeo, omat));
    }
  }

  const s = CHAR_SCALE * (model.scale || 1.0);
  upperGroup.scale.setScalar(s);
  lowerGroup.scale.setScalar(s);
  return { upper: upperGroup, lower: lowerGroup, cutY: zb * VOX_U * s };
}
