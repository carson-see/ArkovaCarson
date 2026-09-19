/**
 * Onboarding Hook
 *
 * Handles the onboarding flow including role selection and org creation.
 * Uses the transactional update_profile_onboarding RPC function.
 */

import { useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { readReferralCode, clearReferralCode } from '@/lib/referralCapture';

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
    organizationType?: string | null;
    description?: string | null;
    websiteUrl?: string | null;
    linkedinUrl?: string | null;
    twitterUrl?: string | null;
    location?: string | null;
    verifyOrganization?: boolean;
    einTaxId?: string | null;
  }) => Promise<OnboardingResult | null>;
  lookupOrgByEmail: (email: string) => Promise<OrgMatch | null>;
  joinOrgByDomain: (orgId: string) => Promise<OnboardingResult | null>;
  clearError: () => void;
}

/**
 * Links a newly-created organization to the current user: adds them as an
 * `owner` org_member row, then stamps `org_id`/role='ORG_ADMIN' on their
 * profile. Both writes used to be fire-and-forget in `createOrg`'s two
 * direct-insert fallback branches — the result was fully discarded, not even
 * `{ error }` was captured (BUG, 2026-08-03 bug sprint). A failure here left
 * a real `organizations` row in the DB while the caller still reported
 * `success: true`, so `OnboardingOrgPage`'s post-success `refreshProfile()`
 * would refetch a profile whose `org_id` was never actually set — RouteGuard
 * then silently bounced the user back into the same onboarding form, and a
 * retry created a second orphaned org. Returns an error message on failure,
 * or null on success.
 */
async function linkUserToNewOrg(orgId: string, userId: string): Promise<string | null> {
  const { error: memberError } = await supabase
    .from('org_members')
    .insert({ org_id: orgId, user_id: userId, role: 'owner' as const });

  if (memberError) return memberError.message;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: profileError } = await (supabase as any)
    .from('profiles')
    .update({ org_id: orgId, role: 'ORG_ADMIN' })
    .eq('id', userId);

  if (profileError) return profileError.message;

  return null;
}

/**
 * Outcome of one attribution attempt. `applied` mirrors the RPC verdict;
 * `reason` is always populated so a caller can COUNT outcomes rather than
 * discover that "nothing happened" (BUILDER-CONTRACT clauses 1 and 2).
 *
 * `rpc_failed` and `threw` are this layer's own reasons — the RPC's own total
 * verdict set is no_code / unknown_code / self_referral / already_attributed /
 * recorded.
 */
export interface ReferralAttributionOutcome {
  applied: boolean;
  reason:
    | 'no_code'
    | 'unknown_code'
    | 'self_referral'
    | 'already_attributed'
    | 'recorded'
    | 'rpc_failed'
    | 'threw';
}

/**
 * SCRUM-5024 — attribute a freshly created organization to a partner, if the
 * visitor arrived through a partner link.
 *
 * Called AFTER the organization exists, never threaded into
 * `update_profile_onboarding`: adding an optional org-creating parameter to
 * that RPC would mean the referral silently disappears down whichever fallback
 * branch the caller happens to take, and there are three of them.
 *
 * NEVER changes the signup result. A referral is an attribution, not a
 * precondition — a mistyped code must not fail an organization that already
 * exists in the database. Every non-applied outcome is therefore logged at
 * error level with its reason and returned to the caller, not swallowed.
 */
export async function applyCapturedReferral(orgId: string): Promise<ReferralAttributionOutcome> {
  const code = readReferralCode();
  if (!code) return { applied: false, reason: 'no_code' };

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error: rpcError } = await (supabase as any).rpc('record_org_referral', {
      p_org_id: orgId,
      p_code: code,
      p_source: 'signup',
    });

    if (rpcError) {
      // The code stays parked: an RPC that failed to run has not decided
      // anything, so a later attempt may still succeed.
      console.error('[useOnboarding] referral attribution RPC failed', {
        orgId,
        reason: 'rpc_failed',
        message: rpcError.message,
      });
      return { applied: false, reason: 'rpc_failed' };
    }

    const verdict = data as { applied?: boolean; reason?: string } | null;
    const applied = verdict?.applied === true;
    const reason = (verdict?.reason ?? 'rpc_failed') as ReferralAttributionOutcome['reason'];

    // The database has ruled. Retrying a refused code cannot start succeeding,
    // so the parked code is dropped either way.
    clearReferralCode();

    if (!applied) {
      console.error('[useOnboarding] referral not applied', { orgId, reason });
    }
    return { applied, reason };
  } catch (err) {
    console.error('[useOnboarding] referral attribution threw', {
      orgId,
      reason: 'threw',
      message: err instanceof Error ? err.message : String(err),
    });
    return { applied: false, reason: 'threw' };
  }
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
      const { data, error: rpcError } = await (supabase as any).rpc(
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
      organizationType?: string | null;
      description?: string | null;
      websiteUrl?: string | null;
      linkedinUrl?: string | null;
      twitterUrl?: string | null;
      location?: string | null;
      verifyOrganization?: boolean;
      einTaxId?: string | null;
    }): Promise<OnboardingResult | null> => {
      setLoading(true);
      setError(null);

      try {
        // Try the onboarding RPC first (works for new users)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: rpcData, error: rpcError } = await (supabase as any).rpc(
          'update_profile_onboarding',
          {
            p_role: 'ORG_ADMIN',
            p_org_legal_name: data.legalName,
            p_org_display_name: data.displayName,
            p_org_domain: data.domain,
            p_org_type: data.organizationType,
            p_org_description: data.description,
            p_org_website_url: data.websiteUrl,
            p_org_linkedin_url: data.linkedinUrl,
            p_org_twitter_url: data.twitterUrl,
            p_org_location: data.location,
            p_org_ein_tax_id: data.verifyOrganization ? data.einTaxId : null,
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
              org_type: data.organizationType,
              description: data.description,
              website_url: data.websiteUrl,
              linkedin_url: data.linkedinUrl,
              twitter_url: data.twitterUrl,
              location: data.location,
              ...(data.verifyOrganization && data.einTaxId
                ? { ein_tax_id: data.einTaxId, verification_status: 'PENDING' }
                : {}),
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
          if (!currentUser || !orgData) {
            setError('Failed to resolve the signed-in user for organization setup.');
            setLoading(false);
            return null;
          }

          const linkError = await linkUserToNewOrg(orgData.id, currentUser.id);
          if (linkError) {
            setError(linkError);
            setLoading(false);
            return null;
          }

          // Org-creating branch 1 of 3 (RPC rejected, direct insert).
          await applyCapturedReferral(orgData.id);

          const directResult: OnboardingResult = {
            success: true,
            role: 'ORG_ADMIN',
            already_set: false,
            user_id: currentUser.id,
            org_id: orgData.id,
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
              org_type: data.organizationType,
              description: data.description,
              website_url: data.websiteUrl,
              linkedin_url: data.linkedinUrl,
              twitter_url: data.twitterUrl,
              location: data.location,
              ...(data.verifyOrganization && data.einTaxId
                ? { ein_tax_id: data.einTaxId, verification_status: 'PENDING' }
                : {}),
            })
            .select('id')
            .single();

          if (orgError) {
            setError(orgError.message);
            setLoading(false);
            return null;
          }

          const { data: { user: currentUser } } = await supabase.auth.getUser();
          if (!currentUser || !orgData) {
            setError('Failed to resolve the signed-in user for organization setup.');
            setLoading(false);
            return null;
          }

          const linkError = await linkUserToNewOrg(orgData.id, currentUser.id);
          if (linkError) {
            setError(linkError);
            setLoading(false);
            return null;
          }

          // Org-creating branch 2 of 3 (RPC returned already_set with no org).
          await applyCapturedReferral(orgData.id);

          onboardingResult.org_id = orgData.id;
          onboardingResult.success = true;
        } else if (onboardingResult.org_id) {
          // Org-creating branch 3 of 3 — the ordinary path: the RPC itself
          // created the organization. `else if` and not a second unconditional
          // call, so the fallback branch above cannot attribute twice.
          await applyCapturedReferral(onboardingResult.org_id);
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
      const { data, error: rpcError } = await (supabase as any).rpc(
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

  // SCRUM-5024, deliberate non-attribution: joining an existing organization by
  // email domain creates NO organization, so there is nothing to attribute — a
  // partner refers organizations, not seats. Accepting an invitation
  // (`/accept-invite`) is the same case and is likewise not attributed. A
  // referral code parked by either visitor stays parked until it expires.
  const joinOrgByDomain = useCallback(async (orgId: string): Promise<OnboardingResult | null> => {
    setLoading(true);
    setError(null);

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error: rpcError } = await (supabase as any).rpc(
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
