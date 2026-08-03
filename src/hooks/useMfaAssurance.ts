/**
 * MFA Session Assurance Gate — pre-pentest hardening.
 *
 * Root cause: `supabase.auth.signInWithPassword()` returns a session at
 * Authenticator Assurance Level `aal1` even when the signing-in user has a
 * verified TOTP factor enrolled. Supabase requires an explicit
 * `mfa.challenge()` + `mfa.verify()` round trip to raise the session to
 * `aal2`. Before this hook, nothing in the app ever called
 * `getAuthenticatorAssuranceLevel()`, so a password alone granted full
 * access to any route — an enrolled user's MFA factor was decorative.
 *
 * This hook is consumed by `AuthGuard` (the single choke point every
 * authenticated route renders through) to decide whether the current
 * session still needs a challenge before rendering protected content.
 *
 * EVERY-LOGIN ENFORCEMENT (verified against @supabase/auth-js source,
 * GoTrueClient.js `_getAuthenticatorAssuranceLevel`): `currentLevel` is
 * decoded from the `aal` claim of WHATEVER JWT the current session holds —
 * a stateless, per-session read. Supabase has no "remember this device" or
 * "skip MFA if recently verified" mechanism; a brand new
 * `signInWithPassword()` call always yields a brand new session whose JWT
 * carries `aal1` (password alone cannot mint `aal2` — that would defeat the
 * concept). This hook holds NO persisted "already verified" flag anywhere
 * (no localStorage/sessionStorage/module-level cache) — `markVerified()`
 * only ever sets local `useState` for THIS mounted instance, which is
 * destroyed and recreated on every route navigation (each `<Route>` in
 * App.tsx wraps its own `<AuthGuard>`) and on every full page reload. The
 * practical effect: a second, independent login by an already-enrolled
 * user is challenged again, every time, by construction — there is no
 * shortcut path to bypass. Session restore (refresh token / page reload)
 * is equally safe in EITHER direction: if Supabase's refresh preserves the
 * session's `aal2` (the documented, intended MFA behavior — elevation
 * persists for the life of the session so users aren't re-prompted every
 * ~1h token refresh), the fresh check on remount correctly reports
 * 'satisfied' with no re-prompt; if it did not, the fresh check would
 * correctly report 'challenge_required' again. Either way this hook never
 * grants 'satisfied' from a stale assumption — only from a live read of
 * the CURRENT session's JWT. See `useMfaAssurance.test.ts` for the tests
 * that pin this (second-login re-challenge, session-restore variants).
 *
 * SAFETY CONTRACT — read before changing this file:
 * Every ambiguous/error/timeout outcome below resolves to `'satisfied'`
 * (i.e. do NOT show a challenge). This hook can therefore only ever ADD
 * friction for users who have a verified MFA factor; it can never be the
 * reason a user with no MFA factor is blocked from signing in. That
 * asymmetry is deliberate: an availability incident that locks out every
 * user (including the ~100% of users who have never enrolled MFA) is a far
 * worse outcome than a rare missed MFA challenge.
 */

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';

export type MfaAssuranceStatus = 'loading' | 'satisfied' | 'challenge_required';

interface UseMfaAssuranceResult {
  /** Whether the CURRENT session still needs an MFA challenge. */
  status: MfaAssuranceStatus;
  /**
   * Whether the user has a verified MFA factor enrolled at all, independent
   * of whether THIS session has completed the challenge yet. Derived from
   * the same fetch as `status`; does not change when `markVerified()` is
   * called except to confirm `true` (see markVerified below).
   */
  hasVerifiedFactor: boolean;
  /** Call after a successful mfa.challenge()+mfa.verify() round trip. */
  markVerified: () => void;
}

interface AssuranceState {
  userId: string | null;
  status: MfaAssuranceStatus;
  hasVerifiedFactor: boolean;
}

const SATISFIED_NO_FACTOR: Omit<AssuranceState, 'userId'> = {
  status: 'satisfied',
  hasVerifiedFactor: false,
};

// getAuthenticatorAssuranceLevel() is documented as "fairly quick
// (microseconds) and rarely uses the network" when called without a JWT
// argument (the default — it reads the current session). A budget this
// generous is purely a last-resort circuit breaker for a stalled network
// call; it should never fire in normal operation.
const ASSURANCE_CHECK_TIMEOUT_MS = 8_000;

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error('mfa-assurance-check-timeout')), ms);
  });
}

export function useMfaAssurance(userId: string | null): UseMfaAssuranceResult {
  const [state, setState] = useState<AssuranceState>({ userId: null, ...SATISFIED_NO_FACTOR });

  useEffect(() => {
    if (!userId) {
      // No setState needed: the render-time derivation below already
      // returns 'satisfied' for a null userId regardless of stale `state`
      // (it only trusts `state` when `state.userId === userId`). Calling
      // setState synchronously here would only trigger an extra render for
      // no behavioral benefit (react-hooks/set-state-in-effect).
      return;
    }

    let cancelled = false;

    async function check() {
      try {
        const { data, error } = await Promise.race([
          supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
          timeout(ASSURANCE_CHECK_TIMEOUT_MS),
        ]);

        if (cancelled) return;

        if (error || !data) {
          // Fail OPEN — see module doc comment.
          setState({ userId, ...SATISFIED_NO_FACTOR });
          return;
        }

        const hasVerifiedFactor = data.nextLevel === 'aal2';
        const status: MfaAssuranceStatus =
          data.currentLevel === data.nextLevel ? 'satisfied' : 'challenge_required';
        setState({ userId, status, hasVerifiedFactor });
      } catch {
        if (cancelled) return;
        // Timeout or unexpected throw — fail OPEN. See module doc comment.
        setState({ userId, ...SATISFIED_NO_FACTOR });
      }
    }

    void check();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const markVerified = useCallback(() => {
    setState({ userId, status: 'satisfied', hasVerifiedFactor: true });
  }, [userId]);

  // `state` only reflects a completed check for `state.userId`. If `userId`
  // has already moved on (new login / user switch) but the effect for the
  // new id hasn't resolved yet, the committed `state` is stale — report
  // 'loading' rather than whatever the PREVIOUS user's result was. Without
  // this, a protected route could flash visible for one render before the
  // real check for the new user completes.
  if (state.userId !== userId) {
    return {
      status: userId ? 'loading' : 'satisfied',
      hasVerifiedFactor: false,
      markVerified,
    };
  }

  return {
    status: state.status,
    hasVerifiedFactor: state.hasVerifiedFactor,
    markVerified,
  };
}
