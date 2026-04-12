/**
 * Billing Hook
 *
 * Fetches the current user's subscription and plan data from Supabase.
 * Provides billing state for BillingOverview.
 * Uses React Query for caching and deduplication.
 *
 * @see P7-TS-02
 */

import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { workerPostForUrl } from '../lib/workerClient';
import { queryKeys } from '../lib/queryClient';
import { useAuth } from './useAuth';
import type { Database } from '../types/database.types';

type Subscription = Database['public']['Tables']['subscriptions']['Row'];
type Plan = Database['public']['Tables']['plans']['Row'];

export interface BillingState {
  subscription: Subscription | null;
  plan: Plan | null;
  plans: Plan[];
  loading: boolean;
  error: string | null;
}

interface BillingActions {
  /** Create a Stripe checkout session and return the redirect URL */
  startCheckout: (planId: string) => Promise<string | null>;
  /** Open the Stripe billing portal for subscription management */
  openBillingPortal: () => Promise<string | null>;
  /** Refresh billing data */
  refresh: () => Promise<void>;
}

interface BillingData {
  subscription: Subscription | null;
  plan: Plan | null;
  plans: Plan[];
}

async function fetchBillingData(userId: string): Promise<BillingData> {
  // Fetch all available plans
  const { data: plansData, error: plansError } = await supabase
    .from('plans')
    .select('*')
    .order('price_cents', { ascending: true });

  if (plansError) throw plansError;
  const plans = plansData ?? [];

  // Fetch user's subscription
  const { data: subData, error: subError } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (subError) throw subError;

  // Determine current plan
  let plan: Plan | null = null;
  if (subData?.plan_id) {
    plan = plans.find(p => p.id === subData.plan_id) ?? null;
  }
  if (!plan) {
    plan = plans.find(p => p.price_cents === 0) ?? null;
  }

  return { subscription: subData, plan, plans };
}

export function useBilling(): BillingState & BillingActions {
  const { user } = useAuth();
  const qc = useQueryClient();

  const {
    data,
    isLoading: loading,
    error: queryError,
  } = useQuery({
    queryKey: queryKeys.billing(user?.id ?? ''),
    queryFn: () => fetchBillingData(user!.id),
    enabled: !!user,
    staleTime: 60_000,
  });

  const error = queryError ? (queryError as Error).message : null;

  const refresh = useCallback(async () => {
    if (user) {
      await qc.invalidateQueries({ queryKey: queryKeys.billing(user.id) });
    }
  }, [user, qc]);

  const startCheckout = useCallback(async (planId: string): Promise<string | null> => {
    if (!user) return null;
    try {
      return await workerPostForUrl('/api/checkout/session', { planId });
    } catch {
      return null;
    }
  }, [user]);

  const openBillingPortal = useCallback(async (): Promise<string | null> => {
    if (!user) return null;
    try {
      return await workerPostForUrl('/api/billing/portal', {});
    } catch {
      return null;
    }
  }, [user]);

  return {
    subscription: data?.subscription ?? null,
    plan: data?.plan ?? null,
    plans: data?.plans ?? [],
    loading: !user ? false : loading,
    error,
    startCheckout,
    openBillingPortal,
    refresh,
  };
}
