/**
 * SDK Types (PH1-SDK-01 + INT-01)
 */

/**
 * Webhook event types. Credential.* contract is defined but per-event emit
 * points wire in Phase-2 follow-ups (SCRUM-1743).
 */
export type WebhookEventType =
  | 'anchor.submitted'
  | 'anchor.secured'
  | 'anchor.revoked'
  | 'anchor.expired'
  | 'anchor.batch_secured'
  | 'credential.issued'
  | 'credential.verified'
  | 'credential.status_changed';

/** Webhook endpoint metadata (INT-09) */
export interface WebhookEndpoint {
  id: string;
  url: string;
  events: WebhookEventType[];
  isActive: boolean;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Webhook endpoint with signing secret — returned ONLY at creation time (INT-09) */
export interface WebhookEndpointWithSecret extends WebhookEndpoint {
  /** 64-char hex HMAC-SHA256 signing secret. Save it now — shown ONCE. */
  secret: string;
  warning: string;
}

/** Input for creating a webhook endpoint */
export interface CreateWebhookInput {
  /** HTTPS URL to receive events. Must be publicly resolvable. */
  url: string;
  /** Events to subscribe to. Default: ['anchor.secured', 'anchor.revoked'] */
  events?: WebhookEventType[];
  /** Free-text label, max 500 chars */
  description?: string;
  /** If true, Arkova sends a verification ping; the endpoint must echo a challenge */
  verify?: boolean;
}

/** Input for updating a webhook endpoint */
export interface UpdateWebhookInput {
  url?: string;
  events?: WebhookEventType[];
  description?: string | null;
  isActive?: boolean;
}

/** Pagination metadata for list operations */
export interface PaginatedWebhooks {
  webhooks: WebhookEndpoint[];
  total: number;
  limit: number;
  offset: number;
}

/** Retry configuration for transient API failures and rate limits */
export interface RetryConfig {
  /** Number of retry attempts after the initial request. Default: 2 */
  retries?: number;
  /** Initial exponential backoff delay in milliseconds. Default: 250 */
  baseDelayMs?: number;
  /** Maximum retry delay in milliseconds. Default: 5000 */
  maxDelayMs?: number;
  /** Override sleep for tests or custom runtimes */
  sleep?: (ms: number) => Promise<void>;
}

/** SDK configuration */
export interface ArkovaConfig {
  /** API key (starts with 'ak_') */
  apiKey?: string;
  /** Base URL for the Arkova API (default: https://arkova-worker-270018525501.us-central1.run.app) */
  baseUrl?: string;
  /** Built-in retry handling for 429/5xx responses. Set retries=0 to disable. */
  retry?: RetryConfig;
  /** Enable x402 auto-payment (requires USDC wallet) */
  x402?: {
    /** x402 facilitator URL */
    facilitatorUrl?: string;
    /** Payer wallet address (USDC on Base) */
    payerAddress: string;
    /** Function to sign x402 payment */
    signPayment: (amount: string, payTo: string) => Promise<string>;
  };
}

/** RFC 7807 problem+json payload returned by API v2 errors */
export interface ProblemDetail {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
}

/** Receipt returned after anchoring */
export interface AnchorReceipt {
  /** Public identifier for the anchor (e.g., ARK-2026-001) */
  publicId: string;
  /** SHA-256 fingerprint of the anchored data */
  fingerprint: string;
  /** Current status */
  status: 'PENDING' | 'SUBMITTED' | 'SECURED';
  /** Anchor creation timestamp (ISO 8601) */
  createdAt: string;
  /** Network receipt ID (set after anchoring) */
  networkReceiptId?: string;
}

/** Additive rich metadata returned by verification and anchor-detail endpoints */
export interface RichVerificationFields {
  /** Immutable credential description when present */
  description?: string | null;
  /**
   * Regulatory control IDs mapped to this anchor.
   *
   * SCRUM-2227: the API emits this as an ARRAY of control-ID strings. The SDK
   * previously declared it object-only and mapped it through a helper that
   * returns `null` for arrays, so this field was silently `null` for every real
   * anchor. The object arm is retained because the type advertised it.
   */
  complianceControls?: string[] | Record<string, unknown> | null;
  /**
   * SCRUM-2227: the informational-not-attestation note that accompanies
   * `complianceControls`. Present whenever controls are present, `null`
   * otherwise. Control IDs are a credential-type mapping — NOT an audit,
   * certification, conformity assessment, or attestation.
   */
  complianceControlsNote?: string | null;
  /** Bitcoin block confirmations at anchor time */
  chainConfirmations?: number | null;
  /** Public ID of the parent anchor in a credential lineage */
  parentPublicId?: string | null;
  /** Version in the credential lineage */
  versionNumber?: number | null;
  /** Bitcoin transaction ID of the revocation */
  revocationTxId?: string | null;
  /** Bitcoin block height at which revocation was anchored */
  revocationBlockHeight?: number | null;
  /** Source document MIME type */
  fileMime?: string | null;
  /** Source document size in bytes */
  fileSize?: number | null;
  /** Per-field AI confidence scores from the latest extraction manifest */
  confidenceScores?: Record<string, unknown> | null;
  /** Fine-grained credential subtype */
  subType?: string | null;
}

/** Result of a verification check */
export interface VerificationResult extends RichVerificationFields {
  /** Whether the data matches the anchor */
  verified: boolean;
  /** Current anchor status */
  status: 'ACTIVE' | 'REVOKED' | 'EXPIRED' | 'SUPERSEDED' | 'UNKNOWN';
  /** Issuer name */
  issuerName: string;
  /** Credential type */
  credentialType: string;
  /** Issued date */
  issuedDate: string | null;
  /** Expiry date */
  expiryDate: string | null;
  /** Anchor timestamp */
  anchorTimestamp: string;
  /** Network receipt ID */
  networkReceiptId: string | null;
  /** Verification URL */
  recordUri: string;
}

/** Nessie RAG retrieval result */
export interface NessieQueryResult {
  results: Array<{
    recordId: string;
    source: string;
    sourceUrl: string;
    recordType: string;
    title: string | null;
    relevanceScore: number;
    anchorProof: {
      chainTxId: string | null;
      contentHash: string;
    } | null;
  }>;
  count: number;
  query: string;
}

/** Nessie verified context result */
export interface NessieContextResult {
  answer: string;
  citations: Array<{
    recordId: string;
    source: string;
    sourceUrl: string;
    title: string | null;
    relevanceScore: number;
    excerpt: string;
    anchorProof: {
      chainTxId: string | null;
      contentHash: string;
    } | null;
  }>;
  confidence: number;
  model: string;
  query: string;
}

export type SearchType = 'all' | 'org' | 'record' | 'fingerprint' | 'document';

export interface SearchOptions {
  type?: SearchType;
  limit?: number;
  cursor?: string;
}

export interface SearchResult {
  type: Exclude<SearchType, 'all'>;
  /** Stable public identifier returned by API v2 search. */
  publicId: string;
  score: number;
  snippet: string;
  metadata?: Record<string, unknown>;
}

export interface SearchResponse {
  results: SearchResult[];
  nextCursor: string | null;
}

export interface FingerprintVerification extends RichVerificationFields {
  verified: boolean;
  status: string;
  fingerprint: string;
  publicId: string | null;
  title: string | null;
  anchorTimestamp: string | null;
  networkReceiptId: string | null;
  recordUri: string | null;
}

export interface AnchorDetails extends RichVerificationFields {
  publicId: string;
  verified: boolean;
  status: string;
  issuerName: string;
  credentialType: string;
  issuedDate: string | null;
  expiryDate: string | null;
  anchorTimestamp: string | null;
  networkReceiptId: string | null;
  recordUri: string;
  jurisdiction?: string | null;
}

/** A single Merkle proof sibling (hash + side). */
export interface MerkleProofEntry {
  hash: string;
  position: 'left' | 'right';
}

/**
 * PROOF-05 (SCRUM-2338): inline Ed25519 signature envelope metadata on a
 * {@link ProofBundle}. Present only when the proof was fetched signed; `null`
 * on the default unsigned response.
 */
export interface ProofBundleSignature {
  alg: string;
  signingKeyId: string;
}

/**
 * PROOF-05 (SCRUM-2338): self-contained, independently-checkable two-layer
 * proof bundle. Carries only cryptographic evidence — never raw document
 * content or PII. `null` on the parent response when the proof is incomplete
 * (the API only emits it when ALL fields below are present + well-formed:
 * receipt txid/height/timestamp, 160-hex header, 64-hex block hash, canonical
 * ARKV OP_RETURN, merkleIndex AND leafCount).
 *
 * Field names are camelCase per SDK convention; the wire form is snake_case.
 */
export interface ProofBundle {
  fingerprint: string;
  merkleRoot: string;
  /**
   * The inclusion branch. A complete (non-null) bundle always ships a non-empty
   * branch — `mapProofBundle` fails closed (returns null) on an empty/malformed
   * array, so consumers can rely on `proofBundle !== null ⇒ independently
   * verifiable` (CodeRabbit).
   */
  merkleProof: [MerkleProofEntry, ...MerkleProofEntry[]];
  /**
   * The leaf's index in the batch tree. Non-null in a complete bundle — together
   * with `leafCount` it arms the CVE-2012-2459 duplicate-leaf structural guard.
   */
  merkleIndex: number;
  /**
   * Total leaves in the batch tree this proof belongs to. With `merkleIndex`
   * this arms the CVE-2012-2459 duplicate-leaf structural guard during local
   * verification — both are always present in a complete (non-null) bundle.
   */
  leafCount: number;
  txId: string;
  blockHeight: number;
  blockHash: string;
  /** Raw 80-byte block header as plain 160-hex. */
  blockHeader: string;
  /**
   * Raw OP_RETURN payload as plain hex: "ARKV" (41524b56) + the 32-byte
   * app-tree root (64 hex), NO version byte, optional trailing metadata hash.
   */
  opReturnPayload: string;
  blockTimestamp: string;
  proofSchemaVersion: number;
  /**
   * RESERVED — always `null` today. The signed envelope is the outer
   * `?format=signed` response wrapper, not an inline bundle field. This is the
   * one legitimately-nullable member of the bundle.
   */
  signature: ProofBundleSignature | null;
}

/**
 * PROOF-05 (SCRUM-2338): response of `GET /api/v1/verify/{publicId}/proof`.
 * The legacy top-level fields are unchanged (frozen schema, Constitution 1.8);
 * `proofBundle` is the additive, nullable self-contained bundle.
 */
export interface MerkleProofResponse {
  publicId: string;
  fingerprint: string;
  merkleRoot: string;
  merkleProof: MerkleProofEntry[];
  txId: string | null;
  blockHeight: number | null;
  blockTimestamp: string | null;
  batchId: string | null;
  verified: boolean;
  proofBundle: ProofBundle | null;
}

export interface AttestationEvidence {
  publicId: string;
  evidenceType: string;
  description: string | null;
  fingerprint: string;
  mime: string | null;
  size: number | null;
  createdAt: string;
}

export interface AttestorCredential {
  publicId: string;
  credentialType: string | null;
  status: string;
  fingerprint: string | null;
  versionNumber: number | null;
  parentPublicId: string | null;
  isCurrent: boolean;
  chainProof: {
    txId: string;
    blockHeight: number | null;
    timestamp: string | null;
    explorerUrl: string | null;
  } | null;
  recordUri: string;
}

export interface AttestationDetails {
  publicId: string;
  attestationType: string;
  status: string;
  subjectType: string;
  subjectIdentifier: string;
  attester: {
    name: string;
    type: string;
    title: string | null;
  };
  claims: Array<{ claim: string; evidence?: string }>;
  summary: string | null;
  jurisdiction?: string | null;
  fingerprint: string | null;
  evidenceFingerprint: string | null;
  evidence: AttestationEvidence[];
  evidenceCount: number;
  linkedCredential: {
    publicId: string;
    credentialType: string | null;
    verificationStatus: string;
    verifyUrl: string;
  } | null;
  attestorCredentials?: AttestorCredential[];
  issuedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revocationReason: string | null;
  createdAt: string;
  verifyUrl: string;
}

export interface OrganizationSummary {
  publicId: string;
  displayName: string;
  domain: string | null;
  websiteUrl: string | null;
  verificationStatus: string | null;
}

/** SCRUM-1132 / SCRUM-1584 — public-safe v2 detail envelopes returned by the
 *  agent-friendly `/api/v2/{organizations|records|fingerprints|documents}/{id}`
 *  routes. Mirrors the worker's `mapAnchorDetail` shape; never carries the
 *  internal `id`, `org_id`, `user_id`, or `record_id` columns. */

/**
 * Public-safe org detail. Kept separate from OrganizationSummary so each
 * response can evolve independently while preserving the no-internal-id
 * public API contract.
 */
export interface OrganizationDetails {
  publicId: string;
  displayName: string;
  domain: string | null;
  websiteUrl: string | null;
  verificationStatus: string | null;
  description: string | null;
  industryTag: string | null;
  orgType: string | null;
  location: string | null;
  logoUrl: string | null;
}

export interface RecordDetails {
  publicId: string | null;
  verified: boolean;
  status: string;
  fingerprint: string | null;
  title: string | null;
  description: string | null;
  issuerName: string | null;
  credentialType: string | null;
  subType: string | null;
  issuedDate: string | null;
  expiryDate: string | null;
  anchorTimestamp: string | null;
  networkReceiptId: string | null;
  recordUri: string | null;
}

export interface FingerprintDetails extends Omit<RecordDetails, 'fingerprint'> {
  fingerprint: string;
}

export type DocumentDetails = RecordDetails;

/**
 * Bulk anchor credential types — mirrors the worker's
 * `services/worker/src/api/v1/anchor-bulk.ts` `CREDENTIAL_TYPES` enum.
 * Keep in sync; the server is authoritative and rejects unknown values.
 */
export const BULK_ANCHOR_CREDENTIAL_TYPES = [
  'DEGREE', 'LICENSE', 'CERTIFICATE', 'TRANSCRIPT', 'PROFESSIONAL', 'CPE', 'CLE',
  'BADGE', 'ATTESTATION', 'FINANCIAL', 'LEGAL', 'INSURANCE', 'SEC_FILING', 'PATENT',
  'REGULATION', 'PUBLICATION', 'CHARITY', 'ACCREDITATION', 'FINANCIAL_ADVISOR',
  'BUSINESS_ENTITY', 'RESUME', 'MEDICAL', 'MILITARY', 'IDENTITY',
  'CONTRACT_PRESIGNING', 'CONTRACT_POSTSIGNING', 'OTHER',
] as const;

export type BulkAnchorCredentialType = typeof BULK_ANCHOR_CREDENTIAL_TYPES[number];

/** How the server should handle a fingerprint that already exists (in-batch or in-org). */
export type BulkAnchorDuplicateStrategy = 'skip' | 'supersede' | 'link' | 'fail';

/**
 * A single row for `arkova.anchorBulk()`. Provide exactly one of `fingerprint`
 * (a pre-computed 64-char hex SHA-256) or `data` (raw content — the SDK
 * fingerprints it client-side via the same `fingerprint()` helper `anchor()`
 * uses, so the document never leaves the caller's process for this step).
 */
export interface BulkAnchorInput {
  /** Pre-computed SHA-256 fingerprint (64-char hex). Mutually exclusive with `data`. */
  fingerprint?: string;
  /** Raw data to fingerprint client-side before submission. Mutually exclusive with `fingerprint`. */
  data?: string | ArrayBuffer;
  credentialType?: BulkAnchorCredentialType;
  /** Free-form note, max 1000 chars. */
  description?: string;
  /** Real-world date the document was created/executed (ISO 8601). Distinct from the anchor timestamp. */
  originalDocumentDate?: string;
  /** Free-form classifier — "contract", "1099", "engagement_letter", etc. */
  documentType?: string;
  /** External tenant reference (case number, matter, etc.). */
  matterOrCaseRef?: string;
  /** Customer-system primary key for round-tripping. */
  externalId?: string;
}

/** Options for `arkova.anchorBulk()`. */
export interface AnchorBulkOptions {
  /** Validate every row but don't queue or deduct credits. */
  dryRun?: boolean;
  /** Strategy when a fingerprint already exists in the org or elsewhere in the batch. Server default: 'fail'. */
  duplicateStrategy?: BulkAnchorDuplicateStrategy;
  /** Client-supplied batch ID, surfaced in audit events and duplicate rows. */
  batchId?: string;
}

export interface BulkAnchorDuplicate {
  /** Index into the input array this duplicate corresponds to. */
  row: number;
  fingerprint: string;
  /** Whether the duplicate was found earlier in the same batch or already in the org's records. */
  scope: 'in_batch' | 'in_db';
  decision: BulkAnchorDuplicateStrategy;
}

export interface BulkAnchorRowError {
  /** Index into the input array this error corresponds to. */
  row: number;
  field?: string;
  code: string;
  message: string;
}

export interface BulkAnchorResultRow {
  publicId: string;
  fingerprint: string;
  status: 'PENDING';
  originalDocumentDate: string | null;
  documentType: string | null;
  matterOrCaseRef: string | null;
  externalId: string | null;
  anchoredAt: string;
}

/** Response from `arkova.anchorBulk()`. */
export interface BulkAnchorResponse {
  batchId: string | null;
  /** Total rows accepted by schema validation (before dedup/insert). */
  validated: number;
  /** Rows actually queued for anchoring (0 when `dryRun` is true). */
  queued: number;
  duplicates: BulkAnchorDuplicate[];
  errors: BulkAnchorRowError[];
  dryRun: boolean;
  /** Present when `dryRun` is false — the rows that were actually inserted. */
  anchors?: BulkAnchorResultRow[];
}
