/**
 * Tests for Treasury Status API
 * @see feedback_treasury_access — Arkova internal only
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { handleTreasuryStatus, handleTreasuryHealth } from './treasury.js';

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
    // fetchAnchorStats() calls callRpc(db, 'get_anchor_status_counts_fast').
    // Without this mock, db.rpc is undefined → TypeError surfaces as an
    // unhandled rejection that fails the whole test run even though the
    // assertions pass.
    rpc: vi.fn().mockResolvedValue({
      data: { total_secured: 5, total_pending: 3 },
      error: null,
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

// ─── CIBA-HARDEN-03: handleTreasuryHealth helpers ────────────────────────────

/**
 * Build a Supabase-style chainable mock from a dot-path + terminal resolve
 * value. e.g. `buildChain('select.eq.single', {...})` yields the nested
 * vi.fn().mockReturnValue({…}) tree that resolves at the leaf. Single
 * factory means Sonar doesn't see structurally-identical mockReturnValue
 * ladders across the three tables we stub.
 */
function buildChain(path: string, resolves: unknown): Record<string, unknown> {
  const keys = path.split('.');
  const leaf = keys[keys.length - 1];
  let current: Record<string, unknown> = { [leaf]: vi.fn().mockResolvedValue(resolves) };
  for (let i = keys.length - 2; i >= 0; i -= 1) {
    current = { [keys[i]]: vi.fn().mockReturnValue(current) };
  }
  return current;
}

async function runHealthWithTableErrors({
  cacheError,
  alertError,
}: {
  cacheError?: { message: string } | null;
  alertError?: { message: string } | null;
}): Promise<Response> {
  const { db } = await import('../utils/db.js');
  // Route by table name so platformAdmin lookup stays on profiles and
  // treasury_cache / treasury_alert_state each get their own chain result.
  vi.mocked(db.from).mockImplementation(((table: string) => {
    if (table === 'profiles') {
      return buildChain('select.eq.single', {
        data: { is_platform_admin: true },
        error: null,
      }) as never;
    }
    if (table === 'treasury_cache') {
      return buildChain('select.limit.maybeSingle', {
        data: null,
        error: cacheError ?? null,
      }) as never;
    }
    if (table === 'treasury_alert_state') {
      return buildChain('select.eq.maybeSingle', {
        data: null,
        error: alertError ?? null,
      }) as never;
    }
    throw new Error(`Unexpected db.from('${table}')`);
  }) as never);
  const res = createMockRes();
  await handleTreasuryHealth('admin-123', {} as Request, res);
  return res;
}

describe('handleTreasuryHealth — DB error 500', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 500 with source: treasury_cache when cache read errors', async () => {
    const res = await runHealthWithTableErrors({ cacheError: { message: 'connection reset' } });
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'treasury_cache' }),
    );
  });

  it('returns 500 with source: treasury_alert_state when alert read errors', async () => {
    const res = await runHealthWithTableErrors({ alertError: { message: 'timeout' } });
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'treasury_alert_state' }),
    );
  });

  it('returns 200 when both reads succeed (no false 500)', async () => {
    const res = await runHealthWithTableErrors({});
    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ threshold_usd: 50, price_unknown: true }),
    );
  });
});

// ─── CIBA-HARDEN-03: parseThresholdUsd ────────────────────────────────────────
describe('parseThresholdUsd', () => {
  // Dynamic import so vitest doesn't pre-evaluate the db mock block above for
  // this pure fn — keeps the test isolated from the handler fixture.
  it('returns default for undefined / empty / whitespace', async () => {
    const { parseThresholdUsd } = await import('./treasury.js');
    expect(parseThresholdUsd(undefined)).toBe(50);
    expect(parseThresholdUsd('')).toBe(50);
    expect(parseThresholdUsd('   ')).toBe(50);
  });

  it('returns default for non-numeric input', async () => {
    const { parseThresholdUsd } = await import('./treasury.js');
    expect(parseThresholdUsd('fifty')).toBe(50);
    expect(parseThresholdUsd('NaN')).toBe(50);
    expect(parseThresholdUsd('abc123')).toBe(50);
  });

  it('returns default for zero / negative', async () => {
    const { parseThresholdUsd } = await import('./treasury.js');
    expect(parseThresholdUsd('0')).toBe(50);
    expect(parseThresholdUsd('-50')).toBe(50);
    expect(parseThresholdUsd('-0.01')).toBe(50);
  });

  it('returns default for Infinity / -Infinity', async () => {
    const { parseThresholdUsd } = await import('./treasury.js');
    expect(parseThresholdUsd('Infinity')).toBe(50);
    expect(parseThresholdUsd('-Infinity')).toBe(50);
  });

  it('returns parsed value for valid positive input', async () => {
    const { parseThresholdUsd } = await import('./treasury.js');
    expect(parseThresholdUsd('100')).toBe(100);
    expect(parseThresholdUsd('25.5')).toBe(25.5);
    expect(parseThresholdUsd('500')).toBe(500);
  });
});
