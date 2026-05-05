import { randomUUID } from 'node:crypto';
import { Router, Request, Response } from 'express';
import { buildVerifyUrl } from '../../lib/urls.js';
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
import { ensureAnchorCreditAvailable } from '../../utils/anchorCreditGate.js';

const router = Router();

interface AnchorReceipt {
  id: string;
  public_id: string;
  fingerprint: string;
  status: string;
  created_at: string;
  record_uri: string;
}

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

async function findExistingImport(userId: string, preview: CredentialSourceImportPreview): Promise<AnchorReceipt | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dbAny = db as any;
  const { data, error } = await dbAny
    .from('anchors')
    .select('id, public_id, fingerprint, status, created_at')
    .eq('user_id', userId)
    .eq('metadata->>source_url', preview.normalized_source_url)
    .eq('metadata->>source_payload_hash', preview.source_payload_hash)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const publicId = data.public_id ?? '';
  return {
    id: data.id,
    public_id: publicId,
    fingerprint: data.fingerprint,
    status: data.status,
    created_at: data.created_at,
    record_uri: buildVerifyUrl(publicId),
  };
}

async function linkSelfRecipient(anchorId: string, userId: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dbAny = db as any;
  const { error } = await dbAny.from('anchor_recipients').insert({
    anchor_id: anchorId,
    recipient_email_hash: buildSelfImportRecipientHash(userId),
    recipient_user_id: userId,
    claimed_at: new Date().toISOString(),
  });

  if (error && error.code !== '23505') throw error;
}

function logImportAudit(userId: string, orgId: string | null, anchorId: string, preview: CredentialSourceImportPreview): void {
  void (async () => {
    const { error } = await db.from('audit_events').insert({
      event_type: 'CREDENTIAL_SOURCE_IMPORTED',
      event_category: 'ANCHOR',
      actor_id: userId,
      org_id: orgId,
      target_type: 'anchor',
      target_id: anchorId,
      details: JSON.stringify({
        source_provider: preview.source_provider,
        source_url: preview.normalized_source_url,
        evidence_package_hash: preview.evidence_package_hash,
        source_payload_hash: preview.source_payload_hash,
      }),
    });
    if (error) logger.warn({ error, anchorId }, 'Failed to audit credential source import');
  })().catch((error: unknown) => {
    logger.warn({ error, anchorId }, 'Failed to audit credential source import');
  });
}

function toReceipt(anchor: {
  id: string;
  public_id: string | null;
  fingerprint: string;
  status: string;
  created_at: string;
}): AnchorReceipt {
  const publicId = anchor.public_id ?? '';
  return {
    id: anchor.id,
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
      res.status(409).json({
        error: 'source_changed',
        message: 'Credential source changed after preview. Preview it again before importing.',
        expected_source_payload_hash: expectedHash,
        actual_source_payload_hash: preview.source_payload_hash,
      });
      return;
    }

    const orgId = await loadUserOrgId(userId);
    const existing = await findExistingImport(userId, preview);
    if (existing) {
      await linkSelfRecipient(existing.id, userId);
      res.status(200).json({
        duplicate: true,
        anchor: existing,
        preview,
      });
      return;
    }

    if (orgId && !(await ensureAnchorCreditAvailable(db, orgId, res))) {
      return;
    }

    const publicId = `ARK-${new Date().getFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const insertPayload = {
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
      metadata: preview.public_metadata,
    };

    const { data: anchor, error: insertError } = await db
      .from('anchors')
      .insert(insertPayload)
      .select('id, public_id, fingerprint, status, created_at')
      .single();

    if (insertError || !anchor) {
      logger.error({ error: insertError, userId }, 'Failed to create credential source anchor');
      res.status(500).json({ error: 'anchor_create_failed', message: 'Failed to create credential record' });
      return;
    }

    await linkSelfRecipient(anchor.id, userId);
    logImportAudit(userId, orgId, anchor.id, preview);

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
