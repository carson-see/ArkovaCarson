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
import {
  ensureAnchorQuotaAvailable,
  writeQuotaCheckUnavailable,
  writeQuotaExhausted,
} from '../../utils/anchorQuotaGate.js';
import { ensureOrgNotSuspended } from '../../utils/orgSuspensionGuard.js';
import { enforceOrgFieldPolicy } from '../../utils/orgFieldPolicy.js';
import { submitJob } from '../../utils/jobQueue.js';
import { buildProfessionalEducationJobPayload } from '../../compliance/professional-education.js';
import {
  isProfessionalEducationSchemaReady,
  professionalEducationSchemaUnavailableBody,
} from '../../utils/professionalEducationSchemaGate.js';
import { config } from '../../config.js';
import { truncateUtf16Safe } from '../../utils/utf16-truncate.js';
import { denyOverQuota, setQuotaHeaders, type OrgTier } from '../../middleware/perOrgRateLimit.js';

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

const INSTANT_STATUSES = [
  'QUEUED', 'PROCESSING', 'NEEDS_CREDIT', 'RETRYABLE', 'HELD', 'SUBMITTED', 'FAILED',
] as const;
type InstantStatus = typeof INSTANT_STATUSES[number];
type CreditState = 'pending' | 'spent' | 'refunded' | null;

interface SubmissionStatus {
  public_id: string;
  action: 'queue' | 'instant';
  anchor_status: string;
  credit_state: CreditState;
  instant_status: InstantStatus | null;
  retryable: boolean;
  updated_at: string;
}

interface AtomicSubmissionResult {
  success?: boolean; error?: string; id?: string; public_id?: string | null;
  fingerprint?: string; status?: string; created_at?: string;
  credential_type?: string | null; metadata?: unknown;
  intent_id?: string | null;
  limit?: number; current?: number;
  quota_limit?: number | null; quota_current?: number | null;
}
function unwrapRpcResult(data: unknown): AtomicSubmissionResult {
  const value = Array.isArray(data) ? data[0] : data;
  return value && typeof value === 'object' ? value as AtomicSubmissionResult : {};
}

function creditStateForIntent(intent: { status: InstantStatus; debit_reason: string | null }): CreditState {
  if (intent.status === 'FAILED') return intent.debit_reason ? 'refunded' : 'pending';
  if (intent.status === 'PROCESSING' || intent.status === 'HELD' || intent.status === 'SUBMITTED') return 'spent';
  return 'pending';
}

function quotaTierForLimit(limit: number): OrgTier | null {
  if (limit === 100) return 'FREE';
  if (limit === 10_000) return 'PAID';
  if (limit === 1_000_000) return 'ENTERPRISE';
  return null;
}

function nextUtcQuotaReset(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

async function findCallerAnchor(
  fingerprint: string,
  userId: string,
  orgId: string | null,
) {
  let query = db.from('anchors')
    .select('id, public_id, fingerprint, status, created_at, updated_at, metadata')
    .eq('fingerprint', fingerprint)
    .eq('user_id', userId)
    .is('deleted_at', null);
  query = orgId ? query.eq('org_id', orgId) : query.is('org_id', null);
  return query.maybeSingle();
}

const compareTagsLexically = (a: string | null, b: string | null): number => {
  // Match Array.sort()'s historical string coercion for nullable generated rows,
  // while making the intended lexical order explicit for static analysis.
  const left = a === null ? 'null' : a;
  const right = b === null ? 'null' : b;
  return left < right ? -1 : left > right ? 1 : 0;
};

async function sendIdempotentReceipt(
  existing: { id: string; public_id: string | null; fingerprint: string; status: string; created_at: string; metadata?: unknown },
  body: AnchorSubmitRequest,
  userId: string,
  orgId: string | null,
  res: Response,
): Promise<void> {
  if (body.private_tags) {
    const { data: storedTags, error: storedTagsError } = await db.from('anchor_private_tags')
      .select('scope, normalized_tag')
      .eq('anchor_id', existing.id)
      .eq('owner_user_id', userId);
    if (storedTagsError) {
      res.status(503).json({ error: 'submission_metadata_unavailable' });
      return;
    }
    const requested = {
      user: [...new Set(body.private_tags.user.map((tag) => tag.trim().toLocaleLowerCase()))].sort(compareTagsLexically),
      organization: [...new Set(body.private_tags.organization.map((tag) => tag.trim().toLocaleLowerCase()))].sort(compareTagsLexically),
    };
    const stored = {
      user: (storedTags ?? []).filter((tag) => tag.scope === 'user').map((tag) => tag.normalized_tag).sort(compareTagsLexically),
      organization: (storedTags ?? []).filter((tag) => tag.scope === 'organization').map((tag) => tag.normalized_tag).sort(compareTagsLexically),
    };
    if (requested.user.join('\0') !== stored.user.join('\0')
      || requested.organization.join('\0') !== stored.organization.join('\0')) {
      res.status(409).json({
        error: 'submission_metadata_conflict',
        message: 'Private tags differ from the existing submission.',
      });
      return;
    }
  }
  let instantStatus: InstantStatus | null = null;
  if (body.action === 'instant' && existing.status === 'PENDING') {
    if (process.env.ENABLE_ORG_SUSPENSION_GUARD === 'true' && orgId) {
      const suspensionGuard = await ensureOrgNotSuspended(orgId);
      if (!suspensionGuard.ok) {
        res.status(suspensionGuard.code === 'org_suspended' ? 403 : 503)
          .json({ error: suspensionGuard.code, message: suspensionGuard.message });
        return;
      }
    }
    const retryResult = await db.rpc('retry_anchor_instant_intent' as never, {
      p_anchor_id: existing.id, p_user_id: userId, p_org_id: orgId,
    } as never);
    let intent = unwrapRpcResult(retryResult.data);
    if (retryResult.error) { res.status(503).json({ error: 'instant_intent_unavailable' }); return; }
    if (!intent.success && intent.error === 'intent_not_found') {
      const initialResult = await db.rpc('enqueue_existing_anchor_instant_intent' as never, {
        p_anchor_id: existing.id, p_user_id: userId, p_org_id: orgId,
        p_user_tags: body.private_tags?.user ?? [], p_org_tags: body.private_tags?.organization ?? [],
      } as never);
      intent = unwrapRpcResult(initialResult.data);
      if (initialResult.error) { res.status(503).json({ error: 'instant_intent_unavailable' }); return; }
    }
    if (!intent.success) { res.status(503).json({ error: 'instant_intent_unavailable' }); return; }
    instantStatus = INSTANT_STATUSES.includes(intent.status as InstantStatus)
      ? intent.status as InstantStatus
      : 'QUEUED';
  }
  const { data: storedIntent, error: storedIntentError } = await db.from('anchor_instant_intents')
    .select('status, debit_reason')
    .eq('anchor_id', existing.id)
    .maybeSingle();
  if (storedIntentError) {
    res.status(503).json({ error: 'submission_status_unavailable' });
    return;
  }
  const authoritativeIntent = storedIntent && INSTANT_STATUSES.includes(storedIntent.status as InstantStatus)
    ? storedIntent as { status: InstantStatus; debit_reason: string | null }
    : null;
  instantStatus = authoritativeIntent?.status ?? instantStatus;
  const storedPath = (existing.metadata as Record<string, unknown> | null)?.securing_path;
  const action = authoritativeIntent || instantStatus || storedPath === 'instant' ? 'instant' as const : 'queue' as const;
  const publicId = existing.public_id ?? '';
  res.status(200).json({
    public_id: publicId,
    fingerprint: existing.fingerprint,
    status: existing.status as AnchorReceipt['status'],
    created_at: existing.created_at,
    record_uri: buildVerifyUrl(publicId),
    action,
    credit_state: authoritativeIntent ? creditStateForIntent(authoritativeIntent) : instantStatus ? 'pending' : null,
    instant_status: instantStatus,
    idempotent: true,
  } satisfies AnchorReceipt);
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
    const { data: existing } = await findCallerAnchor(fingerprint, req.apiKey.userId, scopedOrgId);

    if (existing) {
      await sendIdempotentReceipt(existing, body, req.apiKey.userId, scopedOrgId, res);
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

    // SCRUM-1740 — contractual anchor quota gate. An explicit enforced cap
    // returns 402 at the limit; a config or usage read fault returns retryable
    // 503 rather than bypassing the cap. Re-submissions of an existing fingerprint
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
    const inserted = await db.rpc('create_anchor_submission' as never, {
      p_fingerprint: fingerprint, p_public_id: publicId, p_user_id: req.apiKey.userId, p_org_id: orgId,
      p_filename: body.filename ?? `api-${truncateUtf16Safe(fingerprint, 12)}`,
      p_file_size: body.file_size ?? null, p_file_mime: body.file_mime ?? null,
      p_credential_type: credentialType, p_description: body.description ?? null, p_metadata: metadata,
      p_fingerprint_source: req.apiKey.keyPrefix === 'jwt-session' ? 'document_bytes' : null,
      p_user_tags: body.private_tags?.user ?? [], p_org_tags: body.private_tags?.organization ?? [],
      p_action: body.action,
    } as never);
    const insertError = inserted.error;
    const anchor = unwrapRpcResult(inserted.data);
    if (insertError || !anchor.success) {
      // Another identical request can win between the read above and this
      // insert. Resolve that race to the same idempotent receipt rather than
      // making a safe retry look like a conflict.
      const { data: racedExisting } = await findCallerAnchor(fingerprint, req.apiKey.userId, scopedOrgId);
      if (racedExisting) {
        await sendIdempotentReceipt(racedExisting, body, req.apiKey.userId, scopedOrgId, res);
        return;
      }
      if (!insertError && anchor.error === 'quota_exceeded') {
        const tier = typeof anchor.limit === 'number' ? quotaTierForLimit(anchor.limit) : null;
        if (!tier || typeof anchor.limit !== 'number' || typeof anchor.current !== 'number') {
          res.status(503).json({ error: { code: 'quota_check_failed', message: 'Quota service unavailable' } });
          return;
        }
        const resetAt = nextUtcQuotaReset();
        const retryAfter = Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000));
        denyOverQuota({
          res, tier, kind: 'anchors_created', mode: 'daily',
          decision: { limit: anchor.limit, remaining: 0 },
          currentCount: anchor.current + 1,
          resetValue: resetAt.toISOString(), retryAfter,
          resetEpochSeconds: Math.floor(resetAt.getTime() / 1000),
        });
        return;
      }
      if (!insertError && anchor.error === 'contractual_quota_exceeded') {
        if (typeof anchor.limit !== 'number' || typeof anchor.current !== 'number') {
          writeQuotaCheckUnavailable(res);
          return;
        }
        writeQuotaExhausted(res, anchor.current, anchor.limit);
        return;
      }
      if (!insertError && anchor.error === 'organization_unavailable') {
        res.status(503).json({ error: 'organization_unavailable' });
        return;
      }
      if (!insertError && anchor.error === 'duplicate') {
        res.status(409).json({
          error: 'fingerprint_conflict',
          message: 'This fingerprint already exists in another scope for this API-key actor.',
        });
        return;
      }
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
      idempotent: false,
    };

    if (typeof anchor.quota_limit === 'number' && typeof anchor.quota_current === 'number') {
      setQuotaHeaders(res, 'anchors_created', {
        limit: anchor.quota_limit,
        remaining: Math.max(anchor.quota_limit - anchor.quota_current, 0),
      }, nextUtcQuotaReset().toISOString());
    }

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

router.get('/:publicId/submission-status', async (req: Request, res: Response) => {
  if (!req.apiKey) {
    res.status(401).json({ error: 'authentication_required' });
    return;
  }
  const publicId = z.string().trim().min(1).max(128).safeParse(req.params.publicId);
  if (!publicId.success) {
    res.status(400).json({ error: 'invalid_public_id' });
    return;
  }
  const orgId = req.apiKey.orgId?.trim() || null;
  try {
    let anchorQuery = db.from('anchors')
      .select('id, public_id, status, updated_at, metadata')
      .eq('public_id', publicId.data)
      .eq('user_id', req.apiKey.userId)
      .is('deleted_at', null);
    anchorQuery = orgId ? anchorQuery.eq('org_id', orgId) : anchorQuery.is('org_id', null);
    const { data: anchor, error: anchorError } = await anchorQuery.maybeSingle();
    if (anchorError) {
      res.status(503).json({ error: 'submission_status_unavailable' });
      return;
    }
    if (!anchor) {
      res.status(404).json({ error: 'submission_not_found' });
      return;
    }
    const { data: rawIntent, error: intentError } = await db.from('anchor_instant_intents')
      .select('status, debit_reason, updated_at')
      .eq('anchor_id', anchor.id)
      .maybeSingle();
    if (intentError) {
      res.status(503).json({ error: 'submission_status_unavailable' });
      return;
    }
    if (rawIntent && !INSTANT_STATUSES.includes(rawIntent.status as InstantStatus)) {
      res.status(503).json({ error: 'submission_status_unavailable' });
      return;
    }
    const intent = rawIntent as { status: InstantStatus; debit_reason: string | null; updated_at: string } | null;
    const action = intent || (anchor.metadata as Record<string, unknown> | null)?.securing_path === 'instant'
      ? 'instant' as const
      : 'queue' as const;
    const response: SubmissionStatus = {
      public_id: anchor.public_id ?? publicId.data,
      action,
      anchor_status: anchor.status,
      credit_state: intent ? creditStateForIntent(intent) : null,
      instant_status: intent?.status ?? null,
      retryable: intent?.status === 'NEEDS_CREDIT' && intent.debit_reason === null && anchor.status === 'PENDING',
      updated_at: intent?.updated_at ?? anchor.updated_at,
    };
    res.json(response);
  } catch (error) {
    logger.error({ error, publicId: publicId.data }, 'Submission status lookup failed');
    res.status(503).json({ error: 'submission_status_unavailable' });
  }
});

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
