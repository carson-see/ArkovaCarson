/* eslint-disable arkova/no-unscoped-service-test -- Frontend: RLS enforced server-side by Supabase JWT, not manual query scoping */
/**
 * useAnchor Hook Tests
 *
 * @see P4-TS-03
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const mockFrom = vi.hoisted(() => vi.fn());
const mockGetSession = vi.hoisted(() => vi.fn());

const mockSubscribe = vi.hoisted(() => vi.fn());
const mockChannel = vi.hoisted(() =>
  vi.fn(() => ({
    on: vi.fn().mockReturnThis(),
    subscribe: mockSubscribe.mockReturnThis(),
  })),
);

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: mockFrom,
    channel: mockChannel,
    removeChannel: vi.fn(),
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

  // BUG-2026-08-13-017: the reset branch used to set loading=false while auth
  // was still resolving, exposing one committed frame of (loading=false,
  // anchor=null, error=null) — the exact state RecordDetailPage renders as
  // "Record Not Found". Record every render frame and prove that settled-empty
  // state is never presented for a record that loads successfully.
  it('never exposes a settled empty state before the fetch settles (BUG-2026-08-13-017)', async () => {
    let resolveSession!: (value: unknown) => void;
    mockGetSession.mockReturnValue(
      new Promise((r) => {
        resolveSession = r;
      }),
    );

    const mockAnchor = { id: 'anchor-1', filename: 'owned.pdf', status: 'SECURED' };
    let resolveFetch!: (value: unknown) => void;
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          is: vi.fn().mockReturnValue({
            single: vi.fn().mockReturnValue(
              new Promise((r) => {
                resolveFetch = r;
              }),
            ),
          }),
        }),
      }),
    });

    const { useAnchor } = await import('./useAnchor');
    const frames: { loading: boolean; anchor: unknown; error: string | null }[] = [];
    const { result } = renderHook(() => {
      const state = useAnchor('anchor-1');
      frames.push({ loading: state.loading, anchor: state.anchor, error: state.error });
      return state;
    });

    // Auth settles AFTER mount (the live page's 783ms moment); the anchor
    // query is still in flight.
    await act(async () => {
      resolveSession({
        data: { session: { user: { id: 'user-1', email: 'owner@test.dev' } } },
        error: null,
      });
    });

    // Query settles with the owned record.
    await act(async () => {
      resolveFetch({ data: mockAnchor, error: null });
    });
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.anchor).toEqual(mockAnchor);

    // THE assertion: no rendered frame ever claimed "settled and empty".
    // (loading=false ∧ anchor=null ∧ error=null) is the not-found trigger —
    // it must be unreachable for a record that ultimately loads.
    const settledEmptyFrames = frames.filter((f) => !f.loading && f.anchor === null && f.error === null);
    expect(settledEmptyFrames).toEqual([]);
  });
});
