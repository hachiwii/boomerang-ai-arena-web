#!/usr/bin/env bash
# Renew the Let's Encrypt certificate of the PvP relay domain (DNS-01 via Alibaba Cloud DNS) and upload it to the CDN.
# Uses the aliyun CLI's current AK profile for both lego and the CDN upload. Run every ~60 days (certs last 90).
#   PVP_DOMAIN     default pvp.biao.oinkvm.cn
#   PVP_LEGO_PATH  lego state dir (account + certs), default ~/.lego-pvp
set -euo pipefail
DOMAIN="${PVP_DOMAIN:-pvp.biao.oinkvm.cn}"
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
