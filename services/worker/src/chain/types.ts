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
}
