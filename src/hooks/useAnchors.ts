/**
 * useAnchors Hook
 *
 * Fetches anchors from Supabase for the authenticated user with realtime
 * subscription for live status updates across all records.
 * RLS policies handle scoping:
 *   - INDIVIDUAL users see only their own anchors
 *   - ORG_ADMIN users see all anchors in their organization
 *
 * Uses React Query for caching + stale-while-revalidate. Instant renders
 * on navigation — no re-fetch delay.
 *
 * Returns data mapped to the Record interface used by RecordsList.
 *
 * @see P3-TS-01 — Replace useState mock arrays with real Supabase queries
 * @see BETA-01 — Mempool Live Transaction Tracking (realtime)
 */

import { useEffect, useCallback, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';
import { TOAST, REALTIME_TOAST_LABELS } from '@/lib/copy';
import { queryKeys } from '@/lib/queryClient';
import { getExplorerBaseUrl } from '@/components/ui/ExplorerLink';
import { useAuth } from './useAuth';
import type { Database } from '@/types/database.types';
import type { Record } from '@/components/records';
import type { RealtimeChannel } from '@supabase/supabase-js';

type AnchorRow = Database['public']['Tables']['anchors']['Row'];

/** Subset of AnchorRow columns selected for performance (not select *). */
type AnchorPartial = Pick<AnchorRow,
  'id' | 'filename' | 'fingerprint' | 'status' | 'created_at' |
  'chain_timestamp' | 'file_size' | 'credential_type' | 'chain_tx_id' |
  'chain_block_height' | 'public_id' | 'metadata'
>;

/** Map a Supabase anchor row to the UI Record interface. */
function mapAnchorToRecord(anchor: AnchorPartial): Record {
  const meta = anchor.metadata as { issuer?: string; [k: string]: unknown } | null;
  return {
    id: anchor.id,
    filename: anchor.filename,
    fingerprint: anchor.fingerprint,
    status: anchor.status,
    createdAt: anchor.created_at,
    securedAt: anchor.chain_timestamp ?? undefined,
    fileSize: anchor.file_size ?? 0,
    credentialType: anchor.credential_type ?? undefined,
    chainTxId: anchor.chain_tx_id ?? undefined,
    chainBlockHeight: anchor.chain_block_height ?? undefined,
    publicId: anchor.public_id ?? undefined,
    metadata: meta ?? undefined,
    issuerName: meta?.issuer ?? undefined,
  };
}

/** Fetch anchors from Supabase — extracted for React Query.
 *  PERF: Always filter by user_id so Postgres uses
 *  idx_anchors_user_nopipeline_created instead of scanning 1.4M rows
 *  through RLS (critical for platform admin accounts). */
async function fetchAnchorsData(userId: string): Promise<Record[]> {
  const { data, error } = await supabase
    .from('anchors')
    .select('id, filename, fingerprint, status, created_at, chain_timestamp, file_size, credential_type, chain_tx_id, chain_block_height, public_id, metadata')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .is('metadata->pipeline_source', null)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) throw error;

  return (data ?? []).map(mapAnchorToRecord);
}

interface UseAnchorsReturn {
  records: Record[];
  loading: boolean;
  error: string | null;
  refreshAnchors: () => Promise<void>;
}

export function useAnchors(): UseAnchorsReturn {
  const { user, loading: authLoading } = useAuth();
  const qc = useQueryClient();
  const channelRef = useRef<RealtimeChannel | null>(null);

  const {
    data: records = [],
    isLoading: queryLoading,
    error: queryError,
  } = useQuery({
    queryKey: queryKeys.anchors(user?.id ?? ''),
    queryFn: () => fetchAnchorsData(user!.id),
    enabled: !!user,
  });

  // Fire status-transition toast with optional mempool link
  const fireStatusToast = useCallback((oldRow: Partial<AnchorRow> | null, newRow: AnchorRow) => {
    const prev = oldRow?.status;
    const next = newRow.status;
    if (!prev || prev === next) return;

    if (next === 'SUBMITTED' && newRow.chain_tx_id) {
      const explorerUrl = `${getExplorerBaseUrl()}/tx/${newRow.chain_tx_id}`;
      toast.info(REALTIME_TOAST_LABELS.SUBMITTED, {
        description: `${newRow.filename} — track on explorer`,
        action: {
          label: 'View on Explorer',
          onClick: () => window.open(explorerUrl, '_blank', 'noopener,noreferrer'),
        },
        duration: 15000,
      });
    } else if (next === 'SECURED') {
      const explorerUrl = newRow.chain_tx_id
        ? `${getExplorerBaseUrl()}/tx/${newRow.chain_tx_id}`
        : undefined;
      toast.success(REALTIME_TOAST_LABELS.SECURED, {
        description: newRow.filename,
        ...(explorerUrl && {
          action: {
            label: 'View Receipt',
            onClick: () => window.open(explorerUrl, '_blank', 'noopener,noreferrer'),
          },
        }),
        duration: 10000,
      });
    } else if (next === 'REVOKED') {
      toast.error(REALTIME_TOAST_LABELS.REVOKED, { description: newRow.filename });
    } else if (next === 'EXPIRED') {
      toast.warning(REALTIME_TOAST_LABELS.EXPIRED, { description: newRow.filename });
    }
  }, []);

  // Handle realtime events by updating the React Query cache directly
  const handleRealtimePayload = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (payload: { eventType: string; new: any; old: any }) => {
      const key = queryKeys.anchors(user?.id ?? '');

      if (payload.eventType === 'UPDATE') {
        const updated = payload.new as AnchorRow;
        const old = payload.old as Partial<AnchorRow> | null;
        fireStatusToast(old, updated);
        qc.setQueryData<Record[]>(key, (prev) =>
          (prev ?? []).map((r) => (r.id === updated.id ? mapAnchorToRecord(updated) : r)),
        );
      } else if (payload.eventType === 'INSERT') {
        const inserted = payload.new as AnchorRow;
        if (!inserted.deleted_at) {
          qc.setQueryData<Record[]>(key, (prev) =>
            [mapAnchorToRecord(inserted), ...(prev ?? [])],
          );
        }
      } else if (payload.eventType === 'DELETE') {
        const deleted = payload.old as Partial<AnchorRow>;
        if (deleted.id) {
          qc.setQueryData<Record[]>(key, (prev) =>
            (prev ?? []).filter((r) => r.id !== deleted.id),
          );
        }
      }
    },
    [user?.id, fireStatusToast, qc],
  );

  // Realtime subscription for anchor changes (BETA-01)
  // Filtered by user_id to reduce traffic (H3) + reconnect handler (C4)
  useEffect(() => {
    if (!user) return;

    const channel = supabase
      .channel(`anchors-${user.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'anchors',
          filter: `user_id=eq.${user.id}`,
        },
        handleRealtimePayload,
      )
      .subscribe((status) => {
        // Refetch on reconnect to catch any missed updates (C4)
        if (status === 'SUBSCRIBED' && channelRef.current) {
          qc.invalidateQueries({ queryKey: queryKeys.anchors(user.id) });
        }
      });

    channelRef.current = channel;

    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, [user, handleRealtimePayload, qc]);

  const refreshAnchors = useCallback(async () => {
    if (user) {
      await qc.invalidateQueries({ queryKey: queryKeys.anchors(user.id) });
    }
  }, [user, qc]);

  if (queryError) {
    toast.error(TOAST.RECORDS_FETCH_FAILED);
  }

  return {
    records,
    loading: authLoading || (!!user && queryLoading),
    error: queryError ? (queryError as Error).message : null,
    refreshAnchors,
  };
}
