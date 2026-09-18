import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const { mockIsPlatformAdmin, mockFrom } = vi.hoisted(() => ({
  mockIsPlatformAdmin: vi.fn(),
  mockFrom: vi.fn(),
}));

vi.mock('../utils/platformAdmin.js', () => ({ isPlatformAdmin: mockIsPlatformAdmin }));
vi.mock('../utils/db.js', () => ({ db: { from: mockFrom } }));
vi.mock('../utils/logger.js', () => ({ logger: { error: vi.fn() } }));
vi.mock('../utils/rateLimit.js', () => ({ getRateLimitStoreSize: () => 2 }));
vi.mock('../middleware/idempotency.js', () => ({ getIdempotencyStoreSize: () => 3 }));
vi.mock('../webhooks/delivery.js', () => ({ getCircuitBreakerSize: () => 4 }));
vi.mock('../utils/buildInfo.js', () => ({ getBuildSha: () => 'uat22-test-sha' }));
vi.mock('../config.js', () => ({
  config: {
    bitcoinTreasuryWif: 'configured-only',
    enableProdNetworkAnchoring: true,
    bitcoinNetwork: 'regtest',
    stripeSecretKey: '',
    sentryDsn: '',
    geminiApiKey: '',
    aiProvider: 'mock',
    resendApiKey: 'configured',
  },
}));

import { handleSystemHealth } from './admin-health.js';

function response(): Response & { statusCode: number; body: unknown } {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) { res.statusCode = code; return res; },
    json(body: unknown) { res.body = body; return res; },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

describe('handleSystemHealth UAT-22 acceptance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsPlatformAdmin.mockResolvedValue(true);
    mockFrom.mockReturnValue({
      select: vi.fn(() => ({ limit: vi.fn(async () => ({ error: null })) })),
    });
  });

  it('blocks a non-platform-admin before probing health data', async () => {
    mockIsPlatformAdmin.mockResolvedValue(false);
    const res = response();

    await handleSystemHealth('ordinary-user', {} as Request, res);

    expect(res.statusCode).toBe(403);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('reports the measured DB probe separately from configuration-derived Bitcoin readiness', async () => {
    const res = response();

    await handleSystemHealth('platform-admin', {} as Request, res);

    expect(res.statusCode).toBe(200);
    expect(mockFrom).toHaveBeenCalledWith('plans');
    expect(res.body).toMatchObject({
      status: 'healthy',
      git_sha: 'uat22-test-sha',
      checks: {
        supabase: { status: 'ok', latencyMs: expect.any(Number) },
        // This value proves configured readiness only; the handler performs no chain call.
        bitcoin: { connected: true, network: 'regtest' },
      },
      stores: { rateLimitEntries: 2, idempotencyEntries: 3, circuitBreakerEntries: 4 },
    });
  });
});
