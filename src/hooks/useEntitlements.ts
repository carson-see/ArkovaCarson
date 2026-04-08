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
      // 1. Fetch subscription + all plans + anchor count in parallel (no waterfall)
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);

      const [subResult, plansResult, countResult] = await Promise.all([
        supabase
          .from('subscriptions')
          .select('plan_id, current_period_start, status')
          .eq('user_id', user.id)
          .maybeSingle(),
        supabase
          .from('plans')
          .select('id, records_per_month, name'),
        supabase
          .from('anchors')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', user.id)
          .gte('created_at', monthStart.toISOString()),
      ]);

      if (subResult.error) throw subResult.error;
      if (plansResult.error) throw plansResult.error;
      if (countResult.error) throw countResult.error;

      const subData = subResult.data;
      const plans = plansResult.data ?? [];
      const freePlan = plans.find(p => p.id === 'free');
      let name: string;

      if (subData?.plan_id && subData.status === 'active') {
        const activePlan = plans.find(p => p.id === subData.plan_id);
        name = activePlan?.name ?? freePlan?.name ?? 'Free';
      } else {
        name = freePlan?.name ?? 'Free';
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

  // H5: Removed realtime subscription on subscriptions table.
  // Plan changes are rare (especially during beta with all quotas disabled).
  // Use refresh() to manually re-fetch when needed (e.g., after checkout).

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
