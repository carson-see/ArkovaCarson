/**
 * useMfaEnrollmentRequirement Hook Tests — SCRUM-3167 role-based MFA
 * enforcement tier.
 *
 * REWRITE from the PR #1973 (3572fcd6e) version per CTO ruling A4-3: org-
 * level `hipaa_mfa_required` enforcement is DROPPED from phase 1 (the
 * column is writable by any org owner/admin via PostgREST with no audit —
 * see `mfa-cto-plan.md` Amendment A4 item 3). This hook now answers a
 * date-aware question: is MFA mandatory for THIS user's role, AS OF NOW?
 * Role comes from `useProfile()` (React Query, 60s staleTime) rather than a
 * standalone Supabase query, so cached navigation never flashes a spinner
 * (A4-6) — this hook MUST be used inside `<ProfileProvider>`, which every
 * `AuthGuard` render is (see `App.tsx`).
 *
 * SAFETY: fails to `{ mfaRequired: false, mfaGraceActive: false }` on any
 * profile-query error or a null profile/role. A transient DB error must
 * never be the reason this hook incorrectly reports "required" for an
 * unconfirmed role — the far worse failure direction is a bug that traps
 * an ordinary user behind a block they cannot resolve.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const mockUseProfile = vi.hoisted(() => vi.fn());

vi.mock('./useProfile', () => ({
  useProfile: () => mockUseProfile(),
}));

const ENFORCE_FROM = '2026-09-21T00:00:00Z';

function setDocumentHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
  Object.defineProperty(document, 'visibilityState', {
    value: hidden ? 'hidden' : 'visible',
    configurable: true,
  });
}

describe('useMfaEnrollmentRequirement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_MFA_ALLOW_DATE_OVERRIDE', undefined);
    vi.stubEnv('VITE_MFA_ENFORCE_FROM', ENFORCE_FROM);
    setDocumentHidden(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('is loading while the profile query is genuinely loading for the first time', async () => {
    mockUseProfile.mockReturnValue({ profile: null, loading: true, error: null });

    const { useMfaEnrollmentRequirement } = await import('./useMfaEnrollmentRequirement');
    const { result } = renderHook(() => useMfaEnrollmentRequirement());

    expect(result.current.loading).toBe(true);
    expect(result.current.mfaRequired).toBe(false);
    expect(result.current.mfaGraceActive).toBe(false);
  });

  it('ORG_ADMIN is mfaRequired once enforcement is active (past the enforcement instant)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T00:00:00Z'));
    mockUseProfile.mockReturnValue({
      profile: { role: 'ORG_ADMIN', is_platform_admin: false },
      loading: false,
      error: null,
    });

    const { useMfaEnrollmentRequirement } = await import('./useMfaEnrollmentRequirement');
    const { result } = renderHook(() => useMfaEnrollmentRequirement());

    expect(result.current.loading).toBe(false);
    expect(result.current.mfaRequired).toBe(true);
    expect(result.current.mfaGraceActive).toBe(false);
  });

  it('ORG_ADMIN is mfaGraceActive (not yet required) before the enforcement instant', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
    mockUseProfile.mockReturnValue({
      profile: { role: 'ORG_ADMIN', is_platform_admin: false },
      loading: false,
      error: null,
    });

    const { useMfaEnrollmentRequirement } = await import('./useMfaEnrollmentRequirement');
    const { result } = renderHook(() => useMfaEnrollmentRequirement());

    expect(result.current.mfaRequired).toBe(false);
    expect(result.current.mfaGraceActive).toBe(true);
  });

  it('a platform admin is treated the same as ORG_ADMIN regardless of org role', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T00:00:00Z'));
    mockUseProfile.mockReturnValue({
      profile: { role: 'ORG_MEMBER', is_platform_admin: true },
      loading: false,
      error: null,
    });

    const { useMfaEnrollmentRequirement } = await import('./useMfaEnrollmentRequirement');
    const { result } = renderHook(() => useMfaEnrollmentRequirement());

    expect(result.current.mfaRequired).toBe(true);
  });

  it('CRITICAL: ORG_MEMBER is never required or grace-flagged, at any time — must never regress non-privileged users', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T00:00:00Z'));
    mockUseProfile.mockReturnValue({
      profile: { role: 'ORG_MEMBER', is_platform_admin: false },
      loading: false,
      error: null,
    });

    const { useMfaEnrollmentRequirement } = await import('./useMfaEnrollmentRequirement');
    const { result } = renderHook(() => useMfaEnrollmentRequirement());

    expect(result.current.mfaRequired).toBe(false);
    expect(result.current.mfaGraceActive).toBe(false);
  });

  it('CRITICAL: INDIVIDUAL is never required or grace-flagged, at any time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T00:00:00Z'));
    mockUseProfile.mockReturnValue({
      profile: { role: 'INDIVIDUAL', is_platform_admin: false },
      loading: false,
      error: null,
    });

    const { useMfaEnrollmentRequirement } = await import('./useMfaEnrollmentRequirement');
    const { result } = renderHook(() => useMfaEnrollmentRequirement());

    expect(result.current.mfaRequired).toBe(false);
    expect(result.current.mfaGraceActive).toBe(false);
  });

  it('FAIL-OPEN: a profile query error resolves to not-required/not-grace rather than blocking on an unconfirmed role', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T00:00:00Z'));
    mockUseProfile.mockReturnValue({
      profile: { role: 'ORG_ADMIN', is_platform_admin: false },
      loading: false,
      error: 'network blip',
    });

    const { useMfaEnrollmentRequirement } = await import('./useMfaEnrollmentRequirement');
    const { result } = renderHook(() => useMfaEnrollmentRequirement());

    expect(result.current.loading).toBe(false);
    expect(result.current.mfaRequired).toBe(false);
    expect(result.current.mfaGraceActive).toBe(false);
  });

  it('FAIL-OPEN: a null profile (settled, no role) resolves to not-required/not-grace', async () => {
    mockUseProfile.mockReturnValue({ profile: null, loading: false, error: null });

    const { useMfaEnrollmentRequirement } = await import('./useMfaEnrollmentRequirement');
    const { result } = renderHook(() => useMfaEnrollmentRequirement());

    expect(result.current.loading).toBe(false);
    expect(result.current.mfaRequired).toBe(false);
    expect(result.current.mfaGraceActive).toBe(false);
  });

  it('FAIL-OPEN: a profile with a null role resolves to not-required/not-grace', async () => {
    mockUseProfile.mockReturnValue({
      profile: { role: null, is_platform_admin: null },
      loading: false,
      error: null,
    });

    const { useMfaEnrollmentRequirement } = await import('./useMfaEnrollmentRequirement');
    const { result } = renderHook(() => useMfaEnrollmentRequirement());

    expect(result.current.mfaRequired).toBe(false);
    expect(result.current.mfaGraceActive).toBe(false);
  });

  describe('live re-evaluation (CTO ruling A4-11)', () => {
    it('flips from mfaGraceActive to mfaRequired on the 60s tick once the clock crosses the enforcement instant', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-20T23:59:00Z')); // 1 minute before enforcement
      mockUseProfile.mockReturnValue({
        profile: { role: 'ORG_ADMIN', is_platform_admin: false },
        loading: false,
        error: null,
      });

      const { useMfaEnrollmentRequirement } = await import('./useMfaEnrollmentRequirement');
      const { result } = renderHook(() => useMfaEnrollmentRequirement());

      expect(result.current.mfaGraceActive).toBe(true);
      expect(result.current.mfaRequired).toBe(false);

      await act(async () => {
        vi.setSystemTime(new Date('2026-09-21T00:00:30Z')); // now past enforcement
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(result.current.mfaRequired).toBe(true);
      expect(result.current.mfaGraceActive).toBe(false);
    });

    it('re-evaluates when the tab becomes visible again', async () => {
      vi.setSystemTime(new Date('2026-09-20T23:59:00Z'));
      mockUseProfile.mockReturnValue({
        profile: { role: 'ORG_ADMIN', is_platform_admin: false },
        loading: false,
        error: null,
      });

      const { useMfaEnrollmentRequirement } = await import('./useMfaEnrollmentRequirement');
      const { result } = renderHook(() => useMfaEnrollmentRequirement());

      expect(result.current.mfaGraceActive).toBe(true);

      vi.setSystemTime(new Date('2026-09-22T00:00:00Z'));
      setDocumentHidden(true);
      document.dispatchEvent(new Event('visibilitychange'));
      // Going hidden alone must not flip anything (no re-evaluation needed).
      expect(result.current.mfaGraceActive).toBe(true);

      setDocumentHidden(false);
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });

      await waitFor(() => {
        expect(result.current.mfaRequired).toBe(true);
      });
      vi.useRealTimers();
    });

    it('cleans up the interval and listener on unmount without throwing', async () => {
      vi.useFakeTimers();
      mockUseProfile.mockReturnValue({
        profile: { role: 'ORG_ADMIN', is_platform_admin: false },
        loading: false,
        error: null,
      });
      const removeListenerSpy = vi.spyOn(document, 'removeEventListener');

      const { useMfaEnrollmentRequirement } = await import('./useMfaEnrollmentRequirement');
      const { unmount } = renderHook(() => useMfaEnrollmentRequirement());

      unmount();
      expect(removeListenerSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));

      expect(() => {
        vi.advanceTimersByTime(120_000);
      }).not.toThrow();
    });
  });
});
