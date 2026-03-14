#!/bin/sh
# ─────────────────────────────────────────────────
# Arkova Worker — Entrypoint
#
# Manages processes inside the container:
#   1. Express worker (Node.js) — localhost:${PORT}
#   2. cloudflared tunnel daemon (OPTIONAL — outbound-only)
#
# When CLOUDFLARE_TUNNEL_TOKEN is set, both processes run
# and the container uses Zero Trust ingress (INFRA-01).
#
# When the token is absent, Express runs standalone with
# Cloud Run's built-in HTTPS ingress — suitable for
# signet/development deployments.
#
# If EITHER process exits (when both are running), the
# other is killed and the container exits non-zero
# (Cloud Run restarts it).
#
# ADR: docs/confluence/15_zero_trust_edge_architecture.md
# Story: INFRA-01, MVP-01
# ─────────────────────────────────────────────────

set -eu

PORT="${PORT:-3001}"
TUNNEL_ENABLED=false

# ── Check tunnel token ───────────────────────────
if [ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]; then
  TUNNEL_ENABLED=true
  echo "[entrypoint] Cloudflare Tunnel token found — Zero Trust mode."
else
  echo "[entrypoint] No CLOUDFLARE_TUNNEL_TOKEN — running Express standalone."
  echo "[entrypoint] Ingress via Cloud Run HTTPS. Suitable for signet/dev."
fi

# ── Trap: kill all children on exit ──────────────
cleanup() {
  echo "[entrypoint] Shutting down..."
  kill "$NODE_PID" 2>/dev/null || true
  if [ "$TUNNEL_ENABLED" = true ] && [ -n "${TUNNEL_PID:-}" ]; then
    kill "$TUNNEL_PID" 2>/dev/null || true
    wait "$TUNNEL_PID" 2>/dev/null || true
  fi
  wait "$NODE_PID" 2>/dev/null || true
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

# ── 3. Start cloudflared tunnel (if enabled) ─────
if [ "$TUNNEL_ENABLED" = true ]; then
  echo "[entrypoint] Starting cloudflared tunnel..."
  cloudflared tunnel --no-autoupdate run \
    --token "${CLOUDFLARE_TUNNEL_TOKEN}" \
    --url "http://localhost:${PORT}" &
  TUNNEL_PID=$!

  echo "[entrypoint] Both processes running. PID: node=${NODE_PID}, tunnel=${TUNNEL_PID}"

  # Wait for either process to exit — if one dies, kill the other
  wait -n "$NODE_PID" "$TUNNEL_PID" 2>/dev/null
  EXIT_CODE=$?

  echo "[entrypoint] A process exited with code ${EXIT_CODE}. Shutting down."
  exit "${EXIT_CODE}"
else
  echo "[entrypoint] Express-only mode. PID: node=${NODE_PID}"

  # Wait for Express to exit
  wait "$NODE_PID"
  EXIT_CODE=$?

  echo "[entrypoint] Express exited with code ${EXIT_CODE}."
  exit "${EXIT_CODE}"
fi
