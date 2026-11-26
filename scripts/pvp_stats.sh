#!/usr/bin/env bash
# Print the PvP relay's latency report from the origin box.
#   scripts/pvp_stats.sh [days] [--json]      (default 7 days)
#   PVP_SSH_HOST  ssh host alias of the origin (env or .env.production.local)
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$ROOT_DIR/.env.production.local" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env.production.local"
  set +a
fi
HOST="${PVP_SSH_HOST:-}"
[[ -n "$HOST" ]] || { echo "Error: PVP_SSH_HOST is not set." >&2; exit 1; }
DAYS="${1:-7}"
EXTRA="${2:-}"
ssh "$HOST" "node /opt/boomerang-pvp/dist/stats-report.mjs --days $(printf '%d' "$DAYS") $EXTRA"
