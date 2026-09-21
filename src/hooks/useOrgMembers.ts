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
import { workerFetch } from '@/lib/workerClient';
import { z } from 'zod';
import { queryKeys } from '@/lib/queryClient';
import type { Member } from '@/components/organization';

interface UseOrgMembersReturn {
  members: Member[];
  loading: boolean;
  error: string | null;
  refreshMembers: () => Promise<void>;
}

async function fetchMembersData(orgId: string): Promise<Member[]> {
  const response = await workerFetch(`/api/v1/folders/member-contexts?context_org_id=${encodeURIComponent(orgId)}`);
  if (!response.ok) throw new Error('member_list_failed');
  const parsed = z.object({ members: z.array(z.object({ id: z.string().uuid(), email: z.string().email(),
    full_name: z.string().nullable(), avatar_url: z.string().nullable(), role: z.enum(['ORG_ADMIN', 'INDIVIDUAL']),
    created_at: z.string(), org_id: z.string().uuid(), membership_role: z.enum(['owner', 'admin', 'member']) })) }).strict()
    .safeParse(await response.json().catch(() => null));
  if (!parsed.success || parsed.data.members.some((member) => member.org_id !== orgId)) throw new Error('member_list_failed');

  return parsed.data.members.map((p) => ({
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
