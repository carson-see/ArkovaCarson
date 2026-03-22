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
