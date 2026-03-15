/**
 * useEntitlements Hook Tests
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
      const planData = subscription?.plan_id && subscription.status === 'active' ? plan : freePlan;
      return {
        select: () => ({
          eq: () => ({
            single: () => Promise.resolve({ data: planData, error: planError }),
          }),
        }),
      };
    }
    if (table === 'anchors') {
      return {
        select: () => ({
          eq: () => ({
            gte: () => Promise.resolve({ count, error: countError }),
          }),
        }),
      };
    }
    return {};
  });
}

describe('useEntitlements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser.current = { id: 'test-user-id' };
  });

  it('should return free tier defaults when no subscription', async () => {
    setupMocks({ count: 0 });

    const { result } = renderHook(() => useEntitlements());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.planName).toBe('Free');
    expect(result.current.recordsLimit).toBe(3);
    expect(result.current.recordsUsed).toBe(0);
    expect(result.current.remaining).toBe(3);
    expect(result.current.canCreateAnchor).toBe(true);
  });

  it('should return correct quota for paid plan', async () => {
    setupMocks({
      subscription: { plan_id: 'pro', current_period_start: '2026-03-01T00:00:00Z', status: 'active' },
      plan: { records_per_month: 100, name: 'Professional' },
      count: 42,
    });

    const { result } = renderHook(() => useEntitlements());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.planName).toBe('Professional');
    expect(result.current.recordsLimit).toBe(100);
    expect(result.current.recordsUsed).toBe(42);
    expect(result.current.remaining).toBe(58);
    expect(result.current.canCreateAnchor).toBe(true);
    expect(result.current.percentUsed).toBe(42);
    expect(result.current.isNearLimit).toBe(false);
  });

  it('should block creation when quota exhausted', async () => {
    setupMocks({ count: 3 });

    const { result } = renderHook(() => useEntitlements());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.canCreateAnchor).toBe(false);
    expect(result.current.remaining).toBe(0);
    expect(result.current.percentUsed).toBe(100);
  });

  it('should detect near-limit state (>=80%)', async () => {
    setupMocks({
      subscription: { plan_id: 'ind', current_period_start: '2026-03-01T00:00:00Z', status: 'active' },
      plan: { records_per_month: 10, name: 'Individual' },
      count: 8,
    });

    const { result } = renderHook(() => useEntitlements());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.isNearLimit).toBe(true);
    expect(result.current.percentUsed).toBe(80);
    expect(result.current.remaining).toBe(2);
    expect(result.current.canCreateAnchor).toBe(true);
  });

  it('should treat unlimited plans correctly (999999+)', async () => {
    setupMocks({
      subscription: { plan_id: 'org', current_period_start: '2026-03-01T00:00:00Z', status: 'active' },
      plan: { records_per_month: 999999, name: 'Organization' },
      count: 500,
    });

    const { result } = renderHook(() => useEntitlements());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.recordsLimit).toBeNull();
    expect(result.current.remaining).toBeNull();
    expect(result.current.percentUsed).toBeNull();
    expect(result.current.isNearLimit).toBe(false);
    expect(result.current.canCreateAnchor).toBe(true);
  });

  it('canCreateCount should check bulk amounts', async () => {
    setupMocks({ count: 1 }); // free tier: 3 limit, 1 used, 2 remaining

    const { result } = renderHook(() => useEntitlements());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.canCreateCount(1)).toBe(true);
    expect(result.current.canCreateCount(2)).toBe(true);
    expect(result.current.canCreateCount(3)).toBe(false);
    expect(result.current.canCreateCount(100)).toBe(false);
  });

  it('canCreateCount should always return true for unlimited', async () => {
    setupMocks({
      subscription: { plan_id: 'org', current_period_start: '2026-03-01T00:00:00Z', status: 'active' },
      plan: { records_per_month: 999999, name: 'Organization' },
      count: 5000,
    });

    const { result } = renderHook(() => useEntitlements());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.canCreateCount(1)).toBe(true);
    expect(result.current.canCreateCount(100000)).toBe(true);
  });

  it('should fall back to free tier for inactive subscription', async () => {
    setupMocks({
      subscription: { plan_id: 'pro', current_period_start: '2026-03-01T00:00:00Z', status: 'past_due' },
      count: 0,
    });

    const { result } = renderHook(() => useEntitlements());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.planName).toBe('Free');
    expect(result.current.recordsLimit).toBe(3);
  });

  it('should handle no user (logged out)', async () => {
    mockUser.current = null;

    const { result } = renderHook(() => useEntitlements());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.planName).toBe('Free');
    expect(result.current.recordsLimit).toBe(3);
    expect(result.current.recordsUsed).toBe(0);
  });

  it('should set error on subscription fetch failure', async () => {
    setupMocks({ subError: new Error('Network error') });

    const { result } = renderHook(() => useEntitlements());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toContain('Network error');
  });

  it('should fall back to free tier on fetch error (not fail open)', async () => {
    setupMocks({ subError: new Error('DB connection lost') });

    const { result } = renderHook(() => useEntitlements());

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Verify it does NOT stay in the unlimited state (recordsLimit=null)
    // after an error — it should fall back to free tier limits
    expect(result.current.recordsLimit).toBe(3);
    expect(result.current.planName).toBe('Free');
    expect(result.current.canCreateAnchor).toBe(true); // free tier with 0 usage
  });

  it('refresh should re-fetch entitlements', async () => {
    setupMocks({ count: 0 });

    const { result } = renderHook(() => useEntitlements());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.recordsUsed).toBe(0);

    // Update mock to return different count
    setupMocks({ count: 2 });

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.recordsUsed).toBe(2);
  });

  // DH-10: Realtime subscription
  describe('DH-10: realtime subscription', () => {
    it('subscribes to subscriptions and anchors changes when user is present', async () => {
      setupMocks({ count: 0 });

      renderHook(() => useEntitlements());

      await waitFor(() => {
        // Channel should be set up with postgres_changes listeners
        expect(mockChannel.on).toHaveBeenCalledTimes(2);
        expect(mockChannel.subscribe).toHaveBeenCalled();
      });

      // First on() call: subscriptions table
      expect(mockChannel.on).toHaveBeenCalledWith(
        'postgres_changes',
        expect.objectContaining({
          event: '*',
          schema: 'public',
          table: 'subscriptions',
        }),
        expect.any(Function),
      );

      // Second on() call: anchors table INSERT
      expect(mockChannel.on).toHaveBeenCalledWith(
        'postgres_changes',
        expect.objectContaining({
          event: 'INSERT',
          schema: 'public',
          table: 'anchors',
        }),
        expect.any(Function),
      );
    });

    it('does not subscribe when user is null', async () => {
      mockUser.current = null;
      mockChannel.on.mockClear();
      mockChannel.subscribe.mockClear();

      renderHook(() => useEntitlements());

      await waitFor(() => {
        expect(mockChannel.on).not.toHaveBeenCalled();
      });
    });

    it('cleans up channel on unmount', async () => {
      setupMocks({ count: 0 });

      const { unmount } = renderHook(() => useEntitlements());

      await waitFor(() => {
        expect(mockChannel.subscribe).toHaveBeenCalled();
      });

      unmount();

      expect(mockRemoveChannel).toHaveBeenCalledWith(mockChannel);
    });
  });
});
