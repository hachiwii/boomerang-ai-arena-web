import { ActType, CellType, DState, EngineMapData, HumanAction, PState, TickSnapshot } from './types';

// Authoritative movement constants from dart.hpp (Config defaults)
const RUN_V = 250;
const ACC = 250;
const THROW_MOVE = 50;
const UNIT = 1000;

function rdiv(a: number, b: number): number {
  const half = Math.floor(b / 2);
  return a >= 0 ? Math.floor((a + half) / b) : -Math.floor((-a + half) / b);
}

function isqrt(n: number): number {
  if (n <= 0) return 0;
  let r = Math.floor(Math.sqrt(n));
  while ((r + 1) * (r + 1) <= n) r++;
  while (r * r > n) r--;
  return r;
}

function ilen(x: number, y: number): number {
  return isqrt(x * x + y * y);
}

function iclamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function scaleTo(x: number, y: number, len: number): [number, number] | null {
  if (Math.abs(x) < 100000 && Math.abs(y) < 100000) {
    x *= 1000;
    y *= 1000;
  }
  const L = ilen(x, y);
  if (L === 0) return null;
  return [rdiv(x * len, L), rdiv(y * len, L)];
}

function capLen(x: number, y: number, cap: number): [number, number] {
  const L = ilen(x, y);
  if (L > cap) {
    return [rdiv(x * cap, L), rdiv(y * cap, L)];
  }
  return [x, y];
}

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

function pushOutWalls(
  map: EngineMapData,
  t: number,
  r: number,
  state: { x: number; y: number; vx: number; vy: number },
) {
  const cell = map.cell;
  const r2 = r * r;
  const d2s = new Array<number>(9);
  const pxs = new Array<number>(9);
  const pys = new Array<number>(9);
  const nxs = new Array<number>(9);
  const nys = new Array<number>(9);

  for (let round = 0; round < 4; round++) {
    const cx = Math.floor(state.x / cell);
    const cy = Math.floor(state.y / cell);
    let best = -1;
    for (let i = 0; i < 9; i++) {
      d2s[i] = -1;
      const gx = cx - 1 + (i % 3);
      const gy = cy - 1 + Math.floor(i / 3);
      if (cellAtStep(map, gx, gy, t) !== CellType.WALL) continue;
      const qx = iclamp(state.x, gx * cell, (gx + 1) * cell);
      const qy = iclamp(state.y, gy * cell, (gy + 1) * cell);
      const dx = state.x - qx;
      const dy = state.y - qy;
      const d2 = dx * dx + dy * dy;
      if (d2 >= r2) continue;
      d2s[i] = d2;
      if (best < 0 || d2 < best) best = d2;
    }
    if (best < 0) break;

    let np = 0;
    const add = (nx: number, ny: number, pen: number) => {
      const px = rdiv(nx * pen, UNIT);
      const py = rdiv(ny * pen, UNIT);
      for (let j = 0; j < np; j++) {
        if (pxs[j] === px && pys[j] === py && nxs[j] === nx && nys[j] === ny) return;
      }
      pxs[np] = px;
      pys[np] = py;
      nxs[np] = nx;
      nys[np] = ny;
      np++;
    };

    for (let i = 0; i < 9; i++) {
      if (d2s[i] !== best) continue;
      const gx = cx - 1 + (i % 3);
      const gy = cy - 1 + Math.floor(i / 3);
      const bx0 = gx * cell;
      const by0 = gy * cell;
      const bx1 = bx0 + cell;
      const by1 = by0 + cell;
      if (best === 0) {
        const l = state.x - bx0;
        const rr = bx1 - state.x;
        const u = state.y - by0;
        const dn = by1 - state.y;
        const m = Math.min(l, rr, u, dn);
        if (m === l) add(-UNIT, 0, l + r);
        if (m === rr) add(UNIT, 0, rr + r);
        if (m === u) add(0, -UNIT, u + r);
        if (m === dn) add(0, UNIT, dn + r);
      } else {
        const qx = iclamp(state.x, bx0, bx1);
        const qy = iclamp(state.y, by0, by1);
        const scaled = scaleTo(state.x - qx, state.y - qy, UNIT);
        if (scaled) {
          add(scaled[0], scaled[1], r - isqrt(best));
        }
      }
    }

    for (let j = 0; j < np; j++) {
      state.x += pxs[j];
      state.y += pys[j];
    }
    for (let j = 0; j < np; j++) {
      const vn = state.vx * nxs[j] + state.vy * nys[j];
      if (vn < 0) {
        state.vx -= rdiv(vn * nxs[j], UNIT * UNIT);
        state.vy -= rdiv(vn * nys[j], UNIT * UNIT);
      }
    }
  }
}

function moveBody(
  map: EngineMapData,
  t: number,
  r: number,
  x: number,
  y: number,
  vx: number,
  vy: number,
): { x: number; y: number; vx: number; vy: number } {
  const st = { x, y, vx, vy };
  const L = ilen(vx, vy);
  const ns = Math.max(1, Math.floor((L + 249) / 250));
  for (let i = 1; i <= ns; i++) {
    st.x += rdiv(st.vx * i, ns) - rdiv(st.vx * (i - 1), ns);
    st.y += rdiv(st.vy * i, ns) - rdiv(st.vy * (i - 1), ns);
    pushOutWalls(map, t, r, st);
  }
  return st;
}

/**
 * Exact 1-tick walk simulation matching dart::Game::step() lines 1362-1376.
 */
export function simulateWalkStep(
  map: EngineMapData,
  x: number,
  y: number,
  vx: number,
  vy: number,
  mx: number,
  my: number,
  pct: number,
  t: number,
): { x: number; y: number; vx: number; vy: number; safe: boolean } {
  let tvx = 0;
  let tvy = 0;
  if (pct > 0 && (mx !== 0 || my !== 0)) {
    const L = ilen(mx, my);
    const sp = rdiv(RUN_V * pct * Math.min(L, 1000), 100 * 1000);
    const sc = scaleTo(mx, my, sp);
    if (sc) {
      tvx = sc[0];
      tvy = sc[1];
    }
  }
  const [dvx, dvy] = capLen(tvx - vx, tvy - vy, ACC);
  const res = moveBody(map, t, map.bodyR, x, y, vx + dvx, vy + dvy);
  const safe = cellOfPoint(map, res.x, res.y, t) !== CellType.PIT;
  return { ...res, safe };
}

// Precomputed rotation sin/cos pairs for smooth corner/diagonal cliff sliding
const SLIDE_ANGLES_DEG = [15, -15, 30, -30, 45, -45, 60, -60, 75, -75];
const SLIDE_ROT = SLIDE_ANGLES_DEG.map((deg) => {
  const rad = (deg * Math.PI) / 180;
  return { c: Math.cos(rad), s: Math.sin(rad) };
});

/**
 * Filters ONLY normal walking movement (mx, my) so the human player will not walk off a cliff.
 * Dashing (S_DASH / ActType.DASH), being kicked (S_STUN), and platform collapse underneath the
 * player are intentionally completely unaffected.
 */
export function applyCliffGuard(
  map: EngineMapData,
  state: TickSnapshot,
  seat: number,
  action: HumanAction,
): HumanAction {
  const me = state.players[seat];
  const dart = state.darts[seat];
  if (!me || !me.alive) return action;

  // Never interfere with dashing or kick knockback stun
  if (me.st === PState.DASH || me.st === PState.STUN) return action;

  // Determine the post-start_action walking speed percentage (pct) for this tick
  let postState = me.st;
  if (
    postState === PState.RECALL &&
    (action.mx !== 0 || action.my !== 0 || (action.act !== ActType.NONE && action.act !== ActType.RECALL))
  ) {
    postState = PState.FREE;
  }

  if (postState === PState.FREE && action.act !== ActType.NONE) {
    if (action.act === ActType.DASH && me.cd === 0) {
      // Starting dash: dash is unaffected by cliff guard
      return action;
    }
    if (action.act === ActType.MELEE) {
      // Melee sets pct = 0 automatically
      return action;
    }
    if (action.act === ActType.RECALL && dart && dart.st === DState.GROUND) {
      // Recall stands still (pct = 0)
      return action;
    }
    if (action.act === ActType.THROW && dart && dart.st === DState.HAND) {
      postState = PState.THROW;
    }
  }

  const pct =
    postState === PState.FREE
      ? 100
      : postState === PState.THROW || postState === PState.THROWN
        ? THROW_MOVE
        : 0;

  if (pct === 0) return action;

  const t = state.t;

  // Fast path: desired walk step lands on solid ground
  const desired = simulateWalkStep(map, me.x, me.y, me.vx, me.vy, action.mx, action.my, pct, t);
  if (desired.safe) return action;

  // If the floor underneath the player already collapsed at tick t, don't override platform collapse
  if (cellOfPoint(map, me.x, me.y, t) === CellType.PIT) {
    return action;
  }

  // Current position is solid, but desired walk would step into a pit!
  // Search for the best safe walking vector (smooth rim approach + cliff-edge sliding).
  const desLen = Math.hypot(action.mx, action.my);
  const ux = desLen > 0 ? action.mx / desLen : 0;
  const uy = desLen > 0 ? action.my / desLen : 0;

  let bestMx = 0;
  let bestMy = 0;
  let bestProj = -Infinity;
  let bestPerp = Infinity;
  let foundSafe = false;

  const consider = (cmx: number, cmy: number): boolean => {
    const sim = simulateWalkStep(map, me.x, me.y, me.vx, me.vy, cmx, cmy, pct, t);
    if (!sim.safe) return false;
    const dx = sim.x - me.x;
    const dy = sim.y - me.y;
    const proj = desLen > 0 ? dx * ux + dy * uy : 0;
    // Never choose a candidate that moves backwards relative to user input
    if (desLen > 0 && proj < -0.5) return true;
    const perp = desLen > 0 ? Math.abs(dx * uy - dy * ux) : Math.hypot(dx, dy);
    if (!foundSafe || proj > bestProj + 0.5 || (Math.abs(proj - bestProj) <= 0.5 && perp < bestPerp)) {
      foundSafe = true;
      bestMx = cmx;
      bestMy = cmy;
      bestProj = proj;
      bestPerp = perp;
    }
    return true;
  };

  // Binary-search the largest safe scale in [0..1000] along direction (dirX, dirY)
  const searchSafeScale = (dirX: number, dirY: number): [number, number] => {
    let lo = 0;
    let hi = 1000;
    let safeX = 0;
    let safeY = 0;
    // Check full scale first
    if (consider(dirX, dirY)) {
      return [dirX, dirY];
    }
    for (let iter = 0; iter < 10; iter++) {
      const mid = (lo + hi + 1) >> 1;
      const tx = Math.round((dirX * mid) / 1000);
      const ty = Math.round((dirY * mid) / 1000);
      const sim = simulateWalkStep(map, me.x, me.y, me.vx, me.vy, tx, ty, pct, t);
      if (sim.safe) {
        lo = mid;
        safeX = tx;
        safeY = ty;
      } else {
        hi = mid - 1;
      }
    }
    if (lo > 0) {
      consider(safeX, safeY);
    }
    return [safeX, safeY];
  };

  // 1. Safe stop (always guarantees zero velocity within 1 tick when |v| <= ACC)
  consider(0, 0);

  if (action.mx !== 0 || action.my !== 0) {
    // 2. Clamped straight approach right up to the cliff rim
    searchSafeScale(action.mx, action.my);

    // 3. Axis-aligned cliff sliding (full speed + scaled)
    let safeAxisX = 0;
    let safeAxisY = 0;
    if (action.mx !== 0) {
      const fullX = Math.sign(action.mx) * 1000;
      const [sx] = searchSafeScale(fullX, 0);
      safeAxisX = sx;
      if (action.mx !== fullX) consider(action.mx, 0);
    }
    if (action.my !== 0) {
      const fullY = Math.sign(action.my) * 1000;
      const [, sy] = searchSafeScale(0, fullY);
      safeAxisY = sy;
      if (action.my !== fullY) consider(0, action.my);
    }

    // 4. Combined rim-approach + edge-slide for diagonal input (e.g. W+D against right cliff)
    if (action.mx !== 0 && action.my !== 0) {
      const fullX = Math.sign(action.mx) * 1000;
      const fullY = Math.sign(action.my) * 1000;
      if (safeAxisX !== 0) {
        consider(safeAxisX, fullY);
        consider(safeAxisX, action.my);
      }
      if (safeAxisY !== 0) {
        consider(fullX, safeAxisY);
        consider(action.mx, safeAxisY);
      }
    }

    // 5. Angular fan for smooth sliding along diagonal/stepped voxel island borders
    for (const rot of SLIDE_ROT) {
      const rx = Math.round((ux * rot.c - uy * rot.s) * 1000);
      const ry = Math.round((ux * rot.s + uy * rot.c) * 1000);
      if (!consider(rx, ry)) {
        // Also try half-speed for sharp turns while braking momentum near a cliff
        consider(Math.round(rx * 0.5), Math.round(ry * 0.5));
      }
    }
  }

  // Fallback: if (0, 0) wasn't safe (e.g. somehow |v| > ACC), try full opposite braking
  if (!foundSafe) {
    const brake = scaleTo(-me.vx, -me.vy, 1000);
    if (brake && consider(brake[0], brake[1])) {
      // foundSafe set by consider
    } else {
      bestMx = 0;
      bestMy = 0;
    }
  }

  // Preserve recall-cancel intent if user pressed WASD during S_RECALL and best safe walk is stationary
  if (
    me.st === PState.RECALL &&
    bestMx === 0 &&
    bestMy === 0 &&
    (action.mx !== 0 || action.my !== 0) &&
    action.act === ActType.NONE
  ) {
    const cancelSim = simulateWalkStep(map, me.x, me.y, me.vx, me.vy, 1, 0, pct, t);
    if (cancelSim.safe) {
      bestMx = 1;
      bestMy = 0;
    }
  }

  return {
    ...action,
    mx: bestMx,
    my: bestMy,
  };
}
