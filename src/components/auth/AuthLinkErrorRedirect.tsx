/**
 * SCRUM-2907 — a failed auth link must be explained wherever it lands.
 *
 * `emailRedirectTo` only governs links sent AFTER it shipped. Every link
 * already in a user's inbox was minted against the project Site URL, so it
 * comes back to `/` — not `/auth/callback`, the only route that knows how to
 * explain a dead link. Without this, the users most in need of the explanation
 * (whoever is already sitting on an expired link) are exactly the ones who
 * never see it.
 *
 * `authLinkErrorFromUrl` is captured at supabase-module load, before
 * `detectSessionInUrl` consumes the fragment, so it survives this redirect —
 * which reading `window.location.hash` here would not.
 *
 * Lives in its own module (rather than inline in `App.tsx`) so the ONE-SHOT
 * behaviour below can be regression-tested directly. Rendering `App` to cover
 * it would pull the entire lazy route graph.
 */

import { useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';

import { ROUTES } from '@/lib/routes';
import { authLinkErrorFromUrl, shouldRedirectToAuthCallback } from '@/lib/supabase';

export function AuthLinkErrorRedirect() {
  const navigate = useNavigate();
  const location = useLocation();

  /**
   * ONE-SHOT. `authLinkErrorFromUrl` is a module-scope constant captured once
   * at load and never cleared, so a plain `pathname`-keyed effect re-fires on
   * EVERY later navigation and drags the user straight back to
   * `/auth/callback`. That traps them on the error card with two dead buttons
   * — both of its CTAs (`Request a new link` -> /signup, `Back to sign in` ->
   * /login) navigate away, which is exactly what re-triggers the redirect.
   *
   * The flag is set the first time the effect observes a link error at all,
   * NOT only when it redirects: a user who lands directly on
   * `/auth/callback` is not redirected, and without marking that pass handled
   * their first click away would bounce right back.
   */
  const handledRef = useRef(false);

  useEffect(() => {
    if (handledRef.current) return;
    if (!authLinkErrorFromUrl) return;

    handledRef.current = true;

    if (!shouldRedirectToAuthCallback(authLinkErrorFromUrl, location.pathname, ROUTES.AUTH_CALLBACK)) {
      return;
    }
    navigate(ROUTES.AUTH_CALLBACK, { replace: true });
  }, [navigate, location.pathname]);

  return null;
}
