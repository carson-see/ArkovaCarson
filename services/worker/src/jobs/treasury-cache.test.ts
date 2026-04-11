/**
 * Treasury Cache Refresh Tests (SCRUM-546)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { refreshTreasuryCache } from './treasury-cache.js';

// Mock all external dependencies
vi.mock('../config.js', () => ({
  config: {
    bitcoinTreasuryWif: 'cNYfRxoekiUbYn4NiSVbSB2MRFkJMRhdkhGEZjHlkeCg2HqPDi4j',
    bitcoinNetwork: 'mainnet',
    bitcoinUtxoProvider: 'mempool',
    mempoolApiUrl: undefined,
    bitcoinRpcUrl: undefined,
    bitcoinRpcAuth: undefined,
  },
}));

vi.mock('../chain/wallet.js', () => ({
  addressFromWif: vi.fn(() => 'bc1qtm2kk33k6ht4agt48kh7rfkmmhfkapqn4zwerc'),
}));

vi.mock('../chain/utxo-provider.js', () => ({
  createUtxoProvider: vi.fn(() => ({
    listUnspent: vi.fn(async () => [
      { txid: 'abc123', vout: 0, valueSats: 50000 },
      { txid: 'def456', vout: 1, valueSats: 30000 },
    ]),
    getBlockchainInfo: vi.fn(async () => ({ chain: 'main', blocks: 890123 })),
  })),
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockUpsert = vi.fn().mockResolvedValue({ error: null });
const mockSelect = vi.fn();
// Wide return type so `.mockImplementation(...)` can return the mockChain builder
// below for the anchors table path without narrow-union incompatibility.
const mockFrom = vi.fn((table: string): Record<string, unknown> => {
  if (table === 'treasury_cache') {
    return { upsert: mockUpsert };
  }
  // anchors table mock
  return {
    select: mockSelect,
  };
});

vi.mock('../utils/db.js', () => ({
  db: {
    from: (...args: unknown[]) => mockFrom(...(args as [string])),
  },
}));

// Mock fetch globally
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

describe('refreshTreasuryCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default fetch responses
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/address/')) {
        return {
          ok: true,
          json: async () => ({
            chain_stats: { funded_txo_sum: 100000, spent_txo_sum: 20000 },
            mempool_stats: { funded_txo_sum: 5000, spent_txo_sum: 0 },
          }),
        };
      }
      if (url.includes('/v1/prices')) {
        return {
          ok: true,
          json: async () => ({ USD: 65000 }),
        };
      }
      if (url.includes('/v1/fees/recommended')) {
        return {
          ok: true,
          json: async () => ({
            fastestFee: 15,
            halfHourFee: 10,
            hourFee: 5,
            economyFee: 3,
            minimumFee: 1,
          }),
        };
      }
      return { ok: false };
    });

    // Mock anchor stats queries.
    //
    // Supabase's query builder is thenable in production (`await db.from(...).select(...).eq(...)`
    // resolves via PostgrestFilterBuilder's own `.then`). Tests must not reproduce that
    // pattern by putting a `then` on a plain object — SonarCloud typescript:S7739 flags
    // it because bespoke thenables are a common footgun. Instead, make the TERMINAL method
    // of each chain return a Promise via `mockResolvedValue`. The chain's intermediate
    // methods are `mockReturnThis` for composition.
    //
    // Terminals per query (see refreshTreasuryCache):
    //   1. secured  count: `.eq().is()`          — terminal is `is`
    //   2. pending  count: `.eq().is()`          — terminal is `is`
    //   3. lastSecured row: `.eq().is().order().limit(1)` — terminal is `limit`
    //   4. last24h  count: `.is().gte()`         — terminal is `gte`
    const mockChain = (terminal: 'is' | 'limit' | 'gte', result: unknown) => {
      const chain: Record<string, ReturnType<typeof vi.fn>> = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        gte: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
      };
      chain[terminal] = vi.fn().mockResolvedValue(result);
      return chain;
    };

    let callCount = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'treasury_cache') {
        return { upsert: mockUpsert };
      }
      // anchors table — returns different results for each call
      callCount++;
      if (callCount === 1) return mockChain('is', { count: 1412000, data: null, error: null });
      if (callCount === 2) return mockChain('is', { count: 0, data: null, error: null });
      if (callCount === 3) return mockChain('limit', { data: [{ chain_timestamp: '2026-04-09T12:00:00Z' }], error: null });
      return mockChain('gte', { count: 150, data: null, error: null });
    });
  });

  it('fetches balance from mempool.space and writes to cache', async () => {
    const result = await refreshTreasuryCache();

    expect(result.balance_confirmed_sats).toBe(80000); // 100000 - 20000
    expect(result.balance_unconfirmed_sats).toBe(5000);
    expect(result.btc_price_usd).toBe(65000);
    expect(result.fee_fastest).toBe(15);
    expect(result.fee_economy).toBe(3);
    expect(result.error).toBeNull();
    expect(result.updated_at).toBeDefined();
    expect(mockUpsert).toHaveBeenCalled();
  });

  it('handles mempool.space balance fetch failure gracefully', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/address/')) {
        return { ok: false, status: 429 };
      }
      if (url.includes('/v1/prices')) {
        return { ok: true, json: async () => ({ USD: 65000 }) };
      }
      if (url.includes('/v1/fees/recommended')) {
        return {
          ok: true,
          json: async () => ({
            fastestFee: 15, halfHourFee: 10, hourFee: 5, economyFee: 3, minimumFee: 1,
          }),
        };
      }
      return { ok: false };
    });

    const result = await refreshTreasuryCache();

    // Balance should be 0 (default) since fetch failed
    expect(result.balance_confirmed_sats).toBe(0);
    // But fee rates should still be populated
    expect(result.fee_fastest).toBe(15);
    // And BTC price should still work
    expect(result.btc_price_usd).toBe(65000);
  });

  it('writes to treasury_cache table via upsert', async () => {
    await refreshTreasuryCache();

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 1,
        balance_confirmed_sats: expect.any(Number),
        updated_at: expect.any(String),
      }),
    );
  });
});
