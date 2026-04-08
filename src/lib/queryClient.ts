/**
 * React Query Client Configuration
 *
 * Provides global caching, deduplication, and stale-while-revalidate
 * for all Supabase queries. This eliminates redundant network requests
 * and gives instant page renders from cache on navigation.
 *
 * @see PERF — Performance optimization for enterprise-grade load times
 */

import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Show cached data instantly, refetch in background after 30s
      staleTime: 30_000,
      // Keep unused cache entries for 5 minutes
      gcTime: 5 * 60_000,
      // Refetch when user returns to tab (catches updates missed while away)
      refetchOnWindowFocus: true,
      // Don't retry on auth errors (4xx) — only on transient failures
      retry: (failureCount, error) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const status = (error as any)?.status ?? (error as any)?.code;
        if (status === 401 || status === 403 || status === 404) return false;
        return failureCount < 2;
      },
    },
  },
});

/** Standard query key factories for cache invalidation */
export const queryKeys = {
  profile: (userId: string) => ['profile', userId] as const,
  organization: (orgId: string) => ['organization', orgId] as const,
  anchors: (userId: string, orgId?: string | null) => ['anchors', userId, orgId ?? 'none'] as const,
} as const;
