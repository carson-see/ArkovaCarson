/** Canonical nested-folder client for SCRUM-5142. */
import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryClient';
import { FOLDER_LABELS } from '@/lib/copy';
import { workerFetch } from '@/lib/workerClient';
import { useAuth } from './useAuth';
import { useProfile } from './useProfile';

export interface Folder {
  id: string;
  publicId?: string;
  name: string;
  ownerScope: 'USER' | 'ORG';
  contextOrgId?: string | null;
  parentFolderId?: string | null;
  connectorProvider?: 'google_drive' | 'docusign' | null;
  createdAt: string;
}

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

async function fetchFolders(orgId: string | null): Promise<Folder[]> {
  const paths = ['/api/v1/folders?owner_scope=USER'];
  if (orgId) {
    paths.push(`/api/v1/folders?owner_scope=USER&context_org_id=${encodeURIComponent(orgId)}`);
    paths.push(`/api/v1/folders?owner_scope=ORG&org_id=${encodeURIComponent(orgId)}`);
  }
  const bodies = await Promise.all(paths.map(async (path) =>
    readJson<{ folders: ApiFolder[] }>(await workerFetch(path))));
  return bodies.flatMap((body) => body.folders.map(mapFolder));
}

interface CreateFolderOptions { ownerScope?: 'USER' | 'ORG'; parentFolderId?: string | null }

interface UseFoldersReturn {
  folders: Folder[];
  loading: boolean;
  error: string | null;
  createFolder: (name: string, options?: CreateFolderOptions) => Promise<void>;
  renameFolder: (id: string, name: string) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
  assignRecord: (anchorId: string, folderId: string | null) => Promise<void>;
  assignRecords: (anchorIds: string[], folderId: string | null) => Promise<{ moved: string[]; failed: Array<{ anchor_id: string; code: string }> }>;
}

export function useFolders(): UseFoldersReturn {
  const { user } = useAuth();
  const { profile } = useProfile();
  const qc = useQueryClient();
  const orgId = profile?.org_id ?? null;
  const key = queryKeys.folders(user?.id ?? '', orgId);
  const { data: folders = [], isLoading, error: queryError } = useQuery({
    queryKey: key, queryFn: () => fetchFolders(orgId), enabled: !!user,
  });
  const invalidate = useCallback(() => { void qc.invalidateQueries({ queryKey: key }); }, [qc, key]);

  const createMutation = useMutation({
    mutationFn: async ({ name, options }: { name: string; options?: CreateFolderOptions }) => {
      const ownerScope = options?.ownerScope ?? 'USER';
      const response = await workerFetch('/api/v1/folders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(), owner_scope: ownerScope,
          ...(ownerScope === 'ORG' ? { org_id: orgId } : { context_org_id: orgId }),
          parent_folder_id: options?.parentFolderId ?? null,
        }),
      });
      await readJson(response);
    }, onSuccess: invalidate,
  });
  const renameMutation = useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      await readJson(await workerFetch(`/api/v1/folders/${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }),
      }));
    }, onSuccess: invalidate,
  });
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const response = await workerFetch(`/api/v1/folders/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!response.ok) await readJson(response);
    }, onSuccess: () => { invalidate(); void qc.invalidateQueries({ queryKey: ['anchors'] }); },
  });
  const assignMutation = useMutation({
    mutationFn: async ({ anchorIds, folderId }: { anchorIds: string[]; folderId: string | null }) =>
      readJson<{ moved: string[]; failed: Array<{ anchor_id: string; code: string }> }>(
        await workerFetch('/api/v1/folders/bulk-move', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ anchor_ids: anchorIds, folder_id: folderId }),
        }),
      ),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['anchors'] }); },
  });

  async function assignRecords(anchorIds: string[], folderId: string | null) {
    const result = await assignMutation.mutateAsync({ anchorIds, folderId });
    if (result.failed.length === anchorIds.length) throw new Error(FOLDER_LABELS.ERR_ASSIGN);
    return result;
  }
  return {
    folders, loading: isLoading,
    error: queryError ? (queryError as Error).message || FOLDER_LABELS.ERR_CREATE : null,
    createFolder: (name, options) => createMutation.mutateAsync({ name, options }),
    renameFolder: (id, name) => renameMutation.mutateAsync({ id, name }),
    deleteFolder: (id) => deleteMutation.mutateAsync(id),
    assignRecord: async (anchorId, folderId) => { await assignRecords([anchorId], folderId); },
    assignRecords,
  };
}
