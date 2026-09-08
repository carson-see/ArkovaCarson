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
 *   1 authLoading                              -> spinner
 *   2 !user                                    -> login redirect / fallback
 *   3 mfaStatus loading                        -> spinner
 *   4 policy loading                           -> spinner
 *   5 challenge_required                       -> <MfaChallenge> (ALWAYS — no cooldown/bypass check)
 *   6 !hasVerifiedFactor && required            -> cooldown active? children : <MfaEnrollmentRequired>
 *   7 mfaGraceActive                           -> <MfaGraceNudge/> ABOVE children
 *   8 (else)                                   -> children
 *
 * FAIL-CLOSED CHALLENGE / FAIL-OPEN ENROLLMENT (CTO ruling, PR #2637 review
 * round 2, R17-R21 — SUPERSEDES the earlier "fail open on any platform
 * error" design that let `onCapabilityUnavailable` short-circuit BOTH the
 * challenge and enrollment branches from one shared top-level flag):
 *
 *   Row 5 (challenge) is checked and rendered UNCONDITIONALLY, before any
 *   cooldown/capability state is even consulted. A user whose assurance
 *   check reports a verified factor (`nextLevel === 'aal2'`) is ALWAYS
 *   challenged — cooldown or not, prior capability trip or not. There is no
 *   code path left that can render `children` for such a user without a
 *   real, successful `challenge()`+`verify()` round trip inside
 *   `MfaChallenge` (which itself now fails CLOSED on every error — see that
 *   component's doc comment). This closes the confirmed bypass: the
 *   capability cooldown used to be a single flag checked BEFORE row 5, so
 *   on a shared browser the NEXT user to sign in (a different person, with
 *   their OWN verified factor) could inherit a still-active cooldown window
 *   from the PREVIOUS user's platform-outage trip and skip MfaChallenge
 *   entirely. The cooldown is now (a) scoped to row 6 only, and (b) keyed
 *   by userId in `mfaCapabilityCooldown.ts`, so it cannot even apply to a
 *   different user in the first place — belt and suspenders.
 *
 *   Row 6 (enrollment) is the ONLY place fail-open is allowed: a user with
 *   NO verified factor whose role requires one, but who cannot complete
 *   enrollment because the MFA platform itself (not their input) is
 *   unavailable. `onCapabilityUnavailable` is `MfaEnrollmentRequired`'s
 *   escape hatch for exactly that case — see its own doc comment. Once
 *   tripped, `children` renders for the rest of THIS instance's life, and
 *   the userId-scoped cooldown seeds that same behavior for OTHER route
 *   instances (and future mounts) for THIS user only, within the window —
 *   see CROSS-INSTANCE COOLDOWN below. An authenticated user is never
 *   permanently walled out of the app by a broken enrollment backend; they
 *   also never get a channel to skip a challenge they could otherwise pass.
 *
 * CROSS-INSTANCE COOLDOWN (item 5/D1, CONFIRMED by the verifier; item 24;
 * re-scoped per R17): every one of the ~52 routes in `App.tsx` mounts its
 * OWN `AuthGuard`. A naive per-instance one-shot ref meant a required-role
 * admin who kept navigating during an MFA-platform outage got a FRESH
 * `enroll()` attempt, plus a toast, plus a Sentry event, on EVERY route
 * change. `src/lib/mfaCapabilityCooldown.ts` is the fix: a cross-instance,
 * time-bounded, per-userId cooldown. This component's local
 * `mfaCapabilityUnavailable` state is seeded from that cooldown (keyed by
 * the CURRENT user) at mount and on every user change, so a fresh instance
 * mounted mid-outage for the SAME user renders children immediately at row
 * 6 without ever mounting `MfaEnrollmentRequired` again; the toast/Sentry
 * emission is gated on the cooldown's own `alreadyArmed` result rather than
 * a per-instance ref, so it fires at most once per cooldown window across
 * every route for that user, not once per route.
 *
 * Every fail-open emits a Sentry `mfa_capability_unavailable` message with
 * `{code, path}` tags (never PII) so a targeted or sustained bypass is
 * visible to the team — SCRUM-3593 (aal2-aware RLS) is the phase-2 control
 * that closes this gap server-side.
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
import { armMfaCapabilityCooldown, isMfaCapabilityCooldownActive } from '../../lib/mfaCapabilityCooldown';
import { MfaChallenge } from './MfaChallenge';
import { MfaEnrollmentRequired } from './MfaEnrollmentRequired';
import { MfaGraceNudge } from './MfaGraceNudge';
import { mfaAssuranceSessionKey } from '../../lib/mfaSessionKey';

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
  const { user, session, loading } = useAuth();
  const location = useLocation();
  const toastShown = useRef(false);
  const hadUser = useRef(false);
  const userId = user?.id ?? null;
  // Ordinary token refresh must not discard an in-progress backup QR.
  // New sign-ins and AAL changes still force a fresh assurance check.
  const sessionKey = mfaAssuranceSessionKey(session?.access_token ?? null, userId);

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
  const { status: mfaStatus, hasVerifiedFactor, markVerified, markBypassed } = useMfaAssurance(
    userId,
    sessionKey,
    session?.access_token ?? null,
  );
  const {
    loading: mfaRequirementLoading,
    mfaRequired,
    mfaGraceActive,
    enforceFromIso,
  } = useMfaEnrollmentRequirement();

  // R17: seeded from the CROSS-INSTANCE, per-userId cooldown so a fresh
  // mount during an active cooldown window for THIS user starts already in
  // the fail-open state — `MfaEnrollmentRequired` is never mounted, so the
  // failing operation is never re-attempted within the window. This flag is
  // consulted ONLY inside the row-6 enrollment branch below — it can never
  // short-circuit row 5 (challenge), which is checked first and
  // unconditionally.
  const [mfaCapabilityUnavailable, setMfaCapabilityUnavailable] = useState(() =>
    isMfaCapabilityCooldownActive(userId ?? '')
  );

  // R17(d): re-derive for the CURRENT user whenever the user changes (sign
  // out + a different sign-in without a full AuthGuard remount, or a stale
  // instance surviving a user switch). Never carry one user's bypass flag
  // forward onto another user — the per-userId cooldown storage already
  // prevents cross-user reads, but this keeps the LOCAL render-time flag
  // honest too.
  const previousUserIdRef = useRef(userId);
  useEffect(() => {
    if (previousUserIdRef.current !== userId) {
      previousUserIdRef.current = userId;
      setMfaCapabilityUnavailable(isMfaCapabilityCooldownActive(userId ?? ''));
    }
  }, [userId]);

  const handleCapabilityUnavailable = useCallback(
    (code: string) => {
      if (!userId) return;
      const { alreadyArmed } = armMfaCapabilityCooldown(userId);
      setMfaCapabilityUnavailable(true);
      // Enrollment-path bypass only (R19/R21): no real verify happened, so
      // tell useMfaAssurance explicitly rather than leaving it implicit —
      // see markBypassed's own doc comment for why this stays a distinct
      // call from markVerified even though hasVerifiedFactor is already
      // `false` on every path that reaches this branch.
      markBypassed();

      // One-shot ACROSS every AuthGuard instance, not per-instance, and
      // scoped to THIS user: only the trip that actually opens a new
      // cooldown window fires the toast/Sentry — a repeat trip while the
      // window is already active (this instance or any other route's
      // instance, for the SAME user) does not.
      if (!alreadyArmed) {
        toast.warning(MFA_CAPABILITY_LABELS.UNAVAILABLE_NOTICE);

        // Lazy-load Sentry to keep it out of the initial bundle — same
        // pattern as RouteErrorBoundary.tsx. Tags only: code + path, never
        // a user id/email or any MFA code the user typed.
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
      }
    },
    [location.pathname, userId, markBypassed]
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

  // Row 5: FAIL CLOSED. A user with a verified factor is ALWAYS challenged
  // on this session (independent of role/tier — voluntary enrollment is
  // honored the same as mandated enrollment), and — per the R17-R21 CTO
  // ruling — this check runs BEFORE and INDEPENDENTLY OF any cooldown or
  // capability-unavailable state. `MfaChallenge` itself never grants access
  // on an error; there is no `onBypassed`/`onCapabilityUnavailable` wired
  // here at all. Only a user with NO factor at all can reach row 6.
  if (mfaStatus === 'challenge_required') {
    return <MfaChallenge onVerified={markVerified} />;
  }

  // Row 6: FORCED ENROLLMENT, NOT A LOCKOUT — the only row where fail-open
  // applies. `mfaStatus` is 'satisfied' here, which given row 5 above means
  // no verified factor exists for this session (`hasVerifiedFactor` is
  // false). A required role with no factor is routed into a completable
  // enrollment screen — rendered INLINE, not via route navigation
  // (`<Navigate>`), so there is no route to redirect to and therefore no
  // possible guard-redirects-to-a-guarded-route loop (see the "NO REDIRECT
  // LOOP" test and MfaEnrollmentRequired.tsx's doc comment for why this
  // must stay completable). If the platform itself cannot issue a factor
  // right now (this instance's own trip, or another route's within the
  // per-userId cooldown window), render `children` instead of trapping an
  // otherwise-authenticated user behind an impossible enrollment screen.
  if (!hasVerifiedFactor && mfaRequired) {
    if (mfaCapabilityUnavailable) {
      return <>{children}</>;
    }
    return (
      <MfaEnrollmentRequired onEnrolled={markVerified} onCapabilityUnavailable={handleCapabilityUnavailable} />
    );
  }

  // Row 7: the enforcement date has not arrived yet for this required-role
  // user — nudge them ABOVE children (children still render; this is a
  // heads-up, not a gate). `enforceFromIso` was already resolved once by
  // useMfaEnrollmentRequirement (item 18/EA4) — passed straight through so
  // MfaGraceNudge doesn't re-resolve the same env/localStorage inputs.
  if (mfaGraceActive) {
    return (
      <>
        <MfaGraceNudge enforceFrom={enforceFromIso} />
        {children}
      </>
    );
  }

  // Row 8: nothing MFA-related pending.
  return <>{children}</>;
}
