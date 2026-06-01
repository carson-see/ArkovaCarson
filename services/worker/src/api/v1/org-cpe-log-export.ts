/**
 * ORG-ADMIN Per-Member CPE Compliance-Log Export Endpoint
 * (SCRUM-1849 / SCRUM-1863 — CPE-R3)
 *
 * POST /api/v1/exports/org/cpe-log
 *
 * Body: { user_id, period_start, period_end, format: 'pdf' | 'json' }
 *   where `user_id` is the MEMBER to export (NOT the caller).
 *
 * Sibling of the CPE-R2 own-user export (`./cpe-log-export.ts`), reusing the
 * same export worker (`generateCpeLogExport`) and Storage seam. The ONLY
 * difference is the authorization model: instead of own-user-only, an ORG_ADMIN
 * may export the compliance log of any MEMBER OF THEIR OWN ORG.
 *
 * Authorization (all in application code — the worker runs as service_role and
 * bypasses RLS, so these checks ARE the tenant boundary):
 *   1. Caller is authenticated (req.authUserId set by router `requireAuth`).
 *   2. Caller belongs to an org    → else 403.
 *   3. Caller is an ORG_ADMIN of that org (`isCallerOrgAdmin`) → else 403.
 *   4. The target `user_id` is a member of the CALLER'S org
 *      (`isUserMemberOfOrg(target, callerOrgId)`) → else 403 (CROSS-ORG).
 *
 * The org scope is ALWAYS resolved from the caller's own profile/membership —
 * never trusted from the request body — so an admin of org A can never reach a
 * member of org B. The export worker is then called with `userId = target`,
 * `orgId = caller's org`, and its own query re-filters by BOTH user_id AND
 * org_id (defense in depth).
 *
 * Rate limit (Constitution 1.10): 10 requests / admin / hour, on a SEPARATE
 * bucket scope (`org-cpe-log-export`) so it doesn't share the per-user budget
 * of the R2 own-user export.
 *
 * Audit: the reused worker emits its own metadata-only `cpe_log.exported` row
 * (actor = the exported member). Because an ORG-ADMIN action must record the
 * ADMIN as actor plus the target member, this endpoint emits an ADDITIONAL,
 * complementary `cpe_log.exported` audit row with `actor_id = admin`,
 * `org_id = caller org`, and `target_member_id` + `acting_as: 'ORG_ADMIN'` in
 * metadata-only details (`target_type = 'org_cpe_log_export'`). No export body
 * content is ever logged (CC7) — only ids, period, format, and record count.
 */
import { Router, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { config } from '../../config.js';
import { rateLimit } from '../../utils/rateLimit.js';
import { getCallerOrgId, isCallerOrgAdmin, isUserMemberOfOrg } from '../_org-auth.js';
import {
  generateCpeLogExport,
  createSupabaseStorageAdapter,
} from '../../exports/cpe-log-export.js';

const router = Router();

/**
 * Emit the ADMIN-attributed `cpe_log.exported` audit row.
 *
 * METADATA ONLY (CC7): only ids, period, format, and record count — never any
 * export body content (no titles, providers, public_ids, URLs). `actor_id` is
 * the admin; the exported member is captured in `details.target_member_id` and
 * the action is flagged with `acting_as: 'ORG_ADMIN'`. `target_type` is the
 * additive `org_cpe_log_export` marker so this row is distinguishable from the
 * worker's own member-actor row. Non-fatal — a failure here never fails the
 * already-completed export.
 */
async function emitOrgCpeExportedAudit(args: {
  adminUserId: string;
  orgId: string;
  targetMemberId: string;
  periodStart: string;
  periodEnd: string;
  recordCount: number;
  requestId: string;
}): Promise<void> {
  const details = {
    target_member_id: args.targetMemberId,
    acting_as: 'ORG_ADMIN',
    period_start: args.periodStart,
    period_end: args.periodEnd,
    format: 'pdf+json',
    record_count: args.recordCount,
    request_id: args.requestId,
  };

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, arkova/missing-org-filter -- audit insert writes a new event row; org_id + actor_id are set on the row (not a tenant-leaking read).
    const result = await (db.from('audit_events') as any).insert({
      event_type: 'cpe_log.exported',
      event_category: 'ADMIN',
      actor_id: args.adminUserId,
      org_id: args.orgId,
      target_type: 'org_cpe_log_export',
      details: JSON.stringify(details),
    });
    if (result?.error) {
      logger.warn(
        { orgId: args.orgId, requestId: args.requestId, code: result.error.code },
        'org cpe_log.exported audit insert failed (non-fatal)',
      );
    }
  } catch (err) {
    logger.warn(
      { requestId: args.requestId, error: err instanceof Error ? err.message : 'unknown' },
      'org cpe_log.exported audit insert threw (non-fatal)',
    );
  }
}

/**
 * Per-admin hourly rate limiter. Exported so it can be mounted in the v1 router
 * (and exercised directly in tests). Window = 1 hour, max = 10 → the 11th
 * request in the hour 429s. `scope: 'org-cpe-log-export'` keeps this bucket
 * SEPARATE from the R2 own-user export limiter (`scope: 'cpe-log-export'`), so
 * an admin's org exports don't eat into their own per-user export budget.
 */
export const orgCpeLogExportRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  maxRequests: 10,
  scope: 'org-cpe-log-export',
  keyGenerator: (req: Request) => `org-cpe-log-export:${req.authUserId ?? req.ip ?? 'unknown'}`,
});

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const OrgExportRequestSchema = z
  .object({
    user_id: z.string().min(1),
    period_start: z.string().regex(DATE_ONLY, 'period_start must be YYYY-MM-DD'),
    period_end: z.string().regex(DATE_ONLY, 'period_end must be YYYY-MM-DD'),
    format: z.enum(['pdf', 'json']),
  })
  .strict() // reject any body-supplied org_id / extra fields — org is caller-derived only
  .refine((v) => v.period_start <= v.period_end, {
    message: 'period_end must be on or after period_start',
    path: ['period_end'],
  });

router.post('/', async (req: Request, res: Response) => {
  const requestId = randomUUID();

  // 1. Auth (defense in depth — the router also gates with requireAuth).
  const adminUserId = req.authUserId;
  if (!adminUserId) {
    res.status(401).json({ error: 'Authentication required', request_id: requestId });
    return;
  }

  // 2. Validate.
  const parsed = OrgExportRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: 'Invalid request',
      request_id: requestId,
      details: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        code: i.code,
        message: i.message,
      })),
    });
    return;
  }
  const { user_id: targetUserId, period_start, period_end, format } = parsed.data;

  try {
    // 3. Resolve the CALLER's org (never from the body).
    const orgId = await getCallerOrgId(adminUserId);
    if (!orgId) {
      res.status(403).json({ error: 'Organization membership required', request_id: requestId });
      return;
    }

    // 4. Caller must be an ORG_ADMIN of that org.
    const callerIsAdmin = await isCallerOrgAdmin(adminUserId, orgId);
    if (!callerIsAdmin) {
      res.status(403).json({
        error: 'Organization administrator role required',
        request_id: requestId,
      });
      return;
    }

    // 5. Target must be a member of the CALLER'S org (cross-org → 403).
    const targetInOrg = await isUserMemberOfOrg(targetUserId, orgId);
    if (!targetInOrg) {
      res.status(403).json({
        error: 'The requested member is not part of your organization',
        request_id: requestId,
      });
      return;
    }

    // 6. Generate (PDF + JSON) for the TARGET member within the CALLER'S org,
    //    upload, sign. (The worker also emits its own metadata-only
    //    `cpe_log.exported` row with the member as actor.)
    const result = await generateCpeLogExport(
      {
        userId: targetUserId,
        orgId,
        periodStart: period_start,
        periodEnd: period_end,
        requestId,
      },
      {
        db,
        storage: createSupabaseStorageAdapter(db),
        logger,
        frontendUrl: config.frontendUrl,
      },
    );

    // 7. Emit the ADMIN-attributed audit row (actor = admin, target member in
    //    metadata). Metadata-only (CC7) and non-fatal — the export already
    //    succeeded by this point.
    await emitOrgCpeExportedAudit({
      adminUserId,
      orgId,
      targetMemberId: targetUserId,
      periodStart: period_start,
      periodEnd: period_end,
      recordCount: result.record_count,
      requestId: result.request_id,
    });

    res.status(200).json({
      request_id: result.request_id,
      member_id: targetUserId,
      record_count: result.record_count,
      requested_format: format,
      exports: result.exports,
    });
  } catch (err) {
    logger.error(
      { error: err instanceof Error ? err.message : 'unknown', requestId },
      'Org CPE log export failed',
    );
    res
      .status(500)
      .json({ error: 'Failed to generate CPE compliance log', request_id: requestId });
  }
});

export { router as orgCpeLogExportRouter };
