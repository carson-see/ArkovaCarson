/**
 * SCRUM-2907 — AuthLinkErrorRedirect must fire ONCE, not on every navigation.
 *
 * `authLinkErrorFromUrl` is a module-scope constant captured at supabase-module
 * load and never cleared. A `pathname`-keyed effect that only guards "am I
 * already on the callback route?" therefore re-fires on every subsequent
 * navigation and drags the user straight back to `/auth/callback`.
 *
 * That is not a cosmetic loop: BOTH CTAs on the expired-link card navigate away
 * (`Request a new link` -> /signup, `Back to sign in` -> /login), so the
 * re-fire makes the card's own escape hatches dead. The page that exists to
 * explain a dead link would itself become the trap.
 *
 * The predicate tests in `src/lib/authLinkRedirect.test.ts` cannot catch this —
 * `shouldRedirectToAuthCallback` is pure and correct in isolation. The defect
 * is in how often it is CALLED, which only real navigation through a real
 * router shows. So `react-router-dom` is deliberately NOT mocked here: a
 * mocked `useNavigate` never changes the location, so the effect never
 * re-fires and the bug is invisible.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';

import { AuthLinkErrorRedirect } from './AuthLinkErrorRedirect';

let stubbedAuthLinkError: { expired: boolean } | null = null;

// Only the two auth-link exports are mocked — this component never touches the
// supabase client itself, so no `supabase` stub is provided.
vi.mock('@/lib/supabase', () => ({
  shouldRedirectToAuthCallback: (
    linkError: { expired: boolean } | null,
    pathname: string,
    authCallbackPath: string,
  ) => (linkError ? pathname !== authCallbackPath : false),
  get authLinkErrorFromUrl() {
    return stubbedAuthLinkError;
  },
}));

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="pathname">{location.pathname}</div>;
}

/** Stands in for the expired-link card's "Back to sign in" CTA. */
function CallbackStub() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate('/login')}>
      Back to sign in
    </button>
  );
}

function renderAt(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AuthLinkErrorRedirect />
      <LocationProbe />
      <Routes>
        <Route path="/" element={null} />
        <Route path="/auth/callback" element={<CallbackStub />} />
        <Route path="/login" element={null} />
        <Route path="/signup" element={null} />
      </Routes>
    </MemoryRouter>,
  );
}

const pathname = () => screen.getByTestId('pathname').textContent;

describe('AuthLinkErrorRedirect', () => {
  beforeEach(() => {
    stubbedAuthLinkError = null;
  });

  it('bounces a dead link that landed on the app root to the callback route', () => {
    stubbedAuthLinkError = { expired: true };
    renderAt('/');
    expect(pathname()).toBe('/auth/callback');
  });

  it('leaves a normal load with no link error alone', () => {
    stubbedAuthLinkError = null;
    renderAt('/');
    expect(pathname()).toBe('/');
  });

  it('does not bounce when the dead link already landed on the callback route', () => {
    stubbedAuthLinkError = { expired: true };
    renderAt('/auth/callback');
    expect(pathname()).toBe('/auth/callback');
  });

  it('REGRESSION: the error card CTA still works — no re-bounce after landing on /', async () => {
    const user = userEvent.setup();
    stubbedAuthLinkError = { expired: true };
    renderAt('/');
    expect(pathname()).toBe('/auth/callback');

    await user.click(screen.getByRole('button', { name: 'Back to sign in' }));

    // Without the one-shot guard the effect re-fires on the new pathname and
    // drags the user straight back to /auth/callback.
    expect(pathname()).toBe('/login');
  });

  it('REGRESSION: the error card CTA still works when the link landed directly on the callback route', async () => {
    const user = userEvent.setup();
    stubbedAuthLinkError = { expired: false };
    renderAt('/auth/callback');

    await user.click(screen.getByRole('button', { name: 'Back to sign in' }));

    // The first effect pass did not redirect (already on the callback route),
    // so a guard that only latches on an actual redirect would leave this
    // navigation unprotected.
    expect(pathname()).toBe('/login');
  });
});
