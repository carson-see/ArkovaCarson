/**
 * SCRUM-5142 / UAT-24 — canonical folder management API.
 *
 * The browser and API-key clients share this route. Authorization is resolved
 * from the verified JWT/API-key metadata and rechecked by the data dependency;
 * the service-role client is never treated as an authorization signal.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

export type FolderOwnerScope = 'USER' | 'ORG';
export type FolderEventType = 'folder.created' | 'folder.updated' | 'folder.deleted' | 'record.folder_changed';

export interface FolderRow {
  id: string;
  public_id: string;
  name: string;
  owner_scope: FolderOwnerScope;
  user_id: string | null;
  org_id: string | null;
  context_org_id: string | null;
  parent_folder_id: string | null;
  connector_provider: 'google_drive' | 'docusign' | null;
  connector_source_id: string | null;
  connector_connection_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface FolderActor {
  actorUserId: string | null;
  apiKeyId: string | null;
  apiOrgId: string | null;
  apiPrincipalUserId: string | null;
}

export interface FolderAccessInput extends FolderActor {
  ownerScope: FolderOwnerScope;
  ownerUserId?: string | null;
  orgId?: string | null;
  contextOrgId?: string | null;
}

export interface BulkMoveResult {
  moved: string[];
  failed: Array<{ anchor_id: string; code: string }>;
  eventOrgId?: string | null;
  folderPublicId?: string | null;
}

export function remapPublicIdMoveResult(
  requested: string[], resolved: Array<{ id: string; public_id: string }>,
  raw: { moved?: string[]; failed?: BulkMoveResult['failed']; event_org_id?: string; folder_public_id?: string },
): BulkMoveResult {
  const publicIdByAnchorId = new Map(resolved.map((row) => [row.id, row.public_id]));
  const resolvedPublicIds = new Set(resolved.map((row) => row.public_id));
  return {
    moved: (raw.moved ?? []).map((id) => publicIdByAnchorId.get(id)).filter((id): id is string => !!id),
    failed: [...(raw.failed ?? []).map((row) => ({
      ...row, anchor_id: publicIdByAnchorId.get(row.anchor_id) ?? 'unresolved_public_id',
    })), ...requested.filter((id) => !resolvedPublicIds.has(id))
      .map((id) => ({ anchor_id: id, code: 'not_authorized_or_not_found' }))],
    eventOrgId: raw.event_org_id ?? null,
    folderPublicId: raw.folder_public_id ?? null,
  };
}

export interface FolderApiDeps {
  listFolders(input: FolderAccessInput): Promise<FolderRow[]>;
  createFolder(input: FolderAccessInput & {
    name: string;
    parentFolderId: string | null;
  }): Promise<FolderRow>;
  updateFolder(input: FolderActor & {
    folderId: string;
    name?: string;
    parentFolderId?: string | null;
    connectorProvider?: 'google_drive' | 'docusign' | null;
    connectorSourceId?: string | null;
    connectorConnectionId?: string | null;
  }): Promise<FolderRow | null>;
  deleteFolder(input: FolderActor & { folderId: string }): Promise<FolderRow | null>;
  bulkMove(input: FolderActor & {
    anchorIds?: string[]; recordPublicIds?: string[]; folderId: string | null;
  }): Promise<BulkMoveResult>;
  canReadOrg(input: FolderActor & { orgId: string }): Promise<boolean>;
  canAdminOrg(input: FolderActor & { orgId: string }): Promise<boolean>;
  canAdminOrgExact(input: FolderActor & { orgId: string }): Promise<boolean>;
  canUsePersonalContext(input: FolderActor & { ownerUserId: string; orgId: string }): Promise<boolean>;
  emitFolderEvent(eventType: FolderEventType, orgId: string | null, payload: Record<string, unknown>): Promise<void>;
}

const Uuid = z.string().uuid();
const OwnerScope = z.enum(['USER', 'ORG']);
const ListQuery = z.object({
  owner_scope: OwnerScope.optional(),
  owner_user_id: Uuid.optional(),
  org_id: Uuid.optional(),
  context_org_id: Uuid.optional(),
}).strict();
const CreateBody = z.object({
  name: z.string().trim().min(1).max(100),
  owner_scope: OwnerScope,
  org_id: Uuid.nullish(),
  context_org_id: Uuid.nullish(),
  parent_folder_id: Uuid.nullish(),
}).strict();
const PatchBody = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  parent_folder_id: Uuid.nullish(),
}).strict().refine((body) => body.name !== undefined || body.parent_folder_id !== undefined, {
  message: 'at least one field is required',
});
const ConnectorBody = z.object({
  provider: z.enum(['google_drive', 'docusign']).nullable(),
  source_id: z.string().trim().min(1).max(500).nullable(),
  connection_id: Uuid.nullable(),
}).strict().refine((body) => new Set([
  body.provider === null, body.source_id === null, body.connection_id === null,
]).size === 1, {
  message: 'provider, source_id, and connection_id must all be set or all be null',
});
const BulkMoveBody = z.object({
  anchor_ids: z.array(Uuid).min(1).max(100).optional(),
  record_public_ids: z.array(z.string().regex(/^ARK-[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/))
    .min(1).max(100).optional(),
  folder_id: Uuid.nullable(),
}).strict().refine((body) => Number(!!body.anchor_ids) + Number(!!body.record_public_ids) === 1, {
  message: 'provide exactly one of anchor_ids or record_public_ids',
});

export function actor(req: Request): FolderActor | null {
  if (req.authUserId) {
    if (req.apiKey?.userId && req.apiKey.userId !== req.authUserId) return null;
    return {
      actorUserId: req.authUserId, apiKeyId: req.apiKey?.keyId ?? null,
      apiOrgId: req.apiKey?.orgId ?? null, apiPrincipalUserId: req.apiKey?.userId ?? null,
    };
  }
  if (req.apiKey?.keyId && (req.apiKey.orgId || req.apiKey.userId)) {
    return {
      actorUserId: null, apiKeyId: req.apiKey.keyId, apiOrgId: req.apiKey.orgId || null,
      apiPrincipalUserId: req.apiKey.userId || null,
    };
  }
  return null;
}

function badRequest(res: Response, parsed: z.ZodSafeParseError<unknown>): void {
  res.status(400).json({ error: 'invalid_request', details: parsed.error.issues.map((issue) => ({
    field: issue.path.join('.'), message: issue.message,
  })) });
}

async function authorizeScope(
  deps: FolderApiDeps,
  auth: FolderActor,
  input: { ownerScope: FolderOwnerScope; ownerUserId?: string | null; orgId?: string | null; contextOrgId?: string | null },
  write: boolean,
): Promise<{ ok: true; ownerUserId: string | null; orgId: string | null; contextOrgId: string | null } | { ok: false; code: string }> {
  if (input.ownerScope === 'USER') {
    const principalUserId = auth.actorUserId ?? auth.apiPrincipalUserId;
    if (!principalUserId) return { ok: false, code: 'personal_scope_requires_user' };
    const ownerUserId = input.ownerUserId ?? principalUserId;
    if (auth.apiOrgId && (
      ownerUserId !== auth.apiPrincipalUserId || input.contextOrgId !== auth.apiOrgId
    )) return { ok: false, code: 'personal_scope_key_org_required' };
    if (write && ownerUserId !== principalUserId) return { ok: false, code: 'personal_scope_owner_required' };
    if (ownerUserId !== principalUserId) {
      if (!input.contextOrgId || !(await deps.canAdminOrg({ ...auth, orgId: input.contextOrgId }))) {
        return { ok: false, code: 'folder_scope_forbidden' };
      }
    } else if (input.contextOrgId && !(await deps.canUsePersonalContext({
      ...auth, ownerUserId, orgId: input.contextOrgId,
    }))) {
      return { ok: false, code: 'folder_context_forbidden' };
    }
    return { ok: true, ownerUserId, orgId: null, contextOrgId: input.contextOrgId ?? null };
  }

  const orgId = input.orgId ?? auth.apiOrgId;
  if (!orgId) return { ok: false, code: 'org_id_required' };
  const allowed = write
    ? await deps.canAdminOrgExact({ ...auth, orgId })
    : await deps.canReadOrg({ ...auth, orgId });
  if (!allowed) return { ok: false, code: 'folder_scope_forbidden' };
  return { ok: true, ownerUserId: null, orgId, contextOrgId: null };
}

export function createFoldersRouter(deps: FolderApiDeps): Router {
  const router = Router();

  router.use((req, res, next) => {
    if (!actor(req)) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }
    next();
  });

  router.get('/', async (req, res) => {
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) return badRequest(res, parsed);
    const auth = actor(req)!;
    const ownerScope = parsed.data.owner_scope ?? (auth.actorUserId ? 'USER' : 'ORG');
    const authorized = await authorizeScope(deps, auth, {
      ownerScope,
      ownerUserId: parsed.data.owner_user_id,
      orgId: parsed.data.org_id,
      contextOrgId: parsed.data.context_org_id,
    }, false);
    if (!authorized.ok) return res.status(403).json({ error: authorized.code });
    const folders = await deps.listFolders({ ...auth, ownerScope, ...authorized });
    return res.json({ folders });
  });

  router.post('/', async (req, res) => {
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed);
    const auth = actor(req)!;
    const authorized = await authorizeScope(deps, auth, {
      ownerScope: parsed.data.owner_scope,
      orgId: parsed.data.org_id,
      contextOrgId: parsed.data.context_org_id,
    }, true);
    if (!authorized.ok) return res.status(403).json({ error: authorized.code });
    const folder = await deps.createFolder({
      ...auth, ownerScope: parsed.data.owner_scope, ...authorized,
      name: parsed.data.name, parentFolderId: parsed.data.parent_folder_id ?? null,
    });
    await deps.emitFolderEvent('folder.created', folder.org_id ?? folder.context_org_id, {
      folder_public_id: folder.public_id,
      owner_scope: folder.owner_scope,
    });
    return res.status(201).json({ folder });
  });

  router.patch('/:folderId', async (req, res) => {
    const id = Uuid.safeParse(req.params.folderId);
    const parsed = PatchBody.safeParse(req.body);
    if (!id.success || !parsed.success) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    const auth = actor(req)!;
    const folder = await deps.updateFolder({
      ...auth, folderId: id.data, name: parsed.data.name,
      ...(Object.hasOwn(parsed.data, 'parent_folder_id') ? { parentFolderId: parsed.data.parent_folder_id ?? null } : {}),
    });
    if (!folder) return res.status(404).json({ error: 'folder_not_found_or_forbidden' });
    await deps.emitFolderEvent('folder.updated', folder.org_id ?? folder.context_org_id, {
      folder_public_id: folder.public_id,
      owner_scope: folder.owner_scope,
    });
    return res.json({ folder });
  });

  router.put('/:folderId/connector', async (req, res) => {
    const id = Uuid.safeParse(req.params.folderId);
    const parsed = ConnectorBody.safeParse(req.body);
    if (!id.success || !parsed.success) return res.status(400).json({ error: 'invalid_request' });
    const folder = await deps.updateFolder({
      ...actor(req)!, folderId: id.data,
      connectorProvider: parsed.data.provider, connectorSourceId: parsed.data.source_id,
      connectorConnectionId: parsed.data.connection_id,
    });
    if (!folder) return res.status(404).json({ error: 'folder_not_found_or_forbidden' });
    await deps.emitFolderEvent('folder.updated', folder.org_id ?? folder.context_org_id, {
      folder_public_id: folder.public_id,
      owner_scope: folder.owner_scope, connector_provider: folder.connector_provider,
    });
    return res.json({ folder });
  });

  router.delete('/:folderId', async (req, res) => {
    const id = Uuid.safeParse(req.params.folderId);
    if (!id.success) return res.status(400).json({ error: 'invalid_request' });
    const deleted = await deps.deleteFolder({ ...actor(req)!, folderId: id.data });
    if (!deleted) return res.status(404).json({ error: 'folder_not_found_or_forbidden' });
    await deps.emitFolderEvent('folder.deleted', deleted.org_id ?? deleted.context_org_id, {
      folder_public_id: deleted.public_id, owner_scope: deleted.owner_scope,
    });
    return res.status(204).end();
  });

  router.post('/bulk-move', async (req, res) => {
    const parsed = BulkMoveBody.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed);
    const result = await deps.bulkMove({
      ...actor(req)!,
      ...(parsed.data.anchor_ids ? { anchorIds: [...new Set(parsed.data.anchor_ids)] } : {}),
      ...(parsed.data.record_public_ids
        ? { recordPublicIds: [...new Set(parsed.data.record_public_ids)] } : {}),
      folderId: parsed.data.folder_id,
    });
    if (result.moved.length > 0) {
      await deps.emitFolderEvent('record.folder_changed', result.eventOrgId ?? null, {
        folder_public_id: result.folderPublicId ?? null, moved_count: result.moved.length,
        failed_count: result.failed.length,
      });
    }
    return res.status(result.failed.length > 0 ? 207 : 200).json({ moved: result.moved, failed: result.failed });
  });

  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(error);
    const code = error instanceof Error ? error.message : 'folder_operation_failed';
    if (code === 'folder_forbidden') return res.status(403).json({ error: code });
    if (code === 'folder_name_conflict' || code === 'folder_has_children') {
      return res.status(409).json({ error: code });
    }
    return res.status(500).json({ error: 'folder_operation_failed' });
  });

  return router;
}
