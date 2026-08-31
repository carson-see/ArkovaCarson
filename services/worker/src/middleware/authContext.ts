/**
 * The one place that answers "who is the authenticated caller on this request?"
 *
 * Two different `requireAuth` implementations populate the identity under two
 * different field names — `api/v1/router.ts`'s sets `req.authUserId`, while
 * `routes/middleware.ts`'s sets `req.userId` — so every guard downstream has to
 * read both. `requireOrgId.ts` and `requireOrgAdmin.ts` each carried a private
 * copy of that expression and `requireScopeAnyAuth.ts` was about to be a third.
 *
 * A silently drifting copy of an auth-identity lookup is a security bug waiting
 * to happen (it is the same class of hazard `api/_org-auth.ts` centralises the
 * org lookups to avoid), so it lives here once.
 */
import type { Request } from 'express';

/** Resolve the authenticated caller id from whichever `requireAuth` ran upstream. */
export function getAuthenticatedUserId(req: Request): string | null {
  return req.authUserId ?? req.userId ?? null;
}
