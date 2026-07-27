/**
 * useFolders Hook (SCRUM-2940)
 *
 * Fetches and mutates the caller's folders from Supabase. RLS (migration 0365)
 * scopes reads/writes:
 *   - INDIVIDUAL users see/own their USER-scoped folders (user_id = auth.uid())
 *   - ORG members see their org's ORG-scoped folders (org_id = get_user_org_id())
 *
 * React Query for cache + optimistic invalidation — NEVER useState arrays for
 * table data (CLAUDE.md §6). The owner scope is derived from the profile:
 * ORG_ADMIN callers create ORG folders; everyone else creates USER folders.
 * This mirrors the ownership split the anchors list already uses.
 */

import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { queryKeys } from '@/lib/queryClient';
import { FOLDER_LABELS } from '@/lib/copy';
import type { Database } from '@/types/database.types';
import { useAuth } from './useAuth';
import { useProfile } from './useProfile';

type FolderRow = Database['public']['Tables']['folders']['Row'];
type FolderInsert = Database['public']['Tables']['folders']['Insert'];

/** UI-facing folder shape (camelCase, only what the browse UI needs). */
export interface Folder {
  id: string;
  name: string;
  ownerScope: 'USER' | 'ORG';
  createdAt: string;
}

function mapFolder(row: Pick<FolderRow, 'id' | 'name' | 'owner_scope' | 'created_at'>): Folder {
  return {
    id: row.id,
    name: row.name,
    ownerScope: row.owner_scope as 'USER' | 'ORG',
    createdAt: row.created_at,
  };
}

/** Whether the caller's folders are org-scoped (ORG_ADMIN with an org). */
function resolveOrgScope(role?: string | null, orgId?: string | null): boolean {
  return role === 'ORG_ADMIN' && !!orgId;
}

async function fetchFolders(): Promise<Folder[]> {
  // RLS returns only folders the caller owns/belongs to — no explicit filter
  // needed, but we order by name for a stable sidebar.
  const { data, error } = await supabase
    .from('folders')
    .select('id, name, owner_scope, created_at')
    .order('name', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(mapFolder);
}

interface UseFoldersReturn {
  folders: Folder[];
  loading: boolean;
  error: string | null;
  createFolder: (name: string) => Promise<void>;
  renameFolder: (id: string, name: string) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
  /** Assign a record to a folder, or pass null to move it back to Unfiled. */
  assignRecord: (anchorId: string, folderId: string | null) => Promise<void>;
}

export function useFolders(): UseFoldersReturn {
  const { user } = useAuth();
  const { profile } = useProfile();
  const qc = useQueryClient();

  const orgScoped = resolveOrgScope(profile?.role, profile?.org_id);

  const key = queryKeys.folders(user?.id ?? '', orgScoped ? profile?.org_id : null);

  const {
    data: folders = [],
    isLoading,
    error: queryError,
  } = useQuery({
    queryKey: key,
    queryFn: fetchFolders,
    enabled: !!user,
  });

  const invalidate = useCallback(() => {
    void qc.invalidateQueries({ queryKey: key });
  }, [qc, key]);

  const createMutation = useMutation({
    mutationFn: async (name: string) => {
      if (!user) throw new Error('not authenticated');
      const trimmed = name.trim();
      // Annotated as the generated Insert type: without it TS widens the
      // ternary to a union of two object literals and PostgREST's
      // RejectExcessProperties<> narrows against only the first arm.
      const row: FolderInsert = orgScoped
        ? { owner_scope: 'ORG', org_id: profile!.org_id, user_id: null, name: trimmed, created_by: user.id }
        : { owner_scope: 'USER', user_id: user.id, org_id: null, name: trimmed, created_by: user.id };
      const { error } = await supabase.from('folders').insert(row);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const renameMutation = useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      const { error } = await supabase.from('folders').update({ name: name.trim() }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      // ON DELETE SET NULL un-files the folder's records (migration 0365).
      const { error } = await supabase.from('folders').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      // Records' folder_id changed → refresh the records list too.
      void qc.invalidateQueries({ queryKey: ['anchors'] });
    },
  });

  const assignMutation = useMutation({
    mutationFn: async ({ anchorId, folderId }: { anchorId: string; folderId: string | null }) => {
      const { error } = await supabase.from('anchors').update({ folder_id: folderId }).eq('id', anchorId);
      if (error) throw error;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['anchors'] });
    },
  });

  return {
    folders,
    loading: isLoading,
    error: queryError ? (queryError as Error).message || FOLDER_LABELS.ERR_CREATE : null,
    createFolder: (name) => createMutation.mutateAsync(name),
    renameFolder: (id, name) => renameMutation.mutateAsync({ id, name }),
    deleteFolder: (id) => deleteMutation.mutateAsync(id),
    assignRecord: (anchorId, folderId) => assignMutation.mutateAsync({ anchorId, folderId }),
  };
}
