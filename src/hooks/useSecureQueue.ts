/**
 * useSecureQueue Hook
 *
 * QUEUE-01 / SCRUM-2894 (L2-A1) — the consumer secure-queue
 * (`consumer_secure_queue` in queueContract.ts's QUEUE_SURFACES): documents
 * with status PENDING waiting for the daily batch to secure them. Queueing
 * is free — this hook never touches credits.
 *
 * Two scopes:
 *  - 'own' — the signed-in user's own PENDING anchors (personal queue).
 *  - 'org' — every PENDING anchor in the caller's org (admin org queue).
 *    Reachable via the existing `anchors_select_org` RLS policy (SELECT is
 *    NOT role-gated at the RLS layer — see the file-level RLS note below);
 *    this hook itself is only ever invoked with scope='org' when the caller
 *    is ORG_ADMIN (gated in SecureQueuePage), matching the existing
 *    useAnchors.ts convention.
 *
 * REMOVAL: soft-delete via `deleted_at` (validateAnchorUpdate), which is the
 * established pattern every list query already filters on
 * (`.is('deleted_at', null)` — see useAnchors.ts, RecordsList, etc.). This
 * relies on the EXISTING `anchors_update_own` RLS policy (owner-only) — no
 * RLS change ships with this hook. There is currently NO org-admin UPDATE/
 * DELETE policy on `anchors`, so an admin cannot remove another org member's
 * queued item today; `removeItem` defensively detects the resulting
 * zero-row update (RLS silently matches nothing rather than erroring) and
 * throws SECURE_QUEUE_PAGE_LABELS.REMOVE_FAILED instead of pretending it
 * worked. SecureQueuePage additionally disables the control up front for
 * non-own org rows so the failure path is a defensive backstop, not the
 * primary UX. (Widening that RLS policy is SCRUM-3010 scope — out of bounds
 * here per this sprint's lane coordination.)
 */
import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { queryKeys } from '@/lib/queryClient';
import { validateAnchorUpdate } from '@/lib/validators';
import { SECURE_QUEUE_PAGE_LABELS } from '@/lib/copy';
import { useAuth } from './useAuth';
import { useProfile } from './useProfile';

export type SecureQueueScope = 'own' | 'org';

export interface SecureQueueItem {
  id: string;
  filename: string;
  fingerprint: string;
  createdAt: string;
  fileSize: number;
  credentialType: string | null;
  publicId: string | null;
  ownerUserId: string;
  /** Whether the CURRENT caller owns this item (drives whether Remove is enabled). */
  isOwn: boolean;
}

interface UseSecureQueueReturn {
  items: SecureQueueItem[];
  loading: boolean;
  error: string | null;
  removeItem: (anchorId: string) => Promise<void>;
  refresh: () => Promise<void>;
}

async function fetchQueueData(
  userId: string,
  scope: SecureQueueScope,
  orgId: string | null,
): Promise<SecureQueueItem[]> {
  let query = supabase
    .from('anchors')
    .select('id, filename, fingerprint, created_at, file_size, credential_type, public_id, user_id')
    .eq('status', 'PENDING')
    .is('deleted_at', null);

  if (scope === 'org' && orgId) {
    query = query.eq('org_id', orgId);
  } else {
    query = query.eq('user_id', userId);
  }

  const { data, error } = await query
    .order('created_at', { ascending: true })
    .limit(200);

  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: row.id,
    filename: row.filename,
    fingerprint: row.fingerprint,
    createdAt: row.created_at,
    fileSize: row.file_size ?? 0,
    credentialType: row.credential_type,
    publicId: row.public_id,
    ownerUserId: row.user_id,
    isOwn: row.user_id === userId,
  }));
}

export function useSecureQueue(scope: SecureQueueScope = 'own'): UseSecureQueueReturn {
  const { user, loading: authLoading } = useAuth();
  const { profile } = useProfile();
  const qc = useQueryClient();
  const orgId = profile?.org_id ?? null;
  const queryOrgId = scope === 'org' ? orgId : null;
  const enabled = !!user && (scope === 'own' || !!orgId);

  const queryKey = queryKeys.secureQueue(user?.id ?? '', queryOrgId, scope);

  const {
    data: items = [],
    isLoading: queryLoading,
    error: queryError,
  } = useQuery({
    queryKey,
    queryFn: () => fetchQueueData(user!.id, scope, queryOrgId),
    enabled,
    staleTime: 15_000,
  });

  const removeItem = useCallback(async (anchorId: string) => {
    const payload = validateAnchorUpdate({ deleted_at: new Date().toISOString() });
    // AnchorUpdateSchema's fully-optional field type trips Supabase's stricter
    // update-type excess-property check even though only deleted_at is set
    // (mirrors the insert-path cast pattern in SecureDocumentDialog.tsx's
    // handleConfirm).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any)
      .from('anchors')
      .update(payload)
      .eq('id', anchorId)
      .select('id');

    if (error) throw error;
    // RLS (anchors_update_own) matches zero rows rather than erroring when the
    // caller doesn't own the row — surface that as a real failure.
    if (!data || data.length === 0) {
      throw new Error(SECURE_QUEUE_PAGE_LABELS.REMOVE_FAILED);
    }

    await qc.invalidateQueries({ queryKey });
  }, [qc, queryKey]);

  const refresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey });
  }, [qc, queryKey]);

  return {
    items,
    loading: authLoading || (enabled && queryLoading),
    error: queryError ? (queryError as Error).message : null,
    removeItem,
    refresh,
  };
}
