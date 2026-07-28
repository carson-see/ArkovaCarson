/**
 * Middleware: require the authenticated caller to be an ORG_ADMIN (or
 * platform admin) of `req.orgId`.
 *
 * MUST run AFTER `requireOrgId` (../middleware/requireOrgId.js) — it relies
 * on `req.orgId` already being resolved AND membership-validated, and on
 * `req.authUserId` / `req.userId` already being set by a real JWT
 * `requireAuth`. This middleware only ADDS a privilege check on top; it does
 * not re-validate membership itself.
 *
 * Use for routes where org membership alone is too permissive — e.g. reading
 * a HIPAA audit trail, listing/exporting a FERPA disclosure log, or approving
 * a HIPAA emergency-access grant. Least-privilege reasoning per route is
 * documented at each call site (see hipaa-audit.ts, ferpa-disclosures.ts,
 * emergency-access.ts).
 *
 * Delegates to `isCallerOrgAdminResult` — the single source of truth for the
 * admin precedence rule (org_members owner/admin, OR profile ORG_ADMIN
 * scoped to their own org, OR platform admin) already used by
 * `version-resolution.ts` and `signatureCompliance.ts`.
 */

import type { Request, Response, NextFunction } from 'express';
import { isCallerOrgAdminResult } from '../api/_org-auth.js';
import { logger } from '../utils/logger.js';

function getAuthenticatedUserId(req: Request): string | null {
  return req.authUserId ?? req.userId ?? null;
}

export async function requireOrgAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = getAuthenticatedUserId(req);
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const orgId = req.orgId;
  if (!orgId) {
    // Programmer error: requireOrgAdmin was mounted without requireOrgId
    // upstream. Fail closed rather than silently allowing.
    logger.error({ userId }, 'requireOrgAdmin: req.orgId not set — is requireOrgId mounted upstream?');
    res.status(403).json({ error: 'Organization context required' });
    return;
  }

  const { value: isAdmin, error } = await isCallerOrgAdminResult(userId, orgId);

  if (error) {
    logger.error({ userId, orgId }, 'requireOrgAdmin: admin lookup failed');
    res.status(500).json({ error: 'Internal server error' });
    return;
  }

  if (!isAdmin) {
    res.status(403).json({ error: 'Organization administrator role required' });
    return;
  }

  next();
}
