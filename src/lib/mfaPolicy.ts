/**
 * MFA enforcement policy — SCRUM-3167.
 *
 * PHASE 1 IS ROLE-BASED ONLY (CTO ruling A4-3, `mfa-cto-plan.md`): the
 * `organizations.hipaa_mfa_required` column is writable by any org
 * owner/admin via PostgREST (no audit, no column REVOKE), so it cannot be
 * trusted as an enforcement trigger yet. Org-level enforcement is a phase-2
 * ticket behind an audited service-role RPC + column REVOKE migration
 * (SCRUM-3593 lineage) — this module has NO `organizations` query and never
 * will until that lands. Enforcement here answers exactly one question:
 * from a given instant, is MFA mandatory for ORG_ADMIN / platform-admin
 * roles?
 *
 * DATE RESOLUTION PRECEDENCE (`resolveMfaEnforceFrom`):
 *   1. `localStorage['arkova_mfa_enforce_from_override']` — read ONLY when
 *      `import.meta.env.DEV === true` OR
 *      `import.meta.env.VITE_MFA_ALLOW_DATE_OVERRIDE === 'true'` (exact
 *      string match, fail-closed to any other value). CTO ruling A4-1: the
 *      override must survive a PRODUCTION BUILD (not just `npm run dev`) so
 *      a soak/E2E preview build can bake the flag in and exercise the real
 *      `MfaEnrollmentRequired` screen against a past date. NEVER set
 *      `VITE_MFA_ALLOW_DATE_OVERRIDE` on Vercel prod — see
 *      docs/reference/ENV.md.
 *   2. `import.meta.env.VITE_MFA_ENFORCE_FROM` — the operator-controlled
 *      rollout date (Carson can move the deadline via a Vercel env change +
 *      redeploy, per the CTO plan, without a code change).
 *   3. `MFA_ADMIN_ENFORCE_FROM_DEFAULT` — the baked constant, so the
 *      deadline is real even with zero env configuration.
 *
 * Every candidate at every tier is validated against a STRICT UTC date
 * regex (CTO ruling A4-9) before use; anything that fails validation is
 * treated as absent and resolution falls through to the next tier. This
 * intentionally rejects non-UTC-suffixed strings, local-time-shaped
 * strings, and garbage — an ambiguous date must never silently become
 * "enforcement never starts" (fails toward the baked default, not toward
 * "no enforcement").
 *
 * `import.meta.env.*` and `localStorage` are read live, inside the
 * functions that use them (never cached at module scope) — the same
 * pattern `getAppBaseUrl` in `routes.ts` uses — so `vi.stubEnv` works in
 * tests without `vi.resetModules()`.
 */

const OVERRIDE_STORAGE_KEY = 'arkova_mfa_enforce_from_override';

/** RFC 3339 UTC instant, seconds-required, optional fractional seconds, `Z` mandatory. */
const STRICT_UTC_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * Baked so the enforcement deadline is real even with zero environment
 * configuration. Two weeks out from the CTO plan's authoring date
 * (2026-09-03), giving Carson time to enroll the shared UAT demo account
 * and complete the founder-reserved go-live checklist items before it bites.
 */
export const MFA_ADMIN_ENFORCE_FROM_DEFAULT = '2026-09-21T00:00:00Z';

const DAY_MS = 24 * 60 * 60 * 1000;

function isValidUtcDateString(value: unknown): value is string {
  return typeof value === 'string' && STRICT_UTC_DATE_RE.test(value) && !Number.isNaN(Date.parse(value));
}

function readDateOverride(): string | null {
  const overrideAllowed =
    import.meta.env.DEV === true || import.meta.env.VITE_MFA_ALLOW_DATE_OVERRIDE === 'true';
  if (!overrideAllowed) return null;

  try {
    return localStorage.getItem(OVERRIDE_STORAGE_KEY);
  } catch {
    // Storage access can throw (private browsing, disabled storage, quota).
    // Fall through to the next precedence tier rather than crashing policy
    // resolution — MFA enforcement must never fail loudly for a UX reason
    // this unrelated to the security decision being made.
    return null;
  }
}

/** Resolve the effective MFA enforcement instant, per the precedence above. */
export function resolveMfaEnforceFrom(): string {
  const override = readDateOverride();
  if (isValidUtcDateString(override)) return override;

  const envValue = import.meta.env.VITE_MFA_ENFORCE_FROM;
  if (isValidUtcDateString(envValue)) return envValue;

  return MFA_ADMIN_ENFORCE_FROM_DEFAULT;
}

/** Inclusive boundary: enforcement is active AT the enforcement instant, not only strictly after it. */
export function isMfaEnforcementActive(now: number = Date.now()): boolean {
  const enforceFromMs = Date.parse(resolveMfaEnforceFrom());
  return now >= enforceFromMs;
}

/** Whole days remaining until enforcement, rounded UP, floored at 0 (never negative). */
export function getMfaGraceDaysRemaining(now: number = Date.now()): number {
  const enforceFromMs = Date.parse(resolveMfaEnforceFrom());
  const remainingMs = enforceFromMs - now;
  if (remainingMs <= 0) return 0;
  return Math.ceil(remainingMs / DAY_MS);
}

/** The subset of a profile row this policy needs — never the whole `Profile` type, to keep this module dependency-light. */
export interface MfaPolicyProfile {
  role?: string | null;
  is_platform_admin?: boolean | null;
}

/**
 * Pure role predicate — phase 1 enforcement tier. ORG_ADMIN and platform
 * admins are the highest blast-radius accounts (org-wide data access,
 * admin surfaces gated by `PlatformAdminRoute`). Fails closed to `false`
 * on a missing/null profile — an unresolved role must never read as
 * "required" (see `useMfaEnrollmentRequirement`'s fail-open contract).
 */
export function isMfaRequiredRole(profile: MfaPolicyProfile | null | undefined): boolean {
  if (!profile) return false;
  return profile.role === 'ORG_ADMIN' || profile.is_platform_admin === true;
}
