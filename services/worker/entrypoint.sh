#!/bin/sh
# ─────────────────────────────────────────────────
# Arkova Worker — Zero Trust Entrypoint
#
# Manages two processes inside the container:
#   1. Express worker (Node.js) — localhost:${PORT}
#   2. cloudflared tunnel daemon — outbound-only
#
# If EITHER process exits, the other is killed and
# the container exits non-zero (Cloud Run restarts it).
#
# ADR: docs/confluence/15_zero_trust_edge_architecture.md
# Story: INFRA-01
# ─────────────────────────────────────────────────

set -eu

PORT="${PORT:-3001}"

# ── Validate tunnel token ────────────────────────
if [ -z "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]; then
  echo "FATAL: CLOUDFLARE_TUNNEL_TOKEN is not set."
  echo "The worker cannot start without a tunnel token."
  echo "See: docs/confluence/15_zero_trust_edge_architecture.md"
  exit 1
fi

# ── Trap: kill all children on exit ──────────────
cleanup() {
  echo "[entrypoint] Shutting down..."
  kill "$NODE_PID" "$TUNNEL_PID" 2>/dev/null || true
  wait "$NODE_PID" "$TUNNEL_PID" 2>/dev/null || true
  echo "[entrypoint] All processes stopped."
}
trap cleanup EXIT INT TERM

# ── 1. Start Express worker ──────────────────────
echo "[entrypoint] Starting Express worker on localhost:${PORT}..."
node dist/index.js &
NODE_PID=$!

# ── 2. Wait for Express to be ready ──────────────
echo "[entrypoint] Waiting for Express health check..."
RETRIES=0
MAX_RETRIES=30
until curl -sf "http://localhost:${PORT}/health" > /dev/null 2>&1; do
  RETRIES=$((RETRIES + 1))
  if [ "$RETRIES" -ge "$MAX_RETRIES" ]; then
    echo "FATAL: Express worker failed to start after ${MAX_RETRIES}s"
    exit 1
  fi
  sleep 1
done
echo "[entrypoint] Express worker is healthy."

# ── 3. Start cloudflared tunnel ──────────────────
echo "[entrypoint] Starting cloudflared tunnel..."
cloudflared tunnel --no-autoupdate run \
  --token "${CLOUDFLARE_TUNNEL_TOKEN}" \
  --url "http://localhost:${PORT}" &
TUNNEL_PID=$!

echo "[entrypoint] Both processes running. PID: node=${NODE_PID}, tunnel=${TUNNEL_PID}"

# ── 4. Wait for either process to exit ───────────
# If one dies, we kill the other and exit non-zero
# so the orchestrator (Cloud Run / Docker) restarts.
wait -n "$NODE_PID" "$TUNNEL_PID" 2>/dev/null
EXIT_CODE=$?

echo "[entrypoint] A process exited with code ${EXIT_CODE}. Shutting down."
exit "${EXIT_CODE}"
