import type { PvpNetStats } from '../net/pvpTypes';

export type RttLevel = 'none' | 'good' | 'ok' | 'bad' | 'poor';

/** Colour level for a round trip to the PvP server (lobby latency pill and the in-game perf line). */
export function pvpRttLevel(rttMs: number | null | undefined): RttLevel {
  if (rttMs === null || rttMs === undefined || !Number.isFinite(rttMs)) return 'none';
  if (rttMs <= 80) return 'good';
  if (rttMs <= 150) return 'ok';
  if (rttMs <= 250) return 'bad';
  return 'poor';
}

/** Rounded RTT in ms, or null when unknown. */
export function pvpRttMs(stats: PvpNetStats | null | undefined): number | null {
  const v = stats?.rttMs;
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : null;
}

/** Tooltip with everything the stats carry (jitter, input delay, latest rollback, transport). */
export function pvpNetDetail(stats: PvpNetStats | null | undefined): string {
  const rtt = pvpRttMs(stats);
  const parts = [`与服务器往返延迟 ${rtt === null ? '--' : `${rtt}ms`}`];
  if (stats && typeof stats.jitterMs === 'number') parts.push(`抖动 ${Math.round(stats.jitterMs)}ms`);
  if (stats && typeof stats.inputDelayFrames === 'number') parts.push(`输入延迟 ${stats.inputDelayFrames} 帧`);
  if (stats && typeof stats.rollbackFrames === 'number') parts.push(`最近回滚 ${stats.rollbackFrames} 帧`);
  if (stats?.transport) parts.push(stats.transport === 'ws' ? 'WebSocket' : 'WebRTC');
  return parts.join(' · ');
}
