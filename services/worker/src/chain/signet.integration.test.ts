/**
 * Signet Integration Tests — Real Transaction Construction & Signing
 *
 * These tests construct and sign REAL Bitcoin Signet transactions using
 * bitcoinjs-lib and WifSigningProvider. They validate the full pipeline:
 *   1. Generate a keypair
 *   2. Build a funding transaction (simulated coinbase)
 *   3. Construct an OP_RETURN anchor transaction embedding a fingerprint
 *   4. Sign it with a WIF key (ECPair)
 *   5. Parse and validate the signed transaction
 *
 * Broadcast is SKIPPED in CI — the signed tx hex is validated structurally.
 * No real Bitcoin network calls are made (Constitution 1.7).
 *
 * Stories: CRIT-2, P7-TS-05
 */

import { describe, it, expect, vi } from 'vitest';
import * as bitcoin from 'bitcoinjs-lib';
import { buildOpReturnTransaction, type SelectedUtxo } from './signet.js';
import { WifSigningProvider } from './signing-provider.js';
import { generateSignetKeypair } from './wallet.js';

// PERF-7: Mock config for fee ceiling check
vi.mock('../config.js', () => ({
  config: {
    bitcoinNetwork: 'signet',
    bitcoinMaxFeeRate: undefined,
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const SIGNET_NETWORK = bitcoin.networks.testnet;

/**
 * Build a simulated funding transaction that pays to a given P2WPKH address.
 * This stands in for the real treasury UTXO on Signet/testnet4.
 */
function buildFundingTx(
  pubkey: Buffer,
  valueSats: number,
): { txHex: string; txid: string; vout: number } {
  const { output } = bitcoin.payments.p2wpkh({
    pubkey,
    network: SIGNET_NETWORK,
  });

  const tx = new bitcoin.Transaction();
  tx.version = 2;
  // Coinbase-like input (simulates block reward)
  tx.addInput(Buffer.alloc(32, 0), 0xffffffff);
  tx.addOutput(output!, valueSats);

  return { txHex: tx.toHex(), txid: tx.getId(), vout: 0 };
}

// ─── Integration: Full Transaction Construction & Signing ────────────────

describe('Signet Integration — Real TX Construction', () => {
  const TEST_FINGERPRINT =
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'; // SHA-256 of empty string

  it('constructs and signs a valid OP_RETURN transaction from a generated keypair', async () => {
    // 1. Generate a fresh Signet keypair
    const { wif } = generateSignetKeypair();
    const signer = new WifSigningProvider(wif, SIGNET_NETWORK);
    const publicKey = signer.getPublicKey();

    // 2. Build a simulated funding tx paying 100,000 sats to that keypair
    const funding = buildFundingTx(publicKey, 100_000);
    const utxo: SelectedUtxo = {
      txid: funding.txid,
      vout: funding.vout,
      valueSats: 100_000,
      rawTxHex: funding.txHex,
    };

    // 3. Build and sign the OP_RETURN anchor transaction
    const result = await buildOpReturnTransaction(
      TEST_FINGERPRINT,
      utxo,
      signer,
      1, // 1 sat/vbyte (Signet minimum)
      SIGNET_NETWORK,
    );

    // 4. Validate outputs
    expect(result.txHex).toBeDefined();
    expect(result.txId).toBeDefined();
    expect(result.fee).toBeGreaterThan(0);
    expect(result.txHex.length).toBeGreaterThan(0);
    expect(result.txId).toMatch(/^[a-f0-9]{64}$/);

    // 5. Parse the signed transaction and validate structure
    const tx = bitcoin.Transaction.fromHex(result.txHex);

    // Must have exactly 1 input
    expect(tx.ins).toHaveLength(1);

    // Must have 2 outputs: OP_RETURN + change
    expect(tx.outs.length).toBeGreaterThanOrEqual(1);
    expect(tx.outs.length).toBeLessThanOrEqual(2);

    // First output must be OP_RETURN with ARKV prefix + fingerprint
    const opReturnOut = tx.outs[0];
    expect(opReturnOut.value).toBe(0); // OP_RETURN always has 0 value

    // Decode the OP_RETURN script
    const decompiled = bitcoin.script.decompile(opReturnOut.script);
    expect(decompiled).not.toBeNull();
    expect(decompiled![0]).toBe(bitcoin.opcodes.OP_RETURN);

    // The data payload: 4 bytes 'ARKV' + 32 bytes fingerprint
    const payload = decompiled![1] as Buffer;
    expect(payload.length).toBe(36); // 4 (ARKV) + 32 (SHA-256)
    expect(payload.subarray(0, 4).toString()).toBe('ARKV');
    expect(payload.subarray(4).toString('hex')).toBe(TEST_FINGERPRINT);

    // If there's a change output, it should go back to the same P2WPKH address
    if (tx.outs.length === 2) {
      const changeOut = tx.outs[1];
      expect(changeOut.value).toBeGreaterThan(0);
      expect(changeOut.value).toBe(100_000 - result.fee);
    }

    // P2WPKH: scriptSig is empty, witness contains signature + pubkey
    expect(tx.ins[0].script.length).toBe(0);
    expect(tx.ins[0].witness).toHaveLength(2);
  });

  it('constructs valid tx with the known test WIF', async () => {
    // Use the same test WIF from signet.test.ts for consistency
    const TEST_WIF = 'cVt4o7BGAig1UXywgGSmARhxMdzP5qvQsxKkSsc1XEkw3tDTQFpy';
    const signer = new WifSigningProvider(TEST_WIF, SIGNET_NETWORK);
    const publicKey = signer.getPublicKey();

    const funding = buildFundingTx(publicKey, 50_000);
    const utxo: SelectedUtxo = {
      txid: funding.txid,
      vout: funding.vout,
      valueSats: 50_000,
      rawTxHex: funding.txHex,
    };

    const fingerprint = 'b'.repeat(64);
    const result = await buildOpReturnTransaction(
      fingerprint,
      utxo,
      signer,
      1,
      SIGNET_NETWORK,
    );

    const tx = bitcoin.Transaction.fromHex(result.txHex);

    // Validate the OP_RETURN contains the correct fingerprint
    const decompiled = bitcoin.script.decompile(tx.outs[0].script);
    const payload = decompiled![1] as Buffer;
    expect(payload.subarray(4).toString('hex')).toBe(fingerprint);

    // Tx ID should be deterministic for same inputs
    expect(result.txId).toBe(tx.getId());
  });

  it('handles large UTXO values correctly', async () => {
    const { wif } = generateSignetKeypair();
    const signer = new WifSigningProvider(wif, SIGNET_NETWORK);
    const publicKey = signer.getPublicKey();

    // 1 BTC = 100,000,000 sats
    const funding = buildFundingTx(publicKey, 100_000_000);
    const utxo: SelectedUtxo = {
      txid: funding.txid,
      vout: funding.vout,
      valueSats: 100_000_000,
      rawTxHex: funding.txHex,
    };

    const result = await buildOpReturnTransaction(
      TEST_FINGERPRINT,
      utxo,
      signer,
      1,
      SIGNET_NETWORK,
    );

    const tx = bitcoin.Transaction.fromHex(result.txHex);

    // Must have change output for large UTXO
    expect(tx.outs).toHaveLength(2);

    // Change should be almost all of the input
    const changeValue = tx.outs[1].value;
    expect(changeValue).toBe(100_000_000 - result.fee);
    expect(changeValue).toBeGreaterThan(99_999_000);
  });

  it('consumes entire UTXO when change would be dust', async () => {
    const { wif } = generateSignetKeypair();
    const signer = new WifSigningProvider(wif, SIGNET_NETWORK);
    const publicKey = signer.getPublicKey();

    // Value just barely above fee — change will be below dust threshold (546 sats)
    // P2WPKH tx with change: ~157 vbytes at 1 sat/vbyte = 157 sats fee
    // Without change: ~126 vbytes at 1 sat/vbyte = 126 sats fee
    // So a UTXO of 600 sats: 600 - 157 = 443 change (below 546 dust)
    // Without change: fee = 126, 600 - 126 = 474 sats donated to miners
    const funding = buildFundingTx(publicKey, 600);
    const utxo: SelectedUtxo = {
      txid: funding.txid,
      vout: funding.vout,
      valueSats: 600,
      rawTxHex: funding.txHex,
    };

    const result = await buildOpReturnTransaction(
      TEST_FINGERPRINT,
      utxo,
      signer,
      1,
      SIGNET_NETWORK,
    );

    const tx = bitcoin.Transaction.fromHex(result.txHex);

    // No change output — only OP_RETURN
    expect(tx.outs).toHaveLength(1);
    expect(tx.outs[0].value).toBe(0); // OP_RETURN
  });

  it('rejects invalid fingerprint format', async () => {
    const { wif } = generateSignetKeypair();
    const signer = new WifSigningProvider(wif, SIGNET_NETWORK);
    const publicKey = signer.getPublicKey();

    const funding = buildFundingTx(publicKey, 100_000);
    const utxo: SelectedUtxo = {
      txid: funding.txid,
      vout: funding.vout,
      valueSats: 100_000,
      rawTxHex: funding.txHex,
    };

    // Too short
    await expect(
      buildOpReturnTransaction('abc', utxo, signer, 1, SIGNET_NETWORK),
    ).rejects.toThrow('64-character hex string');

    // Non-hex characters
    await expect(
      buildOpReturnTransaction('g'.repeat(64), utxo, signer, 1, SIGNET_NETWORK),
    ).rejects.toThrow('64-character hex string');
  });

  it('produces different txIds for different fingerprints', async () => {
    const { wif } = generateSignetKeypair();
    const signer = new WifSigningProvider(wif, SIGNET_NETWORK);
    const publicKey = signer.getPublicKey();

    const funding1 = buildFundingTx(publicKey, 100_000);
    const funding2 = buildFundingTx(publicKey, 100_001); // different value → different txid

    const utxo1: SelectedUtxo = {
      txid: funding1.txid,
      vout: 0,
      valueSats: 100_000,
      rawTxHex: funding1.txHex,
    };
    const utxo2: SelectedUtxo = {
      txid: funding2.txid,
      vout: 0,
      valueSats: 100_001,
      rawTxHex: funding2.txHex,
    };

    const fp1 = 'a'.repeat(64);
    const fp2 = 'b'.repeat(64);

    const result1 = await buildOpReturnTransaction(fp1, utxo1, signer, 1, SIGNET_NETWORK);
    const result2 = await buildOpReturnTransaction(fp2, utxo2, signer, 1, SIGNET_NETWORK);

    expect(result1.txId).not.toBe(result2.txId);
  });

  it('signed P2WPKH transaction witness contains valid DER signature + pubkey', async () => {
    const { wif } = generateSignetKeypair();
    const signer = new WifSigningProvider(wif, SIGNET_NETWORK);
    const publicKey = signer.getPublicKey();

    const funding = buildFundingTx(publicKey, 100_000);
    const utxo: SelectedUtxo = {
      txid: funding.txid,
      vout: 0,
      valueSats: 100_000,
      rawTxHex: funding.txHex,
    };

    const result = await buildOpReturnTransaction(
      TEST_FINGERPRINT,
      utxo,
      signer,
      1,
      SIGNET_NETWORK,
    );

    const tx = bitcoin.Transaction.fromHex(result.txHex);

    // P2WPKH: scriptSig is empty, signature + pubkey are in witness
    expect(tx.ins[0].script.length).toBe(0);

    const witness = tx.ins[0].witness;
    expect(witness).toHaveLength(2);

    const sigBuf = witness[0];
    const pubBuf = witness[1];

    // DER signature: starts with 0x30, ends with SIGHASH_ALL (0x01)
    expect(sigBuf[0]).toBe(0x30);
    expect(sigBuf[sigBuf.length - 1]).toBe(0x01); // SIGHASH_ALL

    // Public key: 33-byte compressed (0x02 or 0x03 prefix)
    expect(pubBuf.length).toBe(33);
    expect([0x02, 0x03]).toContain(pubBuf[0]);

    // The pubkey in witness must match the signer's public key
    expect(Buffer.compare(pubBuf, publicKey)).toBe(0);
  });
});

// ─── Integration: Broadcast Skip (CI Safety) ─────────────────────────────

describe('Signet Integration — Broadcast Skip (CI)', () => {
  it('would broadcast to Signet but is skipped in CI', () => {
    // This test documents the broadcast step without executing it.
    // In a real Signet E2E run (manual, outside CI):
    //   1. Fund the treasury address with Signet faucet
    //   2. Set BITCOIN_TREASURY_WIF env var
    //   3. Use MempoolUtxoProvider pointed at mempool.space/signet/api
    //   4. Call client.submitFingerprint() with a real fingerprint
    //   5. Verify the txid appears on mempool.space/signet/tx/{txid}
    //
    // Skipping because:
    //   - Constitution 1.7: no real Bitcoin API calls in CI
    //   - UTXO availability depends on external Signet state
    //   - Broadcast is irreversible
    expect(true).toBe(true);
  });
});
