import type { Request, Response } from 'express';
import { z } from 'zod';
import { ANCHOR_CREDENTIAL_TYPES } from '../lib/credential-evidence.js';
import { BULK_FINGERPRINT_SOURCE, handleAnchorSubmit } from '../api/v1/anchor-submit.js';
import { linkBulkRecipient } from '../api/bulk-recipient.js';
import { db } from '../utils/db.js';

const SAFE_METADATA_KEY = /^[a-zA-Z0-9_.-]+$/;
const PrivateTagsSchema = z.object({
  user: z.array(z.string().trim().min(1).max(64)).max(10).default([]),
  organization: z.array(z.string().trim().min(1).max(64)).max(10).default([]),
}).strict();

const BulkRowSchema = z.object({
  fingerprint: z.string().regex(/^[a-fA-F0-9]{64}$/),
  filename: z.string().trim().min(1).max(255),
  file_size: z.number().int().positive().optional(),
  credential_type: z.enum(ANCHOR_CREDENTIAL_TYPES).optional(),
  metadata: z.record(z.string().regex(SAFE_METADATA_KEY), z.unknown()).optional(),
  fingerprint_provided: z.boolean(),
  recipient_email: z.string().trim().email().max(254).optional(),
  recipient_name: z.string().trim().min(1).max(255).optional(),
}).strict().superRefine((row, context) => {
  if (row.recipient_name && !row.recipient_email) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['recipient_name'],
      message: 'recipient_email is required when recipient_name is provided',
    });
  }
});

export const SelfServiceBulkSchema = z.object({
  org_id: z.string().uuid().nullable(),
  action: z.enum(['queue', 'instant']),
  description: z.string().max(1000).optional(),
  private_tags: PrivateTagsSchema.default({ user: [], organization: [] }),
  rows: z.array(BulkRowSchema).min(1).max(100),
}).strict();

export interface CapturedSubmit {
  status: number;
  body: Record<string, unknown>;
}

/** Invoke the canonical single-submit handler in-process without a loopback HTTP call. */
export async function submitCanonicalRow(req: Request, body: Record<string, unknown>, fingerprintProvided: boolean): Promise<CapturedSubmit> {
  let status = 200;
  let responseBody: Record<string, unknown> | undefined;
  const headers = new Map<string, string | number | readonly string[]>();
  const response = {
    status(code: number) { status = code; return this; },
    json(value: Record<string, unknown>) { responseBody = value; return this; },
    setHeader(name: string, value: string | number | readonly string[]) { headers.set(name.toLowerCase(), value); return this; },
    getHeader(name: string) { return headers.get(name.toLowerCase()); },
  } as unknown as Response;
  const child = Object.create(req) as Request;
  child.body = body;
  (child as Request & { [BULK_FINGERPRINT_SOURCE]?: 'document_bytes' | null })[BULK_FINGERPRINT_SOURCE] = fingerprintProvided
    ? 'document_bytes'
    : null;
  await handleAnchorSubmit(child, response);
  if (!responseBody) throw new Error('canonical submit completed without a response');
  return { status, body: responseBody };
}

function boundedReason(body: Record<string, unknown>): string {
  const error = body.error;
  if (typeof error === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(error)) return error;
  if (error && typeof error === 'object') {
    const code = (error as Record<string, unknown>).code;
    if (typeof code === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(code)) return code;
  }
  return 'submission_failed';
}

async function authorizeRecipientProvisioning(req: Request, orgId: string | null): Promise<'allowed' | 'denied' | 'unavailable'> {
  if (!orgId) return 'denied';
  const [profileResult, membershipResult] = await Promise.all([
    db.from('profiles').select('is_platform_admin').eq('id', req.apiKey!.userId).maybeSingle(),
    db.from('org_members').select('role').eq('user_id', req.apiKey!.userId).eq('org_id', orgId).maybeSingle(),
  ]);
  if (profileResult.error || membershipResult.error) return 'unavailable';
  if (profileResult.data?.is_platform_admin === true) return 'allowed';
  return membershipResult.data?.role === 'owner' || membershipResult.data?.role === 'admin'
    ? 'allowed'
    : 'denied';
}

export async function handleSelfServiceBulk(req: Request, res: Response): Promise<void> {
  if (!req.apiKey) {
    res.status(401).json({ error: 'authentication_required' });
    return;
  }
  const parsed = SelfServiceBulkSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'invalid_request',
      message: 'Request body failed validation',
      details: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code, message: issue.message })),
    });
    return;
  }
  const body = parsed.data;
  if (body.rows.some((row) => row.recipient_email)) {
    const authority = await authorizeRecipientProvisioning(req, req.apiKey.orgId?.trim() || null);
    if (authority !== 'allowed') {
      res.status(authority === 'unavailable' ? 503 : 403).json({
        error: authority === 'unavailable' ? 'recipient_authorization_unavailable' : 'recipient_provisioning_forbidden',
      });
      return;
    }
  }
  const results: Array<Record<string, unknown>> = [];
  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of body.rows) {
    try {
      const outcome = await submitCanonicalRow(req, {
        fingerprint: row.fingerprint,
        filename: row.filename,
        ...(row.file_size === undefined ? {} : { file_size: row.file_size }),
        ...(row.credential_type === undefined ? {} : { credential_type: row.credential_type }),
        ...(row.metadata === undefined ? {} : { metadata: row.metadata }),
        ...(body.description === undefined ? {} : { description: body.description }),
        private_tags: body.private_tags,
        action: body.action,
      }, row.fingerprint_provided);
      const publicId = typeof outcome.body.public_id === 'string' ? outcome.body.public_id : undefined;
      if (outcome.status >= 200 && outcome.status < 300) {
        const isSkipped = outcome.body.idempotent === true;
        if (row.recipient_email && publicId) {
          try {
            await linkBulkRecipient({
              anchorPublicId: publicId,
              actorUserId: req.apiKey.userId,
              orgId: req.apiKey.orgId?.trim() || null,
              email: row.recipient_email,
              fullName: row.recipient_name,
              deliverActivationEmail: true,
            });
          } catch (error) {
            failed += 1;
            const reason = error instanceof Error && /^[a-zA-Z0-9_.-]{1,80}$/.test(error.message)
              ? error.message
              : 'recipient_link_failed';
            results.push({ fingerprint: row.fingerprint.toLowerCase(), status: 'failed', ...(publicId ? { public_id: publicId } : {}), reason });
            continue;
          }
        }
        if (isSkipped) skipped += 1; else created += 1;
        results.push({
          fingerprint: row.fingerprint.toLowerCase(),
          status: isSkipped ? 'skipped' : 'created',
          ...(publicId ? { public_id: publicId } : {}),
          ...(typeof outcome.body.instant_status === 'string' ? { instant_status: outcome.body.instant_status } : {}),
        });
      } else {
        failed += 1;
        results.push({ fingerprint: row.fingerprint.toLowerCase(), status: 'failed', reason: boundedReason(outcome.body) });
      }
    } catch {
      failed += 1;
      results.push({ fingerprint: row.fingerprint.toLowerCase(), status: 'failed', reason: 'submission_failed' });
    }
  }

  res.status(failed > 0 ? 207 : 200).json({
    total: body.rows.length,
    created,
    skipped,
    failed,
    results,
  });
}

/** API-key transport for the same orchestration; tenant comes only from the key. */
export async function handleAnchorImport(req: Request, res: Response): Promise<void> {
  if (!req.apiKey) {
    res.status(401).json({ error: 'authentication_required' });
    return;
  }
  const requested = (req.body as { org_id?: unknown } | null)?.org_id;
  const keyOrgId = req.apiKey.orgId?.trim() || null;
  if (requested !== undefined && requested !== keyOrgId) {
    res.status(403).json({ error: 'organization_access_denied' });
    return;
  }
  req.body = { ...(req.body as Record<string, unknown>), org_id: keyOrgId };
  await handleSelfServiceBulk(req, res);
}
