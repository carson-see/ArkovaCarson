/**
 * useChecklist Hook (DEBT-5)
 *
 * Consolidates dashboard setup checks into a single hook.
 * Replaces 3 scattered useState/useEffect pairs in DashboardPage.
 *
 * Queries:
 *   - Credential templates count (ORG_ADMIN only)
 *   - Active subscription status
 *   - Attestation count
 */

import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';

export interface ChecklistState {
  hasTemplates: boolean;
  hasBillingPlan: boolean;
  attestationCount: number;
  loading: boolean;
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
  const [state, setState] = useState<ChecklistState>({
    hasTemplates: false,
    hasBillingPlan: false,
    attestationCount: 0,
    loading: true,
  });

  useEffect(() => {
    if (!userId) {
      setState((s) => ({ ...s, loading: false }));
      return;
    }

    let cancelled = false;

    async function fetchAll() {
      const results = await Promise.allSettled([
        // Templates check (only for ORG_ADMIN)
        orgId && role === 'ORG_ADMIN'
          ? supabase
              .from('credential_templates')
              .select('id', { count: 'exact', head: true })
              .eq('org_id', orgId!)
          : Promise.resolve({ count: 0 }),

        // Subscription check
        supabase
          .from('subscriptions')
          .select('id')
          .eq('user_id', userId!)
          .in('status', ['active', 'trialing'])
          .maybeSingle(),

        // Attestation count
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase as any)
          .from('attestations')
          .select('id', { count: 'exact', head: true }),
      ]);

      if (cancelled) return;

      const templateResult = results[0].status === 'fulfilled' ? results[0].value : null;
      const subResult = results[1].status === 'fulfilled' ? results[1].value : null;
      const attestResult = results[2].status === 'fulfilled' ? results[2].value : null;

      setState({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        hasTemplates: ((templateResult as Record<string, unknown>)?.count as number ?? 0) > 0,
        hasBillingPlan: !!(subResult as unknown as Record<string, unknown>)?.data,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        attestationCount: (attestResult as Record<string, unknown>)?.count as number ?? 0,
        loading: false,
      });
    }

    fetchAll();

    return () => {
      cancelled = true;
    };
  }, [userId, orgId, role]);

  return state;
}
