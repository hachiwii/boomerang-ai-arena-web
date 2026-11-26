// Usage: node dist/stats-report.mjs [--days N] [--json]
// Reads the relay's per-match stats (PVP_STATS_DIR, or $STATE_DIRECTORY/stats, default /var/lib/boomerang-pvp/stats).
import { join } from 'node:path';
import { StatsStore, formatReport, summarize } from './stats.ts';
import { formatBots, formatVisitors, readDays } from './analytics.ts';

const args = process.argv.slice(2);
const at = args.indexOf('--days');
const days = Math.min(90, Math.max(1, at >= 0 ? Number(args[at + 1]) || 7 : 7));
const dir = process.env.PVP_STATS_DIR ||
  (process.env.STATE_DIRECTORY ? join(process.env.STATE_DIRECTORY.split(':')[0], 'stats') : '/var/lib/boomerang-pvp/stats');

// Same resolution as the relay: PVP_ANALYTICS_DIR, else <StateDirectory>/analytics, else <PVP_STATS_DIR>/analytics
const analyticsDir = process.env.PVP_ANALYTICS_DIR ||
  (process.env.STATE_DIRECTORY ? join(process.env.STATE_DIRECTORY.split(':')[0], 'analytics')
    : process.env.PVP_STATS_DIR ? join(process.env.PVP_STATS_DIR, 'analytics') : '/var/lib/boomerang-pvp/analytics');

const summary = summarize(await new StatsStore(dir).read(days), days);
const visitors = await readDays(analyticsDir, days);
console.log(args.includes('--json')
  ? JSON.stringify({ visitors, matches: summary }, null, 2)
  : `${formatVisitors(visitors)}\n\n${formatBots(visitors)}\n\n${formatReport(summary)}`);
