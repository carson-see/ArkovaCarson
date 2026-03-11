/**
 * Unit tests for SignetChainClient
 *
 * CRIT-2 / P7-TS-05: Tests for OP_RETURN transaction construction,
 * RPC interactions, receipt parsing, and error handling.
 *
 * All network calls are mocked — Constitution requires no real
 * Stripe or Bitcoin API calls in tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as bitcoin from 'bitcoinjs-lib';

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock fetch for all RPC calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { SignetChainClient, buildOpReturnTransaction, type SignetConfig } from './signet.js';

// Test WIF for Signet/testnet (this is a throwaway key, not real funds)
const TEST_WIF = 'cVt4o7BGAig1UXywgGSmARhxMdzP5qvQsxKkSsc1XEkw3tDTQFpy';
const TEST_FINGERPRINT = 'a'.repeat(64); // Valid 64-char hex

const defaultConfig: SignetConfig = {
  treasuryWif: TEST_WIF,
  rpcUrl: 'http://localhost:38332',
};

function mockRpcResponse(result: unknown) {
  return {
    ok: true,
    json: () => Promise.resolve({ result, error: null }),
  };
}

function mockRpcError(message: string, code: number = -1) {
  return {
    ok: true,
    json: () => Promise.resolve({ result: null, error: { message, code } }),
  };
}

describe('buildOpReturnTransaction', () => {
  // We need a valid ECPair for transaction building
  let keyPair: any;

  beforeEach(async () => {
    const ecc = await import('tiny-secp256k1');
    const { ECPairFactory } = await import('ecpair');
    const ECPair = ECPairFactory(ecc);
    keyPair = ECPair.fromWIF(TEST_WIF, bitcoin.networks.testnet);
  });

  it('rejects invalid fingerprint (not 64-char hex)', () => {
    const utxo = { txid: 'a'.repeat(64), vout: 0, value: 100000, scriptPubKey: '00'.repeat(100) };
    expect(() => buildOpReturnTransaction('invalid', utxo, keyPair)).toThrow(
      'Fingerprint must be a 64-character hex string',
    );
  });

  it('rejects fingerprint that is too short', () => {
    const utxo = { txid: 'a'.repeat(64), vout: 0, value: 100000, scriptPubKey: '00'.repeat(100) };
    expect(() => buildOpReturnTransaction('abcd', utxo, keyPair)).toThrow(
      'Fingerprint must be a 64-character hex string',
    );
  });

  it('rejects insufficient funds', () => {
    const utxo = { txid: 'a'.repeat(64), vout: 0, value: 1, scriptPubKey: '00'.repeat(100) };
    expect(() => buildOpReturnTransaction(TEST_FINGERPRINT, utxo, keyPair)).toThrow(
      'Insufficient funds',
    );
  });
});

describe('SignetChainClient constructor', () => {
  it('initializes with valid WIF', () => {
    const client = new SignetChainClient(defaultConfig);
    expect(client).toBeDefined();
  });

  it('throws on invalid WIF', () => {
    expect(
      () => new SignetChainClient({ ...defaultConfig, treasuryWif: 'invalid-wif' }),
    ).toThrow('Invalid BITCOIN_TREASURY_WIF');
  });

  it('throws on empty WIF', () => {
    expect(
      () => new SignetChainClient({ ...defaultConfig, treasuryWif: '' }),
    ).toThrow();
  });
});

describe('SignetChainClient.healthCheck', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns true when connected to signet', async () => {
    mockFetch.mockResolvedValueOnce(
      mockRpcResponse({ chain: 'signet', blocks: 150000 }),
    );

    const client = new SignetChainClient(defaultConfig);
    const healthy = await client.healthCheck();
    expect(healthy).toBe(true);
  });

  it('returns true when connected to test network', async () => {
    mockFetch.mockResolvedValueOnce(
      mockRpcResponse({ chain: 'test', blocks: 2500000 }),
    );

    const client = new SignetChainClient(defaultConfig);
    const healthy = await client.healthCheck();
    expect(healthy).toBe(true);
  });

  it('returns false when connected to mainnet', async () => {
    mockFetch.mockResolvedValueOnce(
      mockRpcResponse({ chain: 'main', blocks: 800000 }),
    );

    const client = new SignetChainClient(defaultConfig);
    const healthy = await client.healthCheck();
    expect(healthy).toBe(false);
  });

  it('returns false on RPC error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

    const client = new SignetChainClient(defaultConfig);
    const healthy = await client.healthCheck();
    expect(healthy).toBe(false);
  });

  it('returns false on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
    });

    const client = new SignetChainClient(defaultConfig);
    const healthy = await client.healthCheck();
    expect(healthy).toBe(false);
  });
});

describe('SignetChainClient.submitFingerprint', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('throws when no UTXOs available', async () => {
    // listunspent returns empty array
    mockFetch.mockResolvedValueOnce(mockRpcResponse([]));

    const client = new SignetChainClient(defaultConfig);
    await expect(
      client.submitFingerprint({ fingerprint: TEST_FINGERPRINT, timestamp: new Date().toISOString() }),
    ).rejects.toThrow('No UTXOs available');
  });

  it('throws on RPC listunspent error', async () => {
    mockFetch.mockResolvedValueOnce(mockRpcError('Wallet not loaded', -18));

    const client = new SignetChainClient(defaultConfig);
    await expect(
      client.submitFingerprint({ fingerprint: TEST_FINGERPRINT, timestamp: new Date().toISOString() }),
    ).rejects.toThrow('RPC listunspent error');
  });

  it('includes auth header when rpcAuth is provided', async () => {
    const configWithAuth: SignetConfig = {
      ...defaultConfig,
      rpcAuth: 'user:pass',
    };

    mockFetch.mockResolvedValueOnce(mockRpcResponse([]));

    const client = new SignetChainClient(configWithAuth);
    try {
      await client.submitFingerprint({ fingerprint: TEST_FINGERPRINT, timestamp: new Date().toISOString() });
    } catch {
      // Expected to fail (no UTXOs) — we just check the fetch call
    }

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:38332',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: expect.stringContaining('Basic'),
        }),
      }),
    );
  });
});

describe('SignetChainClient.getReceipt', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns receipt for existing transaction', async () => {
    const txId = 'a'.repeat(64);

    // getrawtransaction
    mockFetch.mockResolvedValueOnce(
      mockRpcResponse({
        txid: txId,
        confirmations: 3,
        blocktime: 1710000000,
        blockhash: 'b'.repeat(64),
      }),
    );

    // getblockheader
    mockFetch.mockResolvedValueOnce(
      mockRpcResponse({ height: 150042 }),
    );

    const client = new SignetChainClient(defaultConfig);
    const receipt = await client.getReceipt(txId);

    expect(receipt).not.toBeNull();
    expect(receipt!.receiptId).toBe(txId);
    expect(receipt!.blockHeight).toBe(150042);
    expect(receipt!.confirmations).toBe(3);
  });

  it('returns null for non-existent transaction', async () => {
    mockFetch.mockResolvedValueOnce(
      mockRpcError('No such mempool or blockchain transaction', -5),
    );

    const client = new SignetChainClient(defaultConfig);
    const receipt = await client.getReceipt('nonexistent');
    expect(receipt).toBeNull();
  });
});

describe('SignetChainClient.verifyFingerprint', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns verified=false when fingerprint not found', async () => {
    // listtransactions returns empty
    mockFetch.mockResolvedValueOnce(mockRpcResponse([]));

    const client = new SignetChainClient(defaultConfig);
    const result = await client.verifyFingerprint(TEST_FINGERPRINT);

    expect(result.verified).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('returns verified=false on RPC error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

    const client = new SignetChainClient(defaultConfig);
    const result = await client.verifyFingerprint(TEST_FINGERPRINT);

    expect(result.verified).toBe(false);
    expect(result.error).toContain('Verification error');
  });
});
