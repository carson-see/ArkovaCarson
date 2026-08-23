/**
 * useOrgInvitations Hook
 *
 * Fetches an organization's non-accepted invitations (pending / expired /
 * revoked) so the org page can show what happened after "Invite Member" was
 * clicked. Read-side of the founder-reported "I invited someone and nothing
 * happened, and I can't tell why" gap: previously nothing in the UI
 * distinguished "sent, waiting" from "sent, expired, invitee never saw it"
 * from "never actually sent" — all three looked identical (nothing changes
 * on OrgProfilePage). RLS-safe: relies on the existing "Org admins can view
 * invitations" SELECT policy (org_id must match the caller's own
 * profiles.org_id where profiles.role = 'ORG_ADMIN') — no migration needed.
 *
 * Never selects `invitations.token` — that is the single-use accept
 * credential and must never reach the browser for display (Constitution
 * §1.4). "Resend" (wired in OrgProfilePage) re-invites via the existing
 * invite_member RPC + /api/send-invitation-email path instead of reusing the
 * old token, so this hook has no reason to expose it either way.
 *
 * `status` is read from the DB, but `displayStatus` is recomputed
 * client-side exactly like the worker's GET /api/invitations/:token preview
 * (services/worker/src/api/invitations.ts's isExpired()): nothing flips
 * `invitations.status` from 'pending' to 'expired' at rest (confirmed
 * against prod — see docs/staging/agents.md invite-accept investigation),
 * so a stale 'pending' row past its `expires_at` must still display as
 * expired rather than as an actionable, still-live invite.
 */

import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { queryKeys } from '@/lib/queryClient';

export type InvitationDisplayStatus = 'pending' | 'expired' | 'revoked';

export interface OrgInvitation {
  id: string;
  email: string;
  role: 'ORG_ADMIN' | 'INDIVIDUAL' | 'ORG_MEMBER';
  createdAt: string;
  expiresAt: string;
  displayStatus: InvitationDisplayStatus;
}

interface UseOrgInvitationsReturn {
  invitations: OrgInvitation[];
  loading: boolean;
  error: string | null;
  refreshInvitations: () => Promise<void>;
}

interface InvitationRow {
  id: string;
  email: string;
  role: string;
  status: string;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
}

function toDisplayStatus(row: InvitationRow): InvitationDisplayStatus {
  if (row.status === 'pending' && new Date(row.expires_at).getTime() < Date.now()) {
    return 'expired';
  }
  if (row.status === 'revoked') return 'revoked';
  if (row.status === 'expired') return 'expired';
  return 'pending';
}

async function fetchInvitationsData(orgId: string): Promise<OrgInvitation[]> {
  const { data, error } = await supabase
    .from('invitations')
    .select('id, email, role, status, created_at, expires_at, accepted_at')
    .eq('org_id', orgId)
    .neq('status', 'accepted')
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) throw error;

  return ((data ?? []) as InvitationRow[]).map((row) => ({
    id: row.id,
    email: row.email,
    role: row.role as OrgInvitation['role'],
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    displayStatus: toDisplayStatus(row),
  }));
}

export function useOrgInvitations(orgId: string | null | undefined): UseOrgInvitationsReturn {
  const qc = useQueryClient();

  const {
    data: invitations = [],
    isLoading: loading,
    error: queryError,
  } = useQuery({
    queryKey: queryKeys.orgInvitations(orgId ?? ''),
    queryFn: () => fetchInvitationsData(orgId!),
    enabled: !!orgId,
    staleTime: 30_000,
  });

  const refreshInvitations = useCallback(async () => {
    if (orgId) {
      await qc.invalidateQueries({ queryKey: queryKeys.orgInvitations(orgId) });
    }
  }, [orgId, qc]);

  return {
    invitations,
    loading: !orgId ? false : loading,
    error: queryError ? (queryError as Error).message : null,
    refreshInvitations,
  };
}
