#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Load local gitignored Cloudflare deployment config if present
if [[ -f ".env.cloudflare.local" ]]; then
  set -a
  # shellcheck disable=SC1091
  source ".env.cloudflare.local"
  set +a
fi

BUCKET="${CF_R2_BUCKET:-}"
DOMAIN="${CF_DOMAIN:-}"
JOBS="${CF_UPLOAD_JOBS:-6}"
FORCE_ALL=0
SKIP_BUILD=0
MARK_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --all|--force-all) FORCE_ALL=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --mark-uploaded) MARK_ONLY=1; SKIP_BUILD=1 ;;
    --jobs=*) JOBS="${arg#*=}" ;;
    *)
      echo "Unknown option: $arg" >&2
      echo "Usage: $0 [--all] [--skip-build] [--jobs=N] [--mark-uploaded]" >&2
      echo "  --all            ignore the upload cache and re-upload every file" >&2
      echo "  --mark-uploaded  record the current dist/ as live in the upload cache, upload nothing" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$BUCKET" ]]; then
  echo "Error: CF_R2_BUCKET is not set. Configure it in .env.cloudflare.local or env." >&2
  exit 1
fi

if ! command -v wrangler >/dev/null 2>&1; then
  echo "Error: wrangler CLI is not installed or not in PATH." >&2
  exit 1
fi

if [[ "$SKIP_BUILD" == "0" ]]; then
  echo "==> Typechecking & building Cloudflare bundle (dist/, without ICP footer, PvP off)..."
  npx tsc --noEmit
  # --mode cloudflare skips .env.production.local (which holds Aliyun/ICP/PvP settings); the mirror never shows PvP
  NODE_ENV=production VITE_ICP_NUMBER="" VITE_PVP_ENABLED=0 VITE_PVP_URL="" npx vite build --mode cloudflare
fi

if [[ ! -f "dist/index.html" ]]; then
  echo "Error: dist/index.html not found. Run without --skip-build first." >&2
  exit 1
fi

echo "==> Uploading dist/ to Cloudflare R2 bucket '${BUCKET}' (concurrency=${JOBS})..."
# Local record of what is already in the bucket (key -> sha256 + headers): unchanged files are never re-sent.
# The in-browser C++ compiler alone is ~100 MB and only changes when @yowasp/clang is upgraded.
CACHE_FILE="$ROOT_DIR/.deploy-cache/cloudflare-r2.json"
mkdir -p "$(dirname "$CACHE_FILE")"

CF_R2_BUCKET="$BUCKET" CF_DOMAIN="$DOMAIN" CF_UPLOAD_JOBS="$JOBS" CF_FORCE_ALL="$FORCE_ALL" CF_CACHE_FILE="$CACHE_FILE" \
CF_MARK_ONLY="$MARK_ONLY" node --input-type=module <<'EOF'
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const bucket = process.env.CF_R2_BUCKET;
const domain = (process.env.CF_DOMAIN || '').trim();
const jobs = Math.max(1, Number.parseInt(process.env.CF_UPLOAD_JOBS || '6', 10) || 6);
const forceAll = process.env.CF_FORCE_ALL === '1';
const markOnly = process.env.CF_MARK_ONLY === '1';
const cacheFile = process.env.CF_CACHE_FILE;
let cache = { bucket, files: {} };
try {
  const loaded = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  if (loaded && loaded.bucket === bucket && loaded.files) cache = loaded;
} catch {}
function saveCache() {
  const tmp = `${cacheFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 1));
  fs.renameSync(tmp, cacheFile);
}
function fingerprint(fileObj, contentType, cacheControl) {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(fileObj.abs)).digest('hex');
  return `${hash}|${contentType}|${cacheControl}`;
}
const distDir = path.resolve('dist');

const MIME_TYPES = {
  '.wasm': 'application/wasm',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.tar': 'application/x-tar',
};

function getContentType(key) {
  const ext = path.extname(key).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function getCacheControl(key) {
  if (key === 'index.html' || key === 'manifest.webmanifest') return 'no-cache';
  if (key === 'icon.svg') return 'public, max-age=86400';
  return 'public, max-age=2592000';
}

function walkFiles(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...walkFiles(abs, rel));
    } else if (entry.isFile()) {
      out.push({ key: rel, abs, size: fs.statSync(abs).size });
    }
  }
  return out;
}

function isSkippableLargeHashedAsset(key) {
  // Immutable Vite content-hashed clang compiler assets (~100 MB total)
  return /^assets\/llvm[^/]+-[A-Za-z0-9_-]{8}\.(wasm|tar)$/.test(key);
}

async function alreadyLiveWithMatchingSize(key, expectedSize, expectedContentType) {
  if (!domain || forceAll || !isSkippableLargeHashedAsset(key)) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const resp = await fetch(`https://${domain}/${key}`, {
      method: 'HEAD',
      headers: { 'Accept-Encoding': 'identity' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (resp.status !== 200) return false;
    const cl = Number.parseInt(resp.headers.get('content-length') || '', 10);
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    const baseCt = expectedContentType.split(';')[0].trim().toLowerCase();
    return cl === expectedSize && ct.includes(baseCt);
  } catch {
    return false;
  }
}

function runWranglerPut(fileObj, contentType, cacheControl) {
  return new Promise((resolve, reject) => {
    const args = [
      'r2', 'object', 'put',
      `${bucket}/${fileObj.key}`,
      '--file', fileObj.abs,
      '--remote',
      '--content-type', contentType,
      '--cache-control', cacheControl,
      '--force',
    ];
    const child = spawn('wrangler', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`wrangler exited ${code} for ${fileObj.key}:\n${stderr || stdout}`));
    });
  });
}

async function uploadWithRetry(fileObj) {
  const ct = getContentType(fileObj.key);
  const cc = getCacheControl(fileObj.key);
  const fp = fingerprint(fileObj, ct, cc);
  if (markOnly) {
    cache.files[fileObj.key] = fp;
    return { skipped: true, reason: 'marked' };
  }
  if (!forceAll && cache.files[fileObj.key] === fp) {
    return { skipped: true, reason: 'unchanged' };
  }
  if (await alreadyLiveWithMatchingSize(fileObj.key, fileObj.size, ct)) {
    cache.files[fileObj.key] = fp;
    saveCache();
    return { skipped: true, reason: 'already live' };
  }
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await runWranglerPut(fileObj, ct, cc);
      cache.files[fileObj.key] = fp;
      saveCache();
      return { skipped: false };
    } catch (err) {
      lastErr = err;
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, attempt * 1500));
      }
    }
  }
  throw lastErr;
}

const allFiles = walkFiles(distDir).sort((a, b) => a.key.localeCompare(b.key));
const entryKeys = new Set(['manifest.webmanifest', 'index.html']);
const assetFiles = allFiles.filter((f) => !entryKeys.has(f.key));
// Upload large files first so workers stay busy until the end
assetFiles.sort((a, b) => b.size - a.size);
const entryFiles = ['manifest.webmanifest', 'index.html']
  .map((k) => allFiles.find((f) => f.key === k))
  .filter(Boolean);

const total = assetFiles.length + entryFiles.length;
let done = 0;
let skipped = 0;
let uploaded = 0;

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

let cursor = 0;
let failedErr = null;

async function worker() {
  while (!failedErr) {
    const idx = cursor++;
    if (idx >= assetFiles.length) return;
    const f = assetFiles[idx];
    try {
      const res = await uploadWithRetry(f);
      done++;
      if (res.skipped) {
        skipped++;
        if (res.reason !== 'unchanged' || f.size >= 1024 * 1024) {
          console.log(`  [${done}/${total}] skip (${res.reason}): ${f.key} (${formatSize(f.size)})`);
        }
      } else {
        uploaded++;
        if (f.size >= 1024 * 1024 || done % 15 === 0 || done === assetFiles.length) {
          console.log(`  [${done}/${total}] uploaded: ${f.key} (${formatSize(f.size)})`);
        }
      }
    } catch (err) {
      failedErr = err;
      return;
    }
  }
}

await Promise.all(Array.from({ length: Math.min(jobs, assetFiles.length) }, () => worker()));
if (failedErr) {
  console.error(failedErr.message || failedErr);
  process.exit(1);
}

// Upload entry files last so visitors never see new HTML referencing unuploaded assets
for (const f of entryFiles) {
  const res = await uploadWithRetry(f);
  done++;
  if (res.skipped) skipped++;
  else uploaded++;
  console.log(`  [${done}/${total}] ${res.skipped ? `skip (${res.reason})` : 'uploaded'} (entry): ${f.key} (${formatSize(f.size)})`);
}
saveCache();

console.log(`==> R2 upload finished: ${uploaded} uploaded, ${skipped} skipped.`);
EOF

if [[ -n "$DOMAIN" ]]; then
  echo "==> Live URL: https://${DOMAIN}/"
fi
echo "==> Deploy complete!"
