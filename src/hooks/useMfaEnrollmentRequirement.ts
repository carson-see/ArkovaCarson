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
 *
 * `isMfaRequiredRole` / `isMfaEnforcementActive` live in `mfaPolicy.ts` —
 * see that module for the date-resolution precedence and the phase-1
 * role tier (ORG_ADMIN / platform admin).
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
 * (a cheap local re-render, no network call) on a 60s interval and on
 * `visibilitychange` (tab returns to foreground), mirroring
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

import { useEffect, useState } from 'react';
import { useProfile } from './useProfile';
import { isMfaEnforcementActive, isMfaRequiredRole } from '@/lib/mfaPolicy';

interface UseMfaEnrollmentRequirementResult {
  loading: boolean;
  mfaRequired: boolean;
  mfaGraceActive: boolean;
}

// Same cadence as useMfaAssurance's live re-check (A4-11) — kept as two
// independent intervals rather than a shared one so each hook stays
// self-contained and neither depends on the other being mounted.
const REEVALUATE_INTERVAL_MS = 60_000;

export function useMfaEnrollmentRequirement(): UseMfaEnrollmentRequirementResult {
  const { profile, loading, error } = useProfile();

  // Forces a re-render so isMfaEnforcementActive()'s live Date.now() read
  // is re-evaluated periodically / on tab foreground, without touching
  // React Query or issuing any network call.
  const [, forceReevaluate] = useState(0);
  useEffect(() => {
    const intervalId = setInterval(() => {
      forceReevaluate((n) => n + 1);
    }, REEVALUATE_INTERVAL_MS);

    const onVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        forceReevaluate((n) => n + 1);
      }
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }

    return () => {
      clearInterval(intervalId);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  }, []);

  // Fail OPEN on a profile-query error — an unconfirmed role must never be
  // treated as "required". `useProfile()` still returns whatever stale
  // profile it last had on an error, so this deliberately ignores that and
  // treats the role as unknown rather than trusting possibly-stale data.
  const effectiveProfile = error ? null : profile;
  const roleRequired = isMfaRequiredRole(effectiveProfile);
  const enforcementActive = isMfaEnforcementActive();

  return {
    loading,
    mfaRequired: roleRequired && enforcementActive,
    mfaGraceActive: roleRequired && !enforcementActive,
  };
}
