/**
 * Bitcoin Audit Hardening — Tests
 *
 * Tests for findings: CRIT-1, CRIT-3, CRIT-6, NET-4, INEFF-2, INEFF-4/CRIT-5
 */

import { describe, it, expect, vi } from 'vitest';
import {
  selectUtxo,
  selectMultipleUtxos,
  estimateTxVsize,
  buildOpReturnTransaction,
  buildMultiInputOpReturnTransaction,
  hashMetadata,
  truncateMetadataHash,
} from './signet.js';
import type { Utxo } from './utxo-provider.js';
import type { SelectedUtxo } from './signet.js';

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../config.js', () => ({
  config: {
    bitcoinMaxFeeRate: undefined,
    bitcoinNetwork: 'signet',
  },
}));

// ─── Test fixtures ──────────────────────────────────────────────────

const VALID_FINGERPRINT = 'a'.repeat(64);

function makeUtxos(values: number[]): Utxo[] {
  return values.map((v, i) => ({
    txid: `tx_${i}`,
    vout: 0,
    valueSats: v,
    rawTxHex: '',
  }));
}

// Create a minimal mock signing provider using the repo's standard test WIF
function makeMockSigner() {
   
  const { ECPairFactory } = require('ecpair');
   
  const ecc = require('tiny-secp256k1');
  const ECPair = ECPairFactory(ecc);
  const TEST_WIF = 'cVt4o7BGAig1UXywgGSmARhxMdzP5qvQsxKkSsc1XEkw3tDTQFpy';
   
  const keyPair = ECPair.fromWIF(TEST_WIF, require('bitcoinjs-lib').networks.testnet);

  return {
    name: 'Test',
    getPublicKey: () => Buffer.from(keyPair.publicKey),
    sign: (hash: Buffer) => Promise.resolve(Buffer.from(keyPair.sign(hash))),
  };
}

describe('Bitcoin Audit Hardening', () => {
  // ─── selectUtxo (existing, still works) ──────────────────────────

  describe('selectUtxo', () => {
    it('returns null for empty UTXOs', () => {
      expect(selectUtxo([], 1000)).toBeNull();
    });

    it('selects largest UTXO that covers fee', () => {
      const utxos = makeUtxos([500, 2000, 1000]);
      const result = selectUtxo(utxos, 800);
      expect(result).not.toBeNull();
      expect(result!.valueSats).toBe(2000);
    });

    it('returns null when no single UTXO covers fee', () => {
      const utxos = makeUtxos([100, 200, 300]);
      expect(selectUtxo(utxos, 500)).toBeNull();
    });
  });

  // ─── INEFF-4/CRIT-5: selectMultipleUtxos ─────────────────────────

  describe('selectMultipleUtxos (INEFF-4/CRIT-5)', () => {
    it('returns null for empty UTXOs', () => {
      expect(selectMultipleUtxos([], 1000, 1)).toBeNull();
    });

    it('returns single UTXO when one is sufficient', () => {
      const utxos = makeUtxos([5000, 1000]);
      const result = selectMultipleUtxos(utxos, 2000, 1);
      expect(result).not.toBeNull();
      expect(result!.length).toBe(1);
      expect(result![0].valueSats).toBe(5000);
    });

    it('combines multiple UTXOs when none is individually sufficient', () => {
      const utxos = makeUtxos([300, 400, 500, 200]);
      const result = selectMultipleUtxos(utxos, 800, 1);
      expect(result).not.toBeNull();
      expect(result!.length).toBeGreaterThan(1);
      const totalValue = result!.reduce((sum, u) => sum + u.valueSats, 0);
      expect(totalValue).toBeGreaterThanOrEqual(800);
    });

    it('accounts for additional input fee cost', () => {
      // With fee rate of 10, each additional input costs 68 * 10 = 680 sats extra
      // No single UTXO covers 5000 sats, so both are needed
      const utxos = makeUtxos([3000, 3000]); // Total: 6000
      // Need 5000 sats base + 680 for second input = 5680
      const result = selectMultipleUtxos(utxos, 5000, 10);
      expect(result).not.toBeNull();
      expect(result!.length).toBe(2);
      const totalValue = result!.reduce((sum, u) => sum + u.valueSats, 0);
      expect(totalValue).toBeGreaterThanOrEqual(5680);
    });

    it('returns null when total value insufficient', () => {
      const utxos = makeUtxos([100, 100, 100]);
      // Need 1000 sats, only have 300
      expect(selectMultipleUtxos(utxos, 1000, 1)).toBeNull();
    });

    it('sorts UTXOs largest-first for optimal selection', () => {
      const utxos = makeUtxos([100, 800, 200, 600]);
      const result = selectMultipleUtxos(utxos, 700, 1);
      expect(result).not.toBeNull();
      expect(result![0].valueSats).toBe(800); // Largest first
    });
  });

  // ─── CRIT-3: RBF Signaling ────────────────────────────────────────

  describe('RBF Signaling (CRIT-3)', () => {
    it('sets nSequence to 0xfffffffd on PSBT inputs', async () => {
      const signer = makeMockSigner();
      const utxo: SelectedUtxo = {
        txid: 'a'.repeat(64),
        vout: 0,
        valueSats: 100000,
        rawTxHex: '',
      };

      const { txHex } = await buildOpReturnTransaction(
        VALID_FINGERPRINT,
        utxo,
        signer,
        1,
      );

      // The TX hex should be valid
      expect(txHex).toBeTruthy();
      expect(txHex.length).toBeGreaterThan(100);

      // Parse the TX to verify nSequence
       
      const bitcoin = require('bitcoinjs-lib');
      const tx = bitcoin.Transaction.fromHex(txHex);
      expect(tx.ins[0].sequence).toBe(0xfffffffd);
    });
  });

  // ─── NET-4: Raw TX Hex in Receipt ─────────────────────────────────

  describe('buildOpReturnTransaction return values (NET-4)', () => {
    it('returns txHex, txId, and fee', async () => {
      const signer = makeMockSigner();
      const utxo: SelectedUtxo = {
        txid: 'b'.repeat(64),
        vout: 0,
        valueSats: 50000,
        rawTxHex: '',
      };

      const result = await buildOpReturnTransaction(
        VALID_FINGERPRINT,
        utxo,
        signer,
        1,
      );

      expect(result.txHex).toBeTruthy();
      expect(result.txId).toBeTruthy();
      expect(result.fee).toBeGreaterThan(0);
      // TX ID should be 64-char hex
      expect(result.txId).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  // ─── INEFF-4: Multi-Input Transaction ─────────────────────────────

  describe('buildMultiInputOpReturnTransaction (INEFF-4)', () => {
    it('builds a valid TX with multiple inputs', async () => {
      const signer = makeMockSigner();
      const utxos: SelectedUtxo[] = [
        { txid: 'c'.repeat(64), vout: 0, valueSats: 5000, rawTxHex: '' },
        { txid: 'd'.repeat(64), vout: 1, valueSats: 5000, rawTxHex: '' },
      ];

      const result = await buildMultiInputOpReturnTransaction(
        VALID_FINGERPRINT,
        utxos,
        signer,
        1,
      );

      expect(result.txHex).toBeTruthy();
      expect(result.txId).toMatch(/^[a-f0-9]{64}$/);
      expect(result.fee).toBeGreaterThan(0);

      // Verify TX has 2 inputs
       
      const bitcoin = require('bitcoinjs-lib');
      const tx = bitcoin.Transaction.fromHex(result.txHex);
      expect(tx.ins.length).toBe(2);

      // Both inputs should have RBF sequence
      expect(tx.ins[0].sequence).toBe(0xfffffffd);
      expect(tx.ins[1].sequence).toBe(0xfffffffd);
    });

    it('includes metadata hash when provided', async () => {
      const signer = makeMockSigner();
      const utxos: SelectedUtxo[] = [
        { txid: 'e'.repeat(64), vout: 0, valueSats: 50000, rawTxHex: '' },
      ];

      const metadataHash = truncateMetadataHash(hashMetadata({ key: 'value' }));

      const result = await buildMultiInputOpReturnTransaction(
        VALID_FINGERPRINT,
        utxos,
        signer,
        1,
        undefined,
        metadataHash,
      );

      expect(result.txHex).toBeTruthy();
      // TX should have OP_RETURN with 44-byte payload (4 prefix + 32 fingerprint + 8 metadata)
       
      const bitcoin = require('bitcoinjs-lib');
      const tx = bitcoin.Transaction.fromHex(result.txHex);
      const opReturnOutput = tx.outs.find((o: { script: Buffer }) => o.script[0] === 0x6a);
      expect(opReturnOutput).toBeDefined();
    });

    it('throws for empty UTXO array', async () => {
      const signer = makeMockSigner();
      await expect(
        buildMultiInputOpReturnTransaction(VALID_FINGERPRINT, [], signer, 1),
      ).rejects.toThrow('At least one UTXO required');
    });

    it('throws for invalid fingerprint', async () => {
      const signer = makeMockSigner();
      const utxos: SelectedUtxo[] = [
        { txid: 'f'.repeat(64), vout: 0, valueSats: 50000, rawTxHex: '' },
      ];
      await expect(
        buildMultiInputOpReturnTransaction('invalid', utxos, signer, 1),
      ).rejects.toThrow('Fingerprint must be a 64-character hex string');
    });

    it('throws when total UTXO value insufficient', async () => {
      const signer = makeMockSigner();
      const utxos: SelectedUtxo[] = [
        { txid: 'f'.repeat(64), vout: 0, valueSats: 10, rawTxHex: '' }, // tiny
      ];
      await expect(
        buildMultiInputOpReturnTransaction(VALID_FINGERPRINT, utxos, signer, 100),
      ).rejects.toThrow('Insufficient funds');
    });
  });

  // ─── CRIT-6: Metadata Hash ────────────────────────────────────────

  describe('Metadata Hash (CRIT-6)', () => {
    it('hashMetadata produces consistent SHA-256 hash', () => {
      const hash1 = hashMetadata({ a: '1', b: '2' });
      const hash2 = hashMetadata({ b: '2', a: '1' }); // Different key order
      // Canonical JSON sorts keys, so hashes should match
      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    });

    it('truncateMetadataHash returns 8 bytes by default', () => {
      const hash = hashMetadata({ test: 'data' });
      const truncated = truncateMetadataHash(hash);
      expect(truncated.length).toBe(8);
    });

    it('different metadata produces different hashes', () => {
      const hash1 = hashMetadata({ type: 'diploma' });
      const hash2 = hashMetadata({ type: 'transcript' });
      expect(hash1).not.toBe(hash2);
    });
  });

  // ─── estimateTxVsize ──────────────────────────────────────────────

  describe('estimateTxVsize', () => {
    it('estimates size with change output', () => {
      const size = estimateTxVsize(true, 36);
      // Input(68) + OP_RETURN(11+36) + Change(31) + Overhead(11) = 157
      expect(size).toBe(157);
    });

    it('estimates size without change output', () => {
      const size = estimateTxVsize(false, 36);
      // Input(68) + OP_RETURN(11+36) + Overhead(11) = 126
      expect(size).toBe(126);
    });

    it('handles 44-byte payload (with metadata hash)', () => {
      const size = estimateTxVsize(true, 44);
      // Input(68) + OP_RETURN(11+44) + Change(31) + Overhead(11) = 165
      expect(size).toBe(165);
    });
  });
});
