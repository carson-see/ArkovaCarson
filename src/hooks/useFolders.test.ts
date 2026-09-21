/** SCRUM-5142 worker-backed canonical folder hook tests. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const workerFetch = vi.hoisted(() => vi.fn());
const mockProfile = vi.hoisted(() => ({ current: { role: 'INDIVIDUAL', org_id: null as string | null } }));

vi.mock('@/lib/workerClient', () => ({ workerFetch }));
vi.mock('./useAuth', () => ({ useAuth: () => ({ user: { id: 'user-1' }, loading: false }) }));
vi.mock('./useProfile', () => ({ useProfile: () => ({ profile: mockProfile.current, loading: false }) }));

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function createWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
}

import { useFolders } from './useFolders';

describe('useFolders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProfile.current = { role: 'INDIVIDUAL', org_id: null };
    workerFetch.mockResolvedValue(response({ folders: [] }));
  });

  it('loads the caller global personal folders through the authenticated worker API', async () => {
    workerFetch.mockResolvedValueOnce(response({ folders: [{
      id: 'folder-1', public_id: 'FLD-1', name: 'Legal', owner_scope: 'USER',
      context_org_id: null, parent_folder_id: null, connector_provider: null,
      created_at: '2026-09-14T00:00:00Z',
    }] }));
    const { result } = renderHook(() => useFolders(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(workerFetch).toHaveBeenCalledWith('/api/v1/folders?owner_scope=USER');
    expect(result.current.folders[0]).toMatchObject({ id: 'folder-1', name: 'Legal' });
  });

  it('loads personal global, personal context, and organization folders for an org member', async () => {
    mockProfile.current = { role: 'ORG_ADMIN', org_id: 'org-1' };
    const { result } = renderHook(() => useFolders(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(workerFetch.mock.calls.map(([path]) => path)).toEqual(expect.arrayContaining([
      '/api/v1/folders?owner_scope=USER',
      '/api/v1/folders?owner_scope=USER&context_org_id=org-1',
      '/api/v1/folders?owner_scope=ORG&org_id=org-1',
    ]));
  });

  it('assignRecord sends the canonical one-item bulk move', async () => {
    workerFetch.mockImplementation(async (path: string) => path.endsWith('/bulk-move')
      ? response({ moved: ['anchor-1'], failed: [] }) : response({ folders: [] }));
    const { result } = renderHook(() => useFolders(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await expect(result.current.assignRecord('anchor-1', 'folder-1')).resolves.toBeUndefined();
    const [, init] = workerFetch.mock.calls.find(([path]) => path.endsWith('/bulk-move'))!;
    expect(JSON.parse(init.body)).toEqual({ anchor_ids: ['anchor-1'], folder_id: 'folder-1' });
  });

  it('throws when every item in a bulk move is denied', async () => {
    workerFetch.mockImplementation(async (path: string) => path.endsWith('/bulk-move')
      ? response({ moved: [], failed: [{ anchor_id: 'anchor-1', code: 'not_authorized_or_not_found' }] }, 207)
      : response({ folders: [] }));
    const { result } = renderHook(() => useFolders(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await expect(result.current.assignRecord('anchor-1', null)).rejects.toThrow();
  });

  it('surfaces a stable API error', async () => {
    workerFetch.mockImplementation(async (path: string) => path.endsWith('/bulk-move')
      ? response({ error: 'folder_forbidden' }, 403) : response({ folders: [] }));
    const { result } = renderHook(() => useFolders(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await expect(result.current.assignRecord('anchor-1', 'folder-1')).rejects.toThrow('folder_forbidden');
  });
});
