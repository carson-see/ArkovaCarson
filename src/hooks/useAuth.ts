/**
 * Authentication Hook
 *
 * Provides authentication state and methods for React components.
 */

import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { clearMfaAssuranceCache } from './useMfaAssurance';
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
  signUp: (
    email: string,
    password: string,
    fullName?: string
  ) => Promise<{ error: import('@supabase/supabase-js').AuthError | null; session: Session | null }>;
  resendSignUpConfirmation: (
    email: string
  ) => Promise<{ error: import('@supabase/supabase-js').AuthError | null }>;
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
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: {
              full_name: fullName,
            },
            // SCRUM-2907: nominate the app-owned landing route for the emailed
            // confirmation link. Without this, Supabase falls back to the
            // project Site URL — the app has no say in where the link lands, so
            // a dead link drops the user on `/` with nothing to explain it.
            // `/auth/callback` is the one destination Supabase will honour: it
            // is already in the project's additional_redirect_urls allow-list
            // for localhost, app.arkova.ai, and the Vercel preview origin.
            emailRedirectTo: `${window.location.origin}/auth/callback`,
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
          return { error, session: null };
        }

        setLoading(false);
        // SCRUM-2907: Surface the session so callers can distinguish an
        // auto-confirmed signup (live session → user is already logged in) from
        // a confirmation-pending signup (null session → "check your email").
        // When email confirmation is required, Supabase returns a user but a
        // null session; with auto-confirm on it returns a live session.
        return { error: null, session: data.session };
      } catch (err) {
        setError('Unable to reach the server. Please check your connection and try again.');
        setLoading(false);
        return { error: err as import('@supabase/supabase-js').AuthError, session: null };
      }
    },
    []
  );

  const resendSignUpConfirmation = useCallback(async (email: string) => {
    setError(null);

    try {
      const { error } = await supabase.auth.resend({
        type: 'signup',
        email,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      });

      if (error) {
        const msg = error.message?.toLowerCase() ?? '';
        if (msg.includes('failed to fetch') || msg.includes('networkerror') || msg.includes('load failed')) {
          setError('Unable to reach the server. Please check your connection and try again.');
        } else {
          setError(error.message);
        }
      }

      return { error };
    } catch (err) {
      setError('Unable to reach the server. Please check your connection and try again.');
      return { error: err as import('@supabase/supabase-js').AuthError };
    }
  }, []);

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
    // R11 (PR #2637 review round 2): also clear the assurance-check module
    // cache — a genuinely new sign-in always mints a fresh session token,
    // which already makes the cache naturally miss on its own (see that
    // hook's module doc comment), but clearing it explicitly here is a
    // belt-and-suspenders measure that costs nothing.
    clearMfaAssuranceCache();

    // Set flag BEFORE any state changes so AuthGuard won't show
    // misleading "sign in required" toast during the sign-out transition.
    // Wrapped in try/catch (CTO ruling A4-10, SCRUM-3167): a private-
    // browsing or storage-disabled environment throwing here must not
    // prevent sign-out itself from completing — losing the "just signed
    // out" toast suppression is a cosmetic regression, but blocking
    // sign-out entirely would be a lockout the user cannot self-resolve.
    try {
      sessionStorage.setItem('arkova_signed_out', '1');
    } catch {
      // ignore storage access errors in restricted environments
    }

    setLoading(true);
    setError(null);

    const { error } = await supabase.auth.signOut();

    if (error) {
      // Same rationale as the setItem above (A4-10 / PR #2637 review item
      // 29) — a throwing removeItem must not crash the signOut() error
      // path. Worst case the flag lingers and self-corrects the next time
      // AuthGuard's redirect-toast effect reads and clears it.
      try {
        sessionStorage.removeItem('arkova_signed_out');
      } catch {
        // ignore storage access errors in restricted environments
      }
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
    resendSignUpConfirmation,
    signInWithGoogle,
    signInWithLinkedIn,
    signOut,
    clearError,
  };
}
