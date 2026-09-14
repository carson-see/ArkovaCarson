/** Production data adapter for the UAT-24 folder router. */
import { db as defaultDb } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { dispatchWebhookEvent } from '../../webhooks/delivery.js';
import {
  createFoldersRouter,
  type BulkMoveResult,
  type FolderActor,
  type FolderApiDeps,
  type FolderRow,
  remapPublicIdMoveResult,
} from './folders.js';

type DbLike = typeof defaultDb;
type RawMoveResult = {
  moved?: string[]; failed?: BulkMoveResult['failed']; event_org_id?: string; folder_public_id?: string;
};

async function userIsExactAdmin(db: DbLike, userId: string, orgId: string): Promise<boolean> {
  const { data, error } = await db.from('org_members')
    .select('user_id').eq('user_id', userId).eq('org_id', orgId)
    .in('role', ['owner', 'admin']).maybeSingle();
  if (error) throw new Error('folder_authority_lookup_failed');
  return !!data;
}

async function userCanReadOrg(db: DbLike, userId: string, targetOrgId: string): Promise<boolean> {
  const { data: membership, error: memberError } = await db.from('org_members')
    .select('user_id').eq('user_id', userId).eq('org_id', targetOrgId).limit(1).maybeSingle();
  if (memberError) throw new Error('folder_authority_lookup_failed');
  if (membership) return true;

  let cursor: string | null = targetOrgId;
  for (let depth = 0; depth <= 3 && cursor; depth += 1) {
    if (await userIsExactAdmin(db, userId, cursor)) return true;
    const { data: orgData, error } = await db.from('organizations')
      .select('parent_org_id, parent_approval_status').eq('id', cursor).maybeSingle();
    const org = orgData as { parent_org_id: string | null; parent_approval_status: string | null } | null;
    if (error) throw new Error('folder_authority_lookup_failed');
    if (!org || (org.parent_org_id && org.parent_approval_status !== 'APPROVED')) return false;
    cursor = org.parent_org_id;
  }
  return false;
}

async function userCanAdminOrg(db: DbLike, userId: string, targetOrgId: string): Promise<boolean> {
  let cursor: string | null = targetOrgId;
  for (let depth = 0; depth <= 3 && cursor; depth += 1) {
    if (await userIsExactAdmin(db, userId, cursor)) return true;
    const { data: orgData, error } = await db.from('organizations')
      .select('parent_org_id, parent_approval_status').eq('id', cursor).maybeSingle();
    const org = orgData as { parent_org_id: string | null; parent_approval_status: string | null } | null;
    if (error) throw new Error('folder_authority_lookup_failed');
    if (!org || !org.parent_org_id || org.parent_approval_status !== 'APPROVED') return false;
    cursor = org.parent_org_id;
  }
  return false;
}

function principalUserId(auth: FolderActor): string | null {
  return auth.actorUserId ?? auth.apiPrincipalUserId;
}

function rpcIdentity(auth: FolderActor) {
  return { p_actor_user_id: principalUserId(auth), p_api_org_id: auth.apiOrgId };
}

export function createDefaultFolderApiDeps(db: DbLike = defaultDb): FolderApiDeps {
  return {
    async canReadOrg(input) {
      if (input.apiOrgId) return input.apiOrgId === input.orgId;
      return !!input.actorUserId && userCanReadOrg(db, input.actorUserId, input.orgId);
    },
    async canAdminOrg(input) {
      if (input.apiOrgId) return input.apiOrgId === input.orgId;
      return !!input.actorUserId && userCanAdminOrg(db, input.actorUserId, input.orgId);
    },
    async canAdminOrgExact(input) {
      if (input.apiOrgId) return input.apiOrgId === input.orgId;
      return !!input.actorUserId && userIsExactAdmin(db, input.actorUserId, input.orgId);
    },
    async canUsePersonalContext(input) {
      const userId = principalUserId(input);
      if (!userId || userId !== input.ownerUserId) return false;
      if (input.apiOrgId && input.apiOrgId !== input.orgId) return false;
      const { data, error } = await db.from('org_members').select('user_id')
        .eq('user_id', userId).eq('org_id', input.orgId).maybeSingle();
      if (error) throw new Error('folder_authority_lookup_failed');
      return !!data;
    },
    async listFolders(input) {
      const { data, error } = await db.rpc('folder_api_list', {
        ...rpcIdentity(input), p_owner_scope: input.ownerScope,
        p_owner_user_id: input.ownerUserId ?? null, p_org_id: input.orgId ?? null,
        p_context_org_id: input.contextOrgId ?? null,
      });
      if (error) throw new Error('folder_list_failed');
      return ((data ?? []) as unknown as FolderRow[]).sort((a, b) => a.name.localeCompare(b.name));
    },
    async createFolder(input) {
      const { data, error } = await db.rpc('folder_api_create', {
        ...rpcIdentity(input), p_api_key_id: input.apiKeyId, p_owner_scope: input.ownerScope,
        p_owner_user_id: input.ownerUserId ?? null, p_org_id: input.orgId ?? null,
        p_context_org_id: input.contextOrgId ?? null, p_name: input.name,
        p_parent_folder_id: input.parentFolderId,
      });
      if (error) throw new Error(error.code === '23505' ? 'folder_name_conflict'
        : error.code === '42501' ? 'folder_forbidden' : 'folder_create_failed');
      return data as unknown as FolderRow;
    },
    async updateFolder(input) {
      const { data, error } = await db.rpc('folder_api_update', {
        ...rpcIdentity(input), p_folder_id: input.folderId,
        p_name: input.name ?? null, p_name_present: input.name !== undefined,
        p_parent_folder_id: input.parentFolderId ?? null,
        p_parent_present: input.parentFolderId !== undefined,
        p_connector_provider: input.connectorProvider ?? null,
        p_connector_source_id: input.connectorSourceId ?? null,
        p_connector_connection_id: input.connectorConnectionId ?? null,
        p_connector_present: input.connectorProvider !== undefined,
      });
      if (error) throw new Error(error.code === '23505' ? 'folder_name_conflict'
        : error.code === '42501' ? 'folder_forbidden' : 'folder_update_failed');
      return data as unknown as FolderRow | null;
    },
    async deleteFolder(input) {
      const { data, error } = await db.rpc('folder_api_delete', {
        ...rpcIdentity(input), p_folder_id: input.folderId,
      });
      if (error) throw new Error(error.code === '23503' ? 'folder_has_children' : 'folder_delete_failed');
      return data as unknown as FolderRow | null;
    },
    async bulkMove(input) {
      let anchorIds = input.anchorIds ?? [];
      let publicRows: Array<{ id: string; public_id: string }> | null = null;
      if (input.recordPublicIds) {
        const { data: resolvedData, error: resolveError } = await db.from('anchors')
          .select('id, public_id').in('public_id', input.recordPublicIds);
        if (resolveError) throw new Error('folder_bulk_move_failed');
        const resolved = (resolvedData ?? []) as Array<{ id: string; public_id: string }>;
        publicRows = resolved;
        anchorIds = resolved.map((row) => row.id);
      }
      if (anchorIds.length === 0) return remapPublicIdMoveResult(input.recordPublicIds ?? [], publicRows ?? [], {});
      const { data, error } = await db.rpc('folder_api_bulk_move', {
        ...rpcIdentity(input), p_anchor_ids: anchorIds, p_folder_id: input.folderId,
      });
      if (error) throw new Error('folder_bulk_move_failed');
      const raw = data as unknown as RawMoveResult;
      if (publicRows) return remapPublicIdMoveResult(input.recordPublicIds!, publicRows, raw);
      return { moved: raw.moved ?? [], failed: raw.failed ?? [], eventOrgId: raw.event_org_id ?? null,
        folderPublicId: raw.folder_public_id ?? null };
    },
    async emitFolderEvent(eventType, orgId, payload) {
      if (!orgId) return;
      try {
        await dispatchWebhookEvent(orgId, eventType, crypto.randomUUID(), payload);
      } catch (error) {
        logger.warn({ eventType, error }, 'Folder webhook dispatch failed after committed mutation');
      }
    },
  };
}

export const foldersRouter = createFoldersRouter(createDefaultFolderApiDeps());
