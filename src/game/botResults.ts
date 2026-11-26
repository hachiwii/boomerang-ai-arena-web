// Ranked bot results for the site analytics (src/net/analytics.ts → relay → scripts/pvp_stats.sh): for every bot in a
// ranked match played to the end — and for the human player, under the id `human` — win / draw / loss, its kills by
// cause and how it died. Pure functions over the ticks.
import { CauseType, CellType, isRankedMatchMode } from './types';
import type { EngineMapData, MatchConfig, TickSnapshot } from './types';

/** How a player was knocked out: melee, dart, kicked into a pit, fell off on its own (walk or dash), ground collapsed. */
export const DEATH_CAUSES = ['melee', 'dart', 'kick', 'fall', 'collapse'] as const;
export type DeathCause = (typeof DEATH_CAUSES)[number];

/** Result id of the human player (all human players are summed under it). */
export const HUMAN_RESULT_ID = 'human';

/** Kills credited to a player: the causes that have a killer. */
export const KILL_CAUSES = ['melee', 'dart', 'kick'] as const;
export type KillCause = (typeof KILL_CAUSES)[number];

/** b = bot id, r = win / draw / loss, kills = players it knocked out by cause, death = how it went out (if it did). */
export interface BotResult {
  b: string;
  r: 'w' | 'd' | 'l';
  rank: number; // final place (1 = first; ties share the best place)
  kills?: Partial<Record<KillCause, number>>;
  death?: DeathCause;
}

// The engine's cell lookup at step t (wasm/include/dart.hpp cell_at_step): outside the map and collapsed cells are pits.
function cellAtStep(map: EngineMapData, cx: number, cy: number, t: number): number {
  if (cx < 0 || cy < 0 || cx >= map.nx || cy >= map.ny) return CellType.PIT;
  const i = cy * map.nx + cx;
  const w = map.waves[i];
  if (w >= 0 && t >= map.waveSteps[w]) return CellType.PIT;
  return map.cells[i];
}

// The terrain under a point (dart.hpp cell_of_point): a point on a grid line touches 2 cells (4 on a grid point); it is
// that terrain only if all of them agree, otherwise floor.
function pointCell(map: EngineMapData, x: number, y: number, t: number): number {
  const cell = map.cell || 500;
  const ax = Math.floor(x / cell);
  const ay = Math.floor(y / cell);
  const xs = x % cell === 0 ? [ax, ax - 1] : [ax];
  const ys = y % cell === 0 ? [ay, ay - 1] : [ay];
  let first: number | null = null;
  for (const cx of xs) {
    for (const cy of ys) {
      const c = cellAtStep(map, cx, cy, t);
      if (first === null) first = c;
      else if (c !== first) return CellType.FLOOR;
    }
  }
  return first ?? CellType.FLOOR;
}

/** Index of the tick where `seat` went out, or -1 if it never did. */
function deathIndex(ticks: TickSnapshot[], seat: number): number {
  for (let i = 0; i < ticks.length; i++) if (ticks[i].players[seat]?.alive === 0) return i;
  return -1;
}

/**
 * How `seat` went out. Falls with a killer were kicks. Other falls are collapses when the ground was still there when
 * the player got to that spot (it gave way under them, including while stunned), else the player walked or dashed off.
 * A snapshot's `t` is one past the engine step that produced it.
 */
export function deathCause(ticks: TickSnapshot[], seat: number, map: EngineMapData): DeathCause | null {
  const di = deathIndex(ticks, seat);
  if (di < 0) return null;
  const p = ticks[di].players[seat];
  if (p.cause === CauseType.SLASH) return 'melee';
  if (p.cause === CauseType.DART) return 'dart';
  if (p.cause !== CauseType.FALL) return null;
  if (p.killer >= 0) return 'kick';
  let arrived = di; // first tick of the stay at the spot where the player fell
  while (arrived > 0) {
    const q = ticks[arrived - 1].players[seat];
    if (!q || q.x !== p.x || q.y !== p.y) break;
    arrived--;
  }
  const arrivalStep = ticks[arrived].t - 1;
  return pointCell(map, p.x, p.y, arrivalStep - 1) === CellType.PIT ? 'fall' : 'collapse';
}

/** Results of every bot and the human player in a ranked match that ended ([] for other modes or unfinished). */
export function rankedBotResults(config: MatchConfig, ticks: TickSnapshot[], map: EngineMapData): BotResult[] {
  const final = ticks.at(-1);
  if (!isRankedMatchMode(config.matchMode) || !final?.over) return [];
  const deaths = config.slots.map((_, seat) => deathCause(ticks, seat, map));
  const out: BotResult[] = [];
  config.slots.forEach((slot, seat) => {
    const id = slot.kind === 'human' ? HUMAN_RESULT_ID : slot.botId;
    if (!id) return;
    const p = final.players[seat];
    if (!p) return;
    const r = final.winner === seat ? 'w' : final.winner === -1 && p.rank === 1 ? 'd' : 'l';
    const result: BotResult = { b: id, r, rank: p.rank };
    const kills: Partial<Record<KillCause, number>> = {};
    let any = false;
    final.players.forEach((q, other) => {
      const c = deaths[other];
      if (other === seat || !q || q.alive || q.killer !== seat || (c !== 'melee' && c !== 'dart' && c !== 'kick')) return;
      kills[c] = (kills[c] ?? 0) + 1;
      any = true;
    });
    if (any) result.kills = kills;
    if (deaths[seat]) result.death = deaths[seat]!;
    out.push(result);
  });
  return out;
}
