/**
 * Public types for the Arkova embed bundle.
 */

/** Render mode for the badge */
export type EmbedMode = 'compact' | 'full';

/** Configuration for a single widget instance */
export interface ArkovaEmbedConfig {
  /** Public ID of the anchor (e.g. "ARK-2026-001") */
  publicId: string;
  /** Render mode — defaults to "full" */
  mode?: EmbedMode;
  /** DOM container to render into. If omitted, the widget mounts as a sibling of its <script> tag. */
  target?: HTMLElement;
  /** Override the verification API base URL (default: production worker) */
  apiBaseUrl?: string;
  /** Override the public verification page base URL used for "Full details" link */
  appBaseUrl?: string;
  /** Disable analytics logging (method=embed) */
  disableAnalytics?: boolean;
}

/** Anchor data shape returned by GET /api/v1/verify/{publicId} */
export interface AnchorData {
  verified: boolean;
  status: string;
  issuer_name?: string | null;
  credential_type?: string | null;
  anchor_timestamp?: string | null;
  network_receipt_id?: string | null;
  record_uri?: string | null;
  filename?: string | null;
  fingerprint?: string | null;
  public_id?: string | null;
  chain_tx_id?: string | null;
  error?: string | null;
}
