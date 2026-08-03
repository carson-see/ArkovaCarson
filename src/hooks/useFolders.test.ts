/* eslint-disable arkova/no-unscoped-service-test -- Frontend: RLS enforced server-side by Supabase JWT, not manual query scoping */
/**
 * useFolders Hook Tests
 *
 * @see SCRUM-2940 (folders data layer) + founder-priority bug fix (migration
 * 0393): an ORG_ADMIN's "Move to folder" on a record they can SEE but did not
 * personally create (useAnchors gives ORG_ADMIN the whole org's list) used to
 * silently no-op — anchors_update_own's RLS `USING` clause matched zero rows,
 * PostgREST returned `{ error: null }` for the zero-row UPDATE, and
 * `assignRecord` only checked `error`, never a row count. The caller (
 * MyRecordsPage.handleMoveSelect) then showed a false "Record moved" toast.
 * `assignRecord` now mirrors `useSecureQueue.removeItem`'s established
 * pattern: `.select('id')` after the update, throw if zero rows came back.
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
function createSelectChain(result: { data: any[] | null; error: unknown }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    select: vi.fn(() => chain),
    order: vi.fn(() => Promise.resolve(result)),
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

import { useFolders } from './useFolders';

describe('useFolders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProfile.current = { role: 'INDIVIDUAL', org_id: null };
  });

  it('assignRecord succeeds when the update actually affects a row', async () => {
    const listChain = createSelectChain({ data: [], error: null });
    const updateChain = createUpdateChain({ data: [{ id: 'anchor-1' }], error: null });
    mockFrom.mockReturnValue({ select: () => listChain, update: vi.fn(() => updateChain) });

    const { result } = renderHook(() => useFolders(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await expect(result.current.assignRecord('anchor-1', 'folder-1')).resolves.toBeUndefined();
    expect(updateChain.eq).toHaveBeenCalledWith('id', 'anchor-1');
  });

  it('assignRecord throws when RLS silently blocks the update (zero rows returned) instead of pretending it worked', async () => {
    // This is the founder-priority bug: an ORG_ADMIN moving a teammate-owned
    // record that anchors_update_own's RLS USING clause does not match.
    // PostgREST returns { error: null, data: [] } for the zero-row UPDATE --
    // the pre-fix hook resolved successfully here and the caller toasted a
    // false "Record moved".
    const listChain = createSelectChain({ data: [], error: null });
    const updateChain = createUpdateChain({ data: [], error: null });
    mockFrom.mockReturnValue({ select: () => listChain, update: vi.fn(() => updateChain) });

    mockProfile.current = { role: 'ORG_ADMIN', org_id: 'org-1' };
    const { result } = renderHook(() => useFolders(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await expect(result.current.assignRecord('someone-elses-anchor', 'folder-1')).rejects.toThrow();
  });

  it('assignRecord(id, null) un-files a record and still checks for zero rows', async () => {
    const listChain = createSelectChain({ data: [], error: null });
    const updateChain = createUpdateChain({ data: [], error: null });
    mockFrom.mockReturnValue({ select: () => listChain, update: vi.fn(() => updateChain) });

    const { result } = renderHook(() => useFolders(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await expect(result.current.assignRecord('anchor-1', null)).rejects.toThrow();
    expect(updateChain.eq).toHaveBeenCalledWith('id', 'anchor-1');
  });

  it('assignRecord surfaces a real Postgres error unchanged', async () => {
    const listChain = createSelectChain({ data: [], error: null });
    const updateChain = createUpdateChain({ data: null, error: { message: 'constraint violation' } });
    mockFrom.mockReturnValue({ select: () => listChain, update: vi.fn(() => updateChain) });

    const { result } = renderHook(() => useFolders(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await expect(result.current.assignRecord('anchor-1', 'folder-1')).rejects.toThrow('constraint violation');
  });
});
