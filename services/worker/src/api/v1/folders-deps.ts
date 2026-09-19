/** Production data adapter for the UAT-24 folder router. */
import { db as defaultDb } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { dispatchWebhookEvent } from '../../webhooks/delivery.js';
import { chunkForInFilter } from '../../utils/postgrest-filter.js';
import type { Database } from '../../types/database.types.js';
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
type FolderFunction = Extract<keyof Database['public']['Functions'], `folder_api_${string}`>;

/**
 * Postgres accepts NULL for these RPC parameters, but the hosted Supabase type
 * generator records them as non-null strings. Keep its output verbatim and
 * confine that generator limitation to the exact folder RPC boundary.
 */
function nullableFolderRpcArgs<Name extends FolderFunction>(
  args: { [Key in keyof Database['public']['Functions'][Name]['Args']]:
    Database['public']['Functions'][Name]['Args'][Key] | null },
): Database['public']['Functions'][Name]['Args'] {
  return args as Database['public']['Functions'][Name]['Args'];
}

/** PostgREST serializes a SQL composite RETURN NULL as an all-null object. */
function folderCompositeOrNull(data: unknown): FolderRow | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return typeof (data as { id?: unknown }).id === 'string'
    ? data as FolderRow
    : null;
}

async function userIsExactAdmin(db: DbLike, userId: string, orgId: string): Promise<boolean> {
  const { data, error } = await db.from('org_members')
    .select('user_id').eq('user_id', userId).eq('org_id', orgId)
    .in('role', ['owner', 'admin']).maybeSingle();
  if (error) throw new Error('folder_authority_lookup_failed');
  return !!data;
}

async function userIsPlatformAdmin(db: DbLike, userId: string): Promise<boolean> {
  const { data, error } = await db.from('profiles')
    .select('is_platform_admin').eq('id', userId).maybeSingle();
  if (error) throw new Error('folder_authority_lookup_failed');
  return data?.is_platform_admin === true;
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
    async isPlatformAdmin(input) {
      if (input.apiOrgId || !input.actorUserId) return false;
      return userIsPlatformAdmin(db, input.actorUserId);
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
    async getMemberContext(input) {
      const { data: membership, error: membershipError } = await db.from('org_members')
        .select('role').eq('user_id', input.ownerUserId).eq('org_id', input.orgId).maybeSingle();
      if (membershipError) throw new Error('folder_authority_lookup_failed');
      const membershipRole = (membership as { role?: 'owner' | 'admin' | 'member' } | null)?.role;
      const { data: profile, error: profileError } = await db.from('profiles')
        .select('id, email, full_name, avatar_url, role, created_at, org_id')
        .eq('id', input.ownerUserId).maybeSingle();
      if (profileError) throw new Error('folder_authority_lookup_failed');
      const row = profile as { id: string; email: string; full_name: string | null; avatar_url: string | null; role: 'ORG_ADMIN' | 'INDIVIDUAL'; created_at: string; org_id: string | null } | null;
      if (!row || !membershipRole) return null;
      return {
        id: row.id, email: row.email, full_name: row.full_name, avatar_url: row.avatar_url,
        role: membershipRole === 'owner' || membershipRole === 'admin' ? 'ORG_ADMIN' : 'INDIVIDUAL',
        created_at: row.created_at, org_id: input.orgId, membership_role: membershipRole,
      };
    },
    async listMemberContexts(input) {
      const { data: memberships, error: membershipError } = await db.from('org_members')
        .select('user_id, role').eq('org_id', input.orgId).order('user_id', { ascending: true }).limit(500);
      if (membershipError) throw new Error('folder_authority_lookup_failed');
      const rows = (memberships ?? []) as Array<{ user_id: string; role: 'owner' | 'admin' | 'member' }>;
      if (rows.length === 0) return [];
      type Profile = { id: string; email: string; full_name: string | null; avatar_url: string | null; created_at: string };
      const profiles: Profile[] = [];
      for (const { values: userIds } of chunkForInFilter(rows.map((row) => row.user_id))) {
        const { data, error } = await db.from('profiles').select('id, email, full_name, avatar_url, created_at')
          .in('id', userIds);
        if (error) throw new Error('folder_authority_lookup_failed');
        profiles.push(...((data ?? []) as Profile[]));
      }
      const byId = new Map(profiles.map((row) => [row.id, row]));
      return rows.flatMap((membership) => {
        const profile = byId.get(membership.user_id);
        return profile ? [{ ...profile, role: membership.role === 'member' ? 'INDIVIDUAL' as const : 'ORG_ADMIN' as const,
          org_id: input.orgId, membership_role: membership.role }] : [];
      });
    },
    async listFolders(input) {
      const { data, error } = await db.rpc('folder_api_list', nullableFolderRpcArgs<'folder_api_list'>({
        ...rpcIdentity(input), p_owner_scope: input.ownerScope,
        p_owner_user_id: input.ownerUserId ?? null, p_org_id: input.orgId ?? null,
        p_context_org_id: input.contextOrgId ?? null,
      }));
      if (error) throw new Error('folder_list_failed');
      return ((data ?? []) as unknown as FolderRow[]).sort((a, b) => a.name.localeCompare(b.name));
    },
    async createFolder(input) {
      const { data, error } = await db.rpc('folder_api_create', nullableFolderRpcArgs<'folder_api_create'>({
        ...rpcIdentity(input), p_api_key_id: input.apiKeyId, p_owner_scope: input.ownerScope,
        p_owner_user_id: input.ownerUserId ?? null, p_org_id: input.orgId ?? null,
        p_context_org_id: input.contextOrgId ?? null, p_name: input.name,
        p_parent_folder_id: input.parentFolderId,
      }));
      if (error) throw new Error(error.code === '23505' ? 'folder_name_conflict'
        : error.code === '42501' ? 'folder_forbidden' : 'folder_create_failed');
      return data as unknown as FolderRow;
    },
    async updateFolder(input) {
      const { data, error } = await db.rpc('folder_api_update', nullableFolderRpcArgs<'folder_api_update'>({
        ...rpcIdentity(input), p_folder_id: input.folderId,
        p_name: input.name ?? null, p_name_present: input.name !== undefined,
        p_parent_folder_id: input.parentFolderId ?? null,
        p_parent_present: input.parentFolderId !== undefined,
        p_connector_provider: input.connectorProvider ?? null,
        p_connector_source_id: input.connectorSourceId ?? null,
        p_connector_connection_id: input.connectorConnectionId ?? null,
        p_connector_present: input.connectorProvider !== undefined,
      }));
      if (error) throw new Error(error.code === '23505' ? 'folder_name_conflict'
        : error.code === '42501' ? 'folder_forbidden' : 'folder_update_failed');
      return folderCompositeOrNull(data);
    },
    async deleteFolder(input) {
      const { data, error } = await db.rpc('folder_api_delete', nullableFolderRpcArgs<'folder_api_delete'>({
        ...rpcIdentity(input), p_folder_id: input.folderId,
      }));
      if (error) throw new Error(error.code === '23503' ? 'folder_has_children' : 'folder_delete_failed');
      return folderCompositeOrNull(data);
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
      const { data, error } = await db.rpc('folder_api_bulk_move', nullableFolderRpcArgs<'folder_api_bulk_move'>({
        ...rpcIdentity(input), p_anchor_ids: anchorIds, p_folder_id: input.folderId,
      }));
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
