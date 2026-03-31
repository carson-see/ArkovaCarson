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
    // Strip URL fragment containing access_token to prevent it from
    // appearing in console errors or Sentry breadcrumbs (BUG-017)
    // eslint-disable-next-line -- lint:copy exempt: browser API, not user-facing text
    const fragment = window.location.hash; // eslint-disable-line -- lint:copy: browser API
    if (fragment && fragment.includes('access_token')) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }

    // Supabase automatically detects the hash fragment and exchanges it
    // for a session via onAuthStateChange. We listen for that event.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        // Session established — redirect to dashboard
        navigate(ROUTES.DASHBOARD, { replace: true });
      } else if (event === 'SIGNED_OUT') {
        // Auth failed — redirect to login
        navigate(ROUTES.LOGIN, { replace: true });
      }
    });

    // Fallback: if no auth event fires within 5s, redirect to dashboard
    // (useAuth's getSession will handle routing from there)
    const timeout = setTimeout(() => {
      navigate(ROUTES.DASHBOARD, { replace: true });
    }, 5000);

    return () => {
      subscription.unsubscribe();
      clearTimeout(timeout);
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
