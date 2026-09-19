/* eslint-disable arkova/no-unscoped-service-test -- Frontend: RLS enforced server-side by Supabase JWT, not manual query scoping */
/**
 * SCRUM-5024 — referral attribution inside onboarding.
 *
 * Lives in its own file because it mocks `@/lib/referralCapture`, and the
 * existing `useOnboarding.test.ts` depends on there being no parked code (the
 * vitest global `localStorage` is a throwing stub, so `readReferralCode()`
 * naturally returns null there — a mock at that scope would be a behaviour
 * change to those tests rather than a test of this one).
 *
 * What is pinned:
 *   - all THREE org-creating branches attribute;
 *   - joining by domain (no org created) does NOT;
 *   - a non-applied verdict logs at error level, is returned to the caller,
 *     and leaves the signup result untouched (the acceptance criterion);
 *   - the code sent to the RPC satisfies the DB CHECK
 *     `^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$` — the mock enforces it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** Mirrors `referral_codes_code_format` exactly. A test double that accepted a
 *  code the database refuses would certify a call that 503s in production. */
const DB_CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;

const { mockRpc, mockFrom, mockReadReferralCode, mockClearReferralCode } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockFrom: vi.fn(() => ({
    insert: vi.fn(() => ({
      select: vi.fn(() => ({
        single: vi.fn().mockResolvedValue({ data: { id: 'new-org-direct' }, error: null }),
      })),
    })),
    update: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) })),
  })),
  mockReadReferralCode: vi.fn(),
  mockClearReferralCode: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: mockRpc,
    from: mockFrom,
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-123' } } }) },
  },
}));

vi.mock('@/lib/referralCapture', () => ({
  readReferralCode: mockReadReferralCode,
  clearReferralCode: mockClearReferralCode,
}));

import { renderHook, act } from '@testing-library/react';
import { useOnboarding, applyCapturedReferral } from './useOnboarding';

type FromChain = ReturnType<typeof mockFrom>;

function queueFrom(overrides: Partial<FromChain>) {
  mockFrom.mockReturnValueOnce({
    insert: vi.fn(() => ({
      select: vi.fn(() => ({ single: vi.fn().mockResolvedValue({ data: null, error: null }) })),
    })),
    update: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) })),
    ...overrides,
  });
}

/**
 * Routes `record_org_referral` to `referralVerdict` and every other RPC to
 * `onboardingResponse`, and asserts the code the caller sent is one the DB
 * CHECK would accept.
 */
function routeRpc(
  onboardingResponse: { data: unknown; error: unknown },
  referralVerdict: { data: unknown; error: unknown },
) {
  mockRpc.mockImplementation((fn: string, args: Record<string, unknown>) => {
    if (fn === 'record_org_referral') {
      expect(DB_CODE_RE.test(String(args.p_code))).toBe(true);
      expect(args.p_source).toBe('signup');
      return Promise.resolve(referralVerdict);
    }
    return Promise.resolve(onboardingResponse);
  });
}

function referralCalls(): Record<string, unknown>[] {
  return mockRpc.mock.calls
    .filter((c) => c[0] === 'record_org_referral')
    .map((c) => c[1] as Record<string, unknown>);
}

const RECORDED = { data: { applied: true, reason: 'recorded', referrer_public_id: 'org_abc' }, error: null };

describe('useOnboarding — referral attribution (SCRUM-5024)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockReadReferralCode.mockReturnValue('ABCD2345');
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('branch 1 of 3 — RPC path: attributes the org the RPC created', async () => {
    routeRpc(
      { data: { success: true, role: 'ORG_ADMIN', already_set: false, user_id: 'u1', org_id: 'org-rpc' }, error: null },
      RECORDED,
    );

    const { result } = renderHook(() => useOnboarding());
    let final: Awaited<ReturnType<typeof result.current.createOrg>> = null;
    await act(async () => {
      final = await result.current.createOrg({ legalName: 'A Inc.', displayName: 'A', domain: null });
    });

    expect(referralCalls()).toEqual([{ p_org_id: 'org-rpc', p_code: 'ABCD2345', p_source: 'signup' }]);
    expect(final!.org_id).toBe('org-rpc');
    expect(mockClearReferralCode).toHaveBeenCalledTimes(1);
  });

  it('branch 2 of 3 — RPC rejected, direct insert: attributes the directly created org', async () => {
    routeRpc({ data: null, error: { message: 'already onboarded' } }, RECORDED);
    queueFrom({
      insert: vi.fn(() => ({
        select: vi.fn(() => ({ single: vi.fn().mockResolvedValue({ data: { id: 'org-fb1' }, error: null }) })),
      })),
    });
    queueFrom({ insert: vi.fn().mockResolvedValue({ error: null }) });
    queueFrom({ update: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) })) });

    const { result } = renderHook(() => useOnboarding());
    let final: Awaited<ReturnType<typeof result.current.createOrg>> = null;
    await act(async () => {
      final = await result.current.createOrg({ legalName: 'B Inc.', displayName: 'B', domain: null });
    });

    expect(referralCalls()).toEqual([{ p_org_id: 'org-fb1', p_code: 'ABCD2345', p_source: 'signup' }]);
    expect(final!.success).toBe(true);
  });

  it('branch 3 of 3 — already_set with no org_id: attributes exactly once, not twice', async () => {
    routeRpc(
      { data: { success: true, role: 'ORG_ADMIN', already_set: true, user_id: 'u1' }, error: null },
      RECORDED,
    );
    queueFrom({
      insert: vi.fn(() => ({
        select: vi.fn(() => ({ single: vi.fn().mockResolvedValue({ data: { id: 'org-fb2' }, error: null }) })),
      })),
    });
    queueFrom({ insert: vi.fn().mockResolvedValue({ error: null }) });
    queueFrom({ update: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) })) });

    const { result } = renderHook(() => useOnboarding());
    await act(async () => {
      await result.current.createOrg({ legalName: 'C Inc.', displayName: 'C', domain: null });
    });

    // The `else if` guard: the fallback branch sets org_id, and the ordinary
    // branch must not then attribute the same organization a second time.
    expect(referralCalls()).toEqual([{ p_org_id: 'org-fb2', p_code: 'ABCD2345', p_source: 'signup' }]);
  });

  it('does not attribute when no code was captured', async () => {
    mockReadReferralCode.mockReturnValue(null);
    routeRpc(
      { data: { success: true, role: 'ORG_ADMIN', already_set: false, user_id: 'u1', org_id: 'org-rpc' }, error: null },
      RECORDED,
    );

    const { result } = renderHook(() => useOnboarding());
    await act(async () => {
      await result.current.createOrg({ legalName: 'D Inc.', displayName: 'D', domain: null });
    });

    expect(referralCalls()).toEqual([]);
    expect(mockClearReferralCode).not.toHaveBeenCalled();
  });

  it('joining by domain creates no organization, so it does not attribute', async () => {
    routeRpc({ data: { success: true, role: 'ORG_MEMBER', already_set: false, user_id: 'u1', org_id: 'org-existing' }, error: null }, RECORDED);

    const { result } = renderHook(() => useOnboarding());
    await act(async () => {
      await result.current.joinOrgByDomain('org-existing');
    });

    expect(referralCalls()).toEqual([]);
  });

  describe('non-applied outcomes are logged and never change the signup result', () => {
    const cases = ['unknown_code', 'self_referral', 'already_attributed'] as const;

    it.each(cases)('%s logs at error level and leaves createOrg successful', async (reason) => {
      routeRpc(
        { data: { success: true, role: 'ORG_ADMIN', already_set: false, user_id: 'u1', org_id: 'org-rpc' }, error: null },
        { data: { applied: false, reason }, error: null },
      );

      const { result } = renderHook(() => useOnboarding());
      let final: Awaited<ReturnType<typeof result.current.createOrg>> = null;
      await act(async () => {
        final = await result.current.createOrg({ legalName: 'E Inc.', displayName: 'E', domain: null });
      });

      expect(final!.success).toBe(true);
      expect(final!.org_id).toBe('org-rpc');
      expect(result.current.error).toBeNull();
      expect(errorSpy).toHaveBeenCalledWith(
        '[useOnboarding] referral not applied',
        expect.objectContaining({ orgId: 'org-rpc', reason }),
      );
    });
  });

  describe('applyCapturedReferral in isolation', () => {
    it('returns no_code without calling the RPC', async () => {
      mockReadReferralCode.mockReturnValue(null);
      await expect(applyCapturedReferral('org-1')).resolves.toEqual({ applied: false, reason: 'no_code' });
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('an RPC error is rpc_failed, logged, and leaves the code parked for a retry', async () => {
      mockRpc.mockResolvedValue({ data: null, error: { message: 'PGRST202' } });

      await expect(applyCapturedReferral('org-1')).resolves.toEqual({ applied: false, reason: 'rpc_failed' });
      expect(errorSpy).toHaveBeenCalledWith(
        '[useOnboarding] referral attribution RPC failed',
        expect.objectContaining({ orgId: 'org-1', reason: 'rpc_failed' }),
      );
      // Not cleared: the database never ruled, so a later attempt is still live.
      expect(mockClearReferralCode).not.toHaveBeenCalled();
    });

    it('a thrown RPC is threw, logged, and never propagates', async () => {
      mockRpc.mockRejectedValue(new Error('network down'));

      await expect(applyCapturedReferral('org-1')).resolves.toEqual({ applied: false, reason: 'threw' });
      expect(errorSpy).toHaveBeenCalledWith(
        '[useOnboarding] referral attribution threw',
        expect.objectContaining({ orgId: 'org-1', reason: 'threw' }),
      );
    });

    it('a verdict with no reason is reported as rpc_failed, never as a silent success', async () => {
      mockRpc.mockResolvedValue({ data: {}, error: null });
      await expect(applyCapturedReferral('org-1')).resolves.toEqual({ applied: false, reason: 'rpc_failed' });
    });

    it('a recorded verdict is applied and clears the parked code', async () => {
      mockRpc.mockResolvedValue(RECORDED);
      await expect(applyCapturedReferral('org-1')).resolves.toEqual({ applied: true, reason: 'recorded' });
      expect(mockClearReferralCode).toHaveBeenCalledTimes(1);
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });
});
