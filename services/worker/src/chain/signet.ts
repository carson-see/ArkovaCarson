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
  PreparedChainTx,
  SubmitFingerprintRequest,
  VerificationResult,
} from './types.js';
import { RpcUtxoProvider, HttpError, RpcApplicationError, type UtxoProvider, type Utxo, type RawTransaction } from './utxo-provider.js';
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

/**
 * BUG-2026-06-24-004: Structurally decode an output scriptPubKey and return the
 * Arkova-committed fingerprint, or null if the script is not a canonical Arkova
 * anchor.
 *
 * A canonical anchor is exactly `OP_RETURN <buffer>` where the single pushed
 * buffer begins with the 4-byte `ARKV` prefix immediately followed by the
 * 32-byte SHA-256 fingerprint (an optional truncated metadata hash may trail it).
 *
 * This validates the COMMITTED payload at its canonical byte offset — it does NOT
 * do a loose substring scan of the raw hex. A crafted OP_RETURN that merely
 * contains the bytes `ARKV<fingerprint>` somewhere in its payload (e.g. behind a
 * junk byte, or as multiple pushes) decompiles to a different structure and is
 * correctly rejected.
 *
 * @param scriptPubKeyHex - Output scriptPubKey as hex
 * @returns lowercase 64-char hex fingerprint, or null if not a canonical anchor
 */
export function extractAnchorFingerprint(scriptPubKeyHex: string): string | null {
  let chunks: ReturnType<typeof bitcoin.script.decompile>;
  try {
    chunks = bitcoin.script.decompile(Buffer.from(scriptPubKeyHex, 'hex'));
  } catch {
    return null;
  }

  // Must be exactly [OP_RETURN, <data buffer>].
  if (!chunks || chunks.length !== 2) return null;
  if (chunks[0] !== bitcoin.opcodes.OP_RETURN) return null;

  const payload = chunks[1];
  // The second chunk must be a pushed data buffer (not a number/opcode).
  if (!Buffer.isBuffer(payload)) return null;

  // Need at least prefix (4) + fingerprint (32) = 36 bytes of committed data.
  if (payload.length < OP_RETURN_PREFIX.length + 32) return null;

  // Prefix must match at offset 0 (NOT anywhere in the buffer).
  if (!payload.subarray(0, OP_RETURN_PREFIX.length).equals(OP_RETURN_PREFIX)) {
    return null;
  }

  return payload
    .subarray(OP_RETURN_PREFIX.length, OP_RETURN_PREFIX.length + 32)
    .toString('hex');
}

/**
 * BUG-2026-06-24-004: True iff `scriptPubKeyHex` is a canonical Arkova anchor
 * committing exactly `fingerprint` (case-insensitive).
 */
function scriptCommitsFingerprint(scriptPubKeyHex: string, fingerprint: string): boolean {
  const committed = extractAnchorFingerprint(scriptPubKeyHex);
  return committed !== null && committed === fingerprint.toLowerCase();
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
 * Project the REAL fee of a multi-input OP_RETURN anchor transaction with
 * `inputCount` inputs, mirroring the vsize math in
 * `buildMultiInputOpReturnTransaction` so the selector and the builder agree.
 *
 * @param inputCount - Number of P2WPKH inputs in the transaction
 * @param payloadSize - OP_RETURN data payload size in bytes (36 = ARKV + fingerprint; 44 with metadata)
 * @param feeRate - Fee rate in sat/vbyte
 * @param withChange - Whether to include the change output in the size estimate
 */
function projectMultiInputFee(
  inputCount: number,
  payloadSize: number,
  feeRate: number,
  withChange: boolean,
): number {
  const INPUT_SIZE = 68; // P2WPKH input vbytes
  const OP_RETURN_OVERHEAD = 11; // 8 (value) + 1 (scriptLen) + 1 (OP_RETURN) + 1 (push opcode)
  const CHANGE_OUTPUT_SIZE = 31; // P2WPKH change output
  const OVERHEAD = 11; // version + locktime + witness flag
  const vsize =
    INPUT_SIZE * inputCount +
    OP_RETURN_OVERHEAD +
    payloadSize +
    (withChange ? CHANGE_OUTPUT_SIZE : 0) +
    OVERHEAD;
  return Math.ceil(vsize * feeRate);
}

/**
 * INEFF-4/CRIT-5: Select multiple UTXOs to cover the required fee.
 *
 * When no single UTXO is large enough, combine multiple smaller ones.
 * Also enables UTXO consolidation as a side effect (many inputs → one change output).
 *
 * Strategy: largest-first accumulation until the running total clears the fee
 * threshold for the ACTUAL number of inputs selected so far.
 *
 * BUG-2026-06-24-005 (treasury liveness): the threshold is computed from the
 * real projected vsize for `selected.length` inputs — `INPUT_SIZE*n +
 * OP_RETURN_OVERHEAD + payloadSize + CHANGE + OVERHEAD` — exactly matching
 * `buildMultiInputOpReturnTransaction`, PLUS a dust reservation so the chosen
 * set leaves a spendable change output. The previous implementation escalated
 * only by extra-input vbytes on top of a single-input estimate and ignored the
 * change-below-dust band, so it could return a set whose real build either
 * silently burned sub-dust change as fee or threw `Insufficient funds` —
 * wedging the batch (processBatchAnchors bulk-reverts BROADCASTING → PENDING).
 *
 * @param utxos - Available UTXOs from the provider
 * @param requiredFee - Single-input fee estimate in satoshis (kept as a floor for backward compat)
 * @param feeRate - Fee rate in sat/vbyte
 * @param payloadSize - OP_RETURN payload size in bytes (default 36: ARKV + fingerprint)
 * @returns Array of selected UTXOs, or null if no dust-safe combination exists
 */
export function selectMultipleUtxos(
  utxos: Utxo[],
  requiredFee: number,
  feeRate: number,
  payloadSize: number = 36,
): SelectedUtxo[] | null {
  if (utxos.length === 0) return null;

  const sorted = [...utxos].sort((a, b) => b.valueSats - a.valueSats);

  // Try single UTXO first (most efficient). Reserve the dust threshold on top
  // of the single-input projected fee so the change output is spendable rather
  // than silently burned as fee (BUG-2026-06-24-005). Floored by the caller's
  // requiredFee estimate for backward compatibility.
  const singleInputThreshold = Math.max(
    requiredFee,
    projectMultiInputFee(1, payloadSize, feeRate, true) + DUST_THRESHOLD,
  );
  if (sorted[0].valueSats >= singleInputThreshold) {
    return [{
      txid: sorted[0].txid,
      vout: sorted[0].vout,
      valueSats: sorted[0].valueSats,
      rawTxHex: sorted[0].rawTxHex,
    }];
  }

  // Accumulate UTXOs until the total clears the dust-safe threshold for the
  // current input count.
  const selected: SelectedUtxo[] = [];
  let totalValue = 0;

  for (const u of sorted) {
    selected.push({
      txid: u.txid,
      vout: u.vout,
      valueSats: u.valueSats,
      rawTxHex: u.rawTxHex,
    });
    totalValue += u.valueSats;

    // Real fee for a tx with `selected.length` inputs that keeps a change
    // output, reserving the dust threshold so the change is spendable rather
    // than silently burned as fee. Floored by the caller's single-input
    // estimate so the selector never returns less than the caller expects.
    const feeWithChange = projectMultiInputFee(selected.length, payloadSize, feeRate, true);
    const totalFeeNeeded = Math.max(requiredFee, feeWithChange + DUST_THRESHOLD);

    if (totalValue >= totalFeeNeeded) {
      return selected;
    }
  }

  // No dust-safe combination — even all UTXOs together cannot fund a tx that
  // leaves a spendable change output. Caller queues the batch for retry.
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
export const DUST_THRESHOLD = 546;

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

/**
 * #1417-HIGH (fix c): does this getRawTransaction failure prove the tx is
 * ABSENT (vs. just unreadable)?  A definitive "not found" verdict is:
 *   - RPC: JSON-RPC code -5 (RPC_INVALID_ADDRESS_OR_KEY — "No such mempool or
 *     blockchain transaction"), regardless of the HTTP status it wrapped.
 *   - REST (mempool.space): HTTP 404 on GET /tx/:txid.
 * EVERYTHING else — 401/402/5xx/timeout/network/unknown — is a lookup FAILURE
 * and must NOT be read as absence (it would trigger a rebroadcast → 4xx →
 * unwind → double-broadcast). Fail-safe: unknown ⇒ not-absent ⇒ caller throws.
 */
function isDefinitivelyAbsent(error: unknown): boolean {
  if (error instanceof RpcApplicationError) {
    // -5 = RPC_INVALID_ADDRESS_OR_KEY ("No such … transaction"). Any other
    // application code (e.g. -8 bad param) is NOT a proof of absence.
    return error.code === -5;
  }
  if (error instanceof HttpError) {
    return error.status === 404;
  }
  return false;
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

  /**
   * S3-P0: build + SIGN a fingerprint-anchoring OP_RETURN transaction WITHOUT
   * broadcasting it. Runs the exact pre-broadcast pipeline submitFingerprint
   * always ran (metadata hash → fee estimate + PERF-7 ceiling → UTXO fetch →
   * single/multi selection → PSBT build + sign), stopping before the network.
   * The caller persists {txId, txHex} as the durable broadcast intent, then
   * calls broadcastSignedTx — crash between the two re-sends the SAME bytes
   * (same txid), never a second, different transaction.
   */
  async prepareFingerprintTx(
    data: SubmitFingerprintRequest,
  ): Promise<PreparedChainTx> {
    logger.info(
      { fingerprint: data.fingerprint, hasMetadata: !!data.metadata },
      'Preparing fingerprint anchor transaction (build + sign, no broadcast)',
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

    // The exact committed payload: "ARKV"(4) + fingerprint(32) [+ metadata].
    // NO version byte — parser-compatible with extractAnchorFingerprint.
    const opReturnData = Buffer.concat([
      OP_RETURN_PREFIX,
      Buffer.from(data.fingerprint, 'hex'),
      ...(metadataHashBytes ? [metadataHashBytes] : []),
    ]).toString('hex');

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
      // INEFF-4: Fall back to multi-input selection.
      // BUG-2026-06-24-005: pass payloadSize so the selector's fee threshold
      // matches the real multi-input build (OP_RETURN + change + overhead) and
      // reserves dust — preventing a selector "success" that throws at build.
      const multiSelected = selectMultipleUtxos(utxos, estimatedFee, feeRate, payloadSize);
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
        'Multi-input transaction built and signed (not yet broadcast)',
      );

      return {
        txHex: multiTxHex,
        txId: multiTxId,
        feeSats: multiFee,
        opReturnData,
        metadataHash: fullMetadataHash,
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
      'Transaction built and signed (not yet broadcast)',
    );

    return { txHex, txId, feeSats: fee, opReturnData, metadataHash: fullMetadataHash };
  }

  /**
   * S3-P0: broadcast previously-signed transaction bytes. Provider-layer
   * "already-known == success" semantics (S3-C2 regression-pinned per
   * provider) make re-broadcasting the same bytes idempotent — the
   * crash-resume reconcile depends on exactly that.
   */
  async broadcastSignedTx(txHex: string): Promise<ChainReceipt> {
    const computedTxId = bitcoin.Transaction.fromHex(txHex).getId();

    const { txid: broadcastTxid } = await this.provider.broadcastTx(txHex);

    // Sanity check: broadcast returned txid should match our computed txId
    if (broadcastTxid && broadcastTxid !== computedTxId) {
      logger.warn(
        { computed: computedTxId, broadcast: broadcastTxid },
        'Broadcast txid differs from computed txid — using broadcast value',
      );
    }

    const finalTxId = broadcastTxid || computedTxId;

    logger.info({ txId: finalTxId }, 'Signed transaction broadcast');

    // #1417-HIGH (fix b): broadcastSignedTx MUST be infallible AFTER
    // broadcastTx succeeds. The block-height read below is best-effort
    // broadcast-time observability only — the tx is ALREADY on the wire. If the
    // provider 402/401/5xx's on this follow-up call, throwing would make the
    // caller misread a LIVE broadcast as unknown/failed and (worse) unwind the
    // intent, then re-broadcast a SECOND, DIFFERENT tx. Degrade to height 0;
    // the real height is recovered at confirmation time.
    let blockHeight = 0;
    try {
      const blockchainInfo = await this.provider.getBlockchainInfo();
      blockHeight = blockchainInfo.blocks;
    } catch (error) {
      logger.warn(
        { txId: finalTxId, error: error instanceof Error ? error.message : String(error) },
        'Post-broadcast height read failed — broadcast already committed, returning receipt with height 0',
      );
    }

    return {
      receiptId: finalTxId,
      blockHeight,
      blockTimestamp: new Date().toISOString(),
      confirmations: 0, // Just broadcast, not yet confirmed
      rawTxHex: txHex, // NET-4: Store for rebroadcast, RBF, and audit
    };
  }

  async submitFingerprint(
    data: SubmitFingerprintRequest,
  ): Promise<ChainReceipt> {
    logger.info(
      { fingerprint: data.fingerprint, hasMetadata: !!data.metadata },
      'Submitting fingerprint to chain',
    );

    // S3-P0: submitFingerprint is now EXACTLY prepare → broadcast composed —
    // identical bytes, identical selection, identical fee path. Callers that
    // need the persisted-intent guarantee call the two halves themselves.
    const prepared = await this.prepareFingerprintTx(data);

    // SCRUM-2692: the txid is immutable now, but no network call has happened.
    // A journal write failure must reject here so both the single-input and
    // multi-input signing branches prove zero broadcast on persistence error.
    if (data.preBroadcastHook) {
      await data.preBroadcastHook(prepared);
    }

    logger.info(
      { txId: prepared.txId, fee: prepared.feeSats },
      'Transaction built, broadcasting',
    );

    const receipt = await this.broadcastSignedTx(prepared.txHex);

    logger.info(
      { txId: receipt.receiptId, fingerprint: data.fingerprint, fee: prepared.feeSats, metadataHash: prepared.metadataHash },
      'Fingerprint anchored on chain',
    );

    return {
      ...receipt,
      metadataHash: prepared.metadataHash,
      feeSats: prepared.feeSats, // Cost tracking per anchor
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

    // ── Step 2: Fall back to a chain scan ──
    //
    // BUG-2026-06-24-004: two fixes vs the legacy implementation —
    //   (1) Match each OP_RETURN STRUCTURALLY (decompile + canonical-offset
    //       prefix/fingerprint check) instead of a loose `.includes()` substring
    //       scan of the raw scriptPubKey hex.
    //   (2) Scan the address TRANSACTION HISTORY (when the provider supports it)
    //       rather than only `listUnspent` — an anchor's value-0 OP_RETURN output
    //       and its change are spent by the next anchor, so historical anchors
    //       never appear in the UTXO set and the unspent-only scan was a dead path.
    try {
      // Build a verification result from a tx whose OP_RETURN commits this
      // fingerprint, or null if none of its outputs match.
      const matchInTx = async (
        rawTx: RawTransaction,
      ): Promise<VerificationResult | null> => {
        for (const output of rawTx.vout) {
          if (!scriptCommitsFingerprint(output.scriptPubKey.hex, fingerprint)) {
            continue;
          }
          let blockHeight = 0;
          if (rawTx.blockhash) {
            const header = await this.provider.getBlockHeader(rawTx.blockhash);
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
        return null;
      };

      // Preferred path: full address transaction history (finds spent anchors).
      // BUG-2026-06-24-004 (review): if the history API is unavailable OR fails
      // transiently (timeout / 429 / 5xx), do NOT surface a hard verification
      // error — fall through to the legacy UTXO scan, which still verifies any
      // anchor that remains unspent. History failure must not make verification
      // strictly worse than the pre-fix unspent-only path.
      let historyCompleted = false;
      if (typeof this.provider.getAddressTxs === 'function') {
        try {
          const history = await this.provider.getAddressTxs(this.address);
          historyCompleted = true;
          for (const rawTx of history) {
            const match = await matchInTx(rawTx);
            if (match) return match;
          }
        } catch (historyError) {
          const message =
            historyError instanceof Error
              ? historyError.message
              : String(historyError);
          logger.warn(
            { fingerprint, error: message },
            'Address-history lookup failed; falling back to UTXO scan',
          );
        }
      }
      if (!historyCompleted) {
        // Backward-compat / resilience path: providers without an address index
        // (e.g. a bare Bitcoin Core RPC node) OR a transient history-API failure
        // still verify anchors that remain unspent.
        const utxos = await this.provider.listUnspent(this.address);
        for (const utxo of utxos) {
          try {
            const rawTx = await this.provider.getRawTransaction(utxo.txid);
            const match = await matchInTx(rawTx);
            if (match) return match;
          } catch {
            // Skip UTXOs whose parent tx can't be fetched
            continue;
          }
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

  /**
   * #1417-HIGH (fix c): TRI-STATE receipt lookup.
   *   found                → ChainReceipt
   *   definitively-absent  → null  (RPC code -5 "No such … transaction", or
   *                          mempool REST HTTP 404)
   *   lookup-failed         → THROW (provider outage: 401/402/5xx/timeout)
   *
   * The reconcile crash-resume reads null as "tx unknown → rebroadcast the same
   * bytes"; if a provider OUTAGE collapsed to null (the old bare `catch → null`),
   * a live tx got rebroadcast, the follow-up 4xx'd, and the intent unwound into
   * a second, different mainnet tx. A lookup failure must therefore propagate so
   * the caller DEFERS — never guess "absent" from an error we couldn't read.
   */
  async getReceipt(receiptId: string): Promise<ChainReceipt | null> {
    logger.info({ receiptId }, 'Getting receipt from chain');

    let rawTx: RawTransaction;
    try {
      rawTx = await this.provider.getRawTransaction(receiptId);
    } catch (error) {
      if (isDefinitivelyAbsent(error)) {
        logger.warn({ receiptId }, 'Receipt definitively absent on chain (not-found verdict)');
        return null;
      }
      // Lookup failed (outage/auth/quota/transient) — DO NOT masquerade as
      // absent. Propagate so the reconcile path defers instead of rebroadcasting.
      logger.warn(
        { receiptId, error: error instanceof Error ? error.message : String(error) },
        'Receipt lookup failed (provider unavailable) — deferring, not asserting absence',
      );
      throw error;
    }

    // The header read is enrichment only; a failure here must NOT flip a
    // confirmed tx to "absent". Degrade blockHeight to 0 and return the receipt.
    let blockHeight = 0;
    if (rawTx.blockhash) {
      try {
        const header = await this.provider.getBlockHeader(rawTx.blockhash);
        blockHeight = header.height;
      } catch (error) {
        logger.warn(
          { receiptId, error: error instanceof Error ? error.message : String(error) },
          'Receipt found but block-header read failed — returning receipt with height 0',
        );
      }
    }

    return {
      receiptId: rawTx.txid,
      blockHeight,
      blockTimestamp: rawTx.blocktime
        ? new Date(rawTx.blocktime * 1000).toISOString()
        : new Date().toISOString(),
      confirmations: rawTx.confirmations ?? 0,
    };
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

  /**
   * Estimate current fee rate without building a transaction.
   * Used by batch processor to check fees BEFORE claiming anchors (SCALE-1).
   */
  async estimateCurrentFee(): Promise<number> {
    return this.feeEstimator.estimateFee();
  }
}

// ─── Backward-compatible alias ──────────────────────────────────────────

/** @deprecated Use BitcoinChainClient — this alias exists for backward compatibility. */
export const SignetChainClient = BitcoinChainClient;
