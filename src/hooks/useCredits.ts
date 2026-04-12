/**
 * useCredits Hook
 *
 * Fetches and manages user credit balance and allocation info.
 * Uses React Query for caching and deduplication.
 *
 * @see MVP-24, MVP-25
 */

import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { queryKeys } from '@/lib/queryClient';
import { useAuth } from './useAuth';

export interface CreditInfo {
  balance: number;
  monthly_allocation: number;
  purchased: number;
  plan_name: string;
  cycle_start: string | null;
  cycle_end: string | null;
  is_low: boolean;
}

interface UseCreditsReturn {
  credits: CreditInfo | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

async function fetchCreditsData(userId: string): Promise<CreditInfo> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error: rpcError } = await (supabase as any).rpc(
    'get_user_credits',
    { p_user_id: userId }
  );

  if (rpcError) throw rpcError;
  if (data?.error) throw new Error(data.error);

  return data as CreditInfo;
}

export function useCredits(): UseCreditsReturn {
  const { user } = useAuth();
  const qc = useQueryClient();

  const {
    data: credits = null,
    isLoading: loading,
    error: queryError,
  } = useQuery({
    queryKey: queryKeys.credits(user?.id ?? ''),
    queryFn: () => fetchCreditsData(user!.id),
    enabled: !!user,
    staleTime: 60_000,
  });

  const refresh = useCallback(async () => {
    if (user) {
      await qc.invalidateQueries({ queryKey: queryKeys.credits(user.id) });
    }
  }, [user, qc]);

  return {
    credits,
    loading: !user ? false : loading,
    error: queryError ? (queryError as Error).message : null,
    refresh,
  };
}
