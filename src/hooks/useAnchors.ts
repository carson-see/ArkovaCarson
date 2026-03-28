/**
 * useAnchors Hook
 *
 * Fetches anchors from Supabase for the authenticated user with realtime
 * subscription for live status updates across all records.
 * RLS policies handle scoping:
 *   - INDIVIDUAL users see only their own anchors
 *   - ORG_ADMIN users see all anchors in their organization
 *
 * Returns data mapped to the Record interface used by RecordsList.
 *
 * @see P3-TS-01 — Replace useState mock arrays with real Supabase queries
 * @see BETA-01 — Mempool Live Transaction Tracking (realtime)
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';
import { TOAST, REALTIME_TOAST_LABELS } from '@/lib/copy';
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

interface UseAnchorsReturn {
  records: Record[];
  loading: boolean;
  error: string | null;
  refreshAnchors: () => Promise<void>;
}

export function useAnchors(): UseAnchorsReturn {
  const { user, loading: authLoading } = useAuth();
  const [records, setRecords] = useState<Record[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);

  const fetchAnchors = useCallback(async () => {
    if (!user) {
      setRecords([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    // Select only needed columns and exclude pipeline anchors server-side.
    // Limit to 100 most recent user records for performance (was fetching 500+).
    const { data, error: fetchError } = await supabase
      .from('anchors')
      .select('id, filename, fingerprint, status, created_at, chain_timestamp, file_size, credential_type, chain_tx_id, chain_block_height, public_id, metadata')
      .is('deleted_at', null)
      .or('metadata.is.null,metadata->>pipeline_source.is.null')
      .order('created_at', { ascending: false })
      .limit(100);

    if (fetchError) {
      setError(fetchError.message);
      setRecords([]);
      toast.error(TOAST.RECORDS_FETCH_FAILED);
    } else {
      setRecords((data ?? []).map(mapAnchorToRecord));
    }

    setLoading(false);
  }, [user]);

  useEffect(() => {
    fetchAnchors();
  }, [fetchAnchors]);

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

  // Extracted handler to reduce nesting depth (SonarQube S2004)
  const handleRealtimePayload = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (payload: { eventType: string; new: any; old: any }) => {
      if (payload.eventType === 'UPDATE') {
        const updated = payload.new as AnchorRow;
        const old = payload.old as Partial<AnchorRow> | null;
        fireStatusToast(old, updated);
        setRecords((prev) =>
          prev.map((r) => (r.id === updated.id ? mapAnchorToRecord(updated) : r)),
        );
      } else if (payload.eventType === 'INSERT') {
        const inserted = payload.new as AnchorRow;
        if (!inserted.deleted_at) {
          setRecords((prev) => [mapAnchorToRecord(inserted), ...prev]);
        }
      } else if (payload.eventType === 'DELETE') {
        const deleted = payload.old as Partial<AnchorRow>;
        if (deleted.id) {
          setRecords((prev) => prev.filter((r) => r.id !== deleted.id));
        }
      }
    },
    [fireStatusToast],
  );

  // Realtime subscription for anchor changes (BETA-01)
  useEffect(() => {
    if (!user) return;

    const channel = supabase
      .channel('anchors-list')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'anchors',
        },
        handleRealtimePayload,
      )
      .subscribe();

    channelRef.current = channel;

    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, [user, handleRealtimePayload]);

  const refreshAnchors = useCallback(async () => {
    await fetchAnchors();
  }, [fetchAnchors]);

  return {
    records,
    loading: authLoading || loading,
    error,
    refreshAnchors,
  };
}
