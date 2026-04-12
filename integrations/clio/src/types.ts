/**
 * Clio Integration Types (INT-06)
 */

/** Configuration for the Clio–Arkova connector */
export interface ClioConfig {
  /** Clio OAuth2 client ID */
  clioClientId: string;
  /** Clio OAuth2 client secret */
  clioClientSecret: string;
  /** Clio OAuth2 redirect URI */
  clioRedirectUri: string;
  /** Arkova API key */
  arkovaApiKey: string;
  /** Arkova API base URL */
  arkovaBaseUrl?: string;
  /** Clio API base URL (v4) */
  clioBaseUrl?: string;
  /** Auto-anchor new documents on upload */
  autoAnchor?: boolean;
}

/** Clio document representation */
export interface ClioDocument {
  id: number;
  name: string;
  content_type: string;
  created_at: string;
  updated_at: string;
  /** Size in bytes */
  size: number;
  /** Parent folder ID */
  parent_id?: number;
  /** Contact association */
  contact?: { id: number; name: string } | null;
  /** Matter association */
  matter?: { id: number; display_number: string; description: string } | null;
}

/** Clio contact representation */
export interface ClioContact {
  id: number;
  name: string;
  type: 'Person' | 'Company';
  email_addresses?: Array<{ address: string; name: string }>;
  /** Custom fields for bar numbers, jurisdictions */
  custom_fields?: Array<{ id: number; name: string; value: string }>;
}

/** CLE compliance status for an attorney */
export interface CleStatus {
  attorney_name: string;
  bar_number: string;
  jurisdiction: string;
  status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED' | 'UNKNOWN';
  cle_hours_required: number;
  cle_hours_completed: number;
  cle_hours_remaining: number;
  next_deadline: string | null;
  ethics_hours_required: number;
  ethics_hours_completed: number;
  arkova_verification?: {
    public_id: string;
    verified: boolean;
    anchor_timestamp: string;
    record_uri: string;
  };
}

/** Clio OAuth2 token response */
export interface ClioTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  created_at: number;
}

/** Arkova anchor result for Clio document */
export interface ClioAnchorResult {
  clio_document_id: number;
  arkova_public_id: string;
  fingerprint: string;
  status: string;
  record_uri: string;
}

/** Clio webhook event payload */
export interface ClioWebhookEvent {
  type: 'document.created' | 'document.updated' | 'document.deleted';
  data: {
    id: number;
    type: string;
    url: string;
  };
  created_at: string;
}
