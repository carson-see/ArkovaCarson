/**
 * useAuth Hook Tests
 *
 * Tests authentication state management, sign in/up/out flows,
 * Google OAuth, error handling, and oauth_client_id recovery.
 *
 * @see P2-TS-04
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const mockGetSession = vi.hoisted(() => vi.fn());
const mockSignInWithPassword = vi.hoisted(() => vi.fn());
const mockSignUp = vi.hoisted(() => vi.fn());
const mockSignInWithOAuth = vi.hoisted(() => vi.fn());
const mockSignOut = vi.hoisted(() => vi.fn());
const mockOnAuthStateChange = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: mockGetSession,
      signInWithPassword: mockSignInWithPassword,
      signUp: mockSignUp,
      signInWithOAuth: mockSignInWithOAuth,
      signOut: mockSignOut,
      onAuthStateChange: mockOnAuthStateChange,
    },
  },
}));

describe('useAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockOnAuthStateChange.mockReturnValue({
      data: { subscription: { unsubscribe: vi.fn() } },
    });
  });

  it('initializes with loading=true then resolves session', async () => {
    const mockUser = { id: 'user-1', email: 'test@test.com' };
    const mockSession = { user: mockUser };
    mockGetSession.mockResolvedValue({ data: { session: mockSession }, error: null });

    const { useAuth } = await import('./useAuth');
    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.user).toEqual(mockUser);
    expect(result.current.session).toEqual(mockSession);
    expect(result.current.error).toBeNull();
  });

  it('sets user to null when no session exists', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });

    const { useAuth } = await import('./useAuth');
    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.user).toBeNull();
    expect(result.current.session).toBeNull();
  });

  it('handles oauth_client_id error by clearing session', async () => {
    mockGetSession.mockResolvedValue({
      data: { session: null },
      error: { message: 'unexpected field: oauth_client_id' },
    });
    mockSignOut.mockResolvedValue({ error: null });

    const { useAuth } = await import('./useAuth');
    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(result.current.user).toBeNull();
  });

  it('signIn calls signInWithPassword and sets error on failure', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
    mockSignInWithPassword.mockResolvedValue({
      error: { message: 'Invalid credentials' },
    });

    const { useAuth } = await import('./useAuth');
    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.signIn('test@test.com', 'wrong');
    });

    expect(result.current.error).toBe('Invalid credentials');
  });

  it('signUp calls supabase signUp with full_name metadata', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
    mockSignUp.mockResolvedValue({ data: { session: null }, error: null });
    const testCredential = 'unit-test-credential';

    const { useAuth } = await import('./useAuth');
    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.signUp('new@test.com', testCredential, 'Test User');
    });

    expect(mockSignUp).toHaveBeenCalledWith({
      email: 'new@test.com',
      password: testCredential,
      options: {
        data: { full_name: 'Test User' },
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });
  });

  // SCRUM-2907: prod requires email confirmation (verified live 2026-08-01 —
  // signup returns no session and sets confirmation_sent_at). Without
  // emailRedirectTo, Supabase points the emailed link at the project Site URL
  // — the app cannot nominate a landing route, so an expired or already-used
  // link lands on `/` with no way to say what went wrong. /auth/callback is
  // already in the project's additional_redirect_urls allow-list for all three
  // origins, so it is the one destination Supabase will actually honour.
  it('signUp nominates the app-owned confirmation landing route', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
    mockSignUp.mockResolvedValue({ data: { session: null }, error: null });

    const { useAuth } = await import('./useAuth');
    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.signUp('redirect@test.com', 'unit-test-credential');
    });

    const options = mockSignUp.mock.calls.at(-1)?.[0]?.options as
      | { emailRedirectTo?: string }
      | undefined;
    expect(options?.emailRedirectTo).toBe(`${window.location.origin}/auth/callback`);
  });

  // SCRUM-2907: signUp must surface whether an active session was returned so
  // callers can distinguish auto-confirmed signups (live session → proceed into
  // the app) from confirmation-pending signups (null session → "check email").
  it('signUp surfaces the active session when auto-confirm is on', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
    const liveSession = { user: { id: 'user-1', email: 'new@test.com' } };
    mockSignUp.mockResolvedValue({ data: { session: liveSession }, error: null });

    const { useAuth } = await import('./useAuth');
    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let signUpResult: Awaited<ReturnType<typeof result.current.signUp>> | undefined;
    await act(async () => {
      signUpResult = await result.current.signUp('new@test.com', 'unit-test-credential');
    });

    expect(signUpResult?.error).toBeNull();
    expect(signUpResult?.session).toEqual(liveSession);
  });

  it('signUp surfaces a null session when email confirmation is pending', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
    mockSignUp.mockResolvedValue({ data: { session: null }, error: null });

    const { useAuth } = await import('./useAuth');
    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let signUpResult: Awaited<ReturnType<typeof result.current.signUp>> | undefined;
    await act(async () => {
      signUpResult = await result.current.signUp('new@test.com', 'unit-test-credential');
    });

    expect(signUpResult?.error).toBeNull();
    expect(signUpResult?.session).toBeNull();
  });

  it('signInWithGoogle calls signInWithOAuth', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
    mockSignInWithOAuth.mockResolvedValue({ error: null });

    const { useAuth } = await import('./useAuth');
    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.signInWithGoogle();
    });

    expect(mockSignInWithOAuth).toHaveBeenCalledWith({
      provider: 'google',
      options: { redirectTo: expect.stringContaining('/auth/callback') },
    });
  });

  it('signInWithLinkedIn calls signInWithOAuth', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
    mockSignInWithOAuth.mockResolvedValue({ error: null });

    const { useAuth } = await import('./useAuth');
    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.signInWithLinkedIn();
    });

    expect(mockSignInWithOAuth).toHaveBeenCalledWith({
      provider: 'linkedin_oidc',
      options: { redirectTo: expect.stringContaining('/auth/callback') },
    });
  });

  it('signOut clears session and sets error on failure', async () => {
    const mockUser = { id: 'user-1', email: 'test@test.com' };
    mockGetSession.mockResolvedValue({
      data: { session: { user: mockUser } },
      error: null,
    });
    mockSignOut.mockResolvedValue({ error: { message: 'Sign out failed' } });

    const { useAuth } = await import('./useAuth');
    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.signOut();
    });

    expect(result.current.error).toBe('Sign out failed');
  });

  it('signOut sets sessionStorage flag before calling supabase (UAT-LR1-02)', async () => {
    const mockUser = { id: 'user-1', email: 'test@test.com' };
    mockGetSession.mockResolvedValue({
      data: { session: { user: mockUser } },
      error: null,
    });

    // Track order of operations
    const callOrder: string[] = [];
    const mockSessionStorage = {
      getItem: vi.fn(),
      setItem: vi.fn(() => callOrder.push('sessionStorage.setItem')),
      removeItem: vi.fn(),
    };
    Object.defineProperty(window, 'sessionStorage', { value: mockSessionStorage, writable: true });

    mockSignOut.mockImplementation(() => {
      callOrder.push('supabase.signOut');
      return Promise.resolve({ error: null });
    });

    const { useAuth } = await import('./useAuth');
    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.signOut();
    });

    // sessionStorage flag should be set BEFORE supabase.signOut
    expect(callOrder[0]).toBe('sessionStorage.setItem');
    expect(callOrder[1]).toBe('supabase.signOut');
    expect(mockSessionStorage.setItem).toHaveBeenCalledWith('arkova_signed_out', '1');
  });

  it('signOut calls supabase signOut and redirects to /login (UAT-LR1-02)', async () => {
    const mockUser = { id: 'user-1', email: 'test@test.com' };
    mockGetSession.mockResolvedValue({
      data: { session: { user: mockUser } },
      error: null,
    });
    mockSignOut.mockResolvedValue({ error: null });

    // BUG-4: signOut now does window.location.href = '/login' (hard redirect)
    // instead of clearing React state, to avoid ErrorBoundary race conditions.
    // Mock location.href setter to capture the redirect without jsdom navigation.
    const originalLocation = window.location;
    const mockLocation = { ...originalLocation, href: '' };
    Object.defineProperty(window, 'location', {
      value: mockLocation,
      writable: true,
      configurable: true,
    });

    const { useAuth } = await import('./useAuth');
    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.user).toEqual(mockUser);
    });

    await act(async () => {
      await result.current.signOut();
    });

    expect(mockSignOut).toHaveBeenCalled();
    expect(mockLocation.href).toBe('/login');

    // Restore original location
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
  });

  it('clearError resets error to null', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
    mockSignInWithPassword.mockResolvedValue({
      error: { message: 'Bad creds' },
    });

    const { useAuth } = await import('./useAuth');
    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.signIn('a@b.com', 'x');
    });
    expect(result.current.error).toBe('Bad creds');

    act(() => {
      result.current.clearError();
    });
    expect(result.current.error).toBeNull();
  });

  it('handles getSession rejection gracefully', async () => {
    mockGetSession.mockRejectedValue(new Error('Network error'));

    const { useAuth } = await import('./useAuth');
    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.user).toBeNull();
  });
});
