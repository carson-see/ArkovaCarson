/**
 * Dual-mode scope enforcement (SCRUM-1272 / SCRUM-3514).
 *
 * `apiKeyAuth.requireScope` enforces scopes for API-key callers ONLY. Its first
 * two lines are:
 *
 *     if (!req.apiKey) { next(); return; }
 *
 * That fall-through is correct where it is used — `/verify` and `/anchor` allow
 * deliberate anonymous GETs (Constitution §1.10) and rely on other guards — but
 * it means mounting `requireScope` on a **JWT-authenticated** route enforces
 * nothing at all, silently. That is why SCRUM-1272's scope vocabulary shipped
 * while its central acceptance criterion (gate the FERPA/HIPAA/emergency-access
 * routes) did not: there was no scope source for a JWT caller, so the mount
 * would have been decorative.
 *
 * `requireScopeAnyAuth` is the missing path. It resolves a scope grant for
 * WHICHEVER auth mode is in play and has no pass-through branch — every code
 * path ends in `next()`, 401, 403 or 500:
 *
 *   - **API key** (`req.apiKey`) — the key's own `scopes`, via the same
 *     `scopeSatisfies` vocabulary as `requireScope`. Identical 403 body, so the
 *     published error contract is unchanged (Constitution §1.8).
 *   - **Supabase JWT** (`req.authUserId` / `req.userId`, set by a real
 *     `requireAuth` upstream) — the caller's org role, optionally NARROWED by a
 *     `scopes` claim on the presented token.
 *   - **Neither** — 401. This is the branch that makes the guard impossible to
 *     mount as a no-op.
 *
 * ## Why claims can only narrow
 *
 * The role-derived set is the ceiling; a token's `scopes` claim is intersected
 * with it, never unioned. Two reasons:
 *
 *  1. It makes downscoped/delegated tokens genuinely enforceable today, which is
 *     the point of a claims path, without waiting on an access-token hook to
 *     exist in every environment.
 *  2. The claims are read by DECODING the bearer token, not by re-verifying it.
 *     That is safe here — this middleware only ever runs after a `requireAuth`
 *     that cryptographically verified the very same token and set
 *     `req.authUserId`, and the decoded `sub` is cross-checked against it — but
 *     "can only subtract" means even a mis-wiring of that ordering cannot turn
 *     an unverified claim into a privilege grant. Do not change the intersection
 *     to a union.
 *
 * ## Why the role mapping is coarse
 *
 * `compliance:read` for any org-affiliated caller, `compliance:write` for org
 * and platform admins. This layer is a CAPABILITY gate, not the tenant boundary
 * and not the per-route privilege check — `requireOrgId` still validates real
 * membership against `x-org-id`, and `requireOrgAdmin` still gates the
 * admin-only routes inside each router. Deriving anything finer here would
 * duplicate (and eventually drift from) those two.
 *
 * ## Residual — the one caller this can newly refuse
 *
 * A verified `auth.users` identity with NO `public.profiles` row gets an empty
 * grant and a 403. Signup creates that row by trigger, but `org_members.user_id`
 * references `auth.users`, not `profiles`, so an org member without a profile is
 * schema-permissible and `isUserMemberOfOrgResult` would still have admitted
 * them. On a PHI/PII surface that is denied deliberately — granting on the
 * ABSENCE of the record we authorize from is the fail-open pattern this
 * codebase has been bitten by before (see `aiFeatureGate.ts`'s 2026-06-05
 * note). The denial is logged at warn so a real occurrence is diagnosable
 * instead of an unexplained 403.
 */

import type { Request, Response, NextFunction } from 'express';
import { decodeJwt } from 'jose';
import { getCallerProfileResult, type CallerProfile } from '../api/_org-auth.js';
import { scopeSatisfies } from '../api/apiScopes.js';
import { logger } from '../utils/logger.js';

/** Scopes an org or platform administrator holds by virtue of their role. */
export const ADMIN_JWT_SCOPES: readonly string[] = ['compliance:read', 'compliance:write'];

/** Scopes any other org-affiliated caller holds by virtue of their role. */
export const MEMBER_JWT_SCOPES: readonly string[] = ['compliance:read'];

/**
 * Extract an explicit scope grant from verified JWT claims.
 *
 * Recognises the spellings a Supabase custom-access-token hook or an OAuth
 * authorization server may emit: a `scopes` array, an RFC 6749 §3.3
 * space-delimited `scope` string, and either nested under `app_metadata`.
 *
 * Returns `null` when the token asserts NO scope grant at all (the ordinary
 * case today) so the caller can fall back to the role-derived set, and `[]` for
 * a token that explicitly grants nothing — the two are not the same.
 */
export function scopesFromJwtClaims(claims: unknown): string[] | null {
  if (typeof claims !== 'object' || claims === null) return null;
  const record = claims as Record<string, unknown>;
  const appMetadata = typeof record.app_metadata === 'object' && record.app_metadata !== null
    ? (record.app_metadata as Record<string, unknown>)
    : {};

  for (const candidate of [record.scopes, record.scope, appMetadata.scopes, appMetadata.scope]) {
    if (Array.isArray(candidate)) {
      return candidate.filter((entry): entry is string => typeof entry === 'string');
    }
    if (typeof candidate === 'string') {
      return candidate.split(/[\s,]+/).filter(Boolean);
    }
  }

  return null;
}

/**
 * Decode the presented bearer token's claims, if it is a Supabase-style JWT
 * belonging to `verifiedUserId`.
 *
 * NOT a verification step — see the module header. Returns `null` for an API
 * key bearer (`ak_…`), a malformed token, or a `sub` that does not match the
 * already-verified caller id.
 */
function readPresentedClaims(req: Request, verifiedUserId: string): Record<string, unknown> | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ') || header.startsWith('Bearer ak_')) return null;

  try {
    const claims = decodeJwt(header.slice(7));
    if (claims.sub !== verifiedUserId) return null;
    return claims as Record<string, unknown>;
  } catch {
    // A token that survived requireAuth but will not decode here is not a
    // reason to deny — the role-derived grant still applies.
    return null;
  }
}

/** Map a profile row to the scope ceiling its role confers. */
function scopesForProfile(profile: CallerProfile): string[] {
  if (profile.is_platform_admin === true || profile.role === 'ORG_ADMIN') return [...ADMIN_JWT_SCOPES];
  return [...MEMBER_JWT_SCOPES];
}

function denyInsufficientScope(res: Response, scope: string, granted: string[]): void {
  res.status(403).json({
    error: 'insufficient_scope',
    message: `This caller does not have the required scope: ${scope}`,
    required: scope,
    granted,
  });
}

/**
 * Require `scope` of an API-key caller OR a JWT caller. Never falls through.
 *
 * Mount AFTER the route's `requireAuth` (so `req.authUserId` is populated) and
 * before the route's rate limiter, mirroring the `/keys` chain
 * (`requireAuth, requireScope('keys:manage')`).
 */
export function requireScopeAnyAuth(scope: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // ─── API key mode ───
    if (req.apiKey) {
      const granted = req.apiKey.scopes ?? [];
      if (!scopeSatisfies(granted, scope)) {
        denyInsufficientScope(res, scope, granted);
        return;
      }
      next();
      return;
    }

    // ─── JWT mode ───
    const userId = req.authUserId ?? req.userId ?? null;
    if (!userId) {
      // No API key AND no verified JWT identity. requireScope would call
      // next() here; this guard must not.
      res.status(401).json({
        error: 'authentication_required',
        message: 'Authentication is required for this endpoint.',
      });
      return;
    }

    const { value: profile, error } = await getCallerProfileResult(userId);
    if (error) {
      // Fail closed but observable — never mask an operational fault as a 403
      // (same rule as requireOrgId / requireOrgAdmin).
      logger.error({ userId, scope }, 'requireScopeAnyAuth: profile lookup failed');
      res.status(500).json({ error: 'Internal server error' });
      return;
    }
    if (!profile) {
      // A verified auth.users identity with no `profiles` row. The signup
      // trigger normally creates one, but `org_members.user_id` FKs to
      // `auth.users` (not `profiles`), so an org member without a profile is
      // schema-permissible. On a PHI/PII surface that anomaly is denied, not
      // granted — but it is logged at warn so a prod occurrence is diagnosable
      // rather than an unexplained 403. See this file's "Residual" note.
      logger.warn({ userId, scope }, 'requireScopeAnyAuth: no profile row for verified caller — denying');
      denyInsufficientScope(res, scope, []);
      return;
    }

    const roleScopes = scopesForProfile(profile);
    const claimScopes = scopesFromJwtClaims(readPresentedClaims(req, userId));
    // Intersection, never union: a claim may only subtract from the role's
    // ceiling. See the module header before changing this.
    const granted = claimScopes === null
      ? roleScopes
      : roleScopes.filter((candidate) => claimScopes.includes(candidate));

    if (!scopeSatisfies(granted, scope)) {
      denyInsufficientScope(res, scope, granted);
      return;
    }

    next();
  };
}
