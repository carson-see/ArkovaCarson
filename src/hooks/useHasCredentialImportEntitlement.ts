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
 * ──────────────────────────────────────────────────────────────────────────
 * IMPORTANT — inert until a writer ships, and ORG-WIDE by design:
 *
 * 1. NO WRITER EXISTS YET. Nothing in the codebase currently writes an
 *    `entitlement_type = 'credential_source_import'` row — it ships from the
 *    CSI (Credential Source Import) track (SCRUM-1611, PRs #1038–#1041). Until
 *    that writer lands, this hook returns `false` for every viewer and the
 *    gated CPE detail section is therefore inert (fails closed). This is the
 *    intended posture, not a bug: the section is dark until CSI seeds the row.
 *
 * 2. THE GRANT IS ORG-WIDE. The `.or(user_id.eq / org_id.eq)` filter below
 *    plus the `entitlements` RLS both permit an org-wide read: any member of
 *    an org is granted the moment a SINGLE `credential_source_import` row
 *    exists for that org (the row need not name the individual user). This is
 *    deliberate for R1 — the feature is an org-level capability. If per-user
 *    scoping is ever required, BOTH of the following must change together:
 *      (a) the CSI writer must scope the row to a specific `user_id`, and
 *      (b) `resolveImportEntitlement` must additionally compare the matched
 *          row's `user_id` to the current viewer (it does not today — the
 *          minimal projection below does not even select `user_id`).
 *    Do NOT add a half-measure (e.g. selecting user_id without the writer
 *    scoping it) — that would silently narrow the grant and break the org
 *    capability once the writer ships.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * @see SCRUM-1847, SCRUM-1857, SCRUM-1611 (CSI writer track)
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
  //
  // ORG-WIDE GRANT (see file header): the `org_id.eq` arm matches ANY
  // credential_source_import row for the viewer's org, so the entitlement is
  // granted org-wide once one such row exists. Per-user scoping would require
  // the CSI writer to scope by user_id AND resolveImportEntitlement to compare
  // the matched row's user_id — intentionally not done in R1.
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
