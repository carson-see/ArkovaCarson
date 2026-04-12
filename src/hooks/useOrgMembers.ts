/**
 * useOrgMembers Hook
 *
 * Fetches organization members from profiles table for a given org_id.
 * Maps profile rows to the Member interface used by MembersTable.
 * Uses React Query for caching and deduplication.
 *
 * @see P5-TS-03 — Wire MembersTable to real Supabase query
 */

import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { queryKeys } from '@/lib/queryClient';
import type { Member } from '@/components/organization';

interface UseOrgMembersReturn {
  members: Member[];
  loading: boolean;
  error: string | null;
  refreshMembers: () => Promise<void>;
}

async function fetchMembersData(orgId: string): Promise<Member[]> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, full_name, avatar_url, role, created_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: true })
    .limit(500);

  if (error) throw error;

  return (data ?? []).map((p) => ({
    id: p.id,
    email: p.email,
    fullName: p.full_name,
    avatarUrl: p.avatar_url,
    role: (p.role as 'ORG_ADMIN' | 'INDIVIDUAL') ?? 'INDIVIDUAL',
    joinedAt: p.created_at,
    status: 'active' as const,
  }));
}

export function useOrgMembers(orgId: string | null | undefined): UseOrgMembersReturn {
  const qc = useQueryClient();

  const {
    data: members = [],
    isLoading: loading,
    error: queryError,
  } = useQuery({
    queryKey: queryKeys.orgMembers(orgId ?? ''),
    queryFn: () => fetchMembersData(orgId!),
    enabled: !!orgId,
    staleTime: 60_000,
  });

  const refreshMembers = useCallback(async () => {
    if (orgId) {
      await qc.invalidateQueries({ queryKey: queryKeys.orgMembers(orgId) });
    }
  }, [orgId, qc]);

  return {
    members,
    loading: !orgId ? false : loading,
    error: queryError ? (queryError as Error).message : null,
    refreshMembers,
  };
}
