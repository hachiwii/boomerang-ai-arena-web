import { cellAtStep } from './cliffGuard';
import { CellType, DState, EngineMapData, PState, TickSnapshot } from './types';

// Authoritative melee constants from wasm/include/dart.hpp
const UNIT = 1000;
const SLASH_COS = 500; // cos(60°) * 1000
const KICK_COS = 500; // cos(60°) * 1000
const SLASH_HALF_RAD = Math.acos(SLASH_COS / 1000);
const KICK_HALF_RAD = Math.acos(KICK_COS / 1000);

// Inward angular margin (~1.15°) so integer rounding of (ax, ay) -> scale_to(..., 1000)
// always lands safely inside the engine's exact dot-product cone inequality.
const CONE_MARGIN_RAD = 0.02;

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

function scaleToUnit(x: number, y: number): [number, number] | null {
  let sx = x;
  let sy = y;
  if (Math.abs(sx) < 100000 && Math.abs(sy) < 100000) {
    sx *= 1000;
    sy *= 1000;
  }
  const L = ilen(sx, sy);
  if (L === 0) return null;
  return [rdiv(sx * UNIT, L), rdiv(sy * UNIT, L)];
}

function wrapAngleRad(a: number): number {
  let r = a;
  while (r > Math.PI) r -= Math.PI * 2;
  while (r <= -Math.PI) r += Math.PI * 2;
  return r;
}

/**
 * Exact rational mirror of dart::wall_between(M, x0, y0, x1, y1) from wasm/include/dart.hpp.
 */
export function wallBetween(
  map: EngineMapData,
  t: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  const dx = x1 - x0;
  const dy = y1 - y0;
  if (dx === 0 && dy === 0) return false;

  const cell = map.cell;
  const gx0 = Math.max(0, Math.floor(Math.min(x0, x1) / cell) - 1);
  const gx1 = Math.min(map.nx - 1, Math.floor(Math.max(x0, x1) / cell) + 1);
  const gy0 = Math.max(0, Math.floor(Math.min(y0, y1) / cell) - 1);
  const gy1 = Math.min(map.ny - 1, Math.floor(Math.max(y0, y1) / cell) + 1);

  const less = (an: number, ad: number, cn: number, cd: number) => an * cd < cn * ad;

  const slab = (p0: number, d: number, b0: number, b1: number) => {
    if (d === 0) {
      return { ok: p0 >= b0 && p0 <= b1, inf: true, en: 0, ed: 1, xn: 0, xd: 1 };
    }
    if (d > 0) {
      return { ok: true, inf: false, en: b0 - p0, ed: d, xn: b1 - p0, xd: d };
    }
    return { ok: true, inf: false, en: p0 - b1, ed: -d, xn: p0 - b0, xd: -d };
  };

  for (let gy = gy0; gy <= gy1; gy++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      if (cellAtStep(map, gx, gy, t) !== CellType.WALL) continue;
      const bx0 = gx * cell;
      const by0 = gy * cell;
      const sx = slab(x0, dx, bx0, bx0 + cell);
      const sy = slab(y0, dy, by0, by0 + cell);
      if (!sx.ok || !sy.ok) continue;

      let inn: number;
      let ind: number;
      let outn: number;
      let outd: number;
      if (sx.inf) {
        inn = sy.en;
        ind = sy.ed;
        outn = sy.xn;
        outd = sy.xd;
      } else if (sy.inf) {
        inn = sx.en;
        ind = sx.ed;
        outn = sx.xn;
        outd = sx.xd;
      } else {
        if (less(sx.en, sx.ed, sy.en, sy.ed)) {
          inn = sy.en;
          ind = sy.ed;
        } else {
          inn = sx.en;
          ind = sx.ed;
        }
        if (less(sx.xn, sx.xd, sy.xn, sy.xd)) {
          outn = sx.xn;
          outd = sx.xd;
        } else {
          outn = sy.xn;
          outd = sy.xd;
        }
      }

      if (inn <= 0) continue;
      if (less(1, 1, inn, ind)) continue;
      if (less(outn, outd, inn, ind)) continue;
      return true;
    }
  }
  return false;
}

interface MeleeTargetCandidate {
  dx: number;
  dy: number;
  dd: number;
  dl: number;
  cosThreshold: number;
  halfAngleRad: number;
}

function passesEngineCone(dx: number, dy: number, dl: number, ux: number, uy: number, cosThreshold: number): boolean {
  return (dx * ux + dy * uy) * 1000 >= cosThreshold * dl * UNIT;
}

/**
 * Melee aim assist (runs once on the exact tick a human melee slash/kick is issued):
 * - Considers ONLY valid enemy players (darts are intentionally excluded from snap targeting).
 * - If ANY valid enemy player is already inside the current mouse aim cone, keeps mouse aim unchanged.
 * - Otherwise, chooses the reachable enemy player requiring the smallest angular rotation to bring
 *   into the hit cone, and rotates ONLY the minimal angle needed to include that target in range.
 * - Does not affect movement (mx, my) or dash directions.
 */
export function applyMeleeAssist(
  map: EngineMapData,
  state: TickSnapshot,
  seat: number,
  aimX: number,
  aimY: number,
): [number, number] {
  const me = state.players[seat];
  const myDart = state.darts[seat];
  if (!me || !me.alive || !myDart) return [aimX, aimY];

  const baseUnit = scaleToUnit(aimX, aimY);
  if (!baseUnit) return [aimX, aimY];
  const [baseUx, baseUy] = baseUnit;

  const isSlash = myDart.st === DState.HAND;
  const reach = map.slashReach > 0 ? map.slashReach : 1500;
  const reachSq = reach * reach;
  const bodyR = map.bodyR > 0 ? map.bodyR : 400;
  const playerCos = isSlash ? SLASH_COS : KICK_COS;
  const playerHalfRad = isSlash ? SLASH_HALF_RAD : KICK_HALF_RAD;
  const t = state.t;

  const candidates: MeleeTargetCandidate[] = [];

  for (let q = 0; q < state.players.length; q++) {
    if (q === seat) continue;
    const target = state.players[q];
    if (!target || !target.alive) continue;
    // Respect fog-of-war visibility mask
    if (typeof target.visMask === 'number' && ((target.visMask >> seat) & 1) === 0) continue;
    // Skip kick-protected players (currently stunned or 1-tick post-stun immunity) when kicking
    if (!isSlash && (target.st === PState.STUN || (target.st === PState.FREE && target.timer > 0))) {
      continue;
    }

    const dx = target.x - me.x;
    const dy = target.y - me.y;
    const dd = dx * dx + dy * dy;
    if (dd > reachSq) continue;
    if (wallBetween(map, t, me.x, me.y, target.x, target.y)) continue;

    const dl = isqrt(dd);
    // Already inside hit range at current aim angle (or point-blank) -> no adjustment needed!
    if (dl <= bodyR || passesEngineCone(dx, dy, dl, baseUx, baseUy, playerCos)) {
      return [aimX, aimY];
    }

    candidates.push({
      dx,
      dy,
      dd,
      dl,
      cosThreshold: playerCos,
      halfAngleRad: playerHalfRad,
    });
  }

  if (candidates.length === 0) {
    return [aimX, aimY];
  }

  // Pick the valid enemy player requiring the smallest angular rotation to include inside its hit cone
  const aimAngle = Math.atan2(baseUy, baseUx);
  let bestTarget: MeleeTargetCandidate | null = null;
  let bestRot = Infinity;
  let bestSignedDelta = 0;

  for (const cand of candidates) {
    const targetAngle = Math.atan2(cand.dy, cand.dx);
    const delta = wrapAngleRad(targetAngle - aimAngle);
    const neededRot = Math.max(0, Math.abs(delta) - cand.halfAngleRad);

    if (
      !bestTarget ||
      neededRot < bestRot - 1e-6 ||
      (Math.abs(neededRot - bestRot) <= 1e-6 && cand.dd < bestTarget.dd)
    ) {
      bestTarget = cand;
      bestRot = neededRot;
      bestSignedDelta = delta;
    }
  }

  if (!bestTarget) return [aimX, aimY];

  // Rotate just enough toward bestTarget so it lands safely inside the engine's exact integer cone
  const safeHalf = Math.max(0, bestTarget.halfAngleRad - CONE_MARGIN_RAD);
  const rotateMag = Math.max(0, Math.abs(bestSignedDelta) - safeHalf);
  const sign = bestSignedDelta >= 0 ? 1 : -1;
  const adjustedAngle = aimAngle + sign * rotateMag;
  const candAx = Math.round(Math.cos(adjustedAngle) * UNIT);
  const candAy = Math.round(Math.sin(adjustedAngle) * UNIT);
  const candUnit = scaleToUnit(candAx, candAy);

  if (candUnit && passesEngineCone(bestTarget.dx, bestTarget.dy, bestTarget.dl, candUnit[0], candUnit[1], bestTarget.cosThreshold)) {
    return [candAx, candAy];
  }

  // Defensive fallback: if integer rounding still grazed the edge, aim straight at the target center
  const direct = scaleToUnit(bestTarget.dx, bestTarget.dy);
  return direct ?? [aimX, aimY];
}
