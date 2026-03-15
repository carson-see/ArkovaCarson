/**
 * useAnchor Hook Tests
 *
 * @see P4-TS-03
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const mockSelect = vi.hoisted(() => vi.fn());
const mockFrom = vi.hoisted(() => vi.fn());
const mockGetSession = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: mockFrom,
    auth: {
      getSession: mockGetSession,
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
  },
}));

describe('useAnchor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({
      data: { session: { user: { id: 'user-1', email: 'test@test.com' } } },
      error: null,
    });
  });

  it('returns null anchor and stops loading when no id provided', async () => {
    const { useAnchor } = await import('./useAnchor');
    const { result } = renderHook(() => useAnchor(undefined));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.anchor).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('fetches anchor by id from Supabase', async () => {
    const mockAnchor = { id: 'anchor-1', filename: 'test.pdf', status: 'PENDING' };

    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          is: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: mockAnchor, error: null }),
          }),
        }),
      }),
    });

    const { useAnchor } = await import('./useAnchor');
    const { result } = renderHook(() => useAnchor('anchor-1'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.anchor).toEqual(mockAnchor);
    expect(result.current.error).toBeNull();
  });

  it('sets "Record not found" error for PGRST116 code', async () => {
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          is: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: null,
              error: { code: 'PGRST116', message: 'Row not found' },
            }),
          }),
        }),
      }),
    });

    const { useAnchor } = await import('./useAnchor');
    const { result } = renderHook(() => useAnchor('bad-id'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.anchor).toBeNull();
    expect(result.current.error).toBe('Record not found');
  });

  it('sets raw error message for non-PGRST116 errors', async () => {
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          is: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: null,
              error: { code: 'OTHER', message: 'Something went wrong' },
            }),
          }),
        }),
      }),
    });

    const { useAnchor } = await import('./useAnchor');
    const { result } = renderHook(() => useAnchor('anchor-1'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('Something went wrong');
  });
});
