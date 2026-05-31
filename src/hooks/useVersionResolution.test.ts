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
globalThis.fetch = mockFetch as unknown as typeof fetch;

const mockItems = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    external_file_id: 'ext-file-1',
    source: 'google_drive',
    fingerprint: 'abc123',
    version_number: 1,
    status: 'pending_review',
    metadata: { filename: 'contract.pdf' },
    detected_at: '2026-05-15T10:00:00Z',
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    external_file_id: 'ext-file-1',
    source: 'google_drive',
    fingerprint: 'def456',
    version_number: 2,
    status: 'pending_review',
    metadata: { filename: 'contract.pdf' },
    detected_at: '2026-05-15T11:00:00Z',
  },
];

const mappedItems = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    external_file_id: 'ext-file-1',
    filename: 'contract.pdf',
    fingerprint: 'abc123',
    created_at: '2026-05-15T10:00:00Z',
    sibling_count: 0,
    source: 'google_drive',
    status: 'pending_review',
    version_number: 1,
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    external_file_id: 'ext-file-1',
    filename: 'contract.pdf',
    fingerprint: 'def456',
    created_at: '2026-05-15T11:00:00Z',
    sibling_count: 0,
    source: 'google_drive',
    status: 'pending_review',
    version_number: 2,
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
      json: async () => ({ versions: mockItems }),
    });

    const { result } = renderHook(() => useVersionResolution());

    await act(async () => {
      await result.current.fetchPending();
    });

    expect(result.current.items).toEqual(mappedItems);
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
      json: async () => ({ versions: mockItems }),
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
      success = await result.current.resolve(
        '11111111-1111-4111-8111-111111111111',
        'approve',
        'Canonical version',
      );
    });

    expect(success).toBe(true);
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0].id).toBe('22222222-2222-4222-8222-222222222222');
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
      success = await result.current.resolve('11111111-1111-4111-8111-111111111111');
    });

    expect(success).toBe(false);
    expect(result.current.error).toBe('Not found');
  });
});
