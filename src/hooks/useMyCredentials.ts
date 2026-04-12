/**
 * useMyCredentials Hook
 *
 * Fetches credentials issued TO the current user via the
 * get_my_credentials() RPC. Uses React Query for caching.
 *
 * @see UF-03
 */

import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { queryKeys } from '@/lib/queryClient';
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

async function fetchMyCredentialsData(): Promise<ReceivedCredential[]> {
  const { data, error } = await (supabase.rpc as (fn: string, params?: Record<string, unknown>) => ReturnType<typeof supabase.rpc>)('get_my_credentials');

  if (error) throw error;

  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  return rows.map((row) => ({
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
  }));
}

export function useMyCredentials(): UseMyCredentialsReturn {
  const { user, loading: authLoading } = useAuth();
  const qc = useQueryClient();

  const {
    data: credentials = [],
    isLoading: queryLoading,
    error: queryError,
  } = useQuery({
    queryKey: queryKeys.myCredentials(user?.id ?? ''),
    queryFn: fetchMyCredentialsData,
    enabled: !!user,
    staleTime: 60_000,
  });

  const refreshCredentials = useCallback(async () => {
    if (user) {
      await qc.invalidateQueries({ queryKey: queryKeys.myCredentials(user.id) });
    }
  }, [user, qc]);

  return {
    credentials,
    loading: authLoading || (!!user && queryLoading),
    error: queryError ? (queryError as Error).message : null,
    refreshCredentials,
  };
}
