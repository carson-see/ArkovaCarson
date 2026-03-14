# ─────────────────────────────────────────────────
# Arkova Worker — Zero Trust Multi-Process Build
#
# Multi-stage build producing a container that runs:
#   1. Express worker (Node.js, localhost:3001)
#   2. cloudflared daemon (Cloudflare Tunnel sidecar)
#
# NO ports are exposed. All ingress flows through the
# Cloudflare Tunnel. Direct IP/port access is impossible.
#
# ADR: docs/confluence/15_zero_trust_edge_architecture.md
# Story: INFRA-01
# ESM-only (type: module), Node 20 LTS.
# ─────────────────────────────────────────────────

# ── Stage 1: Build TypeScript ────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ── Stage 2: Production image ────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

# Install cloudflared — pinned version for reproducibility
# https://github.com/cloudflare/cloudflared/releases
ARG CLOUDFLARED_VERSION=2024.12.2
RUN apk add --no-cache curl && \
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64" \
      -o /usr/local/bin/cloudflared && \
    chmod +x /usr/local/bin/cloudflared

# Non-root user for security
RUN addgroup --system --gid 1001 arkova && \
    adduser --system --uid 1001 arkova

# Production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled output from builder
COPY --from=builder /app/dist ./dist

# Entrypoint script (manages both processes)
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# Switch to non-root user
USER arkova

# Express listens on localhost only — NOT exposed externally.
# All traffic enters through the Cloudflare Tunnel.
ENV PORT=3001

# ── NO EXPOSE — Zero Trust architecture ──────────
# The container has no public ports. cloudflared creates
# an outbound-only tunnel to Cloudflare's edge network.
# Direct IP:port access to this container is impossible.

# Internal health check — runs inside the container only.
# Cloud Run / Docker health probes use this; external
# clients cannot reach it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -sf http://localhost:${PORT}/health > /dev/null || exit 1

ENTRYPOINT ["./entrypoint.sh"]
