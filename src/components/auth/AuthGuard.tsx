/**
 * Protected-route gate. A human session receives product content only after
 * mailbox confirmation and a same-user authenticated AAL2 JWT. AAL1 users
 * can complete enrollment or challenge here; every MFA error remains closed.
 */

import { ReactNode, useEffect, useRef } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../hooks/useAuth';
import { isEmailConfirmationPending } from '../../lib/oauthConfirmation';
import { useMfaAssurance } from '../../hooks/useMfaAssurance';
import { ROUTES } from '../../lib/routes';
import { NAV_POLISH_LABELS } from '../../lib/copy';
import { MfaChallenge } from './MfaChallenge';
import { MfaEnrollmentRequired } from './MfaEnrollmentRequired';
import { mfaAssuranceSessionKey, sessionHasAal2 } from '../../lib/mfaSessionKey';

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

  const { status: mfaStatus, hasVerifiedFactor, markVerified } = useMfaAssurance(
    userId,
    sessionKey,
    session?.access_token ?? null,
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

  if (loading) {
    return <Spinner />;
  }

  if (!user) {
    if (fallback) {
      return <>{fallback}</>;
    }
    // Redirect to login, preserving the intended destination
    return <Navigate to={ROUTES.LOGIN} state={{ from: location }} replace />;
  }

  // Mailbox proof has precedence even if the transport session already has AAL2.
  if (isEmailConfirmationPending(session)) {
    return <Navigate to={ROUTES.SIGNUP} replace />;
  }

  if (mfaStatus === 'loading') {
    return <Spinner />;
  }

  if (mfaStatus === 'challenge_required') {
    return <MfaChallenge onVerified={markVerified} />;
  }

  // The signed token is the final authority signal; callbacks cannot unlock it.
  if (!sessionHasAal2(session?.access_token ?? null, userId)) {
    if (!hasVerifiedFactor) {
      return <MfaEnrollmentRequired onEnrolled={markVerified} />;
    }
    return <Spinner />;
  }

  return <>{children}</>;
}
