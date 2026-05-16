# services/worker/src/infra/

Infrastructure verification tests for the Cloudflare Tunnel sidecar deployment pattern.

## Files

- **tunnel.test.ts** — Static analysis tests verifying Dockerfile, entrypoint.sh, and docker-compose.yml structure for the Zero Trust tunnel sidecar. Checks pinned base image (no mutable `lts` tag), PORT env, non-root user, and compose service wiring. Does not build or run containers.

## Rules

- Tests are read-only file assertions — no container builds or network calls.
- Base image must use a pinned Node version (e.g. `node:20-alpine`), never `node:lts-alpine` (SEC-013).
