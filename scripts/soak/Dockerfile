# scripts/soak/Dockerfile — standalone image for the 72h-soak load generator
# (SCRUM-2980). Independent of services/worker's Dockerfile/build — this
# image has zero runtime dependencies beyond Node's built-ins.
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
# `npm ci` (not `npm install`) — installs exactly the resolved versions
# pinned in package-lock.json instead of re-resolving semver ranges, so a
# rebuild can't silently pull in a newer, unreviewed transitive dependency
# (SonarCloud docker:S8543).
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY loadgen.ts loadgen-server.ts ./
RUN npm run build

FROM node:20-alpine
RUN apk upgrade --no-cache
WORKDIR /app
COPY --from=builder /app/dist ./dist
ENV PORT=8080
EXPOSE 8080
# SCRUM-4988 (Checkov CKV_DOCKER_2): loadgen-server answers 200 JSON on every
# path, so /status doubles as the liveness probe. busybox wget ships in alpine.
# Shell form, so ${PORT} is expanded in the CONTAINER at probe time: the server
# binds process.env.PORT (loadgen-server.ts) and Cloud Run injects that var, so
# a hardcoded 8080 would probe the wrong port whenever PORT is overridden.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-8080}/status" >/dev/null || exit 1
USER node
CMD ["node", "dist/loadgen-server.js"]
