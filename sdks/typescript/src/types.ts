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
