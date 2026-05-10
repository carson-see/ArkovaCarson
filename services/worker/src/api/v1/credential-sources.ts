import { randomUUID } from 'node:crypto';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { buildVerifyUrl } from '../../lib/urls.js';
import { ANCHOR_CREDENTIAL_TYPES } from '../../lib/credential-evidence.js';
import {
  CredentialSourceImportError,
  CredentialSourceImportRequestSchema,
  buildCredentialSourceImportPreview,
  buildSelfImportRecipientHash,
  buildSourceImportFilename,
  evidenceDateToTimestamp,
  type CredentialSourceImportPreview,
} from '../../lib/credential-source-import.js';
import { dispatchWebhookEvent, isPrivateUrlResolved } from '../../webhooks/delivery.js';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { deductOrgCredit, type DeductionResult } from '../../utils/orgCredits.js';

const router = Router();
const MAX_PUBLIC_ID_INSERT_ATTEMPTS = 5;

const anchorRecipientSchema = z.object({
  anchor_id: z.string().min(1),
  recipient_email_hash: z.string().min(1),
  recipient_user_id: z.string().min(1),
});

const auditEventSchema = z.object({
  event_type: z.literal('CREDENTIAL_SOURCE_IMPORTED'),
  event_category: z.literal('ANCHOR'),
  actor_id: z.string().min(1),
  org_id: z.string().min(1).nullable(),
  target_type: z.literal('anchor'),
  target_id: z.string().min(1),
  details: z.string().min(1),
});

const publicMetadataSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

const anchorSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  public_id: z.string().regex(/^ARK-\d{4}-[A-F0-9]{8}$/),
  status: z.literal('PENDING'),
  org_id: z.string().min(1).nullable(),
  user_id: z.string().min(1),
  filename: z.string().min(1),
  file_size: z.number().int().nonnegative(),
  file_mime: z.string().min(1),
  credential_type: z.enum(ANCHOR_CREDENTIAL_TYPES),
  label: z.string().min(1),
  description: z.string().min(1),
  issued_at: z.string().nullable(),
  expires_at: z.string().nullable(),
  metadata: publicMetadataSchema,
});

const softDeleteUpdateSchema = z.object({
  deleted_at: z.literal('now'),
});

const orgCreditRefundRpcResultSchema = z.object({
  success: z.literal(true),
  balance: z.number().int().nonnegative().optional(),
  refunded: z.number().int().positive().optional(),
});

interface AnchorReceipt {
  public_id: string;
  fingerprint: string;
  status: string;
  created_at: string;
  record_uri: string;
}

interface DbErrorLike {
  code?: string;
  message?: string;
}

interface AnchorRecord {
  id: string;
  public_id: string | null;
  fingerprint: string;
  status: string;
  created_at: string;
}

interface AnchorCreateResult {
  anchor: AnchorRecord | null;
  error: DbErrorLike | null;
  duplicate?: AnchorRecord;
}

interface ImportCreditGateResult {
  ok: boolean;
  deducted: boolean;
}

interface ImportCompensationOptions {
  anchorId: string;
  userId: string;
  orgId: string | null;
  creditDeducted: boolean;
  recipientLinked: boolean;
}

type AnchorInsertPayload = z.infer<typeof anchorSchema>;

function credentialSourceErrorStatus(error: CredentialSourceImportError): number {
  return error.status;
}

function sendCredentialSourceError(res: Response, error: CredentialSourceImportError): void {
  res.status(credentialSourceErrorStatus(error)).json({
    error: error.code,
    message: error.message,
  });
}

async function buildPreviewFromRequest(req: Request, res: Response) {
  const parsed = CredentialSourceImportRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'invalid_request',
      message: 'Request body failed validation',
      details: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
        message: issue.message,
      })),
    });
    return null;
  }

  return {
    input: parsed.data,
    result: await buildCredentialSourceImportPreview(parsed.data, {
      fetchFn: globalThis.fetch,
      urlGuard: isPrivateUrlResolved,
    }),
  };
}

async function loadUserOrgId(userId: string): Promise<string | null> {
  const { data, error } = await db.from('profiles').select('org_id').eq('id', userId).single();
  if (error) throw error;
  return data?.org_id ?? null;
}

function isUniqueViolation(error: DbErrorLike | null | undefined): boolean {
  return error?.code === '23505';
}

function sourceHostFromUrl(sourceUrl: string): string | null {
  try {
    return new URL(sourceUrl).hostname;
  } catch {
    return null;
  }
}

function buildAuditDetails(preview: CredentialSourceImportPreview): Record<string, string | null> {
  return {
    source_provider: preview.source_provider,
    source_host: sourceHostFromUrl(preview.normalized_source_url),
    evidence_package_hash: preview.evidence_package_hash,
    source_payload_hash: preview.source_payload_hash,
    verification_level: preview.verification_level,
  };
}

function sendSourceChanged(res: Response, expectedHash: string, actualHash: string): void {
  res.status(409).json({
    error: 'source_changed',
    message: 'Credential source changed after preview. Preview it again before importing.',
    expected_source_payload_hash: expectedHash,
    actual_source_payload_hash: actualHash,
  });
}

function sendDuplicateImport(res: Response, anchor: AnchorRecord, preview: CredentialSourceImportPreview): void {
  res.status(200).json({
    duplicate: true,
    anchor: toReceipt(anchor),
    preview,
  });
}

function sendCreditFailure(res: Response, orgId: string, deduction: DeductionResult): void {
  if (deduction.error === 'insufficient_credits') {
    res.status(402).json({
      error: 'insufficient_credits',
      message: 'Organization has insufficient anchor credits for this cycle.',
      balance: deduction.balance,
      required: deduction.required,
    });
    return;
  }

  if (deduction.error === 'rpc_failure') {
    logger.error({ err: deduction.message, orgId }, 'org_credit_deduct_rpc_failure');
    res.status(503).json({ error: 'credit_check_unavailable' });
    return;
  }

  logger.warn({ orgId }, 'org_credit_deduct_blocked_uninitialized');
  res.status(402).json({
    error: 'org_credits_not_initialized',
    message:
      'This organization is not provisioned for credit-based billing. ' +
      'An operator must seed org_credits before this API key can submit.',
  });
}

function buildAnchorPublicId(): string {
  return `ARK-${new Date().getFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

function buildAnchorInsertPayload(
  userId: string,
  orgId: string | null,
  preview: CredentialSourceImportPreview,
  publicId: string,
): AnchorInsertPayload {
  return anchorSchema.parse({
    fingerprint: preview.anchor_fingerprint,
    public_id: publicId,
    status: 'PENDING' as const,
    org_id: orgId,
    user_id: userId,
    filename: buildSourceImportFilename(preview),
    file_size: preview.source_payload_byte_length,
    file_mime: preview.source_payload_content_type,
    credential_type: preview.credential_type,
    label: preview.credential_title,
    description: preview.credential_issuer
      ? `${preview.credential_title} from ${preview.credential_issuer}`
      : preview.credential_title,
    issued_at: evidenceDateToTimestamp(preview.credential_issued_at),
    expires_at: evidenceDateToTimestamp(preview.credential_expires_at, true),
    metadata: {
      ...preview.public_metadata,
      source_anchor_fingerprint: preview.anchor_fingerprint,
    },
  });
}

async function findExistingImport(userId: string, preview: CredentialSourceImportPreview): Promise<AnchorRecord | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dbAny = db as any;
  const { data, error } = await dbAny
    .from('anchors')
    .select('id, public_id, fingerprint, status, created_at')
    .eq('user_id', userId)
    .eq('fingerprint', preview.anchor_fingerprint)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    id: data.id,
    public_id: data.public_id,
    fingerprint: data.fingerprint,
    status: data.status,
    created_at: data.created_at,
  };
}

async function findAnchorByPublicId(userId: string, publicId: string): Promise<{ fingerprint: string } | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dbAny = db as any;
  const { data, error } = await dbAny
    .from('anchors')
    .select('fingerprint')
    .eq('user_id', userId)
    .eq('public_id', publicId)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return { fingerprint: data.fingerprint };
}

async function shouldRetryPublicIdCollision(
  userId: string,
  preview: CredentialSourceImportPreview,
  publicId: string,
): Promise<{ retry: boolean; duplicate?: AnchorRecord }> {
  const duplicate = await findExistingImport(userId, preview);
  if (duplicate) return { retry: false, duplicate };

  const publicIdConflict = await findAnchorByPublicId(userId, publicId);
  if (!publicIdConflict) return { retry: true };

  return {
    retry: publicIdConflict.fingerprint !== preview.anchor_fingerprint,
  };
}

async function insertAnchorWithPublicIdRetry(
  userId: string,
  orgId: string | null,
  preview: CredentialSourceImportPreview,
): Promise<AnchorCreateResult> {
  let lastError: DbErrorLike | null = null;

  for (let attempt = 0; attempt < MAX_PUBLIC_ID_INSERT_ATTEMPTS; attempt += 1) {
    const publicId = buildAnchorPublicId();
    const insertPayload = buildAnchorInsertPayload(userId, orgId, preview, publicId);
    const { data: anchor, error: insertError } = await db
      .from('anchors')
      .insert(insertPayload)
      .select('id, public_id, fingerprint, status, created_at')
      .single();

    if (!insertError && anchor) return { anchor, error: null };
    lastError = insertError;
    if (!isUniqueViolation(insertError)) return { anchor: null, error: insertError };

    const collision = await shouldRetryPublicIdCollision(userId, preview, publicId);
    if (collision.duplicate) return { anchor: null, error: insertError, duplicate: collision.duplicate };
    if (!collision.retry || attempt === MAX_PUBLIC_ID_INSERT_ATTEMPTS - 1) {
      return { anchor: null, error: insertError };
    }
  }

  return { anchor: null, error: lastError };
}

async function linkSelfRecipient(anchorId: string, userId: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dbAny = db as any;
  const payload = anchorRecipientSchema.parse({
    anchor_id: anchorId,
    recipient_email_hash: buildSelfImportRecipientHash(userId),
    recipient_user_id: userId,
  });
  const { error } = await dbAny.from('anchor_recipients').insert(payload);

  if (error && error.code !== '23505') throw error;
}

async function unlinkSelfRecipient(anchorId: string, userId: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dbAny = db as any;
  const { error } = await dbAny
    .from('anchor_recipients')
    .delete()
    .match({ anchor_id: anchorId, recipient_user_id: userId });

  if (error) throw error;
}

async function logImportAudit(userId: string, orgId: string | null, anchorId: string, preview: CredentialSourceImportPreview): Promise<void> {
  try {
    const payload = auditEventSchema.parse({
      event_type: 'CREDENTIAL_SOURCE_IMPORTED',
      event_category: 'ANCHOR',
      actor_id: userId,
      org_id: orgId,
      target_type: 'anchor',
      target_id: anchorId,
      details: JSON.stringify(buildAuditDetails(preview)),
    });
    // eslint-disable-next-line arkova/missing-org-filter -- Insert-only audit write; tenant scope is carried in the validated org_id payload.
    const { error } = await db.from('audit_events').insert(payload);
    if (error) throw error;
  } catch (error) {
    logger.error({ error, anchorId }, 'Failed to audit credential source import');
    throw error;
  }
}

async function markAnchorDeleted(anchorId: string, userId: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dbAny = db as any;
  const updatePayload = softDeleteUpdateSchema.parse({ deleted_at: 'now' });
  const { data, error } = await dbAny
    .from('anchors')
    .update(updatePayload)
    .eq('id', anchorId)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();

  if (error) {
    logger.error({ error, anchorId, userId }, 'Failed to roll back credential source anchor after import failure');
    throw error;
  }

  if (!data) {
    const error = new Error('Credential source rollback did not update an anchor');
    logger.error({ anchorId, userId }, 'Failed to roll back credential source anchor after import failure');
    throw error;
  }
}

async function rollbackImportCredit(orgId: string, anchorId: string, userId: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dbAny = db as any;
  const { data, error } = await dbAny.rpc('refund_org_credit', {
    p_org_id: orgId,
    p_amount: 1,
    p_reason: 'credential_source_import_compensation',
    p_reference_id: anchorId,
  });

  if (error) throw error;
  orgCreditRefundRpcResultSchema.parse(data);

  logger.warn({ orgId, anchorId, userId }, 'Rolled back credential source import credit after post-create failure');
}

async function compensateCreatedImportFailure(options: ImportCompensationOptions): Promise<void> {
  const errors: unknown[] = [];
  let anchorDeleted = false;

  if (options.recipientLinked) {
    try {
      await unlinkSelfRecipient(options.anchorId, options.userId);
    } catch (error) {
      errors.push(error);
      logger.error(
        { error, anchorId: options.anchorId, userId: options.userId },
        'Failed to unlink credential source self-recipient during compensation',
      );
    }
  }

  try {
    await markAnchorDeleted(options.anchorId, options.userId);
    anchorDeleted = true;
  } catch (error) {
    errors.push(error);
  }

  if (options.creditDeducted && options.orgId && anchorDeleted) {
    try {
      await rollbackImportCredit(options.orgId, options.anchorId, options.userId);
    } catch (error) {
      errors.push(error);
      logger.error(
        { error, orgId: options.orgId, anchorId: options.anchorId },
        'Failed to refund credential source import credit during compensation',
      );
    }
  }

  if (options.creditDeducted && options.orgId && !anchorDeleted) {
    logger.error(
      { orgId: options.orgId, anchorId: options.anchorId, userId: options.userId },
      'Skipped credential source import credit refund because anchor rollback failed',
    );
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, 'Credential source import compensation failed');
  }
}

async function ensureImportCreditOrRollback(
  orgId: string | null,
  anchorId: string,
  userId: string,
  res: Response,
): Promise<ImportCreditGateResult> {
  if (!orgId) return { ok: true, deducted: false };

  const deduction = await deductOrgCredit(db, orgId, 1, 'anchor.create', anchorId);
  if (deduction.allowed) return { ok: true, deducted: deduction.reason !== 'feature_disabled' };

  await markAnchorDeleted(anchorId, userId);
  sendCreditFailure(res, orgId, deduction);
  return { ok: false, deducted: false };
}

async function handleAnchorCreateFailure(
  userId: string,
  preview: CredentialSourceImportPreview,
  insertError: DbErrorLike | null,
  res: Response,
): Promise<void> {
  if (!isUniqueViolation(insertError)) {
    logger.error({ error: insertError, userId }, 'Failed to create credential source anchor');
    res.status(500).json({ error: 'anchor_create_failed', message: 'Failed to create credential record' });
    return;
  }

  const duplicate = await findExistingImport(userId, preview);
  if (duplicate) {
    await linkSelfRecipient(duplicate.id, userId);
    sendDuplicateImport(res, duplicate, preview);
    return;
  }

  logger.warn({ error: insertError, userId }, 'Credential source duplicate conflict was not readable');
  res.status(409).json({
    error: 'source_import_conflict',
    message: 'Credential source import is already in progress. Try again in a moment.',
  });
}

function toReceipt(anchor: AnchorRecord): AnchorReceipt {
  if (!anchor.public_id) {
    throw new Error('Credential source anchor is missing public_id');
  }
  const publicId = anchor.public_id;
  return {
    public_id: publicId,
    fingerprint: anchor.fingerprint,
    status: anchor.status,
    created_at: anchor.created_at,
    record_uri: buildVerifyUrl(publicId),
  };
}

router.post('/import-url/preview', async (req: Request, res: Response) => {
  if (!req.authUserId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const result = await buildPreviewFromRequest(req, res);
    if (!result) return;
    res.json(result.result.preview);
  } catch (error) {
    if (error instanceof CredentialSourceImportError) {
      sendCredentialSourceError(res, error);
      return;
    }
    logger.error({ error, userId: req.authUserId }, 'Credential source preview failed');
    res.status(500).json({ error: 'preview_failed', message: 'Failed to preview credential source' });
  }
});

router.post('/import-url/confirm', async (req: Request, res: Response) => {
  const userId = req.authUserId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const result = await buildPreviewFromRequest(req, res);
    if (!result) return;

    const { input } = result;
    const { preview } = result.result;
    const expectedHash = input.expected_source_payload_hash?.toLowerCase();
    if (expectedHash && expectedHash !== preview.source_payload_hash) {
      sendSourceChanged(res, expectedHash, preview.source_payload_hash);
      return;
    }

    const orgId = await loadUserOrgId(userId);
    const existing = await findExistingImport(userId, preview);
    if (existing) {
      await linkSelfRecipient(existing.id, userId);
      sendDuplicateImport(res, existing, preview);
      return;
    }

    const createResult = await insertAnchorWithPublicIdRetry(userId, orgId, preview);
    if (createResult.duplicate) {
      await linkSelfRecipient(createResult.duplicate.id, userId);
      sendDuplicateImport(res, createResult.duplicate, preview);
      return;
    }

    const { anchor } = createResult;
    if (!anchor) {
      await handleAnchorCreateFailure(userId, preview, createResult.error, res);
      return;
    }

    const creditGate = await ensureImportCreditOrRollback(orgId, anchor.id, userId, res);
    if (!creditGate.ok) {
      return;
    }

    let recipientLinked = false;
    try {
      await linkSelfRecipient(anchor.id, userId);
      recipientLinked = true;
      await logImportAudit(userId, orgId, anchor.id, preview);
    } catch (postCreateError) {
      try {
        await compensateCreatedImportFailure({
          anchorId: anchor.id,
          userId,
          orgId,
          creditDeducted: creditGate.deducted,
          recipientLinked,
        });
      } catch (compensationError) {
        logger.error(
          { compensationError, postCreateError, anchorId: anchor.id, userId },
          'Failed to compensate credential source import after post-create failure',
        );
      }
      throw postCreateError;
    }

    // SCRUM-1798 (SCRUM-1743 Phase 2a): emit `credential.issued` webhook after
    // the credential row is committed + recipient linked + audit logged.
    // Best-effort dispatch — failure does NOT abort the response. The anchor
    // row is already authoritative; customers reconcile via
    // `/api/v1/anchors/:public_id` if they miss a delivery. Pattern mirrors
    // `anchor.submitted` emit in services/worker/src/jobs/anchor.ts.
    //
    // org_public_id + recipient_public_id are optional+nullable in the schema
    // (services/worker/src/webhooks/payload-schemas.ts CREDENTIAL_BASE_FIELDS)
    // — joining to orgs.public_id / profiles.public_id is a follow-up; schema
    // accepts null today.
    if (orgId && anchor.public_id) {
      const issuedAt =
        evidenceDateToTimestamp(preview.credential_issued_at) ?? anchor.created_at;
      const expiresAt = evidenceDateToTimestamp(preview.credential_expires_at, true);
      // Capture narrowed values into locals so TypeScript keeps the non-null
      // narrowing across the async closure below.
      const publicId: string = anchor.public_id;
      const anchorOrgId: string = orgId;
      const anchorId: string = anchor.id;

      // Codex P2 PR #753: fire-and-forget the webhook dispatch. The previous
      // pattern awaited dispatchWebhookEvent which awaits Promise.all over
      // deliverToEndpoint — each endpoint has a 10s fetch timeout. A slow or
      // black-holed customer endpoint could add up to ~10s to every successful
      // import. The webhook is best-effort; the credential is already
      // committed by the time we get here. The .then handler writes the
      // tamper-evident audit row capturing dispatch outcome (success or
      // dispatch_error) after the dispatch resolves; the response returns
      // immediately regardless.
      const dispatchPromise = (async () => {
        try {
          await dispatchWebhookEvent(anchorOrgId, 'credential.issued', publicId, {
            public_id: publicId,
            credential_type: preview.credential_type,
            status: 'ISSUED',
            issued_at: issuedAt,
            expires_at: expiresAt,
          });
          return { dispatched: true, error: null as string | null };
        } catch (webhookError) {
          const message = webhookError instanceof Error
            ? webhookError.message
            : String(webhookError);
          logger.warn(
            { anchorId, publicId, error: webhookError },
            'Failed to dispatch credential.issued webhook (response NOT aborted)',
          );
          return { dispatched: false, error: message };
        }
      })();

      void dispatchPromise.then((outcome) => {
        // SCRUM-1800 (SCRUM-1743 Phase 2c): tamper-evident audit row tied to
        // the webhook emit decision. The existing CREDENTIAL_SOURCE_IMPORTED
        // row captures the import action; this `credential.issued` row
        // captures the outbound webhook fan-out specifically so auditors can
        // answer "was a credential.issued event emitted for anchor X?"
        // without joining webhook_delivery_logs.
        // eslint-disable-next-line arkova/missing-org-filter -- Insert-only audit write; tenant scope is carried in the validated org_id field.
        void db.from('audit_events').insert({
          event_type: 'credential.issued',
          event_category: 'WEBHOOK',
          actor_id: userId,
          org_id: anchorOrgId,
          target_type: 'anchor',
          target_id: anchorId,
          details: JSON.stringify({
            public_id: publicId,
            credential_type: preview.credential_type,
            dispatched: outcome.dispatched,
            dispatch_error: outcome.error,
            issued_at: issuedAt,
            expires_at: expiresAt,
          }),
        }).then(({ error }: { error: unknown }) => {
          if (error) {
            logger.error(
              { error, anchorId },
              'Failed to write credential.issued audit row',
            );
          }
        });
      });
    }

    res.status(201).json({
      duplicate: false,
      anchor: toReceipt(anchor),
      preview,
    });
  } catch (error) {
    if (error instanceof CredentialSourceImportError) {
      sendCredentialSourceError(res, error);
      return;
    }
    logger.error({ error, userId }, 'Credential source import failed');
    res.status(500).json({ error: 'import_failed', message: 'Failed to import credential source' });
  }
});

export { router as credentialSourcesRouter };
