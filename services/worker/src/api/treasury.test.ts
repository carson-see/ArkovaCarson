/**
 * Tests for Treasury Status API
 * @see feedback_treasury_access — Arkova internal only
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { handleTreasuryStatus } from './treasury.js';

// Mock dependencies
vi.mock('../utils/db.js', () => ({
  db: {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: { is_platform_admin: true }, error: null }),
          is: vi.fn().mockResolvedValue({ count: 5, error: null }),
          neq: vi.fn().mockResolvedValue({ count: 0, error: null }),
        }),
        is: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ count: 3, error: null }),
          order: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({ data: [{ chain_timestamp: '2026-03-16T00:00:00Z' }], error: null }),
          }),
          gte: vi.fn().mockResolvedValue({ count: 2, error: null }),
        }),
      }),
    }),
  },
}));

vi.mock('../config.js', () => ({
  config: {
    bitcoinTreasuryWif: undefined, // No WIF configured
    bitcoinUtxoProvider: 'mempool',
    bitcoinRpcUrl: undefined,
    bitcoinRpcAuth: undefined,
    mempoolApiUrl: undefined,
  },
}));

vi.mock('../chain/wallet.js', () => ({
  addressFromWif: vi.fn().mockReturnValue('tb1qtest'),
}));

vi.mock('../chain/utxo-provider.js', () => ({
  createUtxoProvider: vi.fn().mockReturnValue({
    listUnspent: vi.fn().mockResolvedValue([]),
    getBlockchainInfo: vi.fn().mockResolvedValue({ chain: 'testnet4', blocks: 100000 }),
  }),
}));

vi.mock('../chain/fee-estimator.js', () => ({
  createFeeEstimator: vi.fn().mockReturnValue({
    name: 'Static',
    estimateFee: vi.fn().mockResolvedValue(1),
  }),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

function createMockRes(): Response {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

describe('handleTreasuryStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 403 for non-admin users', async () => {
    // Mock profile lookup to return non-admin email
    const { db } = await import('../utils/db.js');
    vi.mocked(db.from).mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: { email: 'user@example.com' }, error: null }),
        }),
      }),
    } as never);

    const res = createMockRes();
    await handleTreasuryStatus('user-123', {} as Request, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('Forbidden') }),
    );
  });

  it('returns treasury data for admin users', async () => {
    const res = createMockRes();
    await handleTreasuryStatus('admin-123', {} as Request, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        fees: expect.objectContaining({
          estimatorName: 'Static',
          currentRateSatPerVbyte: 1,
        }),
        recentAnchors: expect.objectContaining({
          totalSecured: expect.any(Number),
          totalPending: expect.any(Number),
        }),
      }),
    );
    // Should NOT have 403 status
    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  it('indicates wallet not configured when WIF is missing', async () => {
    const res = createMockRes();
    await handleTreasuryStatus('admin-123', {} as Request, res);

    const response = vi.mocked(res.json).mock.calls[0][0] as Record<string, unknown>;
    expect(response.wallet).toBeNull();
    expect(response.error).toContain('not configured');
  });
});
