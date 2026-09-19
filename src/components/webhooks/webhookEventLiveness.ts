/**
 * Webhook event liveness + payload-field data (WH-01 / SCRUM-2396).
 *
 * Single source of truth for "does the worker actually emit this event?".
 * Both webhook surfaces read it:
 *  - `WebhookEventCatalog.tsx` — the Active / Not-yet-active badge,
 *  - `WebhookSettings.tsx` — the subscription picker's suffix.
 *
 * It lives in its own module deliberately. The catalog imports
 * `AVAILABLE_EVENTS` from `WebhookSettings.tsx` and evaluates it at module
 * scope, so having the picker import liveness back out of the catalog would
 * form an import cycle and leave `AVAILABLE_EVENTS` in its temporal dead zone
 * on one of the two load orders. A third module both can import has no cycle.
 *
 * Honesty rules (§1.13 R-7 launch-claims discipline):
 *  - `live: true` is asserted ONLY for events with a real, reachable
 *    `dispatchWebhookEvent(...)` call site in the worker — verified against
 *    `git grep -n "dispatchWebhookEvent(" services/worker/src`, not against
 *    registration, not against the payload schema existing, and not against
 *    the event family prefix. Registration makes an event *subscribable*;
 *    only a dispatch site makes it *delivered*.
 *  - An `audit_events` row carrying the same `event_type` string is NOT a
 *    dispatch (this is exactly what made `anchor.batch_secured` look live).
 *  - The rule cuts both ways: never claim an event a subscriber won't
 *    receive, and never tell a subscriber an event they ARE receiving is
 *    inactive.
 *  - `fields` lists mirror the worker's strict Zod payload schemas
 *    (services/worker/src/webhooks/payload-schemas.ts). Update BOTH when a
 *    schema changes — the catalog test drift-guards against AVAILABLE_EVENTS,
 *    and payload-schemas.test.ts locks the wire contract.
 */

export interface WebhookCatalogEntry {
  id: string;
  /** True only when the worker has a real emit point for this event. */
  live: boolean;
  /** Wire payload `data` fields, mirroring payload-schemas.ts (strict). */
  fields: string[];
}

// Field lists verified 2026-07-06 against
// services/worker/src/webhooks/payload-schemas.ts (strict Zod schemas).
// `?` marks nullable/optional fields.
export const CATALOG_DATA: Record<string, Omit<WebhookCatalogEntry, 'id'>> = {
  'anchor.submitted': {
    live: true,
    fields: ['public_id', 'status', 'submitted_at', 'chain_tx_id?', 'chain_block_height?', 'org_public_id?'],
  },
  'anchor.secured': {
    live: true,
    fields: ['public_id', 'status', 'chain_tx_id', 'chain_block_height', 'chain_timestamp', 'secured_at', 'org_public_id?'],
  },
  'anchor.revoked': {
    live: true,
    fields: ['public_id', 'status', 'revoked_at', 'revocation_reason?', 'chain_tx_id?', 'chain_block_height?', 'org_public_id?'],
  },
  'anchor.expired': {
    live: true,
    fields: ['public_id', 'status', 'chain_tx_id', 'chain_block_height', 'expires_at', 'expired_at', 'org_public_id?'],
  },
  // DI-775 (SCRUM-3538): `live: true` — the emit point is real:
  // `dispatchWebhookEvent(..., 'anchor.superseded', ...)` in
  // services/worker/src/api/anchor-lineage.ts (SCRUM-2937), on the
  // POST /api/anchor/:id/supersede path. Fields mirror
  // AnchorSupersededPayloadSchema (strict); SUPERSEDED can only follow
  // SECURED, so the chain fields are non-null there and are listed unmarked.
  'anchor.superseded': {
    live: true,
    fields: ['public_id', 'status', 'chain_tx_id', 'chain_block_height', 'superseded_at', 'superseded_by_public_id?', 'supersession_reason?', 'org_public_id?'],
  },
  // CTO ruling Z5 (2026-09-12): `live: false` — corrected, not downgraded.
  // The event has been registered and subscribable since SCRUM-1794 and its
  // payload contract is locked, but NO producer dispatches it:
  // `git grep -n "dispatchWebhookEvent(" services/worker/src` returns no
  // `anchor.batch_secured` call site anywhere. The two
  // `event_type: 'anchor.batch_secured'` literals in the worker
  // (services/worker/src/jobs/check-confirmations.ts:153 and :169) are built
  // by `buildBatchSecuredAuditRows()` and inserted into `audit_events` — an
  // audit row is not a delivery. Subscribers to the merkle-batch path receive
  // the per-anchor `anchor.secured` fan-out and nothing else. Flip this only
  // when a dispatch site exists (§1.13 R-7).
  'anchor.batch_secured': {
    live: false,
    fields: ['public_ids', 'anchor_count', 'chain_tx_id', 'chain_block_height', 'chain_timestamp', 'secured_at'],
  },
  // Emits on connector credential import (SCRUM-1798 Phase 2a,
  // services/worker/src/api/v1/credential-sources.ts) — unflagged.
  'credential.issued': {
    live: true,
    fields: ['public_id', 'status', 'issued_at', 'expires_at?', 'credential_type', 'recipient_public_id?', 'org_public_id?'],
  },
  // Wired but flag-gated dark: ENABLE_CREDENTIAL_VERIFIED_WEBHOOK defaults
  // false and is unset in prod. Flip only after verifying the prod flag.
  'credential.verified': {
    live: false,
    fields: ['public_id', 'status', 'verified_at', 'verifier_country?', 'credential_type', 'recipient_public_id?', 'org_public_id?'],
  },
  // Four live producers (SCRUM-1800): revoke, supersede, bulk-confirm, and
  // reorg-revert — any anchor with a credential_type emits on those
  // transitions, no feature flag.
  'credential.status_changed': {
    live: true,
    fields: ['public_id', 'previous_status', 'new_status', 'changed_at', 'reason?', 'credential_type', 'recipient_public_id?', 'org_public_id?'],
  },
  // BUG-002: `live: true` is asserted because the emit point is real —
  // POST /cron/check-credential-expiry, behind the ENABLE_EXPIRY_ALERTS flag.
  // Field list mirrors ComplianceDocumentExpiringPayloadSchema (strict).
  'compliance.document_expiring': {
    live: true,
    fields: ['public_id', 'status', 'expires_at', 'days_remaining', 'warning_level', 'credential_type?', 'label?', 'org_public_id?'],
  },
  'job.completed': { live: true, fields: ['job_ref', 'status', 'total', 'result_count', 'error_code'] },
  'compliance.certificate_expiring': { live: true, fields: ['certificate_ref', 'expires_at', 'warning_level', 'days_remaining'] },
  'compliance.anchor_delayed': { live: true, fields: ['pending_count', 'oldest_pending_since', 'threshold_minutes'] },
  'compliance.signature_revoked': { live: false, fields: ['public_id', 'revocation_reason', 'revoked_at'] },
  'compliance.timestamp_coverage_low': { live: true, fields: ['coverage_pct', 'threshold_pct', 'total_signatures', 'timestamped_signatures', 'period_days'] },
  // SCRUM-3982: `live: true` — POST /api/v1/attestations really dispatches
  // this (services/worker/src/api/v1/attestations.ts:472), and the org id its
  // guard reads IS selected. Fields mirror AttestationCreatedPayloadSchema
  // (strict); `fingerprint` was removed from the producer in the same change.
  // CTO ruling Z5 (2026-09-12): the single-create route is the ONLY producer.
  // POST /api/v1/attestations/batch-create (same file, router registered at
  // line 707) creates attestations without dispatching anything, so a bulk
  // caller receives no event. The copy.ts description says so — do not widen
  // it back to "an attestation was created" (§1.13 R-7).
  'attestation.created': {
    live: true,
    fields: ['public_id', 'attestation_type', 'status', 'created_at', 'org_public_id?'],
  },
  // `live: false` — verified, not inferred. The revoke handler's dispatch is
  // guarded on `attestation.attester_org_id`, and the ownership query above it
  // selects only `id, status, attester_user_id`, so the guard is always false
  // and this event has never been delivered. Subscribable + contract-locked;
  // flipping this badge requires making the producer reachable, not editing
  // this line (§1.13 R-7).
  'attestation.revoked': {
    live: false,
    fields: ['public_id', 'status', 'revocation_reason', 'revoked_at', 'attestation_type?', 'org_public_id?'],
  },
  'anchor.revocation_anchored': {
    live: true,
    fields: ['public_id', 'status', 'revocation_tx_id', 'revocation_block_height', 'original_chain_tx_id', 'org_public_id?'],
  },
  'attestation.active': {
    live: true,
    fields: ['public_id', 'attestation_type', 'status', 'chain_tx_id', 'chain_timestamp', 'org_public_id?'],
  },
};
