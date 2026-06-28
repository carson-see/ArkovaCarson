/**
 * Bitcoin Audit Hardening — Tests
 *
 * Tests for findings: CRIT-1, CRIT-3, CRIT-6, NET-4, INEFF-2, INEFF-4/CRIT-5
 */

import { describe, it, expect, vi } from 'vitest';
import { ECPairFactory } from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import * as bitcoin from 'bitcoinjs-lib';
import {
  selectUtxo,
  selectMultipleUtxos,
  estimateTxVsize,
  buildOpReturnTransaction,
  buildMultiInputOpReturnTransaction,
  hashMetadata,
  truncateMetadataHash,
  DUST_THRESHOLD,
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
   
  const ECPair = ECPairFactory(ecc);
  const TEST_WIF = 'cVt4o7BGAig1UXywgGSmARhxMdzP5qvQsxKkSsc1XEkw3tDTQFpy';
  const keyPair = ECPair.fromWIF(TEST_WIF, bitcoin.networks.testnet);

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

  // ─── BUG-2026-06-24-005: multi-input fee threshold under-count ─────────
  //
  // The selector's threshold must account for the OP_RETURN output, change
  // output, and per-tx overhead for the ACTUAL multi-input transaction it
  // returns — not just the single-input estimate plus extra-input vbytes.
  // Otherwise it can hand back a UTXO set that lands in the band where the
  // real build either (a) burns sub-dust change as fee, or (b) throws
  // `Insufficient funds`, which processBatchAnchors bulk-reverts
  // BROADCASTING → PENDING (a wedged, retrying batch).
  //
  // Helper: replicate the REAL fee the multi-input build computes for `n`
  // inputs, mirroring buildMultiInputOpReturnTransaction's constants.
  function realBuildFee(
    n: number,
    payloadSize: number,
    feeRate: number,
    withChange: boolean,
  ): number {
    const INPUT_SIZE = 68;
    const OP_RETURN_OVERHEAD = 11;
    const CHANGE_OUTPUT_SIZE = 31;
    const OVERHEAD = 11;
    const vsize =
      INPUT_SIZE * n +
      OP_RETURN_OVERHEAD +
      payloadSize +
      (withChange ? CHANGE_OUTPUT_SIZE : 0) +
      OVERHEAD;
    return Math.ceil(vsize * feeRate);
  }

  describe('selectMultipleUtxos fee threshold (BUG-2026-06-24-005)', () => {
    // Caller derives `requiredFee` from a SINGLE-input estimate that already
    // includes one input + OP_RETURN + change + overhead.
    // estimateTxVsize(true, 36) = 68 + (11+36) + 31 + 11 = 157.
    // At feeRate 2 → estimatedFee = ceil(157 * 2) = 314.
    const PAYLOAD = 36; // ARKV(4) + fingerprint(32)
    const FEE_RATE = 2;
    const estimatedFee = Math.ceil(estimateTxVsize(true, PAYLOAD) * FEE_RATE); // 314

    it('rejects a UTXO set whose only feasible build burns sub-dust change (treasury liveness)', () => {
      // Two UTXOs of 225 each → total 450. No single UTXO covers 314, so the
      // multi-input path runs. The REAL build for n=2 with change costs
      // realBuildFee(2,36,2,true) = ceil((136+47+31+11)*2) = 450, leaving
      // change 450-450 = 0 → drops change → fee_nochange = ceil((136+47+11)*2)
      // = 388 → 62 sats silently burned as fee (sub-dust).
      const feeWithChange = realBuildFee(2, PAYLOAD, FEE_RATE, true); // 450
      const utxos = makeUtxos([225, 225]); // total 450 == feeWithChange (no dust margin)
      expect(utxos.reduce((s, u) => s + u.valueSats, 0)).toBe(feeWithChange);

      const result = selectMultipleUtxos(utxos, estimatedFee, FEE_RATE, PAYLOAD);

      // The pre-fix selector returns [225,225] (threshold = 314 + 136 = 450).
      // A dust-safe selector must NOT return a set that cannot leave a
      // spendable (>= dust) change output: here no such combination exists,
      // so it must return null and let the caller queue for retry.
      expect(result).toBeNull();
    });

    it('any returned selection leaves change == 0 or >= dust (never sub-dust burn)', () => {
      // Comfortable funding: 3 UTXOs of 400 → total 1200. Pre-fix selector
      // returns only 2 (threshold 450), whose build leaves 1200-... sub-dust;
      // a dust-safe selector pulls a third input so the kept change is
      // spendable.
      const utxos = makeUtxos([400, 400, 400]);
      const result = selectMultipleUtxos(utxos, estimatedFee, FEE_RATE, PAYLOAD);
      expect(result).not.toBeNull();

      const n = result!.length;
      const total = result!.reduce((s, u) => s + u.valueSats, 0);
      const feeWithChange = realBuildFee(n, PAYLOAD, FEE_RATE, true);
      const change = total - feeWithChange;
      // Either the change output is dropped cleanly (change <= 0, exact-fit)
      // or it is spendable (>= dust). It must never land in (0, dust).
      expect(change <= 0 || change >= DUST_THRESHOLD).toBe(true);
    });

    it('threshold is never below the real multi-input build fee for n inputs (no build-throw)', () => {
      // Property guard across fee rates, payloads, and input counts: whatever
      // set the selector returns, its total must cover the REAL no-change fee
      // floor of the build (the only condition under which the build throws
      // `Insufficient funds`).
      for (const feeRate of [1, 2, 5, 10]) {
        for (const payload of [36, 44]) {
          const reqFee = Math.ceil(estimateTxVsize(true, payload) * feeRate);
          // Many small equal UTXOs, each below the single-input estimate.
          const utxos = makeUtxos(Array(8).fill(200));
          const result = selectMultipleUtxos(utxos, reqFee, feeRate, payload);
          if (result === null) continue; // refusing is always safe
          const n = result.length;
          const total = result.reduce((s, u) => s + u.valueSats, 0);
          const floor = realBuildFee(n, payload, feeRate, false); // no-change throw boundary
          expect(total).toBeGreaterThanOrEqual(floor);
        }
      }
    });

    it('a dust-safe selection actually builds without throwing Insufficient funds', async () => {
      const signer = makeMockSigner();
      // Pick funding that forces a multi-input selection with a comfortable
      // margin so the build keeps a spendable change output. Valid 64-hex
      // txids are required for PSBT input construction.
      const utxos: SelectedUtxo[] = [
        { txid: 'a'.repeat(64), vout: 0, valueSats: 400, rawTxHex: '' },
        { txid: 'b'.repeat(64), vout: 1, valueSats: 400, rawTxHex: '' },
        { txid: 'c'.repeat(64), vout: 0, valueSats: 400, rawTxHex: '' },
        { txid: 'd'.repeat(64), vout: 1, valueSats: 400, rawTxHex: '' },
      ];
      const selected = selectMultipleUtxos(utxos, estimatedFee, FEE_RATE, PAYLOAD);
      expect(selected).not.toBeNull();

      // The set the selector returns must be buildable — no InsufficientFunds.
      const built = await buildMultiInputOpReturnTransaction(
        VALID_FINGERPRINT,
        selected!,
        signer,
        FEE_RATE,
      );
      expect(built.txHex).toBeTruthy();
      expect(built.fee).toBeGreaterThan(0);
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
       
      // bitcoin imported at top level
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
       
      // bitcoin imported at top level
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
       
      // bitcoin imported at top level
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
