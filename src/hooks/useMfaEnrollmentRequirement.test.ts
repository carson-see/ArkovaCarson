/**
 * useMfaEnrollmentRequirement Hook Tests — mandatory MFA enforcement tier.
 *
 * Answers ONE question, independent of session/AAL state: is MFA mandatory
 * for THIS user's role? Enforcement-tier decision (see PR description):
 * mandatory for ORG_ADMIN and platform admins now; a grace-window rollout
 * for ORG_MEMBER/INDIVIDUAL is proposed but NOT implemented in this PR.
 *
 * Deliberately independent of `useProfile()` (React Query + Context) so
 * AuthGuard has no dependency on a context provider being mounted above
 * it — mirrors `useMfaAssurance`'s self-contained fetch pattern exactly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const mockSingle = vi.hoisted(() => vi.fn());
const mockEq = vi.hoisted(() => vi.fn(() => ({ single: mockSingle })));
const mockSelect = vi.hoisted(() => vi.fn(() => ({ eq: mockEq })));
const mockFrom = vi.hoisted(() => vi.fn(() => ({ select: mockSelect })));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: mockFrom,
  },
}));

describe('useMfaEnrollmentRequirement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is not required with no userId — never queries Supabase', async () => {
    const { useMfaEnrollmentRequirement } = await import('./useMfaEnrollmentRequirement');
    const { result } = renderHook(() => useMfaEnrollmentRequirement(null));

    expect(result.current.loading).toBe(false);
    expect(result.current.mfaRequired).toBe(false);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('is required for ORG_ADMIN', async () => {
    mockSingle.mockResolvedValue({ data: { role: 'ORG_ADMIN', is_platform_admin: false }, error: null });

    const { useMfaEnrollmentRequirement } = await import('./useMfaEnrollmentRequirement');
    const { result } = renderHook(() => useMfaEnrollmentRequirement('user-admin'));

    await waitFor(() => {
      expect(result.current.mfaRequired).toBe(true);
    });
    expect(mockFrom).toHaveBeenCalledWith('profiles');
  });

  it('is required for a platform admin regardless of org role', async () => {
    mockSingle.mockResolvedValue({ data: { role: 'ORG_MEMBER', is_platform_admin: true }, error: null });

    const { useMfaEnrollmentRequirement } = await import('./useMfaEnrollmentRequirement');
    const { result } = renderHook(() => useMfaEnrollmentRequirement('user-platform'));

    await waitFor(() => {
      expect(result.current.mfaRequired).toBe(true);
    });
  });

  it('CRITICAL: is NOT required for ORG_MEMBER — must never regress non-privileged users into a block', async () => {
    mockSingle.mockResolvedValue({ data: { role: 'ORG_MEMBER', is_platform_admin: false }, error: null });

    const { useMfaEnrollmentRequirement } = await import('./useMfaEnrollmentRequirement');
    const { result } = renderHook(() => useMfaEnrollmentRequirement('user-member'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.mfaRequired).toBe(false);
  });

  it('CRITICAL: is NOT required for INDIVIDUAL — must never regress non-privileged users into a block', async () => {
    mockSingle.mockResolvedValue({ data: { role: 'INDIVIDUAL', is_platform_admin: false }, error: null });

    const { useMfaEnrollmentRequirement } = await import('./useMfaEnrollmentRequirement');
    const { result } = renderHook(() => useMfaEnrollmentRequirement('user-individual'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.mfaRequired).toBe(false);
  });

  it('FAIL-OPEN: a query error resolves to not-required rather than blocking on an unconfirmed role', async () => {
    mockSingle.mockResolvedValue({ data: null, error: { message: 'network blip' } });

    const { useMfaEnrollmentRequirement } = await import('./useMfaEnrollmentRequirement');
    const { result } = renderHook(() => useMfaEnrollmentRequirement('user-x'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.mfaRequired).toBe(false);
  });

  it('FAIL-OPEN: a thrown rejection resolves to not-required rather than blocking on an unconfirmed role', async () => {
    mockSingle.mockRejectedValue(new Error('boom'));

    const { useMfaEnrollmentRequirement } = await import('./useMfaEnrollmentRequirement');
    const { result } = renderHook(() => useMfaEnrollmentRequirement('user-y'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.mfaRequired).toBe(false);
  });

  it('reports loading while the query is pending, not a stale prior answer', async () => {
    let resolveQuery!: (v: { data: { role: string; is_platform_admin: boolean }; error: null }) => void;
    mockSingle.mockReturnValue(
      new Promise((resolve) => {
        resolveQuery = resolve;
      })
    );

    const { useMfaEnrollmentRequirement } = await import('./useMfaEnrollmentRequirement');
    const { result } = renderHook(() => useMfaEnrollmentRequirement('user-pending'));

    expect(result.current.loading).toBe(true);

    resolveQuery({ data: { role: 'ORG_ADMIN', is_platform_admin: false }, error: null });

    await waitFor(() => {
      expect(result.current.mfaRequired).toBe(true);
    });
  });
});
