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

// ---------------------------------------------------------------------------------------------
// Mobile 360° dart-block assist
// ---------------------------------------------------------------------------------------------

// Dart flight constants mirrored from wasm/include/dart.hpp `Config` defaults (maps never override them)
const DART_V = 900;
const DART_DEC = 50;
const DART_VMIN = 200;
const DART_HANG = 3;
const RET_V0 = 150;
const RET_ACC = 80;
const RET_V = 900;
const RECALL_V = 900;
const CATCH_R = 600;
const SLASH_PRE = 2;
// Human block cone with melee assist ON: half-angle 30° (cos 866), point-blank inside BODY_R always blocks
const ASSIST_BLOCK_COS = 866;
const ASSIST_BLOCK_HALF_RAD = Math.acos(ASSIST_BLOCK_COS / 1000);

export interface IncomingDartTarget {
  /** Dart seat (owner index) */
  seat: number;
  /** Judgment index inside the slash window (0 = the tick the slash is issued) */
  k: number;
  dx: number;
  dy: number;
  dl: number;
}

function isFlying(st: number): boolean {
  return st === DState.OUT || st === DState.BACK || st === DState.CALL;
}

/**
 * Predicts where dart `j` will be at the start of each of the next `steps` engine steps
 * (index 0 = current snapshot position). Stops early once the dart would stop flying
 * (wall drop on the way out / back, or caught by its owner).
 */
export function predictDartPath(map: EngineMapData, state: TickSnapshot, j: number, steps: number): [number, number][] {
  const d = state.darts[j];
  const owner = state.players[j];
  const out: [number, number][] = [];
  if (!d || !isFlying(d.st)) return out;
  let st = d.st;
  let x = d.x;
  let y = d.y;
  let left = d.left;
  let age = d.age;
  const ux = d.vx;
  const uy = d.vy;
  const range = map.range > 0 ? map.range : 7200;
  if (st === DState.OUT && left <= 0) left = range;
  out.push([x, y]);
  for (let s = 0; s < steps; s++) {
    let x1 = x;
    let y1 = y;
    if (st === DState.OUT) {
      const spd = Math.max(DART_VMIN, DART_V - age * DART_DEC);
      const m1 = Math.min(spd, left);
      x1 = x + rdiv(ux * m1, UNIT);
      y1 = y + rdiv(uy * m1, UNIT);
      left -= m1;
    } else {
      const spd =
        st === DState.BACK ? (age < DART_HANG ? 0 : Math.min(RET_V, RET_V0 + (age - DART_HANG) * RET_ACC)) : Math.min(RECALL_V, RET_V0 + age * RET_ACC);
      if (spd > 0 && owner) {
        // Homes onto the owner's position (assume the owner keeps its current velocity)
        const ox = owner.x + owner.vx * (s + 1);
        const oy = owner.y + owner.vy * (s + 1);
        const gx = ox - x;
        const gy = oy - y;
        const gl = Math.hypot(gx, gy);
        if (gl <= Math.max(spd, CATCH_R)) return out; // caught this step
        x1 = x + (gx * spd) / gl;
        y1 = y + (gy * spd) / gl;
      }
    }
    age++;
    const throughWalls = st === DState.CALL;
    if (!throughWalls && (x1 !== x || y1 !== y) && wallBetween(map, state.t, Math.round(x), Math.round(y), Math.round(x1), Math.round(y1))) {
      return out; // drops on the wall
    }
    x = x1;
    y = y1;
    if (st === DState.OUT && left <= 0) {
      st = DState.BACK;
      age = 0;
    }
    out.push([x, y]);
  }
  return out;
}

/**
 * The first enemy dart that will be inside slash reach (with no wall in between) on one of the
 * human slash judgment ticks: k = 0..ticks-1 for the multi-frame window, or only k = SLASH_PRE-1
 * for the AI-identical mode (ticks = 0). The slashing player stands still for the whole swing.
 */
export function findIncomingDartTarget(
  map: EngineMapData,
  state: TickSnapshot,
  seat: number,
  slashTicks: number,
): IncomingDartTarget | null {
  const me = state.players[seat];
  if (!me || !me.alive) return null;
  const reach = map.slashReach > 0 ? map.slashReach : 1500;
  const judgeKs = slashTicks > 0 ? Array.from({ length: slashTicks }, (_, i) => i) : [SLASH_PRE - 1];
  const lastK = judgeKs[judgeKs.length - 1];
  let best: IncomingDartTarget | null = null;
  for (let j = 0; j < state.darts.length; j++) {
    if (j === seat || !isFlying(state.darts[j]?.st)) continue;
    const path = predictDartPath(map, state, j, lastK);
    for (const k of judgeKs) {
      const pos = path[k];
      if (!pos) break;
      const dx = Math.round(pos[0] - me.x);
      const dy = Math.round(pos[1] - me.y);
      const dd = dx * dx + dy * dy;
      if (dd > reach * reach) continue;
      if (wallBetween(map, state.t, me.x, me.y, Math.round(pos[0]), Math.round(pos[1]))) continue;
      const dl = isqrt(dd);
      if (!best || k < best.k || (k === best.k && dl < best.dl)) {
        best = { seat: j, k, dx, dy, dl };
      }
      break;
    }
  }
  return best;
}

/**
 * Mobile melee assist. With the dart in hand and an enemy dart arriving inside the slash judgment
 * window, the swing turns (any angle, 360°) toward that dart's predicted position — and, when an
 * enemy player in reach can share the swing, leans toward them while keeping the dart inside the
 * 30° block cone. Otherwise falls back to the regular player-only assist.
 */
export function applyMobileMeleeAssist(
  map: EngineMapData,
  state: TickSnapshot,
  seat: number,
  aimX: number,
  aimY: number,
  slashTicks: number,
): [number, number] {
  const me = state.players[seat];
  const myDart = state.darts[seat];
  if (!me || !me.alive || !myDart || myDart.st !== DState.HAND) {
    return applyMeleeAssist(map, state, seat, aimX, aimY);
  }
  const bodyR = map.bodyR > 0 ? map.bodyR : 400;
  const target = findIncomingDartTarget(map, state, seat, slashTicks);
  // No incoming dart, or one already point-blank (blocked whatever the direction) → aim at players
  if (!target || target.dl <= bodyR) {
    return applyMeleeAssist(map, state, seat, aimX, aimY);
  }

  const dartAngle = Math.atan2(target.dy, target.dx);
  const reach = map.slashReach > 0 ? map.slashReach : 1500;
  const blockHalf = Math.max(0, ASSIST_BLOCK_HALF_RAD - CONE_MARGIN_RAD);
  const playerHalf = Math.max(0, SLASH_HALF_RAD - CONE_MARGIN_RAD);
  let bestRot = 0;
  let bestNeed = Infinity;
  for (let q = 0; q < state.players.length; q++) {
    if (q === seat) continue;
    const p = state.players[q];
    if (!p || !p.alive) continue;
    if (typeof p.visMask === 'number' && ((p.visMask >> seat) & 1) === 0) continue;
    const dx = p.x - me.x;
    const dy = p.y - me.y;
    if (dx * dx + dy * dy > reach * reach) continue;
    if (wallBetween(map, state.t, me.x, me.y, p.x, p.y)) continue;
    const delta = wrapAngleRad(Math.atan2(dy, dx) - dartAngle);
    const need = Math.max(0, Math.abs(delta) - playerHalf);
    if (need <= blockHalf && need < bestNeed) {
      bestNeed = need;
      bestRot = need * (delta >= 0 ? 1 : -1);
    }
  }

  const ang = dartAngle + bestRot;
  const ax = Math.round(Math.cos(ang) * UNIT);
  const ay = Math.round(Math.sin(ang) * UNIT);
  const unit = scaleToUnit(ax, ay);
  if (unit && passesEngineCone(target.dx, target.dy, target.dl, unit[0], unit[1], ASSIST_BLOCK_COS)) {
    return [ax, ay];
  }
  return scaleToUnit(target.dx, target.dy) ?? [aimX, aimY];
}
