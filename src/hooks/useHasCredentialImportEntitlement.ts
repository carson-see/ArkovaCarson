/**
 * useHasCredentialImportEntitlement (SCRUM-1847 / CPE-R1)
 *
 * Read-only gate for the `credential_source_import` entitlement — the CSI
 * (Credential Source Import) feature that the CPE metadata detail section is
 * gated behind. The CPE section only renders for viewers who hold this
 * entitlement (see CpeMetadataSection / CredentialRenderer).
 *
 * The entitlement lives in the existing `entitlements` table (the canonical
 * entitlement mechanism — `entitlement_type` + `value` + valid_from/until,
 * scoped per user and/or org). This hook READS it only; it never writes.
 *
 * Pattern mirrors useCanIssueCredential: a pure `resolveImportEntitlement`
 * resolver (unit-tested) plus a thin React Query wrapper that pulls the rows.
 *
 * @see SCRUM-1847, SCRUM-1857
 */

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useProfile } from '@/hooks/useProfile';
import { useAuth } from '@/hooks/useAuth';

/** Entitlement key for the Credential Source Import feature. */
export const CREDENTIAL_SOURCE_IMPORT_ENTITLEMENT = 'credential_source_import' as const;

/** Minimal projection of an `entitlements` row used for the gate. */
export interface EntitlementRow {
  entitlement_type: string;
  valid_from: string;
  valid_until: string | null;
}

export interface ResolveImportEntitlementInput {
  loading: boolean;
  rows: EntitlementRow[] | undefined;
  error?: boolean;
  now?: Date;
}

/**
 * Pure resolver: does the viewer currently hold an active
 * `credential_source_import` entitlement? Fails closed on loading/error.
 */
export function resolveImportEntitlement({
  loading,
  rows,
  error = false,
  now = new Date(),
}: ResolveImportEntitlementInput): boolean {
  if (loading || error || !rows) return false;
  const ts = now.getTime();
  return rows.some((r) => {
    if (r.entitlement_type !== CREDENTIAL_SOURCE_IMPORT_ENTITLEMENT) return false;
    const from = new Date(r.valid_from).getTime();
    if (Number.isFinite(from) && from > ts) return false;
    if (r.valid_until) {
      const until = new Date(r.valid_until).getTime();
      if (Number.isFinite(until) && until <= ts) return false;
    }
    return true;
  });
}

const UUID_RE = /^[0-9a-f-]{36}$/i;

async function fetchImportEntitlementRows(
  userId: string,
  orgId: string | null,
): Promise<EntitlementRow[]> {
  // RLS scopes rows to what the caller may read. We additionally filter by the
  // feature key and to rows for this user OR their active org.
  let query = supabase
    .from('entitlements')
    .select('entitlement_type, valid_from, valid_until')
    .eq('entitlement_type', CREDENTIAL_SOURCE_IMPORT_ENTITLEMENT);

  // Guard the OR-filter interpolation: only build the raw PostgREST OR string
  // from values that are well-formed UUIDs (these come from the auth session
  // and profile row, but validate defensively against filter injection).
  query = orgId && UUID_RE.test(orgId) && UUID_RE.test(userId)
    ? query.or(`user_id.eq.${userId},org_id.eq.${orgId}`)
    : query.eq('user_id', userId);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as EntitlementRow[];
}

/**
 * Returns whether the current viewer holds the `credential_source_import`
 * entitlement. Fail-closed (false) while loading or on error.
 */
export function useHasCredentialImportEntitlement(): boolean {
  const { user } = useAuth();
  const { profile } = useProfile();
  const orgId = profile?.org_id ?? null;

  const { data, isLoading, error } = useQuery({
    queryKey: ['entitlement', CREDENTIAL_SOURCE_IMPORT_ENTITLEMENT, user?.id ?? '', orgId ?? ''],
    queryFn: () => fetchImportEntitlementRows(user!.id, orgId),
    enabled: !!user,
    staleTime: 60_000,
  });

  return resolveImportEntitlement({
    loading: !user ? false : isLoading,
    rows: data,
    error: !!error,
  });
}
