/**
 * MFA Enrollment Requirement — mandatory MFA enforcement tier (SCRUM-3167).
 *
 * REWRITE of the PR #1973 (3572fcd6e) version per CTO ruling A4-3:
 * org-level enforcement (`organizations.hipaa_mfa_required`) is DROPPED
 * from phase 1. That column is writable by any org owner/admin via
 * PostgREST (`organizations_update_admin` RLS + GRANT ALL, no column
 * REVOKE, no audit trail), so it cannot be trusted as a security-relevant
 * trigger yet — phase 2 (SCRUM-3593 lineage) gates it behind an audited
 * service-role RPC + column REVOKE migration. This hook therefore issues
 * NO `organizations` query at all, only a role + date check:
 *
 *   mfaRequired    = isMfaRequiredRole(profile) && isMfaEnforcementActive()
 *   mfaGraceActive = isMfaRequiredRole(profile) && !isMfaEnforcementActive()
 *                      && onboardingComplete(profile)
 *
 * `isMfaRequiredRole` / `isMfaEnforcementActive` live in `mfaPolicy.ts` —
 * see that module for the date-resolution precedence and the phase-1
 * role tier (ORG_ADMIN / platform admin).
 *
 * ONBOARDING GATE ON THE NUDGE ONLY (PR #2637 review, item 33): the grace
 * nudge's CTA points at `/settings`, which is a DEAD LINK for an ORG_ADMIN
 * with `org_id === null` — `RouteGuard` bounces that combination straight
 * to `/onboarding/org`, never `/settings`. So `mfaGraceActive` additionally
 * requires `profile.org_id` to be set WHEN `profile.role === 'ORG_ADMIN'`
 * (a platform admin needs no org and is unaffected). The hard block
 * (`mfaRequired`, evaluated once enforcement is active) is DELIBERATELY
 * UNCHANGED by this gate — `AuthGuard` renders before `RouteGuard`, so
 * `MfaEnrollmentRequired` is reachable and completable regardless of
 * onboarding state; only the pre-enforcement heads-up is suppressed until
 * there is somewhere useful for its CTA to send the user.
 *
 * ROLE SOURCE: `useProfile()` (React Query, 60s staleTime), NOT a
 * standalone Supabase query — cached navigation reads the profile
 * synchronously (no spinner flash), and this hook rides whatever
 * dedup/refetch behavior the rest of the app already gets from that cache
 * (CTO ruling A4-6). This means the hook MUST be called from inside
 * `<ProfileProvider>` — every `AuthGuard` render is, per `App.tsx`
 * (`QueryClientProvider` > `BrowserRouter` > `ProfileProvider` wraps every
 * route).
 *
 * LIVE RE-EVALUATION (CTO ruling A4-11): `isMfaEnforcementActive()` is a
 * pure function of wall-clock time, so a component that only re-renders on
 * profile changes would never notice the clock crossing the enforcement
 * instant, or an operator moving `VITE_MFA_ENFORCE_FROM` back via a Vercel
 * redeploy an open tab picks up lazily. This hook forces a re-evaluation
 * (a cheap local re-render, no network call) via the shared
 * `useForegroundInterval` — a 60s interval and `visibilitychange` — mirroring
 * `useMfaAssurance`'s identical cadence.
 *
 * SAFETY: fails to `{ mfaRequired: false, mfaGraceActive: false }` on any
 * profile-query error or a null profile/role. A transient DB error must
 * never be the reason this hook incorrectly reports "required" for an
 * unconfirmed role — the far worse failure direction would be a bug that
 * traps an ordinary user behind a block they cannot resolve. `loading` is
 * true ONLY while the profile is genuinely loading for the first time
 * (mirrors `useProfile()`'s own `loading` — already false immediately for
 * a warm 60s-stale cache hit on navigation).
 */

import { useMemo, useState } from 'react';
import { useProfile } from './useProfile';
import { useForegroundInterval } from './useForegroundInterval';
import { isMfaEnforcementActive, isMfaRequiredRole, resolveMfaEnforceFrom } from '@/lib/mfaPolicy';

interface UseMfaEnrollmentRequirementResult {
  loading: boolean;
  mfaRequired: boolean;
  mfaGraceActive: boolean;
  /**
   * The enforcement date this render evaluated against, already resolved —
   * pass this straight to `<MfaGraceNudge enforceFrom={...} />` (item
   * 18/EA4) instead of letting it re-resolve the same env/localStorage
   * inputs a second time.
   */
  enforceFromIso: string;
}

// Same cadence as useMfaAssurance's live re-check (A4-11).
const REEVALUATE_INTERVAL_MS = 60_000;

export function useMfaEnrollmentRequirement(): UseMfaEnrollmentRequirementResult {
  const { profile, loading, error } = useProfile();

  // Forces a re-render so isMfaEnforcementActive()'s live Date.now() read
  // is re-evaluated periodically / on tab foreground, without touching
  // React Query or issuing any network call.
  const [tick, forceReevaluate] = useState(0);
  useForegroundInterval(() => forceReevaluate((n) => n + 1), REEVALUATE_INTERVAL_MS);

  // Resolved ONCE per re-evaluation (item 18/EA4), not once per call site —
  // isMfaEnforcementActive and the returned enforceFromIso both reuse it.
  // `tick` has no value of its own; bumping it is only how the foreground
  // interval forces this memo to re-sample the live env/localStorage inputs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const enforceFromIso = useMemo(() => resolveMfaEnforceFrom(), [tick]);

  // Fail OPEN on a profile-query error — an unconfirmed role must never be
  // treated as "required". `useProfile()` still returns whatever stale
  // profile it last had on an error, so this deliberately ignores that and
  // treats the role as unknown rather than trusting possibly-stale data.
  const effectiveProfile = error ? null : profile;
  const roleRequired = isMfaRequiredRole(effectiveProfile);
  // `now` omitted (not `Date.now()` inline) so isMfaEnforcementActive's own
  // default parameter reads the clock — an explicit inline Date.now() call
  // here trips react-hooks/purity's "impure during render" rule; the
  // default-parameter form is the same computation without that warning.
  const enforcementActive = isMfaEnforcementActive(undefined, enforceFromIso);

  // Item 33: the grace nudge's CTA is a dead link for an org-id-less
  // ORG_ADMIN (RouteGuard sends them to /onboarding/org, not /settings).
  // Platform admins need no org, so they are unaffected either way.
  const onboardingIncomplete =
    effectiveProfile?.role === 'ORG_ADMIN' && !effectiveProfile?.is_platform_admin && !effectiveProfile?.org_id;

  return {
    loading,
    mfaRequired: roleRequired && enforcementActive,
    mfaGraceActive: roleRequired && !enforcementActive && !onboardingIncomplete,
    enforceFromIso,
  };
}
