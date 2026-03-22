# ─────────────────────────────────────────────────
# Arkova Worker — Multi-Stage Build
#
# Multi-stage build producing a container that runs:
#   1. Express worker (Node.js, port $PORT)
#   2. cloudflared daemon (OPTIONAL — Cloudflare Tunnel sidecar)
#
# Two modes controlled by CLOUDFLARE_TUNNEL_TOKEN env var:
#
#   WITH token:  Zero Trust mode — no ports exposed, all
#                ingress via Cloudflare Tunnel (INFRA-01).
#
#   WITHOUT token: Standalone mode — Express listens on
#                  $PORT, Cloud Run HTTPS handles ingress.
#                  Suitable for signet/dev deployments.
#
# ADR: docs/confluence/15_zero_trust_edge_architecture.md
# Story: INFRA-01, MVP-01
# ESM-only (type: module), Node 20 LTS.
# ─────────────────────────────────────────────────

# ── Stage 1: Build TypeScript ────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies for native modules (bufferutil, utf-8-validate)
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/

RUN npm run build

# ── Stage 2: Production image ────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

# Install curl (needed for health check) + cloudflared (optional tunnel sidecar).
# cloudflared is always installed so the same image supports both modes.
# https://github.com/cloudflare/cloudflared/releases
ARG CLOUDFLARED_VERSION=2024.12.2
RUN apk add --no-cache curl && \
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64" \
      -o /usr/local/bin/cloudflared && \
    chmod +x /usr/local/bin/cloudflared

# Non-root user for security
RUN addgroup --system --gid 1001 arkova && \
    adduser --system --uid 1001 arkova

# Production dependencies only (need build tools for native modules, then remove)
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
RUN apk del python3 make g++

# Compiled output from builder
COPY --from=builder /app/dist ./dist

# Entrypoint script (manages Express + optional tunnel)
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# Switch to non-root user
USER arkova

# Cloud Run injects PORT (typically 8080). Default to 3001 for local dev.
ENV PORT=3001

# Expose port for Cloud Run standalone mode.
# In Zero Trust mode (with tunnel), Cloud Run ignores this — all traffic
# flows through the outbound-only cloudflared tunnel instead.
EXPOSE ${PORT}

# Internal health check — Cloud Run also probes /health via HTTP.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -sf http://localhost:${PORT}/health > /dev/null || exit 1

ENTRYPOINT ["./entrypoint.sh"]
