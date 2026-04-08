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
    // Supabase automatically detects the hash fragment (#access_token=...)
    // and exchanges it for a session. We listen for that event.
    // IMPORTANT: Do NOT strip the hash fragment before Supabase reads it.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        // Strip the access_token from URL AFTER Supabase has consumed it
        window.history.replaceState(null, '', window.location.pathname);
        navigate(ROUTES.DASHBOARD, { replace: true });
      } else if (event === 'SIGNED_OUT') {
        navigate(ROUTES.LOGIN, { replace: true });
      }
    });

    // Fallback: if no auth event fires within 10s, redirect to dashboard
    // (useAuth's getSession will handle routing from there)
    const timeout = setTimeout(() => {
      navigate(ROUTES.DASHBOARD, { replace: true });
    }, 10000);

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
