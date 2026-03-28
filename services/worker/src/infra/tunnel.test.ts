/**
 * INFRA-01 — Cloudflare Tunnel Sidecar Infrastructure Tests
 *
 * Verifies that all infrastructure files (Dockerfile, entrypoint.sh,
 * docker-compose.yml) exist and have the correct structure for the
 * Zero Trust tunnel sidecar pattern.
 *
 * These are static analysis tests — they read files and verify content
 * without building or running containers.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WORKER_ROOT = resolve(__dirname, '../..');
const dockerfile = readFileSync(resolve(WORKER_ROOT, 'Dockerfile'), 'utf-8');
const entrypoint = readFileSync(resolve(WORKER_ROOT, 'entrypoint.sh'), 'utf-8');
const compose = readFileSync(resolve(WORKER_ROOT, 'docker-compose.yml'), 'utf-8');

describe('INFRA-01: Dockerfile', () => {
  it('uses node:lts-alpine base image', () => {
    expect(dockerfile).toContain('node:lts-alpine');
  });

  it('exposes PORT via ENV', () => {
    expect(dockerfile).toMatch(/ENV\s+PORT=/);
    expect(dockerfile).toMatch(/EXPOSE\s+/);
  });

  it('starts with node directly (not npm — SIGTERM must reach Node)', () => {
    expect(dockerfile).toMatch(/CMD\s+\["node",.*"dist\/index\.js"\]/);
  });

  it('excludes dev dependencies in production stage', () => {
    // Multi-stage: production stage uses npm ci --omit=dev
    expect(dockerfile).toMatch(/npm ci --omit=dev|npm prune --omit=dev/);
  });

  it('uses multi-stage build (source not in production image)', () => {
    // Multi-stage: only dist/ is copied from builder stage
    expect(dockerfile).toMatch(/COPY --from=builder.*dist/);
  });
});

describe('INFRA-01: entrypoint.sh', () => {
  it('checks for CLOUDFLARE_TUNNEL_TOKEN', () => {
    expect(entrypoint).toContain('CLOUDFLARE_TUNNEL_TOKEN');
    // Verify it conditionally checks the token
    expect(entrypoint).toMatch(/if\s+\[.*CLOUDFLARE_TUNNEL_TOKEN/);
  });

  it('has cleanup trap for graceful shutdown', () => {
    expect(entrypoint).toMatch(/trap\s+cleanup\s+EXIT/);
    // Verify cleanup function kills child processes
    expect(entrypoint).toContain('kill "$NODE_PID"');
  });

  it('starts cloudflared conditionally when token is present', () => {
    expect(entrypoint).toContain('cloudflared tunnel');
    expect(entrypoint).toContain('TUNNEL_ENABLED=true');
    expect(entrypoint).toContain('TUNNEL_ENABLED=false');
  });

  it('handles standalone mode (Express only, no tunnel)', () => {
    // Should have an else branch for no-token case
    expect(entrypoint).toContain('Express-only mode');
    expect(entrypoint).toMatch(/wait\s+"\$NODE_PID"/);
  });

  it('handles dual-process mode (Express + tunnel)', () => {
    expect(entrypoint).toContain('TUNNEL_PID');
    // wait -n waits for first child to exit
    expect(entrypoint).toMatch(/wait\s+-n/);
  });

  it('waits for Express health check before starting tunnel', () => {
    expect(entrypoint).toContain('Waiting for Express health check');
    expect(entrypoint).toMatch(/curl\s+-sf.*\/health/);
    expect(entrypoint).toContain('MAX_RETRIES');
  });

  it('exits non-zero if Express fails to start', () => {
    expect(entrypoint).toContain('FATAL: Express worker failed to start');
    expect(entrypoint).toContain('exit 1');
  });
});

describe('INFRA-01: docker-compose.yml', () => {
  it('defines worker service', () => {
    expect(compose).toMatch(/services:\s*\n\s+worker:/);
  });

  it('defines tunnel service with profile', () => {
    expect(compose).toContain('tunnel:');
    expect(compose).toMatch(/profiles:\s*\n\s+-\s*tunnel/);
  });

  it('tunnel depends on worker health', () => {
    expect(compose).toContain('depends_on:');
    expect(compose).toContain('condition: service_healthy');
  });

  it('worker has healthcheck configuration', () => {
    expect(compose).toContain('healthcheck:');
    expect(compose).toContain('/health');
    expect(compose).toContain('interval:');
    expect(compose).toContain('timeout:');
    expect(compose).toContain('retries:');
  });

  it('uses environment variables — no hardcoded secrets', () => {
    // Secrets should reference env vars with ${}, not contain actual values
    expect(compose).toContain('${SUPABASE_URL}');
    expect(compose).toContain('${SUPABASE_SERVICE_ROLE_KEY}');
    expect(compose).toContain('${STRIPE_SECRET_KEY}');
    expect(compose).toContain('${CLOUDFLARE_TUNNEL_TOKEN}');
    expect(compose).toContain('${API_KEY_HMAC_SECRET}');

    // Must not contain actual secret patterns (base64 strings, sk_live, etc.)
    expect(compose).not.toMatch(/sk_live_\w+/);
    expect(compose).not.toMatch(/sk_test_\w+/);
    expect(compose).not.toMatch(/eyJ[A-Za-z0-9+/=]{20,}/);
  });

  it('tunnel uses official cloudflare/cloudflared image', () => {
    expect(compose).toMatch(/image:\s*cloudflare\/cloudflared/);
  });

  it('worker builds from local Dockerfile', () => {
    expect(compose).toContain('build:');
    expect(compose).toContain('dockerfile: Dockerfile');
  });

  it('worker exposes port with configurable default', () => {
    expect(compose).toMatch(/ports:/);
    expect(compose).toContain('WORKER_PORT:-3001');
  });

  it('sets USE_MOCKS to true by default for local development', () => {
    expect(compose).toMatch(/USE_MOCKS=\$\{USE_MOCKS:-true\}/);
  });

  it('disables production anchoring by default', () => {
    expect(compose).toMatch(
      /ENABLE_PROD_NETWORK_ANCHORING=\$\{ENABLE_PROD_NETWORK_ANCHORING:-false\}/,
    );
  });

  it('configures restart policy for both services', () => {
    // Both worker and tunnel should restart
    const restartMatches = compose.match(/restart:\s*unless-stopped/g);
    expect(restartMatches).not.toBeNull();
    expect(restartMatches!.length).toBeGreaterThanOrEqual(2);
  });
});
