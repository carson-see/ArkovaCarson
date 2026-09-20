/**
 * Auth Callback Page
 *
 * Landing route for BOTH Supabase redirect flows:
 *   - OAuth sign-in (Google / LinkedIn), and
 *   - the emailed signup-confirmation link (SCRUM-2907 — `useAuth.signUp`
 *     nominates this route via `emailRedirectTo`).
 *
 * Waits for Supabase to process the hash fragment (#access_token=...) or the
 * PKCE code before redirecting to the appropriate destination.
 *
 * SCRUM-2907: Supabase reports a dead link (expired, already used, tampered)
 * by appending `error` / `error_code` / `error_description` to the redirect
 * URL FRAGMENT. A consumed link can coexist with a session established by its
 * first visit, so only a confirmed, network-validated user matching the locally
 * remembered signup identity may reconcile `otp_expired` as success. Other
 * callback errors remain visible and actionable.
 */

import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Loader2, MailWarning } from 'lucide-react';
import { supabase, authLinkErrorFromUrl } from '@/lib/supabase';
import { isEmailConfirmationPending } from '@/lib/oauthConfirmation';
import type { Session } from '@supabase/supabase-js';
import { ROUTES } from '@/lib/routes';
import { AUTH_CALLBACK_LABELS } from '@/lib/copy';
import {
  clearPendingSignupEmail,
  readPendingSignupEmail,
} from '@/lib/authEmailPolicy';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

interface CallbackError {
  expired: boolean;
}

type CallbackErrorResolution = 'checking' | 'error' | 'signed_in';

/**
 * Supabase puts the failure in the URL fragment, not the query string, because
 * the implicit flow never round-trips through a server. `error_code=otp_expired`
 * is the specific "this link is dead" case worth its own wording; anything
 * else gets the generic treatment rather than a raw provider string, which is
 * neither actionable nor safe to render verbatim.
 */
function readCallbackError(fragment: string): CallbackError | null {
  const params = new URLSearchParams(fragment.replace(/^#/, ''));
  if (!params.get('error')) return null;
  return { expired: params.get('error_code') === 'otp_expired' };
}

export function AuthCallbackPage() {
  const navigate = useNavigate();
  // Prefer the value captured at supabase-module load: `detectSessionInUrl`
  // consumes the fragment during createClient, so by the time this component
  // mounts the error is usually already gone. The live read is the fallback
  // for direct navigation to this route (and keeps this component testable
  // without standing up the real client).
  const [callbackError] = useState<CallbackError | null>(
    () => authLinkErrorFromUrl ?? readCallbackError(window.location.hash),
  );
  const [callbackErrorResolution, setCallbackErrorResolution] = useState<CallbackErrorResolution>(
    callbackError?.expired ? 'checking' : 'error',
  );

  useEffect(() => {
    let redirected = false;

    const goToDestination = (session: Session | null) => {
      if (redirected) return;
      redirected = true;
      window.history.replaceState(null, '', window.location.pathname);
      navigate(isEmailConfirmationPending(session) ? ROUTES.SIGNUP : ROUTES.DASHBOARD, { replace: true });
    };

    const goToLogin = () => {
      if (redirected) return;
      redirected = true;
      navigate(ROUTES.LOGIN, { replace: true });
    };

    if (callbackError) {
      if (!callbackError.expired) return;

      // A link can be consumed successfully and then revisited by the browser
      // or a mail client. Supabase reports the second visit as otp_expired even
      // when the first visit already established this browser's session. The
      // network-validated user and the locally remembered signup identity must
      // both match before treating that as a completed confirmation.
      let cancelled = false;
      let settled = false;
      const validationTimeout = window.setTimeout(() => {
        if (!cancelled && !settled) {
          settled = true;
          setCallbackErrorResolution('error');
        }
      }, 3000);

      void supabase.auth.getUser()
        .then(({ data: { user }, error }) => {
          if (cancelled || settled) return;
          settled = true;
          window.clearTimeout(validationTimeout);
          if (error || !user?.email_confirmed_at) {
            setCallbackErrorResolution('error');
            return;
          }

          const pendingEmail = readPendingSignupEmail();
          if (pendingEmail && user.email?.toLowerCase() === pendingEmail) {
            clearPendingSignupEmail();
            redirected = true;
            window.history.replaceState(null, '', window.location.pathname);
            navigate(ROUTES.DASHBOARD, { replace: true });
            return;
          }

          setCallbackErrorResolution('signed_in');
        })
        .catch(() => {
          if (!cancelled && !settled) {
            settled = true;
            window.clearTimeout(validationTimeout);
            setCallbackErrorResolution('error');
          }
        });
      return () => {
        cancelled = true;
        window.clearTimeout(validationTimeout);
      };
    }

    // Listen for auth state changes — handles both implicit (hash) and PKCE (code) flows.
    // INITIAL_SESSION fires when detectSessionInUrl exchanges the code/hash on page load.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        goToDestination(session);
      } else if (event === 'INITIAL_SESSION') {
        // PKCE flow: detectSessionInUrl already exchanged the code.
        // If a session exists, the user is authenticated.
        if (session) {
          goToDestination(session);
        } else {
          // No session after code exchange — auth failed
          goToLogin();
        }
      } else if (event === 'SIGNED_OUT') {
        goToLogin();
      }
    });

    // Fallback: proactively check for existing session after a short delay.
    // Covers edge cases where onAuthStateChange events fire before listener registration.
    const sessionCheck = setTimeout(async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (session) {
        goToDestination(session);
      } else {
        goToLogin();
      }
    }, 3000);

    // Hard timeout: prevent infinite spinner
    const hardTimeout = setTimeout(() => {
      goToLogin();
    }, 10000);

    return () => {
      subscription.unsubscribe();
      clearTimeout(sessionCheck);
      clearTimeout(hardTimeout);
    };
  }, [navigate, callbackError]);

  if (callbackError && callbackErrorResolution === 'signed_in') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <Card className="w-full max-w-md" role="status">
          <CardHeader className="text-center">
            <CardTitle>{AUTH_CALLBACK_LABELS.SIGNED_IN_TITLE}</CardTitle>
            <CardDescription>{AUTH_CALLBACK_LABELS.SIGNED_IN_DESCRIPTION}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Button asChild className="w-full">
              <Link to={ROUTES.DASHBOARD}>{AUTH_CALLBACK_LABELS.CONTINUE}</Link>
            </Button>
            <Button asChild variant="ghost" className="w-full">
              <Link to={ROUTES.SIGNUP}>{AUTH_CALLBACK_LABELS.REQUEST_NEW_LINK}</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (callbackError && callbackErrorResolution === 'error') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <Card className="w-full max-w-md" role="alert">
          <CardHeader className="text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10 mb-4">
              <MailWarning className="h-8 w-8 text-destructive" />
            </div>
            <CardTitle>
              {callbackError.expired
                ? AUTH_CALLBACK_LABELS.EXPIRED_TITLE
                : AUTH_CALLBACK_LABELS.FAILED_TITLE}
            </CardTitle>
            <CardDescription>
              {callbackError.expired
                ? AUTH_CALLBACK_LABELS.EXPIRED_DESCRIPTION
                : AUTH_CALLBACK_LABELS.FAILED_DESCRIPTION}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Button asChild className="w-full">
              <Link to={ROUTES.SIGNUP}>{AUTH_CALLBACK_LABELS.REQUEST_NEW_LINK}</Link>
            </Button>
            <Button asChild variant="ghost" className="w-full">
              <Link to={ROUTES.LOGIN}>{AUTH_CALLBACK_LABELS.BACK_TO_SIGN_IN}</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-4">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">{AUTH_CALLBACK_LABELS.COMPLETING}</p>
      </div>
    </div>
  );
}
