/**
 * Authentication Hook
 *
 * Provides authentication state and methods for React components.
 */

import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import type { User, Session } from '@supabase/supabase-js';

type OAuthProvider = Parameters<typeof supabase.auth.signInWithOAuth>[0]['provider'];

interface AuthState {
  user: User | null;
  session: Session | null;
  loading: boolean;
  error: string | null;
}

interface AuthActions {
  signIn: (email: string, password: string) => Promise<{ error: import('@supabase/supabase-js').AuthError | null }>;
  signUp: (email: string, password: string, fullName?: string) => Promise<{ error: import('@supabase/supabase-js').AuthError | null }>;
  signInWithGoogle: () => Promise<void>;
  signInWithLinkedIn: () => Promise<void>;
  signOut: () => Promise<void>;
  clearError: () => void;
}

export function useAuth(): AuthState & AuthActions {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Get initial session — clear any corrupt/stale session on error so the
    // user always lands on a working login page instead of "Failed to fetch".
    supabase.auth.getSession().then(({ data: { session }, error }) => {
      if (error) {
        // Any getSession error (oauth_client_id, expired refresh token,
        // network issue, corrupt localStorage) → clear local session and
        // let the user sign in fresh. Never surface init errors in the UI.
        supabase.auth.signOut({ scope: 'local' }).catch(() => {});
        setSession(null);
        setUser(null);
        setLoading(false);
        return;
      }
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
    }).catch(() => {
      // Network-level failure (TypeError: Failed to fetch) — clear any
      // stale session so the login page renders cleanly.
      supabase.auth.signOut({ scope: 'local' }).catch(() => {});
      setLoading(false);
    });

    // Listen for auth changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      // Ignore SIGNED_OUT events triggered by our own corrupt-session cleanup
      if (event === 'SIGNED_OUT' && !session) {
        setSession(null);
        setUser(null);
        setLoading(false);
        return;
      }
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    setLoading(true);
    setError(null);

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        // Translate raw network errors into a user-friendly message
        const msg = error.message?.toLowerCase() ?? '';
        if (msg.includes('failed to fetch') || msg.includes('networkerror') || msg.includes('load failed')) {
          setError('Unable to reach the server. Please check your connection and try again.');
        } else {
          setError(error.message);
        }
      }

      setLoading(false);
      return { error };
    } catch (err) {
      // Catch unexpected throws (e.g. TypeError from fetch)
      setError('Unable to reach the server. Please check your connection and try again.');
      setLoading(false);
      return { error: err as import('@supabase/supabase-js').AuthError };
    }
  }, []);

  const signUp = useCallback(
    async (email: string, password: string, fullName?: string) => {
      setLoading(true);
      setError(null);

      try {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: {
              full_name: fullName,
            },
          },
        });

        if (error) {
          const msg = error.message?.toLowerCase() ?? '';
          if (msg.includes('failed to fetch') || msg.includes('networkerror') || msg.includes('load failed')) {
            setError('Unable to reach the server. Please check your connection and try again.');
          } else {
            setError(error.message);
          }
          setLoading(false);
          return { error };
        }

        setLoading(false);
        return { error: null };
      } catch (err) {
        setError('Unable to reach the server. Please check your connection and try again.');
        setLoading(false);
        return { error: err as import('@supabase/supabase-js').AuthError };
      }
    },
    []
  );

  const signInWithProvider = useCallback(async (provider: OAuthProvider) => {
    setLoading(true);
    setError(null);

    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: `${location.origin}/auth/callback`,
        },
      });

      if (error) {
        const msg = error.message?.toLowerCase() ?? '';
        if (msg.includes('failed to fetch') || msg.includes('networkerror') || msg.includes('load failed')) {
          setError('Unable to reach the server. Please check your connection and try again.');
        } else {
          setError(error.message);
        }
        setLoading(false);
      }
    } catch {
      setError('Unable to reach the server. Please check your connection and try again.');
      setLoading(false);
    }
    // Note: Loading stays true while the browser redirects to the provider.
  }, []);

  const signInWithGoogle = useCallback(async () => {
    await signInWithProvider('google');
  }, [signInWithProvider]);

  const signInWithLinkedIn = useCallback(async () => {
    await signInWithProvider('linkedin_oidc');
  }, [signInWithProvider]);

  const signOut = useCallback(async () => {
    // Set flag BEFORE any state changes so AuthGuard won't show
    // misleading "sign in required" toast during the sign-out transition
    sessionStorage.setItem('arkova_signed_out', '1');

    setLoading(true);
    setError(null);

    const { error } = await supabase.auth.signOut();

    if (error) {
      sessionStorage.removeItem('arkova_signed_out');
      setError(error.message);
      setLoading(false);
      return;
    }

    // BUG-4 fix: Use hard redirect instead of relying on callers to navigate().
    // React state teardown (profile/user → null) races with component re-render,
    // causing ErrorBoundary "Something went wrong" before navigate() takes effect.
    // Hard redirect avoids the React re-render entirely.
    window.location.href = '/login';
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    user,
    session,
    loading,
    error,
    signIn,
    signUp,
    signInWithGoogle,
    signInWithLinkedIn,
    signOut,
    clearError,
  };
}
