/**
 * Compliance Auth Helpers
 *
 * Shared authentication utilities for compliance API routes.
 */

import { Request, Response } from 'express';
import { db } from '../utils/db.js';
import { getCallerOrgId as resolveProfileOrgId } from '../api/_org-auth.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = db as any;

/**
 * Resolve the caller's org id for compliance routes.
 *
 * Resolves via the SAME canonical precedence the rest of the worker uses — see
 * `src/api/_org-auth.ts` (the designated single source of truth for this lookup
 * "so handlers don't each re-implement / drift on the auth fallback rules"),
 * `orgVerification.ts`, and the `get_user_org_id()` SQL helper /
 * `useCanIssueCredential` on the DB + client side:
 *
 *   1. `profiles.org_id` — the canonical "current org" link. An org OWNER is
 *      attached to their org this way; it drives the dashboard "Managing X"
 *      header. The happy-path onboarding RPC sets `profiles.org_id` on the
 *      creator, but a matching `org_members` 'owner' row is not guaranteed for
 *      every owner — so the previous `org_members`-only resolution wrongly
 *      403'd owners with "Must belong to an organization" (prod UAT 2026-06-24).
 *   2. `org_members` — multi-org membership, used only as a fallback so a member
 *      linked solely via `org_members` (no `profiles.org_id`) still resolves.
 *      Uses `limit(1).maybeSingle()` (NOT `.single()`) so a user in 2+ orgs is
 *      not collapsed to a 403 on a "more than one row" error.
 *
 * Sends 401/403 and returns null when auth fails or no org can be resolved.
 */
export async function getCallerOrgId(req: Request, res: Response): Promise<string | null> {
  if (!req.authUserId) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }

  // Primary: canonical profiles.org_id resolution shared with the rest of the
  // worker. This is where org owners are linked.
  const profileOrgId = await resolveProfileOrgId(req.authUserId);
  if (profileOrgId) {
    return profileOrgId;
  }

  // Fallback: an org_members row for users linked only via membership.
  const { data: membership } = await dbAny
    .from('org_members')
    .select('org_id')
    .eq('user_id', req.authUserId)
    .limit(1)
    .maybeSingle();

  if (membership?.org_id) {
    return membership.org_id as string;
  }

  res.status(403).json({ error: 'Must belong to an organization' });
  return null;
}
