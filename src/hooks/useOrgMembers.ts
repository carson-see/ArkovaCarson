/**
 * useOrgMembers Hook
 *
 * Fetches organization members from profiles table for a given org_id.
 * Maps profile rows to the Member interface used by MembersTable.
 *
 * @see P5-TS-03 — Wire MembersTable to real Supabase query
 */

import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import type { Member } from '@/components/organization';

interface UseOrgMembersReturn {
  members: Member[];
  loading: boolean;
  error: string | null;
  refreshMembers: () => Promise<void>;
}

export function useOrgMembers(orgId: string | null | undefined): UseOrgMembersReturn {
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchMembers = useCallback(async () => {
    if (!orgId) {
      setMembers([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const { data, error: fetchError } = await supabase
      .from('profiles')
      .select('id, email, full_name, avatar_url, role, created_at')
      .eq('org_id', orgId)
      .order('created_at', { ascending: true })
      .limit(500);

    if (fetchError) {
      setError(fetchError.message);
      setMembers([]);
    } else {
      setMembers(
        (data ?? []).map((p) => ({
          id: p.id,
          email: p.email,
          fullName: p.full_name,
          avatarUrl: p.avatar_url,
          role: (p.role as 'ORG_ADMIN' | 'INDIVIDUAL') ?? 'INDIVIDUAL',
          joinedAt: p.created_at,
          status: 'active' as const,
        }))
      );
    }

    setLoading(false);
  }, [orgId]);

  useEffect(() => {
    fetchMembers();
  }, [fetchMembers]);

  const refreshMembers = useCallback(async () => {
    await fetchMembers();
  }, [fetchMembers]);

  return { members, loading, error, refreshMembers };
}
