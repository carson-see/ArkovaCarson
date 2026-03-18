/**
 * Bitcoin Chain Client (formerly SignetChainClient)
 *
 * Real implementation of the ChainClient interface using bitcoinjs-lib.
 * Constructs OP_RETURN transactions to anchor document fingerprints
 * on Bitcoin (Signet, testnet, or mainnet).
 *
 * Accepts pluggable SigningProvider (WIF or KMS) and FeeEstimator
 * (static or mempool.space) so the same class works for all networks.
 *
 * UTXO fetching and tx broadcasting are delegated to a UtxoProvider,
 * supporting either Bitcoin Core RPC or Mempool.space REST API.
 *
 * Constitution refs:
 *   - 1.1: bitcoinjs-lib + AWS KMS (target)
 *   - 1.4: Treasury/signing keys server-side only, never logged
 *   - 1.6: generateFingerprint is client-side only — this file never imports it
 *
 * Stories: P7-TS-05 (Signet chain client), P7-TS-12 (UTXO management), CRIT-2 (completion)
 */

import * as bitcoin from 'bitcoinjs-lib';
import { logger } from '../utils/logger.js';
import type {
  ChainClient,
  ChainReceipt,
  ChainIndexLookup,
  SubmitFingerprintRequest,
  VerificationResult,
} from './types.js';
import { RpcUtxoProvider, type UtxoProvider, type Utxo } from './utxo-provider.js';
import type { SigningProvider } from './signing-provider.js';
import { WifSigningProvider } from './signing-provider.js';
import type { FeeEstimator } from './fee-estimator.js';
import { StaticFeeEstimator } from './fee-estimator.js';

// Default network: Signet uses testnet network parameters
const SIGNET_NETWORK = bitcoin.networks.testnet;

// OP_RETURN prefix for Arkova anchors (4 bytes: 'ARKV')
const OP_RETURN_PREFIX = Buffer.from('ARKV');

// Maximum OP_RETURN payload is 80 bytes. Prefix (4) + SHA-256 hash (32) = 36 bytes.
const MAX_OP_RETURN_DATA = 80;

// ─── Legacy Config (backward compat) ────────────────────────────────────

export interface SignetConfig {
  /** Treasury WIF for signing transactions — NEVER log this */
  treasuryWif: string;
  /** UTXO provider instance (RPC or Mempool.space) */
  utxoProvider: UtxoProvider;
  /** Fee rate in sat/vbyte. Defaults to 1 (Signet minimum). */
  feeRate?: number;
}

/** @deprecated Use SignetConfig with utxoProvider instead */
export interface LegacySignetConfig {
  treasuryWif: string;
  rpcUrl: string;
  rpcAuth?: string;
}

// ─── New Config (supports SigningProvider + FeeEstimator) ────────────────

export interface BitcoinClientConfig {
  /** Pluggable signing provider (WIF or KMS) */
  signingProvider: SigningProvider;
  /** UTXO provider instance (RPC or Mempool.space) */
  utxoProvider: UtxoProvider;
  /** Fee estimator (static or mempool). Defaults to StaticFeeEstimator(1). */
  feeEstimator?: FeeEstimator;
  /** Bitcoin network. Defaults to testnet (Signet). */
  network?: bitcoin.Network;
  /** Optional chain index for O(1) fingerprint verification */
  chainIndex?: ChainIndexLookup;
}

/**
 * UTXO selected for spending, with the full raw tx for PSBT.
 */
export interface SelectedUtxo {
  txid: string;
  vout: number;
  /** Value in satoshis */
  valueSats: number;
  /** Full raw transaction hex (legacy — kept for RPC provider compat, unused by P2WPKH signing) */
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
 * P2WPKH input: ~68 vbytes (SegWit discount on witness data)
 * OP_RETURN output (36-byte payload): ~47 vbytes
 * P2WPKH change output: ~31 vbytes
 * Overhead: ~11 vbytes (version + locktime + witness flag)
 */
export function estimateTxVsize(hasChange: boolean): number {
  const INPUT_SIZE = 68;
  const OP_RETURN_OUTPUT_SIZE = 47;
  const CHANGE_OUTPUT_SIZE = 31;
  const OVERHEAD = 11;

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
 * Now async to support KMS signing (via SigningProvider).
 *
 * Transaction structure:
 *   Input:  Selected UTXO from treasury address
 *   Output 0: OP_RETURN <ARKV><sha256_hex_as_bytes>
 *   Output 1: Change back to treasury (input - fee), if above dust
 *
 * @param fingerprint - 64-char hex SHA-256 hash
 * @param utxo - Selected UTXO to spend
 * @param signer - SigningProvider (WIF or KMS)
 * @param feeRate - Fee rate in sat/vbyte (default 1)
 * @param network - Bitcoin network (default testnet/Signet)
 */
export async function buildOpReturnTransaction(
  fingerprint: string,
  utxo: SelectedUtxo,
  signer: SigningProvider,
  feeRate: number = 1, // sat/vbyte — Signet minimum
  network: bitcoin.Network = SIGNET_NETWORK,
): Promise<{ txHex: string; txId: string; fee: number }> {
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

  const psbt = new bitcoin.Psbt({ network });

  // Derive the P2WPKH script for witnessUtxo
  const p2wpkh = bitcoin.payments.p2wpkh({
    pubkey: signer.getPublicKey(),
    network,
  });

  // Add input with witnessUtxo (SegWit P2WPKH)
  psbt.addInput({
    hash: utxo.txid,
    index: utxo.vout,
    witnessUtxo: {
      script: p2wpkh.output!,
      value: utxo.valueSats,
    },
  });

  // Add OP_RETURN output (value = 0)
  psbt.addOutput({
    script: opReturnScript,
    value: 0,
  });

  // Add change output if above dust (P2WPKH SegWit)
  const publicKey = signer.getPublicKey();
  if (hasChange) {
    const { address } = bitcoin.payments.p2wpkh({
      pubkey: publicKey,
      network,
    });

    if (!address) {
      throw new Error('Failed to derive change address from signing provider');
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

  // Sign asynchronously (supports both WIF and KMS)
  await psbt.signInputAsync(0, {
    publicKey,
    sign: (hash: Buffer) => signer.sign(hash),
  });

  psbt.finalizeAllInputs();

  const tx = psbt.extractTransaction();

  return {
    txHex: tx.toHex(),
    txId: tx.getId(),
    fee,
  };
}

// ─── Type guard helpers for config shapes ────────────────────────────────

function isBitcoinClientConfig(
  cfg: SignetConfig | LegacySignetConfig | BitcoinClientConfig,
): cfg is BitcoinClientConfig {
  return 'signingProvider' in cfg;
}

function isSignetConfig(
  cfg: SignetConfig | LegacySignetConfig,
): cfg is SignetConfig {
  return 'utxoProvider' in cfg;
}

// ─── Bitcoin Chain Client ────────────────────────────────────────────────

export class BitcoinChainClient implements ChainClient {
  private readonly signingProvider: SigningProvider;
  private readonly provider: UtxoProvider;
  private readonly feeEstimator: FeeEstimator;
  private readonly address: string;
  private readonly network: bitcoin.Network;
  private readonly chainIndex?: ChainIndexLookup;

  constructor(clientConfig: BitcoinClientConfig | SignetConfig | LegacySignetConfig) {
    if (isBitcoinClientConfig(clientConfig)) {
      // ── New config path: SigningProvider + FeeEstimator ──
      this.signingProvider = clientConfig.signingProvider;
      this.provider = clientConfig.utxoProvider;
      this.feeEstimator = clientConfig.feeEstimator ?? new StaticFeeEstimator(1);
      this.network = clientConfig.network ?? SIGNET_NETWORK;
      this.chainIndex = clientConfig.chainIndex;
    } else if (isSignetConfig(clientConfig)) {
      // ── SignetConfig path: wrap WIF in provider ──
      this.signingProvider = new WifSigningProvider(clientConfig.treasuryWif, SIGNET_NETWORK);
      this.provider = clientConfig.utxoProvider;
      this.feeEstimator = new StaticFeeEstimator(clientConfig.feeRate ?? 1);
      this.network = SIGNET_NETWORK;
    } else {
      // ── Legacy RPC-only config ──
      this.signingProvider = new WifSigningProvider(clientConfig.treasuryWif, SIGNET_NETWORK);
      this.provider = new RpcUtxoProvider({
        rpcUrl: clientConfig.rpcUrl,
        rpcAuth: clientConfig.rpcAuth,
      });
      this.feeEstimator = new StaticFeeEstimator(1);
      this.network = SIGNET_NETWORK;
    }

    // Derive SegWit address from signing provider's public key
    const { address } = bitcoin.payments.p2wpkh({
      pubkey: this.signingProvider.getPublicKey(),
      network: this.network,
    });

    if (!address) {
      throw new Error('Failed to derive treasury address from signing provider');
    }

    this.address = address;

    // Log only the address, NEVER the key material (Constitution 1.4)
    logger.info(
      {
        address: this.address,
        provider: this.provider.name,
        signer: this.signingProvider.name,
        feeEstimator: this.feeEstimator.name,
      },
      'Bitcoin chain client initialized',
    );
  }

  async submitFingerprint(
    data: SubmitFingerprintRequest,
  ): Promise<ChainReceipt> {
    logger.info(
      { fingerprint: data.fingerprint },
      'Submitting fingerprint to chain',
    );

    // 1. Estimate fee rate
    const feeRate = await this.feeEstimator.estimateFee();
    logger.debug({ feeRate, estimator: this.feeEstimator.name }, 'Fee rate estimated');

    // 2. Fetch UTXOs for treasury address
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

    // 3. Select the best UTXO
    const estimatedFee = Math.ceil(estimateTxVsize(true) * feeRate);
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

    // 4. Build and sign the OP_RETURN transaction (async for KMS)
    const { txHex, txId, fee } = await buildOpReturnTransaction(
      data.fingerprint,
      selected,
      this.signingProvider,
      feeRate,
      this.network,
    );

    logger.info(
      { txId, fee, utxoValue: selected.valueSats },
      'Transaction built, broadcasting',
    );

    // 5. Broadcast
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
      'Fingerprint anchored on chain',
    );

    // 6. Get the current block height for the receipt
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
    logger.info({ fingerprint }, 'Verifying fingerprint on chain');

    // ── Step 1: Try chain index first (O(1) lookup) ──
    if (this.chainIndex) {
      try {
        const entry = await this.chainIndex.lookupFingerprint(fingerprint);
        if (entry) {
          logger.debug(
            { fingerprint, txId: entry.chainTxId },
            'Fingerprint found via chain index',
          );
          return {
            verified: true,
            receipt: {
              receiptId: entry.chainTxId,
              blockHeight: entry.blockHeight ?? 0,
              blockTimestamp: entry.blockTimestamp ?? new Date().toISOString(),
              confirmations: entry.confirmations ?? 0,
            },
          };
        }
        logger.debug({ fingerprint }, 'Fingerprint not in chain index, falling back to UTXO scan');
      } catch (indexError) {
        const message = indexError instanceof Error ? indexError.message : String(indexError);
        logger.warn(
          { fingerprint, error: message },
          'Chain index lookup failed, falling back to UTXO scan',
        );
      }
    }

    // ── Step 2: Fall back to O(n) UTXO scan ──
    try {
      const utxos = await this.provider.listUnspent(this.address);

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
    logger.info({ receiptId }, 'Getting receipt from chain');

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
      logger.warn({ receiptId }, 'Receipt not found on chain');
      return null;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const info = await this.provider.getBlockchainInfo();

      // Accept signet, testnet, testnet4, and mainnet chain names
      const isValid =
        info.chain === 'signet' ||
        info.chain === 'test' ||
        info.chain === 'testnet4' ||
        info.chain === 'main';

      logger.info(
        { chain: info.chain, blocks: info.blocks, healthy: isValid },
        'Chain health check',
      );
      return isValid;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      logger.error({ error: message }, 'Chain health check failed');
      return false;
    }
  }
}

// ─── Backward-compatible alias ──────────────────────────────────────────

/** @deprecated Use BitcoinChainClient — this alias exists for backward compatibility. */
export const SignetChainClient = BitcoinChainClient;
