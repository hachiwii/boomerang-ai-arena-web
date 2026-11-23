#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Load local gitignored deployment config if present
if [[ -f ".env.production.local" ]]; then
  set -a
  # shellcheck disable=SC1091
  source ".env.production.local"
  set +a
fi

BUCKET="${DEPLOY_OSS_BUCKET:-}"
REGION="${DEPLOY_OSS_REGION:-cn-hangzhou}"
DOMAIN="${DEPLOY_DOMAIN:-}"
REFRESH_CDN=1

for arg in "$@"; do
  case "$arg" in
    --no-cdn-refresh) REFRESH_CDN=0 ;;
  esac
done

if [[ -z "$BUCKET" ]]; then
  echo "Error: DEPLOY_OSS_BUCKET is not set. Configure it in .env.production.local or env." >&2
  exit 1
fi

echo "==> Building production bundle (dist/)..."
npm run build

echo "==> Uploading dist/assets/ to oss://${BUCKET}/assets/ (${REGION})..."
aliyun ossutil cp -r -f dist/assets/ "oss://${BUCKET}/assets/" \
  --region "$REGION" \
  --cache-control "public, max-age=2592000"

echo "==> Uploading dist/wasm/**/*.wasm with Content-Type: application/wasm..."
aliyun ossutil cp -r -f dist/wasm/ "oss://${BUCKET}/wasm/" \
  --region "$REGION" \
  --include "*.wasm" \
  --content-type "application/wasm" \
  --cache-control "public, max-age=2592000"

echo "==> Uploading dist/wasm/**/*.js with Content-Type: application/javascript..."
aliyun ossutil cp -r -f dist/wasm/ "oss://${BUCKET}/wasm/" \
  --region "$REGION" \
  --include "*.js" \
  --content-type "application/javascript; charset=utf-8" \
  --cache-control "public, max-age=2592000"

echo "==> Uploading dist/index.html with Cache-Control: no-cache..."
aliyun ossutil cp -f dist/index.html "oss://${BUCKET}/index.html" \
  --region "$REGION" \
  --content-type "text/html; charset=utf-8" \
  --cache-control "no-cache"

if [[ "$REFRESH_CDN" == "1" && -n "$DOMAIN" ]]; then
  echo "==> Refreshing CDN cache for https://${DOMAIN}/ and /index.html..."
  aliyun cdn RefreshObjectCaches \
    --ObjectPath "$(printf 'https://%s/\nhttps://%s/index.html' "$DOMAIN" "$DOMAIN")" \
    --ObjectType File >/dev/null
  echo "    CDN refresh submitted."
fi

echo "==> Deploy complete!"
