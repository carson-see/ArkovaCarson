/**
 * Treasury Cache Refresh Tests (SCRUM-546 + SCRUM-1786 sentinel guard)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { refreshTreasuryCache } from './treasury-cache.js';

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
const mockTreasuryCacheSelect = vi.fn();
const mockPipelineCacheSelect = vi.fn();
const mockRpc = vi.fn();

const mockChain = (terminal: string, result: unknown) => {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    gte: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    single: vi.fn().mockReturnThis(),
  };
  chain[terminal] = vi.fn().mockResolvedValue(result);
  return chain;
};

const mockFrom = vi.fn();

vi.mock('../utils/db.js', () => ({
  db: {
    from: (...args: unknown[]) => mockFrom(...(args as [string])),
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}));

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

describe('refreshTreasuryCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();

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

    mockPipelineCacheSelect.mockResolvedValue({
      data: { cache_value: { SECURED: 1_412_000, PENDING: 200, total: 1_412_200 } },
      error: null,
    });
    mockRpc.mockResolvedValue({
      data: {
        distinct_tx_count: 8,
        anchors_with_tx: 24,
        last_anchor_time: '2026-04-09T12:00:00Z',
        last_tx_time: '2026-04-09T12:00:00Z',
      },
      error: null,
    });
    mockTreasuryCacheSelect.mockResolvedValue({ data: null, error: null });

    let anchorsCallCount = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'treasury_cache') {
        return {
          upsert: mockUpsert,
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(() => mockTreasuryCacheSelect()),
            })),
          })),
        };
      }
      if (table === 'pipeline_dashboard_cache') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(() => mockPipelineCacheSelect()),
            })),
          })),
        };
      }
      // anchors table — two calls: lastSeen then last24
      anchorsCallCount++;
      if (anchorsCallCount === 1) {
        return mockChain('limit', {
          data: [{ chain_timestamp: '2026-04-09T12:00:00Z' }],
          error: null,
        });
      }
      return mockChain('limit', { data: [], error: null });
    });
  });

  it('fetches balance from mempool.space and writes to cache', async () => {
    const result = await refreshTreasuryCache();

    expect(result.balance_confirmed_sats).toBe(80000);
    expect(result.balance_unconfirmed_sats).toBe(5000);
    expect(result.btc_price_usd).toBe(65000);
    expect(result.fee_fastest).toBe(15);
    expect(result.fee_economy).toBe(3);
    expect(result.error).toBeNull();
    expect(result.updated_at).toBeDefined();
    expect(mockUpsert).toHaveBeenCalled();
  });

  it('reads anchor counts from pipeline_dashboard_cache', async () => {
    const result = await refreshTreasuryCache();

    expect(result.total_secured).toBe(1_412_000);
    expect(result.total_pending).toBe(200);
    expect(result.last_secured_at).toBe('2026-04-09T12:00:00Z');
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

    expect(result.balance_confirmed_sats).toBe(0);
    expect(result.fee_fastest).toBe(15);
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

  it('SCRUM-1786: sentinel guard preserves last-good values when anchor stats return -1', async () => {
    mockPipelineCacheSelect.mockResolvedValue({
      data: null,
      error: { message: 'relation does not exist' },
    });
    mockTreasuryCacheSelect.mockResolvedValue({
      data: { total_secured: 1_500_000, total_pending: 42, last_24h_count: 150 },
      error: null,
    });

    const result = await refreshTreasuryCache();

    expect(result.total_secured).toBe(1_500_000);
    expect(result.total_pending).toBe(42);
    // last_24h_count is 0 (not -1) because its anchors query succeeded independently
    expect(result.last_24h_count).toBe(0);
  });

  it('SCRUM-1786: sentinel guard skips when no existing cache row', async () => {
    mockPipelineCacheSelect.mockResolvedValue({
      data: null,
      error: { message: 'timeout' },
    });
    mockTreasuryCacheSelect.mockResolvedValue({ data: null, error: null });

    const result = await refreshTreasuryCache();

    expect(result.total_secured).toBe(-1);
    expect(result.total_pending).toBe(-1);
  });
});
