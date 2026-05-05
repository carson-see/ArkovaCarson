/**
 * SCRUM-1632 [Spec] — POST /api/v1/contracts/anchor-post-signing
 *
 * GME10.5-B: post-signing contract anchor. Creates a signed-contract anchor
 * receipt AFTER the e-signature workflow completes, linked to the
 * pre-signing anchor (SCRUM-1623 / 1631) via `parent_anchor_id`.
 *
 * ## §1.6 reconciliation
 *
 * The pre-signing path (SCRUM-1631) accepts only the SHA-256 fingerprint
 * computed in the browser, because the document is still on the user's
 * device. The post-signing path is the reverse: by the time signing
 * completes, the signed PDF lives only at the e-sign provider's tenant.
 *
 * Two patterns are supported by this v1 shape:
 *   1. **Customer-forwarded** (this PR): the customer's own webhook
 *      receiver fetches the signed PDF from the provider, computes the
 *      SHA-256 server-side, and forwards `(fingerprint, validation_report)`
 *      to us. We never see the bytes.
 *   2. **Provider-fetch** (SCRUM-1633 [Implement]): we accept just the
 *      `external_envelope_id` and fetch from the provider on the
 *      customer's behalf using stored OAuth credentials, hash server-side,
 *      do not persist bytes. This requires per-org provider creds and is
 *      gated behind the `ENABLE_CONTRACT_PROVIDER_FETCH` flag.
 *
 * The [Spec] PR ships pattern 1 only — fingerprint is required. Pattern 2
 * is additive (fingerprint becomes optional when provider creds are wired,
 * not before). Both share the same response shape.
 *
 * ## Frozen v1 schema (CLAUDE.md §1.8)
 *
 * Once this endpoint shipped (SCRUM-1632 [Spec]), request + response
 * shapes are frozen. Additive nullable fields are allowed; renames /
 * removals require a v2 namespace and 12-month deprecation. The Zod
 * schemas below are `.strict()` so unknown fields fail validation
 * rather than silently dropping.
 *
 * ## Status
 *
 * STUB — handler returns 501 with `spec_only: true`. Real handler
 * arrives in SCRUM-1633 [Implement]. The Zod schemas + 25 red-baseline
 * tests pin the v1 contract so [Implement] is a swap-in body change,
 * not a re-design.
 *
 * ## Parent linkage strategy
 *
 * The post-signing anchor MUST have a parent pre-signing anchor. Two ways
 * the request can identify it:
 *   - Explicit `parent_public_id` — when the customer kept track of the
 *     pre-signing receipt's public_id and passes it back at sign-completion
 *   - Implicit `(provider, external_envelope_id)` lookup — when the customer
 *     identifies the contract by its e-sig provider envelope, matching the
 *     pre-signing anchor's `signing_workflow_metadata.external_envelope_id`
 *
 * Exactly one of those two paths must succeed. Failure modes:
 *   - 404 `parent_anchor_not_found` — neither lookup yields a row
 *   - 409 `parent_anchor_already_post_signed` — pre-signing anchor already
 *     has a CONTRACT_POSTSIGNING child (idempotency check in [Implement])
 *   - 422 `parent_credential_type_mismatch` — `parent_public_id` resolves
 *     to a non-CONTRACT_PRESIGNING anchor
 *
 * ## Validation-report shape
 *
 * Per parent SCRUM-1624 ("Post-signing anchor endpoint + validation
 * report"). The validation report captures the e-sig provider's audit
 * trail in a privacy-safe shape:
 *   - signers[]: each with opaque label, signed_at, signing_method,
 *     country_iso2 (geolocation reduced to country to avoid IP-level PII)
 *   - audit_trail_hash: provider's signed audit document SHA-256
 *   - completed_at: final-signature timestamp
 *   - envelope_status: 'completed' | 'declined' | 'voided'
 *   - provider_audit_certificate_url (optional): for evidence packaging
 *
 * Email addresses, IP addresses, browser fingerprints — explicitly NOT
 * accepted at v1 to keep the post-signing path PII-free. If a customer
 * needs richer audit data they can include it in a separate, opt-in
 * audit_trail extension under a different content key (NOT in scope for
 * v1).
 *
 * ## Migration
 *
 * No new migration needed. Migration 0285 (shipped via PR #679) already
 * added CONTRACT_POSTSIGNING to the credential_type enum + a partial
 * index `idx_anchors_parent_postsigning ON anchors(parent_anchor_id)
 * WHERE credential_type = 'CONTRACT_POSTSIGNING'` precisely for this
 * endpoint's idempotency-check + duplicate-prevention queries.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';

const router = Router();

// ─── Frozen v1 signer audit shape ─────────────────────────────────────────
//
// Each signer in the validation report is captured by the minimum needed
// for a proof package + verification UI: an opaque label (NEVER an email),
// the signed_at timestamp from the provider's audit trail, the signing
// method (categorical, not freeform), and country-level geolocation
// (NOT IP — IP would be PII at the precision level §1.6 forbids).
const SignerAuditSchema = z
  .object({
    // The doc above this schema says "an opaque label (NEVER an email)" — enforce
    // it. CodeRabbit on PR #698: a label that LOOKS like an email round-trips
    // PII through the audit trail just as effectively as a literal `email` field.
    label: z
      .string()
      .min(1)
      .max(120)
      .refine((v) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), {
        message: 'label must not be an email address (PII guard per §1.6)',
      }),
    signed_at: z.string().datetime({ offset: true }),
    signing_method: z.enum(['email', 'sso', 'id_verification', 'click_to_sign', 'other']),
    country_iso2: z
      .string()
      .regex(/^[A-Z]{2}$/, 'must be uppercase ISO 3166-1 alpha-2 country code')
      .optional(),
  })
  .strict();

// ─── Frozen v1 validation-report shape ────────────────────────────────────
//
// The validation report is the structured audit trail the verification UI
// + evidence-package builder need to render "what was signed, by whom,
// when, how." All fields are PII-stripped per §1.6.
const ValidationReportSchema = z
  .object({
    completed_at: z.string().datetime({ offset: true }),
    envelope_status: z.enum(['completed', 'declined', 'voided']),
    signers: z.array(SignerAuditSchema).min(1).max(20),
    audit_trail_hash: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/, 'must be a 64-character hex SHA-256 hash')
      .transform((s) => s.toLowerCase()),
    // CodeRabbit on PR #698: enforce https-only at the schema layer so an
    // attacker can't smuggle a plain-http reference into a signed audit trail.
    provider_audit_certificate_url: z
      .string()
      .url()
      .max(500)
      .refine((u) => u.startsWith('https://'), {
        message: 'provider_audit_certificate_url must use https://',
      })
      .optional(),
  })
  .strict();

// ─── Parent-lookup discriminator ──────────────────────────────────────────
//
// Exactly one of two paths must identify the pre-signing parent. Modeled
// as a discriminated union so Zod enforces the "exactly one" invariant at
// parse time rather than at handler time.
const ExplicitParentLookupSchema = z
  .object({
    parent_public_id: z.string().regex(/^ARK-\d{4}-[A-F0-9]{8}$/),
  })
  .strict();

const ImplicitParentLookupSchema = z
  .object({
    provider: z.enum(['docusign', 'adobe_sign', 'other']),
    external_envelope_id: z.string().min(1).max(200),
  })
  .strict();

// ─── Request shape ────────────────────────────────────────────────────────
export const PostSigningAnchorSchema = z
  .object({
    // SHA-256 of the fully-signed PDF, computed server-side by the customer's
    // webhook receiver (or by us in the SCRUM-1633 provider-fetch path).
    // Lowercased at parse time to keep idempotency keys consistent.
    fingerprint: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/, 'must be a 64-character hex SHA-256 hash')
      .transform((s) => s.toLowerCase()),
    credential_type: z.literal('CONTRACT_POSTSIGNING').default('CONTRACT_POSTSIGNING'),
    parent: z.union([ExplicitParentLookupSchema, ImplicitParentLookupSchema]),
    validation_report: ValidationReportSchema,
    description: z.string().max(1000).optional(),
  })
  .strict();

export type PostSigningAnchorRequest = z.infer<typeof PostSigningAnchorSchema>;

// ─── Response shape ───────────────────────────────────────────────────────
//
// Matches the pre-signing receipt shape so SDKs can reuse receipt-handling
// code, plus `parent_public_id` (always non-null on post-signing — this is
// the half that fills it in) and the echo'd `validation_report` for the
// integrator's local audit log.
export interface PostSigningAnchorReceipt {
  public_id: string;
  fingerprint: string;
  credential_type: 'CONTRACT_POSTSIGNING';
  status: 'PENDING';
  parent_public_id: string;
  validation_report: z.infer<typeof ValidationReportSchema>;
  created_at: string;
  record_uri: string;
}

// ─── Future-impl insert payload shape ─────────────────────────────────────
//
// Defense-in-depth schema for SCRUM-1633's insert-construction. Pinned
// here at [Spec] time so [Implement] can't accidentally widen the write
// surface. Failure here will be a 500 (`insert_payload_invalid`) since
// the user request was already validated by PostSigningAnchorSchema.
export const PostSigningInsertPayloadSchema = z
  .object({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    public_id: z.string().regex(/^ARK-\d{4}-[A-F0-9]{8}$/),
    status: z.literal('PENDING'),
    org_id: z.string().nullable(),
    user_id: z.string(),
    parent_anchor_id: z.string().uuid(),
    // contract-post-signing filename prefix mirrors contract-pre-signing's
    // pattern. NUL + control chars stripped at handler time.
    filename: z
      .string()
      .min(1)
      .max(120)
      // eslint-disable-next-line no-control-regex
      .regex(/^contract-post\/[^\x00-\x1f\x7f]*$/),
    credential_type: z.literal('CONTRACT_POSTSIGNING'),
    description: z.null(),
    metadata: z
      .object({
        validation_report: ValidationReportSchema,
        // Carry forward the lookup keys the customer used so verification UI
        // can render "anchor X is a sign-completion of envelope Y at provider Z."
        signing_workflow_metadata: z.object({
          provider: z.enum(['docusign', 'adobe_sign', 'other']),
          external_envelope_id: z.string().min(1).max(200),
        }).strict(),
      })
      .strict(),
  })
  .strict();

// ─── POST /api/v1/contracts/anchor-post-signing — STUB (SCRUM-1632) ───────
//
// Returns 501 on the success path. Auth gate, Zod validation, and shape
// pinning all run on every request so the [Spec] tests assert behavior
// the [Implement] (SCRUM-1633) handler will inherit.
router.post('/anchor-post-signing', async (req: Request, res: Response) => {
  if (!req.apiKey) {
    res.status(401).json({ error: 'API key required. Include X-API-Key header.' });
    return;
  }

  const parsed = PostSigningAnchorSchema.safeParse(req.body);
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

  // Spec-only: return 501 to advertise that the contract is locked but the
  // implementation is in-flight (SCRUM-1633). Once [Implement] swaps in,
  // this handler does:
  //   1. Resolve parent pre-signing anchor (explicit OR implicit lookup,
  //      org-scoped, credential_type='CONTRACT_PRESIGNING' filter)
  //   2. Idempotency check — does parent already have a CONTRACT_POSTSIGNING
  //      child? If yes, return existing receipt (200, not 201).
  //   3. Org-credit deduction (1 credit per post-signing anchor)
  //   4. Insert into anchors with credential_type=CONTRACT_POSTSIGNING,
  //      parent_anchor_id=<resolved>, metadata={validation_report, signing_workflow_metadata}
  //   5. Return PostSigningAnchorReceipt (201)
  res.status(501).json({
    error: 'not_implemented',
    spec_only: true,
    message: 'POST /api/v1/contracts/anchor-post-signing — [Spec] only (SCRUM-1632). Implementation in SCRUM-1633.',
  });
});

export { router as anchorPostSigningRouter };
