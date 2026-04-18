/**
 * Entitlements Hook
 *
 * Checks the current user's plan quota and monthly anchor usage.
 * Provides canCreateAnchor, usage counts, and remaining quota.
 *
 * Uses React Query for caching — entitlement data shared across pages instantly.
 *
 * @see CRIT-3 — Entitlement enforcement
 */

import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { queryKeys } from '../lib/queryClient';
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

interface EntitlementData {
  recordsUsed: number;
  recordsLimit: number | null;
  planName: string;
}

async function fetchEntitlementData(userId: string): Promise<EntitlementData> {
  // BUG-2026-04-19-001: Counting this-month anchors through RLS on a 2.8M-row
  // table takes 23s and 500s at the 30s Supabase REST timeout for platform
  // admins / high-volume pipeline operators. Migration 0220 introduces
  // `get_user_monthly_anchor_count` — a SECURITY DEFINER RPC that bypasses
  // RLS and returns in <100ms. The RPC enforces per-user isolation
  // internally (returns 0 if p_user_id != auth.uid()). On any error we
  // degrade to 0 — recordsLimit is null (unlimited) in beta, so the count
  // is advisory and must not strand the widget in its skeleton state.
  const countPromise = supabase
    // Supabase types regen runs via `npm run gen:types`; new RPC will appear
    // after the next regen. Until then the name cast is expected.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .rpc('get_user_monthly_anchor_count' as any, { p_user_id: userId })
    .then(
      (r) => ({ count: (typeof r.data === 'number' ? r.data : 0), error: r.error }),
      (err: unknown) => {
        console.warn('[useEntitlements] anchor count RPC rejected, falling back to 0:', err);
        return { count: 0, error: null };
      },
    );

  const [subResult, plansResult, countResult] = await Promise.all([
    supabase
      .from('subscriptions')
      .select('plan_id, current_period_start, status')
      .eq('user_id', userId)
      .maybeSingle(),
    supabase
      .from('plans')
      .select('id, records_per_month, name'),
    countPromise,
  ]);

  if (subResult.error) throw subResult.error;
  if (plansResult.error) throw plansResult.error;
  // NOTE: intentionally do NOT throw on countResult.error — the count is
  // advisory in beta (recordsLimit is always null). Throwing here would keep
  // the widget in its skeleton state, which is BUG-2026-04-19-001.
  if (countResult.error) {
    console.warn('[useEntitlements] anchor count RPC error, falling back to 0:', countResult.error);
  }

  const subData = subResult.data;
  const plans = plansResult.data ?? [];
  const freePlan = plans.find(p => p.id === 'free');

  let planName: string;
  if (subData?.plan_id && subData.status === 'active') {
    const activePlan = plans.find(p => p.id === subData.plan_id);
    planName = activePlan?.name ?? freePlan?.name ?? 'Free';
  } else {
    planName = freePlan?.name ?? 'Free';
  }

  return {
    recordsUsed: countResult.count ?? 0,
    recordsLimit: null, // null = unlimited in beta
    planName,
  };
}

export function useEntitlements(): EntitlementState & EntitlementActions {
  const { user } = useAuth();
  const qc = useQueryClient();

  const {
    data,
    isLoading: loading,
    error: queryError,
  } = useQuery({
    queryKey: queryKeys.entitlements(user?.id ?? ''),
    queryFn: () => fetchEntitlementData(user!.id),
    enabled: !!user,
    staleTime: 60_000, // Entitlements rarely change — 1 min stale
  });

  // When no user: return free tier defaults (not unlimited)
  const recordsUsed = data?.recordsUsed ?? 0;
  const recordsLimit = !user ? 3 : (queryError ? null : (data?.recordsLimit ?? null));
  const planName = !user ? 'Free' : (queryError ? 'Beta' : (data?.planName ?? 'Free'));
  const error = queryError ? (queryError as Error).message : null;

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

  const refresh = useCallback(async () => {
    if (user) {
      await qc.invalidateQueries({ queryKey: queryKeys.entitlements(user.id) });
    }
  }, [user, qc]);

  return useMemo(() => ({
    canCreateAnchor,
    recordsUsed,
    recordsLimit,
    remaining,
    percentUsed,
    isNearLimit,
    planName,
    loading: !user ? false : loading,
    error,
    refresh,
    canCreateCount,
  }), [canCreateAnchor, recordsUsed, recordsLimit, remaining, percentUsed, isNearLimit, planName, user, loading, error, refresh, canCreateCount]);
}
