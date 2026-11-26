// Usage: node dist/stats-report.mjs [--days N] [--json]
// Reads the relay's per-match stats (PVP_STATS_DIR, or $STATE_DIRECTORY/stats, default /var/lib/boomerang-pvp/stats).
import { join } from 'node:path';
import { StatsStore, formatReport, summarize } from './stats.ts';

const args = process.argv.slice(2);
const at = args.indexOf('--days');
const days = Math.min(90, Math.max(1, at >= 0 ? Number(args[at + 1]) || 7 : 7));
const dir = process.env.PVP_STATS_DIR ||
  (process.env.STATE_DIRECTORY ? join(process.env.STATE_DIRECTORY.split(':')[0], 'stats') : '/var/lib/boomerang-pvp/stats');

const summary = summarize(await new StatsStore(dir).read(days), days);
console.log(args.includes('--json') ? JSON.stringify(summary, null, 2) : formatReport(summary));
