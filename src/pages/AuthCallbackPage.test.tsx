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
}));

describe('AuthCallbackPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    authChangeCallback = null;
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
});
