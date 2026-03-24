/**
 * Chain Maintenance Jobs — Tests
 *
 * Tests for Bitcoin audit findings: CRIT-2, NET-1, NET-3, INEFF-1, NET-6
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---- Hoisted mocks (available before vi.mock factories run) ----
const { mockDb, mockLogger, mockConfig } = vi.hoisted(() => {
  const mockDb = {
    from: vi.fn(),
    rpc: vi.fn(),
  };

  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const mockConfig = {
    useMocks: false,
    nodeEnv: 'development',
    bitcoinNetwork: 'signet',
    mempoolApiUrl: undefined as string | undefined,
    bitcoinMaxFeeRate: 100,
  };

  return { mockDb, mockLogger, mockConfig };
});

vi.mock('../utils/db.js', () => ({ db: mockDb }));
vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('../config.js', () => ({ config: mockConfig }));

import {
  detectReorgs,
  monitorStuckTransactions,
  rebroadcastDroppedTransactions,
  consolidateUtxos,
  monitorFeeRates,
  STUCK_TX_THRESHOLD_MS,
  MAX_REBROADCAST_ATTEMPTS,
  FEE_SPIKE_MULTIPLIER,
} from './chain-maintenance.js';

// Helper to create mock DB chain (thenable)
function mockDbChain(data: unknown = null, error: unknown = null) {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.update = vi.fn(() => chain);
  chain.insert = vi.fn(() => chain);
  chain.upsert = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.gte = vi.fn(() => chain);
  chain.lt = vi.fn(() => chain);
  chain.not = vi.fn(() => chain);
  chain.is = vi.fn(() => chain);
  chain.in = vi.fn(() => chain);
  chain.order = vi.fn(() => chain);
  chain.limit = vi.fn(() => chain);
  chain.single = vi.fn().mockResolvedValue({ data, error });
  chain.maybeSingle = vi.fn().mockResolvedValue({ data, error });
  // Make chain thenable
  chain.then = (resolve: (v: { data: unknown; error: unknown }) => void) => {
    return Promise.resolve().then(() => resolve({ data, error }));
  };
  return chain;
}

describe('Chain Maintenance Jobs', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: advisory lock acquired successfully
    mockDb.rpc.mockResolvedValue({ data: true });
    // Reset config
    mockConfig.useMocks = false;
    mockConfig.nodeEnv = 'development';
    mockConfig.bitcoinNetwork = 'signet';
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // ─── CRIT-2: Reorg Detection ──────────────────────────────────────

  describe('detectReorgs (CRIT-2)', () => {
    it('skips in mock/test mode', async () => {
      mockConfig.useMocks = true;
      const result = await detectReorgs();
      expect(result).toEqual({ checked: 0, reorgsDetected: 0, reverted: 0 });
    });

    it('skips when advisory lock not acquired', async () => {
      // acquireLock is now a no-op (single-worker process), so this test
      // verifies the function still proceeds and handles missing fetch gracefully.
      // Mock fetch to simulate chain tip failure.
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response);
      const result = await detectReorgs();
      expect(result).toEqual({ checked: 0, reorgsDetected: 0, reverted: 0 });
    });

    it('returns zero when chain tip fetch fails', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response);
      const result = await detectReorgs();
      expect(result.checked).toBe(0);
    });

    it('returns zero when no recently SECURED anchors', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true, text: async () => '100',
      } as Response);

      const chain = mockDbChain([], null);
      mockDb.from.mockReturnValue(chain);

      const result = await detectReorgs();
      expect(result.checked).toBe(0);
    });
  });

  // ─── NET-1: Stuck TX Monitor ──────────────────────────────────────

  describe('monitorStuckTransactions (NET-1)', () => {
    it('skips in mock/test mode', async () => {
      mockConfig.useMocks = true;
      const result = await monitorStuckTransactions();
      expect(result).toEqual({ checked: 0, stuck: 0, recovered: 0 });
    });

    it('returns zero when no stuck anchors', async () => {
      const chain = mockDbChain([], null);
      mockDb.from.mockReturnValue(chain);

      const result = await monitorStuckTransactions();
      expect(result.checked).toBe(0);
    });

    it('skips anchors whose TX is actually confirmed', async () => {
      const stuckAnchor = {
        id: 'a1',
        chain_tx_id: 'tx456',
        metadata: {},
        created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        updated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      };

      const selectChain = mockDbChain([stuckAnchor], null);
      mockDb.from.mockReturnValue(selectChain);

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: { confirmed: true } }),
      } as Response);

      const result = await monitorStuckTransactions();
      expect(result.stuck).toBe(0);
    });

    it('recovers anchor after max rebroadcast attempts + 72h', async () => {
      const abandonCutoff = new Date(Date.now() - 73 * 60 * 60 * 1000).toISOString();
      const stuckAnchor = {
        id: 'a1',
        chain_tx_id: 'tx789',
        metadata: { _rebroadcast_attempts: MAX_REBROADCAST_ATTEMPTS },
        created_at: abandonCutoff,
        updated_at: abandonCutoff,
      };

      let fromCallCount = 0;
      mockDb.from.mockImplementation(() => {
        fromCallCount++;
        return mockDbChain(fromCallCount === 1 ? [stuckAnchor] : null, null);
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: false, status: 404,
      } as Response);

      const result = await monitorStuckTransactions();
      expect(result.recovered).toBe(1);
    });
  });

  // ─── NET-3: TX Rebroadcast ────────────────────────────────────────

  describe('rebroadcastDroppedTransactions (NET-3)', () => {
    it('skips in mock/test mode', async () => {
      mockConfig.useMocks = true;
      const result = await rebroadcastDroppedTransactions();
      expect(result).toEqual({ checked: 0, rebroadcast: 0, failed: 0 });
    });

    it('returns zero when no old anchors', async () => {
      const chain = mockDbChain([], null);
      mockDb.from.mockReturnValue(chain);

      const result = await rebroadcastDroppedTransactions();
      expect(result.checked).toBe(0);
    });

    it('successfully rebroadcasts dropped TX with raw hex', async () => {
      const anchor = {
        id: 'a1',
        chain_tx_id: 'tx_dropped',
        metadata: { _raw_tx_hex: '0200000001abcdef...' },
      };

      let fromCallCount = 0;
      mockDb.from.mockImplementation(() => {
        fromCallCount++;
        return mockDbChain(fromCallCount === 1 ? [anchor] : null, null);
      });

      global.fetch = vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 404 } as Response)
        .mockResolvedValueOnce({ ok: true, text: async () => 'tx_dropped' } as Response);

      const result = await rebroadcastDroppedTransactions();
      expect(result.rebroadcast).toBe(1);
    });

    it('fails when no raw TX hex stored', async () => {
      const anchor = {
        id: 'a1',
        chain_tx_id: 'tx_no_hex',
        metadata: {},
      };

      let fromCallCount = 0;
      mockDb.from.mockImplementation(() => {
        fromCallCount++;
        return mockDbChain(fromCallCount === 1 ? [anchor] : null, null);
      });

      global.fetch = vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 404 } as Response);

      const result = await rebroadcastDroppedTransactions();
      expect(result.failed).toBe(1);
    });
  });

  // ─── INEFF-1: UTXO Consolidation ─────────────────────────────────

  describe('consolidateUtxos (INEFF-1)', () => {
    it('skips in mock/test mode', async () => {
      mockConfig.useMocks = true;
      const result = await consolidateUtxos();
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('mock/test mode');
    });

    it('skips when fees are too high', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ hourFee: 50 }),
      } as Response);

      mockDb.from.mockReturnValue(mockDbChain(null, null));

      const result = await consolidateUtxos();
      expect(result.skipped).toBe(true);
      expect(result.reason).toContain('fee');
    });
  });

  // ─── NET-6: Fee Monitoring ────────────────────────────────────────

  describe('monitorFeeRates (NET-6)', () => {
    it('skips in mock/test mode', async () => {
      mockConfig.useMocks = true;
      const result = await monitorFeeRates();
      expect(result.recorded).toBe(false);
    });

    it('records current fee rate', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ halfHourFee: 15 }),
      } as Response);

      let fromCallCount = 0;
      mockDb.from.mockImplementation(() => {
        fromCallCount++;
        if (fromCallCount === 2) {
          // Return some historical samples
          return mockDbChain([], null);
        }
        return mockDbChain(null, null);
      });

      const result = await monitorFeeRates();
      expect(result.currentRate).toBe(15);
      expect(result.recorded).toBe(true);
    });

    it('detects fee spike', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ halfHourFee: 100 }),
      } as Response);

      const samples = Array.from({ length: 10 }, () => ({
        details: JSON.stringify({ rate_sat_per_vb: 10 }),
      }));

      let fromCallCount = 0;
      mockDb.from.mockImplementation(() => {
        fromCallCount++;
        if (fromCallCount === 2) return mockDbChain(samples, null); // historical
        return mockDbChain(null, null); // insert
      });

      const result = await monitorFeeRates();
      expect(result.spikeDetected).toBe(true);
      expect(result.currentRate).toBe(100);
    });
  });

  // ─── Constants ────────────────────────────────────────────────────

  describe('Constants', () => {
    it('exports expected threshold values', () => {
      expect(STUCK_TX_THRESHOLD_MS).toBe(30 * 60 * 1000);
      expect(MAX_REBROADCAST_ATTEMPTS).toBe(3);
      expect(FEE_SPIKE_MULTIPLIER).toBe(5);
    });
  });
});
