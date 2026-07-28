/**
 * Middleware: extract, VALIDATE, and attach the caller's org id.
 *
 * SECURITY (fix, 2026-07-28): this middleware previously read `x-org-id`
 * verbatim off the request and attached it to `req.orgId` with NO check that
 * the authenticated caller actually belongs to that org. Combined with
 * `requireAuth` (which only proves the caller holds a valid Supabase JWT for
 * SOME org), any authenticated Arkova user could impersonate any other org by
 * sending an arbitrary `x-org-id` header — a full cross-tenant authorization
 * bypass on every route mounted behind this middleware (FERPA disclosure log,
 * directory opt-out, HIPAA audit trail, HIPAA emergency-access grants).
 *
 * Fix: the header is now only a DISAMBIGUATION hint for a caller who may
 * belong to more than one org (via `org_members`) — it is never trusted as
 * identity. The middleware resolves the caller's identity from the
 * upstream-verified `req.authUserId` / `req.userId` (set by a real JWT
 * `requireAuth`, never by this header) and validates the requested org
 * against real membership via `isUserMemberOfOrgResult` — the SAME
 * single-source-of-truth helper (`api/_org-auth.ts`) already used by the
 * codebase's other correct org-scoped routes (`org-cpe-log-export.ts`,
 * `version-resolution.ts`, `signatureCompliance.ts`). A header naming an org
 * the caller does not belong to is REJECTED with 403, never silently trusted.
 *
 * A DB/operational error during the membership lookup is surfaced as 500 (not
 * masked as a 403), matching the `*Result` fail-closed-but-observable pattern
 * used throughout `_org-auth.ts`.
 *
 * For routes that further need ORG_ADMIN (not merely membership — e.g. the
 * HIPAA audit trail, or approving emergency access), chain `requireOrgAdmin`
 * from `./requireOrgAdmin.js` AFTER this middleware.
 */

import type { Request, Response, NextFunction } from 'express';
import { isUserMemberOfOrgResult } from '../api/_org-auth.js';
import { logger } from '../utils/logger.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      orgId?: string;
    }
  }
}

/** Resolve the authenticated caller id from whichever `requireAuth` ran upstream. */
function getAuthenticatedUserId(req: Request): string | null {
  return req.authUserId ?? req.userId ?? null;
}

export async function requireOrgId(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = getAuthenticatedUserId(req);
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const orgId = req.headers['x-org-id'] as string | undefined;
  if (!orgId) {
    res.status(400).json({ error: 'x-org-id header required' });
    return;
  }

  const { value: isMember, error } = await isUserMemberOfOrgResult(userId, orgId);

  if (error) {
    logger.error({ userId, orgId }, 'requireOrgId: membership lookup failed');
    res.status(500).json({ error: 'Internal server error' });
    return;
  }

  if (!isMember) {
    res.status(403).json({ error: 'Not authorized for this organization' });
    return;
  }

  req.orgId = orgId;
  next();
}
