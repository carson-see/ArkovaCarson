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

interface OrgMatch {
  found: boolean;
  org_id?: string;
  org_name?: string;
  domain?: string;
}

interface OnboardingActions {
  setRole: (role: UserRole) => Promise<OnboardingResult | null>;
  createOrg: (data: {
    legalName: string;
    displayName: string;
    domain: string | null;
  }) => Promise<OnboardingResult | null>;
  lookupOrgByEmail: (email: string) => Promise<OrgMatch | null>;
  joinOrgByDomain: (orgId: string) => Promise<OnboardingResult | null>;
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
        // Try the onboarding RPC first (works for new users)
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
          // If onboarding RPC fails (user already onboarded), create org directly
          const { data: orgData, error: orgError } = await supabase
            .from('organizations')
            .insert({
              legal_name: data.legalName || data.displayName,
              display_name: data.displayName,
              domain: data.domain,
            })
            .select('id')
            .single();

          if (orgError) {
            setError(orgError.message);
            setLoading(false);
            return null;
          }

          // Add the user as ORG_ADMIN member
          const { data: { user: currentUser } } = await supabase.auth.getUser();
          if (currentUser && orgData) {
            await supabase
              .from('org_members')
              .insert({
                org_id: orgData.id,
                user_id: currentUser.id,
                role: 'admin' as const,
              });

            // Update profile with org_id
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (supabase as any)
              .from('profiles')
              .update({ org_id: orgData.id, role: 'ORG_ADMIN' })
              .eq('id', currentUser.id);
          }

          const directResult: OnboardingResult = {
            success: true,
            role: 'ORG_ADMIN',
            already_set: false,
            user_id: currentUser?.id ?? '',
            org_id: orgData?.id,
          };
          setResult(directResult);
          setLoading(false);
          return directResult;
        }

        const onboardingResult = rpcData as OnboardingResult;
        // If the RPC returned already_set without org_id, the org wasn't created
        if (onboardingResult.already_set && !onboardingResult.org_id) {
          // Create org directly as fallback
          const { data: orgData, error: orgError } = await supabase
            .from('organizations')
            .insert({
              legal_name: data.legalName || data.displayName,
              display_name: data.displayName,
              domain: data.domain,
            })
            .select('id')
            .single();

          if (orgError) {
            setError(orgError.message);
            setLoading(false);
            return null;
          }

          const { data: { user: currentUser } } = await supabase.auth.getUser();
          if (currentUser && orgData) {
            await supabase
              .from('org_members')
              .insert({ org_id: orgData.id, user_id: currentUser.id, role: 'admin' as const });
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (supabase as any)
              .from('profiles')
              .update({ org_id: orgData.id, role: 'ORG_ADMIN' })
              .eq('id', currentUser.id);
          }

          onboardingResult.org_id = orgData?.id;
          onboardingResult.success = true;
        }

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

  const lookupOrgByEmail = useCallback(async (email: string): Promise<OrgMatch | null> => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error: rpcError } = await (supabase.rpc as any)(
        'lookup_org_by_email_domain',
        { p_email: email }
      );

      if (rpcError) {
        return null;
      }

      return data as OrgMatch;
    } catch {
      return null;
    }
  }, []);

  const joinOrgByDomain = useCallback(async (orgId: string): Promise<OnboardingResult | null> => {
    setLoading(true);
    setError(null);

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error: rpcError } = await (supabase.rpc as any)(
        'join_org_by_domain',
        { p_org_id: orgId }
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
      const message = err instanceof Error ? err.message : 'Failed to join organization';
      setError(message);
      setLoading(false);
      return null;
    }
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    loading,
    error,
    result,
    setRole,
    createOrg,
    lookupOrgByEmail,
    joinOrgByDomain,
    clearError,
  };
}
