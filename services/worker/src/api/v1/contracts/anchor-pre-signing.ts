/**
 * SCRUM-1631 [Build] — POST /api/v1/contracts/anchor-pre-signing
 *
 * GME10.5-A: pre-signing contract anchor. Creates an unsigned-contract anchor
 * receipt BEFORE the e-signature workflow begins. The anchor's `public_id`
 * (ARK-{YEAR}-{8hex}) becomes the durable handle a DocuSign Connect or
 * Adobe Sign webhook will reference to attach the post-signing anchor as a
 * child (via `parent_anchor_id`) — that's SCRUM-1624's job.
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
 * Once this endpoint shipped (SCRUM-1629 [Spec]), request + response
 * shapes are frozen. Additive nullable fields are allowed; renames /
 * removals require a v2 namespace and 12-month deprecation. The Zod
 * schemas below are `.strict()` so unknown fields fail validation
 * rather than silently dropping (which would mask integrator bugs and
 * downstream regressions).
 *
 * ## Status
 *
 * BUILT — handler now does the real work:
 *   1. Zod-parse + canonicalize fingerprint
 *   2. Idempotency check (return existing receipt if fingerprint already
 *      anchored, same pattern as /api/v1/anchor)
 *   3. Org-credit deduction (1 credit per pre-signing anchor)
 *   4. Insert into `anchors` with credential_type=CONTRACT_PRESIGNING
 *      and contract_metadata + signing_workflow_metadata stored as nested
 *      keys inside anchors.metadata (jsonb)
 *   5. Return PreSigningAnchorReceipt with the generated public_id
 *
 * SCRUM-1630 [Test] adds the integration tests (real handler against the
 * mocked supabase chain), beyond the [Spec]'s shape-pinning tests that
 * already live in this file's sibling .test.ts.
 */

import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { buildVerifyUrl } from '../../../lib/urls.js';
import { ANCHOR_CREDENTIAL_TYPES } from '../../../lib/credential-evidence.js';
import { db } from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { deductOrgCredit } from '../../../utils/orgCredits.js';

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
    // Lowercase canonicalization at parse time. SHA-256 fingerprints are
    // case-insensitive but the same digest can be sent as `AA...` or `aa...`
    // by different SDKs; persisting the raw casing would split idempotency
    // lookups across two rows. Canonicalize once here so every downstream
    // consumer (DB insert, idempotency check, audit_events, evidence
    // package) sees the same string. The /api/v1/anchor handler does the
    // same lowercase fold post-parse; doing it inside the schema makes the
    // contract self-enforcing.
    fingerprint: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/, 'must be a 64-character hex SHA-256 hash')
      .transform((s) => s.toLowerCase()),
    // For contracts the credential_type is fixed to CONTRACT_PRESIGNING.
    // `.default()` (not `.optional()`) makes the v1 contract deterministic
    // — every parsed request carries `credential_type: 'CONTRACT_PRESIGNING'`
    // whether the client sent it or not.
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

// ─── Org-credit gate ──────────────────────────────────────────────────────
//
// Same pattern as /api/v1/anchor (services/worker/src/api/v1/anchor-submit.ts).
// Pre-signing counts as 1 credit; SCRUM-1624 post-signing counts as 1 more.
async function ensureOrgCreditAvailable(orgId: string, res: Response): Promise<boolean> {
  const deduction = await deductOrgCredit(db, orgId, 1, 'anchor.create');
  if (deduction.allowed) return true;

  if (deduction.error === 'insufficient_credits') {
    res.status(402).json({
      error: 'insufficient_credits',
      message: 'Organization has insufficient anchor credits for this cycle.',
      balance: deduction.balance,
      required: deduction.required,
    });
    return false;
  }

  if (deduction.error === 'rpc_failure') {
    logger.error({ err: deduction.message, orgId }, 'org_credit_deduct_rpc_failure');
    res.status(503).json({ error: 'credit_check_unavailable' });
    return false;
  }

  logger.warn({ orgId }, 'org_credit_deduct_blocked_uninitialized');
  res.status(402).json({
    error: 'org_credits_not_initialized',
    message:
      'This organization is not provisioned for credit-based billing. ' +
      'An operator must seed org_credits before this API key can submit.',
  });
  return false;
}

// ─── Idempotent receipt builder ───────────────────────────────────────────
//
// Used both for the "fingerprint already anchored" idempotent return path
// AND for the freshly-inserted return path. Keeping a single builder makes
// the response shape provably identical between the two cases.
function buildReceipt(
  publicId: string,
  fingerprint: string,
  createdAt: string,
  body: PreSigningAnchorRequest,
): PreSigningAnchorReceipt {
  return {
    public_id: publicId,
    fingerprint,
    credential_type: 'CONTRACT_PRESIGNING',
    status: 'PENDING',
    parent_public_id: null,
    contract_metadata: body.contract_metadata,
    signing_workflow_metadata: body.signing_workflow_metadata,
    created_at: createdAt,
    record_uri: buildVerifyUrl(publicId),
  };
}

// ─── POST /api/v1/contracts/anchor-pre-signing ────────────────────────────
router.post('/anchor-pre-signing', async (req: Request, res: Response) => {
  if (!req.apiKey) {
    res.status(401).json({ error: 'API key required. Include X-API-Key header.' });
    return;
  }

  // Zod validation per CLAUDE.md §1.2 ("Validation: Zod. Every write path.")
  // Returns RFC 7807-style problem+JSON on validation failure so client
  // integrations can surface field-level errors to their users.
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
  const body: PreSigningAnchorRequest = parsed.data;
  const fingerprint = body.fingerprint; // already lowercased by the schema

  try {
    // Idempotency: if this fingerprint is already anchored (any credential
    // type), return the existing receipt rather than spending another credit
    // and inserting a duplicate row. Same convention as /api/v1/anchor.
    const { data: existing } = await db
      .from('anchors')
      .select('public_id, fingerprint, status, created_at')
      .eq('fingerprint', fingerprint)
      .is('deleted_at', null)
      .maybeSingle();

    if (existing) {
      const receipt = buildReceipt(
        existing.public_id ?? '',
        existing.fingerprint,
        existing.created_at,
        body,
      );
      res.status(200).json(receipt);
      return;
    }

    // Generate public_id (same ARK-{YEAR}-{8hex} convention as /api/v1/anchor)
    const shortId = randomUUID().slice(0, 8).toUpperCase();
    const publicId = `ARK-${new Date().getFullYear()}-${shortId}`;

    const orgId = req.apiKey.orgId ?? null;

    // SCRUM-1170-B — gate org-credit deduction. Helper short-circuits to
    // allowed=true when ENABLE_ORG_CREDIT_ENFORCEMENT is off (default), so
    // existing API-key paths without per-org credit setup are unaffected.
    if (orgId && !(await ensureOrgCreditAvailable(orgId, res))) {
      return;
    }

    const insertPayload = {
      fingerprint,
      public_id: publicId,
      status: 'PENDING' as const,
      org_id: orgId,
      user_id: req.apiKey.userId,
      // anchors.filename is NOT NULL in the schema. Pre-signing anchors
      // don't have a filename per §1.6 (the document never leaves the
      // device); use the contract title as a human-readable handle for
      // the verification UI, prefixed so it's obviously a contract anchor.
      filename: `contract-pre/${body.contract_metadata.title.slice(0, 80)}`,
      credential_type: 'CONTRACT_PRESIGNING' as const,
      description: body.description ?? null,
      // contract_metadata + signing_workflow_metadata stored as nested keys
      // inside anchors.metadata (jsonb). The verification UI + SCRUM-1624
      // post-signing webhook receiver both read these by key.
      metadata: {
        contract_metadata: body.contract_metadata,
        signing_workflow_metadata: body.signing_workflow_metadata,
      },
    };

    const { data: anchor, error: insertError } = await db
      .from('anchors')
      .insert(insertPayload)
      .select('public_id, fingerprint, status, created_at')
      .single();

    if (insertError) {
      logger.error(
        { error: insertError, fingerprint: fingerprint.slice(0, 12) },
        'Failed to create pre-signing contract anchor',
      );
      res.status(500).json({ error: 'Failed to create anchor record' });
      return;
    }

    const receipt = buildReceipt(
      anchor.public_id ?? publicId,
      anchor.fingerprint,
      anchor.created_at,
      body,
    );

    logger.info(
      {
        publicId: receipt.public_id,
        fingerprint: fingerprint.slice(0, 12),
        provider: body.signing_workflow_metadata.provider,
        envelope: body.signing_workflow_metadata.external_envelope_id,
      },
      'Pre-signing contract anchor created',
    );
    res.status(201).json(receipt);
  } catch (error) {
    logger.error({ error }, 'Pre-signing contract anchor submission failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Single source of truth for the contract enum values [Build] writes to
// anchors.credential_type. Migration 0285 added these to the Postgres
// `credential_type` enum; ANCHOR_CREDENTIAL_TYPES + database.types.ts both
// already include them after this PR.
export const CONTRACT_CREDENTIAL_TYPES = ['CONTRACT_PRESIGNING', 'CONTRACT_POSTSIGNING'] as const;
export type ContractCredentialType = (typeof CONTRACT_CREDENTIAL_TYPES)[number];

// Surface the credential-evidence list at module scope so a future rename
// of the underlying enum surfaces here (typecheck failure) rather than
// silently drifting downstream.
void ANCHOR_CREDENTIAL_TYPES;

export { router as anchorPreSigningRouter };
