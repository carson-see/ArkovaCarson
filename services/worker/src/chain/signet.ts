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
import { createHash } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
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

// Maximum OP_RETURN payload is 80 bytes.
// Without metadata: Prefix (4) + SHA-256 fingerprint (32) = 36 bytes.
// With metadata:    Prefix (4) + SHA-256 fingerprint (32) + truncated metadata hash (8) = 44 bytes.
const MAX_OP_RETURN_DATA = 80;

/**
 * CRIT-6: Truncated metadata hash length in bytes (appended after fingerprint in OP_RETURN).
 *
 * Security tradeoff:
 *   8 bytes (64-bit) → birthday bound 2^32 (~4B). At 10K docs/day, collision in ~20 years.
 *     Adversarial preimage: ~4B attempts (~hours on modern hardware). Acceptable for integrity, not security.
 *   16 bytes (128-bit) → birthday bound 2^64. Computationally infeasible collision.
 *     Total payload: 52 bytes (ARKV:4 + fingerprint:32 + metadataHash:16). Still under 80-byte limit.
 *
 * Default: 8 bytes. Set METADATA_HASH_BYTES=16 env var for enhanced collision resistance.
 * The fingerprint (32 bytes, full SHA-256) remains the primary integrity guarantee.
 */
const METADATA_HASH_TRUNCATED_BYTES = (() => {
  const envBytes = parseInt(process.env.METADATA_HASH_BYTES ?? '8', 10);
  if (envBytes === 16) return 16;
  return 8; // Default — only 8 or 16 allowed
})();

/**
 * Compute a canonical JSON representation of metadata for deterministic hashing.
 * Keys are sorted alphabetically, values are stringified deterministically.
 */
export function canonicalMetadataJson(metadata: Record<string, unknown>): string {
  const sortedKeys = Object.keys(metadata).sort();
  const sorted: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    sorted[key] = metadata[key];
  }
  return JSON.stringify(sorted);
}

/**
 * SHA-256 hash of canonical metadata JSON.
 * Returns the full 64-char hex hash.
 */
export function hashMetadata(metadata: Record<string, unknown>): string {
  const canonical = canonicalMetadataJson(metadata);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Truncate a full SHA-256 hex hash to METADATA_HASH_TRUNCATED_BYTES bytes.
 * Returns a Buffer of the truncated hash for inclusion in OP_RETURN.
 */
export function truncateMetadataHash(fullHash: string): Buffer {
  return Buffer.from(fullHash, 'hex').subarray(0, METADATA_HASH_TRUNCATED_BYTES);
}

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
 * INEFF-4/CRIT-5: Select multiple UTXOs to cover the required fee.
 *
 * When no single UTXO is large enough, combine multiple smaller ones.
 * Also enables UTXO consolidation as a side effect (many inputs → one change output).
 *
 * Strategy: largest-first accumulation until total >= requiredFee.
 * Each additional input adds ~68 vbytes to the transaction.
 *
 * @param utxos - Available UTXOs from the provider
 * @param requiredFee - Minimum fee in satoshis (for single input)
 * @param feeRate - Fee rate in sat/vbyte (needed to account for additional input costs)
 * @returns Array of selected UTXOs, or null if total value is insufficient
 */
export function selectMultipleUtxos(
  utxos: Utxo[],
  requiredFee: number,
  feeRate: number,
): SelectedUtxo[] | null {
  if (utxos.length === 0) return null;

  const INPUT_VSIZE = 68; // P2WPKH input vbytes
  const sorted = [...utxos].sort((a, b) => b.valueSats - a.valueSats);

  // Try single UTXO first (most efficient)
  if (sorted[0].valueSats >= requiredFee) {
    return [{
      txid: sorted[0].txid,
      vout: sorted[0].vout,
      valueSats: sorted[0].valueSats,
      rawTxHex: sorted[0].rawTxHex,
    }];
  }

  // Accumulate UTXOs until we have enough
  const selected: SelectedUtxo[] = [];
  let totalValue = 0;
  let totalFeeNeeded = requiredFee;

  for (const u of sorted) {
    selected.push({
      txid: u.txid,
      vout: u.vout,
      valueSats: u.valueSats,
      rawTxHex: u.rawTxHex,
    });
    totalValue += u.valueSats;

    // Each additional input beyond the first adds to the fee
    if (selected.length > 1) {
      totalFeeNeeded = requiredFee + (selected.length - 1) * INPUT_VSIZE * feeRate;
    }

    if (totalValue >= totalFeeNeeded) {
      return selected;
    }
  }

  // Not enough total value even with all UTXOs
  return null;
}

/**
 * Estimate the virtual size of an OP_RETURN anchor transaction.
 *
 * P2WPKH input: ~68 vbytes (SegWit discount on witness data)
 * OP_RETURN output: ~(11 + payloadSize) vbytes (8 value + 1 scriptLen + 1 OP_RETURN + 1 push + payload)
 * P2WPKH change output: ~31 vbytes
 * Overhead: ~11 vbytes (version + locktime + witness flag)
 *
 * @param hasChange - Whether to include a change output
 * @param opReturnPayloadSize - Size of the OP_RETURN data payload in bytes (default 36: ARKV + fingerprint)
 */
export function estimateTxVsize(hasChange: boolean, opReturnPayloadSize: number = 36): number {
  const INPUT_SIZE = 68;
  const OP_RETURN_OVERHEAD = 11; // 8 (value) + 1 (scriptLen) + 1 (OP_RETURN) + 1 (push opcode)
  const OP_RETURN_OUTPUT_SIZE = OP_RETURN_OVERHEAD + opReturnPayloadSize;
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
 * CRIT-3: BIP125 RBF opt-in nSequence value.
 * Per BIP125, any input with nSequence < 0xfffffffe signals RBF replaceability.
 * 0xfffffffd enables both RBF and nLockTime (0xfffffffe disables RBF).
 * This allows fee-bumping stuck transactions via replacement.
 */
const RBF_SEQUENCE = 0xfffffffd;

/**
 * Build an OP_RETURN transaction embedding a document fingerprint
 * and optional truncated metadata hash.
 *
 * Now async to support KMS signing (via SigningProvider).
 *
 * Transaction structure:
 *   Input:  Selected UTXO from treasury address
 *   Output 0: OP_RETURN <ARKV><sha256_fingerprint>[<metadata_hash_8bytes>]
 *   Output 1: Change back to treasury (input - fee), if above dust
 *
 * @param fingerprint - 64-char hex SHA-256 hash
 * @param utxo - Selected UTXO to spend
 * @param signer - SigningProvider (WIF or KMS)
 * @param feeRate - Fee rate in sat/vbyte (default 1)
 * @param network - Bitcoin network (default testnet/Signet)
 * @param metadataHashBytes - Optional truncated metadata hash (8 bytes) to append after fingerprint
 */
export async function buildOpReturnTransaction(
  fingerprint: string,
  utxo: SelectedUtxo,
  signer: SigningProvider,
  feeRate: number = 1, // sat/vbyte — Signet minimum
  network: bitcoin.Network = SIGNET_NETWORK,
  metadataHashBytes?: Buffer,
): Promise<{ txHex: string; txId: string; fee: number }> {
  // Validate fingerprint is a 64-char hex string (SHA-256)
  if (!/^[a-f0-9]{64}$/i.test(fingerprint)) {
    throw new Error('Fingerprint must be a 64-character hex string (SHA-256)');
  }

  // Validate metadata hash bytes if provided
  if (metadataHashBytes && metadataHashBytes.length !== METADATA_HASH_TRUNCATED_BYTES) {
    throw new Error(`Metadata hash must be exactly ${METADATA_HASH_TRUNCATED_BYTES} bytes`);
  }

  const fingerprintBytes = Buffer.from(fingerprint, 'hex');
  const opReturnData = metadataHashBytes
    ? Buffer.concat([OP_RETURN_PREFIX, fingerprintBytes, metadataHashBytes])
    : Buffer.concat([OP_RETURN_PREFIX, fingerprintBytes]);

  if (opReturnData.length > MAX_OP_RETURN_DATA) {
    throw new Error(`OP_RETURN data exceeds ${MAX_OP_RETURN_DATA} bytes`);
  }

  // Build the OP_RETURN output script
  const opReturnScript = bitcoin.script.compile([
    bitcoin.opcodes.OP_RETURN,
    opReturnData,
  ]);

  // Estimate fee with change output first
  const payloadSize = opReturnData.length;
  const estimatedSizeWithChange = estimateTxVsize(true, payloadSize);
  const feeWithChange = Math.ceil(estimatedSizeWithChange * feeRate);
  const changeAmount = utxo.valueSats - feeWithChange;

  // Decide whether to include a change output
  const hasChange = changeAmount >= DUST_THRESHOLD;

  // Recalculate fee if no change output (smaller tx)
  const finalSize = estimateTxVsize(hasChange, payloadSize);
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
  // CRIT-3: Set nSequence to 0xfffffffd for BIP125 RBF opt-in
  psbt.addInput({
    hash: utxo.txid,
    index: utxo.vout,
    sequence: RBF_SEQUENCE,
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

/**
 * INEFF-4: Build a multi-input OP_RETURN transaction.
 * Combines multiple UTXOs into a single transaction, enabling:
 * - Spending when no single UTXO covers the fee
 * - Implicit UTXO consolidation (many inputs → one change output)
 */
export async function buildMultiInputOpReturnTransaction(
  fingerprint: string,
  utxos: SelectedUtxo[],
  signer: SigningProvider,
  feeRate: number = 1,
  network: bitcoin.Network = SIGNET_NETWORK,
  metadataHashBytes?: Buffer,
): Promise<{ txHex: string; txId: string; fee: number }> {
  if (!/^[a-f0-9]{64}$/i.test(fingerprint)) {
    throw new Error('Fingerprint must be a 64-character hex string (SHA-256)');
  }
  if (utxos.length === 0) {
    throw new Error('At least one UTXO required');
  }

  const fingerprintBytes = Buffer.from(fingerprint, 'hex');
  const opReturnData = metadataHashBytes
    ? Buffer.concat([OP_RETURN_PREFIX, fingerprintBytes, metadataHashBytes])
    : Buffer.concat([OP_RETURN_PREFIX, fingerprintBytes]);

  if (opReturnData.length > MAX_OP_RETURN_DATA) {
    throw new Error(`OP_RETURN data exceeds ${MAX_OP_RETURN_DATA} bytes`);
  }

  const opReturnScript = bitcoin.script.compile([
    bitcoin.opcodes.OP_RETURN,
    opReturnData,
  ]);

  const totalInputValue = utxos.reduce((sum, u) => sum + u.valueSats, 0);

  // Estimate fee: multiple inputs + OP_RETURN + potential change
  const INPUT_SIZE = 68;
  const OP_RETURN_OVERHEAD = 11;
  const CHANGE_OUTPUT_SIZE = 31;
  const OVERHEAD = 11;
  const txSizeWithChange = (INPUT_SIZE * utxos.length) + OP_RETURN_OVERHEAD + opReturnData.length + CHANGE_OUTPUT_SIZE + OVERHEAD;
  const feeWithChange = Math.ceil(txSizeWithChange * feeRate);
  const changeAmount = totalInputValue - feeWithChange;
  const hasChange = changeAmount >= DUST_THRESHOLD;

  const txSizeFinal = (INPUT_SIZE * utxos.length) + OP_RETURN_OVERHEAD + opReturnData.length + (hasChange ? CHANGE_OUTPUT_SIZE : 0) + OVERHEAD;
  const fee = Math.ceil(txSizeFinal * feeRate);
  const finalChange = totalInputValue - fee;

  if (finalChange < 0) {
    throw new Error(
      `Insufficient funds: total UTXO value ${totalInputValue} sats, estimated fee ${fee} sats`,
    );
  }

  const psbt = new bitcoin.Psbt({ network });
  const publicKey = Buffer.from(signer.getPublicKey());
  const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: publicKey, network });

  // Add all inputs with RBF signaling
  for (const utxo of utxos) {
    psbt.addInput({
      hash: utxo.txid,
      index: utxo.vout,
      sequence: RBF_SEQUENCE,
      witnessUtxo: {
        script: p2wpkh.output!,
        value: utxo.valueSats,
      },
    });
  }

  // OP_RETURN output
  psbt.addOutput({ script: opReturnScript, value: 0 });

  // Change output if above dust
  if (hasChange && finalChange >= DUST_THRESHOLD) {
    const { address } = bitcoin.payments.p2wpkh({ pubkey: publicKey, network });
    if (!address) throw new Error('Failed to derive change address');
    psbt.addOutput({ address, value: finalChange });
  }

  // Sign all inputs
  for (let i = 0; i < utxos.length; i++) {
    await psbt.signInputAsync(i, {
      publicKey,
      sign: (hash: Buffer) => signer.sign(hash),
    });
  }

  psbt.finalizeAllInputs();
  const tx = psbt.extractTransaction();

  return { txHex: tx.toHex(), txId: tx.getId(), fee };
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
      { fingerprint: data.fingerprint, hasMetadata: !!data.metadata },
      'Submitting fingerprint to chain',
    );

    // 1. Compute metadata hash if metadata provided (DEMO-01)
    let metadataHashBytes: Buffer | undefined;
    let fullMetadataHash: string | undefined;
    if (data.metadata && Object.keys(data.metadata).length > 0) {
      fullMetadataHash = hashMetadata(data.metadata);
      metadataHashBytes = truncateMetadataHash(fullMetadataHash);
      logger.info(
        { metadataHash: fullMetadataHash, truncatedHex: metadataHashBytes.toString('hex') },
        'Metadata hash computed for OP_RETURN',
      );
    }

    // 2. Estimate fee rate
    const feeRate = await this.feeEstimator.estimateFee();
    logger.debug({ feeRate, estimator: this.feeEstimator.name }, 'Fee rate estimated');

    // PERF-7: Fee ceiling — reject if fee rate exceeds configured maximum
    if (config.bitcoinMaxFeeRate && feeRate > config.bitcoinMaxFeeRate) {
      throw new Error(
        `Fee rate ${feeRate} sat/vB exceeds ceiling ${config.bitcoinMaxFeeRate} sat/vB — anchor queued for later`,
      );
    }

    // 3. Fetch UTXOs for treasury address
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

    // 4. Select the best UTXO(s) — try single first, then multi-input
    const payloadSize = metadataHashBytes ? 44 : 36; // ARKV(4) + fingerprint(32) [+ metadataHash(8)]
    const estimatedFee = Math.ceil(estimateTxVsize(true, payloadSize) * feeRate);
    const selected = selectUtxo(utxos, estimatedFee);

    if (!selected) {
      // INEFF-4: Fall back to multi-input selection
      const multiSelected = selectMultipleUtxos(utxos, estimatedFee, feeRate);
      if (!multiSelected) {
        const totalValue = utxos.reduce((sum, u) => sum + u.valueSats, 0);
        throw new Error(
          `Insufficient total UTXO value: need ${estimatedFee} sats, total available is ${totalValue} sats`,
        );
      }

      logger.info(
        { inputCount: multiSelected.length, totalValue: multiSelected.reduce((s, u) => s + u.valueSats, 0) },
        'Using multi-input UTXO selection (INEFF-4)',
      );

      // Build multi-input transaction
      const { txHex: multiTxHex, txId: multiTxId, fee: multiFee } = await buildMultiInputOpReturnTransaction(
        data.fingerprint,
        multiSelected,
        this.signingProvider,
        feeRate,
        this.network,
        metadataHashBytes,
      );

      logger.info(
        { txId: multiTxId, fee: multiFee, inputCount: multiSelected.length },
        'Multi-input transaction built, broadcasting',
      );

      const { txid: multiBroadcastTxid } = await this.provider.broadcastTx(multiTxHex);
      const finalMultiTxId = multiBroadcastTxid || multiTxId;
      const blockchainInfo = await this.provider.getBlockchainInfo();

      return {
        receiptId: finalMultiTxId,
        blockHeight: blockchainInfo.blocks,
        blockTimestamp: new Date().toISOString(),
        confirmations: 0,
        metadataHash: fullMetadataHash,
        rawTxHex: multiTxHex,
        feeSats: multiFee,
      };
    }

    logger.debug(
      { txid: selected.txid, vout: selected.vout, value: selected.valueSats },
      'Selected UTXO for anchor',
    );

    // 5. Build and sign the OP_RETURN transaction (async for KMS)
    const { txHex, txId, fee } = await buildOpReturnTransaction(
      data.fingerprint,
      selected,
      this.signingProvider,
      feeRate,
      this.network,
      metadataHashBytes,
    );

    logger.info(
      { txId, fee, utxoValue: selected.valueSats },
      'Transaction built, broadcasting',
    );

    // 6. Broadcast
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
      { txId: finalTxId, fingerprint: data.fingerprint, fee, metadataHash: fullMetadataHash },
      'Fingerprint anchored on chain',
    );

    // 7. Get the current block height for the receipt
    const blockchainInfo = await this.provider.getBlockchainInfo();

    return {
      receiptId: finalTxId,
      blockHeight: blockchainInfo.blocks,
      blockTimestamp: new Date().toISOString(),
      confirmations: 0, // Just broadcast, not yet confirmed
      metadataHash: fullMetadataHash,
      rawTxHex: txHex, // NET-4: Store for rebroadcast, RBF, and audit
      feeSats: fee, // Cost tracking per anchor
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

  /**
   * Pre-flight check: verify treasury has available UTXOs before claiming anchors.
   * Prevents the claim-fail-revert cycle when treasury is depleted.
   */
  async hasFunds(): Promise<boolean> {
    try {
      const utxos = await this.provider.listUnspent(this.address);
      if (utxos.length === 0) {
        logger.warn(
          { address: this.address },
          'Treasury has no UTXOs — batch processing will be skipped until funded',
        );
        return false;
      }
      const totalSats = utxos.reduce((sum, u) => sum + u.valueSats, 0);
      logger.info(
        { utxoCount: utxos.length, totalSats, address: this.address },
        'Treasury pre-flight check passed',
      );
      return true;
    } catch (error) {
      logger.error({ error }, 'Treasury pre-flight UTXO check failed');
      return false;
    }
  }
}

// ─── Backward-compatible alias ──────────────────────────────────────────

/** @deprecated Use BitcoinChainClient — this alias exists for backward compatibility. */
export const SignetChainClient = BitcoinChainClient;
