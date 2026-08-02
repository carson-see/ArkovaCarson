/**
 * SCRUM-2653 — gate `/health?detailed=true` behind a worker-side token.
 *
 * TDD: these tests were written and seen RED before `isDetailedHealthAuthorized`
 * existed.
 *
 * Threat: the detailed health view is an unauthenticated information-disclosure
 * surface. Verified live against production on 2026-08-01 (plain `curl`, no
 * credentials) — it returned `git_sha`, `network: mainnet`, `kms.provider: gcp`
 * (which signing backend is live), every `info.*` feature flag, the anchoring
 * backlog depth, and `connection.url` containing the production Supabase project
 * ref. None of that is needed by a liveness probe.
 *
 * Constitution refs:
 *   - 1.9: `/api/health` always available — so PLAIN liveness must stay public
 *     and unauthenticated. Only the `detailed=true` enrichment is gated.
 *   - 1.4: no secrets in responses; fail closed in production.
 */

import { describe, it, expect, vi } from 'vitest';
import { buildHealthResponse, isDetailedHealthAuthorized, type HealthCheckDeps } from './health.js';

const TOKEN = 'a'.repeat(32);

function createMockDeps(): HealthCheckDeps {
  return {
    isDbHealthy: () => true,
    dbQuery: async () => ({ data: [{ id: '1' }], error: null }),
    recordDbSuccess: vi.fn(),
    recordDbFailure: vi.fn(),
    getDbCircuitState: () => ({ healthy: true, consecutiveFailures: 0, lastError: null }),
    getConnectionInfo: () => ({ mode: 'direct' as const, url: 'https://vzwyaatejekddvltxyye.supabase.co' }),
    config: {
      bitcoinNetwork: 'mainnet' as const,
      stripeSecretKey: 'sk_test',
      sentryDsn: 'https://sentry.io/123',
      geminiApiKey: 'key',
      aiProvider: 'gemini',
      kmsProvider: 'gcp',
      gcpKmsKeyResourceName: 'projects/p/locations/l/keyRings/r/cryptoKeys/k',
      bitcoinTreasuryWif: 'wif_test',
      enableProdNetworkAnchoring: true,
    },
    getLastSecuredAnchor: async () => ({ data: [{ created_at: '2026-08-01T00:00:00Z' }], error: null }),
    getLastBatchAnchor: async () => ({ data: [{ updated_at: '2026-08-01T01:00:00Z' }], error: null }),
    getPendingAnchorCount: async () => ({ count: 42, error: null }),
    getCurrentFeeRate: async () => 3,
  };
}

describe('isDetailedHealthAuthorized', () => {
  describe('when a token is configured', () => {
    it('authorizes an exact match', () => {
      expect(
        isDetailedHealthAuthorized({
          providedToken: TOKEN,
          expectedToken: TOKEN,
          isProduction: true,
        }),
      ).toBe(true);
    });

    it('denies a wrong token of the same length', () => {
      expect(
        isDetailedHealthAuthorized({
          providedToken: 'b'.repeat(32),
          expectedToken: TOKEN,
          isProduction: true,
        }),
      ).toBe(false);
    });

    it('denies a token of a different length (no timing-safe length crash)', () => {
      expect(
        isDetailedHealthAuthorized({
          providedToken: 'short',
          expectedToken: TOKEN,
          isProduction: true,
        }),
      ).toBe(false);
    });

    it('denies a missing token', () => {
      expect(
        isDetailedHealthAuthorized({
          providedToken: undefined,
          expectedToken: TOKEN,
          isProduction: true,
        }),
      ).toBe(false);
    });

    it('denies an empty token', () => {
      expect(
        isDetailedHealthAuthorized({
          providedToken: '',
          expectedToken: TOKEN,
          isProduction: true,
        }),
      ).toBe(false);
    });

    it('denies a token that is a prefix of the expected token', () => {
      expect(
        isDetailedHealthAuthorized({
          providedToken: TOKEN.slice(0, 16),
          expectedToken: TOKEN,
          isProduction: true,
        }),
      ).toBe(false);
    });

    it('requires the token even outside production', () => {
      // Once an operator configures a token, it is enforced everywhere —
      // otherwise a rig running with NODE_ENV!=production would silently
      // ignore a configured secret.
      expect(
        isDetailedHealthAuthorized({
          providedToken: 'wrong',
          expectedToken: TOKEN,
          isProduction: false,
        }),
      ).toBe(false);
    });
  });

  describe('when no token is configured', () => {
    it('FAILS CLOSED in production', () => {
      // The security-critical case: a prod deploy that never got the secret
      // must not fall back to serving detail to anonymous callers.
      expect(
        isDetailedHealthAuthorized({
          providedToken: undefined,
          expectedToken: undefined,
          isProduction: true,
        }),
      ).toBe(false);
    });

    it('still fails closed in production even if the caller sends something', () => {
      expect(
        isDetailedHealthAuthorized({
          providedToken: 'anything',
          expectedToken: undefined,
          isProduction: true,
        }),
      ).toBe(false);
    });

    it('fails closed in production when the token is configured but blank', () => {
      expect(
        isDetailedHealthAuthorized({
          providedToken: '',
          expectedToken: '   ',
          isProduction: true,
        }),
      ).toBe(false);
    });

    it('allows detail off-production for local dev ergonomics', () => {
      expect(
        isDetailedHealthAuthorized({
          providedToken: undefined,
          expectedToken: undefined,
          isProduction: false,
        }),
      ).toBe(true);
    });
  });
});

describe('buildHealthResponse — denied detail degrades to compact', () => {
  it('discloses nothing sensitive when detail is denied, and says why', async () => {
    const result = await buildHealthResponse(createMockDeps(), false, { detailDenied: true });

    expect(result.statusCode).toBe(200);
    expect(result.body.detail).toBe('unauthorized');

    // The whole point of SCRUM-2653: none of these may reach an anonymous
    // caller. Each was verified present in the real unauthenticated production
    // response on 2026-08-01 before this gate existed.
    expect(result.body.connection).toBeUndefined();
    expect(result.body.info).toBeUndefined();

    const serialized = JSON.stringify(result.body);
    expect(serialized).not.toContain('vzwyaatejekddvltxyye'); // Supabase project ref
    expect(serialized).not.toContain('provider'); // which signing backend is live
    expect(serialized).not.toContain('pendingCount'); // anchoring backlog depth
    expect(serialized).not.toContain('prodAnchoring'); // feature flags

    // Compact liveness signal is preserved — probes must still work.
    expect(result.body.status).toBe('healthy');
    expect(result.body.checks).toEqual({
      database: 'ok',
      anchoring: 'ok',
      kms: 'ok',
    });
  });

  it('omits the marker on an ordinary compact probe (no detail requested)', async () => {
    const result = await buildHealthResponse(createMockDeps(), false);
    expect(result.body.detail).toBeUndefined();
    expect(result.body.connection).toBeUndefined();
    expect(result.body.info).toBeUndefined();
  });

  it('still serves full detail when authorized', async () => {
    const result = await buildHealthResponse(createMockDeps(), true);
    expect(result.body.detail).toBeUndefined();
    expect(result.body.connection).toMatchObject({ mode: 'direct' });
    expect(result.body.info).toBeDefined();
    expect(result.body.checks.kms).toMatchObject({ provider: 'gcp' });
  });
});
