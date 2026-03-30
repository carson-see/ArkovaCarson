/**
 * Billing Hook
 *
 * Fetches the current user's subscription and plan data from Supabase.
 * Provides billing state for BillingOverview.
 *
 * @see P7-TS-02
 */

import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { workerPostForUrl } from '../lib/workerClient';
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

export function useBilling(): BillingState & BillingActions {
  const { user } = useAuth();
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchBilling = useCallback(async () => {
    if (!user) {
      setSubscription(null);
      setPlan(null);
      setPlans([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Fetch all available plans
      const { data: plansData, error: plansError } = await supabase
        .from('plans')
        .select('*')
        .order('price_cents', { ascending: true });

      if (plansError) throw plansError;
      setPlans(plansData ?? []);

      // Fetch user's subscription
      const { data: subData, error: subError } = await supabase
        .from('subscriptions')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();

      if (subError) throw subError;
      setSubscription(subData);

      // Fetch the user's current plan
      if (subData?.plan_id) {
        const currentPlan = plansData?.find(p => p.id === subData.plan_id) ?? null;
        setPlan(currentPlan);
      } else {
        // Default to free plan
        const freePlan = plansData?.find(p => p.price_cents === 0) ?? null;
        setPlan(freePlan);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load billing data';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchBilling();
  }, [fetchBilling]);

  const startCheckout = useCallback(async (planId: string): Promise<string | null> => {
    if (!user) {
      setError('You must be signed in to subscribe');
      return null;
    }

    setError(null);

    try {
      return await workerPostForUrl('/api/checkout/session', { planId });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start checkout';
      setError(message);
      return null;
    }
  }, [user]);

  const openBillingPortal = useCallback(async (): Promise<string | null> => {
    if (!user) {
      setError('You must be signed in to manage billing');
      return null;
    }

    setError(null);

    try {
      return await workerPostForUrl('/api/billing/portal', {});
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to open billing portal';
      setError(message);
      return null;
    }
  }, [user]);

  return {
    subscription,
    plan,
    plans,
    loading,
    error,
    startCheckout,
    openBillingPortal,
    refresh: fetchBilling,
  };
}
