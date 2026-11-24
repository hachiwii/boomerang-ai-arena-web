import type { VoxelModelData } from './voxelBuilder';

/**
 * Character model for custom bots: the generic hoodie figure (same voxels as the sparring partners) with the hood
 * dyed in the bot's colour. Base / shadow / highlight hood tones are derived the way the hand-made sparring
 * palettes relate to each other.
 */
export const CUSTOM_CHAR_TEMPLATE = 'demo_red';
const HOOD_KEYS = ['hood', 'hood_d', 'hood_hi'] as const;

function parseHex(hex: string): [number, number, number] {
  const v = Number.parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function toHex(rgb: [number, number, number]): string {
  return `#${rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

export function hoodTones(color: string): Record<(typeof HOOD_KEYS)[number], string> {
  const rgb = parseHex(color);
  return {
    hood: toHex(rgb),
    hood_d: toHex(rgb.map((c) => c * 0.78) as [number, number, number]),
    hood_hi: toHex(rgb.map((c) => c + (255 - c) * 0.34) as [number, number, number]),
  };
}

export function buildCustomCharModel(template: VoxelModelData, charKey: string, color: string): VoxelModelData {
  const tpl = template as unknown as { palette?: Record<string, string> } & Record<string, unknown>;
  const tones = hoodTones(color);
  const remap = new Map<string, string>();
  for (const k of HOOD_KEYS) {
    const from = tpl.palette?.[k];
    if (from) remap.set(from.toUpperCase(), tones[k]);
  }
  const recolor = (v: unknown): unknown => {
    if (typeof v === 'string') return remap.get(v.toUpperCase()) ?? v;
    if (Array.isArray(v)) return v.map(recolor);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = recolor(x);
      return out;
    }
    return v;
  };
  const model = recolor(template) as Record<string, unknown>;
  model.key = charKey;
  model.color = color;
  model.label = '自定义';
  return model as unknown as VoxelModelData;
}
