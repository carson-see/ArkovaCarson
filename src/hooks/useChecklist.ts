/**
 * useChecklist Hook (DEBT-5)
 *
 * Consolidates dashboard setup checks into a single hook.
 * Uses React Query for caching — dashboard loads instantly on re-visit.
 *
 * Queries:
 *   - Credential templates count (ORG_ADMIN only)
 *   - Active subscription status
 *   - Attestation count
 */

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { queryKeys } from '@/lib/queryClient';

export interface ChecklistState {
  hasTemplates: boolean;
  hasBillingPlan: boolean;
  attestationCount: number;
  loading: boolean;
}

interface ChecklistData {
  hasTemplates: boolean;
  hasBillingPlan: boolean;
  attestationCount: number;
}

function countFromResult(result: unknown): number {
  return (result as { count?: number } | null)?.count ?? 0;
}

function hasData(result: unknown): boolean {
  return !!(result as { data?: unknown } | null)?.data;
}

async function fetchChecklistData(
  userId: string,
  orgId: string | null | undefined,
  role: string | null | undefined,
): Promise<ChecklistData> {
  const scopedAttestationCountQuery = supabase
    .from('attestations')
    .select('id', { count: 'exact', head: true })
    .match(orgId ? { attester_org_id: orgId } : { attester_user_id: userId });

  const results = await Promise.allSettled([
    // Templates check (only for ORG_ADMIN)
    orgId && role === 'ORG_ADMIN'
      ? supabase
          .from('credential_templates')
          .select('id', { count: 'exact', head: true })
          .eq('org_id', orgId)
      : Promise.resolve({ count: 0 }),

    // Subscription check
    supabase
      .from('subscriptions')
      .select('id')
      .eq('user_id', userId)
      .in('status', ['active', 'trialing'])
      .maybeSingle(),

    // Attestation count
    scopedAttestationCountQuery,
  ]);

  const templateResult = results[0].status === 'fulfilled' ? results[0].value : null;
  const subResult = results[1].status === 'fulfilled' ? results[1].value : null;
  const attestResult = results[2].status === 'fulfilled' ? results[2].value : null;

  return {
    hasTemplates: countFromResult(templateResult) > 0,
    hasBillingPlan: hasData(subResult),
    attestationCount: countFromResult(attestResult),
  };
}

/**
 * Fetches all dashboard checklist data in a single hook.
 *
 * @param userId - Current user ID (from auth)
 * @param orgId - User's organization ID (from profile)
 * @param role - User's role (only fetches templates for ORG_ADMIN)
 */
export function useChecklist(
  userId: string | null | undefined,
  orgId: string | null | undefined,
  role: string | null | undefined,
): ChecklistState {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.checklist(userId ?? '', orgId),
    queryFn: () => fetchChecklistData(userId!, orgId, role),
    enabled: !!userId,
    staleTime: 2 * 60_000, // 2 min — checklist data changes rarely
  });

  return {
    hasTemplates: data?.hasTemplates ?? false,
    hasBillingPlan: data?.hasBillingPlan ?? false,
    attestationCount: data?.attestationCount ?? 0,
    loading: !userId ? false : isLoading,
  };
}
