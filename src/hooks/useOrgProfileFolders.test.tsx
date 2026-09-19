import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { descendantFolderIds, useOrgProfileFolders } from './useOrgProfileFolders';
import type { Folder } from './useFolders';

const workerFetchMock = vi.fn();
vi.mock('@/lib/workerClient', () => ({ workerFetch: (...args: unknown[]) => workerFetchMock(...args) }));

const folder = (id: string, parentFolderId: string | null): Folder => ({
  id, name: id, ownerScope: 'ORG', parentFolderId, createdAt: '2026-09-19T00:00:00Z',
});

describe('descendantFolderIds', () => {
  it('includes the selected folder and every nested descendant, never siblings', () => {
    expect(descendantFolderIds([
      folder('root', null), folder('child', 'root'), folder('grandchild', 'child'),
      folder('sibling', null),
    ], 'root')).toEqual(['root', 'child', 'grandchild']);
  });

  it('terminates safely if malformed input contains a cycle', () => {
    expect(descendantFolderIds([folder('a', 'b'), folder('b', 'a')], 'a')).toEqual(['a', 'b']);
  });
});

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useOrgProfileFolders exact route scope', () => {
  beforeEach(() => workerFetchMock.mockReset());

  it('does not read folders before route authorization resolves', async () => {
    renderHook(() => useOrgProfileFolders('11111111-1111-4111-8111-111111111111', 'caller-a', false, false), { wrapper });
    await Promise.resolve();
    expect(workerFetchMock).not.toHaveBeenCalled();
  });

  it('reads only the explicit route organization', async () => {
    workerFetchMock.mockResolvedValue(new Response(JSON.stringify({ folders: [] }), { status: 200 }));
    const orgId = '22222222-2222-4222-8222-222222222222';
    renderHook(() => useOrgProfileFolders(orgId, 'caller-a', true, false), { wrapper });
    await waitFor(() => expect(workerFetchMock).toHaveBeenCalled());
    expect(workerFetchMock).toHaveBeenCalledWith(`/api/v1/folders?owner_scope=ORG&org_id=${orgId}`);
  });

  it('hides previously loaded folders when route authorization is revoked', async () => {
    workerFetchMock.mockResolvedValue(new Response(JSON.stringify({ folders: [{
      id: 'folder-a', public_id: 'F-A', name: 'Restricted', owner_scope: 'ORG',
      context_org_id: '22222222-2222-4222-8222-222222222222', parent_folder_id: null,
      connector_provider: null, created_at: '2026-09-19T00:00:00Z',
    }] }), { status: 200 }));
    const { result, rerender } = renderHook(
      ({ authorized }) => useOrgProfileFolders('22222222-2222-4222-8222-222222222222', 'caller-a', authorized, false),
      { wrapper, initialProps: { authorized: true } },
    );
    await waitFor(() => expect(result.current.folders).toHaveLength(1));
    rerender({ authorized: false });
    expect(result.current.folders).toEqual([]);
  });

  it('blocks member mutations before any worker request', async () => {
    const { result } = renderHook(
      () => useOrgProfileFolders('33333333-3333-4333-8333-333333333333', 'caller-a', false, false),
      { wrapper },
    );
    await expect(act(() => result.current.createFolder('Denied', null))).rejects.toThrow(
      'Organization administrator access is required',
    );
    expect(workerFetchMock).not.toHaveBeenCalled();
  });
});
