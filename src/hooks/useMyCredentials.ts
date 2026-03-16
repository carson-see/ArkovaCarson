/**
 * useMyCredentials Hook
 *
 * Fetches credentials issued TO the current user via the
 * get_my_credentials() RPC. Uses the anchor_recipients table
 * to track which credentials were issued to which user.
 *
 * @see UF-03
 */

import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from './useAuth';

export interface ReceivedCredential {
  recipientId: string;
  anchorId: string;
  claimedAt: string | null;
  recipientCreatedAt: string;
  publicId: string;
  filename: string;
  fingerprint: string;
  status: string;
  credentialType: string | null;
  metadata: Record<string, unknown> | null;
  issuedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  orgName: string | null;
  orgId: string | null;
}

interface UseMyCredentialsReturn {
  credentials: ReceivedCredential[];
  loading: boolean;
  error: string | null;
  refreshCredentials: () => Promise<void>;
}

export function useMyCredentials(): UseMyCredentialsReturn {
  const { user, loading: authLoading } = useAuth();
  const [credentials, setCredentials] = useState<ReceivedCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchCredentials = useCallback(async () => {
    if (!user) {
      setCredentials([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const { data, error: fetchError } = await (supabase.rpc as (fn: string, params?: Record<string, unknown>) => ReturnType<typeof supabase.rpc>)('get_my_credentials');

    if (fetchError) {
      setError(fetchError.message);
      setCredentials([]);
    } else {
      const rows = (data ?? []) as unknown as Record<string, unknown>[];
      setCredentials(
        rows.map((row: Record<string, unknown>) => ({
          recipientId: row.recipient_id as string,
          anchorId: row.anchor_id as string,
          claimedAt: row.claimed_at as string | null,
          recipientCreatedAt: row.recipient_created_at as string,
          publicId: row.public_id as string,
          filename: row.filename as string,
          fingerprint: row.fingerprint as string,
          status: row.status as string,
          credentialType: row.credential_type as string | null,
          metadata: row.metadata as Record<string, unknown> | null,
          issuedAt: row.issued_at as string | null,
          expiresAt: row.expires_at as string | null,
          createdAt: row.created_at as string,
          orgName: row.org_name as string | null,
          orgId: row.org_id as string | null,
        }))
      );
    }

    setLoading(false);
  }, [user]);

  useEffect(() => {
    fetchCredentials();
  }, [fetchCredentials]);

  const refreshCredentials = useCallback(async () => {
    await fetchCredentials();
  }, [fetchCredentials]);

  return {
    credentials,
    loading: authLoading || loading,
    error,
    refreshCredentials,
  };
}
