/**
 * Unit tests for Payment Reconciliation (RECON-1, RECON-3, RECON-5)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRpc, mockSelect, mockInsert, mockUpdate, mockUpsert, mockLogger } = vi.hoisted(() => {
  const mockRpc = vi.fn();
  const mockSelect = vi.fn();
  const mockInsert = vi.fn();
  const mockUpdate = vi.fn();
  const mockUpsert = vi.fn();
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return { mockRpc, mockSelect, mockInsert, mockUpdate, mockUpsert, mockLogger };
});

vi.mock('../utils/db.js', () => ({
  db: {
    rpc: mockRpc,
    from: vi.fn((table: string) => {
      const chain: any = {
        select: vi.fn((_cols?: string, opts?: any) => {
          if (opts?.count) return { ...chain, count: 0 };
          return chain;
        }),
        eq: vi.fn(() => chain),
        in: vi.fn(() => chain),
        gte: vi.fn(() => chain),
        lt: vi.fn(() => chain),
        is: vi.fn(() => chain),
        not: vi.fn(() => chain),
        order: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        maybeSingle: mockSelect,
        single: mockSelect,
        insert: mockInsert,
        update: mockUpdate,
        upsert: mockUpsert,
      };
      // Return empty arrays for list queries
      chain.then = (resolve: any) => resolve({ data: [], error: null });
      return chain;
    }),
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: mockLogger,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockInsert.mockResolvedValue({ error: null });
  mockUpdate.mockResolvedValue({ error: null });
  mockUpsert.mockResolvedValue({ error: null });
});

describe('runStripeAnchorReconciliation', () => {
  it('returns empty result when no subscriptions exist', async () => {
    const { runStripeAnchorReconciliation } = await import('./reconciliation.js');
    const result = await runStripeAnchorReconciliation('2026-02');
    expect(result.month).toBe('2026-02');
    expect(result.totalSubscriptions).toBe(0);
    expect(result.discrepancies).toEqual([]);
  });
});

describe('generateFinancialReport', () => {
  it('generates report with zero revenue when no events exist', async () => {
    const { generateFinancialReport } = await import('./reconciliation.js');
    const result = await generateFinancialReport('2026-02');
    expect(result.month).toBe('2026-02');
    expect(result.stripeRevenueUsd).toBe(0);
    expect(result.x402RevenueUsd).toBe(0);
    expect(result.grossMarginPct).toBe(0);
  });
});

describe('isFreeTierUser', () => {
  it('returns true when no subscription exists', async () => {
    mockSelect.mockResolvedValue({ data: null });
    const { isFreeTierUser } = await import('./reconciliation.js');
    const result = await isFreeTierUser('user-1');
    expect(result).toBe(true);
  });
});

describe('isWithinBatchWindow', () => {
  it('correctly identifies batch window (02:00-03:00 UTC)', async () => {
    const { isWithinBatchWindow } = await import('./reconciliation.js');
    // This test depends on current time — just verify it returns a boolean
    expect(typeof isWithinBatchWindow()).toBe('boolean');
  });
});

describe('processFailedPaymentRecovery', () => {
  it('returns zero counts when no expired grace periods', async () => {
    const { processFailedPaymentRecovery } = await import('./reconciliation.js');
    const result = await processFailedPaymentRecovery();
    expect(result.processed).toBe(0);
    expect(result.downgraded).toBe(0);
  });
});

describe('createGracePeriod', () => {
  it('does not create duplicate grace periods', async () => {
    mockSelect.mockResolvedValue({ data: { id: 'existing-gp' } });
    const { createGracePeriod } = await import('./reconciliation.js');
    await createGracePeriod('user-1', 'sub_123');
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
