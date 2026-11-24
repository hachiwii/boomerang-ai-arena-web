/**
 * User-supplied character models for custom bots: the same voxel JSON format as public/assets/chars/*.json
 * (parts → pivot / voxels / paint / slabs, rigged by part name in render/charRig.ts). The file is validated and
 * normalised here, content-hashed (so replays can refer to it), and given a pixel avatar drawn from its head.
 */
import { sha256Hex } from './sha256';

export interface CustomModelInput {
  id: string; // first 16 hex of the SHA-256 of `json`
  json: string; // normalised model JSON
  name: string; // uploaded file name
  avatar: string; // data URL
  parts: number;
  voxels: number;
}

export const MAX_MODEL_BYTES = 2 * 1024 * 1024;
const MAX_PARTS = 64;
const MAX_VOXELS = 40000;
const MAX_PAINT = 40000;
const MAX_SLABS = 4000;
const MAX_COORD = 256;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const PART_NAME_RE = /^[A-Za-z0-9_]{1,32}$/;
// Hidden alternate expressions: not part of the resting look (avatar uses face_open)
const ALT_FACES = new Set(['face_tight', 'face_happy']);

type Voxel = [number, number, number, string];
type Paint = [number, number, number, number, string];
type Slab = [number, number, number, number, number, number, string];
interface Part {
  pivot: [number, number, number];
  outline: boolean;
  voxels: Voxel[];
  paint: Paint[];
  slabs: Slab[];
}

class ModelError extends Error {}

const isInt = (v: unknown, lim = MAX_COORD) => Number.isInteger(v) && Math.abs(v as number) <= lim;
const isNum = (v: unknown, lim = 4096) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= lim;
const isHex = (v: unknown): v is string => typeof v === 'string' && HEX_RE.test(v);

function optNumber(raw: Record<string, unknown>, key: string, def: number, lo: number, hi: number): number {
  const v = raw[key];
  if (v === undefined || v === null) return def;
  if (!isNum(v)) throw new ModelError(`${key} 必须是数字`);
  return Math.max(lo, Math.min(hi, v as number));
}

function parsePart(name: string, raw: unknown): Part {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ModelError(`parts.${name} 必须是对象`);
  const p = raw as Record<string, unknown>;
  const pivot = p.pivot;
  if (!Array.isArray(pivot) || pivot.length !== 3 || !pivot.every((v) => isNum(v, MAX_COORD))) {
    throw new ModelError(`parts.${name}.pivot 必须是 3 个数字`);
  }
  const list = (key: string) => {
    const v = p[key];
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new ModelError(`parts.${name}.${key} 必须是数组`);
    return v as unknown[];
  };
  const voxels = list('voxels').map((v, i) => {
    if (!Array.isArray(v) || v.length !== 4 || !isInt(v[0]) || !isInt(v[1]) || !isInt(v[2]) || !isHex(v[3])) {
      throw new ModelError(`parts.${name}.voxels[${i}] 应为 [x, y, z, "#RRGGBB"]（整数坐标）`);
    }
    return [v[0], v[1], v[2], v[3].toUpperCase()] as Voxel;
  });
  const paint = list('paint').map((v, i) => {
    if (
      !Array.isArray(v) || v.length !== 5 || !isInt(v[0]) || !isInt(v[1]) || !isInt(v[2]) ||
      !Number.isInteger(v[3]) || v[3] < 0 || v[3] > 5 || !isHex(v[4])
    ) {
      throw new ModelError(`parts.${name}.paint[${i}] 应为 [x, y, z, 面 0-5, "#RRGGBB"]`);
    }
    return [v[0], v[1], v[2], v[3], v[4].toUpperCase()] as Paint;
  });
  const slabs = list('slabs').map((v, i) => {
    if (!Array.isArray(v) || v.length !== 7 || !v.slice(0, 6).every((n) => isNum(n, MAX_COORD)) || !isHex(v[6])) {
      throw new ModelError(`parts.${name}.slabs[${i}] 应为 [x0, x1, y0, y1, z0, z1, "#RRGGBB"]`);
    }
    return [v[0], v[1], v[2], v[3], v[4], v[5], v[6].toUpperCase()] as Slab;
  });
  return {
    pivot: [pivot[0], pivot[1], pivot[2]] as [number, number, number],
    outline: p.outline === undefined ? true : Boolean(p.outline),
    voxels,
    paint,
    slabs,
  };
}

/** Validates + normalises an uploaded model. Throws an Error with a readable (Chinese) message. */
export async function parseCustomModel(text: string, fileName: string): Promise<CustomModelInput> {
  if (text.length > MAX_MODEL_BYTES) throw new Error(`模型文件太大（上限 ${MAX_MODEL_BYTES / 1024 / 1024} MB）`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`不是有效的 JSON：${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ModelError('顶层必须是对象');
    const r = raw as Record<string, unknown>;
    const partsRaw = r.parts;
    if (!partsRaw || typeof partsRaw !== 'object' || Array.isArray(partsRaw)) throw new ModelError('缺少 parts 对象');
    const names = Object.keys(partsRaw);
    if (names.length === 0 || names.length > MAX_PARTS) throw new ModelError(`parts 需要 1–${MAX_PARTS} 个部件`);
    const parts: Record<string, Part> = {};
    let nVox = 0;
    let nPaint = 0;
    let nSlab = 0;
    for (const nm of names) {
      if (!PART_NAME_RE.test(nm)) throw new ModelError(`部件名「${nm}」只能用字母、数字和下划线`);
      const part = parsePart(nm, (partsRaw as Record<string, unknown>)[nm]);
      nVox += part.voxels.length;
      nPaint += part.paint.length;
      nSlab += part.slabs.length;
      parts[nm] = part;
    }
    if (!parts.body || parts.body.voxels.length === 0) throw new ModelError('必须有 parts.body，且至少 1 个体素');
    if (nVox > MAX_VOXELS) throw new ModelError(`体素太多（${nVox}，上限 ${MAX_VOXELS}）`);
    if (nPaint > MAX_PAINT) throw new ModelError(`paint 太多（${nPaint}，上限 ${MAX_PAINT}）`);
    if (nSlab > MAX_SLABS) throw new ModelError(`slabs 太多（${nSlab}，上限 ${MAX_SLABS}）`);

    const palette: Record<string, string> = {};
    if (r.palette && typeof r.palette === 'object' && !Array.isArray(r.palette)) {
      for (const [k, v] of Object.entries(r.palette as Record<string, unknown>)) {
        if (PART_NAME_RE.test(k) && isHex(v)) palette[k] = v.toUpperCase();
      }
    }
    const model = {
      key: '',
      unit: optNumber(r, 'unit', 0.07, 0.01, 1),
      hz: optNumber(r, 'hz', 6, 0, 60),
      scale: optNumber(r, 'scale', 1, 0.2, 3),
      arm_len: optNumber(r, 'arm_len', 2.5, 0, 32),
      hair_swing: optNumber(r, 'hair_swing', 1, 0, 8),
      tail_rest: optNumber(r, 'tail_rest', 0, -8, 8),
      palette,
      color: '',
      label: '',
      parts,
    };
    const json = JSON.stringify(model);
    const id = (await sha256Hex(new TextEncoder().encode(json))).slice(0, 16);
    return { id, json, name: fileName, avatar: modelAvatar(parts), parts: names.length, voxels: nVox };
  } catch (err) {
    if (err instanceof ModelError) throw new Error(`模型格式不对：${err.message}`);
    throw err;
  }
}

/**
 * Front view (from -y, +z up) of the head region, pixel for pixel: the frontmost voxel of each column with its
 * front-face paint, plus slabs (eyes, mouth…) lying on that front. Falls back to the top of the model without a head.
 */
function modelAvatar(parts: Record<string, Part>): string {
  const visible = Object.entries(parts).filter(([nm]) => !ALT_FACES.has(nm));
  const all = visible.flatMap(([, p]) => p.voxels);
  const headVox = parts.head?.voxels.length ? parts.head.voxels : null;
  const ref = headVox ?? all;
  let x0 = Math.min(...ref.map((v) => v[0]));
  let x1 = Math.max(...ref.map((v) => v[0])) + 1;
  let z0 = Math.min(...ref.map((v) => v[2]));
  const z1 = Math.max(...ref.map((v) => v[2])) + 1;
  if (!headVox) z0 = Math.max(z0, z1 - Math.max(4, Math.round((z1 - z0) * 0.45)));
  // square crop, centred horizontally, keeping the top of the head
  const size = Math.max(x1 - x0, z1 - z0) + 2;
  const cx = (x0 + x1) / 2;
  x0 = cx - size / 2;
  x1 = cx + size / 2;
  const top = z1 + 1;
  const bottom = top - size;

  const front = new Map<string, { y: number; col: string }>();
  for (const [, p] of visible) {
    const paintFront = new Map<string, string>();
    for (const [x, y, z, d, col] of p.paint) if (d === 3) paintFront.set(`${x},${y},${z}`, col);
    for (const [x, y, z, col] of p.voxels) {
      if (x + 1 <= x0 || x >= x1 || z + 1 <= bottom || z >= top) continue;
      const k = `${x},${z}`;
      const cur = front.get(k);
      if (!cur || y < cur.y) front.set(k, { y, col: paintFront.get(`${x},${y},${z}`) ?? col });
    }
  }
  const rects: string[] = [];
  const px = (x: number) => (x - x0).toFixed(2);
  const pz = (z: number) => (top - z).toFixed(2);
  for (const [k, { col }] of front) {
    const [x, z] = k.split(',').map(Number);
    rects.push(`<rect x="${px(x)}" y="${pz(z + 1)}" width="1" height="1" fill="${col}"/>`);
  }
  for (const [, p] of visible) {
    for (const [sx0, sx1, sy0, , sz0, sz1, col] of p.slabs) {
      const fx = Math.floor((sx0 + sx1) / 2);
      const fz = Math.floor((sz0 + sz1) / 2);
      const f = front.get(`${fx},${fz}`);
      if (f && sy0 > f.y + 0.5) continue; // behind the surface
      if (sx1 <= x0 || sx0 >= x1 || sz1 <= bottom || sz0 >= top) continue;
      rects.push(
        `<rect x="${px(sx0)}" y="${pz(sz1)}" width="${(sx1 - sx0).toFixed(2)}" height="${(sz1 - sz0).toFixed(2)}" fill="${col}"/>`,
      );
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">${rects.join('')}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
