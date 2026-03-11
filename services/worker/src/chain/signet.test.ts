/**
 * Unit tests for SignetChainClient
 *
 * CRIT-2 / P7-TS-05 / P7-TS-12: Tests for OP_RETURN transaction construction,
 * UTXO selection, provider interactions, receipt parsing, and error handling.
 *
 * All network calls are mocked — Constitution requires no real
 * Stripe or Bitcoin API calls in tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
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

// Mock fetch for legacy RPC path
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  SignetChainClient,
  buildOpReturnTransaction,
  selectUtxo,
  estimateTxVsize,
  type SelectedUtxo,
} from './signet.js';
import type { UtxoProvider, Utxo } from './utxo-provider.js';

// Test WIF for Signet/testnet (this is a throwaway key, not real funds)
const TEST_WIF = 'cVt4o7BGAig1UXywgGSmARhxMdzP5qvQsxKkSsc1XEkw3tDTQFpy';
const TEST_FINGERPRINT = 'a'.repeat(64); // Valid 64-char hex

// Build a dummy funding tx that pays to the TEST_WIF key's P2PKH address.
// This is required because bitcoinjs-lib PSBT validation checks that:
// 1. The nonWitnessUtxo txid matches the input hash
// 2. The output's scriptPubKey matches the signing key
function buildDummyFundingTx(valueSats: number): { txHex: string; txid: string } {
  const testKey = ECPair.fromWIF(TEST_WIF, bitcoin.networks.testnet);
  const { output } = bitcoin.payments.p2pkh({
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
  it('calculates size with change output', () => {
    const size = estimateTxVsize(true);
    // 148 + 47 + 34 + 10 = 239
    expect(size).toBe(239);
  });

  it('calculates size without change output', () => {
    const size = estimateTxVsize(false);
    // 148 + 47 + 10 = 205
    expect(size).toBe(205);
  });
});

// ─── buildOpReturnTransaction ────────────────────────────────────────────

describe('buildOpReturnTransaction', () => {
  const keyPair = ECPair.fromWIF(TEST_WIF, bitcoin.networks.testnet);

  const makeUtxo = (valueSats: number): SelectedUtxo => ({
    txid: DUMMY_TXID,
    vout: 0,
    valueSats,
    rawTxHex: DUMMY_RAW_TX_HEX,
  });

  it('rejects invalid fingerprint (not 64-char hex)', () => {
    expect(() => buildOpReturnTransaction('invalid', makeUtxo(100000), keyPair)).toThrow(
      'Fingerprint must be a 64-character hex string',
    );
  });

  it('rejects fingerprint that is too short', () => {
    expect(() => buildOpReturnTransaction('abcd', makeUtxo(100000), keyPair)).toThrow(
      'Fingerprint must be a 64-character hex string',
    );
  });

  it('rejects insufficient funds', () => {
    expect(() => buildOpReturnTransaction(TEST_FINGERPRINT, makeUtxo(1), keyPair)).toThrow(
      'Insufficient funds',
    );
  });

  it('returns txHex, txId, and fee on success', () => {
    const result = buildOpReturnTransaction(TEST_FINGERPRINT, makeUtxo(100000), keyPair);
    expect(result.txHex).toBeTruthy();
    expect(result.txId).toBeTruthy();
    expect(result.fee).toBeGreaterThan(0);
    expect(result.txId).toHaveLength(64);
  });

  it('includes OP_RETURN output with ARKV prefix', () => {
    const result = buildOpReturnTransaction(TEST_FINGERPRINT, makeUtxo(100000), keyPair);
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

  it('includes change output when above dust threshold', () => {
    const result = buildOpReturnTransaction(TEST_FINGERPRINT, makeUtxo(100000), keyPair);
    const tx = bitcoin.Transaction.fromHex(result.txHex);

    // Should have 2 outputs: OP_RETURN + change
    expect(tx.outs).toHaveLength(2);
    expect(tx.outs[1].value).toBeGreaterThan(0);
  });

  it('omits change output when below dust threshold', () => {
    // Set value just above the fee but below fee + dust (546)
    const feeEstimate = estimateTxVsize(true); // ~239 at 1 sat/vbyte
    const barelyEnough = feeEstimate + 100; // change would be ~100 sats, below dust

    const result = buildOpReturnTransaction(TEST_FINGERPRINT, makeUtxo(barelyEnough), keyPair);
    const tx = bitcoin.Transaction.fromHex(result.txHex);

    // Should have only 1 output: OP_RETURN (no change)
    expect(tx.outs).toHaveLength(1);
  });
});

// ─── SignetChainClient constructor ───────────────────────────────────────

describe('SignetChainClient constructor', () => {
  it('initializes with new-style config (utxoProvider)', () => {
    const client = new SignetChainClient({
      treasuryWif: TEST_WIF,
      utxoProvider: createMockProvider(),
    });
    expect(client).toBeDefined();
  });

  it('initializes with legacy config (rpcUrl)', () => {
    const client = new SignetChainClient({
      treasuryWif: TEST_WIF,
      rpcUrl: 'http://localhost:38332',
    });
    expect(client).toBeDefined();
  });

  it('throws on invalid WIF', () => {
    expect(
      () => new SignetChainClient({
        treasuryWif: 'invalid-wif',
        utxoProvider: createMockProvider(),
      }),
    ).toThrow('Invalid BITCOIN_TREASURY_WIF');
  });

  it('throws on empty WIF', () => {
    expect(
      () => new SignetChainClient({
        treasuryWif: '',
        utxoProvider: createMockProvider(),
      }),
    ).toThrow();
  });
});

// ─── SignetChainClient.healthCheck ───────────────────────────────────────

describe('SignetChainClient.healthCheck', () => {
  it('returns true when connected to signet', async () => {
    const provider = createMockProvider({
      getBlockchainInfo: vi.fn().mockResolvedValue({ chain: 'signet', blocks: 150000 }),
    });
    const client = new SignetChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });
    expect(await client.healthCheck()).toBe(true);
  });

  it('returns true when connected to test network', async () => {
    const provider = createMockProvider({
      getBlockchainInfo: vi.fn().mockResolvedValue({ chain: 'test', blocks: 2500000 }),
    });
    const client = new SignetChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });
    expect(await client.healthCheck()).toBe(true);
  });

  it('returns false when connected to mainnet', async () => {
    const provider = createMockProvider({
      getBlockchainInfo: vi.fn().mockResolvedValue({ chain: 'main', blocks: 800000 }),
    });
    const client = new SignetChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });
    expect(await client.healthCheck()).toBe(false);
  });

  it('returns false on provider error', async () => {
    const provider = createMockProvider({
      getBlockchainInfo: vi.fn().mockRejectedValue(new Error('Connection refused')),
    });
    const client = new SignetChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });
    expect(await client.healthCheck()).toBe(false);
  });
});

// ─── SignetChainClient.submitFingerprint ─────────────────────────────────

describe('SignetChainClient.submitFingerprint', () => {
  it('throws when no UTXOs available', async () => {
    const provider = createMockProvider({
      listUnspent: vi.fn().mockResolvedValue([]),
    });
    const client = new SignetChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });

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
    const client = new SignetChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });

    await expect(
      client.submitFingerprint({ fingerprint: TEST_FINGERPRINT, timestamp: new Date().toISOString() }),
    ).rejects.toThrow('No UTXO large enough');
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
    const client = new SignetChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });

    const receipt = await client.submitFingerprint({
      fingerprint: TEST_FINGERPRINT,
      timestamp: new Date().toISOString(),
    });

    expect(broadcastTx).toHaveBeenCalledOnce();
    expect(receipt.receiptId).toBeTruthy();
    expect(receipt.blockHeight).toBe(150000);
    expect(receipt.confirmations).toBe(0);
  });
});

// ─── SignetChainClient.getReceipt ────────────────────────────────────────

describe('SignetChainClient.getReceipt', () => {
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
    const client = new SignetChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });
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
    const client = new SignetChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });
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
    const client = new SignetChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });
    const receipt = await client.getReceipt('c'.repeat(64));

    expect(receipt).not.toBeNull();
    expect(receipt!.blockHeight).toBe(0);
  });
});

// ─── SignetChainClient.verifyFingerprint ─────────────────────────────────

describe('SignetChainClient.verifyFingerprint', () => {
  it('returns verified=false when fingerprint not found', async () => {
    const provider = createMockProvider({
      listUnspent: vi.fn().mockResolvedValue([]),
    });
    const client = new SignetChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });
    const result = await client.verifyFingerprint(TEST_FINGERPRINT);

    expect(result.verified).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('returns verified=false on provider error', async () => {
    const provider = createMockProvider({
      listUnspent: vi.fn().mockRejectedValue(new Error('Connection refused')),
    });
    const client = new SignetChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });
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

    const client = new SignetChainClient({ treasuryWif: TEST_WIF, utxoProvider: provider });
    const result = await client.verifyFingerprint(TEST_FINGERPRINT);

    expect(result.verified).toBe(true);
    expect(result.receipt).toBeDefined();
    expect(result.receipt!.blockHeight).toBe(150042);
  });
});
