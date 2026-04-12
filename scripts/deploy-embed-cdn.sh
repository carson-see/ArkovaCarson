#!/usr/bin/env bash
#
# Deploy @arkova/embed bundle to cdn.arkova.ai (INT-03 / SCRUM-644).
#
# Prerequisites:
#   1. A Cloudflare R2 bucket named `arkova-embed` (or set $R2_BUCKET)
#      provisioned in your Cloudflare dashboard.
#   2. A custom domain `cdn.arkova.ai` CNAMEd to the R2 bucket's public URL
#      (or proxied via a Cloudflare Worker).
#   3. CLOUDFLARE_API_TOKEN exported with R2 write permissions.
#   4. wrangler installed: `npm i -g wrangler` or `npx wrangler` below.
#
# Usage:
#   scripts/deploy-embed-cdn.sh               # live upload
#   scripts/deploy-embed-cdn.sh --dry-run     # build + size report only
#
# The script builds the embed bundle, verifies the gzipped size is under the
# 15 KB budget (Story INT-03 acceptance criteria), and uploads the IIFE,
# UMD, and ES bundles + source maps to R2 under a versioned path plus a
# `latest/` alias.

set -euo pipefail

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG_DIR="$REPO_ROOT/packages/embed"
R2_BUCKET="${R2_BUCKET:-arkova-embed}"
SIZE_BUDGET_GZIPPED=15360  # 15 KB

cd "$PKG_DIR"

echo "== Building @arkova/embed"
npm install --silent
npx vite build

echo "== Verifying bundle sizes (budget: ${SIZE_BUDGET_GZIPPED} bytes gzipped)"
for bundle in dist/embed.iife.js dist/embed.umd.js dist/embed.es.js; do
  if [[ ! -f "$bundle" ]]; then
    echo "  ERROR: $bundle not produced by vite build" >&2
    exit 1
  fi
  raw=$(wc -c < "$bundle" | tr -d ' ')
  gzipped=$(gzip -c "$bundle" | wc -c | tr -d ' ')
  if [[ "$gzipped" -gt "$SIZE_BUDGET_GZIPPED" ]]; then
    echo "  ERROR: $bundle is ${gzipped}B gzipped — over ${SIZE_BUDGET_GZIPPED}B budget" >&2
    exit 1
  fi
  printf "  OK  %-24s raw=%6dB  gzipped=%6dB\n" "$bundle" "$raw" "$gzipped"
done

VERSION="$(node -p "require('./package.json').version")"
echo "== Package version: $VERSION"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "-- DRY RUN: skipping upload"
  exit 0
fi

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "ERROR: CLOUDFLARE_API_TOKEN is not set" >&2
  exit 1
fi

echo "== Uploading to R2 bucket: $R2_BUCKET"
for bundle in dist/embed.iife.js dist/embed.umd.js dist/embed.es.js dist/embed.iife.js.map dist/embed.umd.js.map dist/embed.es.js.map; do
  name="$(basename "$bundle")"
  # Versioned path — immutable
  npx wrangler r2 object put "$R2_BUCKET/v$VERSION/$name" \
    --file "$bundle" \
    --content-type "application/javascript; charset=utf-8" \
    --cache-control "public, max-age=31536000, immutable"
  # Latest alias — short cache
  npx wrangler r2 object put "$R2_BUCKET/latest/$name" \
    --file "$bundle" \
    --content-type "application/javascript; charset=utf-8" \
    --cache-control "public, max-age=300"
done

echo "== Done. Bundle available at:"
echo "   https://cdn.arkova.ai/v$VERSION/embed.iife.js"
echo "   https://cdn.arkova.ai/latest/embed.iife.js"
