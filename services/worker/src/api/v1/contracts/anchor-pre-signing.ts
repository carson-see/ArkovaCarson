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
 *   2. DPA clause 4.6 org field policy — reject a request carrying a field this
 *      organisation may not send (migration 0405). Runs HERE, before step 3,
 *      because the idempotency check answers 200 with a stored receipt and
 *      would otherwise pass a prohibited field through on every retry.
 *   3. Idempotency check (return existing receipt if fingerprint already
 *      anchored, same pattern as /api/v1/anchor)
 *   4. Insert into `anchors` with credential_type=CONTRACT_PRESIGNING
 *      and contract_metadata + signing_workflow_metadata stored as nested
 *      keys inside anchors.metadata (jsonb)
 *   5. Org-credit deduction (1 credit per pre-signing anchor), with a
 *      compensating delete if it fails — see the ATOMICITY NOTE below; this is
 *      insert-then-deduct since SCRUM-2970, not deduct-then-insert
 *   6. Return PreSigningAnchorReceipt with the generated public_id
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
import { ensureAnchorCreditAvailable } from '../../../utils/anchorCreditGate.js';
import { ensureOrgNotSuspended } from '../../../utils/orgSuspensionGuard.js';
import { enforceOrgFieldPolicy } from '../../../utils/orgFieldPolicy.js';

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

// ─── Idempotent receipt builder ───────────────────────────────────────────
//
// Used both for the "fingerprint already anchored" idempotent return path
// AND for the freshly-inserted return path. Keeping a single builder makes
// the response shape provably identical between the two cases.
//
// `metadataSource` matters: for the freshly-inserted path we echo what the
// caller sent (since the DB row contains exactly that). For the idempotent
// path we MUST return what was persisted on the existing row, NOT the
// retry's request body — otherwise a retry with different
// contract_metadata or signing_workflow_metadata gets back a 200 receipt
// containing values that were never persisted (CodeRabbit P1 on PR #680).
function buildReceipt(
  publicId: string,
  fingerprint: string,
  createdAt: string,
  metadataSource: {
    contract_metadata: z.infer<typeof ContractMetadataSchema>;
    signing_workflow_metadata: z.infer<typeof SigningWorkflowMetadataSchema>;
  },
): PreSigningAnchorReceipt {
  return {
    public_id: publicId,
    fingerprint,
    credential_type: 'CONTRACT_PRESIGNING',
    status: 'PENDING',
    parent_public_id: null,
    contract_metadata: metadataSource.contract_metadata,
    signing_workflow_metadata: metadataSource.signing_workflow_metadata,
    created_at: createdAt,
    record_uri: buildVerifyUrl(publicId),
  };
}

// ─── Insert-payload defensive schema ─────────────────────────────────────
//
// CodeRabbit major on PR #680: Zod-validates the *constructed* insert
// payload, not just the request body. Catches future regressions where a
// transform (e.g. `safeTitle`) or a derived field (`public_id`,
// `filename`) silently produces a DB-incompatible value AFTER credit
// deduction. The schema is intentionally narrow — it pins the contract
// pre-signing handler's specific insert shape, not the full anchors-row
// surface.
//
// This is defense-in-depth, not user-facing validation: failure here
// surfaces a 500 (`insert_payload_invalid`) rather than a 400, since
// the request itself was already validated by PreSigningAnchorSchema.
const InsertPayloadSchema = z
  .object({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    public_id: z.string().regex(/^ARK-\d{4}-[A-F0-9]{8}$/),
    status: z.literal('PENDING'),
    org_id: z.string().nullable(),
    user_id: z.string(),
    filename: z
      .string()
      .min(1)
      .max(120)
      // eslint-disable-next-line no-control-regex
      .regex(/^contract-pre\/[^\x00-\x1f\x7f]*$/),
    credential_type: z.literal('CONTRACT_PRESIGNING'),
    description: z.null(),
    metadata: z
      .object({
        contract_metadata: ContractMetadataSchema,
        signing_workflow_metadata: SigningWorkflowMetadataSchema,
      })
      .strict(),
  })
  .strict();

// ─── Stored metadata extraction ───────────────────────────────────────────
//
// On the idempotent path we re-parse the stored anchor's `metadata` jsonb
// through the same Zod schemas the write path validated against. That way:
//   1. The receipt reflects what was actually persisted (not the retry's
//      request body)
//   2. If the stored metadata is malformed (it shouldn't be — the write
//      path is strict — but defense in depth) we surface a 500 rather than
//      lying about the row
//   3. Anchors with a different credential_type that happen to share the
//      fingerprint (shouldn't happen post-org-scoping, but again defense
//      in depth) get rejected from the idempotent return path
function extractStoredContractMetadata(stored: unknown): {
  contract_metadata: z.infer<typeof ContractMetadataSchema>;
  signing_workflow_metadata: z.infer<typeof SigningWorkflowMetadataSchema>;
} | null {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
  const root = stored as Record<string, unknown>;
  const cm = ContractMetadataSchema.safeParse(root.contract_metadata);
  const sm = SigningWorkflowMetadataSchema.safeParse(root.signing_workflow_metadata);
  if (!cm.success || !sm.success) return null;
  return { contract_metadata: cm.data, signing_workflow_metadata: sm.data };
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

  const orgId = req.apiKey.orgId ?? null;

  // DPA Schedule 1 / clause 4.6 — org-scoped field rejection (migration 0405).
  // No-op for every org without a policy row. Runs on the RAW body and BEFORE
  // the idempotency lookup below: that lookup answers 200 with the stored
  // receipt for an already-anchored fingerprint, so enforcing after it would
  // let a prohibited field through on every retry — and a contract-signing
  // integration retries by construction.
  if (!(await enforceOrgFieldPolicy({
    orgId,
    body: req.body,
    res,
    scope: 'contracts-anchor-pre-signing',
  }))) {
    return;
  }

  try {
    // Idempotency lookup, scoped by:
    //   - fingerprint (same digest = same document)
    //   - org_id (CodeRabbit critical on PR #680: without this, Org B can
    //     probe whether Org A has anchored a document, AND would receive
    //     Org A's anchor receipt verbatim — a cross-tenant data leak)
    //   - credential_type='CONTRACT_PRESIGNING' (so a regular credential
    //     anchor with the same fingerprint doesn't accidentally satisfy
    //     a contract retry)
    //   - deleted_at IS NULL (deleted rows shouldn't satisfy retries)
    // The lookup also reads `metadata` so we can return what was actually
    // persisted, not the retry's body (CodeRabbit P1).
    let existingQuery = db
      .from('anchors')
      .select('public_id, fingerprint, status, created_at, metadata')
      .eq('fingerprint', fingerprint)
      .eq('credential_type', 'CONTRACT_PRESIGNING')
      .is('deleted_at', null);
    if (orgId) {
      existingQuery = existingQuery.eq('org_id', orgId);
    } else {
      // Anonymous-by-design API keys (no orgId) match only other rows
      // with NULL org_id so they can't see tenant-scoped anchors.
      existingQuery = existingQuery.is('org_id', null);
    }
    const { data: existing, error: lookupError } = await existingQuery.maybeSingle();
    if (lookupError) {
      // Fail-closed on idempotency lookup errors (CodeRabbit major on
      // PR #680). Without this, a transient DB failure would be treated
      // as a cache miss → credit deducts + insert attempted on a broken
      // lookup. Surface 503 so the caller retries against a healthy
      // backend rather than spending credits.
      logger.error(
        { error: lookupError, fingerprint: fingerprint.slice(0, 12) },
        'idempotency_lookup_failed',
      );
      res.status(503).json({ error: 'idempotency_lookup_unavailable' });
      return;
    }

    if (existing) {
      const stored = extractStoredContractMetadata(existing.metadata);
      if (!stored) {
        // Should be unreachable — write path validates with the same
        // schemas. But if a future migration corrupts a row, we surface
        // 500 rather than fabricating a receipt.
        logger.error(
          { publicId: existing.public_id, fingerprint: fingerprint.slice(0, 12) },
          'Idempotent hit but stored contract metadata failed Zod re-parse',
        );
        res.status(500).json({ error: 'stored_metadata_invalid' });
        return;
      }
      const receipt = buildReceipt(
        existing.public_id ?? '',
        existing.fingerprint,
        existing.created_at,
        stored,
      );
      res.status(200).json(receipt);
      return;
    }

    // Generate public_id (same ARK-{YEAR}-{8hex} convention as /api/v1/anchor)
    const shortId = randomUUID().slice(0, 8).toUpperCase();
    const publicId = `ARK-${new Date().getFullYear()}-${shortId}`;

    // ATOMICITY NOTE (updated for SCRUM-2970): the ordering is now
    // insert → deduction (reference_id = the new anchor row's id), with a
    // compensating hard-delete of the never-paid row when the deduction
    // fails. This is not transactional either — a crash between insert and
    // deduction leaves an unpaid PENDING row — but a retry then hits the
    // dedup lookup above and returns it without a charge, and the 0326
    // ledger keys the deduction to the row id so a re-run of the same
    // anchoring event cannot double-deduct.
    //
    // SCRUM-1667 — sub-org suspension guard, gated by
    // ENABLE_ORG_SUSPENSION_GUARD (default off). Mirrors anchor-submit.
    if (process.env.ENABLE_ORG_SUSPENSION_GUARD === 'true' && orgId) {
      const suspensionGuard = await ensureOrgNotSuspended(orgId);
      if (!suspensionGuard.ok) {
        const status = suspensionGuard.code === 'org_suspended' ? 403 : 503;
        res.status(status).json({
          error: suspensionGuard.code,
          message: suspensionGuard.message,
        });
        return;
      }
    }

    // Sanitize the derived filename (CodeRabbit major on PR #680). The
    // contract_metadata.title field is bounded by Zod (1..200 chars) but
    // could contain control characters that pass Zod's string check yet
    // fail anchors.filename's DB-level character constraints. Stripping
    // them here prevents an "insert fails AFTER credit deducts" path.
    const safeTitle = body.contract_metadata.title
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, ' ')
      .trim()
      .slice(0, 80);

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
      // `safeTitle` strips control characters (CodeRabbit major).
      filename: `contract-pre/${safeTitle || 'untitled'}`,
      credential_type: 'CONTRACT_PRESIGNING' as const,
      // `description` is intentionally NOT persisted (CodeRabbit major on
      // PR #680). The Zod schema accepts it for forward-compatibility, but
      // writing arbitrary prose into anchors.description would open a
      // free-text PII channel on a path that otherwise constrains callers
      // to structured contract metadata. The field is dropped silently on
      // write rather than rejected so SDKs that always set it for the
      // generic /api/v1/anchor endpoint don't break here.
      description: null,
      // contract_metadata + signing_workflow_metadata stored as nested keys
      // inside anchors.metadata (jsonb). The verification UI + SCRUM-1624
      // post-signing webhook receiver both read these by key.
      metadata: {
        contract_metadata: body.contract_metadata,
        signing_workflow_metadata: body.signing_workflow_metadata,
      },
    };

    // Defense-in-depth Zod validation of the constructed insert payload
    // (CodeRabbit major on PR #680). Catches future regressions where a
    // derived field (filename, public_id, metadata structure) silently
    // produces a DB-incompatible value AFTER credit deduction. Failure
    // here is a 500 (`insert_payload_invalid`) since the request itself
    // already passed PreSigningAnchorSchema — getting here means the
    // handler's own construction is wrong.
    const insertParse = InsertPayloadSchema.safeParse(insertPayload);
    if (!insertParse.success) {
      logger.error(
        {
          fingerprint: fingerprint.slice(0, 12),
          issues: insertParse.error.issues.map((i) => ({
            path: i.path.join('.'),
            code: i.code,
            message: i.message,
          })),
        },
        'insert_payload_invalid',
      );
      res.status(500).json({ error: 'insert_payload_invalid' });
      return;
    }

    const { data: anchor, error: insertError } = await db
      .from('anchors')
      .insert(insertParse.data)
      .select('id, public_id, fingerprint, status, created_at')
      .single();

    if (insertError) {
      logger.error(
        { error: insertError, fingerprint: fingerprint.slice(0, 12) },
        'Failed to create pre-signing contract anchor',
      );
      res.status(500).json({ error: 'Failed to create anchor record' });
      return;
    }

    // SCRUM-1170-B / SCRUM-2970 — org-credit deduction, insert-then-deduct.
    // Helper short-circuits to allowed=true when
    // ENABLE_ORG_CREDIT_ENFORCEMENT is off (default). Same shared helper as
    // /api/v1/anchor (SCRUM-1631 PR #680). The reference_id is the
    // just-inserted anchor row's id (repo pattern per
    // credential-sources.ts): a fresh uuid per anchoring event, so a
    // soft-delete + re-anchor is a NEW billable event, while an HTTP retry
    // of the same logical request is absorbed by the dedup lookup above.
    // On deduct failure (402/503 already written by the gate), compensate
    // by hard-deleting the never-paid row.
    if (orgId && !(await ensureAnchorCreditAvailable(db, orgId, res, anchor.id))) {
      const { error: compensationError } = await db.from('anchors').delete().eq('id', anchor.id);
      if (compensationError) {
        logger.error(
          { anchorId: anchor.id, orgId },
          'anchor_credit_compensation_delete_failed',
        );
      }
      return;
    }

    // Fresh-insert path: echo the request body's metadata since that's
    // exactly what was just persisted.
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
