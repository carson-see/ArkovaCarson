#!/usr/bin/env bash
#
# Deploy services/edge to Cloudflare Workers (edge.arkova.ai).
# Ships the INT-02 MCP verify_batch tool addition.
#
# Prerequisites:
#   1. CLOUDFLARE_API_TOKEN exported with Workers edit permissions.
#   2. Wrangler installed: `npm i -g wrangler` or the script uses `npx`.
#   3. services/edge/wrangler.toml configured with the correct route
#      binding for edge.arkova.ai (already checked in).
#   4. Any secrets referenced by the edge worker are already set via
#      `wrangler secret put` — this script only ships code.
#
# Usage:
#   scripts/deploy-edge-worker.sh              # live deploy
#   scripts/deploy-edge-worker.sh --dry-run    # dry-run wrangler deploy
#
# This is a PRODUCTION deploy to edge.arkova.ai. Cloudflare versions each
# deploy; roll back with `wrangler deployments list` + `wrangler rollback`.

set -euo pipefail

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EDGE_DIR="$REPO_ROOT/services/edge"

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "ERROR: CLOUDFLARE_API_TOKEN is not set"
  echo "Export it with Workers edit permissions before running this script."
  exit 1
fi

cd "$EDGE_DIR"

echo "== Installing edge worker dependencies"
npm install --silent

echo "== Typechecking edge worker"
npx tsc --noEmit

if [[ "$DRY_RUN" == "1" ]]; then
  echo "-- DRY RUN: running wrangler deploy --dry-run"
  npx wrangler deploy --dry-run --outdir=dist
  exit 0
fi

echo "== Deploying to Cloudflare Workers (edge.arkova.ai)"
npx wrangler deploy

echo "== Verifying /.well-known/mcp.json is reachable"
sleep 3
if curl -sf -m 10 https://edge.arkova.ai/.well-known/mcp.json > /dev/null; then
  echo "   OK"
else
  echo "   WARNING: /.well-known/mcp.json did not return 2xx within 10s"
  echo "   Check the deployment via: wrangler deployments list"
fi
