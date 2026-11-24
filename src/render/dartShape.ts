/**
 * Pure (three.js-free) voxel layout of the in-game boomerang — the exact 3-blade pattern from
 * chars_voxel.py dart_part(). Shared by the 3D voxel mesh and the mobile HUD icon so they can
 * never drift apart.
 *
 * Cell kinds: 'core' hub center · 'ring' white hub ring · 'blade' · 'shade' (trailing edge) · 'tip'.
 */
export type DartVoxelKind = 'core' | 'ring' | 'blade' | 'shade' | 'tip';

export interface DartVoxel {
  i: number;
  j: number;
  kind: DartVoxelKind;
}

export const DART_CELL = 0.058;
export const DART_GRID_N = 6;
export const DART_BLADES = 3;

export function computeDartVoxels(blades = DART_BLADES): DartVoxel[] {
  const out: DartVoxel[] = [];
  const n = DART_GRID_N;
  for (let i = -n; i <= n; i++) {
    for (let j = -n; j <= n; j++) {
      const x = i * DART_CELL;
      const y = j * DART_CELL;
      const r = Math.hypot(x, y);
      if (r < 0.085) {
        out.push({ i, j, kind: r > 0.03 ? 'ring' : 'core' });
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
        out.push({ i, j, kind: best[1] > 0.8 ? 'tip' : best[2] < -0.012 ? 'shade' : 'blade' });
      }
    }
  }
  return out;
}
