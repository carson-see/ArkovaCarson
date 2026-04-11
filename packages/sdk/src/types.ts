/**
 * SDK Types (PH1-SDK-01 + INT-01)
 */

/** Webhook event types (INT-09) */
export type WebhookEventType = 'anchor.secured' | 'anchor.revoked' | 'anchor.expired';

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


/** SDK configuration */
export interface ArkovaConfig {
  /** API key (starts with 'ak_') */
  apiKey?: string;
  /** Base URL for the Arkova API (default: https://arkova-worker-270018525501.us-central1.run.app) */
  baseUrl?: string;
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

/** Result of a verification check */
export interface VerificationResult {
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
