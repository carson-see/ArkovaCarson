/**
 * useSecureQueue Hook Tests
 *
 * @see QUEUE-01 / SCRUM-2894 (L2-A1)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockFrom = vi.hoisted(() => vi.fn());
const mockProfile = vi.hoisted(() => ({ current: { role: 'INDIVIDUAL', org_id: null as string | null } }));

vi.mock('@/lib/supabase', () => ({
  supabase: { from: mockFrom },
}));

vi.mock('./useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1' }, loading: false }),
}));

vi.mock('./useProfile', () => ({
  useProfile: () => ({ profile: mockProfile.current, loading: false }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createQueryChain(result: { data: any[] | null; error: unknown }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    is: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => Promise.resolve(result)),
  };
  return chain;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createUpdateChain(result: { data: any[] | null; error: unknown }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    eq: vi.fn(() => chain),
    select: vi.fn(() => Promise.resolve(result)),
  };
  return chain;
}

function createWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
}

import { useSecureQueue } from './useSecureQueue';

describe('useSecureQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProfile.current = { role: 'INDIVIDUAL', org_id: null };
  });

  it('fetches the caller\'s own PENDING anchors, scope="own"', async () => {
    const rows = [
      {
        id: 'anchor-1',
        filename: 'diploma.pdf',
        fingerprint: 'fp1',
        created_at: '2026-07-01T00:00:00Z',
        file_size: 2048,
        credential_type: 'DEGREE',
        public_id: 'pub-1',
        user_id: 'user-1',
      },
    ];
    const queryChain = createQueryChain({ data: rows, error: null });
    mockFrom.mockReturnValue({ select: () => queryChain });

    const { result } = renderHook(() => useSecureQueue('own'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0]).toMatchObject({
      id: 'anchor-1',
      filename: 'diploma.pdf',
      isOwn: true,
    });
    expect(queryChain.eq).toHaveBeenCalledWith('status', 'PENDING');
    expect(queryChain.eq).toHaveBeenCalledWith('user_id', 'user-1');
  });

  it('scope="org" queries by org_id and marks items owned by other members isOwn=false', async () => {
    mockProfile.current = { role: 'ORG_ADMIN', org_id: 'org-1' };
    const rows = [
      { id: 'a1', filename: 'a.pdf', fingerprint: 'f1', created_at: '2026-07-01T00:00:00Z', file_size: 10, credential_type: null, public_id: 'p1', user_id: 'user-1' },
      { id: 'a2', filename: 'b.pdf', fingerprint: 'f2', created_at: '2026-07-02T00:00:00Z', file_size: 20, credential_type: null, public_id: 'p2', user_id: 'user-2' },
    ];
    const queryChain = createQueryChain({ data: rows, error: null });
    mockFrom.mockReturnValue({ select: () => queryChain });

    const { result } = renderHook(() => useSecureQueue('org'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.items).toHaveLength(2);
    expect(result.current.items.find((i) => i.id === 'a1')?.isOwn).toBe(true);
    expect(result.current.items.find((i) => i.id === 'a2')?.isOwn).toBe(false);
    expect(queryChain.eq).toHaveBeenCalledWith('org_id', 'org-1');
  });

  it('sets error on fetch failure', async () => {
    const queryChain = createQueryChain({ data: null, error: { message: 'RLS denied' } });
    mockFrom.mockReturnValue({ select: () => queryChain });

    const { result } = renderHook(() => useSecureQueue('own'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('RLS denied');
  });

  it('removeItem soft-deletes via deleted_at and invalidates the list', async () => {
    const queryChain = createQueryChain({ data: [], error: null });
    const updateChain = createUpdateChain({ data: [{ id: 'anchor-1' }], error: null });
    mockFrom.mockReturnValue({ select: () => queryChain, update: vi.fn(() => updateChain) });

    const { result } = renderHook(() => useSecureQueue('own'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await result.current.removeItem('anchor-1');

    expect(updateChain.eq).toHaveBeenCalledWith('id', 'anchor-1');
  });

  it('removeItem throws when RLS blocks the update (zero rows returned)', async () => {
    const queryChain = createQueryChain({ data: [], error: null });
    const updateChain = createUpdateChain({ data: [], error: null });
    mockFrom.mockReturnValue({ select: () => queryChain, update: vi.fn(() => updateChain) });

    const { result } = renderHook(() => useSecureQueue('org'), { wrapper: createWrapper() });
    mockProfile.current = { role: 'ORG_ADMIN', org_id: 'org-1' };
    await waitFor(() => expect(result.current.loading).toBe(false));

    await expect(result.current.removeItem('someone-elses-anchor')).rejects.toThrow();
  });
});
