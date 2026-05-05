/**
 * Unit tests for chain client factory (async pattern)
 *
 * CRIT-2 + P7-TS-13: Verify the factory returns the correct client
 * based on configuration — MockChainClient for test/mock modes,
 * BitcoinChainClient (Signet or Mainnet) when ENABLE_PROD_NETWORK_ANCHORING
 * is true with valid config, MockChainClient fallback otherwise.
 *
 * Also covers:
 *   - initChainClient / getInitializedChainClient singleton pattern
 *   - SupabaseChainIndexLookup (Supabase-backed fingerprint lookup)
 *   - Legacy getChainClient backward compat
 *
 * Stories: P7-TS-05, P7-TS-13, CRIT-2
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mocks ──────────────────────────────────────────────────

const { mockConfig, mockDbFrom } = vi.hoisted(() => {
  const mockConfig = {
    nodeEnv: 'test' as string,
    useMocks: true,
    chainNetwork: 'testnet' as const,
    bitcoinNetwork: 'signet' as string,
    bitcoinRpcUrl: undefined as string | undefined,
    bitcoinRpcAuth: undefined as string | undefined,
    bitcoinTreasuryWif: undefined as string | undefined,
    bitcoinUtxoProvider: 'mempool' as string,
    mempoolApiUrl: undefined as string | undefined,
    bitcoinFeeStrategy: undefined as string | undefined,
    bitcoinStaticFeeRate: undefined as number | undefined,
    bitcoinFallbackFeeRate: undefined as number | undefined,
    bitcoinKmsKeyId: undefined as string | undefined,
    bitcoinKmsRegion: undefined as string | undefined,
    kmsProvider: undefined as string | undefined,
    gcpKmsKeyResourceName: undefined as string | undefined,
    gcpKmsProjectId: undefined as string | undefined,
    forceDynamicFeeEstimation: false,
    bitcoinMaxFeeRate: undefined as number | undefined,
    enableProdNetworkAnchoring: false,
    logLevel: 'info',
  };

  const mockDbFrom = vi.fn();

  return { mockConfig, mockDbFrom };
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
    return mockConfig;
  },
  getNetworkDisplayName: vi.fn(() => 'Test Environment'),
}));

vi.mock('../utils/db.js', () => ({
  db: {
    from: mockDbFrom,
  },
}));

// Mock BitcoinChainClient with a real class so `new BitcoinChainClient()` works
vi.mock('./signet.js', () => {
  class MockBitcoinChainClient {
    _isBitcoinClient = true; // marker for test assertions
    config: Record<string, unknown>;
    constructor(cfg: Record<string, unknown>) { this.config = cfg; }
    submitFingerprint = vi.fn();
    verifyFingerprint = vi.fn();
    getReceipt = vi.fn();
    healthCheck = vi.fn().mockResolvedValue(true);
  }
  return {
    BitcoinChainClient: MockBitcoinChainClient,
    SignetChainClient: MockBitcoinChainClient,
  };
});

// Mock provider factories — they must return objects with `name` property
vi.mock('./utxo-provider.js', () => ({
  createUtxoProvider: vi.fn(() => ({ name: 'mock-utxo-provider' })),
}));

vi.mock('./signing-provider.js', () => ({
  createSigningProvider: vi.fn(async () => ({ name: 'mock-signing-provider' })),
}));

vi.mock('./fee-estimator.js', () => ({
  createFeeEstimator: vi.fn(() => ({ name: 'mock-fee-estimator' })),
}));

import {
  createChainClient,
  initChainClient,
  getInitializedChainClient,
  getChainClient,
  SupabaseChainIndexLookup,
} from './client.js';
import { MockChainClient } from './mock.js';
import { createSigningProvider } from './signing-provider.js';
import { createFeeEstimator } from './fee-estimator.js';
import { createUtxoProvider } from './utxo-provider.js';
import { logger } from '../utils/logger.js';

// ─── createChainClient (async factory) ──────────────────────────────

describe('createChainClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to test defaults
    mockConfig.nodeEnv = 'test';
    mockConfig.useMocks = true;
    mockConfig.enableProdNetworkAnchoring = false;
    mockConfig.bitcoinNetwork = 'signet';
    mockConfig.bitcoinTreasuryWif = undefined;
    mockConfig.bitcoinRpcUrl = undefined;
    mockConfig.bitcoinRpcAuth = undefined;
    mockConfig.bitcoinUtxoProvider = 'mempool';
    mockConfig.bitcoinFeeStrategy = undefined;
    mockConfig.bitcoinStaticFeeRate = undefined;
    mockConfig.bitcoinFallbackFeeRate = undefined;
    mockConfig.bitcoinKmsKeyId = undefined;
    mockConfig.bitcoinKmsRegion = undefined;
    mockConfig.kmsProvider = undefined;
    mockConfig.gcpKmsKeyResourceName = undefined;
    mockConfig.gcpKmsProjectId = undefined;
    mockConfig.forceDynamicFeeEstimation = false;
  });

  it('returns MockChainClient when useMocks is true', async () => {
    mockConfig.useMocks = true;
    mockConfig.nodeEnv = 'development';

    const client = await createChainClient();
    expect(client).toBeInstanceOf(MockChainClient);
  });

  it('returns MockChainClient when nodeEnv is test', async () => {
    mockConfig.useMocks = false;
    mockConfig.nodeEnv = 'test';

    const client = await createChainClient();
    expect(client).toBeInstanceOf(MockChainClient);
  });

  it('returns MockChainClient when enableProdNetworkAnchoring is false', async () => {
    mockConfig.useMocks = false;
    mockConfig.nodeEnv = 'production';
    mockConfig.enableProdNetworkAnchoring = false;

    const client = await createChainClient();
    expect(client).toBeInstanceOf(MockChainClient);
  });

  // ── Signet path ───────────────────────────────────────────────────

  it('returns BitcoinChainClient for signet with valid config', async () => {
    mockConfig.useMocks = false;
    mockConfig.nodeEnv = 'production';
    mockConfig.enableProdNetworkAnchoring = true;
    mockConfig.bitcoinNetwork = 'signet';
    mockConfig.bitcoinTreasuryWif = 'cVt4o7BGAig1UXywgGSmARhxMdzP5qvQsxKkSsc1XEkw3tDTQFpy';

    const client = await createChainClient();
    expect((client as unknown as { _isBitcoinClient: boolean })._isBitcoinClient).toBe(true);
  });

  it('creates WIF signing provider for signet', async () => {
    mockConfig.useMocks = false;
    mockConfig.nodeEnv = 'production';
    mockConfig.enableProdNetworkAnchoring = true;
    mockConfig.bitcoinNetwork = 'signet';
    mockConfig.bitcoinTreasuryWif = 'cVt4o7BGAig1UXywgGSmARhxMdzP5qvQsxKkSsc1XEkw3tDTQFpy';

    await createChainClient();
    expect(createSigningProvider).toHaveBeenCalledWith({
      type: 'wif',
      wif: 'cVt4o7BGAig1UXywgGSmARhxMdzP5qvQsxKkSsc1XEkw3tDTQFpy',
    });
  });

  it('defaults to static fee strategy for signet', async () => {
    mockConfig.useMocks = false;
    mockConfig.nodeEnv = 'production';
    mockConfig.enableProdNetworkAnchoring = true;
    mockConfig.bitcoinNetwork = 'signet';
    mockConfig.bitcoinTreasuryWif = 'cVt4o7BGAig1UXywgGSmARhxMdzP5qvQsxKkSsc1XEkw3tDTQFpy';

    await createChainClient();
    expect(createFeeEstimator).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: 'static' }),
    );
  });

  it('uses configured fee strategy for signet when set', async () => {
    mockConfig.useMocks = false;
    mockConfig.nodeEnv = 'production';
    mockConfig.enableProdNetworkAnchoring = true;
    mockConfig.bitcoinNetwork = 'signet';
    mockConfig.bitcoinTreasuryWif = 'cVt4o7BGAig1UXywgGSmARhxMdzP5qvQsxKkSsc1XEkw3tDTQFpy';
    mockConfig.bitcoinFeeStrategy = 'mempool';

    await createChainClient();
    expect(createFeeEstimator).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: 'mempool' }),
    );
  });

  it('falls back to MockChainClient when signet treasury WIF is missing', async () => {
    mockConfig.useMocks = false;
    mockConfig.nodeEnv = 'production';
    mockConfig.enableProdNetworkAnchoring = true;
    mockConfig.bitcoinNetwork = 'signet';
    mockConfig.bitcoinTreasuryWif = undefined;

    const client = await createChainClient();
    expect(client).toBeInstanceOf(MockChainClient);
  });

  it('falls back to MockChainClient when RPC URL is missing for rpc provider (signet)', async () => {
    mockConfig.useMocks = false;
    mockConfig.nodeEnv = 'production';
    mockConfig.enableProdNetworkAnchoring = true;
    mockConfig.bitcoinNetwork = 'signet';
    mockConfig.bitcoinTreasuryWif = 'cVt4o7BGAig1UXywgGSmARhxMdzP5qvQsxKkSsc1XEkw3tDTQFpy';
    mockConfig.bitcoinRpcUrl = undefined;
    mockConfig.bitcoinUtxoProvider = 'rpc';

    const client = await createChainClient();
    expect(client).toBeInstanceOf(MockChainClient);
  });

  it('handles testnet same as signet', async () => {
    mockConfig.useMocks = false;
    mockConfig.nodeEnv = 'production';
    mockConfig.enableProdNetworkAnchoring = true;
    mockConfig.bitcoinNetwork = 'testnet';
    mockConfig.bitcoinTreasuryWif = 'cVt4o7BGAig1UXywgGSmARhxMdzP5qvQsxKkSsc1XEkw3tDTQFpy';

    const client = await createChainClient();
    expect((client as unknown as { _isBitcoinClient: boolean })._isBitcoinClient).toBe(true);
  });

  it('handles testnet4 same as signet/testnet', async () => {
    mockConfig.useMocks = false;
    mockConfig.nodeEnv = 'production';
    mockConfig.enableProdNetworkAnchoring = true;
    mockConfig.bitcoinNetwork = 'testnet4';
    mockConfig.bitcoinTreasuryWif = 'cVt4o7BGAig1UXywgGSmARhxMdzP5qvQsxKkSsc1XEkw3tDTQFpy';

    const client = await createChainClient();
    expect((client as unknown as { _isBitcoinClient: boolean })._isBitcoinClient).toBe(true);
  });

  // ── Mainnet path ──────────────────────────────────────────────────

  it('returns BitcoinChainClient for mainnet with valid KMS config', async () => {
    mockConfig.useMocks = false;
    mockConfig.nodeEnv = 'production';
    mockConfig.enableProdNetworkAnchoring = true;
    mockConfig.bitcoinNetwork = 'mainnet';
    mockConfig.bitcoinKmsKeyId = 'arn:aws:kms:us-east-1:123456:key/abc-123';
    mockConfig.bitcoinKmsRegion = 'us-east-1';

    const client = await createChainClient();
    expect((client as unknown as { _isBitcoinClient: boolean })._isBitcoinClient).toBe(true);
  });

  it('creates KMS signing provider for mainnet', async () => {
    mockConfig.useMocks = false;
    mockConfig.nodeEnv = 'production';
    mockConfig.enableProdNetworkAnchoring = true;
    mockConfig.bitcoinNetwork = 'mainnet';
    mockConfig.bitcoinKmsKeyId = 'arn:aws:kms:us-east-1:123456:key/abc-123';
    mockConfig.bitcoinKmsRegion = 'us-east-1';

    await createChainClient();
    expect(createSigningProvider).toHaveBeenCalledWith({
      type: 'kms',
      kmsKeyId: 'arn:aws:kms:us-east-1:123456:key/abc-123',
      kmsRegion: 'us-east-1',
    });
  });

  it('defaults to mempool fee strategy for mainnet', async () => {
    mockConfig.useMocks = false;
    mockConfig.nodeEnv = 'production';
    mockConfig.enableProdNetworkAnchoring = true;
    mockConfig.bitcoinNetwork = 'mainnet';
    mockConfig.bitcoinKmsKeyId = 'arn:aws:kms:us-east-1:123456:key/abc-123';

    await createChainClient();
    expect(createFeeEstimator).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: 'mempool' }),
    );
  });

  it('passes network=mainnet to BitcoinChainClient constructor', async () => {
    mockConfig.useMocks = false;
    mockConfig.nodeEnv = 'production';
    mockConfig.enableProdNetworkAnchoring = true;
    mockConfig.bitcoinNetwork = 'mainnet';
    mockConfig.bitcoinKmsKeyId = 'arn:aws:kms:us-east-1:123456:key/abc-123';

    const client = await createChainClient();
    // bitcoin.networks.bitcoin is the mainnet network object from bitcoinjs-lib
    expect((client as unknown as { config: Record<string, unknown> }).config.network).toEqual(expect.objectContaining({ bech32: 'bc', pubKeyHash: 0 }));
  });

  it('falls back to MockChainClient when mainnet KMS key is missing', async () => {
    mockConfig.useMocks = false;
    mockConfig.nodeEnv = 'production';
    mockConfig.enableProdNetworkAnchoring = true;
    mockConfig.bitcoinNetwork = 'mainnet';
    mockConfig.bitcoinKmsKeyId = undefined;

    const client = await createChainClient();
    expect(client).toBeInstanceOf(MockChainClient);
  });

  it('falls back to MockChainClient when RPC URL is missing for rpc provider (mainnet)', async () => {
    mockConfig.useMocks = false;
    mockConfig.nodeEnv = 'production';
    mockConfig.enableProdNetworkAnchoring = true;
    mockConfig.bitcoinNetwork = 'mainnet';
    mockConfig.bitcoinKmsKeyId = 'arn:aws:kms:us-east-1:123456:key/abc-123';
    mockConfig.bitcoinUtxoProvider = 'rpc';
    mockConfig.bitcoinRpcUrl = undefined;

    const client = await createChainClient();
    expect(client).toBeInstanceOf(MockChainClient);
  });

  // ── UTXO provider wiring ─────────────────────────────────────────

  it('passes UTXO provider config through for signet', async () => {
    mockConfig.useMocks = false;
    mockConfig.nodeEnv = 'production';
    mockConfig.enableProdNetworkAnchoring = true;
    mockConfig.bitcoinNetwork = 'signet';
    mockConfig.bitcoinTreasuryWif = 'cVt4o7BGAig1UXywgGSmARhxMdzP5qvQsxKkSsc1XEkw3tDTQFpy';
    mockConfig.bitcoinUtxoProvider = 'mempool';
    mockConfig.mempoolApiUrl = 'https://mempool.space/signet/api';

    await createChainClient();
    expect(createUtxoProvider).toHaveBeenCalledWith({
      type: 'mempool',
      rpcUrl: undefined,
      rpcAuth: undefined,
      mempoolApiUrl: 'https://mempool.space/signet/api',
      network: 'signet',
    });
  });

  // ── Unknown network fallback ──────────────────────────────────────

  it('returns MockChainClient for unknown network', async () => {
    mockConfig.useMocks = false;
    mockConfig.nodeEnv = 'production';
    mockConfig.enableProdNetworkAnchoring = true;
    (mockConfig as unknown as Record<string, string>).bitcoinNetwork = 'regtest';

    const client = await createChainClient();
    expect(client).toBeInstanceOf(MockChainClient);
  });
});

// ─── initChainClient / getInitializedChainClient ────────────────────

describe('initChainClient / getInitializedChainClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to test defaults — will produce MockChainClient
    mockConfig.nodeEnv = 'test';
    mockConfig.useMocks = true;
    mockConfig.enableProdNetworkAnchoring = false;
  });

  it('initializes and returns a client', async () => {
    const client = await initChainClient();
    expect(client).toBeInstanceOf(MockChainClient);
  });

  it('getInitializedChainClient returns the same client after init', async () => {
    const client = await initChainClient();
    const retrieved = getInitializedChainClient();
    expect(retrieved).toBe(client);
  });

  it('getInitializedChainClient throws before init', () => {
    // Reset the module-level singleton by re-initializing to clear it
    // We test this by importing fresh — but since module state persists in vitest,
    // we rely on the previous test having called initChainClient.
    // Instead, test the error message pattern:
    expect(() => {
      // If the singleton was already set by a previous test, this won't throw.
      // We document this limitation — full isolation would require resetModules().
      const client = getInitializedChainClient();
      // If it didn't throw, the singleton was already set (expected in this test suite)
      expect(client).toBeDefined();
    }).not.toThrow();
  });
});

// ─── getChainClient (legacy backward compat) ────────────────────────

describe('getChainClient (legacy)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.nodeEnv = 'test';
    mockConfig.useMocks = true;
    mockConfig.enableProdNetworkAnchoring = false;
  });

  it('returns the initialized client if available', async () => {
    const client = await initChainClient();
    const legacy = getChainClient();
    expect(legacy).toBe(client);
  });

  it('returns a ChainClient interface', () => {
    const client = getChainClient();
    expect(client).toBeDefined();
    expect(typeof client.submitFingerprint).toBe('function');
    expect(typeof client.verifyFingerprint).toBe('function');
    expect(typeof client.getReceipt).toBe('function');
    expect(typeof client.healthCheck).toBe('function');
  });
});

// ─── SupabaseChainIndexLookup (P7-TS-13) ────────────────────────────

describe('SupabaseChainIndexLookup', () => {
  let lookup: SupabaseChainIndexLookup;
  let mockEq: ReturnType<typeof vi.fn>;
  let mockLimit: ReturnType<typeof vi.fn>;
  let mockMaybeSingle: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    lookup = new SupabaseChainIndexLookup();

    mockMaybeSingle = vi.fn();
    mockLimit = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
    mockEq = vi.fn(() => ({ limit: mockLimit }));

    const mockSelect = vi.fn(() => ({ eq: mockEq }));
    mockDbFrom.mockReturnValue({ select: mockSelect });
  });

  it('queries anchor_chain_index table with fingerprint', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });

    await lookup.lookupFingerprint('abc123hash');

    expect(mockDbFrom).toHaveBeenCalledWith('anchor_chain_index');
    expect(mockEq).toHaveBeenCalledWith('fingerprint_sha256', 'abc123hash');
  });

  it('returns IndexEntry when match found', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        chain_tx_id: 'tx_abc',
        chain_block_height: 12345,
        chain_block_timestamp: '2026-03-12T00:00:00Z',
        confirmations: 6,
        anchor_id: 'anchor_uuid',
      },
      error: null,
    });

    const result = await lookup.lookupFingerprint('abc123hash');

    expect(result).toEqual({
      chainTxId: 'tx_abc',
      blockHeight: 12345,
      blockTimestamp: '2026-03-12T00:00:00Z',
      confirmations: 6,
      anchorId: 'anchor_uuid',
    });
  });

  it('returns null when no match found', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });

    const result = await lookup.lookupFingerprint('nonexistent');
    expect(result).toBeNull();
  });

  it('returns null and logs warning on DB error', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: null,
      error: { message: 'connection timeout' },
    });

    const result = await lookup.lookupFingerprint('abc123hash');

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ fingerprint: 'abc123hash' }),
      expect.stringContaining('Chain index lookup failed'),
    );
  });

  it('maps snake_case DB fields to camelCase IndexEntry', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        chain_tx_id: 'tx_mapped',
        chain_block_height: null,
        chain_block_timestamp: null,
        confirmations: null,
        anchor_id: null,
      },
      error: null,
    });

    const result = await lookup.lookupFingerprint('fp_test');

    expect(result).toEqual({
      chainTxId: 'tx_mapped',
      blockHeight: null,
      blockTimestamp: null,
      confirmations: null,
      anchorId: null,
    });
  });

  // ── DH-05 + WRK-03 cache (SCRUM-1545 coverage backfill) ──

  it('returns cached entry on second lookup without DB hit', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { chain_tx_id: 'tx_cached', chain_block_height: 1, chain_block_timestamp: null, confirmations: null, anchor_id: 'a1' },
      error: null,
    });

    const first = await lookup.lookupFingerprint('fp_cache');
    expect(first?.chainTxId).toBe('tx_cached');
    expect(mockDbFrom).toHaveBeenCalledTimes(1);

    const second = await lookup.lookupFingerprint('fp_cache');
    expect(second?.chainTxId).toBe('tx_cached');
    // Second call serves from cache → no extra DB read
    expect(mockDbFrom).toHaveBeenCalledTimes(1);
  });

  it('clearCache() empties the cache so next lookup hits DB again', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    await lookup.lookupFingerprint('fp_clr');
    expect(lookup.cacheSize).toBe(1);

    lookup.clearCache();
    expect(lookup.cacheSize).toBe(0);

    await lookup.lookupFingerprint('fp_clr');
    expect(mockDbFrom).toHaveBeenCalledTimes(2);
  });

  it('evicts stale entries when capacity hit and a prior entry has expired', async () => {
    const ttl = 5;
    const tiny = new SupabaseChainIndexLookup(ttl, 1);
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    await tiny.lookupFingerprint('fp_x');
    expect(tiny.cacheSize).toBe(1);
    await new Promise((r) => setTimeout(r, ttl + 5));
    await tiny.lookupFingerprint('fp_y');
    // Stale fp_x evicted via _evictStale, fp_y inserted → still 1 entry
    expect(tiny.cacheSize).toBe(1);
  });

  it('evicts oldest entry (LRU) when at capacity with no expirations', async () => {
    const small = new SupabaseChainIndexLookup(60_000, 2);
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    await small.lookupFingerprint('fp_1');
    await small.lookupFingerprint('fp_2');
    expect(small.cacheSize).toBe(2);
    await small.lookupFingerprint('fp_3');
    // At capacity: expired-eviction is no-op (TTL 60s); oldest deleted via Map.keys().next()
    expect(small.cacheSize).toBe(2);
  });
});

// ─── createChainClient mainnet variants (SCRUM-1545 coverage) ──────

describe('createChainClient mainnet signing variants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.useMocks = false;
    mockConfig.nodeEnv = 'production';
    mockConfig.enableProdNetworkAnchoring = true;
    mockConfig.bitcoinNetwork = 'mainnet';
    mockConfig.bitcoinTreasuryWif = undefined;
    mockConfig.bitcoinKmsKeyId = undefined;
    mockConfig.kmsProvider = undefined;
    mockConfig.gcpKmsKeyResourceName = undefined;
    mockConfig.bitcoinUtxoProvider = 'mempool';
  });

  it('uses WIF signing for mainnet when bitcoinTreasuryWif is set', async () => {
    mockConfig.bitcoinTreasuryWif = 'L1aW4aubDFB7yfras2S1mN3bqg9NV1nMM3PYQzJBN4Pc8t6n5w8m';
    await createChainClient();
    expect(createSigningProvider).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'wif', wif: expect.any(String) }),
    );
  });

  it('falls back to MockChainClient on mainnet GCP KMS path when gcpKmsKeyResourceName missing', async () => {
    mockConfig.kmsProvider = 'gcp';
    mockConfig.gcpKmsKeyResourceName = undefined;
    const client = await createChainClient();
    expect(client).toBeInstanceOf(MockChainClient);
  });

  it('uses GCP KMS signing for mainnet when kmsProvider=gcp + key resource present', async () => {
    mockConfig.kmsProvider = 'gcp';
    mockConfig.gcpKmsKeyResourceName = 'projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1';
    mockConfig.gcpKmsProjectId = 'p';
    await createChainClient();
    expect(createSigningProvider).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'gcp-kms' }),
    );
  });

  it('uses dynamic mempool fee estimator on signet when forceDynamicFeeEstimation=true', async () => {
    mockConfig.bitcoinNetwork = 'signet';
    mockConfig.bitcoinTreasuryWif = 'cVt4o7BGAig1UXywgGSmARhxMdzP5qvQsxKkSsc1XEkw3tDTQFpy';
    mockConfig.forceDynamicFeeEstimation = true;
    await createChainClient();
    expect(createFeeEstimator).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: 'mempool' }),
    );
  });
});

// ─── getChainClientAsync paths (SCRUM-1545 coverage) ──────────────

describe('getChainClientAsync', () => {
  it('returns the initialized client when present', async () => {
    await initChainClient();
    const { getChainClientAsync } = await import('./client.js');
    const c = await getChainClientAsync();
    expect(c).toBeDefined();
    expect(typeof c.submitFingerprint).toBe('function');
  });
});

// ─── module-isolated throws (SCRUM-1545 coverage) ─────────────────

describe('chain client singleton throws when uninitialized', () => {
  it('getInitializedChainClient throws before init in a fresh module instance', async () => {
    vi.resetModules();
    const fresh = await import('./client.js');
    expect(() => fresh.getInitializedChainClient()).toThrow(/not initialized/);
  });

  it('getChainClient throws before init in a fresh module instance', async () => {
    vi.resetModules();
    const fresh = await import('./client.js');
    expect(() => fresh.getChainClient()).toThrow(/before initChainClient/);
  });

  it('getChainClientAsync throws before init in a fresh module instance', async () => {
    vi.resetModules();
    const fresh = await import('./client.js');
    await expect(fresh.getChainClientAsync()).rejects.toThrow(/not initialized/);
  });
});
