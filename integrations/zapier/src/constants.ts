/** Arkova API base URL */
export const BASE_URL = 'https://arkova-worker-270018525501.us-central1.run.app';

/** Default webhook events */
export const DEFAULT_EVENTS = ['anchor.secured', 'anchor.revoked'];

/** Valid webhook event types */
export const VALID_EVENTS = ['anchor.secured', 'anchor.revoked', 'anchor.expired'] as const;

/** Max batch verify size (sync) */
export const BATCH_SYNC_LIMIT = 20;
