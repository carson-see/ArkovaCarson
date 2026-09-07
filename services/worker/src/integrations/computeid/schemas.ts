/**
 * ComputeID AgentPassport integration — wire-shape schemas.
 *
 * Sources (verified live against https://api.aicomputeid.com on 2026-09-07):
 *   - OpenAPI 1.0.0 `/openapi.json` for `VerificationReceipt` + `AgentPassport`.
 *   - The webhook contract is NOT in their OpenAPI; shapes come from the
 *     partner's 2026-08-19 / 2026-09-03 emails plus a captured `test` delivery
 *     (`__fixtures__/golden-test-delivery.json`). Passport-event schemas are
 *     therefore deliberately lenient (`.passthrough()`, minimal required set)
 *     so an undocumented extra field never turns a real revocation into a 400.
 */
import { z } from 'zod';

export const COMPUTEID_ISSUER = 'computeid' as const;

export const COMPUTEID_PASSPORT_EVENTS = [
  'passport.revoked',
  'passport.suspended',
  'passport.reinstated',
] as const;
export type ComputeIdPassportEvent = (typeof COMPUTEID_PASSPORT_EVENTS)[number];

/** Sent by `POST /v1/webhooks/test`; carries no passport. Ack + ignore. */
export const COMPUTEID_TEST_EVENT = 'test' as const;

const isoTimestamp = z.string().datetime({ offset: true });

/** Minimum every delivery must carry before we look at the event type. */
export const ComputeIdWebhookEnvelope = z
  .object({
    event: z.string().trim().min(1).max(64),
    timestamp: isoTimestamp,
  })
  .passthrough();

/** `passport.*` events. `reason` is partner free text — treated as untrusted and never persisted or logged. */
export const ComputeIdPassportEventPayload = z
  .object({
    event: z.enum(COMPUTEID_PASSPORT_EVENTS),
    passport_id: z.string().uuid(),
    timestamp: isoTimestamp,
    reason: z.string().max(4000).nullable().optional(),
  })
  .passthrough();
export type ComputeIdPassportEventPayloadT = z.infer<typeof ComputeIdPassportEventPayload>;

/**
 * `verification_receipt` from `GET /v1/agents/{id}/verify`. Only
 * `receipt_payload` (the exact bytes ComputeID signed) is trusted; the sibling
 * fields are unsigned convenience copies and must agree with it.
 */
export const ComputeIdVerificationReceipt = z
  .object({
    passport_id: z.string().uuid(),
    status: z.string().min(1).max(32),
    signature_valid: z.boolean().nullable().optional(),
    issued_at: isoTimestamp,
    expires_at: isoTimestamp,
    key_id: z.string().regex(/^[0-9a-f]{16}$/),
    receipt_signature: z.string().min(1).max(4096),
    receipt_algorithm: z.string().min(1).max(32),
    receipt_payload: z.string().min(2).max(16_384),
  })
  .passthrough();
export type ComputeIdVerificationReceiptT = z.infer<typeof ComputeIdVerificationReceipt>;

export const ComputeIdAdmissionRequest = z.object({
  issuer: z.literal(COMPUTEID_ISSUER).optional(),
  passport_id: z.string().uuid(),
  verification_receipt: ComputeIdVerificationReceipt,
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  allowed_scopes: z.array(z.string().min(1).max(64)).min(1).max(32).optional(),
});
export type ComputeIdAdmissionRequestT = z.infer<typeof ComputeIdAdmissionRequest>;
