/**
 * SCRUM-4984 — fail-closed tenant row access.
 *
 * Both `ai-provenance.ts` and `ai-accountability-report.ts` used the idiom
 * `row.org_id && callerOrgId && row.org_id !== callerOrgId` to deny access.
 * That expression is only true when BOTH sides are present and differ, so a
 * caller with no `profiles.org_id` (INDIVIDUAL), an orphan row, or a select
 * list that never fetched `org_id` (ai-provenance.ts before this fix) all
 * fell through to "allowed". Any authenticated user could read any org's
 * extraction manifests by fingerprint.
 *
 * The rule is now positive: a caller may read a row only when the row is in
 * the caller's org, or the caller owns the row. Everything else is denied,
 * and callers respond 404 (not 403) so the endpoint is not an existence
 * oracle for other tenants' data.
 */

export interface TenantScopedRow {
  org_id?: string | null;
  user_id?: string | null;
}

export interface TenantCaller {
  userId: string;
  orgId?: string | null;
}

export function callerMayReadRow(row: TenantScopedRow, caller: TenantCaller): boolean {
  if (row.org_id && caller.orgId && row.org_id === caller.orgId) return true;
  if (row.user_id && row.user_id === caller.userId) return true;
  return false;
}
