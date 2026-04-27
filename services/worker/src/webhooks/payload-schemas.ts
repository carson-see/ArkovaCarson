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
 *   - `anchor_id`     — internal UUID (CLAUDE.md §6)
 *   - `fingerprint`   — raw document-derived hash (CLAUDE.md §1.6)
 *   - `org_id`        — internal UUID
 *   - `user_id`       — internal UUID
 *   - any field starting with `_`  — internal-only convention
 */

import { z } from 'zod';

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const isoTimestamp = z
  .string()
  .regex(ISO_TIMESTAMP_RE, 'must be an ISO 8601 timestamp');

/**
 * Common fields shared across all anchor lifecycle events.
 * The .strict() call on each derived schema rejects unknown keys at runtime,
 * which is what enforces "no anchor_id leaks." We declare it on each
 * specific schema rather than this base because z.object().strict() can't be
 * extended without losing strictness on the base portion.
 */
const ANCHOR_BASE_FIELDS = {
  public_id: z.string().min(1).max(64),
  chain_tx_id: z.string().nullable(),
  chain_block_height: z.number().int().nonnegative().nullable(),
  org_public_id: z.string().min(1).max(64).nullable().optional(),
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
 * Map event_type → matching schema. Used by `dispatchWebhookEvent` to validate
 * outbound payloads against the canonical contract before signing.
 */
export const PAYLOAD_SCHEMAS_BY_EVENT_TYPE = {
  'anchor.submitted': AnchorSubmittedPayloadSchema,
  'anchor.secured': AnchorSecuredPayloadSchema,
  'anchor.revoked': AnchorRevokedPayloadSchema,
  'anchor.batch_secured': AnchorBatchSecuredPayloadSchema,
} as const;

export type WebhookEventType = keyof typeof PAYLOAD_SCHEMAS_BY_EVENT_TYPE;
export type AnchorSubmittedPayload = z.infer<typeof AnchorSubmittedPayloadSchema>;
export type AnchorSecuredPayload = z.infer<typeof AnchorSecuredPayloadSchema>;
export type AnchorRevokedPayload = z.infer<typeof AnchorRevokedPayloadSchema>;
export type AnchorBatchSecuredPayload = z.infer<typeof AnchorBatchSecuredPayloadSchema>;

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
 * Validate an outbound webhook payload against the schema for its event type.
 * Throws `WebhookPayloadValidationError` if the payload contains banned
 * fields (anchor_id, fingerprint, user_id, org_id) or fails any schema check.
 *
 * Unknown event types pass through without validation — the schemas in this
 * file are an allowlist, and other event types (`payment.*`, `org.*`) ride
 * the general dispatch path until their own schemas are added.
 *
 * PR #567 CodeRabbit minor fix: surfaces the unknown event type via the
 * `bypassed` flag so `dispatchWebhookEvent` can emit a debug log. Without
 * this, a typo like `anchor.SUBMITTED` (caps) would silently skip
 * validation and ship banned fields with no signal.
 */
export function validateWebhookPayload(
  eventType: string,
  data: unknown,
): { ok: true; bypassed?: boolean } | { ok: false; error: WebhookPayloadValidationError } {
  const schema = PAYLOAD_SCHEMAS_BY_EVENT_TYPE[eventType as WebhookEventType];
  if (!schema) return { ok: true, bypassed: true };
  const result = schema.safeParse(data);
  if (result.success) return { ok: true };
  return { ok: false, error: new WebhookPayloadValidationError(eventType, result.error.issues) };
}
