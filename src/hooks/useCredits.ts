/**
 * useCredits Hook
 *
 * Fetches and manages user credit balance and allocation info.
 *
 * @see MVP-24, MVP-25
 */

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
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

export function useCredits(): UseCreditsReturn {
  const { user } = useAuth();
  const [credits, setCredits] = useState<CreditInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchCredits = useCallback(async () => {
    if (!user) {
      setCredits(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error: rpcError } = await (supabase.rpc as any)(
        'get_user_credits',
        { p_user_id: user.id }
      );

      if (rpcError) {
        setError(rpcError.message);
        return;
      }

      if (data?.error) {
        setError(data.error);
        return;
      }

      setCredits(data as CreditInfo);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch credits');
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchCredits();
  }, [fetchCredits]);

  return { credits, loading, error, refresh: fetchCredits };
}
