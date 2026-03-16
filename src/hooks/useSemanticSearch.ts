/**
 * useSemanticSearch Hook (P8-S12)
 *
 * Client-side hook for AI-powered semantic credential search.
 * Calls GET /api/v1/ai/search on the worker API.
 * Gated behind ENABLE_SEMANTIC_SEARCH feature flag.
 */

import { useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';

export interface SemanticSearchResult {
  anchorId: string;
  publicId: string;
  fileName: string;
  credentialType: string;
  metadata: Record<string, string>;
  status: string;
  createdAt: string;
  similarity: number;
}

export interface SemanticSearchResponse {
  query: string;
  results: SemanticSearchResult[];
  count: number;
  threshold: number;
  creditsRemaining: number;
}

export interface UseSemanticSearchReturn {
  results: SemanticSearchResult[];
  isSearching: boolean;
  error: string | null;
  creditsRemaining: number | null;
  search: (query: string, threshold?: number, limit?: number) => Promise<void>;
  clear: () => void;
}

export function useSemanticSearch(): UseSemanticSearchReturn {
  const [results, setResults] = useState<SemanticSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creditsRemaining, setCreditsRemaining] = useState<number | null>(null);

  const search = useCallback(
    async (query: string, threshold = 0.7, limit = 10) => {
      if (!query.trim()) return;

      setIsSearching(true);
      setError(null);

      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();

        if (!session?.access_token) {
          setError('Authentication required');
          return;
        }

        const workerUrl = import.meta.env.VITE_WORKER_URL ?? 'http://localhost:3001';
        const params = new URLSearchParams({
          q: query,
          threshold: String(threshold),
          limit: String(limit),
        });

        const response = await fetch(
          `${workerUrl}/api/v1/ai/search?${params.toString()}`,
          {
            headers: {
              Authorization: `Bearer ${session.access_token}`,
            },
          },
        );

        if (response.status === 402) {
          setError('No AI credits remaining. Upgrade your plan for more credits.');
          return;
        }

        if (response.status === 503) {
          setError('Semantic search is not currently enabled.');
          return;
        }

        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          setError(body.message ?? 'Search failed');
          return;
        }

        const data: SemanticSearchResponse = await response.json();
        setResults(data.results);
        setCreditsRemaining(data.creditsRemaining);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Search failed');
      } finally {
        setIsSearching(false);
      }
    },
    [],
  );

  const clear = useCallback(() => {
    setResults([]);
    setError(null);
  }, []);

  return { results, isSearching, error, creditsRemaining, search, clear };
}
