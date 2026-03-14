#!/bin/bash
# ─────────────────────────────────────────────────
# Arkova — Cloudflare Tunnel Deployment Script
#
# Creates and configures the Cloudflare Tunnel for
# the worker service. Run ONCE during initial setup.
#
# Prerequisites:
#   1. `cloudflared` installed locally
#   2. `cloudflared login` completed (auth token cached)
#   3. DNS zone `arkova.io` active in Cloudflare
#
# ADR: docs/confluence/15_zero_trust_edge_architecture.md
# Story: INFRA-01
# ─────────────────────────────────────────────────

set -euo pipefail

# ── Configuration ────────────────────────────────
TUNNEL_NAME="arkova-worker"
HOSTNAME_PROD="worker.arkova.io"
HOSTNAME_STAGING="staging-worker.arkova.io"

echo "═══════════════════════════════════════════════"
echo "  Arkova Tunnel Deployment — INFRA-01"
echo "═══════════════════════════════════════════════"
echo ""

# ── Step 1: Create the tunnel ────────────────────
echo "[1/5] Creating Cloudflare Tunnel: ${TUNNEL_NAME}..."
TUNNEL_OUTPUT=$(cloudflared tunnel create "${TUNNEL_NAME}" 2>&1) || {
  if echo "${TUNNEL_OUTPUT}" | grep -q "already exists"; then
    echo "  Tunnel '${TUNNEL_NAME}' already exists. Continuing."
  else
    echo "  ERROR: ${TUNNEL_OUTPUT}"
    exit 1
  fi
}

# Extract Tunnel ID
TUNNEL_ID=$(cloudflared tunnel list --name "${TUNNEL_NAME}" --output json 2>/dev/null | \
  python3 -c "import sys,json; print(json.load(sys.stdin)[0]['id'])" 2>/dev/null || \
  echo "UNKNOWN")

echo "  Tunnel ID: ${TUNNEL_ID}"
echo ""

# ── Step 2: Configure DNS routes ─────────────────
echo "[2/5] Creating DNS CNAME for ${HOSTNAME_PROD}..."
cloudflared tunnel route dns "${TUNNEL_NAME}" "${HOSTNAME_PROD}" 2>&1 || \
  echo "  WARNING: DNS route for ${HOSTNAME_PROD} may have failed. Check Cloudflare dashboard."
echo ""

echo "  Creating DNS CNAME for ${HOSTNAME_STAGING}..."
cloudflared tunnel route dns "${TUNNEL_NAME}" "${HOSTNAME_STAGING}" 2>&1 || \
  echo "  WARNING: DNS route for ${HOSTNAME_STAGING} may have failed. Check Cloudflare dashboard."
echo ""

# ── Step 3: Generate tunnel token ────────────────
echo "[3/5] Generating tunnel token..."
echo ""
echo "  Run this command to get the tunnel token:"
echo ""
echo "    cloudflared tunnel token ${TUNNEL_NAME}"
echo ""
echo "  Then set it in your secrets manager:"
echo ""
echo "    # GCP Secret Manager:"
echo "    echo -n '<TOKEN>' | gcloud secrets create CLOUDFLARE_TUNNEL_TOKEN --data-file=-"
echo ""
echo "    # Local .env (development only):"
echo "    echo 'CLOUDFLARE_TUNNEL_TOKEN=<TOKEN>' >> services/worker/.env"
echo ""

# ── Step 4: Print Access Policy checklist ────────
echo "[4/5] Cloudflare Access Policies — MANUAL SETUP REQUIRED"
echo ""
echo "  Navigate to: https://one.dash.cloudflare.com → Access → Applications"
echo ""
echo "  ┌─────────────────────────────────────────────────────────────────┐"
echo "  │ APPLICATION 1: arkova-worker-prod                              │"
echo "  │ Domain: ${HOSTNAME_PROD}                                       │"
echo "  ├─────────────────────────────────────────────────────────────────┤"
echo "  │ Route             │ Policy Type     │ Rule                     │"
echo "  │───────────────────│─────────────────│──────────────────────────│"
echo "  │ /webhooks/stripe  │ Service Token   │ Stripe service token     │"
echo "  │ /checkout         │ Bypass          │ Browser CORS (public)    │"
echo "  │ /billing-portal   │ Bypass          │ Browser CORS (public)    │"
echo "  │ /health           │ Bypass          │ Public health check      │"
echo "  │ /* (catch-all)    │ Deny            │ Block all other paths    │"
echo "  └─────────────────────────────────────────────────────────────────┘"
echo ""
echo "  ┌─────────────────────────────────────────────────────────────────┐"
echo "  │ APPLICATION 2: arkova-worker-staging                           │"
echo "  │ Domain: ${HOSTNAME_STAGING}                                    │"
echo "  ├─────────────────────────────────────────────────────────────────┤"
echo "  │ Route             │ Policy Type     │ Rule                     │"
echo "  │───────────────────│─────────────────│──────────────────────────│"
echo "  │ /* (all routes)   │ Allow           │ @arkova.io email domain  │"
echo "  │                   │                 │ (requires SSO/email OTP) │"
echo "  └─────────────────────────────────────────────────────────────────┘"
echo ""

# ── Step 5: Verification commands ────────────────
echo "[5/5] Verification Commands"
echo ""
echo "  # Check tunnel status:"
echo "  cloudflared tunnel info ${TUNNEL_NAME}"
echo ""
echo "  # Verify DNS routing:"
echo "  dig CNAME ${HOSTNAME_PROD}"
echo "  dig CNAME ${HOSTNAME_STAGING}"
echo ""
echo "  # Test health endpoint through tunnel:"
echo "  curl -sf https://${HOSTNAME_PROD}/health | jq ."
echo ""
echo "  # Confirm direct IP is unreachable:"
echo "  # (This should TIMEOUT or REFUSE — that's the correct behavior)"
echo "  curl --connect-timeout 5 http://<CONTAINER_IP>:3001/health"
echo ""

echo "═══════════════════════════════════════════════"
echo "  Tunnel ID: ${TUNNEL_ID}"
echo "  Production:  https://${HOSTNAME_PROD}"
echo "  Staging:     https://${HOSTNAME_STAGING}"
echo "═══════════════════════════════════════════════"
echo ""
echo "  NEXT: Configure Access policies in the dashboard (Step 4 above)."
echo "  NEXT: Set CLOUDFLARE_TUNNEL_TOKEN in your secrets manager."
echo ""
