/**
 * useSemanticSearch Hook Tests (P8-S12)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSemanticSearch } from './useSemanticSearch';

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

  it('handles 402 credit exhaustion', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 402,
      json: () => Promise.resolve({ error: 'insufficient_credits' }),
    });

    const { result } = renderHook(() => useSemanticSearch());

    await act(async () => {
      await result.current.search('test');
    });

    expect(result.current.error).toContain('credits');
  });

  it('handles 503 feature disabled', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: () => Promise.resolve({ error: 'service_unavailable' }),
    });

    const { result } = renderHook(() => useSemanticSearch());

    await act(async () => {
      await result.current.search('test');
    });

    expect(result.current.error).toContain('not currently enabled');
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
