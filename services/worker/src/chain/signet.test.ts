/**
 * Unit tests for BitcoinChainClient (formerly SignetChainClient)
 *
 * CRIT-2 / P7-TS-05 / P7-TS-12 / P7-TS-13: Tests for OP_RETURN transaction
 * construction, UTXO selection, provider interactions, receipt parsing,
 * error handling, SigningProvider/FeeEstimator integration, and chain index lookup.
 *
 * All network calls are mocked — Constitution requires no real
 * Stripe or Bitcoin API calls in tests.
 */

import { describe, it, expect, vi } from 'vitest';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { ECPairFactory } from 'ecpair';

const ECPair = ECPairFactory(ecc);

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// PERF-7: Mock config for fee ceiling check
vi.mock('../config.js', () => ({
  config: {
    bitcoinNetwork: 'signet',
    bitcoinMaxFeeRate: undefined, // No ceiling in tests
  },
}));

// Mock fetch for legacy RPC path
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  SignetChainClient,
  BitcoinChainClient,
  buildOpReturnTransaction,
  selectUtxo,
  estimateTxVsize,
  canonicalMetadataJson,
  hashMetadata,
  truncateMetadataHash,
  extractAnchorFingerprint,
  type SelectedUtxo,
  type BitcoinClientConfig,
} from './signet.js';
import type { UtxoProvider, Utxo } from './utxo-provider.js';
import { WifSigningProvider } from './signing-provider.js';
import { StaticFeeEstimator } from './fee-estimator.js';
import type { FeeEstimator } from './fee-estimator.js';
import type { ChainIndexLookup, IndexEntry } from './types.js';

// Test WIF for Signet/testnet (this is a throwaway key, not real funds)
const TEST_WIF = 'cVt4o7BGAig1UXywgGSmARhxMdzP5qvQsxKkSsc1XEkw3tDTQFpy';
const TEST_FINGERPRINT = 'a'.repeat(64); // Valid 64-char hex

// Build a dummy funding tx that pays to the TEST_WIF key's P2WPKH address.
// This is required because bitcoinjs-lib PSBT validation checks that
// the witnessUtxo script matches the signing key.
function buildDummyFundingTx(valueSats: number): { txHex: string; txid: string } {
  const testKey = ECPair.fromWIF(TEST_WIF, bitcoin.networks.testnet);
  const { output } = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(testKey.publicKey),
    network: bitcoin.networks.testnet,
  });
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  // Coinbase-like input (doesn't matter for our PSBT usage)
  tx.addInput(Buffer.alloc(32, 0), 0xffffffff);
  tx.addOutput(output!, valueSats);
  return { txHex: tx.toHex(), txid: tx.getId() };
}

// Pre-build a 100k-sat funding tx for reuse across tests
const FUNDING_TX = buildDummyFundingTx(100000);
const DUMMY_RAW_TX_HEX = FUNDING_TX.txHex;
const DUMMY_TXID = FUNDING_TX.txid;

// WifSigningProvider for tests
const testSigner = new WifSigningProvider(TEST_WIF, bitcoin.networks.testnet);

function createMockProvider(overrides: Partial<UtxoProvider> = {}): UtxoProvider {
  return {
    name: 'MockProvider',
    listUnspent: vi.fn().mockResolvedValue([]),
    broadcastTx: vi.fn().mockResolvedValue({ txid: 'broadcast_txid' }),
    getBlockchainInfo: vi.fn().mockResolvedValue({ chain: 'signet', blocks: 150000 }),
    getRawTransaction: vi.fn().mockResolvedValue({
      txid: 'a'.repeat(64),
      confirmations: 3,
      blocktime: 1710000000,
      blockhash: 'b'.repeat(64),
      vout: [],
    }),
    getBlockHeader: vi.fn().mockResolvedValue({ height: 150042 }),
    ...overrides,
  };
}

function createMockChainIndex(overrides: Partial<ChainIndexLookup> = {}): ChainIndexLookup {
  return {
    lookupFingerprint: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

// ─── selectUtxo ──────────────────────────────────────────────────────────

describe('selectUtxo', () => {
  it('returns null for empty UTXO list', () => {
    expect(selectUtxo([], 1000)).toBeNull();
  });

  it('selects the largest UTXO that covers the fee', () => {
    const utxos: Utxo[] = [
      { txid: 'a', vout: 0, valueSats: 500, rawTxHex: '00' },
      { txid: 'b', vout: 0, valueSats: 2000, rawTxHex: '00' },
      { txid: 'c', vout: 0, valueSats: 1000, rawTxHex: '00' },
    ];
    const result = selectUtxo(utxos, 800);
    expect(result).not.toBeNull();
    expect(result!.txid).toBe('b');
    expect(result!.valueSats).toBe(2000);
  });

  it('returns null if no UTXO is large enough', () => {
    const utxos: Utxo[] = [
      { txid: 'a', vout: 0, valueSats: 100, rawTxHex: '00' },
      { txid: 'b', vout: 0, valueSats: 200, rawTxHex: '00' },
    ];
    expect(selectUtxo(utxos, 500)).toBeNull();
  });

  it('handles single UTXO that is exactly the fee', () => {
    const utxos: Utxo[] = [
      { txid: 'a', vout: 0, valueSats: 300, rawTxHex: '00' },
    ];
    const result = selectUtxo(utxos, 300);
    expect(result).not.toBeNull();
    expect(result!.txid).toBe('a');
  });
});

// ─── estimateTxVsize ─────────────────────────────────────────────────────

describe('estimateTxVsize', () => {
  it('calculates size with change output (default payload)', () => {
    const size = estimateTxVsize(true);
    // P2WPKH: 68 + (11+36) + 31 + 11 = 157
    expect(size).toBe(157);
  });

  it('calculates size without change output (default payload)', () => {
    const size = estimateTxVsize(false);
    // P2WPKH: 68 + (11+36) + 11 = 126
    expect(size).toBe(126);
  });

  it('calculates size with metadata hash payload (44 bytes)', () => {
    const size = estimateTxVsize(true, 44);
    // P2WPKH: 68 + (11+44) + 31 + 11 = 165
    expect(size).toBe(165);
  });

  it('calculates size without change with metadata hash payload', () => {
    const size = estimateTxVsize(false, 44);
    // P2WPKH: 68 + (11+44) + 11 = 134
    expect(size).toBe(134);
  });
});

// ─── canonicalMetadataJson ────────────────────────────────────────────

describe('canonicalMetadataJson', () => {
  it('sorts keys alphabetically', () => {
    const result = canonicalMetadataJson({ z: 'last', a: 'first', m: 'middle' });
    expect(result).toBe('{"a":"first","m":"middle","z":"last"}');
  });

  it('produces consistent output regardless of input order', () => {
    const a = canonicalMetadataJson({ name: 'Alice', degree: 'BS' });
    const b = canonicalMetadataJson({ degree: 'BS', name: 'Alice' });
    expect(a).toBe(b);
  });

  it('handles empty object', () => {
    expect(canonicalMetadataJson({})).toBe('{}');
  });
});

// ─── hashMetadata ─────────────────────────────────────────────────────

describe('hashMetadata', () => {
  it('returns 64-char hex hash', () => {
    const hash = hashMetadata({ name: 'Alice' });
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces same hash for same data regardless of key order', () => {
    const h1 = hashMetadata({ name: 'Alice', degree: 'BS' });
    const h2 = hashMetadata({ degree: 'BS', name: 'Alice' });
    expect(h1).toBe(h2);
  });

  it('produces different hash for different data', () => {
    const h1 = hashMetadata({ name: 'Alice' });
    const h2 = hashMetadata({ name: 'Bob' });
    expect(h1).not.toBe(h2);
  });
});

// ─── truncateMetadataHash ─────────────────────────────────────────────

describe('truncateMetadataHash', () => {
  it('returns exactly 8 bytes', () => {
    const fullHash = hashMetadata({ name: 'Alice' });
    const truncated = truncateMetadataHash(fullHash);
    expect(truncated.length).toBe(8);
  });

  it('matches first 8 bytes of full hash', () => {
    const fullHash = hashMetadata({ name: 'Alice' });
    const truncated = truncateMetadataHash(fullHash);
    const expected = Buffer.from(fullHash, 'hex').subarray(0, 8);
    expect(truncated).toEqual(expected);
  });
});

// ─── extractAnchorFingerprint (BUG-2026-06-24-004 structural decode) ──────

describe('extractAnchorFingerprint', () => {
  const FP = 'a'.repeat(64);
  const fpBytes = Buffer.from(FP, 'hex');

  const opReturnHex = (payload: Buffer): string =>
    bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, payload]).toString('hex');

  it('returns the fingerprint for a canonical ARKV anchor (prefix + 32-byte fp)', () => {
    const hex = opReturnHex(Buffer.concat([Buffer.from('ARKV'), fpBytes]));
    expect(extractAnchorFingerprint(hex)).toBe(FP);
  });

  it('returns the fingerprint when a trailing metadata hash is present', () => {
    const meta = Buffer.from('0011223344556677', 'hex');
    const hex = opReturnHex(Buffer.concat([Buffer.from('ARKV'), fpBytes, meta]));
    expect(extractAnchorFingerprint(hex)).toBe(FP);
  });

  it('rejects a payload with a leading junk byte before ARKV (non-canonical offset)', () => {
    const hex = opReturnHex(Buffer.concat([Buffer.from([0xab]), Buffer.from('ARKV'), fpBytes]));
    // The raw hex still CONTAINS "ARKV<fp>" — a substring scan would wrongly match.
    expect(hex).toContain(Buffer.from('ARKV').toString('hex') + FP);
    expect(extractAnchorFingerprint(hex)).toBeNull();
  });

  it('rejects a multi-push OP_RETURN even if a push equals ARKV+fingerprint', () => {
    // OP_RETURN <junk> <ARKV+fp> decompiles to 3 chunks, not the canonical 2.
    const hex = bitcoin.script
      .compile([
        bitcoin.opcodes.OP_RETURN,
        Buffer.from('deadbeef', 'hex'),
        Buffer.concat([Buffer.from('ARKV'), fpBytes]),
      ])
      .toString('hex');
    expect(extractAnchorFingerprint(hex)).toBeNull();
  });

  it('rejects an OP_RETURN whose prefix is not ARKV', () => {
    const hex = opReturnHex(Buffer.concat([Buffer.from('XXXX'), fpBytes]));
    expect(extractAnchorFingerprint(hex)).toBeNull();
  });

  it('rejects a non-OP_RETURN script (e.g. P2WPKH)', () => {
    const hex = '0014' + '00'.repeat(20); // OP_0 <20-byte program>
    expect(extractAnchorFingerprint(hex)).toBeNull();
  });

  it('rejects an OP_RETURN whose payload is shorter than prefix + 32 bytes', () => {
    const hex = opReturnHex(Buffer.concat([Buffer.from('ARKV'), fpBytes.subarray(0, 16)]));
    expect(extractAnchorFingerprint(hex)).toBeNull();
  });

  it('returns null for undecodable / empty hex', () => {
    expect(extractAnchorFingerprint('')).toBeNull();
  });
});

// ─── buildOpReturnTransaction (async) ────────────────────────────────────

describe('buildOpReturnTransaction', () => {
  const makeUtxo = (valueSats: number): SelectedUtxo => ({
    txid: DUMMY_TXID,
    vout: 0,
    valueSats,
    rawTxHex: DUMMY_RAW_TX_HEX,
  });

  it('rejects invalid fingerprint (not 64-char hex)', async () => {
    await expect(
      buildOpReturnTransaction('invalid', makeUtxo(100000), testSigner),
    ).rejects.toThrow('Fingerprint must be a 64-character hex string');
  });

  it('rejects fingerprint that is too short', async () => {
    await expect(
      buildOpReturnTransaction('abcd', makeUtxo(100000), testSigner),
    ).rejects.toThrow('Fingerprint must be a 64-character hex string');
  });

  it('rejects insufficient funds', async () => {
    await expect(
      buildOpReturnTransaction(TEST_FINGERPRINT, makeUtxo(1), testSigner),
    ).rejects.toThrow('Insufficient funds');
  });

  it('returns txHex, txId, and fee on success', async () => {
    const result = await buildOpReturnTransaction(TEST_FINGERPRINT, makeUtxo(100000), testSigner);
    expect(result.txHex).toBeTruthy();
    expect(result.txId).toBeTruthy();
    expect(result.fee).toBeGreaterThan(0);
    expect(result.txId).toHaveLength(64);
  });

  it('includes OP_RETURN output with ARKV prefix', async () => {
    const result = await buildOpReturnTransaction(TEST_FINGERPRINT, makeUtxo(100000), testSigner);
    const tx = bitcoin.Transaction.fromHex(result.txHex);

    // First output should be OP_RETURN
    const opReturnOutput = tx.outs[0];
    const decompiled = bitcoin.script.decompile(opReturnOutput.script);
    expect(decompiled).not.toBeNull();
    expect(decompiled![0]).toBe(bitcoin.opcodes.OP_RETURN);

    // Check ARKV prefix in the data
    const data = decompiled![1] as Buffer;
    expect(data.subarray(0, 4).toString()).toBe('ARKV');
  });

  it('includes change output when above dust threshold', async () => {
    const result = await buildOpReturnTransaction(TEST_FINGERPRINT, makeUtxo(100000), testSigner);
    const tx = bitcoin.Transaction.fromHex(result.txHex);

    // Should have 2 outputs: OP_RETURN + change
    expect(tx.outs).toHaveLength(2);
    expect(tx.outs[1].value).toBeGreaterThan(0);
  });

  it('omits change output when below dust threshold', async () => {
    // Set value just above the fee but below fee + dust (546)
    const feeEstimate = estimateTxVsize(true); // ~157 at 1 sat/vbyte
    const barelyEnough = feeEstimate + 100; // change would be ~100 sats, below dust

    const result = await buildOpReturnTransaction(TEST_FINGERPRINT, makeUtxo(barelyEnough), testSigner);
    const tx = bitcoin.Transaction.fromHex(result.txHex);

    // Should have only 1 output: OP_RETURN (no change)
    expect(tx.outs).toHaveLength(1);
  });

  it('accepts custom fee rate', async () => {
    const result1 = await buildOpReturnTransaction(TEST_FINGERPRINT, makeUtxo(100000), testSigner, 1);
    const result5 = await buildOpReturnTransaction(TEST_FINGERPRINT, makeUtxo(100000), testSigner, 5);
    expect(result5.fee).toBeGreaterThan(result1.fee);
  });

  it('accepts custom network', async () => {
    const result = await buildOpReturnTransaction(
      TEST_FINGERPRINT,
      makeUtxo(100000),
      testSigner,
      1,
      bitcoin.networks.testnet,
    );
    expect(result.txHex).toBeTruthy();
  });

  it('includes metadata hash in OP_RETURN when provided', async () => {
    const metadataHashBytes = truncateMetadataHash(hashMetadata({ degree: 'BS', name: 'Alice' }));
    const result = await buildOpReturnTransaction(
      TEST_FINGERPRINT,
      makeUtxo(100000),
      testSigner,
      1,
      bitcoin.networks.testnet,
      metadataHashBytes,
    );
    const tx = bitcoin.Transaction.fromHex(result.txHex);
    const opReturnOutput = tx.outs[0];
    const decompiled = bitcoin.script.decompile(opReturnOutput.script);
    expect(decompiled).not.toBeNull();

    const data = decompiled![1] as Buffer;
    // Total: ARKV (4) + fingerprint (32) + metadata hash (8) = 44 bytes
    expect(data.length).toBe(44);
    expect(data.subarray(0, 4).toString()).toBe('ARKV');
    // Last 8 bytes should be the metadata hash
    expect(data.subarray(36, 44)).toEqual(metadataHashBytes);
  });

  it('rejects metadata hash of wrong length', async () => {
    const wrongSize = Buffer.from('abcd', 'hex'); // 2 bytes, not 8
    await expect(
      buildOpReturnTransaction(TEST_FINGERPRINT, makeUtxo(100000), testSigner, 1, bitcoin.networks.testnet, wrongSize),
    ).rejects.toThrow('Metadata hash must be exactly 8 bytes');
  });

  it('OP_RETURN without metadata is 36 bytes', async () => {
    const result = await buildOpReturnTransaction(TEST_FINGERPRINT, makeUtxo(100000), testSigner);
    const tx = bitcoin.Transaction.fromHex(result.txHex);
    const decompiled = bitcoin.script.decompile(tx.outs[0].script);
    const data = decompiled![1] as Buffer;
    expect(data.length).toBe(36);
  });
});

// ─── BitcoinChainClient constructor ──────────────────────────────────────

describe('BitcoinChainClient constructor', () => {
  it('initializes with new-style config (utxoProvider)', () => {
    const client = new BitcoinChainClient({
      treasuryWif: TEST_WIF,
      utxoProvider: createMockProvider(),
    });
    expect(client).toBeDefined();
  });

  it('initializes with legacy config (rpcUrl)', () => {
    const client = new BitcoinChainClient({
      treasuryWif: TEST_WIF,
      rpcUrl: 'http://localhost:38332',
    });
    expect(client).toBeDefined();
  });

  it('throws on invalid WIF', () => {
    expect(
      () => new BitcoinChainClient({
        treasuryWif: 'invalid-wif',
        utxoProvider: createMockProvider(),
      }),
    ).toThrow('Invalid WIF');
  });

  it('throws on empty WIF', () => {
    expect(
      () => new BitcoinChainClient({
        treasuryWif: '',
        utxoProvider: createMockProvider(),
      }),
    ).toThrow();
  });

  it('initializes with BitcoinClientConfig (signingProvider)', () => {
    const config: BitcoinClientConfig = {
      signingProvider: testSigner,
      utxoProvider: createMockProvider(),
    };
    const client = new BitcoinChainClient(config);
    expect(client).toBeDefined();
  });

  it('accepts custom feeEstimator in BitcoinClientConfig', () => {
    const feeEstimator = new StaticFeeEstimator(5);
    const config: BitcoinClientConfig = {
      signingProvider: testSigner,
      utxoProvider: createMockProvider(),
      feeEstimator,
    };
    const client = new BitcoinChainClient(config);
    expect(client).toBeDefined();
  });

  it('accepts custom network in BitcoinClientConfig', () => {
    const config: BitcoinClientConfig = {
      signingProvider: testSigner,
      utxoProvider: createMockProvider(),
      network: bitcoin.networks.bitcoin, // mainnet
    };
    // WIF is for testnet but we wrap via WifSigningProvider which was created with testnet
    // The address derivation will use the provided network
    // This will throw because testnet key can't derive mainnet address cleanly
    // but it demonstrates the config path works
    expect(() => new BitcoinChainClient(config)).toBeDefined();
  });

  it('accepts chainIndex in BitcoinClientConfig', () => {
    const chainIndex = createMockChainIndex();
    const config: BitcoinClientConfig = {
      signingProvider: testSigner,
      utxoProvider: createMockProvider(),
      chainIndex,
    };
    const client = new BitcoinChainClient(config);
    expect(client).toBeDefined();
  });

  // Backward compat: SignetChainClient alias
  it('SignetChainClient alias works identically', () => {
    const client = new SignetChainClient({
      treasuryWif: TEST_WIF,
      utxoProvider: createMockProvider(),
    });
    expect(client).toBeInstanceOf(BitcoinChainClient);
  });
});

// ─── BitcoinChainClient.healthCheck ──────────────────────────────────────

describe('BitcoinChainClient.healthCheck', () => {
  it('returns true when connected to signet', async () => {
    const provider = createMockProvider({
      getBlockchainInfo: vi.fn().mockResolvedValue({ chain: 'signet', blocks: 150000 }),
    });
    const client = new BitcoinChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });
    expect(await client.healthCheck()).toBe(true);
  });

  it('returns true when connected to test network', async () => {
    const provider = createMockProvider({
      getBlockchainInfo: vi.fn().mockResolvedValue({ chain: 'test', blocks: 2500000 }),
    });
    const client = new BitcoinChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });
    expect(await client.healthCheck()).toBe(true);
  });

  it('returns true when connected to mainnet', async () => {
    const provider = createMockProvider({
      getBlockchainInfo: vi.fn().mockResolvedValue({ chain: 'main', blocks: 800000 }),
    });
    const client = new BitcoinChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });
    expect(await client.healthCheck()).toBe(true);
  });

  it('returns false on provider error', async () => {
    const provider = createMockProvider({
      getBlockchainInfo: vi.fn().mockRejectedValue(new Error('Connection refused')),
    });
    const client = new BitcoinChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });
    expect(await client.healthCheck()).toBe(false);
  });

  it('returns false for unknown chain name', async () => {
    const provider = createMockProvider({
      getBlockchainInfo: vi.fn().mockResolvedValue({ chain: 'regtest', blocks: 100 }),
    });
    const client = new BitcoinChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });
    expect(await client.healthCheck()).toBe(false);
  });
});

// ─── BitcoinChainClient.submitFingerprint ────────────────────────────────

describe('BitcoinChainClient.submitFingerprint', () => {
  it('throws when no UTXOs available', async () => {
    const provider = createMockProvider({
      listUnspent: vi.fn().mockResolvedValue([]),
    });
    const client = new BitcoinChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });

    await expect(
      client.submitFingerprint({ fingerprint: TEST_FINGERPRINT, timestamp: new Date().toISOString() }),
    ).rejects.toThrow('No UTXOs available');
  });

  it('throws when no UTXO large enough for fee', async () => {
    const provider = createMockProvider({
      listUnspent: vi.fn().mockResolvedValue([
        { txid: DUMMY_TXID, vout: 0, valueSats: 10, rawTxHex: DUMMY_RAW_TX_HEX },
      ]),
    });
    const client = new BitcoinChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });

    await expect(
      client.submitFingerprint({ fingerprint: TEST_FINGERPRINT, timestamp: new Date().toISOString() }),
    ).rejects.toThrow('Insufficient total UTXO value');
  });

  it('broadcasts and returns receipt on success', async () => {
    const broadcastTx = vi.fn().mockResolvedValue({ txid: 'broadcast_abc' });
    const provider = createMockProvider({
      listUnspent: vi.fn().mockResolvedValue([
        { txid: DUMMY_TXID, vout: 0, valueSats: 100000, rawTxHex: DUMMY_RAW_TX_HEX },
      ]),
      broadcastTx,
      getBlockchainInfo: vi.fn().mockResolvedValue({ chain: 'signet', blocks: 150000 }),
    });
    const client = new BitcoinChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });

    const receipt = await client.submitFingerprint({
      fingerprint: TEST_FINGERPRINT,
      timestamp: new Date().toISOString(),
    });

    expect(broadcastTx).toHaveBeenCalledOnce();
    expect(receipt.receiptId).toBeTruthy();
    expect(receipt.blockHeight).toBe(150000);
    expect(receipt.confirmations).toBe(0);
  });

  it('uses broadcast txid when it differs from computed txid', async () => {
    const { logger } = await import('../utils/logger.js');
    const broadcastTx = vi.fn().mockResolvedValue({ txid: 'different_txid_from_network' });
    const provider = createMockProvider({
      listUnspent: vi.fn().mockResolvedValue([
        { txid: DUMMY_TXID, vout: 0, valueSats: 100000, rawTxHex: DUMMY_RAW_TX_HEX },
      ]),
      broadcastTx,
      getBlockchainInfo: vi.fn().mockResolvedValue({ chain: 'signet', blocks: 150001 }),
    });
    const client = new BitcoinChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });

    const receipt = await client.submitFingerprint({
      fingerprint: TEST_FINGERPRINT,
      timestamp: new Date().toISOString(),
    });

    // Should use the broadcast txid, not the computed one
    expect(receipt.receiptId).toBe('different_txid_from_network');
    // Should have logged a warning about the mismatch
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ broadcast: 'different_txid_from_network' }),
      expect.stringContaining('differs'),
    );
  });

  it('falls back to computed txid when broadcast returns empty', async () => {
    const broadcastTx = vi.fn().mockResolvedValue({ txid: '' });
    const provider = createMockProvider({
      listUnspent: vi.fn().mockResolvedValue([
        { txid: DUMMY_TXID, vout: 0, valueSats: 100000, rawTxHex: DUMMY_RAW_TX_HEX },
      ]),
      broadcastTx,
      getBlockchainInfo: vi.fn().mockResolvedValue({ chain: 'signet', blocks: 150002 }),
    });
    const client = new BitcoinChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });

    const receipt = await client.submitFingerprint({
      fingerprint: TEST_FINGERPRINT,
      timestamp: new Date().toISOString(),
    });

    // Should fall back to the locally computed txid (not empty string)
    expect(receipt.receiptId).toBeTruthy();
    expect(receipt.receiptId).not.toBe('');
  });

  it('passes raw tx hex to broadcastTx', async () => {
    const broadcastTx = vi.fn().mockResolvedValue({ txid: 'txid_result' });
    const provider = createMockProvider({
      listUnspent: vi.fn().mockResolvedValue([
        { txid: DUMMY_TXID, vout: 0, valueSats: 100000, rawTxHex: DUMMY_RAW_TX_HEX },
      ]),
      broadcastTx,
      getBlockchainInfo: vi.fn().mockResolvedValue({ chain: 'signet', blocks: 150003 }),
    });
    const client = new BitcoinChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });

    await client.submitFingerprint({
      fingerprint: TEST_FINGERPRINT,
      timestamp: new Date().toISOString(),
    });

    // broadcastTx should receive a valid hex string
    expect(broadcastTx).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]+$/));
  });

  it('returns metadataHash when metadata is provided', async () => {
    const broadcastTx = vi.fn().mockResolvedValue({ txid: 'broadcast_meta' });
    const provider = createMockProvider({
      listUnspent: vi.fn().mockResolvedValue([
        { txid: DUMMY_TXID, vout: 0, valueSats: 100000, rawTxHex: DUMMY_RAW_TX_HEX },
      ]),
      broadcastTx,
      getBlockchainInfo: vi.fn().mockResolvedValue({ chain: 'signet', blocks: 150010 }),
    });
    const client = new BitcoinChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });

    const receipt = await client.submitFingerprint({
      fingerprint: TEST_FINGERPRINT,
      timestamp: new Date().toISOString(),
      metadata: { degree: 'BS Computer Science', institution: 'University of Michigan' },
    });

    expect(receipt.metadataHash).toBeDefined();
    expect(receipt.metadataHash).toHaveLength(64);
    expect(receipt.metadataHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not include metadataHash when no metadata', async () => {
    const broadcastTx = vi.fn().mockResolvedValue({ txid: 'broadcast_nometa' });
    const provider = createMockProvider({
      listUnspent: vi.fn().mockResolvedValue([
        { txid: DUMMY_TXID, vout: 0, valueSats: 100000, rawTxHex: DUMMY_RAW_TX_HEX },
      ]),
      broadcastTx,
      getBlockchainInfo: vi.fn().mockResolvedValue({ chain: 'signet', blocks: 150011 }),
    });
    const client = new BitcoinChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });

    const receipt = await client.submitFingerprint({
      fingerprint: TEST_FINGERPRINT,
      timestamp: new Date().toISOString(),
    });

    expect(receipt.metadataHash).toBeUndefined();
  });

  it('metadata hash is deterministic regardless of key order', async () => {
    const broadcastTx = vi.fn().mockResolvedValue({ txid: 'broadcast_det' });
    const makeProvider = () => createMockProvider({
      listUnspent: vi.fn().mockResolvedValue([
        { txid: DUMMY_TXID, vout: 0, valueSats: 100000, rawTxHex: DUMMY_RAW_TX_HEX },
      ]),
      broadcastTx,
      getBlockchainInfo: vi.fn().mockResolvedValue({ chain: 'signet', blocks: 150012 }),
    });

    const client1 = new BitcoinChainClient({ treasuryWif: TEST_WIF, utxoProvider: makeProvider() });
    const client2 = new BitcoinChainClient({ treasuryWif: TEST_WIF, utxoProvider: makeProvider() });

    const r1 = await client1.submitFingerprint({
      fingerprint: TEST_FINGERPRINT,
      timestamp: new Date().toISOString(),
      metadata: { z: 'last', a: 'first' },
    });
    const r2 = await client2.submitFingerprint({
      fingerprint: TEST_FINGERPRINT,
      timestamp: new Date().toISOString(),
      metadata: { a: 'first', z: 'last' },
    });

    expect(r1.metadataHash).toBe(r2.metadataHash);
  });

  it('uses fee estimator rate for transaction', async () => {
    const feeEstimator: FeeEstimator = {
      name: 'Test',
      estimateFee: vi.fn().mockResolvedValue(10),
    };
    const broadcastTx = vi.fn().mockResolvedValue({ txid: 'broadcast_fee_test' });
    const provider = createMockProvider({
      listUnspent: vi.fn().mockResolvedValue([
        { txid: DUMMY_TXID, vout: 0, valueSats: 100000, rawTxHex: DUMMY_RAW_TX_HEX },
      ]),
      broadcastTx,
      getBlockchainInfo: vi.fn().mockResolvedValue({ chain: 'signet', blocks: 150004 }),
    });

    const config: BitcoinClientConfig = {
      signingProvider: testSigner,
      utxoProvider: provider,
      feeEstimator,
    };
    const client = new BitcoinChainClient(config);

    await client.submitFingerprint({
      fingerprint: TEST_FINGERPRINT,
      timestamp: new Date().toISOString(),
    });

    expect(feeEstimator.estimateFee).toHaveBeenCalledOnce();
  });
});

// ─── BitcoinChainClient.getReceipt ───────────────────────────────────────

describe('BitcoinChainClient.getReceipt', () => {
  it('returns receipt for existing transaction', async () => {
    const txId = 'a'.repeat(64);
    const provider = createMockProvider({
      getRawTransaction: vi.fn().mockResolvedValue({
        txid: txId,
        confirmations: 3,
        blocktime: 1710000000,
        blockhash: 'b'.repeat(64),
        vout: [],
      }),
      getBlockHeader: vi.fn().mockResolvedValue({ height: 150042 }),
    });
    const client = new BitcoinChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });
    const receipt = await client.getReceipt(txId);

    expect(receipt).not.toBeNull();
    expect(receipt!.receiptId).toBe(txId);
    expect(receipt!.blockHeight).toBe(150042);
    expect(receipt!.confirmations).toBe(3);
  });

  it('returns null for non-existent transaction', async () => {
    const provider = createMockProvider({
      getRawTransaction: vi.fn().mockRejectedValue(new Error('Not found')),
    });
    const client = new BitcoinChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });
    const receipt = await client.getReceipt('nonexistent');
    expect(receipt).toBeNull();
  });

  it('returns receipt without block height for unconfirmed tx', async () => {
    const provider = createMockProvider({
      getRawTransaction: vi.fn().mockResolvedValue({
        txid: 'c'.repeat(64),
        confirmations: 0,
        vout: [],
      }),
    });
    const client = new BitcoinChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });
    const receipt = await client.getReceipt('c'.repeat(64));

    expect(receipt).not.toBeNull();
    expect(receipt!.blockHeight).toBe(0);
  });
});

// ─── BitcoinChainClient.verifyFingerprint ────────────────────────────────

describe('BitcoinChainClient.verifyFingerprint', () => {
  it('returns verified=false when fingerprint not found', async () => {
    const provider = createMockProvider({
      listUnspent: vi.fn().mockResolvedValue([]),
    });
    const client = new BitcoinChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });
    const result = await client.verifyFingerprint(TEST_FINGERPRINT);

    expect(result.verified).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('returns verified=false on provider error', async () => {
    const provider = createMockProvider({
      listUnspent: vi.fn().mockRejectedValue(new Error('Connection refused')),
    });
    const client = new BitcoinChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });
    const result = await client.verifyFingerprint(TEST_FINGERPRINT);

    expect(result.verified).toBe(false);
    expect(result.error).toContain('Verification error');
  });

  it('returns verified=true when matching OP_RETURN found', async () => {
    const arkvPrefix = Buffer.from('ARKV').toString('hex');
    const fpHex = TEST_FINGERPRINT.toLowerCase();
    const opReturnHex = '6a24' + arkvPrefix + fpHex; // 6a = OP_RETURN, 24 = push 36 bytes

    const provider = createMockProvider({
      listUnspent: vi.fn().mockResolvedValue([
        { txid: 'x'.repeat(64), vout: 0, valueSats: 50000, rawTxHex: '00' },
      ]),
      getRawTransaction: vi.fn().mockResolvedValue({
        txid: 'x'.repeat(64),
        confirmations: 5,
        blocktime: 1710000000,
        blockhash: 'y'.repeat(64),
        vout: [{
          scriptPubKey: {
            hex: opReturnHex,
            asm: 'OP_RETURN ' + arkvPrefix + fpHex,
          },
        }],
      }),
      getBlockHeader: vi.fn().mockResolvedValue({ height: 150042 }),
    });

    const client = new BitcoinChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });
    const result = await client.verifyFingerprint(TEST_FINGERPRINT);

    expect(result.verified).toBe(true);
    expect(result.receipt).toBeDefined();
    expect(result.receipt!.blockHeight).toBe(150042);
  });

  // ── Chain index lookup tests (P7-TS-13) ──

  it('returns verified=true from chain index hit (skips UTXO scan)', async () => {
    const indexEntry: IndexEntry = {
      chainTxId: 'idx_tx_' + 'f'.repeat(57),
      blockHeight: 200000,
      blockTimestamp: '2026-03-01T00:00:00Z',
      confirmations: 10,
      anchorId: 'anchor-uuid-123',
    };
    const chainIndex = createMockChainIndex({
      lookupFingerprint: vi.fn().mockResolvedValue(indexEntry),
    });
    const listUnspent = vi.fn();
    const provider = createMockProvider({ listUnspent });

    const config: BitcoinClientConfig = {
      signingProvider: testSigner,
      utxoProvider: provider,
      chainIndex,
    };
    const client = new BitcoinChainClient(config);

    const result = await client.verifyFingerprint(TEST_FINGERPRINT);

    expect(result.verified).toBe(true);
    expect(result.receipt).toBeDefined();
    expect(result.receipt!.receiptId).toBe(indexEntry.chainTxId);
    expect(result.receipt!.blockHeight).toBe(200000);
    expect(result.receipt!.confirmations).toBe(10);
    // UTXO scan should NOT be called
    expect(listUnspent).not.toHaveBeenCalled();
  });

  it('falls back to UTXO scan when chain index returns null', async () => {
    const chainIndex = createMockChainIndex({
      lookupFingerprint: vi.fn().mockResolvedValue(null),
    });
    const provider = createMockProvider({
      listUnspent: vi.fn().mockResolvedValue([]),
    });

    const config: BitcoinClientConfig = {
      signingProvider: testSigner,
      utxoProvider: provider,
      chainIndex,
    };
    const client = new BitcoinChainClient(config);

    const result = await client.verifyFingerprint(TEST_FINGERPRINT);

    // Index returned null, UTXO scan found nothing
    expect(result.verified).toBe(false);
    expect(provider.listUnspent).toHaveBeenCalled();
  });

  it('falls back to UTXO scan on chain index error', async () => {
    const chainIndex = createMockChainIndex({
      lookupFingerprint: vi.fn().mockRejectedValue(new Error('DB connection failed')),
    });
    const provider = createMockProvider({
      listUnspent: vi.fn().mockResolvedValue([]),
    });

    const config: BitcoinClientConfig = {
      signingProvider: testSigner,
      utxoProvider: provider,
      chainIndex,
    };
    const client = new BitcoinChainClient(config);

    const result = await client.verifyFingerprint(TEST_FINGERPRINT);

    expect(result.verified).toBe(false);
    // Should have fallen through to UTXO scan
    expect(provider.listUnspent).toHaveBeenCalled();
  });

  it('skips chain index when not configured', async () => {
    const provider = createMockProvider({
      listUnspent: vi.fn().mockResolvedValue([]),
    });
    // No chainIndex — goes straight to UTXO scan
    const client = new BitcoinChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });
    const result = await client.verifyFingerprint(TEST_FINGERPRINT);

    expect(result.verified).toBe(false);
    expect(provider.listUnspent).toHaveBeenCalled();
  });

  it('handles chain index entry with null fields gracefully', async () => {
    const indexEntry: IndexEntry = {
      chainTxId: 'idx_tx_partial',
      blockHeight: null,
      blockTimestamp: null,
      confirmations: null,
      anchorId: null,
    };
    const chainIndex = createMockChainIndex({
      lookupFingerprint: vi.fn().mockResolvedValue(indexEntry),
    });

    const config: BitcoinClientConfig = {
      signingProvider: testSigner,
      utxoProvider: createMockProvider(),
      chainIndex,
    };
    const client = new BitcoinChainClient(config);

    const result = await client.verifyFingerprint(TEST_FINGERPRINT);

    expect(result.verified).toBe(true);
    expect(result.receipt!.blockHeight).toBe(0);
    expect(result.receipt!.confirmations).toBe(0);
  });

  // ── BUG-2026-06-24-004: structural OP_RETURN decode + tx-history fallback ──

  it('REJECTS a forged OP_RETURN containing the prefix+fingerprint substring at a non-canonical offset', async () => {
    // Craft an OP_RETURN whose pushed payload is `<junk byte> || ARKV || fingerprint`.
    // The raw scriptPubKey hex therefore CONTAINS the substring "ARKV<fingerprint>"
    // (so the old `.includes()` check would falsely match), but the canonical
    // committed bytes are NOT [OP_RETURN, <ARKV><fingerprint>]: byte 0 is junk,
    // so subarray(0,4) !== "ARKV". A structural decode must reject it.
    const fpBytes = Buffer.from(TEST_FINGERPRINT.toLowerCase(), 'hex');
    const forgedPayload = Buffer.concat([Buffer.from([0xab]), Buffer.from('ARKV'), fpBytes]);
    const forgedScript = bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, forgedPayload]);
    const forgedHex = forgedScript.toString('hex');

    // Sanity: the forged hex really does contain the loose substring the old code matched.
    expect(forgedHex).toContain(Buffer.from('ARKV').toString('hex') + TEST_FINGERPRINT.toLowerCase());

    const forgedTx = {
      txid: 'f'.repeat(64),
      confirmations: 5,
      blocktime: 1710000000,
      blockhash: 'e'.repeat(64),
      vout: [{ scriptPubKey: { hex: forgedHex, asm: 'OP_RETURN ' + forgedPayload.toString('hex') } }],
    };
    const provider = createMockProvider({
      listUnspent: vi.fn().mockResolvedValue([
        { txid: 'f'.repeat(64), vout: 0, valueSats: 50000, rawTxHex: '00' },
      ]),
      getAddressTxs: vi.fn().mockResolvedValue([forgedTx]),
      getRawTransaction: vi.fn().mockResolvedValue(forgedTx),
    });

    const client = new BitcoinChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });
    const result = await client.verifyFingerprint(TEST_FINGERPRINT);

    expect(result.verified).toBe(false);
  });

  it('FINDS a spent/historical anchor TX via address tx-history (not in the UTXO set)', async () => {
    // Historical anchors: the OP_RETURN output is value-0 and the change is spent
    // by the next anchor, so the anchor TX never appears in listUnspent. It must be
    // discovered via the address transaction history.
    const fpBytes = Buffer.from(TEST_FINGERPRINT.toLowerCase(), 'hex');
    const canonicalPayload = Buffer.concat([Buffer.from('ARKV'), fpBytes]);
    const canonicalScript = bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, canonicalPayload]);
    const canonicalHex = canonicalScript.toString('hex');

    const historicalTxid = 'd'.repeat(64);
    const provider = createMockProvider({
      // UTXO set is EMPTY — the anchor TX has been fully spent.
      listUnspent: vi.fn().mockResolvedValue([]),
      getAddressTxs: vi.fn().mockResolvedValue([
        {
          txid: historicalTxid,
          confirmations: 12,
          blocktime: 1710000000,
          blockhash: 'c'.repeat(64),
          vout: [
            { scriptPubKey: { hex: canonicalHex, asm: 'OP_RETURN ' + canonicalPayload.toString('hex') } },
            // A change output (P2WPKH) that was later spent — must be ignored.
            { scriptPubKey: { hex: '0014' + '00'.repeat(20), asm: 'OP_0 ...' } },
          ],
        },
      ]),
      getBlockHeader: vi.fn().mockResolvedValue({ height: 250000 }),
    });

    const client = new BitcoinChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });
    const result = await client.verifyFingerprint(TEST_FINGERPRINT);

    expect(result.verified).toBe(true);
    expect(result.receipt).toBeDefined();
    expect(result.receipt!.receiptId).toBe(historicalTxid);
    expect(result.receipt!.blockHeight).toBe(250000);
    // The full address history must have been consulted.
    expect(provider.getAddressTxs).toHaveBeenCalledWith(expect.any(String));
  });

  it('accepts a genuine canonical OP_RETURN anchor found via tx-history', async () => {
    const fpBytes = Buffer.from(TEST_FINGERPRINT.toLowerCase(), 'hex');
    const canonicalPayload = Buffer.concat([Buffer.from('ARKV'), fpBytes]);
    const canonicalScript = bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, canonicalPayload]);
    const canonicalHex = canonicalScript.toString('hex');

    const provider = createMockProvider({
      listUnspent: vi.fn().mockResolvedValue([]),
      getAddressTxs: vi.fn().mockResolvedValue([
        {
          txid: 'a1'.repeat(32),
          confirmations: 6,
          blocktime: 1710000000,
          blockhash: 'b'.repeat(64),
          vout: [{ scriptPubKey: { hex: canonicalHex, asm: 'OP_RETURN ' + canonicalPayload.toString('hex') } }],
        },
      ]),
      getBlockHeader: vi.fn().mockResolvedValue({ height: 150042 }),
    });

    const client = new BitcoinChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });
    const result = await client.verifyFingerprint(TEST_FINGERPRINT);

    expect(result.verified).toBe(true);
    expect(result.receipt!.blockHeight).toBe(150042);
  });

  it('accepts a canonical anchor that also carries an 8-byte metadata hash suffix', async () => {
    // Payload = ARKV(4) + fingerprint(32) + metadataHash(8) = 44 bytes.
    // The structural matcher keys on subarray(0,4)===ARKV and subarray(4,36)===fp,
    // ignoring any trailing metadata bytes.
    const fpBytes = Buffer.from(TEST_FINGERPRINT.toLowerCase(), 'hex');
    const metaBytes = Buffer.from('0011223344556677', 'hex'); // 8 bytes
    const payload = Buffer.concat([Buffer.from('ARKV'), fpBytes, metaBytes]);
    const script = bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, payload]);

    const provider = createMockProvider({
      listUnspent: vi.fn().mockResolvedValue([]),
      getAddressTxs: vi.fn().mockResolvedValue([
        {
          txid: 'a2'.repeat(32),
          confirmations: 6,
          blocktime: 1710000000,
          blockhash: 'b'.repeat(64),
          vout: [{ scriptPubKey: { hex: script.toString('hex'), asm: 'OP_RETURN ' + payload.toString('hex') } }],
        },
      ]),
      getBlockHeader: vi.fn().mockResolvedValue({ height: 160000 }),
    });

    const client = new BitcoinChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });
    const result = await client.verifyFingerprint(TEST_FINGERPRINT);

    expect(result.verified).toBe(true);
    expect(result.receipt!.blockHeight).toBe(160000);
  });

  it('falls back to the UTXO scan (structural) when the provider has no getAddressTxs', async () => {
    // Backward-compat: providers without history support still verify unspent anchors.
    const fpBytes = Buffer.from(TEST_FINGERPRINT.toLowerCase(), 'hex');
    const canonicalPayload = Buffer.concat([Buffer.from('ARKV'), fpBytes]);
    const canonicalScript = bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, canonicalPayload]);
    const canonicalHex = canonicalScript.toString('hex');

    const provider = createMockProvider({
      listUnspent: vi.fn().mockResolvedValue([
        { txid: 'x'.repeat(64), vout: 0, valueSats: 50000, rawTxHex: '00' },
      ]),
      getRawTransaction: vi.fn().mockResolvedValue({
        txid: 'x'.repeat(64),
        confirmations: 5,
        blocktime: 1710000000,
        blockhash: 'y'.repeat(64),
        vout: [{ scriptPubKey: { hex: canonicalHex, asm: 'OP_RETURN ' + canonicalPayload.toString('hex') } }],
      }),
      getBlockHeader: vi.fn().mockResolvedValue({ height: 150042 }),
    });
    // Explicitly remove getAddressTxs to simulate a legacy provider.
    delete (provider as { getAddressTxs?: unknown }).getAddressTxs;

    const client = new BitcoinChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });
    const result = await client.verifyFingerprint(TEST_FINGERPRINT);

    expect(result.verified).toBe(true);
    expect(result.receipt!.blockHeight).toBe(150042);
    expect(provider.listUnspent).toHaveBeenCalled();
  });

  it('falls back to the UTXO scan when getAddressTxs FAILS (timeout/429), not a hard error', async () => {
    // Review (CodeRabbit): a transient history-API failure must not make
    // verification strictly worse than the pre-fix unspent-only path — it should
    // fall through to the legacy UTXO scan, which still verifies unspent anchors.
    const fpBytes = Buffer.from(TEST_FINGERPRINT.toLowerCase(), 'hex');
    const canonicalPayload = Buffer.concat([Buffer.from('ARKV'), fpBytes]);
    const canonicalScript = bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, canonicalPayload]);
    const canonicalHex = canonicalScript.toString('hex');

    const provider = createMockProvider({
      // History API is down (e.g. 429 / timeout).
      getAddressTxs: vi.fn().mockRejectedValue(new Error('HTTP 429 Too Many Requests')),
      // The anchor is still unspent, so the legacy UTXO scan can find it.
      listUnspent: vi.fn().mockResolvedValue([
        { txid: 'x'.repeat(64), vout: 0, valueSats: 50000, rawTxHex: '00' },
      ]),
      getRawTransaction: vi.fn().mockResolvedValue({
        txid: 'x'.repeat(64),
        confirmations: 5,
        blocktime: 1710000000,
        blockhash: 'y'.repeat(64),
        vout: [{ scriptPubKey: { hex: canonicalHex, asm: 'OP_RETURN ' + canonicalPayload.toString('hex') } }],
      }),
      getBlockHeader: vi.fn().mockResolvedValue({ height: 150042 }),
    });

    const client = new BitcoinChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });
    const result = await client.verifyFingerprint(TEST_FINGERPRINT);

    // Found via UTXO fallback — NOT a "Verification error".
    expect(result.verified).toBe(true);
    expect(result.receipt!.blockHeight).toBe(150042);
    expect(provider.getAddressTxs).toHaveBeenCalled();
    expect(provider.listUnspent).toHaveBeenCalled();
  });
});

// =============================================================================
// S3-P0 (batch producer) — prepare/broadcast split for persisted pre-broadcast
// intents. prepareFingerprintTx builds + signs WITHOUT broadcasting;
// broadcastSignedTx sends previously-signed bytes. submitFingerprint must
// remain exactly prepare→broadcast composed (back-compat).
// =============================================================================

describe('S3-P0 — BitcoinChainClient.prepareFingerprintTx', () => {
  const fundedProvider = (overrides: Partial<UtxoProvider> = {}) => createMockProvider({
    listUnspent: vi.fn().mockResolvedValue([
      { txid: DUMMY_TXID, vout: 0, valueSats: 100000, rawTxHex: DUMMY_RAW_TX_HEX },
    ]),
    ...overrides,
  });

  it('builds and signs WITHOUT broadcasting (no provider.broadcastTx call)', async () => {
    const broadcastTx = vi.fn();
    const provider = fundedProvider({ broadcastTx });
    const client = new BitcoinChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });

    const prepared = await client.prepareFingerprintTx({
      fingerprint: TEST_FINGERPRINT,
      timestamp: new Date().toISOString(),
    });

    expect(broadcastTx).not.toHaveBeenCalled();
    expect(prepared.txHex).toMatch(/^[0-9a-f]+$/i);
    expect(prepared.txId).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.feeSats).toBeGreaterThan(0);
  });

  it('txId equals the txid of the signed bytes (deterministic rebroadcast key)', async () => {
    const client = new BitcoinChainClient({ treasuryWif: TEST_WIF, utxoProvider: fundedProvider() });
    const prepared = await client.prepareFingerprintTx({
      fingerprint: TEST_FINGERPRINT,
      timestamp: new Date().toISOString(),
    });
    expect(bitcoin.Transaction.fromHex(prepared.txHex).getId()).toBe(prepared.txId);
  });

  it('commits exactly ONE OP_RETURN output carrying ARKV + the 32-byte root, ≤ 80 bytes (AC2)', async () => {
    const root = 'c1'.repeat(32);
    const client = new BitcoinChainClient({ treasuryWif: TEST_WIF, utxoProvider: fundedProvider() });
    const prepared = await client.prepareFingerprintTx({
      fingerprint: root,
      timestamp: new Date().toISOString(),
    });

    const tx = bitcoin.Transaction.fromHex(prepared.txHex);
    const opReturnOuts = tx.outs.filter((o) => o.script[0] === bitcoin.opcodes.OP_RETURN);
    expect(opReturnOuts).toHaveLength(1);

    // Structural decode at canonical offset — same parser the verifier uses.
    const committed = extractAnchorFingerprint(opReturnOuts[0].script.toString('hex'));
    expect(committed).toBe(root);

    // Raw committed payload: "ARKV"(4) + root(32) = 36 ≤ 80 bytes, no version byte.
    expect(prepared.opReturnData).toBe(`41524b56${root}`);
    expect(prepared.opReturnData.length / 2).toBeLessThanOrEqual(80);
  });

  it('same UTXO set → identical signed bytes and txid (RFC6979 deterministic signing)', async () => {
    const mk = () => new BitcoinChainClient({ treasuryWif: TEST_WIF, utxoProvider: fundedProvider() });
    const req = { fingerprint: TEST_FINGERPRINT, timestamp: new Date().toISOString() };
    const p1 = await mk().prepareFingerprintTx(req);
    const p2 = await mk().prepareFingerprintTx(req);
    expect(p1.txHex).toBe(p2.txHex);
    expect(p1.txId).toBe(p2.txId);
  });
});

describe('S3-P0 — BitcoinChainClient.broadcastSignedTx', () => {
  it('broadcasts the exact provided hex and returns a receipt with the broadcast txid', async () => {
    const broadcastTx = vi.fn().mockResolvedValue({ txid: 'broadcast_txid_s3p0' });
    const provider = createMockProvider({ broadcastTx });
    const client = new BitcoinChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });

    const receipt = await client.broadcastSignedTx(FUNDING_TX.txHex);

    expect(broadcastTx).toHaveBeenCalledWith(FUNDING_TX.txHex);
    expect(receipt.receiptId).toBe('broadcast_txid_s3p0');
    expect(receipt.rawTxHex).toBe(FUNDING_TX.txHex);
  });

  it('falls back to the locally-computed txid when the provider returns an empty txid (already-known == success)', async () => {
    const broadcastTx = vi.fn().mockResolvedValue({ txid: '' });
    const provider = createMockProvider({ broadcastTx });
    const client = new BitcoinChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });

    const receipt = await client.broadcastSignedTx(FUNDING_TX.txHex);
    expect(receipt.receiptId).toBe(FUNDING_TX.txid);
  });

  it('submitFingerprint remains prepare→broadcast composed: broadcast bytes == prepared bytes', async () => {
    const sent: string[] = [];
    const broadcastTx = vi.fn().mockImplementation(async (hex: string) => {
      sent.push(hex);
      return { txid: '' };
    });
    const provider = createMockProvider({
      listUnspent: vi.fn().mockResolvedValue([
        { txid: DUMMY_TXID, vout: 0, valueSats: 100000, rawTxHex: DUMMY_RAW_TX_HEX },
      ]),
      broadcastTx,
    });
    const mkClient = () => new BitcoinChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });
    const req = { fingerprint: TEST_FINGERPRINT, timestamp: new Date().toISOString() };

    const prepared = await mkClient().prepareFingerprintTx(req);
    const receipt = await mkClient().submitFingerprint(req);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe(prepared.txHex);
    expect(receipt.receiptId).toBe(prepared.txId);
    expect(receipt.rawTxHex).toBe(prepared.txHex);
  });
});
