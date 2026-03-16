/**
 * API Keys Hook (P4.5-TS-09)
 *
 * Manages API key CRUD via the worker Verification API endpoints.
 * Keys are created server-side with HMAC-SHA256 hashing.
 * Raw key is returned once at creation and never stored.
 */

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from './useAuth';

const WORKER_URL = import.meta.env.VITE_WORKER_URL ?? 'http://localhost:3001';

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

async function workerFetch(
  endpoint: string,
  options: RequestInit = {},
): Promise<Response> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    throw new Error('No active session — please sign in again');
  }

  return fetch(`${WORKER_URL}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
      ...options.headers,
    },
  });
}

export function useApiKeys() {
  const { user } = useAuth();
  const [keys, setKeys] = useState<ApiKeyMasked[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchKeys = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      const res = await workerFetch('/api/v1/keys');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Failed to fetch keys (${res.status})`);
      }
      const { keys: fetchedKeys } = await res.json();
      setKeys(fetchedKeys ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch API keys');
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  const createKey = useCallback(async (
    name: string,
    scopes: string[] = ['verify'],
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
    await fetchKeys();
    return created as ApiKeyCreated;
  }, [fetchKeys]);

  const revokeKey = useCallback(async (keyId: string) => {
    const res = await workerFetch(`/api/v1/keys/${keyId}`, {
      method: 'PATCH',
      body: JSON.stringify({ is_active: false }),
    });

    if (!res.ok) {
      const parsed = await res.json().catch(() => ({}));
      throw new Error(parsed.error ?? 'Failed to revoke key');
    }

    await fetchKeys();
  }, [fetchKeys]);

  const deleteKey = useCallback(async (keyId: string) => {
    const res = await workerFetch(`/api/v1/keys/${keyId}`, {
      method: 'DELETE',
    });

    if (!res.ok && res.status !== 204) {
      const parsed = await res.json().catch(() => ({}));
      throw new Error(parsed.error ?? 'Failed to delete key');
    }

    await fetchKeys();
  }, [fetchKeys]);

  return { keys, loading, error, createKey, revokeKey, deleteKey, refresh: fetchKeys };
}

export function useApiUsage() {
  const { user } = useAuth();
  const [usage, setUsage] = useState<ApiUsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchUsage = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      const res = await workerFetch('/api/v1/usage');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Failed to fetch usage (${res.status})`);
      }
      const data = await res.json();
      setUsage(data as ApiUsageData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch usage');
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchUsage();
  }, [fetchUsage]);

  return { usage, loading, error, refresh: fetchUsage };
}
