/**
 * Outbound webhook payload schemas (SCRUM-1268 R2-5).
 *
 * CLAUDE.md §6 hard-bans exposing internal `id` UUIDs publicly. CLAUDE.md §1.6
 * keeps `fingerprint` (the document-content-derived hash) client-side. Earlier
 * dispatch sites in `services/worker/src/jobs/anchor.ts` and
 * `services/worker/src/jobs/check-confirmations.ts` shipped both — `anchor_id`
 * (the internal UUID) and the raw `fingerprint` hex — to every customer
 * webhook endpoint subscribed to `anchor.submitted` / `anchor.secured`.
 *
 * The schemas in this file are the only authority for what an outbound
 * webhook payload's `data` block may contain. `dispatchWebhookEvent` validates
 * against them before signing; any drift fails loud at runtime AND fails the
 * payload-snapshot tests at PR time. CLAUDE.md §1.8 frozen-API mandate: new
 * fields are nullable + additive only; removing a field requires a v2 prefix.
 *
 * Allowed:
 *   - `public_id`           — short opaque slug, PostgREST-safe to share
 *   - `chain_tx_id`         — public on-chain reference
 *   - `chain_block_height`  — public block height
 *   - `chain_timestamp`     — Network Observed Time per CLAUDE.md §1.5
 *   - `secured_at`          — server timestamp for the SECURED transition
 *   - `submitted_at`        — server timestamp for the SUBMITTED transition
 *   - `org_public_id`       — short opaque slug for the org (when applicable)
 *   - `status`              — narrow string union ('SUBMITTED' | 'SECURED' | 'REVOKED')
 *
 * Banned (will fail validation):
 *   - every key in `BANNED_RESPONSE_KEYS` (api/v1/response-schemas.ts) —
 *     `anchor_id`, `org_id`, `user_id`, `actor_id`, `attester_org_id`,
 *     `attester_user_id`, `key_hash`, `secret_hash`, … all internal UUIDs and
 *     secret hashes. A webhook payload is a MORE exposed surface than a
 *     response body, so that list binds here a fortiori.
 *   - `fingerprint`, and any key containing it (`document_fingerprint`,
 *     `fingerprint_sha256`) — raw document-derived hash (CLAUDE.md §1.6)
 *   - any qualified spelling of the above (`source_anchor_id`) or camelCase
 *     spelling (`orgId`) — matching is normalised, not exact
 *   - any field starting with `_`  — internal-only convention
 *
 * SCRUM-3982: that ban list is no longer only a comment. It is derived as
 * `BANNED_PAYLOAD_KEYS` and enforced by `validateWebhookPayload` — recursively,
 * and on unregistered event types, which is the path every historical leak of
 * this class actually travelled. Unregistered types that are not on the
 * shrinking `LEGACY_UNREGISTERED_EVENT_TYPES` ratchet are refused outright.
 */

import { z } from 'zod';
import { BANNED_RESPONSE_KEYS } from '../api/v1/response-schemas.js';

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const isoTimestamp = z
  .string()
  .regex(ISO_TIMESTAMP_RE, 'must be an ISO 8601 timestamp');

/**
 * The opaque public identifiers that EVERY event family carries, and the whole
 * reason no payload needs an internal UUID. Declared once (CTO review ruling
 * Z10): the same two lines were repeated in five places, so a change to the
 * `max(64)` bound or to `org_public_id`'s nullability had five chances to be
 * applied inconsistently.
 *
 * `public_id` is the resource's own slug; `org_public_id` is the issuing org's.
 * Both are short opaque slugs that are safe to publish — see the "Allowed"
 * block in the file header.
 */
const PUBLIC_ID_FIELDS = {
  public_id: z.string().min(1).max(64),
  org_public_id: z.string().min(1).max(64).nullable().optional(),
} as const;

/**
 * Common fields shared across all anchor lifecycle events.
 * The .strict() call on each derived schema rejects unknown keys at runtime,
 * which is what enforces "no anchor_id leaks." We declare it on each
 * specific schema rather than this base because z.object().strict() can't be
 * extended without losing strictness on the base portion.
 */
const ANCHOR_BASE_FIELDS = {
  ...PUBLIC_ID_FIELDS,
  chain_tx_id: z.string().nullable(),
  chain_block_height: z.number().int().nonnegative().nullable(),
} as const;

export const AnchorSubmittedPayloadSchema = z
  .object({
    ...ANCHOR_BASE_FIELDS,
    status: z.literal('SUBMITTED'),
    submitted_at: isoTimestamp,
  })
  .strict();

// PR #567 CodeRabbit P1 fix: SECURED ⇒ on-chain invariant. The base fields
// allow null `chain_tx_id` / `chain_block_height` because `anchor.submitted`
// emits before the tx is mined. SECURED is the post-confirmation state and
// MUST have both fields populated — override the nullable bases with strict
// non-null versions so a future regression that ships
// `{ status: 'SECURED', chain_tx_id: null, chain_block_height: null }` fails
// schema validation.
export const AnchorSecuredPayloadSchema = z
  .object({
    ...ANCHOR_BASE_FIELDS,
    chain_tx_id: z.string().min(1),
    chain_block_height: z.number().int().nonnegative(),
    status: z.literal('SECURED'),
    chain_timestamp: isoTimestamp,
    secured_at: isoTimestamp,
  })
  .strict();

export const AnchorRevokedPayloadSchema = z
  .object({
    ...ANCHOR_BASE_FIELDS,
    status: z.literal('REVOKED'),
    revoked_at: isoTimestamp,
    revocation_reason: z.string().nullable().optional(),
  })
  .strict();

// SCRUM-1735: anchor.expired fires when a SECURED anchor crosses
// `anchors.expires_at` and is transitioned to status=EXPIRED by the
// anchorExpirySweep cron (spec'd in this story; implementation is SCRUM-1736).
// Same on-chain invariant as SECURED — chain_tx_id and chain_block_height
// must be populated because EXPIRED can only follow SECURED. Two timestamps
// are emitted: `expires_at` (the original anchor expiry the cron crossed —
// from `anchors.expires_at`) and `expired_at` (server timestamp of the
// EXPIRED transition itself, for partner reconciliation against deliveries).
export const AnchorExpiredPayloadSchema = z
  .object({
    ...ANCHOR_BASE_FIELDS,
    chain_tx_id: z.string().min(1),
    chain_block_height: z.number().int().nonnegative(),
    status: z.literal('EXPIRED'),
    expires_at: isoTimestamp,
    expired_at: isoTimestamp,
  })
  .strict();

// SCRUM-2937: anchor.superseded fires when a SECURED anchor is atomically
// replaced by a re-issued child (lifecycle transition SECURED → SUPERSEDED,
// sourced from the `supersede_anchor` RPC behind POST /api/anchor/:id/supersede
// — the same action a dashboard org admin takes from VersionConflictsPage /
// the RecordDetail lineage view). Headless partners (e.g. HakiChain) have no
// dashboard, so without this event they silently miss supersession while a
// dashboard org sees the whole version chain — the webhook↔dashboard parity
// gap this story closes.
//
// Same on-chain invariant as SECURED / EXPIRED: SUPERSEDED can only follow
// SECURED, so chain_tx_id + chain_block_height must be populated (a regression
// shipping nulls fails validation before signing). Two additive public-only
// fields carry the lineage pointer + reason:
//   - `superseded_by_public_id` — the child anchor's public slug (same org,
//     same lineage). Nullable + optional: the child slug may not be resolvable
//     at dispatch time, and older producers may omit it (§1.8 additive).
//   - `supersession_reason` — the operator-supplied reason, capped at 500.
//     Nullable + optional; free text, PII-banned by convention (the .strict()
//     rejects unknown keys; UUIDs/fingerprint can never ride this event).
export const AnchorSupersededPayloadSchema = z
  .object({
    ...ANCHOR_BASE_FIELDS,
    chain_tx_id: z.string().min(1),
    chain_block_height: z.number().int().nonnegative(),
    status: z.literal('SUPERSEDED'),
    superseded_at: isoTimestamp,
    superseded_by_public_id: z.string().min(1).max(64).nullable().optional(),
    supersession_reason: z.string().max(500).nullable().optional(),
  })
  .strict();

/**
 * Aggregate event for the merkle-batch path. Fires once per merkle TX.
 * Per-anchor `anchor.secured` events still fan out alongside this for
 * customers keying off individual `public_id`s — see SCRUM-1264 (R2-1).
 */
export const AnchorBatchSecuredPayloadSchema = z
  .object({
    chain_tx_id: z.string(),
    chain_block_height: z.number().int().nonnegative(),
    chain_timestamp: isoTimestamp,
    secured_at: isoTimestamp,
    anchor_count: z.number().int().nonnegative(),
    public_ids: z.array(z.string().min(1).max(64)).max(20_000),
  })
  .strict();

/**
 * Credential lifecycle events (SCRUM-1743). The `anchor.*` family describes
 * on-chain anchoring lifecycle (submitted/secured/revoked/expired); the
 * `credential.*` family describes the recipient-facing credential lifecycle
 * (issued / verified / status_changed). They are intentionally distinct
 * because consumers care about different transitions:
 *
 *   - HRIS / SIS / verification webhooks key off `credential.issued` to fan
 *     out to recipient inboxes the moment an issuer creates a credential —
 *     this fires BEFORE chain confirmation (anchor.secured).
 *   - Background-check / verifier integrations key off `credential.verified`
 *     when an /api/v1/verify call resolves a credential as SECURED.
 *   - Issuer-side reconciliation keys off `credential.status_changed` for
 *     any state transition (revocation, expiry, re-issuance).
 *
 * Fields obey the same allowlist as anchor events — `public_id`-only,
 * never internal UUIDs, never `fingerprint`. CLAUDE.md §6 + §1.6.
 *
 * **Emit points are tracked separately** — the schemas and dispatch
 * map entries land in this PR so the contract is locked + customers can
 * subscribe via the existing webhook CRUD; per-event emit-point wiring
 * is split into follow-up Phase-2 tickets so this PR stays reviewable
 * and the staging-soak surface is bounded to schema validation.
 */
const CREDENTIAL_BASE_FIELDS = {
  ...PUBLIC_ID_FIELDS,
  // Recipient (who the credential is issued TO) — distinct from the issuer
  // org. HRIS / SIS integrations key off this for recipient-side fan-out.
  // Optional + nullable because not every credential has a single recipient
  // (org-level attestations, SEC filings, etc).
  recipient_public_id: z.string().min(1).max(64).nullable().optional(),
  credential_type: z.string().min(1).max(64),
} as const;

// ISO 3166-1 alpha-2 country code: exactly two uppercase letters.
const ISO_COUNTRY_CODE_RE = /^[A-Z]{2}$/;

export const CredentialIssuedPayloadSchema = z
  .object({
    ...CREDENTIAL_BASE_FIELDS,
    status: z.literal('ISSUED'),
    issued_at: isoTimestamp,
    expires_at: isoTimestamp.nullable().optional(),
  })
  .strict();

// SCRUM-1743 review feedback: `credential.verified` only fires on a TERMINAL
// resolution. PENDING means "no answer yet, retry later" — emitting a
// verification event in that case is semantically incoherent and would
// confuse downstream HRIS integrations. Allowed: SECURED / REVOKED /
// EXPIRED. PENDING / SUBMITTED do not fire `credential.verified`.
export const CredentialVerifiedPayloadSchema = z
  .object({
    ...CREDENTIAL_BASE_FIELDS,
    status: z.enum(['SECURED', 'REVOKED', 'EXPIRED']),
    verified_at: isoTimestamp,
    // Country code only — never the verifier's IP. ISO 3166-1 alpha-2,
    // shape enforced by regex (length-2 alone would let `'!!'` through).
    verifier_country: z
      .string()
      .regex(ISO_COUNTRY_CODE_RE, 'must be ISO 3166-1 alpha-2 (e.g. US, GB)')
      .nullable()
      .optional(),
  })
  .strict();

export const CredentialStatusChangedPayloadSchema = z
  .object({
    ...CREDENTIAL_BASE_FIELDS,
    // SCRUM-2937: SUPERSEDED added so credential.status_changed can carry the
    // SECURED → SUPERSEDED transition emitted alongside anchor.superseded (the
    // supersede action re-issues a credential as a new child). Widening an
    // accepted enum value is additive per §1.8 — no existing value removed.
    previous_status: z.enum(['PENDING', 'SUBMITTED', 'SECURED', 'REVOKED', 'EXPIRED', 'SUPERSEDED']),
    new_status: z.enum(['PENDING', 'SUBMITTED', 'SECURED', 'REVOKED', 'EXPIRED', 'SUPERSEDED']),
    changed_at: isoTimestamp,
    // Free-form reason capped at 500 chars. Banned: PII, document text,
    // any internal UUIDs (the .strict() rejects unknown keys, this is a
    // soft reminder for the field contents).
    reason: z.string().max(500).nullable().optional(),
  })
  .strict()
  // SCRUM-1743 review feedback: a status_changed event with the same
  // previous and new status is a no-op and should never be emitted.
  // Reject at schema level so future emit code can't accidentally
  // ship one.
  .refine((d) => d.previous_status !== d.new_status, {
    message: 'previous_status and new_status must differ',
    path: ['new_status'],
  });

/**
 * BUG-002: `compliance.document_expiring` is the ADVANCE warning — a SECURED
 * document is inside its 7-day expiry window and has not expired yet. It is
 * distinct from `anchor.expired`, which fires after the fact, once the
 * anchorExpirySweep cron has already transitioned the anchor to EXPIRED. A
 * subscriber acting on `anchor.expired` is by definition too late to renew.
 *
 * It is emitted by `POST /cron/check-credential-expiry` (NCE-09 / SCRUM-600),
 * gated on the `ENABLE_EXPIRY_ALERTS` flag. That emit point has existed since
 * SCRUM-600 but the event type was never added here — and because
 * `VALID_WEBHOOK_EVENTS` is derived from THIS map, no endpoint could ever
 * subscribe to it, so every dispatch matched zero endpoints and was silently a
 * no-op. Worse, an unregistered type takes the `bypassed` branch of
 * `validateWebhookPayload`, so the payload was never checked: the emit site was
 * shipping `anchor_id` (the internal UUID, CLAUDE.md §6) into a `data` block one
 * subscription away from being deliverable. Registering it here is what closes
 * that, not just what turns the feature on — `.strict()` now rejects
 * `anchor_id` before anything is signed.
 *
 * `status` is `SECURED` and only `SECURED`: an EXPIRED or REVOKED document is
 * not "expiring". `days_remaining` is positive for the same reason.
 * Chain fields are deliberately absent — this event is about a calendar date,
 * not an on-chain transition, and the anchor's receipt is already carried by
 * `anchor.secured`.
 */
export const ComplianceDocumentExpiringPayloadSchema = z
  .object({
    ...PUBLIC_ID_FIELDS,
    // Nullable rather than defaulted: `anchors.credential_type` is nullable, and
    // inventing an 'OTHER' for a null would assert a classification we do not
    // have (CLAUDE.md §1.5 — state what is measured).
    credential_type: z.string().min(1).max(64).nullable().optional(),
    status: z.literal('SECURED'),
    expires_at: isoTimestamp,
    days_remaining: z.number().int().positive(),
    warning_level: z.enum(['7_day', '30_day', '60_day', '90_day']),
    // The issuer's own display label for the document, so the alert names
    // something a human recognises. Free text, same footing as
    // `anchor.revoked`'s `revocation_reason`; `.strict()` keeps UUIDs and
    // fingerprints out regardless.
    label: z.string().max(200).nullable().optional(),
  })
  .strict();

/**
 * Attestation lifecycle events (SCRUM-3982). Both have had real
 * `dispatchWebhookEvent` call sites in
 * `services/worker/src/api/v1/attestations.ts` since PH2-AGENT-03 while being
 * absent from the map below — so `validateWebhookPayload` took the
 * `bypassed: true` branch and nothing checked what left the process. The
 * `attestation.created` site was shipping the attestation `fingerprint`
 * (CLAUDE.md §1.6); it is dropped in the same PR that registers these.
 *
 * Public ids only, same allowlist as every other family: no `attestation_id`,
 * no `anchor_id`, no `fingerprint`, no internal UUID of any kind. `.strict()`
 * is what makes that true at runtime rather than by convention.
 */
export const AttestationCreatedPayloadSchema = z
  .object({
    ...PUBLIC_ID_FIELDS,
    // `public.attestation_type` enum (baseline migration): VERIFICATION,
    // ENDORSEMENT, AUDIT, APPROVAL, WITNESS, COMPLIANCE, SUPPLY_CHAIN,
    // IDENTITY, CUSTOM. Kept as a bounded string rather than a mirrored
    // z.enum so that adding a value to the DB enum does not start failing
    // dispatch on a payload the database itself accepted.
    attestation_type: z.string().min(1).max(64),
    // `public.attestation_status` is DRAFT | PENDING | ACTIVE | REVOKED |
    // EXPIRED | CHALLENGED. A *creation* event can only carry a pre-anchoring
    // state: the sole producer inserts `status: 'PENDING'`, and DRAFT is the
    // column default. ACTIVE arrives via the anchoring job (which emits
    // `attestation.active`, a different event), and REVOKED / EXPIRED /
    // CHALLENGED cannot be a creation state. Narrowed deliberately so a
    // future producer that emits a terminal status on `created` fails loudly
    // instead of shipping an incoherent event.
    status: z.enum(['DRAFT', 'PENDING']),
    created_at: isoTimestamp,
  })
  .strict();

export const AttestationRevokedPayloadSchema = z
  .object({
    ...PUBLIC_ID_FIELDS,
    attestation_type: z.string().min(1).max(64).nullable().optional(),
    status: z.literal('REVOKED'),
    // `PATCH /api/v1/attestations/:publicId/revoke` rejects a reason shorter
    // than 3 characters and imposes NO upper bound. This schema mirrors that
    // guard exactly. Do not add a `.max()` here without adding the matching
    // bound to the route first — a cap the producer does not know about turns
    // a long-but-valid revocation into a refused dispatch.
    revocation_reason: z.string().min(3),
    revoked_at: isoTimestamp,
  })
  .strict();

const FOLDER_EVENT_FIELDS = {
  folder_public_id: z.string().min(1).max(64),
  owner_scope: z.enum(['USER', 'ORG']),
  connector_provider: z.enum(['google_drive', 'docusign']).nullable().optional(),
} as const;

/** SCRUM-5142 folder lifecycle payloads expose only the folder's public slug. */
export const FolderLifecyclePayloadSchema = z.object(FOLDER_EVENT_FIELDS).strict();

export const RecordFolderChangedPayloadSchema = z.object({
  folder_public_id: z.string().min(1).max(64).nullable(),
  moved_count: z.number().int().min(1).max(100),
  failed_count: z.number().int().min(0).max(100),
}).strict();

/**
 * Map event_type → matching schema. Used by `dispatchWebhookEvent` to validate
 * outbound payloads against the canonical contract before signing.
 */
export const PAYLOAD_SCHEMAS_BY_EVENT_TYPE = {
  'anchor.submitted': AnchorSubmittedPayloadSchema,
  'anchor.secured': AnchorSecuredPayloadSchema,
  'anchor.revoked': AnchorRevokedPayloadSchema,
  'anchor.expired': AnchorExpiredPayloadSchema,
  'anchor.superseded': AnchorSupersededPayloadSchema,
  'anchor.batch_secured': AnchorBatchSecuredPayloadSchema,
  'credential.issued': CredentialIssuedPayloadSchema,
  'credential.verified': CredentialVerifiedPayloadSchema,
  'credential.status_changed': CredentialStatusChangedPayloadSchema,
  'compliance.document_expiring': ComplianceDocumentExpiringPayloadSchema,
  'attestation.created': AttestationCreatedPayloadSchema,
  'attestation.revoked': AttestationRevokedPayloadSchema,
  'folder.created': FolderLifecyclePayloadSchema,
  'folder.updated': FolderLifecyclePayloadSchema,
  'folder.deleted': FolderLifecyclePayloadSchema,
  'record.folder_changed': RecordFolderChangedPayloadSchema,
} as const;

export type WebhookEventType = keyof typeof PAYLOAD_SCHEMAS_BY_EVENT_TYPE;
export type AnchorSubmittedPayload = z.infer<typeof AnchorSubmittedPayloadSchema>;
export type AnchorSecuredPayload = z.infer<typeof AnchorSecuredPayloadSchema>;
export type AnchorRevokedPayload = z.infer<typeof AnchorRevokedPayloadSchema>;
export type AnchorExpiredPayload = z.infer<typeof AnchorExpiredPayloadSchema>;
export type AnchorSupersededPayload = z.infer<typeof AnchorSupersededPayloadSchema>;
export type AnchorBatchSecuredPayload = z.infer<typeof AnchorBatchSecuredPayloadSchema>;
export type CredentialIssuedPayload = z.infer<typeof CredentialIssuedPayloadSchema>;
export type CredentialVerifiedPayload = z.infer<typeof CredentialVerifiedPayloadSchema>;
export type CredentialStatusChangedPayload = z.infer<typeof CredentialStatusChangedPayloadSchema>;
export type ComplianceDocumentExpiringPayload = z.infer<typeof ComplianceDocumentExpiringPayloadSchema>;
export type AttestationCreatedPayload = z.infer<typeof AttestationCreatedPayloadSchema>;
export type AttestationRevokedPayload = z.infer<typeof AttestationRevokedPayloadSchema>;
export type FolderLifecyclePayload = z.infer<typeof FolderLifecyclePayloadSchema>;
export type RecordFolderChangedPayload = z.infer<typeof RecordFolderChangedPayloadSchema>;

export class WebhookPayloadValidationError extends Error {
  constructor(
    public readonly eventType: string,
    public readonly issues: z.ZodIssue[],
  ) {
    super(`Webhook payload for ${eventType} failed validation: ${issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    this.name = 'WebhookPayloadValidationError';
  }
}

/**
 * The keys that may NEVER leave Arkova on an outbound webhook, for any event
 * type (SCRUM-3982).
 *
 * DERIVED, not re-typed (CTO review ruling Z3). `api/v1/response-schemas.ts`
 * already maintains `BANNED_RESPONSE_KEYS` for exactly this leak class on v1
 * response bodies, and a webhook payload is a strictly MORE exposed surface: a
 * response body is pulled by an authenticated caller, a webhook payload is
 * pushed to a third-party URL. Anything banned from a response body is banned
 * here a fortiori, plus `fingerprint` (CLAUDE.md §1.6 — the document-derived
 * hash never appears in a response body either, but it is stripped at the
 * sanitizer rather than by that list).
 *
 * Widening `BANNED_RESPONSE_KEYS` therefore tightens webhooks automatically,
 * and the two lists cannot drift apart.
 */
export const BANNED_PAYLOAD_KEYS = [...BANNED_RESPONSE_KEYS, 'fingerprint'] as const;

/** `_`-led keys are internal-only by convention (see the file header). */
export const BANNED_PAYLOAD_KEY_PREFIX = '_';

/**
 * `attesterOrgId` and `attester_org_id` are the same field; an exact-match
 * `Set.has()` caught only one of them. Normalise camelCase to snake_case and
 * lowercase before comparing.
 */
function normalizePayloadKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

const BANNED_PAYLOAD_KEY_SET: ReadonlySet<string> = new Set<string>(
  BANNED_PAYLOAD_KEYS.map(normalizePayloadKey),
);

/**
 * Whether a single payload key is banned. Three rules, in order:
 *
 *  1. `_`-led — internal-only convention (file header).
 *  2. Normalised exact match against `BANNED_PAYLOAD_KEYS`, or a QUALIFIED
 *     spelling of one (`attester_org_id`, `source_anchor_id`, `previous_user_id`
 *     all end in a banned key). Deliberately NOT a blanket `*_id` ban: the file
 *     header explicitly ALLOWS `public_id`, `org_public_id` and `chain_tx_id`,
 *     and a blanket rule would refuse every registered anchor payload.
 *  3. Anything CONTAINING `fingerprint` — `document_fingerprint`,
 *     `evidence_fingerprint`, `fingerprint_sha256`. §1.6 is about the hash
 *     itself, not about one spelling of it.
 *
 * Known and deliberate non-coverage (ruling Z2): `job_id`, `certificate_id` and
 * `signature_id` are internal UUIDs carried by four of the legacy unregistered
 * types below. They are NOT banned, because banning them would refuse live
 * dispatches without registering anything. The fix is to give those types
 * public-id-only schemas (SCRUM-5063); pinned in a test so it cannot be
 * mistaken for coverage.
 */
export function isBannedPayloadKey(key: string): boolean {
  if (key.startsWith(BANNED_PAYLOAD_KEY_PREFIX)) return true;
  const normalized = normalizePayloadKey(key);
  if (BANNED_PAYLOAD_KEY_SET.has(normalized)) return true;
  if (normalized.includes('fingerprint')) return true;
  for (const banned of BANNED_PAYLOAD_KEY_SET) {
    if (normalized.endsWith(`_${banned}`)) return true;
  }
  return false;
}

/** Depth cap — payloads are shallow; this only exists so a cyclic or absurdly
 * deep object cannot turn a validation call into a stack overflow. */
const MAX_SCAN_DEPTH = 8;

/**
 * Every banned key in `data`, as dotted paths in payload order
 * (`metadata.fingerprint`, `items.1.anchor_id`). Empty for a clean payload and
 * for any non-object input.
 *
 * RECURSIVE (CTO review ruling Z3 / finding AB6). The first cut scanned the
 * top level only, on the reasoning that it mirrored `.strict()`. But `.strict()`
 * is the authority for REGISTERED types, and this function's job is the
 * unregistered ones — where there is no schema at all, and where
 * `jobs/attestationAnchor.ts` demonstrably nests a `metadata` object. A
 * top-level scan there is not a mirror of anything, it is a hole.
 */
export function findBannedPayloadKeys(data: unknown, path: string[] = []): string[] {
  if (path.length > MAX_SCAN_DEPTH) return [];
  if (Array.isArray(data)) {
    return data.flatMap((item, index) => findBannedPayloadKeys(item, [...path, String(index)]));
  }
  if (data === null || typeof data !== 'object') return [];
  const hits: string[] = [];
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    // Do not recurse under a banned key: the whole subtree is refused with it,
    // and reporting `org_id` plus `org_id.user_id` is noise.
    if (isBannedPayloadKey(key)) hits.push([...path, key].join('.'));
    else hits.push(...findBannedPayloadKeys(value, [...path, key]));
  }
  return hits;
}

/**
 * Event types with a live `dispatchWebhookEvent(...)` call site in
 * `services/worker/src` that have no schema in the registry above.
 *
 * This exists because unregistered types now FAIL CLOSED (ruling Z2). The
 * original justification for bypassing them — "nothing can subscribe to an
 * unregistered type, so the payload never reaches anyone" — is false:
 *
 *   - `POST /api/v1/webhooks` does restrict `events` to `VALID_WEBHOOK_EVENTS`
 *     (derived from the registry), but that is only one of three writers.
 *   - `create_webhook_endpoint(p_url, p_events)` is SECURITY DEFINER and
 *     GRANTed to `authenticated`; it inserts `p_events` with no allowlist check.
 *   - `webhook_endpoints_insert_org` / `webhook_endpoints_update_org` let any
 *     ORG_ADMIN write the `events` column directly through PostgREST.
 *   - `webhook_endpoints.events` has no CHECK constraint (confirmed against
 *     prod, see `webhooks/agents.md`).
 *
 * So an ORG_ADMIN can subscribe to any string they like, and before this change
 * the resulting delivery was signed with nothing having looked at it.
 *
 * This list is a RATCHET, and the only reason it is not empty is that refusing
 * these seven outright would break live dispatch sites mid-release. Entries
 * come OFF it as SCRUM-5063 registers each type with a public-id-only schema.
 * Nothing is ever added: a NEW event type must ship with a schema.
 */
export const LEGACY_UNREGISTERED_EVENT_TYPES = [
  'job.completed',
  'attestation.active',
  'anchor.revocation_anchored',
  'compliance.anchor_delayed',
  'compliance.certificate_expiring',
  'compliance.signature_revoked',
  'compliance.timestamp_coverage_low',
] as const;

const LEGACY_UNREGISTERED_EVENT_TYPE_SET: ReadonlySet<string> = new Set<string>(
  LEGACY_UNREGISTERED_EVENT_TYPES,
);

function bannedKeyError(eventType: string, bannedPaths: string[]): WebhookPayloadValidationError {
  // Names the offending KEY PATH, never its value — the value is exactly the
  // fingerprint / UUID we are refusing to let out, and this message is logged,
  // sent to Sentry, and stored in `job_queue.last_error`.
  return new WebhookPayloadValidationError(
    eventType,
    bannedPaths.map((keyPath) => ({
      code: 'unrecognized_keys' as const,
      keys: [keyPath],
      path: keyPath.split('.'),
      message: `'${keyPath}' may never appear in an outbound webhook payload (CLAUDE.md §6 + §1.6)`,
    })),
  );
}

/**
 * Validate an outbound webhook payload against the schema for its event type.
 * Returns `ok: false` if the payload contains banned fields (anchor_id,
 * fingerprint, user_id, org_id) or fails any schema check; `dispatchWebhookEvent`
 * error-logs and throws on that, so the payload is never signed or delivered.
 *
 * SCRUM-3982 — exactly ONE authority per event type (CTO review ruling Z4):
 *
 *   REGISTERED   → the schema. `.strict()` already refuses every banned key by
 *                  not declaring it, and it reports a precise
 *                  `unrecognized_keys` issue. Running a key scan first only
 *                  shadowed that with a vaguer message. A structural test pins
 *                  that every registered schema is a flat object of primitives,
 *                  which is what makes top-level `.strict()` a complete guard.
 *   LEGACY        → the recursive banned-key scan. Seven types (see
 *   UNREGISTERED    `LEGACY_UNREGISTERED_EVENT_TYPES`) have live dispatch sites
 *                   and no schema yet; they pass with `bypassed: true` only
 *                   after the scan clears them. This is where the historical
 *                   leaks travelled: BUG-002 (`compliance.document_expiring`
 *                   shipping `anchor_id`), and today `anchor.revocation_anchored`
 *                   + `attestation.active`, both of which ship `fingerprint`
 *                   from T3 lifecycle jobs this PR does not edit — now refused
 *                   at this boundary instead of edited at the producer.
 *   ANYTHING ELSE → FAIL CLOSED. Not "bypass". An unregistered type IS
 *                   subscribable (see `LEGACY_UNREGISTERED_EVENT_TYPES` for the
 *                   three writers that skip the allowlist), so bypassing an
 *                   unknown type shipped an unchecked payload to a real
 *                   endpoint. It also means a typo (`anchor.SECURED`) is now an
 *                   error rather than a silent unvalidated dispatch — the
 *                   failure mode PR #567 added the `bypassed` flag to warn
 *                   about, closed properly.
 */
export function validateWebhookPayload(
  eventType: string,
  data: unknown,
): { ok: true; bypassed?: boolean } | { ok: false; error: WebhookPayloadValidationError } {
  const schema = PAYLOAD_SCHEMAS_BY_EVENT_TYPE[eventType as WebhookEventType];
  if (schema) {
    const result = schema.safeParse(data);
    if (result.success) return { ok: true };
    return { ok: false, error: new WebhookPayloadValidationError(eventType, result.error.issues) };
  }

  if (!LEGACY_UNREGISTERED_EVENT_TYPE_SET.has(eventType)) {
    return {
      ok: false,
      error: new WebhookPayloadValidationError(eventType, [
        {
          code: 'custom' as const,
          path: [],
          message:
            `event type '${eventType}' is not registered in PAYLOAD_SCHEMAS_BY_EVENT_TYPE — ` +
            'refusing to dispatch an unvalidated payload. Add a .strict() schema (and the six ' +
            'mirror surfaces) before emitting a new event type.',
        },
      ]),
    };
  }

  const banned = findBannedPayloadKeys(data);
  if (banned.length > 0) return { ok: false, error: bannedKeyError(eventType, banned) };
  return { ok: true, bypassed: true };
}
