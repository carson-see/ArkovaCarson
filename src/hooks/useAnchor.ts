/**
 * useAnchor Hook
 *
 * Fetches a single anchor by ID from Supabase with realtime subscription
 * for live status updates (SUBMITTED → SECURED progression).
 * RLS policies ensure the user can only access their own anchors
 * (or org anchors if they are an ORG_ADMIN).
 *
 * @see P4-TS-03 — Wire AssetDetailView to /records/:id route
 * @see BETA-01 — Mempool Live Transaction Tracking (realtime)
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from './useAuth';
import type { Database } from '@/types/database.types';
import type { RealtimeChannel } from '@supabase/supabase-js';

type AnchorRow = Database['public']['Tables']['anchors']['Row'];

interface UseAnchorReturn {
  anchor: AnchorRow | null;
  loading: boolean;
  error: string | null;
  refreshAnchor: () => Promise<void>;
}

export function useAnchor(id: string | undefined): UseAnchorReturn {
  const { user, loading: authLoading } = useAuth();
  const [anchor, setAnchor] = useState<AnchorRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);

  const fetchAnchor = useCallback(async () => {
    if (!user || !id) {
      setAnchor(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const { data, error: fetchError } = await supabase
      .from('anchors')
      .select('*')
      .eq('id', id)
      .is('deleted_at', null)
      .single();

    if (fetchError) {
      setError(fetchError.code === 'PGRST116' ? 'Record not found' : fetchError.message);
      setAnchor(null);
    } else {
      setAnchor(data);
    }

    setLoading(false);
  }, [user, id]);

  useEffect(() => {
    fetchAnchor();
  }, [fetchAnchor]);

  // Realtime subscription for anchor status changes (BETA-01)
  useEffect(() => {
    if (!user || !id) return;

    const channel = supabase
      .channel(`anchor-${id}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'anchors',
          filter: `id=eq.${id}`,
        },
        (payload) => {
          setAnchor((prev) => (prev ? { ...prev, ...payload.new } as AnchorRow : prev));
        },
      )
      .subscribe();

    channelRef.current = channel;

    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, [user, id]);

  const refreshAnchor = useCallback(async () => {
    await fetchAnchor();
  }, [fetchAnchor]);

  return {
    anchor,
    loading: authLoading || loading,
    error,
    refreshAnchor,
  };
}
