/* eslint-disable arkova/no-unscoped-service-test -- Frontend: RLS enforced server-side by Supabase JWT, not manual query scoping */
/**
 * useEntitlements Hook Tests
 *
 * Updated for beta mode: all quotas disabled, recordsLimit = null (unlimited).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mocks
const mockFrom = vi.hoisted(() => vi.fn());
const mockUser = vi.hoisted(() => ({ current: { id: 'test-user-id' } as { id: string } | null }));

const mockChannel = vi.hoisted(() => ({
  on: vi.fn().mockReturnThis(),
  subscribe: vi.fn().mockReturnThis(),
}));
const mockRemoveChannel = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: mockFrom,
    channel: vi.fn(() => mockChannel),
    removeChannel: mockRemoveChannel,
  },
}));

vi.mock('./useAuth', () => ({
  useAuth: () => ({
    user: mockUser.current,
  }),
}));

import { renderHook, act, waitFor } from '@testing-library/react';
import { createQueryWrapper } from '@/tests/queryTestUtils';
import { useEntitlements } from './useEntitlements';

// Helper to set up mock chain for subscription + plan + count queries
function setupMocks(opts: {
  subscription?: { plan_id: string; current_period_start: string; status: string } | null;
  plan?: { records_per_month: number; name: string };
  freePlan?: { records_per_month: number; name: string };
  count?: number;
  subError?: Error | null;
  planError?: Error | null;
  countError?: Error | null;
}) {
  const {
    subscription = null,
    plan = { records_per_month: 100, name: 'Professional' },
    freePlan = { records_per_month: 3, name: 'Free' },
    count = 0,
    subError = null,
    planError = null,
    countError = null,
  } = opts;

  mockFrom.mockImplementation((table: string) => {
    if (table === 'subscriptions') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: subscription, error: subError }),
          }),
        }),
      };
    }
    if (table === 'plans') {
      // Hook now fetches all plans in parallel (no .eq().single())
      const allPlans = [
        { id: 'free', ...freePlan },
        ...(subscription?.plan_id && subscription.plan_id !== 'free'
          ? [{ id: subscription.plan_id, ...plan }]
          : []),
      ];
      return {
        select: () => Promise.resolve({ data: allPlans, error: planError }),
      };
    }
    if (table === 'anchors') {
      // Builder chain with abortSignal + Thenable so `await` works and the
      // hook's `.then(r => r, err => {...})` fallback path is exercisable.
      const result = { count, error: countError, data: null };
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = () => builder;
      builder.gte = () => builder;
      builder.abortSignal = () => builder;
      builder.then = (onFulfilled: (v: typeof result) => unknown, onRejected?: (e: unknown) => unknown) => {
        if (countError && onRejected) return Promise.resolve(onRejected(countError));
        return Promise.resolve(onFulfilled(result));
      };
      return builder;
    }
    return {};
  });
}

describe('useEntitlements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser.current = { id: 'test-user-id' };
  });

  // Beta: all users get unlimited (recordsLimit = null)
  it('should return unlimited for all users during beta', async () => {
    setupMocks({ count: 0 });

    const { result } = renderHook(() => useEntitlements(), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.planName).toBe('Free');
    expect(result.current.recordsLimit).toBeNull(); // unlimited in beta
    expect(result.current.recordsUsed).toBe(0);
    expect(result.current.remaining).toBeNull(); // unlimited
    expect(result.current.canCreateAnchor).toBe(true);
  });

  it('should return plan name for paid subscription', async () => {
    setupMocks({
      subscription: { plan_id: 'pro', current_period_start: '2026-03-01T00:00:00Z', status: 'active' },
      plan: { records_per_month: 100, name: 'Professional' },
      count: 42,
    });

    const { result } = renderHook(() => useEntitlements(), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.planName).toBe('Professional');
    expect(result.current.recordsLimit).toBeNull(); // unlimited in beta
    expect(result.current.recordsUsed).toBe(42);
    expect(result.current.canCreateAnchor).toBe(true);
    expect(result.current.isNearLimit).toBe(false);
  });

  it('should never block creation during beta', async () => {
    setupMocks({ count: 99999 });

    const { result } = renderHook(() => useEntitlements(), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.canCreateAnchor).toBe(true);
    expect(result.current.recordsLimit).toBeNull();
  });

  it('should not detect near-limit during beta (unlimited)', async () => {
    setupMocks({
      subscription: { plan_id: 'ind', current_period_start: '2026-03-01T00:00:00Z', status: 'active' },
      plan: { records_per_month: 10, name: 'Individual' },
      count: 8,
    });

    const { result } = renderHook(() => useEntitlements(), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.isNearLimit).toBe(false); // unlimited = never near limit
    expect(result.current.percentUsed).toBeNull();
    expect(result.current.canCreateAnchor).toBe(true);
  });

  it('should treat unlimited plans correctly (999999+)', async () => {
    setupMocks({
      subscription: { plan_id: 'org', current_period_start: '2026-03-01T00:00:00Z', status: 'active' },
      plan: { records_per_month: 999999, name: 'Organization' },
      count: 500,
    });

    const { result } = renderHook(() => useEntitlements(), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.recordsLimit).toBeNull();
    expect(result.current.remaining).toBeNull();
    expect(result.current.percentUsed).toBeNull();
    expect(result.current.isNearLimit).toBe(false);
    expect(result.current.canCreateAnchor).toBe(true);
  });

  it('canCreateCount should always return true during beta', async () => {
    setupMocks({ count: 1 });

    const { result } = renderHook(() => useEntitlements(), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.canCreateCount(1)).toBe(true);
    expect(result.current.canCreateCount(100)).toBe(true);
    expect(result.current.canCreateCount(999999)).toBe(true);
  });

  it('canCreateCount should always return true for unlimited', async () => {
    setupMocks({
      subscription: { plan_id: 'org', current_period_start: '2026-03-01T00:00:00Z', status: 'active' },
      plan: { records_per_month: 999999, name: 'Organization' },
      count: 5000,
    });

    const { result } = renderHook(() => useEntitlements(), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.canCreateCount(1)).toBe(true);
    expect(result.current.canCreateCount(100000)).toBe(true);
  });

  it('should fall back to beta unlimited for inactive subscription', async () => {
    setupMocks({
      subscription: { plan_id: 'pro', current_period_start: '2026-03-01T00:00:00Z', status: 'past_due' },
      count: 0,
    });

    const { result } = renderHook(() => useEntitlements(), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.planName).toBe('Free');
    expect(result.current.recordsLimit).toBeNull(); // unlimited in beta
  });

  it('should handle no user (logged out)', async () => {
    mockUser.current = null;

    const { result } = renderHook(() => useEntitlements(), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.planName).toBe('Free');
    expect(result.current.recordsLimit).toBe(3); // logged out = real free tier
    expect(result.current.recordsUsed).toBe(0);
  });

  it('should set error on subscription fetch failure', async () => {
    setupMocks({ subError: new Error('Network error') });

    const { result } = renderHook(() => useEntitlements(), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toContain('Network error');
  });

  it('should stay unlimited on fetch error during beta', async () => {
    setupMocks({ subError: new Error('DB connection lost') });

    const { result } = renderHook(() => useEntitlements(), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Beta: unlimited even on error
    expect(result.current.recordsLimit).toBeNull();
    expect(result.current.planName).toBe('Beta');
    expect(result.current.canCreateAnchor).toBe(true);
  });

  it('refresh should re-fetch entitlements', async () => {
    setupMocks({ count: 0 });

    const { result } = renderHook(() => useEntitlements(), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.recordsUsed).toBe(0);

    // Update mock to return different count
    setupMocks({ count: 2 });

    await act(async () => {
      await result.current.refresh();
    });

    // React Query refetch is async — wait for the new data
    await waitFor(() => expect(result.current.recordsUsed).toBe(2));
  });

  // BUG-2026-04-19-001 regression: anchor count timeout / RLS failure must
  // NOT strand the UsageWidget in its loading skeleton. Fall back to 0.
  it('falls back to recordsUsed=0 when anchor count errors (BUG-2026-04-19-001)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setupMocks({
      subscription: { plan_id: 'pro', current_period_start: '2026-03-01T00:00:00Z', status: 'active' },
      plan: { records_per_month: 100, name: 'Professional' },
      countError: new Error('statement timeout (25s)'),
    });

    const { result } = renderHook(() => useEntitlements(), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.recordsUsed).toBe(0);
    expect(result.current.planName).toBe('Professional');
    expect(result.current.error).toBeNull();
    expect(result.current.canCreateAnchor).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      '[useEntitlements] anchor count fell back to 0:',
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  // H5: Realtime subscription removed — plan changes are rare during beta.
  // Use refresh() to manually re-fetch when needed (e.g., after checkout).
  describe('H5: no realtime subscription (removed for perf)', () => {
    it('does not subscribe to subscription changes', async () => {
      setupMocks({ count: 0 });

      renderHook(() => useEntitlements(), { wrapper: createQueryWrapper() });

      await waitFor(() => {
        expect(mockChannel.on).not.toHaveBeenCalled();
        expect(mockChannel.subscribe).not.toHaveBeenCalled();
      });
    });

    it('does not create channel when user is null', async () => {
      mockUser.current = null;
      mockChannel.on.mockClear();
      mockChannel.subscribe.mockClear();

      renderHook(() => useEntitlements(), { wrapper: createQueryWrapper() });

      await waitFor(() => {
        expect(mockChannel.on).not.toHaveBeenCalled();
      });
    });
  });
});
