/**
 * useMfaAssurance Hook Tests — pre-pentest MFA hardening.
 *
 * Root cause under test: `supabase.auth.signInWithPassword()` leaves a
 * session at `aal1` even when the user has a verified TOTP factor. Nothing
 * in the app previously called `getAuthenticatorAssuranceLevel()`, so an
 * enrolled user's password alone granted full access — MFA was decorative.
 *
 * This hook is the single source of truth AuthGuard uses to decide whether
 * the current session still needs an MFA challenge before rendering a
 * protected route. Every failure mode here is graded against ONE priority:
 * never lock out a user who has NOT enrolled MFA. Fail-open (status
 * 'satisfied') is the deliberate, correct behavior on error/timeout — see
 * inline comments on each test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const mockGetAAL = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      mfa: {
        getAuthenticatorAssuranceLevel: (...args: unknown[]) => mockGetAAL(...args),
      },
    },
  },
}));

// Deferred-promise helper so we can assert intermediate ('loading') state
// before resolving the mocked Supabase call.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useMfaAssurance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is immediately satisfied with no userId (logged out / still resolving auth) — never calls Supabase', async () => {
    const { useMfaAssurance } = await import('./useMfaAssurance');
    const { result } = renderHook(() => useMfaAssurance(null));

    expect(result.current.status).toBe('satisfied');
    expect(result.current.hasVerifiedFactor).toBe(false);
    expect(mockGetAAL).not.toHaveBeenCalled();
  });

  it('CRITICAL: user with NO enrolled factor reaches satisfied — must never be blocked (catastrophic-failure guard)', async () => {
    mockGetAAL.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal1', currentAuthenticationMethods: [] },
      error: null,
    });

    const { useMfaAssurance } = await import('./useMfaAssurance');
    const { result } = renderHook(() => useMfaAssurance('user-no-mfa'));

    await waitFor(() => {
      expect(result.current.status).toBe('satisfied');
    });
    expect(result.current.hasVerifiedFactor).toBe(false);
  });

  it('requires a challenge when a verified factor exists but the session is still aal1', async () => {
    mockGetAAL.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal2', currentAuthenticationMethods: [] },
      error: null,
    });

    const { useMfaAssurance } = await import('./useMfaAssurance');
    const { result } = renderHook(() => useMfaAssurance('user-with-mfa'));

    await waitFor(() => {
      expect(result.current.status).toBe('challenge_required');
    });
    expect(result.current.hasVerifiedFactor).toBe(true);
  });

  it('is satisfied when the session already reached aal2 (challenge already completed this session)', async () => {
    mockGetAAL.mockResolvedValue({
      data: { currentLevel: 'aal2', nextLevel: 'aal2', currentAuthenticationMethods: [] },
      error: null,
    });

    const { useMfaAssurance } = await import('./useMfaAssurance');
    const { result } = renderHook(() => useMfaAssurance('user-elevated'));

    await waitFor(() => {
      expect(result.current.status).toBe('satisfied');
    });
    expect(result.current.hasVerifiedFactor).toBe(true);
  });

  it('FAIL-OPEN: an error response from Supabase never blocks access', async () => {
    mockGetAAL.mockResolvedValue({
      data: null,
      error: { message: 'network blip' },
    });

    const { useMfaAssurance } = await import('./useMfaAssurance');
    const { result } = renderHook(() => useMfaAssurance('user-x'));

    await waitFor(() => {
      expect(result.current.status).toBe('satisfied');
    });
  });

  it('FAIL-OPEN: a thrown rejection never blocks access', async () => {
    mockGetAAL.mockRejectedValue(new Error('boom'));

    const { useMfaAssurance } = await import('./useMfaAssurance');
    const { result } = renderHook(() => useMfaAssurance('user-y'));

    await waitFor(() => {
      expect(result.current.status).toBe('satisfied');
    });
  });

  it('FAIL-OPEN: a hung/never-resolving check times out to satisfied rather than spinning forever', async () => {
    vi.useFakeTimers();
    const never = new Promise(() => {});
    mockGetAAL.mockReturnValue(never);

    const { useMfaAssurance } = await import('./useMfaAssurance');
    const { result } = renderHook(() => useMfaAssurance('user-hang'));

    expect(result.current.status).toBe('loading');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(result.current.status).toBe('satisfied');
  });

  it('NO-FLASH: status is loading (not a stale satisfied) while the check is pending — closes the render-race where a protected page could flash before the challenge screen', async () => {
    const gate = deferred<{ data: { currentLevel: string; nextLevel: string; currentAuthenticationMethods: never[] } | null; error: null }>();
    mockGetAAL.mockReturnValue(gate.promise);

    const { useMfaAssurance } = await import('./useMfaAssurance');
    const { result } = renderHook(() => useMfaAssurance('user-pending'));

    // Synchronously after mount, before the mocked promise resolves, the
    // hook must NOT report 'satisfied' — that would let AuthGuard render
    // protected children for a user who may still need a challenge.
    expect(result.current.status).toBe('loading');

    await act(async () => {
      gate.resolve({ data: { currentLevel: 'aal1', nextLevel: 'aal2', currentAuthenticationMethods: [] }, error: null });
      await gate.promise;
    });

    await waitFor(() => {
      expect(result.current.status).toBe('challenge_required');
    });
  });

  it('markVerified() flips status to satisfied immediately, without waiting on a re-fetch', async () => {
    mockGetAAL.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal2', currentAuthenticationMethods: [] },
      error: null,
    });

    const { useMfaAssurance } = await import('./useMfaAssurance');
    const { result } = renderHook(() => useMfaAssurance('user-verifying'));

    await waitFor(() => {
      expect(result.current.status).toBe('challenge_required');
    });

    const callsBeforeVerify = mockGetAAL.mock.calls.length;

    act(() => {
      result.current.markVerified();
    });

    expect(result.current.status).toBe('satisfied');
    // markVerified is a local state transition (the caller just proved
    // possession of the factor via challenge+verify) — it must not trigger
    // another network round-trip.
    expect(mockGetAAL.mock.calls.length).toBe(callsBeforeVerify);
  });

  it('re-runs the check when userId changes (user switch) instead of keeping stale state', async () => {
    mockGetAAL.mockResolvedValueOnce({
      data: { currentLevel: 'aal1', nextLevel: 'aal1', currentAuthenticationMethods: [] },
      error: null,
    });

    const { useMfaAssurance } = await import('./useMfaAssurance');
    const { result, rerender } = renderHook(({ userId }) => useMfaAssurance(userId), {
      initialProps: { userId: 'user-a' },
    });

    await waitFor(() => {
      expect(result.current.status).toBe('satisfied');
    });
    expect(result.current.hasVerifiedFactor).toBe(false);

    const gate = deferred<{ data: { currentLevel: string; nextLevel: string; currentAuthenticationMethods: never[] }; error: null }>();
    mockGetAAL.mockReturnValueOnce(gate.promise);

    rerender({ userId: 'user-b' });

    // Must not keep showing user A's 'satisfied' result for user B while
    // user B's check is still in flight.
    expect(result.current.status).toBe('loading');

    await act(async () => {
      gate.resolve({ data: { currentLevel: 'aal1', nextLevel: 'aal2', currentAuthenticationMethods: [] }, error: null });
      await gate.promise;
    });

    await waitFor(() => {
      expect(result.current.status).toBe('challenge_required');
    });
  });

  // ---------------------------------------------------------------------
  // FOUNDER REQUIREMENT: "MFA isn't just forced enrollment it needs to be
  // enforced everytime you login." These tests pin that a second,
  // independent login is challenged again, and that neither a route change
  // nor a full page reload (simulated here as unmount+remount, since both
  // destroy this hook's React state) can leave a stale 'satisfied' result
  // standing in for a fresh session that has not actually reached aal2.
  // ---------------------------------------------------------------------

  it('EVERY-LOGIN ENFORCEMENT: an already-enrolled user is challenged again on a SECOND, independent login — completing the first challenge does not leak into a fresh mount', async () => {
    mockGetAAL.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal2', currentAuthenticationMethods: [] },
      error: null,
    });

    const { useMfaAssurance } = await import('./useMfaAssurance');

    // First login (first mount).
    const first = renderHook(() => useMfaAssurance('user-1'));
    await waitFor(() => {
      expect(first.result.current.status).toBe('challenge_required');
    });
    act(() => {
      first.result.current.markVerified();
    });
    expect(first.result.current.status).toBe('satisfied');
    first.unmount(); // sign-out / full reload destroys all React state

    // Second, independent login. Supabase issues a brand new aal1 JWT for
    // this signInWithPassword() call regardless of the first session's
    // outcome (verified against auth-js source — see module doc comment),
    // so the mock correctly continues to report aal1/aal2 here too.
    const second = renderHook(() => useMfaAssurance('user-1'));
    await waitFor(() => {
      expect(second.result.current.status).toBe('challenge_required');
    });
  });

  it('SESSION RESTORE: a reload that restores an already-aal2 session does not re-challenge (matches Supabase preserving aal2 across token refresh)', async () => {
    mockGetAAL.mockResolvedValue({
      data: { currentLevel: 'aal2', nextLevel: 'aal2', currentAuthenticationMethods: [] },
      error: null,
    });

    const { useMfaAssurance } = await import('./useMfaAssurance');
    const { result } = renderHook(() => useMfaAssurance('user-1'));

    await waitFor(() => {
      expect(result.current.status).toBe('satisfied');
    });
  });

  it('SESSION RESTORE SAFETY NET: a restored session reporting aal1 is challenged, never silently treated as verified from a stale assumption — proves there is no persisted "already verified" bypass anywhere in this hook', async () => {
    mockGetAAL.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal2', currentAuthenticationMethods: [] },
      error: null,
    });

    const { useMfaAssurance } = await import('./useMfaAssurance');
    const { result, unmount } = renderHook(() => useMfaAssurance('user-1'));

    await waitFor(() => {
      expect(result.current.status).toBe('challenge_required');
    });

    // Simulate a reload (destroys state) landing back on a still-aal1
    // restored session — must independently re-derive the same answer,
    // not read anything left over from the previous mount.
    unmount();
    const restored = renderHook(() => useMfaAssurance('user-1'));
    await waitFor(() => {
      expect(restored.result.current.status).toBe('challenge_required');
    });
  });
});
