// Public site stats from the relay (GET /public-stats, server/analytics.ts publicStats) for the lobby's 全球统计 panel.
import { relayHttpUrl } from './pvpConfig';

export const PUBLIC_MODES = ['ranked-solo', 'ranked-ffa', 'cricket', 'custom', 'pvp'] as const;
export type PublicMode = (typeof PUBLIC_MODES)[number];
export const KILL_CAUSES = ['melee', 'dart', 'kick'] as const;
export const DEATH_CAUSES = ['melee', 'dart', 'kick', 'fall', 'collapse'] as const;
export type KillCause = (typeof KILL_CAUSES)[number];
export type DeathCause = (typeof DEATH_CAUSES)[number];

export interface BotTally {
  w: number;
  d: number;
  l: number;
  kills: Partial<Record<KillCause, number>>;
  deaths: Partial<Record<DeathCause, number>>;
}

export interface PublicStats {
  since: string; // YYYY-MM-DD (UTC+8)
  updatedAt: string;
  online: number;
  total: Record<PublicMode, number>; // matches started
  last24h: { from: string; to: string; modes: Record<PublicMode, number> }; // current hour + the 23 before it
  bots: Record<'ranked-solo' | 'ranked-ffa', Record<string, BotTally>>;
}

/** The panel only exists where the page has a relay (not on the PvP-off mirror build). */
export function publicStatsAvailable(): boolean {
  return relayHttpUrl('/public-stats') !== null;
}

export async function fetchPublicStats(signal?: AbortSignal): Promise<PublicStats> {
  const url = relayHttpUrl('/public-stats');
  if (!url) throw new Error('no relay');
  const res = await fetch(url, { credentials: 'omit', cache: 'no-cache', signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as PublicStats;
}

export const sumModes = (m: Record<PublicMode, number>) => PUBLIC_MODES.reduce((a, k) => a + (m[k] ?? 0), 0);

const UNITS: [number, string][] = [[1e4, '万'], [1e8, '亿'], [1e12, '万亿']];

/** Counts on the panel: up to 10000 as is (1,234); above that 4 significant digits in 万 / 亿 / 万亿 (1.235万, 12.35万). */
export function formatCount(n: number): string {
  if (!(n > 10_000)) return n.toLocaleString('zh-CN');
  // Round the integer itself (half up): 12345 / 10 = 1234.5 is exact, 1.2345 as a double is not
  const scale = 10 ** (Math.floor(Math.log10(n)) - 3);
  const r = Math.round(n / scale) * scale;
  let i = UNITS.length - 1;
  while (i > 0 && r < UNITS[i][0]) i--;
  const [size, unit] = UNITS[i];
  const v = r / size;
  return `${v.toFixed(Math.max(0, 3 - Math.floor(Math.log10(v) + 1e-9)))}${unit}`;
}
