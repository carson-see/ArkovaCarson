/**
 * Entitlements Hook
 *
 * Checks the current user's plan quota and monthly anchor usage.
 * Provides canCreateAnchor, usage counts, and remaining quota.
 *
 * @see CRIT-3 — Entitlement enforcement
 */

import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';

export interface EntitlementState {
  /** Whether the user can create at least one more anchor this period */
  canCreateAnchor: boolean;
  /** Number of anchors created in the current billing period */
  recordsUsed: number;
  /** Plan's monthly limit (null = unlimited) */
  recordsLimit: number | null;
  /** How many more anchors can be created (null = unlimited) */
  remaining: number | null;
  /** Percentage of quota used (0-100, null if unlimited) */
  percentUsed: number | null;
  /** Whether user is near their limit (>=80%) */
  isNearLimit: boolean;
  /** Current plan name */
  planName: string;
  /** Whether data is still loading */
  loading: boolean;
  /** Error message if quota check failed */
  error: string | null;
}

interface EntitlementActions {
  /** Re-fetch entitlement data */
  refresh: () => Promise<void>;
  /** Check if a specific number of records can be created */
  canCreateCount: (count: number) => boolean;
}

export function useEntitlements(): EntitlementState & EntitlementActions {
  const { user } = useAuth();
  const [recordsUsed, setRecordsUsed] = useState(0);
  const [recordsLimit, setRecordsLimit] = useState<number | null>(null);
  const [planName, setPlanName] = useState('Free');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchEntitlements = useCallback(async () => {
    if (!user) {
      setRecordsUsed(0);
      setRecordsLimit(3); // Default free limit
      setPlanName('Free');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // 1. Fetch subscription + plans + anchor count in parallel
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);

      const [subResult, freePlanResult, countResult] = await Promise.all([
        supabase
          .from('subscriptions')
          .select('plan_id, current_period_start, status')
          .eq('user_id', user.id)
          .maybeSingle(),
        supabase
          .from('plans')
          .select('records_per_month, name')
          .eq('id', 'free')
          .single(),
        supabase
          .from('anchors')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', user.id)
          .gte('created_at', monthStart.toISOString()),
      ]);

      if (subResult.error) throw subResult.error;
      if (freePlanResult.error) throw freePlanResult.error;
      if (countResult.error) throw countResult.error;

      const subData = subResult.data;
      let name: string;

      if (subData?.plan_id && subData.status === 'active') {
        // Fetch active plan details (only when needed)
        const { data: planData, error: planError } = await supabase
          .from('plans')
          .select('records_per_month, name')
          .eq('id', subData.plan_id)
          .single();

        if (planError) throw planError;
        name = planData.name;
      } else {
        name = freePlanResult.data.name;
      }

      const count = countResult.count;

      // Beta: set unlimited for all users — credit/quota enforcement disabled
      setRecordsUsed(count ?? 0);
      setRecordsLimit(null); // null = unlimited in beta
      setPlanName(name);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to check plan quota';
      setError(message);
      // Fail closed: fall back to free tier defaults on error.
      // Never leave recordsLimit as null (unlimited) when we can't verify the plan.
      setRecordsLimit(null); // Beta: unlimited on error too
      setPlanName('Beta');
      setRecordsUsed(0);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchEntitlements();
  }, [fetchEntitlements]);

  // DH-10: Subscribe to billing_subscriptions changes for live quota updates
  useEffect(() => {
    if (!user) return;

    const channel = supabase
      .channel(`entitlements-${user.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'subscriptions',
          filter: `user_id=eq.${user.id}`,
        },
        () => {
          // Re-fetch entitlements when subscription changes
          fetchEntitlements();
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, fetchEntitlements]);

  const isUnlimited = recordsLimit === null;
  const remaining = isUnlimited ? null : Math.max(0, recordsLimit - recordsUsed);
  const percentUsed = isUnlimited ? null : Math.min(100, (recordsUsed / recordsLimit) * 100);
  const isNearLimit = percentUsed !== null && percentUsed >= 80;
  const canCreateAnchor = isUnlimited || (remaining !== null && remaining > 0);

  const canCreateCount = useCallback(
    (count: number): boolean => {
      if (isUnlimited) return true;
      return remaining !== null && remaining >= count;
    },
    [isUnlimited, remaining],
  );

  return {
    canCreateAnchor,
    recordsUsed,
    recordsLimit,
    remaining,
    percentUsed,
    isNearLimit,
    planName,
    loading,
    error,
    refresh: fetchEntitlements,
    canCreateCount,
  };
}
