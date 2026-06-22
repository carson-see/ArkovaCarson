# Arkova Worker — Cloud Run Build (multi-stage)
# SEC-013: Pin to specific Node version (not mutable lts-alpine tag)
# SEC-014: Run as non-root user

# Stage 1: Build (includes native build tools)
FROM node:20-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
RUN npm run build

# Stage 2: Production (minimal image, non-root)
FROM node:20-alpine
# SEC: refresh OS packages so the shipped image picks up Alpine security
# patches (openssl/libssl3/libcrypto3, etc.) not yet baked into the upstream
# node:20-alpine tag. The container-image CVE gate in deploy-worker.yml
# (Trivy, vuln-type=os, HIGH/CRITICAL fixable) fails the deploy if a fixable
# base-image CVE would otherwise ship to Cloud Run.
RUN apk upgrade --no-cache && apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --ignore-scripts && rm -f .npmrc && npm cache clean --force && apk del python3 make g++
COPY --from=builder /app/dist ./dist

# SCRUM-1922 / SCRUM-900: ship the published public-key registry. The
# did:web (api/did-web.ts) and proof-key (api/proof-keys.ts) routes resolve
# it at runtime as `<dist>/api/../../proof-keys.public.json` → /app/proof-keys.public.json.
# Without this COPY the file is absent in the image and both endpoints 503
# ("No active signing key published") regardless of the registry contents.
# PUBLIC keys only — no private material is ever in this file.
COPY proof-keys.public.json ./

# SEC-014: Non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

# SCRUM-1247 (R0-1): bake the GitHub commit SHA into the image so /health
# can report it. Surfaced via process.env.BUILD_SHA in routes/health.ts +
# api/admin-health.ts. Defaults to "unknown" if the deploy workflow doesn't
# pass --build-arg BUILD_SHA, which makes drift visible immediately.
ARG BUILD_SHA=unknown
ENV BUILD_SHA=${BUILD_SHA}

ENV PORT=3001
EXPOSE 3001
# V8 tuning for Cloud Run (2GB container):
#   --max-old-space-size=1536  — heap ceiling at 1.5GB (leaves 512MB for RSS overhead, native buffers)
#   --max-semi-space-size=64   — double default young-gen (faster GC for short-lived objects like API responses)
#   --optimize-for-size        — prefer smaller compiled code over peak speed (reduces code cache memory)
CMD ["node", "--max-old-space-size=1536", "--max-semi-space-size=64", "--optimize-for-size", "dist/index.js"]
