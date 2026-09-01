/**
 * Connector Webhook Payload Schemas (INT-10 / INT-12 / INT-13)
 *
 * SCRUM-1015 (INT-10): Google Workspace / Microsoft 365
 * SCRUM-1016 (INT-12): DocuSign / Adobe Sign
 * SCRUM-1030 (INT-13): ATS / Background Check (Veremark / Checkr)
 *
 * Each vendor posts webhooks in its own shape. The handler in
 * `webhook-handlers.ts` validates the shape with these schemas, then emits a
 * canonical `TriggerEvent` for the Rules Engine (ARK-106) to evaluate.
 *
 * All webhook payloads are HMAC-validated BEFORE these schemas run (SEC-01
 * lands the uniform middleware in SCRUM-1025). These schemas are the
 * second-pass validation: reject malformed payloads that survived HMAC.
 *
 * Live credentialed traffic is GATED on vendor accounts + legal:
 *   ENABLE_INT10_WORKSPACE      — Google/M365 (blocked on OAuth app approval)
 *   ENABLE_INT12_ESIGN          — DocuSign/Adobe (blocked on Partner Connect)
 *   ENABLE_INT13_ATS            — Veremark/Checkr (blocked on data-sharing MSA)
 */
import { z } from 'zod';

// =============================================================================
// Shared primitives
// =============================================================================

const NonEmptyString = z.string().trim().min(1).max(500);
const MaybeEmail = z.string().trim().toLowerCase().email().optional();

// Standard 8-4-4-4-12 hex GUID shape — deliberately NOT Zod's built-in
// `.uuid()`, which additionally enforces the RFC 4122 variant nibble
// (8/9/a/b) that a vendor-issued GUID is not guaranteed to satisfy. Used to
// structurally pin PII-adjacent identifier fields (see `DocusignCapturedSigner`
// below) so a value cannot pass validation merely by having the right KEY
// NAME while holding an email/name in the wrong shape.
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GuidString = NonEmptyString.regex(GUID_PATTERN, 'must be a GUID');

// =============================================================================
// INT-12 — E-Sign (SCRUM-1016)
// =============================================================================

/** DocuSign Connect envelope-completed payload — fields we care about. */
export const DocusignEnvelopeCompleted = z.object({
  event: z.literal('envelope-completed'),
  eventId: NonEmptyString.optional(),
  envelopeId: NonEmptyString,
  accountId: NonEmptyString,
  status: z.literal('completed'),
  generatedDateTime: z.string().datetime().optional(),
  sender: z
    .object({ email: MaybeEmail })
    .partial()
    .optional(),
  envelopeDocuments: z
    .array(
      z.object({
        documentId: NonEmptyString,
        name: z.string().trim().max(500).optional(),
        // SHA-256 is vendor-provided when present — we NEVER compute
        // fingerprints server-side (Constitution §1.6).
        sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
      }),
    )
    .max(100)
    .default([]),
});

/**
 * CTO Decision Record (docs/staging/docusign-bilateral-2026-08,
 * ruling R6) — a captured DocuSign signer identifier. PSEUDONYMOUS ONLY:
 * `recipient_id_guid` (DocuSign's envelope-scoped GUID) and `user_id`
 * (DocuSign's platform user id, absent for pure email-link signers) — never
 * a name or email.
 *
 * Zod's default "strip unknown keys" object mode is load-bearing here: the
 * raw DocuSign recipient object also carries `name` / `email` / `phoneAuthentication`
 * / etc. Because this schema does not list them, they are stripped BY
 * CONSTRUCTION on `.parse()` — not merely "not read" by whatever code
 * happens to touch the object afterward. No caller may widen this schema
 * with `.passthrough()`; doing so would defeat the guarantee.
 *
 * HIGH finding (PR #2474 review): stripping-by-key-name alone is not enough —
 * if a future/buggy DocuSign payload ever mis-slots a value so that
 * `recipientIdGuid` (or `userId`) HOLDS an email/name string, every gate that
 * only checks the key name would wave it through and persist PII under a
 * GUID-shaped field name. `GuidString` pins the VALUE shape, not just the
 * key: a non-GUID `recipient_id_guid`/`user_id` fails `.safeParse()`, so
 * `extractSigners` (webhooks/docusign.ts) silently skips that entry — same
 * fail-soft posture as a missing required field, never a thrown error.
 */
export const DocusignCapturedSigner = z.object({
  recipient_id_guid: GuidString,
  // Absent for pure email-link (non-platform) signers — DocuSign only
  // assigns userId to a recipient with a DocuSign platform account.
  user_id: GuidString.optional(),
  status: NonEmptyString,
  // Deliberately NOT `.datetime()` — mirrors the existing notary extraction
  // (`extractNotaryData`/`completedDateTime`), which accepts DocuSign's raw
  // timestamp string as-is rather than enforcing strict RFC3339.
  signed_at: z.string().trim().min(1).max(100).optional(),
});

export type DocusignCapturedSignerT = z.infer<typeof DocusignCapturedSigner>;

/** R6: display cap + persistence cap for captured signers (metadata-size safety). */
export const MAX_CAPTURED_DOCUSIGN_SIGNERS = 20;

function trimmedSignerField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/**
 * Shared per-recipient mapping algorithm behind BOTH `extractSigners`
 * (`api/v1/webhooks/docusign.ts`, the live Connect webhook) and
 * `extractCapturedSigners` (`integrations/oauth/docusign.ts`, the signer
 * backfill's `/recipients` REST fetch). The two call sites differ only in
 * WHERE they find the raw `signers[]` array — `recipients.signers` off a
 * webhook payload vs `signers` off the eSignature REST recipients response —
 * not in how one raw recipient becomes a `DocusignCapturedSignerT`; that
 * conversion lives here exactly once.
 *
 * PII discipline (R6): only `recipientIdGuid`/`userId`/`status`/
 * `signedDateTime` are ever read off the raw recipient, individually, into a
 * fresh literal — never a spread — so a DocuSign-supplied `name`/`email` can
 * never reach the result even if a future payload shape adds more fields.
 * `DocusignCapturedSigner.safeParse` is a second, independent gate: its
 * default (non-`.passthrough()`) object mode strips anything not explicitly
 * listed, rejects entries missing a required `recipient_id_guid`/`status`,
 * and (PR #2474 review, HIGH) rejects `recipient_id_guid`/`user_id` values
 * that are not GUID-shaped — key-name stripping alone cannot stop a
 * mis-slotted email/name riding in under the right field name, so the value
 * shape is pinned too; that failure mode fails closed (entry skipped), not
 * open.
 *
 * Also dedupes by `recipient_id_guid` (a resend/bounce can list the same
 * signer twice) and caps at `MAX_CAPTURED_DOCUSIGN_SIGNERS`, truncating
 * rather than rejecting the whole envelope.
 */
export function captureDocusignSigners(
  signers: Array<Record<string, unknown>> | undefined,
): DocusignCapturedSignerT[] {
  if (!signers || signers.length === 0) return [];

  const captured: DocusignCapturedSignerT[] = [];
  const seenGuids = new Set<string>();
  for (const raw of signers) {
    if (captured.length >= MAX_CAPTURED_DOCUSIGN_SIGNERS) break;

    const recipientIdGuid = trimmedSignerField(raw, 'recipientIdGuid');
    const userId = trimmedSignerField(raw, 'userId');
    const status = trimmedSignerField(raw, 'status');
    const signedAt = trimmedSignerField(raw, 'signedDateTime');
    // Optional fields are only spread in when present — an explicit
    // `undefined` value would still leave the key on the object (Zod
    // `.optional()` accepts that), which would defeat the "absent, not
    // merely falsy" contract the pure-email-link-signer case (no userId) and
    // unsigned-recipient case (no signed_at) both rely on.
    const candidate = {
      ...(recipientIdGuid ? { recipient_id_guid: recipientIdGuid } : {}),
      ...(userId ? { user_id: userId } : {}),
      ...(status ? { status } : {}),
      ...(signedAt ? { signed_at: signedAt } : {}),
    };
    const parsed = DocusignCapturedSigner.safeParse(candidate);
    if (parsed.success && !seenGuids.has(parsed.data.recipient_id_guid)) {
      seenGuids.add(parsed.data.recipient_id_guid);
      captured.push(parsed.data);
    }
    // Entries missing a required recipient_id_guid/status, or whose
    // recipient_id_guid/user_id is not GUID-shaped, are silently skipped —
    // never persisted as a partial/identity-less/PII row — fail-soft, matches
    // extractNotaryData's posture (best-effort metadata, never blocks the
    // standard eSign flow or the backfill run).
  }
  return captured;
}

/** Adobe Sign agreement-signed payload — simplified shape. */
export const AdobeAgreementSigned = z.object({
  event: z.literal('AGREEMENT_WORKFLOW_COMPLETED'),
  agreement: z.object({
    id: NonEmptyString,
    name: z.string().trim().max(500).optional(),
    senderInfo: z
      .object({ email: MaybeEmail })
      .partial()
      .optional(),
  }),
});

// =============================================================================
// INT-10 — Workspace (SCRUM-1015)
// =============================================================================

/** Google Drive `changes.watch` notification. Minimal shape. */
export const GoogleDriveChange = z.object({
  kind: z.literal('api#channel').optional(), // push header
  resourceId: NonEmptyString,
  resourceUri: z.string().url().max(2000).optional(),
  eventType: z.enum(['add', 'update', 'remove']).optional(),
  fileId: NonEmptyString,
  name: z.string().trim().max(500).optional(),
  mimeType: z.string().trim().max(200).optional(),
  modifiedTime: z.string().datetime().optional(),
  parents: z.array(z.string().max(200)).max(20).optional(),
});

/** Microsoft Graph SharePoint/OneDrive change notification. */
export const MicrosoftGraphChange = z.object({
  subscriptionId: NonEmptyString,
  changeType: z.enum(['created', 'updated', 'deleted']),
  resource: NonEmptyString,
  resourceData: z
    .object({
      id: NonEmptyString,
      name: z.string().trim().max(500).optional(),
      parentReference: z
        .object({ path: z.string().trim().max(2000).optional() })
        .partial()
        .optional(),
    })
    .passthrough(),
  tenantId: z.string().uuid().optional(),
});

// =============================================================================
// INT-13 — ATS / BGC (SCRUM-1030)
// =============================================================================

/** Veremark background-check-completed payload. */
export const VeremarkCheckCompleted = z.object({
  event: z.literal('check.completed'),
  checkId: NonEmptyString,
  candidate: z
    .object({ email: MaybeEmail })
    .partial()
    .optional(),
  report: z
    .object({
      reportId: NonEmptyString,
      documentUrl: z.string().url().max(2000).optional(),
    })
    .optional(),
});

/** Checkr report-completed payload. */
export const CheckrReportCompleted = z.object({
  type: z.literal('report.completed'),
  data: z.object({
    object: z.object({
      id: NonEmptyString,
      status: z.literal('complete'),
      candidate_id: NonEmptyString,
      uri: z.string().url().max(2000).optional(),
    }),
  }),
});

// =============================================================================
// Canonical event emitted into the rules-engine queue
// =============================================================================

export const ConnectorCanonicalEvent = z.object({
  trigger_type: z.enum([
    'ESIGN_COMPLETED',
    'ESIGN_NOTARIZED',
    'WORKSPACE_FILE_MODIFIED',
    'CONNECTOR_DOCUMENT_RECEIVED',
    'MANUAL_UPLOAD',
    'EMAIL_INTAKE',
  ]),
  org_id: z.string().uuid(),
  vendor: z.string().trim().min(1).max(50),
  external_file_id: NonEmptyString,
  filename: z.string().trim().max(500).nullable().optional(),
  folder_path: z.string().trim().max(2000).nullable().optional(),
  sender_email: z.string().email().nullable().optional(),
  subject: z.string().trim().max(500).nullable().optional(),
});

export type ConnectorCanonicalEventT = z.infer<typeof ConnectorCanonicalEvent>;
