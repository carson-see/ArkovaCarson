/**
 * Unit tests for enhanced /health endpoint (P7-TS-06)
 *
 * TDD: Tests written before implementation.
 * Validates structured subsystem health checks including:
 * - Database connectivity
 * - Last anchor timestamps
 * - KMS availability
 * - Anchor queue depth
 * - Bitcoin fee rate
 * - Uptime
 *
 * Constitution refs:
 *   - 1.9: /api/health always available without auth
 *   - 1.4: Never include PII (user IDs, emails, API keys) in health responses
 *   - 1.7: No real Supabase/Bitcoin calls — mock everything
 */

import { describe, it, expect, vi } from 'vitest';
import { buildHealthResponse, type HealthCheckDeps } from './health.js';

function createMockDeps(overrides: Partial<HealthCheckDeps> = {}): HealthCheckDeps {
  return {
    isDbHealthy: () => true,
    dbQuery: async () => ({ data: [{ id: '1' }], error: null }),
    recordDbSuccess: vi.fn(),
    recordDbFailure: vi.fn(),
    getDbCircuitState: () => ({ healthy: true, consecutiveFailures: 0, lastError: null }),
    getConnectionInfo: () => ({ mode: 'direct' as const, url: 'https://***@test.supabase.co' }),
    config: {
      bitcoinNetwork: 'signet' as const,
      stripeSecretKey: 'sk_test',
      sentryDsn: 'https://sentry.io/123',
      geminiApiKey: 'key',
      aiProvider: 'mock',
      kmsProvider: 'gcp' as const,
      bitcoinKmsKeyId: undefined,
      gcpKmsKeyResourceName: 'projects/p/locations/l/keyRings/r/cryptoKeys/k',
      bitcoinTreasuryWif: 'wif_test',
      enableProdNetworkAnchoring: false,
    },
    getLastSecuredAnchor: async () => ({
      data: [{ created_at: '2026-03-14T00:00:00Z' }],
      error: null,
    }),
    getLastBatchAnchor: async () => ({
      data: [{ updated_at: '2026-03-14T01:00:00Z' }],
      error: null,
    }),
    getPendingAnchorCount: async () => ({
      count: 5,
      error: null,
    }),
    getCurrentFeeRate: async () => 2.5,
    ...overrides,
  };
}

describe('buildHealthResponse (P7-TS-06)', () => {
  describe('basic response structure', () => {
    it('returns healthy status with all subsystem checks', async () => {
      const deps = createMockDeps();
      const result = await buildHealthResponse(deps, false);

      expect(result.statusCode).toBe(200);
      expect(result.body.status).toBe('healthy');
      expect(result.body.version).toBeDefined();
      expect(typeof result.body.uptime).toBe('number');
      expect(result.body.network).toBe('signet');
    });

    it('includes subsystem checks in response', async () => {
      const deps = createMockDeps();
      const result = await buildHealthResponse(deps, false);

      expect(result.body.checks).toBeDefined();
      expect(result.body.checks.database).toBeDefined();
      expect(result.body.checks.anchoring).toBeDefined();
      expect(result.body.checks.kms).toBeDefined();
    });

    it('includes compact check statuses by default', async () => {
      const deps = createMockDeps();
      const result = await buildHealthResponse(deps, false);

      // Compact mode: just status strings
      expect(result.body.checks.database).toBe('ok');
    });

    it('includes detailed check info when detailed=true', async () => {
      const deps = createMockDeps();
      const result = await buildHealthResponse(deps, true);

      // Detailed mode: objects with status + metadata
      expect(result.body.checks.database).toMatchObject({
        status: 'ok',
      });
      expect(typeof result.body.checks.database.latencyMs).toBe('number');
    });
  });

  describe('database health check', () => {
    it('reports ok when DB is reachable', async () => {
      const deps = createMockDeps();
      const result = await buildHealthResponse(deps, true);

      expect(result.body.checks.database.status).toBe('ok');
    });

    it('reports error when DB query fails', async () => {
      const deps = createMockDeps({
        dbQuery: async () => ({ data: null, error: { message: 'connection refused' } }),
      });
      const result = await buildHealthResponse(deps, true);

      expect(result.statusCode).toBe(503);
      expect(result.body.status).toBe('degraded');
      expect(result.body.checks.database.status).toBe('error');
      expect(result.body.checks.database.message).toBe('connection refused');
    });

    it('reports error when circuit breaker is open', async () => {
      const deps = createMockDeps({
        isDbHealthy: () => false,
        getDbCircuitState: () => ({
          healthy: false,
          consecutiveFailures: 5,
          lastError: 'timeout',
        }),
      });
      const result = await buildHealthResponse(deps, true);

      expect(result.statusCode).toBe(503);
      expect(result.body.checks.database.status).toBe('error');
      expect(result.body.checks.database.message).toContain('Circuit breaker open');
    });

    it('reports error when DB query throws', async () => {
      const deps = createMockDeps({
        dbQuery: async () => { throw new Error('Network unreachable'); },
      });
      const result = await buildHealthResponse(deps, true);

      expect(result.statusCode).toBe(503);
      expect(result.body.checks.database.status).toBe('error');
      expect(result.body.checks.database.message).toBe('Network unreachable');
    });
  });

  describe('anchor status checks', () => {
    it('includes last SECURED anchor timestamp', async () => {
      const deps = createMockDeps();
      const result = await buildHealthResponse(deps, true);

      expect(result.body.checks.anchoring.lastSecuredAt).toBe('2026-03-14T00:00:00Z');
    });

    it('includes last batch anchor timestamp', async () => {
      const deps = createMockDeps();
      const result = await buildHealthResponse(deps, true);

      expect(result.body.checks.anchoring.lastBatchAt).toBe('2026-03-14T01:00:00Z');
    });

    it('includes pending anchor queue depth', async () => {
      const deps = createMockDeps();
      const result = await buildHealthResponse(deps, true);

      expect(result.body.checks.anchoring.pendingCount).toBe(5);
    });

    it('handles null last anchor gracefully', async () => {
      const deps = createMockDeps({
        getLastSecuredAnchor: async () => ({ data: [], error: null }),
        getLastBatchAnchor: async () => ({ data: [], error: null }),
      });
      const result = await buildHealthResponse(deps, true);

      expect(result.body.checks.anchoring.lastSecuredAt).toBeNull();
      expect(result.body.checks.anchoring.lastBatchAt).toBeNull();
    });

    it('handles anchor query errors gracefully without degrading overall status', async () => {
      const deps = createMockDeps({
        getLastSecuredAnchor: async () => ({ data: null, error: { message: 'query failed' } }),
        getPendingAnchorCount: async () => ({ count: null, error: { message: 'count failed' } }),
      });
      const result = await buildHealthResponse(deps, true);

      // Anchor query failures are informational, not critical
      expect(result.body.checks.anchoring.lastSecuredAt).toBeNull();
      expect(result.body.checks.anchoring.pendingCount).toBeNull();
      // Overall status still healthy if DB is reachable
      expect(result.body.status).toBe('healthy');
    });
  });

  describe('KMS availability check', () => {
    it('reports KMS as configured when GCP KMS key is set', async () => {
      const deps = createMockDeps();
      const result = await buildHealthResponse(deps, true);

      expect(result.body.checks.kms.status).toBe('ok');
      expect(result.body.checks.kms.provider).toBe('gcp');
    });

    it('reports KMS as configured when AWS KMS key is set', async () => {
      const deps = createMockDeps({
        config: {
          bitcoinNetwork: 'mainnet' as const,
          stripeSecretKey: 'sk_test',
          sentryDsn: undefined,
          geminiApiKey: undefined,
          aiProvider: 'mock',
          kmsProvider: 'aws' as const,
          bitcoinKmsKeyId: 'key-123',
          gcpKmsKeyResourceName: undefined,
          bitcoinTreasuryWif: undefined,
          enableProdNetworkAnchoring: true,
        },
      });
      const result = await buildHealthResponse(deps, true);

      expect(result.body.checks.kms.status).toBe('ok');
      expect(result.body.checks.kms.provider).toBe('aws');
    });

    it('reports KMS as unconfigured when no key is available', async () => {
      const deps = createMockDeps({
        config: {
          bitcoinNetwork: 'mainnet' as const,
          stripeSecretKey: 'sk_test',
          sentryDsn: undefined,
          geminiApiKey: undefined,
          aiProvider: 'mock',
          kmsProvider: 'aws' as const,
          bitcoinKmsKeyId: undefined,
          gcpKmsKeyResourceName: undefined,
          bitcoinTreasuryWif: undefined,
          enableProdNetworkAnchoring: true,
        },
      });
      const result = await buildHealthResponse(deps, true);

      expect(result.body.checks.kms.status).toBe('warning');
      expect(result.body.checks.kms.message).toContain('No signing key configured');
    });

    it('reports WIF as signing method on non-mainnet', async () => {
      const deps = createMockDeps({
        config: {
          bitcoinNetwork: 'signet' as const,
          stripeSecretKey: 'sk_test',
          sentryDsn: undefined,
          geminiApiKey: undefined,
          aiProvider: 'mock',
          kmsProvider: 'aws' as const,
          bitcoinKmsKeyId: undefined,
          gcpKmsKeyResourceName: undefined,
          bitcoinTreasuryWif: 'wif_test',
          enableProdNetworkAnchoring: true,
        },
      });
      const result = await buildHealthResponse(deps, true);

      expect(result.body.checks.kms.status).toBe('ok');
      expect(result.body.checks.kms.provider).toBe('wif');
    });
  });

  describe('fee rate check', () => {
    it('includes current fee rate in detailed response', async () => {
      const deps = createMockDeps();
      const result = await buildHealthResponse(deps, true);

      expect(result.body.checks.anchoring.feeRateSatVb).toBe(2.5);
    });

    it('handles fee rate fetch failure gracefully', async () => {
      const deps = createMockDeps({
        getCurrentFeeRate: async () => null,
      });
      const result = await buildHealthResponse(deps, true);

      expect(result.body.checks.anchoring.feeRateSatVb).toBeNull();
    });
  });

  describe('overall status determination', () => {
    it('returns healthy when all critical checks pass', async () => {
      const deps = createMockDeps();
      const result = await buildHealthResponse(deps, false);

      expect(result.statusCode).toBe(200);
      expect(result.body.status).toBe('healthy');
    });

    it('returns degraded (503) when database is down', async () => {
      const deps = createMockDeps({
        dbQuery: async () => ({ data: null, error: { message: 'down' } }),
      });
      const result = await buildHealthResponse(deps, false);

      expect(result.statusCode).toBe(503);
      expect(result.body.status).toBe('degraded');
    });
  });

  describe('PII safety (Constitution 1.4)', () => {
    it('never includes user IDs in response', async () => {
      const deps = createMockDeps();
      const result = await buildHealthResponse(deps, true);
      const json = JSON.stringify(result.body);

      expect(json).not.toContain('user_id');
      expect(json).not.toContain('email');
      expect(json).not.toContain('api_key');
    });

    it('never includes secret values in response', async () => {
      const deps = createMockDeps();
      const result = await buildHealthResponse(deps, true);
      const json = JSON.stringify(result.body);

      // Verify raw secret values are not present
      expect(json).not.toContain('sk_test');
      expect(json).not.toContain('wif_test');
      // Verify no Stripe/Supabase keys leak
      expect(json).not.toContain('sk_live');
      expect(json).not.toContain('service_role');
    });
  });

  describe('info section (detailed only)', () => {
    it('includes service info in detailed mode', async () => {
      const deps = createMockDeps();
      const result = await buildHealthResponse(deps, true);

      expect(result.body.info).toBeDefined();
      expect(result.body.info.stripe).toMatchObject({ configured: true });
      expect(result.body.info.sentry).toMatchObject({ configured: true });
      expect(result.body.info.ai).toMatchObject({ configured: true });
      expect(result.body.info.prodAnchoring).toBeDefined();
    });

    it('does not include info in compact mode', async () => {
      const deps = createMockDeps();
      const result = await buildHealthResponse(deps, false);

      expect(result.body.info).toBeUndefined();
    });

    it('includes connection info in detailed mode', async () => {
      const deps = createMockDeps();
      const result = await buildHealthResponse(deps, true);

      expect(result.body.connection).toMatchObject({ mode: 'direct' });
    });
  });
});
