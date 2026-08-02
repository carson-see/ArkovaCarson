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
 * URL FRAGMENT and creating no session. "No session" was previously this
 * page's only signal, so an expired confirmation link was indistinguishable
 * from "not signed in yet" and the user was bounced to a bare login form with
 * nothing explaining why. Read the error off the fragment FIRST, and say what
 * actually happened.
 */

import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Loader2, MailWarning } from 'lucide-react';
import { supabase, authLinkErrorFromUrl } from '@/lib/supabase';
import { ROUTES } from '@/lib/routes';
import { AUTH_CALLBACK_LABELS } from '@/lib/copy';
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

  useEffect(() => {
    // A failed link never produces a session, so none of the session plumbing
    // below can resolve — skip it entirely and leave the explanation on screen.
    if (callbackError) return;

    let redirected = false;

    const goToDashboard = () => {
      if (redirected) return;
      redirected = true;
      window.history.replaceState(null, '', window.location.pathname);
      navigate(ROUTES.DASHBOARD, { replace: true });
    };

    const goToLogin = () => {
      if (redirected) return;
      redirected = true;
      navigate(ROUTES.LOGIN, { replace: true });
    };

    // Listen for auth state changes — handles both implicit (hash) and PKCE (code) flows.
    // INITIAL_SESSION fires when detectSessionInUrl exchanges the code/hash on page load.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        goToDashboard();
      } else if (event === 'INITIAL_SESSION') {
        // PKCE flow: detectSessionInUrl already exchanged the code.
        // If a session exists, the user is authenticated.
        if (session) {
          goToDashboard();
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
        goToDashboard();
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

  if (callbackError) {
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
