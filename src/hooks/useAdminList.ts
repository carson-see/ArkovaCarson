/**
 * Admin List Hook (SN1)
 *
 * Generic paginated list fetcher for admin detail pages.
 * Supports search, filtering, and pagination.
 */

import { useState, useCallback } from 'react';
import { workerFetch } from '@/lib/workerClient';

export interface AdminListState<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  loading: boolean;
  error: string | null;
}

export function useAdminList<T>(endpoint: string, pageSize = 25) {
  const [state, setState] = useState<AdminListState<T>>({
    items: [],
    total: 0,
    page: 1,
    limit: pageSize,
    loading: false,
    error: null,
  });

  const fetchList = useCallback(async (params: {
    page?: number;
    search?: string;
    filters?: Record<string, string>;
  } = {}) => {
    const page = params.page ?? 1;
    setState((s) => ({ ...s, loading: true, error: null, page }));

    const searchParams = new URLSearchParams();
    searchParams.set('page', String(page));
    searchParams.set('limit', String(pageSize));
    if (params.search) searchParams.set('search', params.search);
    if (params.filters) {
      for (const [key, value] of Object.entries(params.filters)) {
        if (value) searchParams.set(key, value);
      }
    }

    try {
      const response = await workerFetch(`${endpoint}?${searchParams.toString()}`, { method: 'GET' });

      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: 'Request failed' }));
        setState((s) => ({ ...s, loading: false, error: body.error ?? `HTTP ${response.status}` }));
        return;
      }

      const data = await response.json();
      // The response has a key matching the endpoint type (users, records, subscriptions)
      const items = data.users ?? data.records ?? data.subscriptions ?? [];
      setState({
        items,
        total: data.total ?? 0,
        page: data.page ?? page,
        limit: data.limit ?? pageSize,
        loading: false,
        error: null,
      });
    } catch (err) {
      setState((s) => ({
        ...s,
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to fetch data',
      }));
    }
  }, [endpoint, pageSize]);

  return { ...state, fetchList };
}
