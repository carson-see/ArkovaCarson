/**
 * useAnchors Hook
 *
 * Fetches anchors from Supabase for the authenticated user.
 * RLS policies handle scoping:
 *   - INDIVIDUAL users see only their own anchors
 *   - ORG_ADMIN users see all anchors in their organization
 *
 * Returns data mapped to the Record interface used by RecordsList.
 *
 * @see P3-TS-01 — Replace useState mock arrays with real Supabase queries
 */

import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';
import { TOAST } from '@/lib/copy';
import { useAuth } from './useAuth';
import type { Database } from '@/types/database.types';
import type { Record } from '@/components/records';

type AnchorRow = Database['public']['Tables']['anchors']['Row'];

/** Map a Supabase anchor row to the UI Record interface. */
function mapAnchorToRecord(anchor: AnchorRow): Record {
  return {
    id: anchor.id,
    filename: anchor.filename,
    fingerprint: anchor.fingerprint,
    status: anchor.status,
    createdAt: anchor.created_at,
    securedAt: anchor.chain_timestamp ?? undefined,
    fileSize: anchor.file_size ?? 0,
    credentialType: anchor.credential_type ?? undefined,
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

  const fetchAnchors = useCallback(async () => {
    if (!user) {
      setRecords([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const { data, error: fetchError } = await supabase
      .from('anchors')
      .select('*')
      .is('deleted_at', null)
      .order('created_at', { ascending: false });

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
