/**
 * Treasury Cache Refresh Tests (SCRUM-546 + SCRUM-1786 sentinel guard)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { refreshTreasuryCache } from './treasury-cache.js';
import { config } from '../config.js';

/**
 * The mocked config is a plain object, so tests can flip the deployment
 * network per-case. Reset in beforeEach so cases stay independent.
 */
const mutableConfig = config as unknown as {
  bitcoinNetwork: string;
  mempoolApiUrl: string | undefined;
};

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
    mutableConfig.bitcoinNetwork = 'mainnet';
    mutableConfig.mempoolApiUrl = undefined;

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

  /**
   * BUG-2026-08-11 — network selection.
   *
   * The job hardcoded `https://mempool.space/api` (MAINNET) as its fallback
   * base while `createUtxoProvider` selected per-network from MEMPOOL_URLS.
   * On a signet deployment the balance fetch therefore asked the MAINNET
   * explorer about a signet address; mempool.space answers HTTP 400
   * ("Address on invalid network"), the `res.ok ? … : null` ladder mapped
   * that to null, and `handleSettled` skipped a null value silently — so the
   * job recorded balance_confirmed_sats = 0 with error = null and reported
   * `{"success":true,"balance":0}`. treasury-alert then fired
   * "Price or balance oracle unavailable / below_threshold" every 5 minutes.
   *
   * Reproduced live against arkova-worker-fullsoak-2026-08-staging while the
   * bound treasury address held ~749k sats and the anchoring path was
   * successfully spending from it.
   */
  describe('BUG-2026-08-11: per-network API base selection', () => {
    /** Matches the address the mocked `addressFromWif` derives. */
    const ADDRESS = 'bc1qtm2kk33k6ht4agt48kh7rfkmmhfkapqn4zwerc';

    const urlFor = (fragment: string): string =>
      mockFetch.mock.calls
        .map((call) => String(call[0]))
        .find((u) => u.includes(fragment)) ?? '';

    it('resolves a signet-configured treasury to the signet API base', async () => {
      mutableConfig.bitcoinNetwork = 'signet';

      await refreshTreasuryCache();

      expect(urlFor('/address/')).toBe(
        `https://mempool.space/signet/api/address/${ADDRESS}`,
      );
    });

    it.each([
      ['signet', 'https://mempool.space/signet/api'],
      ['testnet4', 'https://mempool.space/testnet4/api'],
      ['testnet', 'https://mempool.space/testnet/api'],
      ['mainnet', 'https://mempool.space/api'],
    ])('selects the %s base for address lookups', async (network, expected) => {
      mutableConfig.bitcoinNetwork = network;

      await refreshTreasuryCache();

      expect(urlFor('/address/')).toBe(`${expected}/address/${ADDRESS}`);
    });

    it('sends fee-rate lookups to the configured network, not mainnet', async () => {
      mutableConfig.bitcoinNetwork = 'signet';

      await refreshTreasuryCache();

      expect(urlFor('/v1/fees/recommended')).toBe(
        'https://mempool.space/signet/api/v1/fees/recommended',
      );
    });

    it('records the real balance once the signet base is used', async () => {
      mutableConfig.bitcoinNetwork = 'signet';

      const result = await refreshTreasuryCache();

      // The shared fetch mock answers any base; the point is that a
      // non-mainnet deployment no longer silently books a zero balance.
      expect(result.balance_confirmed_sats).toBe(80000);
      expect(result.error).toBeNull();
    });

    it('honours an operator-set MEMPOOL_API_URL over the per-network default', async () => {
      mutableConfig.bitcoinNetwork = 'signet';
      mutableConfig.mempoolApiUrl = 'https://mempool.example.internal/signet';

      await refreshTreasuryCache();

      expect(urlFor('/address/')).toBe(
        `https://mempool.example.internal/signet/api/address/${ADDRESS}`,
      );
    });
  });

  /**
   * BUG-2026-08-11 (second-order): `/v1/prices` is a GLOBAL BTC/USD market
   * quote. The signet/testnet explorers serve it with HTTP 200 and a `-1`
   * sentinel rather than 404, so routing the price fetch per-network the same
   * way as the address fetch would store btc_price_usd = -1. decideTreasuryAlert
   * multiplies that by the balance, making balance_usd negative — which is
   * below every threshold, so the false "oracle unavailable" alert would simply
   * become a false "below threshold" alert that looks like a real reading.
   */
  describe('BUG-2026-08-11: BTC/USD price is a global quote', () => {
    it('keeps the price lookup on mainnet for a signet deployment', async () => {
      mutableConfig.bitcoinNetwork = 'signet';

      await refreshTreasuryCache();

      const priceUrl = mockFetch.mock.calls
        .map((call) => String(call[0]))
        .find((u) => u.includes('/v1/prices'));

      expect(priceUrl).toBe('https://mempool.space/api/v1/prices');
    });

    it.each([-1, 0, Number.NaN])(
      'rejects the %s price sentinel instead of storing it',
      async (sentinel) => {
        mockFetch.mockImplementation(async (url: string) => {
          if (url.includes('/v1/prices')) {
            return { ok: true, json: async () => ({ USD: sentinel }) };
          }
          if (url.includes('/address/')) {
            return {
              ok: true,
              json: async () => ({
                chain_stats: { funded_txo_sum: 100000, spent_txo_sum: 20000 },
                mempool_stats: { funded_txo_sum: 5000, spent_txo_sum: 0 },
              }),
            };
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

        expect(result.btc_price_usd).toBeNull();
        // The balance must still be recorded — a bad price is not a balance outage.
        expect(result.balance_confirmed_sats).toBe(80000);
      },
    );

    it('still stores a valid price', async () => {
      const result = await refreshTreasuryCache();

      expect(result.btc_price_usd).toBe(65000);
    });
  });
});
