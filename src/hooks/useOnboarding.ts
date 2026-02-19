/**
 * Onboarding Hook
 *
 * Handles the onboarding flow including role selection and org creation.
 * Uses the transactional update_profile_onboarding RPC function.
 */

import { useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';

type UserRole = 'INDIVIDUAL' | 'ORG_ADMIN';

interface OnboardingResult {
  success: boolean;
  role: string;
  already_set: boolean;
  user_id: string;
  org_id?: string;
}

interface OnboardingState {
  loading: boolean;
  error: string | null;
  result: OnboardingResult | null;
}

interface OnboardingActions {
  setRole: (role: UserRole) => Promise<OnboardingResult | null>;
  createOrg: (data: {
    legalName: string;
    displayName: string;
    domain: string | null;
  }) => Promise<OnboardingResult | null>;
  clearError: () => void;
}

export function useOnboarding(): OnboardingState & OnboardingActions {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OnboardingResult | null>(null);

  const setRole = useCallback(async (role: UserRole): Promise<OnboardingResult | null> => {
    setLoading(true);
    setError(null);

    try {
      // For INDIVIDUAL, just set the role
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error: rpcError } = await (supabase.rpc as any)(
        'update_profile_onboarding',
        { p_role: role }
      );

      if (rpcError) {
        setError(rpcError.message);
        setLoading(false);
        return null;
      }

      const onboardingResult = data as OnboardingResult;
      setResult(onboardingResult);
      setLoading(false);
      return onboardingResult;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to set role';
      setError(message);
      setLoading(false);
      return null;
    }
  }, []);

  const createOrg = useCallback(
    async (data: {
      legalName: string;
      displayName: string;
      domain: string | null;
    }): Promise<OnboardingResult | null> => {
      setLoading(true);
      setError(null);

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: rpcData, error: rpcError } = await (supabase.rpc as any)(
          'update_profile_onboarding',
          {
            p_role: 'ORG_ADMIN',
            p_org_legal_name: data.legalName,
            p_org_display_name: data.displayName,
            p_org_domain: data.domain,
          }
        );

        if (rpcError) {
          setError(rpcError.message);
          setLoading(false);
          return null;
        }

        const onboardingResult = rpcData as OnboardingResult;
        setResult(onboardingResult);
        setLoading(false);
        return onboardingResult;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create organization';
        setError(message);
        setLoading(false);
        return null;
      }
    },
    []
  );

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    loading,
    error,
    result,
    setRole,
    createOrg,
    clearError,
  };
}
