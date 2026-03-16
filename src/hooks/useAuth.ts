/**
 * Authentication Hook
 *
 * Provides authentication state and methods for React components.
 */

import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import type { User, Session } from '@supabase/supabase-js';

interface AuthState {
  user: User | null;
  session: Session | null;
  loading: boolean;
  error: string | null;
}

interface AuthActions {
  signIn: (email: string, password: string) => Promise<{ error: import('@supabase/supabase-js').AuthError | null }>;
  signUp: (email: string, password: string, fullName?: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  clearError: () => void;
}

export function useAuth(): AuthState & AuthActions {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Get initial session — suppress known GoTrue oauth_client_id errors
    supabase.auth.getSession().then(({ data: { session }, error }) => {
      if (error) {
        // Known Supabase GoTrue issue: stale session contains fields the server
        // doesn't recognize (e.g. oauth_client_id). Clear the corrupt session
        // so subsequent requests don't re-trigger the error.
        if (error.message?.includes('oauth_client_id')) {
          supabase.auth.signOut({ scope: 'local' }).catch(() => {});
          setSession(null);
          setUser(null);
          setLoading(false);
          return;
        }
      }
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
    }).catch(() => {
      // Auth unavailable (e.g. missing credentials) — fall through to login
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

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setError(error.message);
    }

    setLoading(false);
    return { error };
  }, []);

  const signUp = useCallback(
    async (email: string, password: string, fullName?: string) => {
      setLoading(true);
      setError(null);

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
        setError(error.message);
      }

      setLoading(false);
    },
    []
  );

  const signInWithGoogle = useCallback(async () => {
    setLoading(true);
    setError(null);

    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${location.origin}/auth/callback`,
      },
    });

    if (error) {
      setError(error.message);
      setLoading(false);
    }
    // Note: Loading stays true as we're redirecting to Google
  }, []);

  const signOut = useCallback(async () => {
    setLoading(true);
    setError(null);

    const { error } = await supabase.auth.signOut();

    if (error) {
      setError(error.message);
    }

    setLoading(false);
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
    signOut,
    clearError,
  };
}
