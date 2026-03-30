/**
 * GRC Platform Integration Types (CML-05)
 *
 * Shared types for GRC platform adapters (Vanta, Drata, Anecdotes).
 */

export type GrcPlatform = 'vanta' | 'drata' | 'anecdotes';

export type GrcSyncStatus = 'pending' | 'syncing' | 'success' | 'failed';

export interface GrcConnection {
  id: string;
  org_id: string;
  platform: GrcPlatform;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  token_expires_at: string | null;
  external_org_id: string | null;
  external_workspace_id: string | null;
  scopes: string[];
  is_active: boolean;
  last_sync_at: string | null;
  last_sync_status: GrcSyncStatus | null;
  last_sync_error: string | null;
  sync_count: number;
  created_at: string;
  updated_at: string;
  created_by: string;
}

export interface GrcSyncLog {
  id: string;
  connection_id: string;
  anchor_id: string | null;
  status: GrcSyncStatus;
  evidence_type: string;
  external_evidence_id: string | null;
  error_message: string | null;
  request_payload: Record<string, unknown> | null;
  response_payload: Record<string, unknown> | null;
  duration_ms: number | null;
  created_at: string;
}

/** Evidence payload pushed to GRC platforms */
export interface GrcEvidencePayload {
  /** Arkova verification ID (public_id) */
  verification_id: string;
  /** Document display name */
  title: string;
  /** SHA-256 fingerprint */
  fingerprint: string;
  /** Credential type */
  credential_type: string | null;
  /** Verification status */
  status: string;
  /** Bitcoin network receipt (TX ID) */
  network_receipt: string | null;
  /** Block height for chain confirmation */
  block_height: number | null;
  /** Timestamp of chain anchoring */
  chain_timestamp: string | null;
  /** Applicable compliance control IDs */
  compliance_controls: string[];
  /** Compliance frameworks covered */
  frameworks: string[];
  /** Lifecycle timestamps */
  created_at: string;
  secured_at: string | null;
}

/** OAuth2 token response from GRC platform */
export interface GrcOAuthTokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

/** Result of pushing evidence to a GRC platform */
export interface GrcPushResult {
  success: boolean;
  external_evidence_id?: string;
  error?: string;
  response?: Record<string, unknown>;
}

/**
 * GRC Platform Adapter Interface
 *
 * Each GRC platform (Vanta, Drata, Anecdotes) implements this interface.
 * Adapters handle OAuth2 token exchange, evidence push, and connection testing.
 */
export interface IGrcAdapter {
  readonly platform: GrcPlatform;

  /** Exchange OAuth2 authorization code for tokens */
  exchangeAuthCode(code: string, redirectUri: string): Promise<GrcOAuthTokens>;

  /** Refresh an expired access token */
  refreshAccessToken(refreshToken: string): Promise<GrcOAuthTokens>;

  /** Push a single evidence item to the platform */
  pushEvidence(accessToken: string, evidence: GrcEvidencePayload): Promise<GrcPushResult>;

  /** Test connection validity (e.g., fetch org info) */
  testConnection(accessToken: string): Promise<{ valid: boolean; orgName?: string; error?: string }>;

  /** Get the OAuth2 authorization URL for the platform */
  getAuthUrl(redirectUri: string, state: string): string;
}
