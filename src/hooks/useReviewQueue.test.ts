/**
 * useReviewQueue Hook Tests (P8-S9 / AUDIT-12)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useReviewQueue } from './useReviewQueue';

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

const mockItem = {
  id: 'rq1',
  anchorId: 'a1',
  orgId: 'org1',
  status: 'PENDING' as const,
  priority: 5,
  reason: 'Low integrity score',
  flags: ['low_confidence'],
  assignedTo: null,
  reviewedBy: null,
  reviewedAt: null,
  reviewNotes: null,
  reviewAction: null,
  createdAt: '2026-03-17T00:00:00Z',
  updatedAt: '2026-03-17T00:00:00Z',
};

describe('useReviewQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts with empty state', () => {
    const { result } = renderHook(() => useReviewQueue());
    expect(result.current.items).toEqual([]);
    expect(result.current.stats).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.acting).toBe(false);
  });

  it('fetches review queue items', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ items: [mockItem] }),
    });

    const { result } = renderHook(() => useReviewQueue());

    await act(async () => {
      await result.current.fetchItems();
    });

    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0].status).toBe('PENDING');
  });

  it('fetches review queue stats', async () => {
    const stats = { total: 10, pending: 5, investigating: 2, escalated: 1, approved: 1, dismissed: 1 };
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(stats),
    });

    const { result } = renderHook(() => useReviewQueue());

    await act(async () => {
      await result.current.fetchStats();
    });

    expect(result.current.stats?.total).toBe(10);
    expect(result.current.stats?.pending).toBe(5);
  });

  it('applies APPROVE action and updates local state', async () => {
    // First fetch items
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ items: [mockItem] }),
    });

    const { result } = renderHook(() => useReviewQueue());

    await act(async () => {
      await result.current.fetchItems();
    });

    // Then approve
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true }) });

    await act(async () => {
      const success = await result.current.applyAction('rq1', 'APPROVE', 'Looks good');
      expect(success).toBe(true);
    });

    expect(result.current.items[0].status).toBe('APPROVED');
    expect(result.current.items[0].reviewAction).toBe('APPROVE');
  });

  it('throws on failed action', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'Internal error' }),
    });

    const { result } = renderHook(() => useReviewQueue());

    await expect(
      act(async () => {
        await result.current.applyAction('rq1', 'DISMISS');
      }),
    ).rejects.toThrow('Internal error');
  });
});
