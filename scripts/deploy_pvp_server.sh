#!/usr/bin/env bash
# Build the PvP relay (server/) and install it on the origin box as the systemd unit boomerang-pvp.
# The origin key lives only on the server in /etc/boomerang-pvp.env (PVP_ORIGIN_KEY=..., same value as the CDN's
# back-to-origin header x-pvp-origin-key); this script never writes it.
#   PVP_SSH_HOST  ssh host alias of the origin (default aliyun_e0)
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
HOST="${PVP_SSH_HOST:-aliyun_e0}"

echo "==> Building relay bundle..."
npm ci --prefix server --silent
npm run build --prefix server --silent

echo "==> Uploading to ${HOST}..."
scp -q server/dist/relay.mjs server/package.json server/package-lock.json server/deploy/boomerang-pvp.service "${HOST}:/tmp/"
ssh "$HOST" 'set -e
id boomerang-pvp >/dev/null 2>&1 || useradd --system --no-create-home --shell /sbin/nologin boomerang-pvp
mkdir -p /opt/boomerang-pvp/dist
install -m 644 /tmp/relay.mjs /opt/boomerang-pvp/dist/relay.mjs
install -m 644 /tmp/package.json /tmp/package-lock.json /opt/boomerang-pvp/
cd /opt/boomerang-pvp && npm ci --omit=dev --registry=https://registry.npmmirror.com --no-audit --no-fund >/dev/null
install -m 644 /tmp/boomerang-pvp.service /etc/systemd/system/boomerang-pvp.service
[ -f /etc/boomerang-pvp.env ] || echo "WARNING: /etc/boomerang-pvp.env missing (PVP_ORIGIN_KEY unset: origin open to direct access)"
rm -f /tmp/relay.mjs /tmp/package.json /tmp/package-lock.json /tmp/boomerang-pvp.service
systemctl daemon-reload
systemctl enable boomerang-pvp >/dev/null 2>&1
systemctl restart boomerang-pvp
sleep 1
systemctl is-active boomerang-pvp
curl -fsS -m 3 http://127.0.0.1:8787/healthz && echo'
echo "==> Relay deployed (note: a restart drops lobby codes and running matches)."
