/**
 * useCanIssueCredential — gate for the Issue Credential UI surface.
 *
 * Issue Credential is a restricted action distinct from Secure Document
 * (the universal anchor flow). Per PRD §ORG-08 (SCRUM-1755) only verified
 * organizations may issue credentials, and a sub-org may only issue when
 * its parent org has explicitly approved the affiliation.
 *
 * The pure `resolveIssueGate` function carries the gating logic and is
 * unit-tested directly. The React hook is a thin wrapper that pulls the
 * required rows via React Query and delegates to the resolver.
 *
 * Source-of-truth columns:
 *   organizations.verification_status    — 'UNVERIFIED' | 'PENDING' | 'VERIFIED'
 *   organizations.suspended              — boolean (migration 0289)
 *   organizations.parent_org_id          — uuid | null
 *   organizations.parent_approval_status — 'PENDING' | 'APPROVED' | 'REVOKED' | null (migration 0128)
 */

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useProfile } from '@/hooks/useProfile';
import { queryKeys } from '@/lib/queryClient';

export type IssueGateReason =
  | 'loading'
  | 'not_admin'
  | 'no_org'
  | 'org_unverified'
  | 'org_suspended'
  | 'parent_unapproved'
  | 'parent_unverified'
  | 'parent_suspended';

export type IssueGate =
  | { allowed: true;  loading: false; reason: null }
  | { allowed: false; loading: true;  reason: 'loading' }
  | { allowed: false; loading: false; reason: Exclude<IssueGateReason, 'loading'> };

export interface OrgGateRow {
  id: string;
  verification_status: string | null;
  suspended: boolean | null;
  parent_org_id: string | null;
  parent_approval_status: string | null;
}

export interface ResolveIssueGateInput {
  profileLoading: boolean;
  role: string | null | undefined;
  orgId: string | null | undefined;
  org: OrgGateRow | null | undefined;
  orgLoading: boolean;
  parent: OrgGateRow | null | undefined;
  parentLoading: boolean;
}

/**
 * Pure resolver for the Issue Credential gate. Has no IO; every input is
 * a primitive or a row already-fetched. Called by the hook below and by
 * the unit tests.
 */
export function resolveIssueGate(input: ResolveIssueGateInput): IssueGate {
  const { profileLoading, role, orgId, org, orgLoading, parent, parentLoading } = input;

  if (profileLoading || (!!orgId && orgLoading)) {
    return { allowed: false, loading: true, reason: 'loading' };
  }
  if (role !== 'ORG_ADMIN') {
    return { allowed: false, loading: false, reason: 'not_admin' };
  }
  if (!orgId || !org) {
    return { allowed: false, loading: false, reason: 'no_org' };
  }
  if (org.verification_status !== 'VERIFIED') {
    return { allowed: false, loading: false, reason: 'org_unverified' };
  }
  if (org.suspended === true) {
    return { allowed: false, loading: false, reason: 'org_suspended' };
  }

  if (org.parent_org_id) {
    if ((org.parent_approval_status ?? null) !== 'APPROVED') {
      return { allowed: false, loading: false, reason: 'parent_unapproved' };
    }
    if (parentLoading) {
      return { allowed: false, loading: true, reason: 'loading' };
    }
    if (!parent || parent.verification_status !== 'VERIFIED') {
      return { allowed: false, loading: false, reason: 'parent_unverified' };
    }
    if (parent.suspended === true) {
      return { allowed: false, loading: false, reason: 'parent_suspended' };
    }
  }

  return { allowed: true, loading: false, reason: null };
}

async function fetchOrgGateRow(orgId: string): Promise<OrgGateRow | null> {
  const { data, error } = await supabase
    .from('organizations')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generated types may lag the 0289 `suspended` column
    .select('id, verification_status, suspended, parent_org_id, parent_approval_status' as any)
    .eq('id', orgId)
    .single();
  if (error) {
    if (error.code === 'PGRST116') return null;
    throw error;
  }
  return data as unknown as OrgGateRow;
}

export function useCanIssueCredential(): IssueGate {
  const { profile, loading: profileLoading } = useProfile();
  const orgId = profile?.org_id ?? null;

  const { data: org, isLoading: orgLoading } = useQuery({
    queryKey: [...queryKeys.organization(orgId ?? ''), 'gate'] as const,
    queryFn: () => fetchOrgGateRow(orgId!),
    enabled: !!orgId,
    staleTime: 30_000,
  });

  const parentId = org?.parent_org_id ?? null;

  const { data: parent, isLoading: parentLoading } = useQuery({
    queryKey: [...queryKeys.organization(parentId ?? ''), 'gate-parent'] as const,
    queryFn: () => fetchOrgGateRow(parentId!),
    enabled: !!parentId,
    staleTime: 30_000,
  });

  return resolveIssueGate({
    profileLoading,
    role: profile?.role,
    orgId,
    org,
    orgLoading,
    parent,
    parentLoading,
  });
}
