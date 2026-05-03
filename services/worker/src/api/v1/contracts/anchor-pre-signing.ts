/**
 * SCRUM-1629 [Spec] — POST /api/v1/contracts/anchor-pre-signing
 *
 * GME10.5-A: pre-signing contract anchor. Creates an unsigned-contract anchor
 * receipt BEFORE the e-signature workflow begins. The anchor's `public_id`
 * (ARK-{YEAR}-{8hex}) becomes the durable handle a DocuSign Connect or
 * Adobe Sign webhook will reference to attach the post-signing anchor as a
 * child (via `parent_anchor_id`).
 *
 * ## Constitution §1.6 reconciliation
 *
 * SCRUM-863's original story text mentioned "PDF binary in body OR
 * document_url" — that text predates the §1.6 client-side processing
 * boundary. For the **pre-signing** path, the document is still on the
 * user's device (it has not yet entered the e-signature provider's
 * pipeline), so the only thing that may cross the wire is the
 * SHA-256 fingerprint computed in the browser. This endpoint accepts
 * `fingerprint` ONLY. Any future variant that wanted to accept raw
 * bytes would need to live behind a separate flag and a separate
 * security review — out of scope here.
 *
 * The **post-signing** sibling (SCRUM-1624) reverses the privacy
 * argument: by definition the signed PDF only exists at the
 * provider, so the post-signing endpoint will fetch it from the
 * provider's tenant on the customer's behalf, hash server-side, and
 * never persist the bytes.
 *
 * ## Frozen v1 schema (CLAUDE.md §1.8)
 *
 * Once this endpoint ships, request + response shapes are frozen.
 * Additive nullable fields are allowed; renames / removals require a
 * v2 namespace and 12-month deprecation. The Zod schemas below are
 * `.strict()` so unknown fields fail validation rather than silently
 * dropping (which would mask integrator bugs and downstream regressions).
 *
 * ## Status
 *
 * SPEC ONLY — this file pins the shape with a stub that returns 501.
 * SCRUM-1630 [Test] writes red-baseline tests against these schemas.
 * SCRUM-1631 [Build] replaces the stub with the real handler.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { ANCHOR_CREDENTIAL_TYPES } from '../../../lib/credential-evidence.js';

const router = Router();

// ─── Frozen v1 contract metadata shape ────────────────────────────────────
//
// The pre-signing anchor records the customer's *intent to sign* a contract.
// This metadata block is the minimum the verification UI needs to render a
// useful "before signing" panel without leaking PII. Counterparties are
// recorded as opaque labels (e.g. "Acme Corp", "John Doe") — never email
// addresses, never document text. The signing provider field is an enum so
// downstream handlers (post-signing webhook receivers) can route by provider
// without parsing freeform strings.
const ContractMetadataSchema = z
  .object({
    title: z.string().min(1).max(200),
    counterparty_labels: z.array(z.string().min(1).max(120)).min(1).max(20),
    effective_date: z.string().datetime({ offset: true }).optional(),
    jurisdiction_label: z.string().max(80).optional(),
  })
  .strict();

// ─── Frozen v1 signing-workflow metadata shape ────────────────────────────
//
// The customer tells us which provider they're about to send the document
// to + an opaque correlation id. The post-signing webhook receiver
// (SCRUM-1624) uses (provider, external_envelope_id) to find this
// pre-signing anchor and link the post-signing anchor as a child.
//
// `external_envelope_id` is opaque to us — DocuSign calls it `envelopeId`,
// Adobe Sign calls it `agreementId`. We don't validate format because
// providers can change ids without notice.
const SigningWorkflowMetadataSchema = z
  .object({
    provider: z.enum(['docusign', 'adobe_sign', 'other']),
    external_envelope_id: z.string().min(1).max(200),
    expected_signer_count: z.number().int().min(1).max(100).optional(),
  })
  .strict();

// ─── Request shape ────────────────────────────────────────────────────────
export const PreSigningAnchorSchema = z
  .object({
    fingerprint: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/, 'must be a 64-character hex SHA-256 hash'),
    // For contracts the credential_type is fixed to CONTRACT_PRESIGNING.
    // `.default()` (not `.optional()`) makes the v1 contract deterministic
    // — every parsed request carries `credential_type: 'CONTRACT_PRESIGNING'`
    // whether the client sent it or not. This avoids the implicit defaulting
    // that pushed the contract decision into [Build]; per CLAUDE.md §1.8
    // (frozen v1 schema), we want the resolved-value behavior pinned now,
    // not at handler-implementation time.
    credential_type: z.literal('CONTRACT_PRESIGNING').default('CONTRACT_PRESIGNING'),
    contract_metadata: ContractMetadataSchema,
    signing_workflow_metadata: SigningWorkflowMetadataSchema,
    description: z.string().max(1000).optional(),
  })
  .strict();

export type PreSigningAnchorRequest = z.infer<typeof PreSigningAnchorSchema>;

// ─── Response shape ───────────────────────────────────────────────────────
//
// Matches the existing /api/v1/anchor receipt shape so SDKs can reuse
// receipt-handling code. Adds `parent_public_id: null` (always null on
// pre-signing — post-signing is the one that links upward) and the echo'd
// `contract_metadata` + `signing_workflow_metadata` so the integrator gets a
// single self-describing object back.
//
// `parent_public_id` (not `parent_anchor_public_id`) per the existing public
// anchor lineage convention — see services/worker/src/api/v1/verify.ts and
// services/worker/src/api/anchor-lineage.ts. Per CodeRabbit review on PR
// #679, unifying naming before v1 freeze avoids a schema-rename later.
export interface PreSigningAnchorReceipt {
  public_id: string;
  fingerprint: string;
  credential_type: 'CONTRACT_PRESIGNING';
  status: 'PENDING';
  parent_public_id: null;
  contract_metadata: z.infer<typeof ContractMetadataSchema>;
  signing_workflow_metadata: z.infer<typeof SigningWorkflowMetadataSchema>;
  created_at: string;
  record_uri: string;
}

// ─── Stub handler ─────────────────────────────────────────────────────────
//
// SCRUM-1629 is the [Spec] subtask. Implementation lands in [Build]
// (SCRUM-1631). Until then this returns 501 + a pointer so any premature
// integrator gets a clear signal rather than a confusing 404.
router.post('/anchor-pre-signing', (req: Request, res: Response) => {
  if (!req.apiKey) {
    res.status(401).json({ error: 'API key required. Include X-API-Key header.' });
    return;
  }

  // Even in stub mode we run validation so red-baseline tests can pin
  // shape rejection without waiting for the [Build] subtask.
  const parsed = PreSigningAnchorSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'invalid_request',
      message: 'Request body failed validation',
      details: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        code: i.code,
        message: i.message,
      })),
    });
    return;
  }

  res.status(501).json({
    error: 'not_implemented',
    message:
      'POST /api/v1/contracts/anchor-pre-signing is the [Spec] stub for SCRUM-1629. ' +
      'The [Build] subtask SCRUM-1631 replaces this with the real handler. ' +
      'See the SCRUM-1623 child-story chain.',
    spec_only: true,
  });
});

// Single source of truth for the enum values [Build] (SCRUM-1631) will
// write to anchors.credential_type. Migration 0285 adds these to the
// `credential_type` Postgres enum; the corresponding ANCHOR_CREDENTIAL_TYPES
// TS array is updated in the same change so this assertion stays in sync.
export const CONTRACT_CREDENTIAL_TYPES = ['CONTRACT_PRESIGNING', 'CONTRACT_POSTSIGNING'] as const;
export type ContractCredentialType = (typeof CONTRACT_CREDENTIAL_TYPES)[number];

// Surface the credential-evidence list at module scope so a future rename
// of the underlying enum surfaces here (typecheck failure) rather than
// silently drifting downstream.
void ANCHOR_CREDENTIAL_TYPES;

export { router as anchorPreSigningRouter };
