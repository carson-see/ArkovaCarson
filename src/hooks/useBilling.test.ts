/* eslint-disable arkova/no-unscoped-service-test -- Frontend: RLS enforced server-side by Supabase JWT, not manual query scoping */
/* eslint-disable arkova/no-mock-echo -- Integration test: verifies data flows through hook/component to rendered output */
/**
 * useBilling Hook Tests
 * @see P7-TS-02
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBilling } from './useBilling';

// Hoisted mocks
const mockFrom = vi.hoisted(() => vi.fn());
const mockUser = vi.hoisted(() => ({ id: 'user-123', email: 'test@arkova.local' }));
const mockUseAuth = vi.hoisted(() => vi.fn(() => ({ user: mockUser })));

const mockGetSession = vi.hoisted(() => vi.fn(() =>
  Promise.resolve({ data: { session: { access_token: 'mock-jwt-token' } } })
));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: mockFrom,
    auth: {
      getSession: mockGetSession,
    },
  },
}));

vi.mock('./useAuth', () => ({
  useAuth: mockUseAuth,
}));

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const mockPlans = [
  { id: 'plan-free', name: 'Free', price_cents: 0, records_per_month: 3, stripe_price_id: null },
  { id: 'plan-ind', name: 'Individual', price_cents: 1000, records_per_month: 10, stripe_price_id: 'price_ind' },
  { id: 'plan-pro', name: 'Professional', price_cents: 10000, records_per_month: 100, stripe_price_id: 'price_pro' },
];

const mockSubscription = {
  id: 'sub-1',
  user_id: 'user-123',
  plan_id: 'plan-ind',
  stripe_subscription_id: 'sub_stripe_1',
  stripe_customer_id: 'cus_1',
  status: 'active',
  current_period_end: '2026-04-10T00:00:00Z',
};

function setupSupabaseMock(opts: {
  plans?: { data: unknown[] | null; error: unknown };
  subscription?: { data: unknown | null; error: unknown };
}) {
  mockFrom.mockImplementation((table: string) => {
    if (table === 'plans') {
      return {
        select: () => ({
          order: () => Promise.resolve(opts.plans ?? { data: mockPlans, error: null }),
        }),
      };
    }
    if (table === 'subscriptions') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve(opts.subscription ?? { data: null, error: null }),
          }),
        }),
      };
    }
    return { select: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) };
  });
}

describe('useBilling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAuth.mockReturnValue({ user: mockUser });
  });

  it('loads plans and defaults to free plan when no subscription', async () => {
    setupSupabaseMock({ plans: { data: mockPlans, error: null }, subscription: { data: null, error: null } });

    const { result } = renderHook(() => useBilling());

    // Wait for loading to finish
    await vi.waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.plans).toHaveLength(3);
    expect(result.current.plan?.name).toBe('Free');
    expect(result.current.subscription).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('loads subscription and matches current plan', async () => {
    setupSupabaseMock({
      plans: { data: mockPlans, error: null },
      subscription: { data: mockSubscription, error: null },
    });

    const { result } = renderHook(() => useBilling());
    await vi.waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.subscription?.status).toBe('active');
    expect(result.current.plan?.name).toBe('Individual');
  });

  it('sets error when plans query fails', async () => {
    setupSupabaseMock({
      plans: { data: null, error: { message: 'DB error' } },
      subscription: { data: null, error: null },
    });

    const { result } = renderHook(() => useBilling());
    await vi.waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe('Failed to load billing data');
    expect(result.current.plans).toHaveLength(0);
  });

  it('resets state when user is null', async () => {
    mockUseAuth.mockReturnValue({ user: null as unknown as { id: string; email: string } });

    const { result } = renderHook(() => useBilling());
    await vi.waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.plans).toHaveLength(0);
    expect(result.current.plan).toBeNull();
    expect(result.current.subscription).toBeNull();
  });

  describe('startCheckout', () => {
    beforeEach(() => {
      setupSupabaseMock({ plans: { data: mockPlans, error: null }, subscription: { data: null, error: null } });
    });

    it('returns checkout URL on success', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ url: 'https://checkout.stripe.com/session_123' }),
      });

      const { result } = renderHook(() => useBilling());
      await vi.waitFor(() => expect(result.current.loading).toBe(false));

      let url: string | null = null;
      await act(async () => {
        url = await result.current.startCheckout('plan-ind');
      });

      expect(url).toBe('https://checkout.stripe.com/session_123');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/checkout/session'),
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer mock-jwt-token',
          },
          body: JSON.stringify({ planId: 'plan-ind' }),
        }),
      );
    });

    it('sets error on failed checkout', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: 'Invalid plan' }),
      });

      const { result } = renderHook(() => useBilling());
      await vi.waitFor(() => expect(result.current.loading).toBe(false));

      let url: string | null = null;
      await act(async () => {
        url = await result.current.startCheckout('bad-plan');
      });

      expect(url).toBeNull();
      expect(result.current.error).toBe('Invalid plan');
    });

    it('returns null when user is not signed in', async () => {
      mockUseAuth.mockReturnValue({ user: null as unknown as { id: string; email: string } });

      const { result } = renderHook(() => useBilling());
      await vi.waitFor(() => expect(result.current.loading).toBe(false));

      let url: string | null = null;
      await act(async () => {
        url = await result.current.startCheckout('plan-ind');
      });

      expect(url).toBeNull();
      expect(result.current.error).toBe('You must be signed in to subscribe');
    });
  });

  describe('openBillingPortal', () => {
    beforeEach(() => {
      setupSupabaseMock({ plans: { data: mockPlans, error: null }, subscription: { data: mockSubscription, error: null } });
    });

    it('returns portal URL on success', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ url: 'https://billing.stripe.com/portal_123' }),
      });

      const { result } = renderHook(() => useBilling());
      await vi.waitFor(() => expect(result.current.loading).toBe(false));

      let url: string | null = null;
      await act(async () => {
        url = await result.current.openBillingPortal();
      });

      expect(url).toBe('https://billing.stripe.com/portal_123');
    });

    it('sets error on failure', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'Portal error' }),
      });

      const { result } = renderHook(() => useBilling());
      await vi.waitFor(() => expect(result.current.loading).toBe(false));

      let url: string | null = null;
      await act(async () => {
        url = await result.current.openBillingPortal();
      });

      expect(url).toBeNull();
      expect(result.current.error).toBe('Portal error');
    });
  });

  describe('refresh', () => {
    it('re-fetches billing data', async () => {
      setupSupabaseMock({ plans: { data: mockPlans, error: null }, subscription: { data: null, error: null } });

      const { result } = renderHook(() => useBilling());
      await vi.waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.plan?.name).toBe('Free');

      // Now update mock to return a subscription
      setupSupabaseMock({
        plans: { data: mockPlans, error: null },
        subscription: { data: mockSubscription, error: null },
      });

      await act(async () => {
        await result.current.refresh();
      });

      expect(result.current.plan?.name).toBe('Individual');
    });
  });
});
