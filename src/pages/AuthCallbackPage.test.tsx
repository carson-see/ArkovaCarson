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
const mockGetUser = vi.fn();

// SCRUM-2907: the real module captures the auth-link error at load time,
// BEFORE createClient consumes the URL fragment. Mirror that shape here and
// let each test set it, so the module-load path is covered rather than only
// the live-fragment fallback.
let stubbedAuthLinkError: { expired: boolean } | null = null;

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      onAuthStateChange: (cb: AuthChangeCallback) => {
        authChangeCallback = cb;
        return { data: { subscription: { unsubscribe: mockUnsubscribe } } };
      },
      getSession: () => mockGetSession(),
      getUser: () => mockGetUser(),
    },
  },
  get authLinkErrorFromUrl() {
    return stubbedAuthLinkError;
  },
}));

describe('AuthCallbackPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    authChangeCallback = null;
    stubbedAuthLinkError = null;
    mockGetSession.mockResolvedValue({ data: { session: null } });
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    window.sessionStorage.clear();
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

  it.each(['INITIAL_SESSION', 'SIGNED_IN', 'TOKEN_REFRESHED'])(
    'keeps a pending OAuth identity on signup after %s (SCRUM-4035)',
    (event) => {
      render(<MemoryRouter><AuthCallbackPage /></MemoryRouter>);
      const payload = btoa(JSON.stringify({ role: 'arkova_email_pending' }));
      act(() => {
        authChangeCallback?.(event, {
          access_token: `header.${payload}.signature`,
          user: { id: '123', email_confirmed_at: '2026-09-05T00:00:00Z' },
        });
      });
      expect(mockNavigate).toHaveBeenCalledWith('/signup', { replace: true });
      expect(mockNavigate).not.toHaveBeenCalledWith('/dashboard', expect.anything());
    },
  );

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
    it('explains an expired link captured before the client consumed the fragment', async () => {
      stubbedAuthLinkError = { expired: true };
      setHash(''); // Supabase already stripped it — this is the real condition.

      render(
        <MemoryRouter>
          <AuthCallbackPage />
        </MemoryRouter>,
      );

      await act(async () => {});

      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText(/link has expired/i)).toBeInTheDocument();
      // Must NOT dump the user on /login with no explanation.
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('explains an expired confirmation link read straight off the fragment', async () => {
      setHash(
        '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired',
      );

      render(
        <MemoryRouter>
          <AuthCallbackPage />
        </MemoryRouter>,
      );

      await act(async () => {});

      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText(/link has expired/i)).toBeInTheDocument();
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('offers a route back to signup so the user can request a new link', async () => {
      stubbedAuthLinkError = { expired: true };

      render(
        <MemoryRouter>
          <AuthCallbackPage />
        </MemoryRouter>,
      );

      await act(async () => {});

      expect(screen.getByRole('link', { name: /new link/i })).toHaveAttribute('href', '/signup');
    });

    it('surfaces a generic auth error that is not an expired link', async () => {
      stubbedAuthLinkError = { expired: false };

      render(
        <MemoryRouter>
          <AuthCallbackPage />
        </MemoryRouter>,
      );

      await act(async () => {});

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

    it('continues only when Auth verifies the consumed link established the intended account', async () => {
      stubbedAuthLinkError = { expired: true };
      window.sessionStorage.setItem('arkova_pending_signup_email', 'member@arkova.ai');
      mockGetUser.mockResolvedValue({
        data: {
          user: {
            id: 'confirmed-user',
            email: 'member@arkova.ai',
            email_confirmed_at: '2026-09-14T12:00:00Z',
          },
        },
        error: null,
      });

      render(
        <MemoryRouter>
          <AuthCallbackPage />
        </MemoryRouter>,
      );

      await act(async () => {});
      expect(mockNavigate).toHaveBeenCalledWith('/dashboard', { replace: true });
      expect(screen.queryByText(/link has expired/i)).not.toBeInTheDocument();
    });

    it('does not suppress a generic callback error for an existing session', async () => {
      stubbedAuthLinkError = { expired: false };
      mockGetSession.mockResolvedValue({ data: { session: { user: { id: 'existing' } } } });
      render(<MemoryRouter><AuthCallbackPage /></MemoryRouter>);
      await act(async () => {});

      expect(screen.getByText(/could not complete sign in/i)).toBeInTheDocument();
      expect(mockGetUser).not.toHaveBeenCalled();
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('does not treat an unrelated signed-in account as proof that the link succeeded', async () => {
      stubbedAuthLinkError = { expired: true };
      window.sessionStorage.setItem('arkova_pending_signup_email', 'member@arkova.ai');
      mockGetUser.mockResolvedValue({
        data: {
          user: {
            id: 'other-user',
            email: 'other@example.com',
            email_confirmed_at: '2026-09-14T12:00:00Z',
          },
        },
        error: null,
      });
      render(<MemoryRouter><AuthCallbackPage /></MemoryRouter>);
      await act(async () => {});

      expect(screen.getByText(/link is no longer valid/i)).toBeInTheDocument();
      expect(screen.getByText(/already signed in/i)).toBeInTheDocument();
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('rejects a stale or unconfirmed session as confirmation proof', async () => {
      stubbedAuthLinkError = { expired: true };
      window.sessionStorage.setItem('arkova_pending_signup_email', 'member@arkova.ai');
      mockGetUser.mockResolvedValue({
        data: { user: { id: 'member', email: 'member@arkova.ai', email_confirmed_at: null } },
        error: null,
      });
      render(<MemoryRouter><AuthCallbackPage /></MemoryRouter>);
      await act(async () => {});

      expect(screen.getByText(/link has expired/i)).toBeInTheDocument();
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('fails closed when authoritative session validation errors', async () => {
      stubbedAuthLinkError = { expired: true };
      mockGetUser.mockResolvedValue({ data: { user: null }, error: new Error('invalid session') });
      render(<MemoryRouter><AuthCallbackPage /></MemoryRouter>);
      await act(async () => {});

      expect(screen.getByText(/link has expired/i)).toBeInTheDocument();
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('stops checking a consumed link when authoritative validation stalls', async () => {
      stubbedAuthLinkError = { expired: true };
      mockGetUser.mockReturnValue(new Promise(() => {}));
      render(<MemoryRouter><AuthCallbackPage /></MemoryRouter>);
      expect(screen.getByText(/completing sign in/i)).toBeInTheDocument();

      await act(async () => {
        vi.advanceTimersByTime(3_000);
      });
      expect(screen.getByText(/link has expired/i)).toBeInTheDocument();
      expect(mockNavigate).not.toHaveBeenCalled();
    });
  });
});
