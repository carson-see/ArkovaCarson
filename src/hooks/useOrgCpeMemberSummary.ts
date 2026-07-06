/**
 * useOrgCpeMemberSummary — CPE-02 (SCRUM-2380) org CPE dashboard MVP data layer.
 *
 * Live Supabase reads over EXISTING tables only — no new table, no migration:
 *   - `anchors` (CPE rows carry `cpe_metadata`; read shape matches the 0342
 *     partial index `idx_anchors_org_cpe_metadata_issued`:
 *     org_id + cpe_metadata IS NOT NULL, ORDER BY issued_at DESC).
 *   - `profiles` for member name/identifier (org-scoped read is allowed by the
 *     `profiles_select_org_members` policy).
 *
 * Authorization model (defense in depth):
 *   - RLS is the hard boundary: the consolidated `anchors_select` policy limits
 *     reads to own rows / caller's org / platform admin, so cross-org rows can
 *     never be returned regardless of what this hook asks for (proven in
 *     tests/rls/cpe-org-dashboard.test.ts).
 *   - Role scoping is applied in the QUERY on top of RLS: an org admin reads
 *     org-wide; a plain member's query is pinned to their OWN user_id. NOTE:
 *     the standing `anchors_select` policy itself grants every org member the
 *     org-wide read (`org_id = get_user_org_id()`), so "member sees only own
 *     rows" is a query-layer guarantee here — expressing it in RLS would need
 *     a new policy (= migration), out of scope for Sprint 3 by design.
 *
 * §1.6: only `user_id, status, issued_at` are selected — never the
 * `cpe_metadata` blob, so member PII (participantName, licenseNumber, …) never
 * leaves Postgres for this dashboard.
 */
import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';

export interface OrgCpeMemberSummaryRow {
  userId: string;
  /**
   * full_name → email → '' (the component maps '' to the UNKNOWN_MEMBER copy;
   * never an internal-id fragment — round-1 review finding 5).
   */
  displayName: string;
  /** Stable identifier shown next to the name (email), when readable. */
  identifier: string | null;
  /** Secured = status SECURED only (FE-PROOF-GATE contract, see below). */
  securedCount: number;
  /** In progress: PENDING, SUBMITTED, BROADCASTING, or PENDING_RESOLUTION. */
  pendingCount: number;
  /** Terminal: REVOKED, EXPIRED, or SUPERSEDED — surfaced, never silent. */
  terminalCount: number;
  /** Most recent issued_at across the member's in-period CPE rows. */
  lastActivity: string | null;
}

export interface OrgCpeMemberSummary {
  rows: OrgCpeMemberSummaryRow[];
  totals: { members: number; secured: number; pending: number; terminal: number };
  /** True when the caller is a plain member and results are own-rows only. */
  scopedToSelf: boolean;
}

export interface FetchOrgCpeMemberSummaryParams {
  orgId: string;
  userId: string;
  isOrgAdmin: boolean;
  /** ISO lower bound for issued_at; null = all time. */
  periodStart: string | null;
}

interface AnchorRow {
  user_id: string | null;
  status: string | null;
  issued_at: string | null;
}

interface ProfileRow {
  id: string;
  full_name: string | null;
  email: string | null;
}

/** Row cap mirrors the existing org CPE aggregate panel (bounded read). */
const MAX_ROWS = 1000;

/**
 * Status taxonomy — consistent with the SECURED-only export gate and the
 * FE-PROOF-GATE contract (docs/reference/FE_PROOF_GATE_CONTRACT.md): "secured"
 * means status === 'SECURED' ONLY; terminal states (REVOKED / EXPIRED /
 * SUPERSEDED) are never treated as secured NOR as in-progress — they are
 * counted distinctly so no record silently vanishes from the dashboard.
 * Values verified against the `anchor_status` enum in
 * src/types/database.types.ts (PENDING, SECURED, REVOKED, EXPIRED, SUBMITTED,
 * BROADCASTING, SUPERSEDED, PENDING_RESOLUTION).
 */
const IN_PROGRESS_STATUSES = new Set([
  'PENDING',
  'SUBMITTED',
  'BROADCASTING',
  'PENDING_RESOLUTION',
]);
const TERMINAL_STATUSES = new Set(['REVOKED', 'EXPIRED', 'SUPERSEDED']);

export async function fetchOrgCpeMemberSummary(
  params: FetchOrgCpeMemberSummaryParams,
): Promise<OrgCpeMemberSummary> {
  const { orgId, userId, isOrgAdmin, periodStart } = params;
  const scopedToSelf = !isOrgAdmin;

  // ── anchors read (0342 partial-index shape; §1.6 minimal projection) ──
  let anchorsQuery = supabase
    .from('anchors')
    .select('user_id, status, issued_at')
    .eq('org_id', orgId)
    .eq('credential_type', 'CPE')
    .not('cpe_metadata', 'is', null)
    .is('deleted_at', null);
  if (scopedToSelf) {
    anchorsQuery = anchorsQuery.eq('user_id', userId);
  }
  if (periodStart) {
    anchorsQuery = anchorsQuery.gte('issued_at', periodStart);
  }
  const anchorsRes = await anchorsQuery
    .order('issued_at', { ascending: false })
    .limit(MAX_ROWS);

  if (anchorsRes.error) {
    // Surface the failure — an error banner beats zeros indistinguishable from
    // "no records" (same convention as useAnchorStats / SCRUM-1260).
    throw new Error(`failed to load CPE records: ${anchorsRes.error.message}`);
  }
  const anchorRows = (anchorsRes.data ?? []) as AnchorRow[];

  // ── profiles read for member name/identifier (non-fatal on failure) ──
  let profilesQuery = supabase.from('profiles').select('id, full_name, email');
  profilesQuery = scopedToSelf
    ? profilesQuery.eq('id', userId)
    : profilesQuery.eq('org_id', orgId);
  const profilesRes = await profilesQuery.limit(MAX_ROWS);
  const profileById = new Map<string, ProfileRow>();
  if (!profilesRes.error) {
    for (const row of (profilesRes.data ?? []) as ProfileRow[]) {
      profileById.set(row.id, row);
    }
  }

  // ── per-member aggregation ──
  const byMember = new Map<string, OrgCpeMemberSummaryRow>();
  let securedTotal = 0;
  let pendingTotal = 0;
  let terminalTotal = 0;

  for (const row of anchorRows) {
    if (!row.user_id) continue;
    let member = byMember.get(row.user_id);
    if (!member) {
      const profile = profileById.get(row.user_id);
      member = {
        userId: row.user_id,
        displayName:
          profile?.full_name?.trim() ||
          profile?.email?.trim() ||
          // Static fallback lives here (data-layer), the component maps it to
          // the ORG_CPE_DASHBOARD_LABELS.UNKNOWN_MEMBER copy for display.
          // NEVER an internal-id fragment (round-1 review finding 5).
          '',
        identifier: profile?.email ?? null,
        securedCount: 0,
        pendingCount: 0,
        terminalCount: 0,
        lastActivity: null,
      };
      byMember.set(row.user_id, member);
    }

    // Three-bucket taxonomy — every status lands in exactly one bucket
    // (secured / in-progress / terminal); nothing silently vanishes.
    if (row.status === 'SECURED') {
      member.securedCount += 1;
      securedTotal += 1;
    } else if (row.status && IN_PROGRESS_STATUSES.has(row.status)) {
      member.pendingCount += 1;
      pendingTotal += 1;
    } else if (row.status && TERMINAL_STATUSES.has(row.status)) {
      member.terminalCount += 1;
      terminalTotal += 1;
    }
    if (row.issued_at && (!member.lastActivity || row.issued_at > member.lastActivity)) {
      member.lastActivity = row.issued_at;
    }
  }

  const rows = [...byMember.values()]
    .map((r) => ({
      ...r,
      // '' when neither profile name nor email is readable — the component
      // renders UNKNOWN_MEMBER copy; never a userId fragment.
      displayName: r.displayName || r.identifier || '',
    }))
    .sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));

  return {
    rows,
    totals: {
      members: rows.length,
      secured: securedTotal,
      pending: pendingTotal,
      terminal: terminalTotal,
    },
    scopedToSelf,
  };
}

export interface UseOrgCpeMemberSummaryReturn {
  summary: OrgCpeMemberSummary | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useOrgCpeMemberSummary(
  orgId: string | null | undefined,
  userId: string | null | undefined,
  isOrgAdmin: boolean,
  periodStart: string | null,
): UseOrgCpeMemberSummaryReturn {
  const qc = useQueryClient();
  const enabled = !!orgId && !!userId;

  const queryKey = ['orgCpeMemberSummary', orgId ?? 'none', userId ?? 'none', isOrgAdmin, periodStart ?? 'all'] as const;

  const { data, isLoading, error: queryError } = useQuery({
    queryKey,
    queryFn: () =>
      fetchOrgCpeMemberSummary({
        orgId: orgId!,
        userId: userId!,
        isOrgAdmin,
        periodStart,
      }),
    enabled,
    staleTime: 60_000,
  });

  const refresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: ['orgCpeMemberSummary'] });
  }, [qc]);

  return {
    summary: data ?? null,
    loading: enabled ? isLoading : false,
    error: queryError ? (queryError as Error).message : null,
    refresh,
  };
}
