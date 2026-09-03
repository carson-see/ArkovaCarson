/**
 * Auth Guard Component
 *
 * Protects routes that require authentication. Redirects to login if user
 * is not authenticated. Also the MFA gate (SCRUM-3167, restoring and
 * hardening PR #1973 / 3572fcd6e): once authenticated, a session that
 * still needs a login challenge, mandatory enrollment, or a pre-enforcement
 * heads-up renders that screen in place of (or, for the nudge, above)
 * `children` — see the inline comments below and
 * `src/components/auth/agents.md` for the full design writeup.
 *
 * DECISION ORDER (first match wins — see AuthGuard.mfaGate.test.tsx for one
 * named test per row):
 *   1 authLoading                    -> spinner
 *   2 !user                          -> login redirect / fallback
 *   3 mfaStatus loading              -> spinner
 *   4 policy loading                 -> spinner
 *   5 mfaCapabilityUnavailable       -> children (+ one-shot toast + Sentry)
 *   6 challenge_required             -> <MfaChallenge>
 *   7 !hasVerifiedFactor && required -> <MfaEnrollmentRequired>
 *   8 mfaGraceActive                 -> <MfaGraceNudge/> ABOVE children
 *   9 (else)                         -> children
 *
 * FAIL-OPEN CAPABILITY GATE (CTO ruling A4-7, accepted phase-1 trade-off):
 * `onCapabilityUnavailable` is the shared escape hatch both `MfaChallenge`
 * and `MfaEnrollmentRequired` call when the MFA PLATFORM itself (not the
 * user's code) is the reason verification/enrollment cannot complete. This
 * is deliberately prioritized ABOVE the challenge/enrollment branches: once
 * set, it renders `children` for the rest of this AuthGuard instance's
 * life, so an authenticated user is never permanently walled out by a
 * broken MFA backend. Every fail-open emits a Sentry `mfa_capability_
 * unavailable` message with `{code, path}` tags (never PII) so a targeted
 * or sustained bypass is visible to the team — SCRUM-3593 (aal2-aware RLS)
 * is the phase-2 control that closes this gap server-side.
 */

import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../hooks/useAuth';
import { useMfaAssurance } from '../../hooks/useMfaAssurance';
import { useMfaEnrollmentRequirement } from '../../hooks/useMfaEnrollmentRequirement';
import { ROUTES } from '../../lib/routes';
import { NAV_POLISH_LABELS, MFA_CAPABILITY_LABELS } from '../../lib/copy';
import { MfaChallenge } from './MfaChallenge';
import { MfaEnrollmentRequired } from './MfaEnrollmentRequired';
import { MfaGraceNudge } from './MfaGraceNudge';

interface AuthGuardProps {
  children: ReactNode;
  fallback?: ReactNode;
}

function Spinner() {
  return (
    <div className="flex items-center justify-center min-h-screen">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
    </div>
  );
}

export function AuthGuard({ children, fallback }: Readonly<AuthGuardProps>) {
  const { user, loading } = useAuth();
  const location = useLocation();
  const toastShown = useRef(false);
  const hadUser = useRef(false);
  const capabilityToastShown = useRef(false);

  // SECURITY (pre-pentest hardening, founder directive 2026-08-03 "MFA
  // needs to be mandatory" + "enforced everytime you login"; phase-1
  // role-based enforcement dates from SCRUM-3167): signInWithPassword()
  // leaves a session at aal1 even when the user has a verified TOTP
  // factor — only an explicit mfa.challenge()/verify() raises it to aal2,
  // and Supabase mints a FRESH aal1 session on every new sign-in
  // regardless of prior sessions (see useMfaAssurance's module doc
  // comment). AuthGuard is the single choke point every authenticated
  // route renders through (see App.tsx), so it is also the one place a
  // page-reload or deep-link mid-challenge cannot slip past. Users with NO
  // enrolled factor, on a role that does NOT (yet) require MFA, are
  // completely unaffected — see useMfaAssurance's and
  // useMfaEnrollmentRequirement's fail-open safety contracts.
  const { status: mfaStatus, hasVerifiedFactor, markVerified } = useMfaAssurance(user?.id ?? null);
  const { loading: mfaRequirementLoading, mfaRequired, mfaGraceActive } = useMfaEnrollmentRequirement();

  const [mfaCapabilityUnavailable, setMfaCapabilityUnavailable] = useState(false);

  const handleCapabilityUnavailable = useCallback(
    (code: string) => {
      setMfaCapabilityUnavailable(true);

      if (!capabilityToastShown.current) {
        capabilityToastShown.current = true;
        toast.warning(MFA_CAPABILITY_LABELS.UNAVAILABLE_NOTICE);
      }

      // Lazy-load Sentry to keep it out of the initial bundle — same
      // pattern as RouteErrorBoundary.tsx. Tags only: code + path, never a
      // user id/email or any MFA code the user typed.
      import('@/lib/sentry')
        .then(({ Sentry: S }) => {
          S.captureMessage('mfa_capability_unavailable', {
            level: 'warning',
            tags: { code, path: location.pathname },
          });
        })
        .catch(() => {
          /* Sentry unavailable */
        });
    },
    [location.pathname]
  );

  // Track whether the user was previously authenticated
  useEffect(() => {
    if (user) {
      hadUser.current = true;
    }
  }, [user]);

  // Show toast when redirecting unauthenticated user (UF-09)
  // Skip toast if user just signed out (had a session, now doesn't)
  // Also skip if sessionStorage flag indicates recent sign-out (survives page reload)
  useEffect(() => {
    if (!loading && !user && !fallback && !toastShown.current && !hadUser.current) {
      let recentlySignedOut = false;
      try {
        recentlySignedOut = sessionStorage.getItem('arkova_signed_out') === '1';
        if (recentlySignedOut) {
          sessionStorage.removeItem('arkova_signed_out');
        }
      } catch {
        // ignore storage access errors in restricted environments
      }
      if (recentlySignedOut) return;
      toastShown.current = true;
      toast.info(NAV_POLISH_LABELS.AUTH_REDIRECT_TOAST);
    }
  }, [loading, user, fallback]);

  // Row 1: authLoading.
  if (loading) {
    return <Spinner />;
  }

  // Row 2: !user.
  if (!user) {
    if (fallback) {
      return <>{fallback}</>;
    }
    // Redirect to login, preserving the intended destination
    return <Navigate to={ROUTES.LOGIN} state={{ from: location }} replace />;
  }

  // Rows 3/4: either check still loading. Same spinner as the auth-loading
  // state above — from the user's perspective this is still "signing you
  // in", not a new loading state. Both must resolve before deciding: a
  // one-render flash of the wrong screen is the same race useMfaAssurance's
  // and useMfaEnrollmentRequirement's own render-time derivations close
  // internally; this is that same discipline applied to combining both.
  if (mfaStatus === 'loading' || mfaRequirementLoading) {
    return <Spinner />;
  }

  // Row 5: the MFA platform itself failed (not the user's code). Render
  // children unconditionally for the rest of this instance's life — see
  // the module doc comment's FAIL-OPEN CAPABILITY GATE section.
  if (mfaCapabilityUnavailable) {
    return <>{children}</>;
  }

  // Row 6: challenge takes priority over enrollment — a user who already
  // has a verified factor is ALWAYS challenged on this session (independent
  // of role/tier — voluntary enrollment is honored the same as mandated
  // enrollment). Only a user with NO factor at all can reach row 7.
  if (mfaStatus === 'challenge_required') {
    return <MfaChallenge onVerified={markVerified} onCapabilityUnavailable={handleCapabilityUnavailable} />;
  }

  // Row 7: FORCED ENROLLMENT, NOT A LOCKOUT. `mfaStatus` is 'satisfied'
  // here, which means EITHER (a) aal2 already reached this session, OR (b)
  // no verified factor exists — `hasVerifiedFactor` distinguishes them. A
  // required role with no factor is routed into a completable enrollment
  // screen — rendered INLINE, not via route navigation (`<Navigate>`), so
  // there is no route to redirect to and therefore no possible
  // guard-redirects-to-a-guarded-route loop (see the "NO REDIRECT LOOP"
  // test and MfaEnrollmentRequired.tsx's doc comment for why this must
  // stay completable).
  if (!hasVerifiedFactor && mfaRequired) {
    return (
      <MfaEnrollmentRequired onEnrolled={markVerified} onCapabilityUnavailable={handleCapabilityUnavailable} />
    );
  }

  // Row 8: the enforcement date has not arrived yet for this required-role
  // user — nudge them ABOVE children (children still render; this is a
  // heads-up, not a gate).
  if (mfaGraceActive) {
    return (
      <>
        <MfaGraceNudge />
        {children}
      </>
    );
  }

  // Row 9: nothing MFA-related pending.
  return <>{children}</>;
}
