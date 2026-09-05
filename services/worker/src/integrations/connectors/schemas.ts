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

// =============================================================================
// INT-12 — E-Sign (SCRUM-1016)
// =============================================================================

/** DocuSign Connect envelope-completed payload — fields we care about. */
export const DocusignEnvelopeCompleted = z.object({
  event: z.literal('envelope-completed'),
  eventId: NonEmptyString.optional(),
  envelopeId: NonEmptyString,
  // The account whose Connect configuration produced THIS delivery (used to
  // resolve the org_integrations/member_integrations row + its HMAC key —
  // unchanged by docusign-bilateral-2026-08). NOT necessarily the envelope's
  // owning/sending account — see `senderAccountId` below.
  accountId: NonEmptyString,
  status: z.literal('completed'),
  generatedDateTime: z.string().datetime().optional(),
  sender: z
    .object({ email: MaybeEmail })
    .partial()
    .optional(),
  // docusign-bilateral-2026-08 (feasibility spike, SCRUM-3817/SCRUM-3818):
  // the envelope's declared owning/sending DocuSign account, when DocuSign's
  // notification states one distinct from `accountId` — carries the payload's
  // `sender.accountId`. Optional and ABSENT on every payload shape that
  // predates this field (including 100% of traffic today): the webhook
  // classifier (services/worker/src/api/v1/webhooks/docusign.ts) treats a
  // missing `senderAccountId` as "same as accountId" (falls back to it),
  // which reproduces the pre-existing outbound-only classification exactly.
  // Never trust this field alone for a trust decision — the classifier
  // additionally cross-checks it against the resolving org's own
  // SERVER-STORED connected-account set before ever calling an envelope
  // "outbound" (see that file's `classifyDirection`).
  senderAccountId: NonEmptyString.optional(),
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
