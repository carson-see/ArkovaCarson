/**
 * Supabase Client
 *
 * Client-side Supabase client for authentication and data access.
 * Uses anonymous key only - service role key is NEVER exposed to client.
 */

import { createClient } from '@supabase/supabase-js';
import type { Database } from '../types/database.types';
export type { Database } from '../types/database.types';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'http://127.0.0.1:54321';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

if (!supabaseAnonKey) {
  console.warn('VITE_SUPABASE_ANON_KEY not set. Authentication will not work.');
}

// Use a placeholder key when none is configured so the client can instantiate
// without throwing. Auth calls will fail gracefully at runtime instead.
const safeKey = supabaseAnonKey || 'missing-key-placeholder';

/**
 * SCRUM-2907 — capture a failed auth-link error BEFORE the client exists.
 *
 * Supabase reports a dead email link (expired / already used / tampered) by
 * putting `error` + `error_code` in the redirect URL fragment and creating no
 * session. But `detectSessionInUrl: true` CONSUMES that fragment during
 * `createClient` below, and the SCRUM-371 cleanup strips whatever survives —
 * so by the time a route component mounts there is nothing left to read, and
 * an expired link is indistinguishable from "not signed in yet".
 *
 * Reading it here is the fix: this runs before `createClient`, and the client
 * cannot clear a fragment it has not been constructed to look at yet. Caught
 * in local UAT — the component-level read alone silently lost the error and
 * bounced the user to a bare login form, which is the exact bug being fixed.
 */
export interface AuthLinkError {
  expired: boolean;
}

function readAuthLinkErrorFromUrl(): AuthLinkError | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  if (!params.get('error')) return null;
  return { expired: params.get('error_code') === 'otp_expired' };
}

export const authLinkErrorFromUrl: AuthLinkError | null = readAuthLinkErrorFromUrl();

/**
 * Should the app bounce to the auth-callback route so a dead link gets
 * explained?
 *
 * `emailRedirectTo` only governs links minted AFTER it shipped. Links already
 * sitting in inboxes were built against the project Site URL and come back to
 * `/`, which has no idea how to explain a failure — so the users most in need
 * of the explanation are precisely the ones who would never see it.
 *
 * Extracted as a predicate so the decision is unit-testable; the component in
 * `App.tsx` is glue around it.
 */
export function shouldRedirectToAuthCallback(
  linkError: AuthLinkError | null,
  pathname: string,
  authCallbackPath: string,
): boolean {
  if (!linkError) return false;
  // Already there — redirecting again would loop.
  return pathname !== authCallbackPath;
}

export const supabase = createClient<Database>(supabaseUrl, safeKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
  },
});

// SCRUM-371: Strip URL fragment after Supabase has read it to prevent
// access_token from persisting in the address bar or appearing in
// subsequent console error logs / Sentry breadcrumbs.
// Use a delayed cleanup to avoid racing with detectSessionInUrl.
if (typeof window !== 'undefined' && window.location.hash?.includes('access_token')) {
  setTimeout(() => {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, 2000);
}
