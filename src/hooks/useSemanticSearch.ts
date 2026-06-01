/**
 * useSemanticSearch Hook (P8-S12)
 *
 * Client-side hook for AI-powered semantic credential search.
 * Calls GET /api/v1/ai/search on the worker API.
 * Gated behind ENABLE_SEMANTIC_SEARCH feature flag.
 */

import { useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { WORKER_URL } from '../lib/workerClient';
import { SEMANTIC_SEARCH_LABELS } from '../lib/copy';

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
          setError(SEMANTIC_SEARCH_LABELS.ERROR_AUTH);
          return;
        }

        const workerUrl = WORKER_URL;
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

        // 402 — org has run out of AI credits (worker `insufficient_credits`).
        if (response.status === 402) {
          setError(SEMANTIC_SEARCH_LABELS.ERROR_NO_CREDITS);
          return;
        }

        // 503 — the aiSemanticSearchGate middleware returns service_unavailable
        // when the flag is off OR the flag lookup fails closed (and a downstream
        // AI provider outage would surface the same way). Keep the copy honest:
        // it's temporarily unavailable, without asserting a specific cause.
        if (response.status === 503) {
          setError(SEMANTIC_SEARCH_LABELS.ERROR_UNAVAILABLE);
          return;
        }

        if (!response.ok) {
          // Do NOT surface raw worker error bodies — they can leak engineering
          // copy (banned per Constitution §1.3). Use friendly generic copy.
          setError(SEMANTIC_SEARCH_LABELS.ERROR_GENERIC);
          return;
        }

        const data: SemanticSearchResponse = await response.json();
        setResults(data.results);
        setCreditsRemaining(data.creditsRemaining);
      } catch (err) {
        // A failed fetch surfaces as a TypeError in browsers ("Failed to
        // fetch" / "NetworkError"). Treat any TypeError as a connectivity
        // problem; never echo a raw error message into user-visible copy.
        if (err instanceof TypeError) {
          setError(SEMANTIC_SEARCH_LABELS.ERROR_NETWORK);
        } else {
          setError(SEMANTIC_SEARCH_LABELS.ERROR_GENERIC);
        }
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
