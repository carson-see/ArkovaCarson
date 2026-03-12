# ─────────────────────────────────────────────────
# Arkova Worker — Multi-stage Docker Build
#
# Builds the Express worker service for production.
# ESM-only (type: module), Node 20 LTS.
# ─────────────────────────────────────────────────

# Stage 1: Install dependencies + build TypeScript
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first for layer caching
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies for tsc)
RUN npm ci

# Copy source code
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript → dist/
RUN npm run build

# Stage 2: Production image
FROM node:20-alpine AS runner

WORKDIR /app

# Non-root user for security
RUN addgroup --system --gid 1001 arkova && \
    adduser --system --uid 1001 arkova

# Copy package files and install production-only deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist

# Switch to non-root user
USER arkova

# Default port (override with PORT env var)
ENV PORT=3001
EXPOSE 3001

# Health check (worker exposes /health on its Express server)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

CMD ["node", "dist/index.js"]
