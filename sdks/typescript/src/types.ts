/** Receipt returned after submitting data for anchoring. */
export interface AnchorReceipt {
  public_id: string;
  fingerprint: string;
  status: 'PENDING';
  created_at: string;
  record_uri: string;
}

/** Result of verifying a public_id or fingerprint. */
export interface VerificationResult {
  verified: boolean;
  status?: 'ACTIVE' | 'REVOKED' | 'SUPERSEDED' | 'EXPIRED' | 'PENDING';
  issuer_name?: string;
  credential_type?: string;
  anchor_timestamp?: string;
  bitcoin_block?: number | null;
  network_receipt_id?: string | null;
  record_uri?: string;
  explorer_url?: string;
  description?: string;
  /** API-RICH-01 (v1.5.0): Regulatory control IDs (SOC 2 / FERPA / HIPAA / GDPR / ISO). */
  compliance_controls?: Record<string, unknown> | null;
  /** API-RICH-01: Bitcoin block confirmations at anchor time. */
  chain_confirmations?: number | null;
  /** API-RICH-01: Public ID of the parent anchor (credential lineage). */
  parent_public_id?: string | null;
  /** API-RICH-01: Version in the lineage (>=2 means this is a successor). */
  version_number?: number | null;
  /** API-RICH-01: Revocation TX id when status = REVOKED. */
  revocation_tx_id?: string | null;
  /** API-RICH-01: Revocation block height when status = REVOKED. */
  revocation_block_height?: number | null;
  /** API-RICH-01: Source document MIME type (client-side metadata only). */
  file_mime?: string | null;
  /** API-RICH-01: Source document size in bytes. */
  file_size?: number | null;
  error?: string;
}

/** Configuration for ArkovaClient. */
export interface ArkovaConfig {
  /** Your Arkova API key (starts with 'ak_'). */
  apiKey: string;
  /** API base URL. Defaults to Arkova production. */
  baseUrl?: string;
  /** Request timeout in milliseconds. Defaults to 30000. */
  timeout?: number;
}

/** A VerificationResult with the public_id it was looked up by (batch only). */
export interface BatchVerificationResult extends VerificationResult {
  public_id: string;
}

/** Server-side batch verification job. Created when >20 IDs are submitted. */
export interface BatchJob {
  job_id: string;
  status: 'submitted' | 'processing' | 'complete' | 'failed';
  total: number;
  created_at: string;
  expires_at: string;
  completed_at?: string | null;
  results?: BatchVerificationResult[];
  error_message?: string;
}

/** Options for ArkovaClient.waitForBatchJob. */
export interface WaitForBatchJobOptions {
  /** Max ms to wait before throwing. Defaults to 300000 (5 min). */
  timeoutMs?: number;
  /** Ms between polls. Defaults to 2000. */
  pollIntervalMs?: number;
}
