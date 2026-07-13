/**
 * Chain API Types
 *
 * Types for interacting with the blockchain anchoring service.
 */

export interface SubmitFingerprintRequest {
  fingerprint: string;
  timestamp: string;
  metadata?: Record<string, string>;
}

export interface ChainReceipt {
  /** Network receipt ID (formerly transaction ID) */
  receiptId: string;
  /** Block reference number */
  blockHeight: number;
  /** Block timestamp in ISO format */
  blockTimestamp: string;
  /** Number of confirmations */
  confirmations: number;
  /** Full SHA-256 hash of canonical metadata JSON (64-char hex), if metadata was anchored */
  metadataHash?: string;
  /** NET-4: Raw transaction hex for rebroadcast, RBF, and independent audit */
  rawTxHex?: string;
  /** Fee paid in satoshis (for Bitcoin cost tracking) */
  feeSats?: number;
  /** Fee paid in wei (for EVM chain cost tracking) — mutually exclusive with feeSats */
  feeWei?: string;
}

export interface VerificationResult {
  verified: boolean;
  receipt?: ChainReceipt;
  error?: string;
}

/**
 * S3-P0: a fully-built, SIGNED transaction that has NOT been broadcast.
 * Produced by `prepareFingerprintTx` so the batch producer can durably
 * persist the broadcast intent (txid + signed bytes) BEFORE any bytes hit
 * the network — the foundation of the no-double-broadcast crash-resume
 * guarantee. Contains no key material (a signed tx is public data the
 * moment it is broadcast).
 */
export interface PreparedChainTx {
  /** Fully-signed raw transaction hex — rebroadcastable as-is. */
  txHex: string;
  /** txid of the signed bytes (deterministic rebroadcast key). */
  txId: string;
  /** Fee committed by the signed tx, in satoshis. */
  feeSats: number;
  /**
   * The raw OP_RETURN data payload committed by the tx, as plain hex:
   * "ARKV"(4B) + fingerprint/root(32B) [+ truncated metadata hash].
   * Persisted verbatim to `anchor_proofs.op_return_payload`.
   */
  opReturnData: string;
  /** Full SHA-256 of canonical metadata JSON when metadata was included. */
  metadataHash?: string;
}

// ─── Chain Index Lookup (P7-TS-13) ──────────────────────────────────────

/**
 * Entry returned from the chain index for a fingerprint.
 */
export interface IndexEntry {
  chainTxId: string;
  blockHeight: number | null;
  blockTimestamp: string | null;
  confirmations: number | null;
  anchorId: string | null;
}

/**
 * Abstraction for O(1) fingerprint verification via a DB index.
 *
 * BitcoinChainClient uses this (when configured) to skip the O(n) UTXO scan.
 * The default implementation queries the `anchor_chain_index` table.
 */
export interface ChainIndexLookup {
  /** Look up a fingerprint in the index. Returns null if not found. */
  lookupFingerprint(fingerprint: string): Promise<IndexEntry | null>;
}

export interface ChainClient {
  /**
   * Submit a fingerprint to be anchored on-chain
   */
  submitFingerprint(data: SubmitFingerprintRequest): Promise<ChainReceipt>;

  /**
   * Verify a fingerprint exists on-chain
   */
  verifyFingerprint(fingerprint: string): Promise<VerificationResult>;

  /**
   * Get receipt details by ID
   */
  getReceipt(receiptId: string): Promise<ChainReceipt | null>;

  /**
   * Check service health
   */
  healthCheck(): Promise<boolean>;

  /**
   * Pre-flight check: does the treasury have any UTXOs to fund a transaction?
   * Returns false if treasury is empty — callers should skip batch processing.
   * Optional: MockChainClient always returns true.
   */
  hasFunds?(): Promise<boolean>;

  /**
   * Estimate current fee rate (sat/vB) without building a transaction.
   * Used by batch processor to check fees BEFORE claiming anchors.
   * Optional: implementations that don't support fee estimation return undefined.
   */
  estimateCurrentFee?(): Promise<number>;

  /**
   * S3-P0: build + SIGN a fingerprint-anchoring transaction WITHOUT
   * broadcasting it. The batch producer persists the returned txid + signed
   * hex as the pre-broadcast intent, then calls `broadcastSignedTx`.
   * Optional: clients without it fall back to the legacy single-call
   * `submitFingerprint` path (no intent persistence).
   */
  prepareFingerprintTx?(data: SubmitFingerprintRequest): Promise<PreparedChainTx>;

  /**
   * S3-P0: broadcast previously-signed transaction bytes. Re-broadcasting the
   * same bytes MUST be idempotent success (already-known == success at the
   * provider layer) — the crash-resume reconcile depends on it.
   */
  broadcastSignedTx?(txHex: string): Promise<ChainReceipt>;
}
