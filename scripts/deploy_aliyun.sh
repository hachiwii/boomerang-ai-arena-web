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

# The in-browser C++ compiler (@yowasp/clang: assets/llvm*-<hash>.{wasm,tar}, ~100 MB) never changes for a given
# content hash: skip each file that is already in the bucket with the same size.
SKIP_ARGS=()
for f in dist/assets/llvm*; do
  [[ -f "$f" ]] || continue
  name="$(basename "$f")"
  local_size="$(stat -f %z "$f" 2>/dev/null || stat -c %s "$f")"
  remote_size="$(aliyun ossutil stat "oss://${BUCKET}/assets/${name}" --region "$REGION" 2>/dev/null \
    | awk -F': *' '/^Content-Length/ {print $2}' | tr -d '[:space:]')"
  if [[ "$remote_size" == "$local_size" ]]; then
    SKIP_ARGS+=(--exclude "$name")
    echo "    skip (already in bucket): assets/${name}"
  fi
done

echo "==> Uploading dist/assets/ to oss://${BUCKET}/assets/ (${REGION})..."
aliyun ossutil cp -r -f dist/assets/ "oss://${BUCKET}/assets/" \
  --region "$REGION" \
  ${SKIP_ARGS[@]+"${SKIP_ARGS[@]}"} \
  --exclude "*.wasm" \
  --cache-control "public, max-age=2592000"

# In-browser C++ compiler for custom bots (@yowasp/clang, ~100 MB, fetched on a player's first compile only):
# WebAssembly.compileStreaming requires Content-Type: application/wasm
echo "==> Uploading dist/assets/*.wasm with Content-Type: application/wasm..."
aliyun ossutil cp -r -f dist/assets/ "oss://${BUCKET}/assets/" \
  --region "$REGION" \
  ${SKIP_ARGS[@]+"${SKIP_ARGS[@]}"} \
  --include "*.wasm" \
  --content-type "application/wasm" \
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

if [[ -f "dist/manifest.webmanifest" ]]; then
  echo "==> Uploading dist/manifest.webmanifest..."
  aliyun ossutil cp -f dist/manifest.webmanifest "oss://${BUCKET}/manifest.webmanifest" \
    --region "$REGION" \
    --content-type "application/manifest+json; charset=utf-8" \
    --cache-control "no-cache"
fi

if [[ -f "dist/icon.svg" ]]; then
  echo "==> Uploading dist/icon.svg..."
  aliyun ossutil cp -f dist/icon.svg "oss://${BUCKET}/icon.svg" \
    --region "$REGION" \
    --content-type "image/svg+xml" \
    --cache-control "public, max-age=86400"
fi

if [[ "$REFRESH_CDN" == "1" && -n "$DOMAIN" ]]; then
  echo "==> Refreshing CDN cache for https://${DOMAIN}/, /index.html, /manifest.webmanifest, /icon.svg..."
  aliyun cdn RefreshObjectCaches \
    --ObjectPath "$(printf 'https://%s/\nhttps://%s/index.html\nhttps://%s/manifest.webmanifest\nhttps://%s/icon.svg' "$DOMAIN" "$DOMAIN" "$DOMAIN" "$DOMAIN")" \
    --ObjectType File >/dev/null
  echo "    CDN refresh submitted."
fi

echo "==> Deploy complete!"
