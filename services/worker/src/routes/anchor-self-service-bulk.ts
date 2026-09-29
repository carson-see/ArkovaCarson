import type { Request, Response } from 'express';
import { z } from 'zod';
import { ANCHOR_CREDENTIAL_TYPES } from '../lib/credential-evidence.js';
import { BULK_FINGERPRINT_SOURCE, handleAnchorSubmit } from '../api/v1/anchor-submit.js';
import { linkBulkRecipient } from '../api/bulk-recipient.js';
import { RecipientPepperUnavailableError } from '../lib/recipient-identity.js';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { captureRecipientPepperUnavailableAlert } from '../utils/sentry.js';

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
    type(value: string) { headers.set('content-type', value); return this; },
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
  const orgId = req.apiKey.orgId?.trim() || null;
  // B1 (BLOCKING, #3034 review): a DENIED answer used to reject the whole
  // request 403. That is a regression against `main`, where the recipient pass
  // was separate, non-fatal, and simply skipped when there was no org — so a
  // personal-scope user importing a spreadsheet with any column containing
  // "mail" (csvParser auto-maps it to email) got ZERO anchors and a generic
  // "Failed to process batch". The anchor is the durable fact, so a caller who
  // may not provision recipients still gets every anchor; only the link is
  // skipped, and those rows say so per-row.
  //
  // `unavailable` is deliberately NOT degraded the same way: it means we could
  // not READ the authority, it is transient, and it is decided before any anchor
  // exists — so a retryable 503 loses no durable state, whereas guessing would
  // either leak provisioning to an unauthorized caller or mark rows with a
  // failure that may not be true.
  let recipientAuthority: 'allowed' | 'denied' = 'allowed';
  if (body.rows.some((row) => row.recipient_email)) {
    const authority = await authorizeRecipientProvisioning(req, orgId);
    if (authority === 'unavailable') {
      res.status(503).json({ error: 'recipient_authorization_unavailable' });
      return;
    }
    recipientAuthority = authority;
  }
  const results: Array<Record<string, unknown>> = [];
  let created = 0;
  let skipped = 0;
  let failed = 0;
  let recipientLinkFailed = 0;
  // Counted, not alerted per row: a missing pepper is one config outage shared
  // by every row in the request (S7).
  let pepperUnavailableRows = 0;

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
        // The anchor is the durable fact. Once the canonical submit answers
        // 2xx the record exists permanently, so a later recipient-link failure
        // must NOT be reported as a failed row: a caller reading `failed` here
        // re-submits a row whose anchor already exists, which is a duplicate
        // submission attempt and, for a capped or billable org, a double
        // charge. The link failure gets its own status instead (SCRUM-5265,
        // SHOULD-FIX from the #3020 review). Replay is safe and cheap: the
        // canonical submit dedupes on fingerprint and answers
        // `idempotent: true` without creating or charging again, and the block
        // below re-attempts ONLY the link.
        let recipientFailure: string | null = null;
        if (row.recipient_email && publicId) {
          if (recipientAuthority === 'denied') {
            recipientFailure = 'recipient_provisioning_forbidden';
            // Warn, not error: the caller is simply not authorized to provision
            // a recipient. Bounded context only — never the email or the name.
            logger.warn(
              { reason: recipientFailure, publicId, orgId },
              'Bulk import anchored a row but skipped a recipient link the caller may not provision',
            );
          } else {
            try {
              await linkBulkRecipient({
                anchorPublicId: publicId,
                actorUserId: req.apiKey.userId,
                orgId,
                email: row.recipient_email,
                fullName: row.recipient_name,
                deliverActivationEmail: true,
              });
            } catch (error) {
              if (error instanceof RecipientPepperUnavailableError) {
                // Distinguishable in the logs AND in the response: this is a
                // deployment config outage, not a defect in the caller's row.
                recipientFailure = 'recipient_pepper_unavailable';
                pepperUnavailableRows += 1;
              } else {
                // Bounded, non-PII: a thrown message is only echoed when it is
                // already a machine-readable code.
                recipientFailure = error instanceof Error && /^[a-zA-Z0-9_.-]{1,80}$/.test(error.message)
                  ? error.message
                  : 'recipient_link_failed';
              }
              logger.error(
                { reason: recipientFailure, publicId, orgId },
                'Bulk import anchored a row but the recipient link failed',
              );
            }
          }
        }
        if (isSkipped) skipped += 1; else created += 1;
        if (recipientFailure) recipientLinkFailed += 1;
        results.push({
          fingerprint: row.fingerprint.toLowerCase(),
          status: recipientFailure
            ? (isSkipped ? 'skipped_recipient_failed' : 'created_recipient_failed')
            : (isSkipped ? 'skipped' : 'created'),
          ...(publicId ? { public_id: publicId } : {}),
          ...(recipientFailure ? { reason: recipientFailure } : {}),
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

  // Once per request, not once per row: every affected row shares one outage.
  if (pepperUnavailableRows > 0) {
    captureRecipientPepperUnavailableAlert({
      operation: 'anchor-self-service-bulk.linkBulkRecipient',
      orgId,
      affectedRows: pepperUnavailableRows,
    });
  }

  // A recipient-link failure is a partial outcome even though every anchor
  // committed, so it reports 207 alongside a genuinely failed row.
  res.status(failed > 0 || recipientLinkFailed > 0 ? 207 : 200).json({
    total: body.rows.length,
    created,
    skipped,
    failed,
    // Additive counter (§1.8). Rows counted here are ALSO counted in `created`
    // or `skipped`, so `created + skipped + failed` still equals `total`.
    recipient_link_failed: recipientLinkFailed,
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
