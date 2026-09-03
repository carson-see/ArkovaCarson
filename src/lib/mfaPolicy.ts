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
 * Every candidate at every tier is validated with `z.string().datetime()`
 * (CTO ruling A4-9; R10, PR #2637 review round 2 — replaces a hand-rolled
 * regex with Zod's built-in ISO-datetime validator, this repo's existing
 * validation dependency) before use; anything that fails validation is
 * treated as absent and resolution falls through to the next tier. Zod's
 * default (`offset: false`) accepts ONLY a `Z`-suffixed UTC instant with
 * optional fractional seconds — no numeric offset, no missing `Z`, and it
 * validates real calendar values (rejects month 13, Feb 30/29-on-a-
 * non-leap-year, hour 25, etc.), which the prior regex did not. An
 * ambiguous date must never silently become "enforcement never starts"
 * (fails toward the baked default, not toward "no enforcement").
 *
 * `import.meta.env.*` and `localStorage` are read live, inside the
 * functions that use them (never cached at module scope) — the same
 * pattern `getAppBaseUrl` in `routes.ts` uses — so `vi.stubEnv` works in
 * tests without `vi.resetModules()`.
 */

import { z } from 'zod';
import type { Database } from '@/types/database.types';
import { readItem } from './safeStorage';

/** R14 (PR #2637 review round 2): exported so callers outside this module
 * (e.g. `e2e/helpers/mfa.ts`'s `setEnforceDateOverride`) reference the same
 * constant instead of duplicating the string literal. */
export const MFA_ENFORCE_FROM_OVERRIDE_KEY = 'arkova_mfa_enforce_from_override';

const utcDateTimeSchema = z.string().datetime();

/**
 * Baked so the enforcement deadline is real even with zero environment
 * configuration. Two weeks out from the CTO plan's authoring date
 * (2026-09-03), giving Carson time to enroll the shared UAT demo account
 * and complete the founder-reserved go-live checklist items before it bites.
 */
export const MFA_ADMIN_ENFORCE_FROM_DEFAULT = '2026-09-21T00:00:00Z';

const DAY_MS = 24 * 60 * 60 * 1000;

function isValidUtcDateString(value: unknown): value is string {
  return utcDateTimeSchema.safeParse(value).success;
}

function readDateOverride(): string | null {
  const overrideAllowed =
    import.meta.env.DEV === true || import.meta.env.VITE_MFA_ALLOW_DATE_OVERRIDE === 'true';
  if (!overrideAllowed) return null;

  // R8 (PR #2637 review round 2): shared safeStorage.readItem — see that
  // module's doc comment for why the try/catch here matters even in this
  // repo's own test environment, not just real private-browsing.
  return readItem(localStorage, MFA_ENFORCE_FROM_OVERRIDE_KEY);
}

/** Resolve the effective MFA enforcement instant, per the precedence above. */
export function resolveMfaEnforceFrom(): string {
  const override = readDateOverride();
  if (isValidUtcDateString(override)) return override;

  const envValue = import.meta.env.VITE_MFA_ENFORCE_FROM;
  if (isValidUtcDateString(envValue)) return envValue;

  return MFA_ADMIN_ENFORCE_FROM_DEFAULT;
}

/**
 * Inclusive boundary: enforcement is active AT the enforcement instant, not
 * only strictly after it.
 *
 * `enforceFrom` (item 18/EA4): most callers can omit it and let this
 * function resolve the date itself. A caller that ALSO needs the resolved
 * date for something else in the same render (e.g. `AuthGuard` threading it
 * down to `MfaGraceNudge`) should resolve it once via `resolveMfaEnforceFrom()`
 * and pass it here, instead of this function (and `getMfaGraceDaysRemaining`)
 * each re-resolving it independently — up to 3 resolutions per render
 * otherwise, all reading the same env/localStorage inputs.
 */
export function isMfaEnforcementActive(
  now: number = Date.now(),
  enforceFrom: string = resolveMfaEnforceFrom(),
): boolean {
  const enforceFromMs = Date.parse(enforceFrom);
  return now >= enforceFromMs;
}

/**
 * Whole days remaining until enforcement, rounded UP, floored at 0 (never
 * negative). See `isMfaEnforcementActive`'s doc comment for `enforceFrom`.
 */
export function getMfaGraceDaysRemaining(
  now: number = Date.now(),
  enforceFrom: string = resolveMfaEnforceFrom(),
): number {
  const enforceFromMs = Date.parse(enforceFrom);
  const remainingMs = enforceFromMs - now;
  if (remainingMs <= 0) return 0;
  return Math.ceil(remainingMs / DAY_MS);
}

/**
 * The subset of a profile row this policy needs. `Pick` off the generated
 * `profiles` Row type (item 12/S4/EA2) rather than a hand-rolled
 * `{role?: string|null}` shape, so `role` stays the real
 * `Database['public']['Enums']['user_role']` enum — widening it to a bare
 * `string` would have let a typo'd role value type-check silently.
 */
export type MfaPolicyProfile = Pick<
  Database['public']['Tables']['profiles']['Row'],
  'role' | 'is_platform_admin'
>;

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
