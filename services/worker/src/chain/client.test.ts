/**
 * Unit tests for chain client factory (getChainClient)
 *
 * HARDENING-2 + CRIT-2: Verify the factory returns the correct client
 * based on configuration — MockChainClient for test/mock modes,
 * SignetChainClient when ENABLE_PROD_NETWORK_ANCHORING is true with
 * valid Bitcoin config, MockChainClient fallback otherwise.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist the mutable config so vi.mock factories can reference it
const { mockConfig } = vi.hoisted(() => {
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
    enableProdNetworkAnchoring: false,
    logLevel: 'info',
  };
  return { mockConfig };
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

// Mock SignetChainClient with a real class so `new SignetChainClient()` works
vi.mock('./signet.js', () => {
  class MockSignetChainClient {
    _isSignet = true; // marker for test assertions
    submitFingerprint = vi.fn();
    verifyFingerprint = vi.fn();
    getReceipt = vi.fn();
    healthCheck = vi.fn().mockResolvedValue(true);
  }
  return { SignetChainClient: MockSignetChainClient };
});

import { getChainClient } from './client.js';
import { MockChainClient } from './mock.js';
import type { ChainClient } from './types.js';

describe('getChainClient', () => {
  beforeEach(() => {
    // Reset to test defaults
    mockConfig.nodeEnv = 'test';
    mockConfig.useMocks = true;
    mockConfig.enableProdNetworkAnchoring = false;
    mockConfig.bitcoinNetwork = 'signet';
    mockConfig.bitcoinTreasuryWif = undefined;
    mockConfig.bitcoinRpcUrl = undefined;
  });

  it('returns a ChainClient interface', () => {
    const client: ChainClient = getChainClient();
    expect(client).toBeDefined();
    expect(typeof client.submitFingerprint).toBe('function');
    expect(typeof client.verifyFingerprint).toBe('function');
    expect(typeof client.getReceipt).toBe('function');
    expect(typeof client.healthCheck).toBe('function');
  });

  it('returns MockChainClient when useMocks is true', () => {
    mockConfig.useMocks = true;
    mockConfig.nodeEnv = 'development';

    const client = getChainClient();
    expect(client).toBeInstanceOf(MockChainClient);
  });

  it('returns MockChainClient when nodeEnv is test', () => {
    mockConfig.useMocks = false;
    mockConfig.nodeEnv = 'test';

    const client = getChainClient();
    expect(client).toBeInstanceOf(MockChainClient);
  });

  it('returns MockChainClient when enableProdNetworkAnchoring is false', () => {
    mockConfig.useMocks = false;
    mockConfig.nodeEnv = 'production';
    mockConfig.enableProdNetworkAnchoring = false;

    const client = getChainClient();
    expect(client).toBeInstanceOf(MockChainClient);
  });

  it('returns SignetChainClient when feature flag is on and config is valid', () => {
    mockConfig.useMocks = false;
    mockConfig.nodeEnv = 'production';
    mockConfig.enableProdNetworkAnchoring = true;
    mockConfig.bitcoinNetwork = 'signet';
    mockConfig.bitcoinTreasuryWif = 'cVt4o7BGAig1UXywgGSmARhxMdzP5qvQsxKkSsc1XEkw3tDTQFpy';
    mockConfig.bitcoinRpcUrl = 'http://localhost:38332';

    const client = getChainClient();
    // Should be the mocked SignetChainClient (has _isSignet marker)
    expect((client as any)._isSignet).toBe(true);
  });

  it('falls back to MockChainClient when treasury WIF is missing', () => {
    mockConfig.useMocks = false;
    mockConfig.nodeEnv = 'production';
    mockConfig.enableProdNetworkAnchoring = true;
    mockConfig.bitcoinNetwork = 'signet';
    mockConfig.bitcoinTreasuryWif = undefined;
    mockConfig.bitcoinRpcUrl = 'http://localhost:38332';

    const client = getChainClient();
    expect(client).toBeInstanceOf(MockChainClient);
  });

  it('falls back to MockChainClient when RPC URL is missing for rpc provider', () => {
    mockConfig.useMocks = false;
    mockConfig.nodeEnv = 'production';
    mockConfig.enableProdNetworkAnchoring = true;
    mockConfig.bitcoinNetwork = 'signet';
    mockConfig.bitcoinTreasuryWif = 'cVt4o7BGAig1UXywgGSmARhxMdzP5qvQsxKkSsc1XEkw3tDTQFpy';
    mockConfig.bitcoinRpcUrl = undefined;
    mockConfig.bitcoinUtxoProvider = 'rpc';

    const client = getChainClient();
    expect(client).toBeInstanceOf(MockChainClient);
  });

  it('falls back to MockChainClient for mainnet (not yet implemented)', () => {
    mockConfig.useMocks = false;
    mockConfig.nodeEnv = 'production';
    mockConfig.enableProdNetworkAnchoring = true;
    mockConfig.bitcoinNetwork = 'mainnet';
    mockConfig.bitcoinTreasuryWif = 'L1aW4aubDFB7yfDzZ';
    mockConfig.bitcoinRpcUrl = 'http://localhost:8332';

    const client = getChainClient();
    expect(client).toBeInstanceOf(MockChainClient);
  });

  it('returns a new instance on each call', () => {
    const client1 = getChainClient();
    const client2 = getChainClient();
    expect(client1).not.toBe(client2);
  });
});
