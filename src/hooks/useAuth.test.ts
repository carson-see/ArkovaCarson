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
    mockSignUp.mockResolvedValue({ error: null });
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
      options: { data: { full_name: 'Test User' } },
    });
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
