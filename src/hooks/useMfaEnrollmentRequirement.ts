/**
 * MFA Enrollment Requirement — mandatory MFA enforcement tier.
 *
 * Answers ONE question, independent of session/AAL state: is MFA mandatory
 * for THIS user's role? Enforcement-tier decision (see PR description for
 * full rationale): mandatory now for ORG_ADMIN and platform admins — the
 * highest blast-radius accounts (org-wide data access, admin surfaces
 * gated by `PlatformAdminRoute`). A grace-window rollout for
 * ORG_MEMBER/INDIVIDUAL is proposed but deliberately NOT implemented here.
 *
 * Deliberately independent of `useProfile()` (React Query + Context) so
 * `AuthGuard` — the single choke point every authenticated route renders
 * through — has no dependency on a context provider being mounted above
 * it. Mirrors `useMfaAssurance`'s self-contained fetch pattern exactly,
 * including its fail-open safety contract and its "never trust stale
 * state for a different userId" render-time derivation.
 *
 * SAFETY: fails to `mfaRequired: false` on any query error. A transient DB
 * error must never be the reason this hook incorrectly reports "not
 * required" for a real admin (that would just mean one extra unblocked
 * page load, self-healing on the next check) — but the FAR worse failure
 * direction would be a bug that treats an ordinary user as "required" and
 * traps them behind a block they cannot resolve. `false` is the
 * unconditionally safe default in both directions: it never blocks anyone
 * who shouldn't be, at the cost of occasionally not enforcing someone who
 * should be until the next successful check.
 */

import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';

interface UseMfaEnrollmentRequirementResult {
  loading: boolean;
  mfaRequired: boolean;
}

interface RequirementState {
  userId: string | null;
  mfaRequired: boolean;
}

export function useMfaEnrollmentRequirement(userId: string | null): UseMfaEnrollmentRequirementResult {
  const [state, setState] = useState<RequirementState>({ userId: null, mfaRequired: false });

  useEffect(() => {
    if (!userId) {
      // No setState needed — see the render-time derivation below and the
      // matching comment in useMfaAssurance.ts (react-hooks/set-state-in-effect).
      return;
    }

    let cancelled = false;

    async function check() {
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('role, is_platform_admin')
          .eq('id', userId as string)
          .single();

        if (cancelled) return;

        if (error || !data) {
          setState({ userId, mfaRequired: false });
          return;
        }

        const mfaRequired = data.role === 'ORG_ADMIN' || data.is_platform_admin === true;
        setState({ userId, mfaRequired });
      } catch {
        if (cancelled) return;
        setState({ userId, mfaRequired: false });
      }
    }

    void check();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // `state` only reflects a completed check for `state.userId`. While a
  // check for a NEW userId is still in flight, report loading rather than
  // a stale answer for a different user — closes the identical
  // one-render-flash race useMfaAssurance guards against.
  if (state.userId !== userId) {
    return { loading: Boolean(userId), mfaRequired: false };
  }

  return { loading: false, mfaRequired: state.mfaRequired };
}
