import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { workerFetch } from '@/lib/workerClient';
import type { Folder } from './useFolders';

interface ApiFolder {
  id: string; public_id: string; name: string; owner_scope: 'USER' | 'ORG';
  context_org_id: string | null; parent_folder_id: string | null;
  connector_provider: 'google_drive' | 'docusign' | null; created_at: string;
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((body as { error?: string }).error ?? `Folder request failed (${response.status})`);
  return body as T;
}

function mapFolder(row: ApiFolder): Folder {
  return {
    id: row.id, publicId: row.public_id, name: row.name, ownerScope: row.owner_scope,
    contextOrgId: row.context_org_id, parentFolderId: row.parent_folder_id,
    connectorProvider: row.connector_provider, createdAt: row.created_at,
  };
}

export function descendantFolderIds(folders: Folder[], selectedId: string): string[] {
  const result: string[] = [];
  const pending = [selectedId];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const id = pending.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    for (const folder of folders) if (folder.parentFolderId === id) pending.push(folder.id);
  }
  return result;
}

export function useOrgProfileFolders(
  orgId: string | null,
  callerId: string | null,
  authorized: boolean,
  canManage: boolean,
) {
  const qc = useQueryClient();
  const key = useMemo(
    () => ['org-profile-folders', callerId, orgId, authorized, canManage] as const,
    [authorized, callerId, canManage, orgId],
  );
  const query = useQuery({
    queryKey: key,
    enabled: authorized && !!orgId,
    queryFn: async () => {
      const body = await readJson<{ folders: ApiFolder[] }>(await workerFetch(
        `/api/v1/folders?owner_scope=ORG&org_id=${encodeURIComponent(orgId!)}`,
      ));
      return body.folders.map(mapFolder);
    },
  });
  const invalidate = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: key });
  }, [key, qc]);
  const requireManager = () => {
    if (!canManage) throw new Error('Organization administrator access is required');
  };
  const create = useMutation({ mutationFn: async ({ name, parentFolderId }: { name: string; parentFolderId: string | null }) => {
    requireManager();
    await readJson(await workerFetch('/api/v1/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim(), owner_scope: 'ORG', org_id: orgId, parent_folder_id: parentFolderId }) }));
  }, onSuccess: invalidate });
  const rename = useMutation({ mutationFn: async ({ id, name }: { id: string; name: string }) => {
    requireManager();
    await readJson(await workerFetch(`/api/v1/folders/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) }));
  }, onSuccess: invalidate });
  const remove = useMutation({ mutationFn: async (id: string) => {
    requireManager();
    const response = await workerFetch(`/api/v1/folders/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!response.ok) await readJson(response);
  }, onSuccess: invalidate });
  const move = useMutation({ mutationFn: async ({ anchorIds, folderId }: { anchorIds: string[]; folderId: string | null }) => {
    requireManager();
    return readJson<{ moved: string[]; failed: Array<{ anchor_id: string; code: string }> }>(await workerFetch('/api/v1/folders/bulk-move', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ anchor_ids: anchorIds, folder_id: folderId }) }));
  } });
  return {
    folders: authorized ? query.data ?? [] : [], loading: authorized && query.isLoading, error: authorized ? query.error : null,
    createFolder: (name: string, parentFolderId: string | null) => create.mutateAsync({ name, parentFolderId }),
    renameFolder: (id: string, name: string) => rename.mutateAsync({ id, name }),
    deleteFolder: (id: string) => remove.mutateAsync(id),
    moveRecords: (anchorIds: string[], folderId: string | null) => move.mutateAsync({ anchorIds, folderId }),
  };
}
