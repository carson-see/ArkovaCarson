/**
 * useUserOrgs Hook
 *
 * Fetches all organizations the current user belongs to via org_members table.
 * Returns org details + the user's role in each org.
 * Uses React Query for caching and deduplication.
 */

import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { queryKeys } from '@/lib/queryClient';
import { useAuth } from './useAuth';

export interface UserOrg {
  id: string;
  orgId: string;
  displayName: string;
  legalName: string | null;
  domain: string | null;
  orgPrefix: string | null;
  role: 'owner' | 'admin' | 'member';
  joinedAt: string;
}

interface UseUserOrgsReturn {
  orgs: UserOrg[];
  loading: boolean;
  error: string | null;
  refreshOrgs: () => Promise<void>;
}

interface OrgMemberRow {
  id: string;
  org_id: string;
  role: string;
  joined_at: string;
}

async function fetchUserOrgsData(userId: string): Promise<UserOrg[]> {
  // Step 1: Fetch user's org memberships
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: memberships, error: memberError } = await (supabase as any)
    .from('org_members')
    .select('id, org_id, role, joined_at')
    .eq('user_id', userId)
    .order('joined_at', { ascending: true });

  if (memberError) throw memberError;

  const rows = (memberships ?? []) as OrgMemberRow[];
  if (rows.length === 0) return [];

  // Step 2: Fetch org details via SECURITY DEFINER RPC
  const orgIds = rows.map((m) => m.org_id);
  const orgResults = await Promise.all(
    orgIds.map((orgId) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC not in generated types
      (supabase as any).rpc('get_public_org_profiles', { p_org_id: orgId, p_limit: 1 })
    )
  );

  const organizations = orgResults
    .filter((r) => !r.error && r.data?.length > 0)
    .map((r) => r.data[0]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orgMap = new Map(organizations.map((o: any) => [o.id, o]));

  return rows.map((m) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const org = orgMap.get(m.org_id) as any;
    return {
      id: m.id,
      orgId: m.org_id,
      displayName: org?.display_name ?? '',
      legalName: org?.legal_name ?? null,
      domain: org?.domain ?? null,
      orgPrefix: org?.org_prefix ?? null,
      role: m.role as 'owner' | 'admin' | 'member',
      joinedAt: m.joined_at,
    };
  }).filter((o) => o.displayName);
}

export function useUserOrgs(): UseUserOrgsReturn {
  const { user } = useAuth();
  const qc = useQueryClient();

  const {
    data: orgs = [],
    isLoading: loading,
    error: queryError,
  } = useQuery({
    queryKey: queryKeys.userOrgs(user?.id ?? ''),
    queryFn: () => fetchUserOrgsData(user!.id),
    enabled: !!user,
    staleTime: 2 * 60_000,
  });

  const refreshOrgs = useCallback(async () => {
    if (user) {
      await qc.invalidateQueries({ queryKey: queryKeys.userOrgs(user.id) });
    }
  }, [user, qc]);

  return {
    orgs,
    loading: !user ? false : loading,
    error: queryError ? (queryError as Error).message : null,
    refreshOrgs,
  };
}
