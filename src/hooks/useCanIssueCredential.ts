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
import type { Database } from '@/types/database.types';

export type IssueGateReason =
  | 'loading'
  | 'query_error'
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

// Pick the fields from the generated DB types so column-name typos type-error
// here. `suspended` is not yet in the generated types as of 2026-05-05 (added
// by migration 0289); declare it explicitly until `npm run gen:types` catches
// up. This addresses CodeRabbit's concern about hiding the row type behind
// `as any` while staying honest about the column gap.
type OrganizationsRow = Database['public']['Tables']['organizations']['Row'];
export type OrgGateRow = Pick<
  OrganizationsRow,
  'id' | 'verification_status' | 'parent_org_id' | 'parent_approval_status'
> & {
  /** Migration 0289 — boolean | null. Defaults `false` per the column DDL. */
  suspended: boolean | null;
};

export interface ResolveIssueGateInput {
  profileLoading: boolean;
  role: string | null | undefined;
  orgId: string | null | undefined;
  org: OrgGateRow | null | undefined;
  orgLoading: boolean;
  /** Surfaced from React Query so the resolver can distinguish "the row
   *  doesn't exist" (legitimate denial) from "the fetch failed" (operational
   *  error — should not silently flip a real org admin into `no_org`). */
  orgError: boolean;
  parent: OrgGateRow | null | undefined;
  parentLoading: boolean;
  parentError: boolean;
}

export interface UseCanIssueCredentialOptions {
  /** Override the org being checked. Defaults to `profile.org_id`. */
  orgId?: string | null;
  /** Override the caller role. Defaults to `profile.role`. */
  role?: string | null;
  /** Extra loading state for role/org membership resolution. */
  profileLoading?: boolean;
}

/**
 * Pure resolver for the Issue Credential gate. Has no IO; every input is
 * a primitive or a row already-fetched. Called by the hook below and by
 * the unit tests.
 */
export function resolveIssueGate(input: ResolveIssueGateInput): IssueGate {
  const {
    profileLoading,
    role,
    orgId,
    org,
    orgLoading,
    orgError,
    parent,
    parentLoading,
    parentError,
  } = input;

  if (profileLoading) {
    return { allowed: false, loading: true, reason: 'loading' };
  }
  if (role !== 'ORG_ADMIN') {
    return { allowed: false, loading: false, reason: 'not_admin' };
  }
  if (!!orgId && orgLoading) {
    return { allowed: false, loading: true, reason: 'loading' };
  }
  // Distinguish "fetch failed" from "row missing" — a transient Supabase /
  // RLS error must NOT silently downgrade a real ORG_ADMIN to `no_org`.
  if (!!orgId && orgError) {
    return { allowed: false, loading: false, reason: 'query_error' };
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

  const parentGate = resolveParentIssueGate(org, parent, parentLoading, parentError);
  if (parentGate) return parentGate;

  return { allowed: true, loading: false, reason: null };
}

function resolveParentIssueGate(
  org: OrgGateRow,
  parent: OrgGateRow | null | undefined,
  parentLoading: boolean,
  parentError: boolean,
): IssueGate | null {
  if (!org.parent_org_id) return null;
  if ((org.parent_approval_status ?? null) !== 'APPROVED') {
    return { allowed: false, loading: false, reason: 'parent_unapproved' };
  }
  if (parentLoading) {
    return { allowed: false, loading: true, reason: 'loading' };
  }
  if (parentError) {
    return { allowed: false, loading: false, reason: 'query_error' };
  }
  if (!parent || parent.verification_status !== 'VERIFIED') {
    return { allowed: false, loading: false, reason: 'parent_unverified' };
  }
  if (parent.suspended === true) {
    return { allowed: false, loading: false, reason: 'parent_suspended' };
  }
  return null;
}

/**
 * Selects the gate-relevant columns from `organizations`. The `suspended`
 * column is added by migration 0289 but isn't yet in the generated types
 * (regen pending), so we suppress the unsafe-any for that one literal.
 */
async function fetchOrgGateRow(orgId: string): Promise<OrgGateRow | null> {
  const { data, error } = await supabase
    .from('organizations')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generated types lag migration 0289 `suspended`; runtime shape pinned by OrgGateRow.
    .select('id, verification_status, suspended, parent_org_id, parent_approval_status' as any)
    .eq('id', orgId)
    .single();
  if (error) {
    if (error.code === 'PGRST116') return null;
    throw error;
  }
  return data as unknown as OrgGateRow;
}

export function useCanIssueCredential(options: UseCanIssueCredentialOptions = {}): IssueGate {
  const { profile, loading: profileLoading } = useProfile();
  const orgId = options.orgId !== undefined ? options.orgId : profile?.org_id ?? null;
  const role = options.role ?? profile?.role;
  const loading = profileLoading || options.profileLoading === true;
  const shouldFetchOrg = !!orgId && role === 'ORG_ADMIN' && !loading;

  const { data: org, isLoading: orgLoading, isError: orgIsError } = useQuery({
    queryKey: [...queryKeys.organization(orgId ?? ''), 'gate'] as const,
    queryFn: () => fetchOrgGateRow(orgId!),
    enabled: shouldFetchOrg,
    staleTime: 30_000,
  });

  const parentId = org?.parent_org_id ?? null;

  const { data: parent, isLoading: parentLoading, isError: parentIsError } = useQuery({
    queryKey: [...queryKeys.organization(parentId ?? ''), 'gate-parent'] as const,
    queryFn: () => fetchOrgGateRow(parentId!),
    enabled: !!parentId,
    staleTime: 30_000,
  });

  return resolveIssueGate({
    profileLoading: loading,
    role,
    orgId,
    org,
    orgLoading,
    orgError: orgIsError,
    parent,
    parentLoading,
    parentError: parentIsError,
  });
}
