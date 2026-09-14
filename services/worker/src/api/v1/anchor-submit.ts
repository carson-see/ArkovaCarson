/**
 * POST /api/v1/anchor (Agent SDK endpoint)
 *
 * Submits a fingerprint for anchoring. Returns a receipt with the public_id
 * that can be used for later verification.
 *
 * Requires API key authentication (X-API-Key header).
 * Constitution 1.6: Documents never leave the user's device — only fingerprints are accepted.
 */

import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { buildVerifyUrl } from '../../lib/urls.js';
import {
  ANCHOR_CREDENTIAL_TYPES,
  hasPublicCredentialEvidenceMetadataKeys,
  parsePublicCredentialEvidenceMetadataResult,
  PUBLIC_CREDENTIAL_EVIDENCE_METADATA_KEYS,
  stripClientUnassertableEvidenceClaims,
} from '../../lib/credential-evidence.js';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { ensureAnchorQuotaAvailable } from '../../utils/anchorQuotaGate.js';
import { ensureOrgNotSuspended } from '../../utils/orgSuspensionGuard.js';
import { enforceOrgFieldPolicy } from '../../utils/orgFieldPolicy.js';
import { requireOrgQuota } from '../../middleware/perOrgRateLimit.js';
import { submitJob } from '../../utils/jobQueue.js';
import { buildProfessionalEducationJobPayload } from '../../compliance/professional-education.js';
import {
  isProfessionalEducationSchemaReady,
  professionalEducationSchemaUnavailableBody,
} from '../../utils/professionalEducationSchemaGate.js';
import { config } from '../../config.js';
import { truncateUtf16Safe } from '../../utils/utf16-truncate.js';

const router = Router();

// Frozen request shape per CLAUDE.md §1.8 — additive nullable fields only.
// Fingerprint must be 64-char hex (SHA-256). Description capped to keep
// inserts predictable and PostgREST payload size bounded. Metadata key syntax
// is bounded here; only recognized public evidence keys are persisted below.
const SAFE_METADATA_KEY = /^[a-zA-Z0-9_.-]+$/;
export const AnchorSubmitSchema = z.object({
  fingerprint: z.string().regex(/^[a-fA-F0-9]{64}$/, 'must be a 64-character hex SHA-256 hash'),
  credential_type: z.enum(ANCHOR_CREDENTIAL_TYPES).optional(),
  description: z.string().max(1000).optional(),
  filename: z.string().trim().min(1).max(255).optional(),
  file_size: z.number().int().positive().optional(),
  file_mime: z.string().trim().max(255).optional(),
  action: z.enum(['queue', 'instant']).optional().default('queue'),
  private_tags: z.object({
    user: z.array(z.string().trim().min(1).max(64)).max(10).optional().default([]),
    organization: z.array(z.string().trim().min(1).max(64)).max(10).optional().default([]),
  }).strict().superRefine((tags, ctx) => {
    for (const [scope, values] of Object.entries(tags)) {
      const normalized = values.map((value) => value.toLocaleLowerCase());
      if (new Set(normalized).size !== normalized.length) ctx.addIssue({ code: 'custom', path: [scope], message: 'tags must be unique ignoring case' });
    }
  }).optional(),
  metadata: z.record(z.string().regex(SAFE_METADATA_KEY, 'metadata keys must match [a-zA-Z0-9_.-]+'), z.unknown()).optional(),
}).strict();

type AnchorSubmitRequest = z.infer<typeof AnchorSubmitSchema>;

interface AnchorReceipt {
  public_id: string;
  fingerprint: string;
  status: 'PENDING';
  created_at: string;
  record_uri: string;
  action: 'queue' | 'instant';
  credit_state: 'pending' | 'spent' | 'refunded' | null;
  instant_status?: string | null;
  idempotent?: boolean;
}

interface AtomicSubmissionResult {
  success?: boolean; error?: string; id?: string; public_id?: string | null;
  fingerprint?: string; status?: string; created_at?: string;
  credential_type?: string | null; metadata?: unknown;
  intent_id?: string | null;
}
function unwrapRpcResult(data: unknown): AtomicSubmissionResult {
  const value = Array.isArray(data) ? data[0] : data;
  return value && typeof value === 'object' ? value as AtomicSubmissionResult : {};
}

const DASHBOARD_PRIVATE_METADATA_KEYS = new Set([
  'recipient', 'email', 'phone', 'phone_number', 'ssn', 'social_security',
  'student_id', 'student_number', 'address', 'street_address', 'home_address',
  'mailing_address', 'dob', 'date_of_birth', 'birthday', 'national_id',
  'passport_number', 'drivers_license', 'private_tags', 'user_tags', 'org_tags',
]);

/** Preserve the dashboard's existing PII-stripped extraction/fraud metadata. */
function dashboardMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!metadata) return {};
  return Object.fromEntries(Object.entries(metadata).filter(([key]) =>
    !key.startsWith('_')
    && !DASHBOARD_PRIVATE_METADATA_KEYS.has(key.toLowerCase())
    && !PUBLIC_CREDENTIAL_EVIDENCE_METADATA_KEYS.has(key)
  ));
}

async function consumeAnchorCreateQuota(
  req: Request,
  res: Response,
  delta: number,
): Promise<boolean> {
  const quota = requireOrgQuota({
    kind: 'anchors_created',
    mode: 'daily',
    getOrgId: (quotaReq) => quotaReq.apiKey?.orgId ?? null,
    getDelta: () => delta,
  });
  let allowed = false;
  await quota(req, res, () => {
    allowed = true;
  });
  return allowed;
}

async function handleAnchorSubmit(req: Request, res: Response) {
  // Require API key
  if (!req.apiKey) {
    res.status(401).json({ error: 'API key required. Include X-API-Key header.' });
    return;
  }

  // Zod validation per CLAUDE.md §1.2 ("Validation: Zod. Every write path.")
  // Returns RFC 7807-style problem+JSON on validation failure so client
  // integrations can surface field-level errors to their users.
  const parsed = AnchorSubmitSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'invalid_request',
      message: 'Request body failed validation',
      details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code, message: i.message })),
    });
    return;
  }
  const body: AnchorSubmitRequest = parsed.data;
  const scopedOrgId = req.apiKey.orgId?.trim() || null;
  if (body.action === 'instant' && !config.enableInstantSecure) {
    res.status(503).json({ error: 'instant_secure_unavailable', message: 'Instant securing is temporarily unavailable. Add this document to the queue instead.' });
    return;
  }
  if ((body.private_tags?.organization.length ?? 0) > 0 && !scopedOrgId) {
    res.status(400).json({ error: 'organization_required', message: 'Organization tags require an organization.' });
    return;
  }

  // DPA Schedule 1 / clause 4.6 — org-scoped field rejection (migration 0405).
  // No-op for every org without a policy row. Runs on the RAW body (so a field
  // nested in `metadata` cannot slip past) and BEFORE the duplicate lookup:
  // that lookup answers 200 for an existing fingerprint, which would otherwise
  // let a prohibited field through on any re-submission.
  if (!(await enforceOrgFieldPolicy({
    orgId: scopedOrgId,
    body: req.body,
    res,
    scope: 'anchor-submit',
  }))) {
    return;
  }

  if (body.credential_type === 'CPE' && !isProfessionalEducationSchemaReady()) {
    res.status(503).json(professionalEducationSchemaUnavailableBody('anchor-submit:cpe'));
    return;
  }

  const fingerprint = body.fingerprint.toLowerCase();
  const parsedCredentialEvidenceMetadata = parsePublicCredentialEvidenceMetadataResult(body.metadata);
  // SCRUM-2481 — server-side evidence-level trust enforcement. A client may
  // describe where a credential came from, but it may not assert that the
  // ISSUER authenticated it: `issuer_anchored` / `source_signed` are the only
  // levels that render the green issuer-authenticated badge on the public
  // verification page, and no code path in this platform can prove either.
  // Drop the claim (the anchor is still created) and log the attempt.
  const clientAssertableCredentialEvidenceMetadata = parsedCredentialEvidenceMetadata.ok
    ? stripClientUnassertableEvidenceClaims(parsedCredentialEvidenceMetadata.metadata)
    : null;
  if (clientAssertableCredentialEvidenceMetadata?.stripped.length) {
    logger.warn(
      {
        orgId: scopedOrgId ?? undefined,
        keyId: req.apiKey.keyId,
        stripped: clientAssertableCredentialEvidenceMetadata.stripped,
        attemptedVerificationLevel: parsedCredentialEvidenceMetadata.ok
          ? parsedCredentialEvidenceMetadata.metadata.verification_level
          : null,
      },
      'Dropped client-asserted issuer-authenticated evidence level on anchor submit',
    );
  }
  const publicSafeCredentialEvidenceMetadata =
    clientAssertableCredentialEvidenceMetadata &&
    Object.keys(clientAssertableCredentialEvidenceMetadata.metadata).length > 0
      ? clientAssertableCredentialEvidenceMetadata.metadata
      : null;
  if (body.metadata && hasPublicCredentialEvidenceMetadataKeys(body.metadata) && !parsedCredentialEvidenceMetadata.ok) {
    logger.warn(
      {
        metadataKeys: Object.keys(body.metadata).sort((a, b) => a.localeCompare(b)),
        reason: parsedCredentialEvidenceMetadata.reason,
        issues: parsedCredentialEvidenceMetadata.issues,
      },
      'Rejected invalid credential evidence metadata on anchor submit',
    );
    const credentialEvidenceDetails = parsedCredentialEvidenceMetadata.issues?.map((issue) => ({
      path: issue.path ? `metadata.${issue.path}` : 'metadata',
      code: issue.code,
      message: issue.message,
    })) ?? [
      {
        path: 'metadata',
        code: 'invalid_credential_evidence_metadata',
        message: 'Credential evidence metadata is invalid or not public-safe',
      },
    ];
    res.status(400).json({
      error: 'invalid_request',
      message: 'Request body failed validation',
      details: credentialEvidenceDetails,
    });
    return;
  }

  try {
    // Check for duplicate fingerprint (idempotent — return existing if already anchored)
    let existingQuery = db.from('anchors')
      .select('id, public_id, fingerprint, status, created_at')
      .eq('fingerprint', fingerprint)
      .eq('user_id', req.apiKey.userId)
      .is('deleted_at', null);
    existingQuery = scopedOrgId ? existingQuery.eq('org_id', scopedOrgId) : existingQuery.is('org_id', null);
    const { data: existing } = await existingQuery.maybeSingle();

    if (existing) {
      let instantStatus: string | null = null;
      if (body.action === 'instant' && existing.status === 'PENDING') {
        if (process.env.ENABLE_ORG_SUSPENSION_GUARD === 'true' && scopedOrgId) {
          const suspensionGuard = await ensureOrgNotSuspended(scopedOrgId);
          if (!suspensionGuard.ok) {
            const status = suspensionGuard.code === 'org_suspended' ? 403 : 503;
            res.status(status).json({ error: suspensionGuard.code, message: suspensionGuard.message });
            return;
          }
        }
        const retryResult = await db.rpc('retry_anchor_instant_intent' as never, {
          p_anchor_id: existing.id, p_user_id: req.apiKey.userId, p_org_id: scopedOrgId,
        } as never);
        let intent = unwrapRpcResult(retryResult.data);
        if (retryResult.error) { res.status(503).json({ error: 'instant_intent_unavailable' }); return; }
        if (!intent.success && intent.error === 'intent_not_found') {
          const initialResult = await db.rpc('enqueue_existing_anchor_instant_intent' as never, {
            p_anchor_id: existing.id, p_user_id: req.apiKey.userId, p_org_id: scopedOrgId,
            p_user_tags: body.private_tags?.user ?? [], p_org_tags: body.private_tags?.organization ?? [],
          } as never);
          intent = unwrapRpcResult(initialResult.data);
          if (initialResult.error) { res.status(503).json({ error: 'instant_intent_unavailable' }); return; }
        }
        if (!intent.success) { res.status(503).json({ error: 'instant_intent_unavailable' }); return; }
        instantStatus = intent.status ?? 'QUEUED';
      }
      const existingPublicId = existing.public_id ?? '';
      const receipt: AnchorReceipt = {
        public_id: existingPublicId, fingerprint: existing.fingerprint,
        status: existing.status as AnchorReceipt['status'], created_at: existing.created_at,
        record_uri: buildVerifyUrl(existingPublicId), action: body.action, credit_state: null,
        instant_status: instantStatus, idempotent: true,
      };
      res.status(200).json(receipt);
      return;
    }

    if (!(await consumeAnchorCreateQuota(req, res, 1))) {
      return;
    }

    // Generate public_id
    const shortId = randomUUID().slice(0, 8).toUpperCase();
    const publicId = `ARK-${new Date().getFullYear()}-${shortId}`;

    // Get org_id from API key
    const orgId = scopedOrgId;

    // SCRUM-1667 — sub-org suspension guard, gated by
    // ENABLE_ORG_SUSPENSION_GUARD (default off). Off → no-op so existing
    // contract tests don't need to mock the is_org_suspended RPC. On →
    // 403 fail-closed when the parent admin has suspended this sub-org
    // via suspend_suborg (mig 0289). Read paths intentionally skip this
    // check; suspended orgs retain read access to existing evidence per
    // PRD 6 ORG-08. Same default-off rollout pattern as the credit gate.
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

    // SCRUM-1740 — sandbox anchor quota gate. No-op for prod orgs
    // (anchor_quota is NULL). Sandbox orgs with is_test=true and a
    // configured cap get a 402 quota_exhausted problem+json response when
    // they hit their limit. Re-submissions of an existing fingerprint
    // already short-circuited at the dedup-check above, so partners can
    // re-anchor without consuming quota.
    if (orgId && !(await ensureAnchorQuotaAvailable(db, orgId, res))) {
      return;
    }

    // The RPC commits anchor + private tags + optional instant intent/job as one unit.
    const credentialType = body.credential_type ?? 'OTHER';
    const metadata = {
      ...(req.apiKey.keyPrefix === 'jwt-session' ? dashboardMetadata(body.metadata) : {}),
      ...(publicSafeCredentialEvidenceMetadata ?? {}),
      securing_path: body.action,
    };
    let anchor: AtomicSubmissionResult;
    let insertError: unknown = null;
    if (body.action === 'queue' && !body.private_tags) {
      const inserted = await db.from('anchors').insert({
        fingerprint, public_id: publicId, status: 'PENDING' as const, org_id: orgId,
        user_id: req.apiKey.userId, filename: body.filename ?? `api-${truncateUtf16Safe(fingerprint, 12)}`,
        file_size: body.file_size ?? null, file_mime: body.file_mime ?? null,
        credential_type: credentialType, description: body.description ?? null, metadata,
        fingerprint_source: req.apiKey.keyPrefix === 'jwt-session' ? 'document_bytes' : null,
      }).select('id, public_id, fingerprint, status, created_at, credential_type, metadata').single();
      insertError = inserted.error;
      anchor = inserted.data ? { ...inserted.data, success: true } : {};
    } else {
      const inserted = await db.rpc('create_anchor_submission' as never, {
        p_fingerprint: fingerprint, p_public_id: publicId, p_user_id: req.apiKey.userId, p_org_id: orgId,
        p_filename: body.filename ?? `api-${truncateUtf16Safe(fingerprint, 12)}`,
        p_file_size: body.file_size ?? null, p_file_mime: body.file_mime ?? null,
        p_credential_type: credentialType, p_description: body.description ?? null, p_metadata: metadata,
        p_fingerprint_source: req.apiKey.keyPrefix === 'jwt-session' ? 'document_bytes' : null,
        p_user_tags: body.private_tags?.user ?? [], p_org_tags: body.private_tags?.organization ?? [],
        p_action: body.action,
      } as never);
      insertError = inserted.error;
      anchor = unwrapRpcResult(inserted.data);
    }
    if (insertError || !anchor.success) {
      handleInsertError(insertError ?? { code: anchor.error === 'duplicate' ? '23505' : undefined }, orgId, res);
      return;
    }

    const receipt: AnchorReceipt = {
      public_id: anchor.public_id ?? publicId,
      fingerprint: anchor.fingerprint ?? fingerprint,
      status: (anchor.status ?? 'PENDING') as AnchorReceipt['status'],
      created_at: anchor.created_at ?? new Date().toISOString(),
      record_uri: buildVerifyUrl(anchor.public_id ?? publicId),
      action: body.action,
      credit_state: body.action === 'instant' ? 'pending' : null,
      instant_status: body.action === 'instant' ? 'QUEUED' : null,
    };

    logger.info({ publicId }, 'Anchor submitted via API');
    enqueueProfessionalEducationExtraction({
      id: anchor.id ?? undefined,
      public_id: anchor.public_id ?? publicId,
      fingerprint: anchor.fingerprint ?? fingerprint,
      credential_type: anchor.credential_type ?? credentialType,
      org_id: orgId,
      user_id: req.apiKey.userId,
      metadata: (anchor.metadata as Record<string, unknown> | null | undefined) ?? publicSafeCredentialEvidenceMetadata,
    });
    res.status(201).json(receipt);
  } catch (error) {
    logger.error({ error }, 'Anchor submission failed');
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/v1/anchor
 *
 * Submit a fingerprint for blockchain anchoring.
 * The fingerprint must be a 64-character hex SHA-256 hash.
 */
router.post('/', handleAnchorSubmit);
router.post('/submit', handleAnchorSubmit);

/**
 * Handle Supabase insert errors for anchor creation.
 *
 * Logs the Postgres error class server-side for debugging but never exposes
 * schema internals such as constraint names to logs or API clients.
 */
function handleInsertError(
  insertError: unknown,
  orgId: string | null,
  res: Response,
): void {
  const pgCode = (insertError as { code?: string }).code ?? null;
  logger.error({ pgCode, orgId }, 'Failed to create anchor');
  if (pgCode === '23505') {
    res.status(409).json({
      error: 'anchor_creation_conflict',
      message: 'A conflicting anchor record already exists. Retry the request.',
    });
    return;
  }
  res.status(500).json({
    error: 'anchor_creation_failed',
    message: 'Failed to create anchor record. Contact support if this persists.',
  });
}

function enqueueProfessionalEducationExtraction(anchor: {
  id?: string;
  public_id: string | null;
  fingerprint: string | null;
  credential_type: string | null;
  org_id: string | null;
  user_id: string | null;
  metadata: Record<string, unknown> | null;
}): void {
  if (!anchor.id) return;
  if (!isProfessionalEducationSchemaReady()) return;

  const payload = buildProfessionalEducationJobPayload({ ...anchor, id: anchor.id });
  if (!payload) return;

  void submitJob({
    type: 'professional_education.metadata_extraction',
    payload,
    priority: 25,
    max_attempts: 5,
  }).catch((error: unknown) => {
    logger.warn({ error, anchorId: anchor.id }, 'Failed to enqueue professional education extraction job');
  });
}

export { router as anchorSubmitRouter };
