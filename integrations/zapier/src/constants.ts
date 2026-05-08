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
  'anchor.secured',
  'anchor.revoked',
  'anchor.expired',
  'credential.issued',
  'credential.verified',
  'credential.status_changed',
] as const;

/** Max batch verify size (sync) */
export const BATCH_SYNC_LIMIT = 20;
