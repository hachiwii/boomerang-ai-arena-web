#!/usr/bin/env bash
# Renew the Let's Encrypt certificate of the PvP relay domain (DNS-01 via Alibaba Cloud DNS) and upload it to the CDN.
# Uses the aliyun CLI's current AK profile for both lego and the CDN upload. Run every ~60 days (certs last 90).
#   PVP_DOMAIN     relay domain; default: the host of VITE_PVP_URL in .env.production.local
#   PVP_LEGO_PATH  lego state dir (account + certs), default ~/.lego-pvp
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$ROOT_DIR/.env.production.local" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env.production.local"
  set +a
fi
DOMAIN="${PVP_DOMAIN:-}"
if [[ -z "$DOMAIN" && -n "${VITE_PVP_URL:-}" ]]; then
  DOMAIN="$(printf '%s' "$VITE_PVP_URL" | sed -E 's#^[a-z]+://([^/:]+).*#\1#')"
fi
if [[ -z "$DOMAIN" ]]; then
  echo "Error: set PVP_DOMAIN or VITE_PVP_URL (in .env.production.local)." >&2
  exit 1
fi
LEGO_PATH="${PVP_LEGO_PATH:-$HOME/.lego-pvp}"

eval "$(python3 - <<'PY'
import json, os, shlex
c = json.load(open(os.path.expanduser('~/.aliyun/config.json')))
p = next(x for x in c['profiles'] if x['name'] == c.get('current', 'default'))
print('export ALICLOUD_ACCESS_KEY=' + shlex.quote(p['access_key_id']))
print('export ALICLOUD_SECRET_KEY=' + shlex.quote(p['access_key_secret']))
PY
)"

echo "==> Renewing ${DOMAIN} (lego, DNS-01 alidns)..."
lego renew --path "$LEGO_PATH" --dns alidns --dns.resolvers 223.5.5.5:53 -d "$DOMAIN" --days 30 || \
  lego run --path "$LEGO_PATH" --dns alidns --dns.resolvers 223.5.5.5:53 -d "$DOMAIN"

CERT="$LEGO_PATH/certificates/${DOMAIN}.crt"
KEY="$LEGO_PATH/certificates/${DOMAIN}.key"
NAME="pvp-le-$(date +%Y%m%d)"
echo "==> Uploading ${NAME} to CDN..."
aliyun cdn SetCdnDomainSSLCertificate --DomainName "$DOMAIN" --CertName "$NAME" --CertType upload \
  --SSLProtocol on --SSLPub "$(cat "$CERT")" --SSLPri "$(cat "$KEY")" >/dev/null
openssl x509 -in "$CERT" -noout -enddate
echo "==> Done."
