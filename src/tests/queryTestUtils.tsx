/**
 * Test utilities for React Query integration.
 *
 * Provides a QueryClientProvider wrapper for renderHook/render in tests
 * that use hooks backed by React Query.
 */

import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/** Create a fresh QueryClient for test isolation (no retries, no caching) */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
      },
    },
  });
}

/** Wrapper component for renderHook that provides QueryClientProvider */
export function createQueryWrapper() {
  const qc = createTestQueryClient();
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
}
