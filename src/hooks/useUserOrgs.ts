/**
 * useUserOrgs Hook
 *
 * Fetches all organizations the current user belongs to via org_members table.
 * Returns org details + the user's role in each org.
 *
 * Note: org_members table added in migration 0087. Type assertions used until
 * database.types.ts is regenerated (see AUDIT-21 pattern).
 */

import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
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

export function useUserOrgs(): UseUserOrgsReturn {
  const { user } = useAuth();
  const [orgs, setOrgs] = useState<UserOrg[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchOrgs = useCallback(async () => {
    if (!user) {
      setOrgs([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    // Step 1: Fetch user's org memberships
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: memberships, error: memberError } = await (supabase as any)
      .from('org_members')
      .select('id, org_id, role, joined_at')
      .eq('user_id', user.id)
      .order('joined_at', { ascending: true });

    if (memberError) {
      setError(memberError.message);
      setOrgs([]);
      setLoading(false);
      return;
    }

    const rows = (memberships ?? []) as OrgMemberRow[];
    if (rows.length === 0) {
      setOrgs([]);
      setLoading(false);
      return;
    }

    // Step 2: Fetch org details for all orgs
    const orgIds = rows.map((m) => m.org_id);
    const { data: organizations, error: orgError } = await supabase
      .from('organizations')
      .select('*')
      .in('id', orgIds);

    if (orgError) {
      setError(orgError.message);
      setOrgs([]);
      setLoading(false);
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orgMap = new Map((organizations ?? []).map((o: any) => [o.id, o]));

    setOrgs(
      rows.map((m) => {
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
      }).filter((o) => o.displayName)
    );

    setLoading(false);
  }, [user]);

  useEffect(() => {
    fetchOrgs();
  }, [fetchOrgs]);

  const refreshOrgs = useCallback(async () => {
    await fetchOrgs();
  }, [fetchOrgs]);

  return { orgs, loading, error, refreshOrgs };
}
