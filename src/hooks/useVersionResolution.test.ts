/**
 * useVersionResolution Hook Tests (SCRUM-1126)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVersionResolution } from './useVersionResolution';

vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { access_token: 'test-token' } },
      }),
    },
  },
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

const mockItems = [
  {
    public_id: 'pub-1',
    external_file_id: 'ext-file-1',
    filename: 'contract.pdf',
    fingerprint: 'abc123',
    created_at: '2026-05-15T10:00:00Z',
    sibling_count: 3,
  },
  {
    public_id: 'pub-2',
    external_file_id: 'ext-file-1',
    filename: 'contract.pdf',
    fingerprint: 'def456',
    created_at: '2026-05-15T11:00:00Z',
    sibling_count: 3,
  },
];

describe('useVersionResolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts with empty state', () => {
    const { result } = renderHook(() => useVersionResolution());
    expect(result.current.items).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('fetches pending conflicts successfully', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: mockItems }),
    });

    const { result } = renderHook(() => useVersionResolution());

    await act(async () => {
      await result.current.fetchPending();
    });

    expect(result.current.items).toEqual(mockItems);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('handles fetch error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: { message: 'Internal server error' } }),
    });

    const { result } = renderHook(() => useVersionResolution());

    await act(async () => {
      await result.current.fetchPending();
    });

    expect(result.current.items).toEqual([]);
    expect(result.current.error).toBe('Internal server error');
  });

  it('resolves a conflict and removes items from local state', async () => {
    // First fetch items
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: mockItems }),
    });

    const { result } = renderHook(() => useVersionResolution());

    await act(async () => {
      await result.current.fetchPending();
    });

    expect(result.current.items).toHaveLength(2);

    // Now resolve
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });

    let success: boolean | undefined;
    await act(async () => {
      success = await result.current.resolve('ext-file-1', 'pub-1', 'Canonical version');
    });

    expect(success).toBe(true);
    expect(result.current.items).toHaveLength(0);
  });

  it('handles resolve error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Not found' }),
    });

    const { result } = renderHook(() => useVersionResolution());

    let success: boolean | undefined;
    await act(async () => {
      success = await result.current.resolve('ext-file-1', 'pub-1');
    });

    expect(success).toBe(false);
    expect(result.current.error).toBe('Not found');
  });
});
