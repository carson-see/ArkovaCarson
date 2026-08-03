/**
 * Auth Guard Component
 *
 * Protects routes that require authentication. Redirects to login if user
 * is not authenticated. Also the MFA gate (2026-08-03): once authenticated,
 * a session that still needs a login challenge or mandatory enrollment
 * renders that screen in place of `children` — see the inline comments
 * below and `src/components/auth/agents.md` for the full design writeup.
 */

import { ReactNode, useEffect, useRef } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../hooks/useAuth';
import { useMfaAssurance } from '../../hooks/useMfaAssurance';
import { useMfaEnrollmentRequirement } from '../../hooks/useMfaEnrollmentRequirement';
import { ROUTES } from '../../lib/routes';
import { NAV_POLISH_LABELS } from '../../lib/copy';
import { MfaChallenge } from './MfaChallenge';
import { MfaEnrollmentRequired } from './MfaEnrollmentRequired';

interface AuthGuardProps {
  children: ReactNode;
  fallback?: ReactNode;
}

export function AuthGuard({ children, fallback }: Readonly<AuthGuardProps>) {
  const { user, loading } = useAuth();
  const location = useLocation();
  const toastShown = useRef(false);
  const hadUser = useRef(false);
  // SECURITY (pre-pentest hardening, founder directive 2026-08-03 "MFA
  // needs to be mandatory" + "enforced everytime you login"):
  // signInWithPassword() leaves a session at aal1 even when the user has a
  // verified TOTP factor — only an explicit mfa.challenge()/verify()
  // raises it to aal2, and Supabase mints a FRESH aal1 session on every
  // new sign-in regardless of prior sessions (verified against auth-js
  // source — see useMfaAssurance's module doc comment). Nothing previously
  // checked this, so an enrolled user's MFA was decorative: a password
  // alone still granted full access, every time. AuthGuard is the single
  // choke point every authenticated route renders through (see App.tsx),
  // so it is also the one place a page-reload or deep-link mid-challenge
  // cannot slip past. Users with NO enrolled factor, on a role that does
  // NOT require MFA, are completely unaffected — see useMfaAssurance's and
  // useMfaEnrollmentRequirement's module doc comments for the fail-open
  // safety contract that guarantees this.
  const { status: mfaStatus, hasVerifiedFactor, markVerified } = useMfaAssurance(user?.id ?? null);
  // ENFORCEMENT TIER (see PR description for full rationale): mandatory
  // for ORG_ADMIN + platform admin now. ORG_MEMBER/INDIVIDUAL are
  // proposed for a grace-window rollout, NOT implemented here.
  const { loading: mfaRequirementLoading, mfaRequired } = useMfaEnrollmentRequirement(user?.id ?? null);

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

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!user) {
    if (fallback) {
      return <>{fallback}</>;
    }

    // Redirect to login, preserving the intended destination
    return <Navigate to={ROUTES.LOGIN} state={{ from: location }} replace />;
  }

  // Same spinner as the auth-loading state above — from the user's
  // perspective this is still "signing you in", not a new loading state.
  // Both checks must resolve before deciding: `mfaRequired` is needed to
  // know whether a no-factor user should be forced into enrollment, so
  // rendering children (or the wrong gate) before it resolves would be a
  // one-render flash of the wrong screen — same race useMfaAssurance's and
  // useMfaEnrollmentRequirement's own render-time derivations close
  // internally; this is that same discipline applied to combining both.
  if (mfaStatus === 'loading' || mfaRequirementLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  // Challenge takes priority over enrollment: a user who already has a
  // verified factor is ALWAYS challenged on this session (independent of
  // role/tier — voluntary enrollment is honored the same as mandated
  // enrollment). Only a user with NO factor at all can reach the
  // enrollment branch below.
  if (mfaStatus === 'challenge_required') {
    return <MfaChallenge onVerified={markVerified} />;
  }

  // FORCED ENROLLMENT, NOT A LOCKOUT: mfaStatus is 'satisfied' here, which
  // means EITHER (a) aal2 already reached this session, OR (b) no
  // verified factor exists. `hasVerifiedFactor` distinguishes them. A
  // required role with no factor is routed into a completable enrollment
  // screen — rendered INLINE, not via route navigation (`<Navigate>`), so
  // there is no route to redirect to and therefore no possible
  // guard-redirects-to-a-guarded-route loop. See
  // AuthGuard.mfaGate.test.tsx's "NO REDIRECT LOOP" test for the explicit
  // proof, and MfaEnrollmentRequired.tsx's doc comment for why this must
  // stay completable rather than becoming a dead end.
  if (!hasVerifiedFactor && mfaRequired) {
    return <MfaEnrollmentRequired onEnrolled={markVerified} />;
  }

  return <>{children}</>;
}
