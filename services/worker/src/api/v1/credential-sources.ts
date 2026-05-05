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
import { isPrivateUrlResolved } from '../../webhooks/delivery.js';
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
    logger.error({ error, anchorId, userId }, 'Failed to roll back credential source anchor after credit rejection');
    throw error;
  }

  if (!data) {
    const error = new Error('Credential source rollback did not update an anchor');
    logger.error({ anchorId, userId }, 'Failed to roll back credential source anchor after credit rejection');
    throw error;
  }
}

async function ensureImportCreditOrRollback(
  orgId: string | null,
  anchorId: string,
  userId: string,
  res: Response,
): Promise<boolean> {
  if (!orgId) return true;

  const deduction = await deductOrgCredit(db, orgId, 1, 'anchor.create', anchorId);
  if (deduction.allowed) return true;

  await markAnchorDeleted(anchorId, userId);
  sendCreditFailure(res, orgId, deduction);
  return false;
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
  const publicId = anchor.public_id ?? '';
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

    if (!(await ensureImportCreditOrRollback(orgId, anchor.id, userId, res))) {
      return;
    }

    await linkSelfRecipient(anchor.id, userId);
    await logImportAudit(userId, orgId, anchor.id, preview);

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
