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
 *
 * R13 (PR #2637 review round 2): the onboarding-incomplete gate (item 33)
 * now reads `useProfile().destination === '/onboarding/org'` directly
 * instead of re-deriving `role === 'ORG_ADMIN' && !org_id` inline —
 * `useProfile()` already computes exactly this decision (see
 * `useProfile.ts`'s `RouteDestination` logic) and duplicating it here was
 * a second place that could silently drift from `RouteGuard`'s real
 * behaviour. The mock helper below computes a realistic `destination` the
 * same way `useProfile.ts` does, so these tests exercise the real
 * contract; a few tests pass a MISMATCHED `destination` explicitly to
 * prove the hook reads that field rather than re-deriving its own answer.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const mockUseProfile = vi.hoisted(() => vi.fn());

vi.mock('./useProfile', () => ({
  useProfile: () => mockUseProfile(),
}));

const ENFORCE_FROM = '2026-09-21T00:00:00Z';

interface MockProfileShape {
  role?: string | null;
  is_platform_admin?: boolean | null;
  org_id?: string | null;
  requires_manual_review?: boolean;
}

/** Mirrors `useProfile.ts`'s `RouteDestination` derivation for a realistic mock. */
function computeDestination(profile: MockProfileShape | null): string {
  if (!profile) return '/auth';
  if (profile.requires_manual_review) return '/review-pending';
  if (!profile.role) return '/onboarding/role';
  if (profile.role === 'ORG_ADMIN' && !profile.org_id) return '/onboarding/org';
  if (profile.role === 'INDIVIDUAL') return '/vault';
  if (profile.role === 'ORG_ADMIN' && profile.org_id) return '/dashboard';
  if (profile.role === 'ORG_MEMBER') return '/dashboard';
  return '/vault';
}

function mockProfile(
  profile: MockProfileShape | null,
  opts: { loading?: boolean; error?: string | null; destination?: string } = {},
) {
  mockUseProfile.mockReturnValue({
    profile,
    loading: opts.loading ?? false,
    error: opts.error ?? null,
    destination: opts.destination ?? computeDestination(profile),
  });
}

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
    mockProfile(null, { loading: true });

    const { useMfaEnrollmentRequirement } = await import('./useMfaEnrollmentRequirement');
    const { result } = renderHook(() => useMfaEnrollmentRequirement());

    expect(result.current.loading).toBe(true);
    expect(result.current.mfaRequired).toBe(false);
    expect(result.current.mfaGraceActive).toBe(false);
  });

  it('ORG_ADMIN is mfaRequired once enforcement is active (past the enforcement instant)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T00:00:00Z'));
    mockProfile({ role: 'ORG_ADMIN', is_platform_admin: false, org_id: 'org-1' });

    const { useMfaEnrollmentRequirement } = await import('./useMfaEnrollmentRequirement');
    const { result } = renderHook(() => useMfaEnrollmentRequirement());

    expect(result.current.loading).toBe(false);
    expect(result.current.mfaRequired).toBe(true);
    expect(result.current.mfaGraceActive).toBe(false);
  });

  it('ORG_ADMIN is mfaGraceActive (not yet required) before the enforcement instant', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
    mockProfile({ role: 'ORG_ADMIN', is_platform_admin: false, org_id: 'org-1' });

    const { useMfaEnrollmentRequirement } = await import('./useMfaEnrollmentRequirement');
    const { result } = renderHook(() => useMfaEnrollmentRequirement());

    expect(result.current.mfaRequired).toBe(false);
    expect(result.current.mfaGraceActive).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Item 33 (PR #2637 review, cross-file tracer): `MfaGraceNudge`'s CTA
  // points at `/settings`, which is a dead link for an ORG_ADMIN still
  // mid-onboarding (role ORG_ADMIN, org_id NULL — `RouteGuard` bounces them
  // to `/onboarding/org` instead). The nudge must not render until
  // onboarding is complete for that role. The hard block (mfaRequired,
  // after the enforcement date) is UNCHANGED and still completable
  // regardless of org_id — AuthGuard renders before RouteGuard, so the
  // forced-enrollment screen works with or without an org.
  //
  // R13: these now go through `destination` (via the `mockProfile` helper
  // above, which computes it the same way `useProfile.ts` does) rather
  // than the hook re-deriving role/org_id inline.
  // -----------------------------------------------------------------------

  it('ITEM 33: an ORG_ADMIN with NO org yet (mid-onboarding, destination=/onboarding/org) does NOT get the grace nudge', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
    mockProfile({ role: 'ORG_ADMIN', is_platform_admin: false, org_id: null });

    const { useMfaEnrollmentRequirement } = await import('./useMfaEnrollmentRequirement');
    const { result } = renderHook(() => useMfaEnrollmentRequirement());

    expect(result.current.mfaGraceActive).toBe(false);
    expect(result.current.mfaRequired).toBe(false);
  });

  it('ITEM 33: an ORG_ADMIN with a real org (destination=/dashboard) DOES get the grace nudge before the enforcement date', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
    mockProfile({ role: 'ORG_ADMIN', is_platform_admin: false, org_id: 'org-1' });

    const { useMfaEnrollmentRequirement } = await import('./useMfaEnrollmentRequirement');
    const { result } = renderHook(() => useMfaEnrollmentRequirement());

    expect(result.current.mfaGraceActive).toBe(true);
  });

  it('ITEM 33: the hard block (mfaRequired) is UNCHANGED and still true for an org-id-less ORG_ADMIN once enforcement is active', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T00:00:00Z'));
    mockProfile({ role: 'ORG_ADMIN', is_platform_admin: false, org_id: null });

    const { useMfaEnrollmentRequirement } = await import('./useMfaEnrollmentRequirement');
    const { result } = renderHook(() => useMfaEnrollmentRequirement());

    expect(result.current.mfaRequired).toBe(true);
  });

  it('ITEM 33: a platform admin gets the grace nudge with NO org_id at all — platform admins are unaffected by the onboarding gate', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
    mockProfile({ role: 'ORG_MEMBER', is_platform_admin: true, org_id: null });

    const { useMfaEnrollmentRequirement } = await import('./useMfaEnrollmentRequirement');
    const { result } = renderHook(() => useMfaEnrollmentRequirement());

    expect(result.current.mfaGraceActive).toBe(true);
  });

  it('R13: reads destination DIRECTLY rather than re-deriving it — a mismatched destination of "/onboarding/org" suppresses the nudge even for a profile whose role/org_id alone would not suggest it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
    // role/org_id here look like "onboarding complete" — only the
    // explicitly-passed destination says otherwise.
    mockProfile(
      { role: 'ORG_ADMIN', is_platform_admin: false, org_id: 'org-1' },
      { destination: '/onboarding/org' },
    );

    const { useMfaEnrollmentRequirement } = await import('./useMfaEnrollmentRequirement');
    const { result } = renderHook(() => useMfaEnrollmentRequirement());

    expect(result.current.mfaGraceActive).toBe(false);
  });

  it('R13: a platform admin at destination=/onboarding/org still gets the grace nudge (the !is_platform_admin carve-out)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
    mockProfile(
      { role: 'ORG_ADMIN', is_platform_admin: true, org_id: null },
      { destination: '/onboarding/org' },
    );

    const { useMfaEnrollmentRequirement } = await import('./useMfaEnrollmentRequirement');
    const { result } = renderHook(() => useMfaEnrollmentRequirement());

    expect(result.current.mfaGraceActive).toBe(true);
  });

  it('a platform admin is treated the same as ORG_ADMIN regardless of org role', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T00:00:00Z'));
    mockProfile({ role: 'ORG_MEMBER', is_platform_admin: true });

    const { useMfaEnrollmentRequirement } = await import('./useMfaEnrollmentRequirement');
    const { result } = renderHook(() => useMfaEnrollmentRequirement());

    expect(result.current.mfaRequired).toBe(true);
  });

  it('CRITICAL: ORG_MEMBER is never required or grace-flagged, at any time — must never regress non-privileged users', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T00:00:00Z'));
    mockProfile({ role: 'ORG_MEMBER', is_platform_admin: false });

    const { useMfaEnrollmentRequirement } = await import('./useMfaEnrollmentRequirement');
    const { result } = renderHook(() => useMfaEnrollmentRequirement());

    expect(result.current.mfaRequired).toBe(false);
    expect(result.current.mfaGraceActive).toBe(false);
  });

  it('CRITICAL: INDIVIDUAL is never required or grace-flagged, at any time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T00:00:00Z'));
    mockProfile({ role: 'INDIVIDUAL', is_platform_admin: false });

    const { useMfaEnrollmentRequirement } = await import('./useMfaEnrollmentRequirement');
    const { result } = renderHook(() => useMfaEnrollmentRequirement());

    expect(result.current.mfaRequired).toBe(false);
    expect(result.current.mfaGraceActive).toBe(false);
  });

  it('FAIL-OPEN: a profile query error resolves to not-required/not-grace rather than blocking on an unconfirmed role', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T00:00:00Z'));
    mockProfile({ role: 'ORG_ADMIN', is_platform_admin: false, org_id: 'org-1' }, { error: 'network blip' });

    const { useMfaEnrollmentRequirement } = await import('./useMfaEnrollmentRequirement');
    const { result } = renderHook(() => useMfaEnrollmentRequirement());

    expect(result.current.loading).toBe(false);
    expect(result.current.mfaRequired).toBe(false);
    expect(result.current.mfaGraceActive).toBe(false);
  });

  it('FAIL-OPEN: a null profile (settled, no role) resolves to not-required/not-grace', async () => {
    mockProfile(null);

    const { useMfaEnrollmentRequirement } = await import('./useMfaEnrollmentRequirement');
    const { result } = renderHook(() => useMfaEnrollmentRequirement());

    expect(result.current.loading).toBe(false);
    expect(result.current.mfaRequired).toBe(false);
    expect(result.current.mfaGraceActive).toBe(false);
  });

  it('FAIL-OPEN: a profile with a null role resolves to not-required/not-grace', async () => {
    mockProfile({ role: null, is_platform_admin: null });

    const { useMfaEnrollmentRequirement } = await import('./useMfaEnrollmentRequirement');
    const { result } = renderHook(() => useMfaEnrollmentRequirement());

    expect(result.current.mfaRequired).toBe(false);
    expect(result.current.mfaGraceActive).toBe(false);
  });

  it('ITEM 18/EA4: returns the resolved enforcement date so AuthGuard can thread it to MfaGraceNudge without a second resolution', async () => {
    mockProfile(null);

    const { useMfaEnrollmentRequirement } = await import('./useMfaEnrollmentRequirement');
    const { result } = renderHook(() => useMfaEnrollmentRequirement());

    expect(result.current.enforceFromIso).toBe(ENFORCE_FROM);
  });

  describe('live re-evaluation (CTO ruling A4-11)', () => {
    it('flips from mfaGraceActive to mfaRequired on the 60s tick once the clock crosses the enforcement instant', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-20T23:59:00Z')); // 1 minute before enforcement
      mockProfile({ role: 'ORG_ADMIN', is_platform_admin: false, org_id: 'org-1' });

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
      mockProfile({ role: 'ORG_ADMIN', is_platform_admin: false, org_id: 'org-1' });

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
      mockProfile({ role: 'ORG_ADMIN', is_platform_admin: false, org_id: 'org-1' });
      const removeListenerSpy = vi.spyOn(document, 'removeEventListener');

      const { useMfaEnrollmentRequirement } = await import('./useMfaEnrollmentRequirement');
      const { unmount } = renderHook(() => useMfaEnrollmentRequirement());

      unmount();
      expect(removeListenerSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));

      expect(() => {
        vi.advanceTimersByTime(120_000);
      }).not.toThrow();
    });

    it('R12: does not poll or listen at all when the profile is not yet loaded (enabled=Boolean(profile))', async () => {
      vi.useFakeTimers();
      mockProfile(null, { loading: true });
      const addSpy = vi.spyOn(document, 'addEventListener');

      const { useMfaEnrollmentRequirement } = await import('./useMfaEnrollmentRequirement');
      renderHook(() => useMfaEnrollmentRequirement());

      expect(addSpy).not.toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    });
  });
});
