import { CellType, EngineMapData } from './types';

export function cellAtStep(map: EngineMapData, gx: number, gy: number, t: number): number {
  if (gx < 0 || gy < 0 || gx >= map.nx || gy >= map.ny) return CellType.PIT;
  const idx = gy * map.nx + gx;
  const w = map.waves[idx];
  if (w >= 0 && t >= map.waveSteps[w]) return CellType.PIT;
  return map.cells[idx];
}

/**
 * Exact integer mirror of dart::cell_of_point(cf, M, x, y, t).
 * A point is only C_PIT if ALL cells it touches (1, 2 on edge, 4 on corner) are C_PIT.
 */
export function cellOfPoint(map: EngineMapData, x: number, y: number, t: number): number {
  const cell = map.cell;
  const ax = Math.floor(x / cell);
  const ay = Math.floor(y / cell);
  const ex = ((x % cell) + cell) % cell === 0;
  const ey = ((y % cell) + cell) % cell === 0;
  const c0 = cellAtStep(map, ax, ay, t);
  if (!ex && !ey) return c0;
  for (let i = 0; i <= (ex ? 1 : 0); i++) {
    for (let j = 0; j <= (ey ? 1 : 0); j++) {
      if (i === 0 && j === 0) continue;
      if (cellAtStep(map, ax - i, ay - j, t) !== c0) return CellType.FLOOR;
    }
  }
  return c0;
}
