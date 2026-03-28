/**
 * useAnchors Hook Tests
 *
 * Tests anchor fetching, mapping, error handling, and refresh.
 *
 * @see P3-TS-01
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const mockFrom = vi.hoisted(() => vi.fn());
const mockGetSession = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: mockFrom,
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnThis(),
    })),
    removeChannel: vi.fn(),
    auth: {
      getSession: mockGetSession,
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      })),
    },
  },
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

describe('useAnchors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockGetSession.mockResolvedValue({
      data: { session: { user: { id: 'user-1', email: 'test@test.com' } } },
      error: null,
    });
  });

  it('returns empty records when user is not authenticated', async () => {
    mockGetSession.mockResolvedValue({
      data: { session: null },
      error: null,
    });

    const { useAnchors } = await import('./useAnchors');
    const { result } = renderHook(() => useAnchors());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.records).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('fetches and maps anchors from Supabase', async () => {
    const mockAnchors = [
      {
        id: 'anchor-1',
        filename: 'test.pdf',
        fingerprint: 'abc123',
        status: 'SECURED',
        created_at: '2026-03-01T00:00:00Z',
        chain_timestamp: '2026-03-01T01:00:00Z',
        file_size: 1024,
        credential_type: 'DIPLOMA',
      },
    ];

    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        is: vi.fn().mockReturnValue({
          or: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({ data: mockAnchors, error: null }),
            }),
          }),
        }),
      }),
    });

    const { useAnchors } = await import('./useAnchors');
    const { result } = renderHook(() => useAnchors());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.records).toHaveLength(1);
    expect(result.current.records[0]).toMatchObject({
      id: 'anchor-1',
      filename: 'test.pdf',
      fingerprint: 'abc123',
      status: 'SECURED',
      createdAt: '2026-03-01T00:00:00Z',
      securedAt: '2026-03-01T01:00:00Z',
      fileSize: 1024,
      credentialType: 'DIPLOMA',
    });
  });

  it('sets error when fetch fails', async () => {
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        is: vi.fn().mockReturnValue({
          or: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({
                data: null,
                error: { message: 'RLS policy violation' },
              }),
            }),
          }),
        }),
      }),
    });

    const { useAnchors } = await import('./useAnchors');
    const { result } = renderHook(() => useAnchors());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('RLS policy violation');
    expect(result.current.records).toEqual([]);
  });

  it('maps null chain_timestamp to undefined securedAt', async () => {
    const mockAnchors = [
      {
        id: 'anchor-2',
        filename: 'pending.pdf',
        fingerprint: 'def456',
        status: 'PENDING',
        created_at: '2026-03-01T00:00:00Z',
        chain_timestamp: null,
        file_size: null,
        credential_type: null,
      },
    ];

    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        is: vi.fn().mockReturnValue({
          or: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({ data: mockAnchors, error: null }),
            }),
          }),
        }),
      }),
    });

    const { useAnchors } = await import('./useAnchors');
    const { result } = renderHook(() => useAnchors());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.records[0].securedAt).toBeUndefined();
    expect(result.current.records[0].fileSize).toBe(0);
    expect(result.current.records[0].credentialType).toBeUndefined();
  });
});
