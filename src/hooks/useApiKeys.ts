/**
 * API Keys Hook (P4.5-TS-09)
 *
 * Manages API key CRUD via the worker Verification API endpoints.
 * Keys are created server-side with HMAC-SHA256 hashing.
 * Raw key is returned once at creation and never stored.
 * Uses React Query for caching and deduplication.
 */

import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { workerFetch } from '@/lib/workerClient';
import { queryKeys } from '@/lib/queryClient';
import { useAuth } from './useAuth';

export interface ApiKeyMasked {
  id: string;
  key_prefix: string;
  name: string;
  scopes: string[];
  rate_limit_tier: string;
  is_active: boolean;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
}

export interface ApiKeyCreated extends ApiKeyMasked {
  key: string;
  warning: string;
}

export interface ApiUsageData {
  used: number;
  limit: number | 'unlimited';
  remaining: number | 'unlimited';
  reset_date: string;
  month: string;
  keys: Array<{ key_prefix: string; name: string; used: number }>;
}

async function fetchKeysData(): Promise<ApiKeyMasked[]> {
  const res = await workerFetch('/api/v1/keys');
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to fetch keys (${res.status})`);
  }
  const { keys } = await res.json();
  return keys ?? [];
}

async function fetchUsageData(): Promise<ApiUsageData> {
  const res = await workerFetch('/api/v1/usage');
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      return {
        used: 0,
        limit: 'unlimited',
        remaining: 'unlimited',
        reset_date: new Date().toISOString(),
        month: new Date().toISOString().slice(0, 7),
        keys: [],
      };
    }
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to fetch usage (${res.status})`);
  }
  return await res.json() as ApiUsageData;
}

export function useApiKeys(options: { enabled?: boolean } = {}) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const enabled = !!user && (options.enabled ?? true);

  const {
    data: keys = [],
    isLoading: loading,
    error: queryError,
  } = useQuery({
    queryKey: queryKeys.apiKeys(user?.id ?? ''),
    queryFn: fetchKeysData,
    enabled,
    staleTime: 30_000,
  });

  const refresh = useCallback(async () => {
    if (user) {
      await qc.invalidateQueries({ queryKey: queryKeys.apiKeys(user.id) });
    }
  }, [user, qc]);

  const createKey = useCallback(async (
    name: string,
    scopes: string[] = ['read:search'],
    expiresInDays?: number,
  ): Promise<ApiKeyCreated> => {
    const body: Record<string, unknown> = { name, scopes };
    if (expiresInDays) body.expires_in_days = expiresInDays;

    const res = await workerFetch('/api/v1/keys', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const parsed = await res.json().catch(() => ({}));
      throw new Error(parsed.error ?? `Failed to create key (${res.status})`);
    }

    const created = await res.json();
    if (user) {
      await qc.invalidateQueries({ queryKey: queryKeys.apiKeys(user.id) });
    }
    return created as ApiKeyCreated;
  }, [user, qc]);

  const revokeKey = useCallback(async (keyId: string) => {
    const res = await workerFetch(`/api/v1/keys/${keyId}`, {
      method: 'PATCH',
      body: JSON.stringify({ is_active: false }),
    });

    if (!res.ok) {
      const parsed = await res.json().catch(() => ({}));
      throw new Error(parsed.error ?? 'Failed to revoke key');
    }

    if (user) {
      await qc.invalidateQueries({ queryKey: queryKeys.apiKeys(user.id) });
    }
  }, [user, qc]);

  const deleteKey = useCallback(async (keyId: string) => {
    const res = await workerFetch(`/api/v1/keys/${keyId}`, {
      method: 'DELETE',
    });

    if (!res.ok && res.status !== 204) {
      const parsed = await res.json().catch(() => ({}));
      throw new Error(parsed.error ?? 'Failed to delete key');
    }

    if (user) {
      await qc.invalidateQueries({ queryKey: queryKeys.apiKeys(user.id) });
    }
  }, [user, qc]);

  return {
    keys,
    loading: enabled ? loading : false,
    error: queryError ? (queryError as Error).message : null,
    createKey,
    revokeKey,
    deleteKey,
    refresh,
  };
}

export function useApiUsage(options: { enabled?: boolean } = {}) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const enabled = !!user && (options.enabled ?? true);

  const {
    data: usage = null,
    isLoading: loading,
    error: queryError,
  } = useQuery({
    queryKey: queryKeys.apiUsage(user?.id ?? ''),
    queryFn: fetchUsageData,
    enabled,
    staleTime: 30_000,
  });

  const refresh = useCallback(async () => {
    if (user) {
      await qc.invalidateQueries({ queryKey: queryKeys.apiUsage(user.id) });
    }
  }, [user, qc]);

  return {
    usage,
    loading: enabled ? loading : false,
    error: queryError ? (queryError as Error).message : null,
    refresh,
  };
}
