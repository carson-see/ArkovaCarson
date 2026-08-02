/**
 * Dashboard bridge for mixed-format batch anchoring — SCRUM-2911 (W1, founder
 * P0, 2026-07-28 amendment A1).
 *
 * `POST /api/v1/anchor/bulk` (`anchor-bulk.ts`) already implements everything
 * a bulk-anchor call needs (dedup strategies, org-credit deduction, quota
 * enforcement, per-row error reporting) but it is mounted behind
 * `apiKeyAuth`/`requireScope('anchor:write')` — real `ak_...` API keys only
 * (see `services/worker/src/middleware/apiKeyAuth.ts`). The dashboard
 * authenticates users with a Supabase session JWT, which that middleware
 * never recognizes, so the browser cannot reach it directly.
 *
 * This is the bulk-anchor analogue of `webhooks-self-service.ts`: mounted
 * behind the v1 router's local `requireAuth` (Supabase JWT — sets
 * `req.authUserId`), it re-derives `org_id` from `profiles` (never trusts an
 * org id supplied by the client), synthesizes an `ApiKeyMeta`-shaped caller
 * scoped to that org, and falls through into the EXISTING, byte-for-byte
 * unmodified `anchorBulkRouter` — no duplicated dedup/credit/quota/insert
 * logic. Any org member may call it (mixed-format batch anchoring is a
 * document-creation action, not an admin setting — same RLS bar as a single
 * `anchors` insert: `anchors_insert_own` requires only `org_id =
 * get_user_org_id()`, no role check).
 *
 * Individual (no-org) accounts are rejected with 403 — `deductOrgCredit`
 * requires a non-null `orgId` (org-scoped credits are canonical for
 * org-scoped money ops per the 2026-07-28 CTO ruling R4), and the external
 * bulk API is inherently org-scoped (API keys always belong to an org). An
 * individual account can still secure documents one at a time via the
 * existing single-document flow.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { anchorBulkRouter } from './anchor-bulk.js';

const router = Router();

/**
 * Resolve the org for the JWT-authenticated caller and synthesize the
 * `req.apiKey` shape `anchorBulkRouter` expects. Writes the response and
 * returns without calling `next()` on any failure.
 */
async function resolveDashboardBulkCaller(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = req.authUserId;
  if (!userId) {
    res.status(401).json({
      error: 'authentication_required',
      message: 'Supabase session authentication required',
    });
    return;
  }

  const { data: profile, error } = await db
    .from('profiles')
    .select('org_id')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    logger.error({ error, userId }, 'anchor-bulk self-service: profile lookup failed');
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to verify permissions',
    });
    return;
  }

  if (!profile?.org_id) {
    res.status(403).json({
      error: 'organization_required',
      message: 'Mixed-format batch anchoring requires an organization account. Secure documents one at a time, or contact your organization to get access.',
    });
    return;
  }

  // Synthetic API-key-shaped caller — org write scope only, never persisted,
  // never a real key. Distinct keyId prefix keeps its rate-limit bucket
  // separate from real API keys sharing the same org.
  req.apiKey = {
    keyId: `dashboard-session:${userId}`,
    orgId: profile.org_id,
    userId,
    scopes: ['anchor:write'],
    rateLimitTier: 'free',
    keyPrefix: 'session_',
  };

  next();
}

router.use(resolveDashboardBulkCaller, anchorBulkRouter);

export { router as anchorBulkSelfServiceRouter };
