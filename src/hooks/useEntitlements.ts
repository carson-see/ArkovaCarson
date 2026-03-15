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

const UNLIMITED_THRESHOLD = 999999;

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
      // 1. Get user's subscription + plan in one query
      const { data: subData, error: subError } = await supabase
        .from('subscriptions')
        .select('plan_id, current_period_start, status')
        .eq('user_id', user.id)
        .maybeSingle();

      if (subError) throw subError;

      let limit: number;
      let name: string;
      let periodStart: string | null = null;

      if (subData?.plan_id && subData.status === 'active') {
        // Fetch plan details
        const { data: planData, error: planError } = await supabase
          .from('plans')
          .select('records_per_month, name')
          .eq('id', subData.plan_id)
          .single();

        if (planError) throw planError;

        limit = planData.records_per_month;
        name = planData.name;
        periodStart = subData.current_period_start;
      } else {
        // No active subscription — free tier
        const { data: freePlan, error: freePlanError } = await supabase
          .from('plans')
          .select('records_per_month, name')
          .eq('id', 'free')
          .single();

        if (freePlanError) throw freePlanError;
        limit = freePlan.records_per_month;
        name = freePlan.name;
      }

      // 2. Count anchors created in current period
      let countQuery = supabase
        .from('anchors')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id);

      if (periodStart) {
        countQuery = countQuery.gte('created_at', periodStart);
      } else {
        // Free users: count from start of current calendar month
        const monthStart = new Date();
        monthStart.setDate(1);
        monthStart.setHours(0, 0, 0, 0);
        countQuery = countQuery.gte('created_at', monthStart.toISOString());
      }

      const { count, error: countError } = await countQuery;
      if (countError) throw countError;

      setRecordsUsed(count ?? 0);
      setRecordsLimit(limit >= UNLIMITED_THRESHOLD ? null : limit);
      setPlanName(name);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to check plan quota';
      setError(message);
      // Fail closed: fall back to free tier defaults on error.
      // Never leave recordsLimit as null (unlimited) when we can't verify the plan.
      setRecordsLimit(3);
      setPlanName('Free');
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
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'anchors',
          filter: `user_id=eq.${user.id}`,
        },
        () => {
          // Re-fetch when new anchors are created (quota decrement)
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
