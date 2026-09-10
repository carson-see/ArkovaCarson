/**
 * Adobe Sign webhook helpers (SCRUM-1148).
 *
 * Adobe Sign sends agreement-event notifications signed with a per-webhook
 * client-secret HMAC over the exact raw body, using SHA-256 and Base64.
 * Reference: https://opensource.adobe.com/acrobat-sign/developer_guide/webhooks.html
 *
 * Header carrying the signature is `X-AdobeSign-ClientId-Authentication-Sha256`
 * (mirrored alongside the older `X-AdobeSign-ClientId` proof header). Adobe
 * documents the canonicalization as raw HTTP body bytes — same as DocuSign,
 * different header.
 */
import { z } from 'zod';
import { verifyHmacSha256Base64 } from './hmac.js';

/**
 * Code/constraint parity with `organization_rule_events` (baseline migration).
 *
 * Every field below is copied into that row by the webhook handler's
 * `enqueue_rule_event` call, and the row carries hard CHECK constraints:
 *   `agreement.id`               -> external_file_id  (char_length <= 500)
 *   `agreement.name`             -> filename          (char_length <= 500)
 *   `agreement.senderInfo.email` -> sender_email      (char_length <= 320)
 *
 * Neither over-long value used to be caught HERE, and the two failed differently
 * — both badly:
 *   - `agreement.id` was caught late, by `NonEmptyString` (`.max(500)`) inside
 *     `adaptAdobeSign`. That throw happens AFTER the replay nonce is committed,
 *     so the handler DLQs and returns **500**, and the retry — identical body,
 *     identical `payload_hash` — is answered `200 {duplicate:true}`. A value we
 *     always intended to reject cost us the event and told Adobe it succeeded.
 *   - `senderInfo.email` was not caught at all: `MaybeEmail` in
 *     `connectors/schemas.ts` is `z.string().trim().toLowerCase().email()` with
 *     NO length cap, so a >320-char address reached Postgres and raised SQLSTATE
 *     23514 inside the RPC — same 500, same swallowed retry, same silent loss.
 *
 * Bounding both at the parse layer moves the rejection BEFORE the nonce insert,
 * where the handler's existing 400 + DLQ-audit branch handles it: bounded,
 * auditable, and not a 5xx. Keep these in step with the migration set — the
 * webhook test asserts them against the constraints it reads from
 * `supabase/migrations/`, so narrowing a CHECK fails CI rather than production.
 *
 * NOT fixed here (other handlers' surface): `MaybeEmail` is shared, so the
 * DocuSign (`sender.email`) and Checkr (`candidate.email`) adapters still feed
 * an unbounded address into the same 320-char column.
 */
const EXTERNAL_FILE_ID_MAX = 500;
const FILENAME_MAX = 500;
const SENDER_EMAIL_MAX = 320;

const RawAdobeWebhookPayload = z
  .object({
    event: z.string().trim().min(1),
    eventDate: z.string().optional(),
    agreement: z
      .object({
        id: z.string().trim().min(1).max(EXTERNAL_FILE_ID_MAX),
        name: z.string().trim().max(FILENAME_MAX).optional(),
        senderInfo: z
          .object({ email: z.string().trim().max(SENDER_EMAIL_MAX).email().optional() })
          .partial()
          .optional(),
        // Adobe sends the SHA256 of each constituent document if requested.
        documents: z
          .array(
            z.object({
              id: z.string().trim().min(1),
              name: z.string().trim().max(500).optional(),
              sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
            }),
          )
          .max(100)
          .optional(),
      })
      .passthrough(),
    webhookId: z.string().trim().min(1).optional(),
    webhookName: z.string().trim().max(200).optional(),
  })
  .passthrough();

export interface AdobeAgreementCompletedEvent {
  event: 'AGREEMENT_WORKFLOW_COMPLETED';
  agreementId: string;
  agreementName: string | null;
  senderEmail: string | null;
  documents: Array<{ id: string; name: string | null; sha256: string | null }>;
  webhookId: string | null;
}

export function verifyAdobeSignHmac(args: {
  rawBody: Buffer | string;
  signature: string | undefined;
  clientSecret: string;
}): boolean {
  return verifyHmacSha256Base64({
    rawBody: args.rawBody,
    signature: args.signature,
    secret: args.clientSecret,
  });
}

export function parseAdobeSignPayload(rawBody: Buffer | string): AdobeAgreementCompletedEvent {
  const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
  const json = JSON.parse(text);
  const parsed = RawAdobeWebhookPayload.parse(json);

  // Only AGREEMENT_WORKFLOW_COMPLETED is in scope for the rules engine —
  // any other event type (CREATED, RECALLED, REJECTED) is still a 200-OK
  // ack but the caller will skip it; we throw so the route can return 200
  // with a clear "ignored" body. Treat case-insensitively per Adobe docs.
  if (parsed.event.toUpperCase() !== 'AGREEMENT_WORKFLOW_COMPLETED') {
    throw new Error(`Unsupported Adobe Sign event: ${parsed.event}`);
  }
  if (!parsed.agreement?.id) {
    throw new Error('Adobe Sign payload missing agreement.id');
  }

  return {
    event: 'AGREEMENT_WORKFLOW_COMPLETED',
    agreementId: parsed.agreement.id,
    agreementName: parsed.agreement.name ?? null,
    senderEmail: parsed.agreement.senderInfo?.email ?? null,
    documents: (parsed.agreement.documents ?? []).map((d) => ({
      id: d.id,
      name: d.name ?? null,
      sha256: d.sha256 ?? null,
    })),
    webhookId: parsed.webhookId ?? null,
  };
}
