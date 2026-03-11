/**
 * Bitcoin Signet Chain Client
 *
 * Real implementation of the ChainClient interface using bitcoinjs-lib.
 * Constructs OP_RETURN transactions to anchor document fingerprints
 * on Bitcoin Signet (testnet). Treasury WIF loaded from env — never logged.
 *
 * UTXO fetching and tx broadcasting are delegated to a UtxoProvider,
 * supporting either Bitcoin Core RPC or Mempool.space REST API.
 *
 * Constitution refs:
 *   - 1.1: bitcoinjs-lib + AWS KMS (target)
 *   - 1.4: Treasury/signing keys server-side only, never logged
 *   - 1.6: generateFingerprint is client-side only — this file never imports it
 *
 * Stories: P7-TS-05 (Signet chain client), P7-TS-12 (UTXO management)
 */

import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { ECPairFactory } from 'ecpair';
import { logger } from '../utils/logger.js';
import type {
  ChainClient,
  ChainReceipt,
  SubmitFingerprintRequest,
  VerificationResult,
} from './types.js';
import { RpcUtxoProvider, type UtxoProvider, type Utxo } from './utxo-provider.js';

const ECPair = ECPairFactory(ecc);

// Signet uses testnet network parameters
const SIGNET_NETWORK = bitcoin.networks.testnet;

// OP_RETURN prefix for Arkova anchors (4 bytes: 'ARKV')
const OP_RETURN_PREFIX = Buffer.from('ARKV');

// Maximum OP_RETURN payload is 80 bytes. Prefix (4) + SHA-256 hash (32) = 36 bytes.
const MAX_OP_RETURN_DATA = 80;

export interface SignetConfig {
  /** Treasury WIF for signing transactions — NEVER log this */
  treasuryWif: string;
  /** UTXO provider instance (RPC or Mempool.space) */
  utxoProvider: UtxoProvider;
  /** Fee rate in sat/vbyte. Defaults to 1 (Signet minimum). */
  feeRate?: number;
}

// ─── Deprecated — kept for backward compat with existing tests ──────────

/** @deprecated Use SignetConfig with utxoProvider instead */
export interface LegacySignetConfig {
  treasuryWif: string;
  rpcUrl: string;
  rpcAuth?: string;
}

/**
 * UTXO selected for spending, with the full raw tx for PSBT.
 */
export interface SelectedUtxo {
  txid: string;
  vout: number;
  /** Value in satoshis */
  valueSats: number;
  /** Full raw transaction hex (for nonWitnessUtxo in PSBT) */
  rawTxHex: string;
}

/**
 * Select the best UTXO for an OP_RETURN anchor transaction.
 *
 * Strategy: pick the largest confirmed UTXO so we minimize the chance
 * of creating dust change outputs. The change goes back to the treasury.
 *
 * @param utxos - Available UTXOs from the provider
 * @param requiredFee - Minimum fee in satoshis
 * @returns The selected UTXO, or null if none are large enough
 */
export function selectUtxo(
  utxos: Utxo[],
  requiredFee: number,
): SelectedUtxo | null {
  if (utxos.length === 0) return null;

  // Sort descending by value — pick the largest
  const sorted = [...utxos].sort((a, b) => b.valueSats - a.valueSats);

  // Find the first UTXO that can cover the fee
  for (const u of sorted) {
    if (u.valueSats >= requiredFee) {
      return {
        txid: u.txid,
        vout: u.vout,
        valueSats: u.valueSats,
        rawTxHex: u.rawTxHex,
      };
    }
  }

  return null;
}

/**
 * Estimate the virtual size of an OP_RETURN anchor transaction.
 *
 * P2PKH input: ~148 vbytes
 * OP_RETURN output (36-byte payload): ~47 vbytes
 * P2PKH change output: ~34 vbytes
 * Overhead: ~10 vbytes
 */
export function estimateTxVsize(hasChange: boolean): number {
  const INPUT_SIZE = 148;
  const OP_RETURN_OUTPUT_SIZE = 47;
  const CHANGE_OUTPUT_SIZE = 34;
  const OVERHEAD = 10;

  return (
    INPUT_SIZE +
    OP_RETURN_OUTPUT_SIZE +
    (hasChange ? CHANGE_OUTPUT_SIZE : 0) +
    OVERHEAD
  );
}

/** Dust threshold in satoshis — outputs below this are unspendable */
const DUST_THRESHOLD = 546;

/**
 * Build an OP_RETURN transaction embedding a document fingerprint.
 *
 * Transaction structure:
 *   Input:  Selected UTXO from treasury address
 *   Output 0: OP_RETURN <ARKV><sha256_hex_as_bytes>
 *   Output 1: Change back to treasury (input - fee), if above dust
 */
export function buildOpReturnTransaction(
  fingerprint: string,
  utxo: SelectedUtxo,
  keyPair: ReturnType<typeof ECPair.fromWIF>,
  feeRate: number = 1, // sat/vbyte — Signet minimum
): { txHex: string; txId: string; fee: number } {
  // Validate fingerprint is a 64-char hex string (SHA-256)
  if (!/^[a-f0-9]{64}$/i.test(fingerprint)) {
    throw new Error('Fingerprint must be a 64-character hex string (SHA-256)');
  }

  const fingerprintBytes = Buffer.from(fingerprint, 'hex');
  const opReturnData = Buffer.concat([OP_RETURN_PREFIX, fingerprintBytes]);

  if (opReturnData.length > MAX_OP_RETURN_DATA) {
    throw new Error(`OP_RETURN data exceeds ${MAX_OP_RETURN_DATA} bytes`);
  }

  // Build the OP_RETURN output script
  const opReturnScript = bitcoin.script.compile([
    bitcoin.opcodes.OP_RETURN,
    opReturnData,
  ]);

  // Estimate fee with change output first
  const estimatedSizeWithChange = estimateTxVsize(true);
  const feeWithChange = Math.ceil(estimatedSizeWithChange * feeRate);
  const changeAmount = utxo.valueSats - feeWithChange;

  // Decide whether to include a change output
  const hasChange = changeAmount >= DUST_THRESHOLD;

  // Recalculate fee if no change output (smaller tx)
  const finalSize = estimateTxVsize(hasChange);
  const fee = Math.ceil(finalSize * feeRate);
  const finalChange = utxo.valueSats - fee;

  if (finalChange < 0) {
    throw new Error(
      `Insufficient funds: UTXO value ${utxo.valueSats} sats, estimated fee ${fee} sats`,
    );
  }

  const psbt = new bitcoin.Psbt({ network: SIGNET_NETWORK });

  // Add input with full raw transaction (nonWitnessUtxo for P2PKH)
  psbt.addInput({
    hash: utxo.txid,
    index: utxo.vout,
    nonWitnessUtxo: Buffer.from(utxo.rawTxHex, 'hex'),
  });

  // Add OP_RETURN output (value = 0)
  psbt.addOutput({
    script: opReturnScript,
    value: 0,
  });

  // Add change output if above dust
  if (hasChange) {
    const { address } = bitcoin.payments.p2pkh({
      pubkey: Buffer.from(keyPair.publicKey),
      network: SIGNET_NETWORK,
    });

    if (!address) {
      throw new Error('Failed to derive change address from key pair');
    }

    psbt.addOutput({
      address,
      value: finalChange,
    });
  } else {
    logger.warn(
      { utxoValue: utxo.valueSats, fee },
      'Change below dust threshold — entire UTXO consumed as fee',
    );
  }

  // Sign
  psbt.signInput(0, {
    publicKey: Buffer.from(keyPair.publicKey),
    sign: (hash: Buffer) => Buffer.from(keyPair.sign(hash)),
  });

  psbt.finalizeAllInputs();

  const tx = psbt.extractTransaction();

  return {
    txHex: tx.toHex(),
    txId: tx.getId(),
    fee,
  };
}

export class SignetChainClient implements ChainClient {
  private readonly keyPair: ReturnType<typeof ECPair.fromWIF>;
  private readonly provider: UtxoProvider;
  private readonly address: string;
  private readonly feeRate: number;

  constructor(signetConfig: SignetConfig | LegacySignetConfig) {
    // Parse the treasury WIF — validation happens here.
    // The WIF itself is NEVER logged (Constitution 1.4).
    try {
      this.keyPair = ECPair.fromWIF(
        signetConfig.treasuryWif,
        SIGNET_NETWORK,
      );
    } catch {
      throw new Error(
        'Invalid BITCOIN_TREASURY_WIF — cannot parse as WIF for Signet network',
      );
    }

    const { address } = bitcoin.payments.p2pkh({
      pubkey: Buffer.from(this.keyPair.publicKey),
      network: SIGNET_NETWORK,
    });

    if (!address) {
      throw new Error('Failed to derive treasury address from WIF');
    }

    this.address = address;

    // Support both new and legacy config shapes
    if ('utxoProvider' in signetConfig) {
      this.provider = signetConfig.utxoProvider;
      this.feeRate = signetConfig.feeRate ?? 1;
    } else {
      // Legacy RPC-only config — wrap in RpcUtxoProvider
      this.provider = new RpcUtxoProvider({
        rpcUrl: signetConfig.rpcUrl,
        rpcAuth: signetConfig.rpcAuth,
      });
      this.feeRate = 1;
    }

    // Log only the address, NEVER the WIF
    logger.info(
      { address: this.address, provider: this.provider.name },
      'Signet chain client initialized',
    );
  }

  async submitFingerprint(
    data: SubmitFingerprintRequest,
  ): Promise<ChainReceipt> {
    logger.info(
      { fingerprint: data.fingerprint },
      'Submitting fingerprint to Signet',
    );

    // 1. Fetch UTXOs for treasury address
    const utxos = await this.provider.listUnspent(this.address);

    if (utxos.length === 0) {
      throw new Error(
        `No UTXOs available for treasury address ${this.address}`,
      );
    }

    logger.debug(
      { utxoCount: utxos.length, address: this.address },
      'Fetched UTXOs for treasury',
    );

    // 2. Select the best UTXO
    const estimatedFee = Math.ceil(estimateTxVsize(true) * this.feeRate);
    const selected = selectUtxo(utxos, estimatedFee);

    if (!selected) {
      const maxValue = Math.max(...utxos.map((u) => u.valueSats));
      throw new Error(
        `No UTXO large enough to cover fee: need ${estimatedFee} sats, largest is ${maxValue} sats`,
      );
    }

    logger.debug(
      { txid: selected.txid, vout: selected.vout, value: selected.valueSats },
      'Selected UTXO for anchor',
    );

    // 3. Build and sign the OP_RETURN transaction
    const { txHex, txId, fee } = buildOpReturnTransaction(
      data.fingerprint,
      selected,
      this.keyPair,
      this.feeRate,
    );

    logger.info(
      { txId, fee, utxoValue: selected.valueSats },
      'Transaction built, broadcasting',
    );

    // 4. Broadcast
    const { txid: broadcastTxid } = await this.provider.broadcastTx(txHex);

    // Sanity check: broadcast returned txid should match our computed txId
    if (broadcastTxid && broadcastTxid !== txId) {
      logger.warn(
        { computed: txId, broadcast: broadcastTxid },
        'Broadcast txid differs from computed txid — using broadcast value',
      );
    }

    const finalTxId = broadcastTxid || txId;

    logger.info(
      { txId: finalTxId, fingerprint: data.fingerprint, fee },
      'Fingerprint anchored on Signet',
    );

    // 5. Get the current block height for the receipt
    const blockchainInfo = await this.provider.getBlockchainInfo();

    return {
      receiptId: finalTxId,
      blockHeight: blockchainInfo.blocks,
      blockTimestamp: new Date().toISOString(),
      confirmations: 0, // Just broadcast, not yet confirmed
    };
  }

  async verifyFingerprint(
    fingerprint: string,
  ): Promise<VerificationResult> {
    logger.info({ fingerprint }, 'Verifying fingerprint on Signet');

    // Search for the fingerprint in recent transactions
    // This is a simplified approach — production would use an indexer
    try {
      // Use provider to get raw transaction and inspect OP_RETURN outputs
      // For now we still use the RPC listtransactions approach when available
      // TODO: P7-TS-13 — Add fingerprint indexing for efficient lookup
      const utxos = await this.provider.listUnspent(this.address);

      // Walk recent transactions looking for our OP_RETURN
      // This is O(n) and not ideal — flagged for future indexer story
      for (const utxo of utxos) {
        try {
          const rawTx = await this.provider.getRawTransaction(utxo.txid);

          for (const output of rawTx.vout) {
            if (output.scriptPubKey.asm.startsWith('OP_RETURN')) {
              const hexData = output.scriptPubKey.hex;
              const expectedSuffix =
                OP_RETURN_PREFIX.toString('hex') +
                fingerprint.toLowerCase();

              if (hexData.includes(expectedSuffix)) {
                let blockHeight = 0;
                if (rawTx.blockhash) {
                  const header = await this.provider.getBlockHeader(
                    rawTx.blockhash,
                  );
                  blockHeight = header.height;
                }

                return {
                  verified: true,
                  receipt: {
                    receiptId: rawTx.txid,
                    blockHeight,
                    blockTimestamp: rawTx.blocktime
                      ? new Date(rawTx.blocktime * 1000).toISOString()
                      : new Date().toISOString(),
                    confirmations: rawTx.confirmations ?? 0,
                  },
                };
              }
            }
          }
        } catch {
          // Skip UTXOs whose parent tx can't be fetched
          continue;
        }
      }

      return {
        verified: false,
        error: 'Fingerprint not found in recent transactions',
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      logger.error({ fingerprint, error: message }, 'Verification failed');
      return {
        verified: false,
        error: `Verification error: ${message}`,
      };
    }
  }

  async getReceipt(receiptId: string): Promise<ChainReceipt | null> {
    logger.info({ receiptId }, 'Getting receipt from Signet');

    try {
      const rawTx = await this.provider.getRawTransaction(receiptId);

      let blockHeight = 0;
      if (rawTx.blockhash) {
        const header = await this.provider.getBlockHeader(rawTx.blockhash);
        blockHeight = header.height;
      }

      return {
        receiptId: rawTx.txid,
        blockHeight,
        blockTimestamp: rawTx.blocktime
          ? new Date(rawTx.blocktime * 1000).toISOString()
          : new Date().toISOString(),
        confirmations: rawTx.confirmations ?? 0,
      };
    } catch {
      logger.warn({ receiptId }, 'Receipt not found on Signet');
      return null;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const info = await this.provider.getBlockchainInfo();

      // Verify we're actually on signet/testnet
      const isSignet = info.chain === 'signet' || info.chain === 'test';
      logger.info(
        { chain: info.chain, blocks: info.blocks, healthy: isSignet },
        'Signet health check',
      );
      return isSignet;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      logger.error({ error: message }, 'Signet health check failed');
      return false;
    }
  }
}
