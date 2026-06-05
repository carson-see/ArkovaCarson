/**
 * useAdminOrgMembers Hook
 *
 * Platform-admin roster fetch for an organization the admin may NOT belong to.
 *
 * The standard useOrgMembers hook queries Supabase directly under RLS, which has
 * no platform-admin bypass — so a platform admin viewing an org they are not a
 * member of gets 0 rows ("0 members"). This hook instead calls the service_role
 * worker endpoint GET /api/admin/organizations/:id/members, which is gated on
 * isPlatformAdmin and bypasses RLS. Same Member shape as useOrgMembers so it is a
 * drop-in for MembersTable.
 *
 * Gated by `enabled` — it only fires for platform admins, so non-admins never hit
 * the 403-bound admin endpoint.
 */

import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { workerFetch } from '@/lib/workerClient';
import { queryKeys } from '@/lib/queryClient';
import type { Member } from '@/components/organization';

interface UseAdminOrgMembersReturn {
  members: Member[];
  loading: boolean;
  error: string | null;
  refreshMembers: () => Promise<void>;
}

interface AdminMemberRow {
  id: string;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  role: 'ORG_ADMIN' | 'INDIVIDUAL';
  joinedAt: string;
  status: 'active' | 'pending' | 'removed';
}

async function fetchAdminMembers(orgId: string): Promise<Member[]> {
  const res = await workerFetch(`/api/admin/organizations/${orgId}/members`, { method: 'GET' });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  const data = (await res.json()) as { members?: AdminMemberRow[] };
  return (data.members ?? []).map((m) => ({
    id: m.id,
    email: m.email,
    fullName: m.fullName,
    avatarUrl: m.avatarUrl,
    role: m.role ?? 'INDIVIDUAL',
    joinedAt: m.joinedAt,
    status: m.status ?? 'active',
  }));
}

export function useAdminOrgMembers(
  orgId: string | null | undefined,
  enabled: boolean,
): UseAdminOrgMembersReturn {
  const qc = useQueryClient();

  const {
    data: members = [],
    isLoading,
    error: queryError,
  } = useQuery({
    queryKey: queryKeys.adminOrgMembers(orgId ?? ''),
    queryFn: () => fetchAdminMembers(orgId!),
    enabled: enabled && !!orgId,
    staleTime: 60_000,
  });

  const refreshMembers = useCallback(async () => {
    if (orgId) {
      await qc.invalidateQueries({ queryKey: queryKeys.adminOrgMembers(orgId) });
    }
  }, [orgId, qc]);

  return {
    members,
    // React Query reports isLoading=true while disabled+no-data; only treat as
    // loading when this hook is actually enabled and fetching.
    loading: enabled && !!orgId ? isLoading : false,
    error: queryError ? (queryError as Error).message : null,
    refreshMembers,
  };
}
