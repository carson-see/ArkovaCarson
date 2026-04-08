/**
 * OAuth Callback Page
 *
 * Handles the redirect from Supabase OAuth (Google sign-in).
 * Waits for Supabase to process the hash fragment (#access_token=...)
 * before redirecting to the appropriate destination.
 */

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { ROUTES } from '@/lib/routes';

export function AuthCallbackPage() {
  const navigate = useNavigate();

  useEffect(() => {
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
  }, [navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-4">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">Completing sign in...</p>
      </div>
    </div>
  );
}
