/**
 * AuthCallbackPage Tests
 *
 * Verifies OAuth callback handling for PKCE (INITIAL_SESSION),
 * implicit (SIGNED_IN), and failure (SIGNED_OUT) flows.
 *
 * BUG-S35-04: AuthCallbackPage must handle INITIAL_SESSION event
 * from Supabase PKCE flow, not just SIGNED_IN.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthCallbackPage } from './AuthCallbackPage';

// Mock navigate
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// Mock supabase
type AuthChangeCallback = (event: string, session: unknown) => void;
let authChangeCallback: AuthChangeCallback | null = null;
const mockUnsubscribe = vi.fn();
const mockGetSession = vi.fn();

// SCRUM-2907: the real module captures the auth-link error at load time,
// BEFORE createClient consumes the URL fragment. Mirror that shape here and
// let each test set it, so the module-load path is covered rather than only
// the live-fragment fallback.
let mockAuthLinkErrorFromUrl: { expired: boolean } | null = null;

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      onAuthStateChange: (cb: AuthChangeCallback) => {
        authChangeCallback = cb;
        return { data: { subscription: { unsubscribe: mockUnsubscribe } } };
      },
      getSession: () => mockGetSession(),
    },
  },
  get authLinkErrorFromUrl() {
    return mockAuthLinkErrorFromUrl;
  },
}));

describe('AuthCallbackPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    authChangeCallback = null;
    mockAuthLinkErrorFromUrl = null;
    mockGetSession.mockResolvedValue({ data: { session: null } });
    // Mock window.history.replaceState
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders loading spinner', () => {
    render(
      <MemoryRouter>
        <AuthCallbackPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('Completing sign in...')).toBeInTheDocument();
  });

  it('redirects to dashboard on SIGNED_IN event', () => {
    render(
      <MemoryRouter>
        <AuthCallbackPage />
      </MemoryRouter>,
    );

    act(() => {
      authChangeCallback?.('SIGNED_IN', { user: { id: '123' } });
    });

    expect(mockNavigate).toHaveBeenCalledWith('/dashboard', { replace: true });
  });

  it('redirects to dashboard on INITIAL_SESSION with session (BUG-S35-04 fix)', () => {
    render(
      <MemoryRouter>
        <AuthCallbackPage />
      </MemoryRouter>,
    );

    act(() => {
      authChangeCallback?.('INITIAL_SESSION', { user: { id: '123' } });
    });

    expect(mockNavigate).toHaveBeenCalledWith('/dashboard', { replace: true });
  });

  it('redirects to login on INITIAL_SESSION without session', () => {
    render(
      <MemoryRouter>
        <AuthCallbackPage />
      </MemoryRouter>,
    );

    act(() => {
      authChangeCallback?.('INITIAL_SESSION', null);
    });

    expect(mockNavigate).toHaveBeenCalledWith('/login', { replace: true });
  });

  it('redirects to login on SIGNED_OUT event', () => {
    render(
      <MemoryRouter>
        <AuthCallbackPage />
      </MemoryRouter>,
    );

    act(() => {
      authChangeCallback?.('SIGNED_OUT', null);
    });

    expect(mockNavigate).toHaveBeenCalledWith('/login', { replace: true });
  });

  it('only redirects once even with multiple events', () => {
    render(
      <MemoryRouter>
        <AuthCallbackPage />
      </MemoryRouter>,
    );

    act(() => {
      authChangeCallback?.('SIGNED_IN', { user: { id: '123' } });
      authChangeCallback?.('INITIAL_SESSION', { user: { id: '123' } });
    });

    expect(mockNavigate).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = render(
      <MemoryRouter>
        <AuthCallbackPage />
      </MemoryRouter>,
    );

    unmount();
    expect(mockUnsubscribe).toHaveBeenCalled();
  });

  it('redirects to dashboard on TOKEN_REFRESHED event', () => {
    render(
      <MemoryRouter>
        <AuthCallbackPage />
      </MemoryRouter>,
    );

    act(() => {
      authChangeCallback?.('TOKEN_REFRESHED', { user: { id: '123' } });
    });

    expect(mockNavigate).toHaveBeenCalledWith('/dashboard', { replace: true });
  });

  /**
   * SCRUM-2907 — email-confirmation link failures must be explained.
   *
   * Prod requires email confirmation (verified live 2026-08-01: signup returns
   * no session and sets confirmation_sent_at). Supabase reports a dead
   * confirmation link by appending `error`/`error_code`/`error_description` to
   * the redirect HASH — no session is ever created, so the page's only signal
   * used to be "no session", which bounced the user to a bare /login with no
   * explanation. An expired link and a working link were indistinguishable.
   */
  describe('email confirmation link failures', () => {
    function setHash(hash: string) {
      Object.defineProperty(window, 'location', {
        value: { ...window.location, hash, pathname: '/auth/callback' },
        writable: true,
      });
    }

    afterEach(() => {
      setHash('');
    });

    /**
     * The real production path. `detectSessionInUrl: true` consumes the URL
     * fragment inside `createClient`, so by the time this component mounts the
     * fragment is EMPTY — reading `window.location.hash` here finds nothing.
     * Caught in local UAT: the component-only read silently lost the error and
     * bounced to a bare login form, i.e. the exact bug under repair. The error
     * is now captured at supabase-module load and handed over.
     */
    it('explains an expired link captured before the client consumed the fragment', () => {
      mockAuthLinkErrorFromUrl = { expired: true };
      setHash(''); // Supabase already stripped it — this is the real condition.

      render(
        <MemoryRouter>
          <AuthCallbackPage />
        </MemoryRouter>,
      );

      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText(/link has expired/i)).toBeInTheDocument();
      // Must NOT dump the user on /login with no explanation.
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('explains an expired confirmation link read straight off the fragment', () => {
      setHash(
        '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired',
      );

      render(
        <MemoryRouter>
          <AuthCallbackPage />
        </MemoryRouter>,
      );

      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText(/link has expired/i)).toBeInTheDocument();
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('offers a route back to signup so the user can request a new link', () => {
      mockAuthLinkErrorFromUrl = { expired: true };

      render(
        <MemoryRouter>
          <AuthCallbackPage />
        </MemoryRouter>,
      );

      expect(screen.getByRole('link', { name: /new link/i })).toHaveAttribute('href', '/signup');
    });

    it('surfaces a generic auth error that is not an expired link', () => {
      mockAuthLinkErrorFromUrl = { expired: false };

      render(
        <MemoryRouter>
          <AuthCallbackPage />
        </MemoryRouter>,
      );

      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText(/could not complete sign in/i)).toBeInTheDocument();
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('still completes a healthy confirmation link normally', () => {
      setHash('#access_token=abc&type=signup');

      render(
        <MemoryRouter>
          <AuthCallbackPage />
        </MemoryRouter>,
      );

      act(() => {
        authChangeCallback?.('SIGNED_IN', { user: { id: '123' } });
      });

      expect(mockNavigate).toHaveBeenCalledWith('/dashboard', { replace: true });
    });
  });
});
