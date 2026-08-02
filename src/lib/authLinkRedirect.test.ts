/**
 * SCRUM-2907 — routing a failed auth link to the one page that can explain it.
 *
 * `emailRedirectTo` only governs links minted AFTER it ships. Every link
 * already sitting in a user's inbox was built against the project Site URL and
 * comes back to `/`, which has no idea a confirmation attempt just failed. So
 * without a global bounce, the people most in need of the explanation — anyone
 * holding an already-expired link — are exactly the ones who never see it.
 *
 * Concretely: as of 2026-08-01 prod holds a real signup from 2026-07-23 whose
 * confirmation token is still UNCONSUMED and now ~9 days old, well past
 * GoTrue's 24h expiry. That user's link lands on `/`.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: {} }),
}));

const AUTH_CALLBACK = '/auth/callback';

describe('shouldRedirectToAuthCallback', () => {
  it('bounces an expired link that landed on the app root', async () => {
    const { shouldRedirectToAuthCallback } = await import('./supabase');
    expect(shouldRedirectToAuthCallback({ expired: true }, '/', AUTH_CALLBACK)).toBe(true);
  });

  it('bounces a generic auth failure from any other route', async () => {
    const { shouldRedirectToAuthCallback } = await import('./supabase');
    for (const path of ['/', '/login', '/dashboard', '/verify/ARK-2026-001']) {
      expect(shouldRedirectToAuthCallback({ expired: false }, path, AUTH_CALLBACK)).toBe(true);
    }
  });

  it('does NOT bounce when already on the callback route', async () => {
    const { shouldRedirectToAuthCallback } = await import('./supabase');
    // Redirecting to where we already are is a render loop, not a no-op.
    expect(shouldRedirectToAuthCallback({ expired: true }, AUTH_CALLBACK, AUTH_CALLBACK)).toBe(false);
  });

  it('does NOT bounce a normal page load with no link error', async () => {
    const { shouldRedirectToAuthCallback } = await import('./supabase');
    for (const path of ['/', '/login', '/dashboard', AUTH_CALLBACK]) {
      expect(shouldRedirectToAuthCallback(null, path, AUTH_CALLBACK)).toBe(false);
    }
  });
});
