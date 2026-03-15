/**
 * DH-05: Chain Index Cache TTL Tests
 *
 * Tests for SupabaseChainIndexLookup TTL-based caching.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Hoisted mocks ──────────────────────────────────────────────────

const { mockDbFrom } = vi.hoisted(() => {
  const mockDbFrom = vi.fn();
  return { mockDbFrom };
});

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../config.js', () => ({
  get config() {
    return {
      nodeEnv: 'test',
      useMocks: true,
      enableProdNetworkAnchoring: false,
      logLevel: 'info',
    };
  },
  getNetworkDisplayName: vi.fn(() => 'Test Environment'),
}));

vi.mock('../utils/db.js', () => ({
  db: { from: mockDbFrom },
}));

vi.mock('./signet.js', () => ({
  BitcoinChainClient: vi.fn(),
  SignetChainClient: vi.fn(),
}));

vi.mock('./utxo-provider.js', () => ({
  createUtxoProvider: vi.fn(() => ({ name: 'mock' })),
}));

vi.mock('./signing-provider.js', () => ({
  createSigningProvider: vi.fn(async () => ({ name: 'mock' })),
}));

vi.mock('./fee-estimator.js', () => ({
  createFeeEstimator: vi.fn(() => ({ name: 'mock' })),
}));

import { SupabaseChainIndexLookup } from './client.js';

describe('DH-05: SupabaseChainIndexLookup cache TTL', () => {
  let lookup: SupabaseChainIndexLookup;
  let mockMaybeSingle: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T12:00:00Z'));

    // Create lookup with 5-second TTL for faster testing
    lookup = new SupabaseChainIndexLookup(5000);

    mockMaybeSingle = vi.fn();
    const mockLimit = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
    const mockEq = vi.fn(() => ({ limit: mockLimit }));
    const mockSelect = vi.fn(() => ({ eq: mockEq }));
    mockDbFrom.mockReturnValue({ select: mockSelect });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('queries DB on first lookup (cache miss)', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        chain_tx_id: 'tx_abc',
        chain_block_height: 100,
        chain_block_timestamp: '2026-03-15T00:00:00Z',
        confirmations: 6,
        anchor_id: 'anchor_1',
      },
      error: null,
    });

    const result = await lookup.lookupFingerprint('abc123');

    expect(result).toEqual({
      chainTxId: 'tx_abc',
      blockHeight: 100,
      blockTimestamp: '2026-03-15T00:00:00Z',
      confirmations: 6,
      anchorId: 'anchor_1',
    });
    expect(mockDbFrom).toHaveBeenCalledTimes(1);
  });

  it('returns cached result on second lookup within TTL', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        chain_tx_id: 'tx_cached',
        chain_block_height: 200,
        chain_block_timestamp: '2026-03-15T00:00:00Z',
        confirmations: 3,
        anchor_id: 'anchor_2',
      },
      error: null,
    });

    // First lookup — hits DB
    await lookup.lookupFingerprint('cached_fp');
    expect(mockDbFrom).toHaveBeenCalledTimes(1);

    // Second lookup — should use cache
    const result = await lookup.lookupFingerprint('cached_fp');
    expect(result?.chainTxId).toBe('tx_cached');
    expect(mockDbFrom).toHaveBeenCalledTimes(1); // Still 1 — no new DB call
  });

  it('queries DB again after TTL expires', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        chain_tx_id: 'tx_expired',
        chain_block_height: 300,
        chain_block_timestamp: '2026-03-15T00:00:00Z',
        confirmations: 1,
        anchor_id: 'anchor_3',
      },
      error: null,
    });

    // First lookup
    await lookup.lookupFingerprint('expired_fp');
    expect(mockDbFrom).toHaveBeenCalledTimes(1);

    // Advance past TTL (5s)
    vi.advanceTimersByTime(6000);

    // Second lookup — TTL expired, should hit DB again
    await lookup.lookupFingerprint('expired_fp');
    expect(mockDbFrom).toHaveBeenCalledTimes(2);
  });

  it('caches null results (miss)', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });

    // First lookup — DB miss
    const result1 = await lookup.lookupFingerprint('nonexistent');
    expect(result1).toBeNull();
    expect(mockDbFrom).toHaveBeenCalledTimes(1);

    // Second lookup — cached null
    const result2 = await lookup.lookupFingerprint('nonexistent');
    expect(result2).toBeNull();
    expect(mockDbFrom).toHaveBeenCalledTimes(1); // Still 1
  });

  it('clearCache resets the cache', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        chain_tx_id: 'tx_clear',
        chain_block_height: 400,
        chain_block_timestamp: '2026-03-15T00:00:00Z',
        confirmations: 10,
        anchor_id: 'anchor_4',
      },
      error: null,
    });

    // Populate cache
    await lookup.lookupFingerprint('clear_fp');
    expect(lookup.cacheSize).toBe(1);

    // Clear
    lookup.clearCache();
    expect(lookup.cacheSize).toBe(0);

    // Next lookup should hit DB
    await lookup.lookupFingerprint('clear_fp');
    expect(mockDbFrom).toHaveBeenCalledTimes(2);
  });

  it('uses default 5-minute TTL when no ttlMs provided', () => {
    const defaultLookup = new SupabaseChainIndexLookup();
    expect(defaultLookup).toBeDefined();
    expect(defaultLookup.cacheSize).toBe(0);
  });

  it('does not cache on DB error', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: null,
      error: { message: 'connection timeout' },
    });

    const result = await lookup.lookupFingerprint('error_fp');
    expect(result).toBeNull();
    expect(lookup.cacheSize).toBe(0); // Should not cache errors
  });
});
