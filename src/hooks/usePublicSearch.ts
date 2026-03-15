/**
 * Public Search Hook
 *
 * Provides search functionality for public credential discovery.
 * Uses search_public_issuers and get_public_issuer_registry RPCs.
 *
 * @see UF-02
 */

import { useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';

export interface IssuerResult {
  org_id: string;
  org_name: string;
  org_domain: string | null;
  credential_count: number;
}

export interface IssuerRegistryAnchor {
  public_id: string;
  credential_type: string | null;
  filename: string;
  issued_at: string | null;
  created_at: string;
  label: string | null;
}

export interface IssuerRegistry {
  org_id: string;
  org_name: string;
  org_domain: string | null;
  total: number;
  anchors: IssuerRegistryAnchor[];
}

interface UsePublicSearchReturn {
  /** Search results for issuer search */
  issuerResults: IssuerResult[];
  /** Whether a search is in progress */
  searching: boolean;
  /** Search error message */
  error: string | null;
  /** Search for public issuers by name */
  searchIssuers: (query: string) => Promise<void>;
  /** Clear search results */
  clearResults: () => void;
}

export function usePublicSearch(): UsePublicSearchReturn {
  const [issuerResults, setIssuerResults] = useState<IssuerResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const searchIssuers = useCallback(async (query: string) => {
    if (!query.trim()) {
      setIssuerResults([]);
      return;
    }

    setSearching(true);
    setError(null);

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error: rpcError } = await (supabase.rpc as any)(
        'search_public_issuers',
        { p_query: query.trim() }
      );

      if (rpcError) {
        setError(rpcError.message);
        return;
      }

      setIssuerResults((data ?? []) as IssuerResult[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setSearching(false);
    }
  }, []);

  const clearResults = useCallback(() => {
    setIssuerResults([]);
    setError(null);
  }, []);

  return { issuerResults, searching, error, searchIssuers, clearResults };
}

interface UseIssuerRegistryReturn {
  registry: IssuerRegistry | null;
  loading: boolean;
  error: string | null;
  fetchRegistry: (orgId: string, page?: number) => Promise<void>;
}

export function useIssuerRegistry(): UseIssuerRegistryReturn {
  const [registry, setRegistry] = useState<IssuerRegistry | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchRegistry = useCallback(async (orgId: string, page = 0) => {
    setLoading(true);
    setError(null);

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error: rpcError } = await (supabase.rpc as any)(
        'get_public_issuer_registry',
        { p_org_id: orgId, p_limit: 20, p_offset: page * 20 }
      );

      if (rpcError) {
        setError(rpcError.message);
        return;
      }

      if (data?.error) {
        setError(data.error as string);
        return;
      }

      setRegistry(data as IssuerRegistry);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load registry');
    } finally {
      setLoading(false);
    }
  }, []);

  return { registry, loading, error, fetchRegistry };
}
