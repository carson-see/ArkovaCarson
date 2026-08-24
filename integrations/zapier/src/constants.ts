/** Arkova API base URL */
export const BASE_URL = 'https://arkova-worker-270018525501.us-central1.run.app';

/** Default webhook events — anchor lifecycle only; credential.* requires explicit opt-in (SCRUM-1743). */
export const DEFAULT_EVENTS = ['anchor.secured', 'anchor.revoked'];

/**
 * Valid webhook event types.
 *
 * Mirrors `services/worker/src/api/v1/webhooks-schemas.ts` `VALID_WEBHOOK_EVENTS`.
 * Keep in sync when new event types ship there.
 *
 * SCRUM-1743: credential.* events accepted at the CRUD layer; emit-point
 * wiring lands in Phase-2 follow-ups.
 */
export const VALID_EVENTS = [
  'anchor.submitted',
  'anchor.secured',
  'anchor.revoked',
  'anchor.expired',
  // DI-775: SECURED -> SUPERSEDED. Emitted by POST /api/anchor/:id/supersede
  // (SCRUM-2937); it was subscribable in the worker long before it was listed
  // here. Listing it does NOT by itself give a Zap author a way to pick it —
  // the packaged triggers (triggers/anchorSecured.ts, triggers/anchorRevoked.ts)
  // and the makecom.json modules each subscribe to a hardcoded events array,
  // and nothing in this app reads VALID_EVENTS. This constant is the mirror of
  // the worker allowlist; a per-event trigger is separate follow-up work.
  'anchor.superseded',
  'anchor.batch_secured',
  'credential.issued',
  'credential.verified',
  'credential.status_changed',
  // BUG-002: advance 7-day expiry warning. Emitted by the
  // check-credential-expiry cron behind the ENABLE_EXPIRY_ALERTS flag.
  'compliance.document_expiring',
] as const;

/** Max batch verify size (sync) */
export const BATCH_SYNC_LIMIT = 20;
