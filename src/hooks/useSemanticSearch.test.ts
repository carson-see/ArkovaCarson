/**
 * useSemanticSearch Hook Tests (P8-S12)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSemanticSearch } from './useSemanticSearch';
import { SEMANTIC_SEARCH_LABELS } from '../lib/copy';

// Mock supabase
vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { access_token: 'test-token' } },
      }),
    },
  },
}));

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('useSemanticSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          query: 'test',
          results: [
            {
              anchorId: 'a1',
              publicId: 'p1',
              fileName: 'diploma.pdf',
              credentialType: 'DEGREE',
              metadata: {},
              status: 'SECURED',
              createdAt: '2025-01-01',
              similarity: 0.9,
            },
          ],
          count: 1,
          threshold: 0.7,
          creditsRemaining: 49,
        }),
    });
  });

  it('starts with empty state', () => {
    const { result } = renderHook(() => useSemanticSearch());

    expect(result.current.results).toEqual([]);
    expect(result.current.isSearching).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.creditsRemaining).toBeNull();
  });

  it('calls worker API with search query', async () => {
    const { result } = renderHook(() => useSemanticSearch());

    await act(async () => {
      await result.current.search('computer science degree');
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/ai/search?q=computer+science+degree'),
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-token' },
      }),
    );
  });

  it('updates results on successful search', async () => {
    const { result } = renderHook(() => useSemanticSearch());

    await act(async () => {
      await result.current.search('test');
    });

    expect(result.current.results).toHaveLength(1);
    expect(result.current.results[0].similarity).toBe(0.9);
    expect(result.current.creditsRemaining).toBe(49);
  });

  it('handles 402 credit exhaustion with friendly copy', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 402,
      json: () => Promise.resolve({ error: 'insufficient_credits' }),
    });

    const { result } = renderHook(() => useSemanticSearch());

    await act(async () => {
      await result.current.search('test');
    });

    expect(result.current.error).toBe(SEMANTIC_SEARCH_LABELS.ERROR_NO_CREDITS);
    expect(result.current.error).toContain('AI credits');
  });

  it('handles 503 service unavailable (flag off / AI down)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: () => Promise.resolve({ error: 'service_unavailable' }),
    });

    const { result } = renderHook(() => useSemanticSearch());

    await act(async () => {
      await result.current.search('test');
    });

    expect(result.current.error).toBe(SEMANTIC_SEARCH_LABELS.ERROR_UNAVAILABLE);
  });

  it('handles a generic non-OK response without leaking the raw body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ message: 'Ensure the worker service is running' }),
    });

    const { result } = renderHook(() => useSemanticSearch());

    await act(async () => {
      await result.current.search('test');
    });

    expect(result.current.error).toBe(SEMANTIC_SEARCH_LABELS.ERROR_GENERIC);
    // Raw engineering copy must not reach the user.
    expect(result.current.error).not.toContain('worker service');
  });

  it('handles a network failure (fetch throws TypeError)', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const { result } = renderHook(() => useSemanticSearch());

    await act(async () => {
      await result.current.search('test');
    });

    expect(result.current.error).toBe(SEMANTIC_SEARCH_LABELS.ERROR_NETWORK);
    expect(result.current.error).toContain('connection');
  });

  it('requires an authenticated session', async () => {
    const supabaseModule = await import('../lib/supabase');
    vi.mocked(supabaseModule.supabase.auth.getSession).mockResolvedValueOnce({
      data: { session: null },
      error: null,
    } as Awaited<ReturnType<typeof supabaseModule.supabase.auth.getSession>>);

    const { result } = renderHook(() => useSemanticSearch());

    await act(async () => {
      await result.current.search('test');
    });

    expect(result.current.error).toBe(SEMANTIC_SEARCH_LABELS.ERROR_AUTH);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('clears results', async () => {
    const { result } = renderHook(() => useSemanticSearch());

    await act(async () => {
      await result.current.search('test');
    });
    expect(result.current.results).toHaveLength(1);

    act(() => {
      result.current.clear();
    });
    expect(result.current.results).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('skips empty queries', async () => {
    const { result } = renderHook(() => useSemanticSearch());

    await act(async () => {
      await result.current.search('');
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });
});
