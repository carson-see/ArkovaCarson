import express, { type Request } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFoldersRouter, remapPublicIdMoveResult, type FolderApiDeps } from './folders.js';

const USER = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const OTHER_ORG = '33333333-3333-4333-8333-333333333333';
const FOLDER = '44444444-4444-4444-8444-444444444444';
const ANCHOR_A = '55555555-5555-4555-8555-555555555555';
const ANCHOR_B = '66666666-6666-4666-8666-666666666666';

function app(deps: FolderApiDeps, auth: { userId?: string; orgId?: string; apiUserId?: string } = { userId: USER }) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    req.authUserId = auth.userId;
    if (auth.orgId || auth.apiUserId) {
      (req as Request & { apiKey: { keyId: string; orgId: string; userId: string; scopes: string[] } }).apiKey = {
        keyId: 'key-1', orgId: auth.orgId ?? '', userId: auth.apiUserId ?? '', scopes: ['anchor:write'],
        rateLimitTier: 'free', keyPrefix: 'ak_test_1234',
      };
    }
    next();
  });
  server.use('/folders', createFoldersRouter(deps));
  return server;
}

function deps(overrides: Partial<FolderApiDeps> = {}): FolderApiDeps {
  return {
    listFolders: vi.fn().mockResolvedValue([]),
    createFolder: vi.fn().mockResolvedValue({
      id: FOLDER, public_id: 'FLD-LEGAL0000000001', name: 'Legal', owner_scope: 'USER', user_id: USER, org_id: null,
      context_org_id: null, parent_folder_id: null, connector_provider: null,
      connector_source_id: null, connector_connection_id: null,
      created_at: '2026-09-14T00:00:00Z', updated_at: '2026-09-14T00:00:00Z',
    }),
    updateFolder: vi.fn().mockResolvedValue(null),
    deleteFolder: vi.fn().mockResolvedValue({
      id: FOLDER, public_id: 'FLD-LEGAL0000000001', name: 'Legal', owner_scope: 'USER', user_id: USER,
      org_id: null, context_org_id: null, parent_folder_id: null, connector_provider: null,
      connector_source_id: null, connector_connection_id: null,
      created_at: '2026-09-14T00:00:00Z', updated_at: '2026-09-14T00:00:00Z',
    }),
    bulkMove: vi.fn().mockResolvedValue({ moved: [FOLDER], failed: [] }),
    canReadOrg: vi.fn().mockResolvedValue(true),
    canAdminOrg: vi.fn().mockResolvedValue(true),
    canAdminOrgExact: vi.fn().mockResolvedValue(true),
    isPlatformAdmin: vi.fn().mockResolvedValue(false),
    canUsePersonalContext: vi.fn().mockResolvedValue(true),
    getMemberContext: vi.fn().mockResolvedValue({
      id: ANCHOR_A, email: 'member@example.com', full_name: 'Member', avatar_url: null,
      role: 'INDIVIDUAL', created_at: '2026-01-01T00:00:00Z', org_id: ORG, membership_role: 'member',
    }),
    listMemberContexts: vi.fn().mockResolvedValue([]),
    emitFolderEvent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('UAT-24 folders API', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires either a verified user or an API key', async () => {
    const d = deps();
    const res = await request(app(d, {})).get('/folders');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'authentication_required' });
    expect(d.listFolders).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain('FLD-');
  });

  it('lists a user personal scope for a JWT caller', async () => {
    const d = deps();
    const res = await request(app(d)).get('/folders?owner_scope=USER');
    expect(res.status).toBe(200);
    expect(d.listFolders).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: USER, ownerScope: 'USER' }));
  });

  it('refuses personal-folder access through an organization API key without a principal', async () => {
    const res = await request(app(deps(), { orgId: ORG })).get('/folders?owner_scope=USER');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('personal_scope_requires_user');
  });

  it('supports an organization-only key for exact-org list and create', async () => {
    const d = deps();
    const list = await request(app(d, { orgId: ORG })).get(`/folders?owner_scope=ORG&org_id=${ORG}`);
    expect(list.status).toBe(200);
    expect(d.listFolders).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: null, apiOrgId: ORG, ownerScope: 'ORG', orgId: ORG,
    }));

    const create = await request(app(d, { orgId: ORG })).post('/folders')
      .send({ name: 'Legal', owner_scope: 'ORG', org_id: ORG });
    expect(create.status).toBe(201);
    expect(d.createFolder).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: null, apiKeyId: 'key-1', apiOrgId: ORG, ownerScope: 'ORG', orgId: ORG,
    }));
  });

  it('supports organization-only key update and bulk move without a user fallback', async () => {
    const orgFolder = {
      id: FOLDER, public_id: 'FLD-ORG00000000001', name: 'Legal', owner_scope: 'ORG' as const,
      user_id: null, org_id: ORG, context_org_id: null, parent_folder_id: null,
      connector_provider: null, connector_source_id: null, connector_connection_id: null,
      created_at: '2026-09-14T00:00:00Z', updated_at: '2026-09-14T00:00:00Z',
    };
    const d = deps({ updateFolder: vi.fn().mockResolvedValue(orgFolder) });
    const update = await request(app(d, { orgId: ORG })).patch(`/folders/${FOLDER}`).send({ name: 'Renamed' });
    expect(update.status).toBe(200);
    expect(d.updateFolder).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: null, apiOrgId: ORG }));

    const move = await request(app(d, { orgId: ORG })).post('/folders/bulk-move')
      .send({ anchor_ids: [ANCHOR_A], folder_id: FOLDER });
    expect(move.status).toBe(200);
    expect(d.bulkMove).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: null, apiOrgId: ORG }));
  });

  it('allows the verified API-key principal to manage its personal folders', async () => {
    const d = deps();
    const res = await request(app(d, { orgId: ORG, apiUserId: USER }))
      .post('/folders').send({ name: 'Legal', owner_scope: 'USER', context_org_id: ORG });
    expect(res.status).toBe(201);
    expect(d.createFolder).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: USER, contextOrgId: ORG }));
  });

  it('keeps an org API key from its issuer global personal scope', async () => {
    const d = deps();
    const res = await request(app(d, { orgId: ORG, apiUserId: USER }))
      .get('/folders?owner_scope=USER');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('personal_scope_key_org_required');
    expect(d.listFolders).not.toHaveBeenCalled();
  });

  it('requires admin authority, not ordinary membership, to list another user contextual folders', async () => {
    const d = deps({ canAdminOrg: vi.fn().mockResolvedValue(false), canReadOrg: vi.fn().mockResolvedValue(true) });
    const res = await request(app(d)).get(`/folders?owner_scope=USER&owner_user_id=${ANCHOR_A}&context_org_id=${ORG}`);
    expect(res.status).toBe(403);
    expect(d.listFolders).not.toHaveBeenCalled();
  });

  it('allows a verified platform admin to read another user contextual folders', async () => {
    const d = deps({
      isPlatformAdmin: vi.fn().mockResolvedValue(true),
      canAdminOrg: vi.fn().mockResolvedValue(false),
    });
    const res = await request(app(d)).get(
      `/folders?owner_scope=USER&owner_user_id=${ANCHOR_A}&context_org_id=${ORG}`,
    );
    expect(res.status).toBe(200);
    expect(d.listFolders).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: USER, apiOrgId: null, ownerUserId: ANCHOR_A, contextOrgId: ORG,
    }));
  });

  it('keeps another user global personal folders private from platform admins', async () => {
    const d = deps({ isPlatformAdmin: vi.fn().mockResolvedValue(true) });
    const res = await request(app(d)).get(`/folders?owner_scope=USER&owner_user_id=${ANCHOR_A}`);
    expect(res.status).toBe(403);
    expect(d.listFolders).not.toHaveBeenCalled();
  });

  it('allows a verified platform admin to read an organization folder tree', async () => {
    const d = deps({
      isPlatformAdmin: vi.fn().mockResolvedValue(true),
      canReadOrg: vi.fn().mockResolvedValue(false),
    });
    const res = await request(app(d)).get(`/folders?owner_scope=ORG&org_id=${OTHER_ORG}`);
    expect(res.status).toBe(200);
    expect(d.listFolders).toHaveBeenCalledWith(expect.objectContaining({ orgId: OTHER_ORG }));
  });

  it('retains ordinary ancestor-admin contextual read authority', async () => {
    const d = deps({
      isPlatformAdmin: vi.fn().mockResolvedValue(false),
      canAdminOrg: vi.fn().mockResolvedValue(true),
    });
    const res = await request(app(d)).get(
      `/folders?owner_scope=USER&owner_user_id=${ANCHOR_A}&context_org_id=${ORG}`,
    );
    expect(res.status).toBe(200);
  });

  it('returns a server-derived exact member context to an authorized admin', async () => {
    const d = deps({ canAdminOrg: vi.fn().mockResolvedValue(true) });
    const res = await request(app(d)).get(`/folders/member-context?owner_user_id=${ANCHOR_A}&context_org_id=${ORG}`);
    expect(res.status).toBe(200);
    expect(res.body.member).toMatchObject({ id: ANCHOR_A, org_id: ORG, membership_role: 'member' });
    expect(d.getMemberContext).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: ANCHOR_A, orgId: ORG }));
  });

  it('lists only the canonical exact-membership roster for an authorized admin', async () => {
    const listMemberContexts = vi.fn().mockResolvedValue([{
      id: ANCHOR_A, email: 'member@example.com', full_name: null, avatar_url: null,
      role: 'INDIVIDUAL', created_at: '2026-01-01T00:00:00Z', org_id: ORG, membership_role: 'member',
    }]);
    const d = deps({ canAdminOrg: vi.fn().mockResolvedValue(true), listMemberContexts });
    const res = await request(app(d)).get(`/folders/member-contexts?context_org_id=${ORG}`);
    expect(res.status).toBe(200);
    expect(res.body.members).toHaveLength(1);
    expect(listMemberContexts).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG }));
  });

  it('does not enumerate a member to an unauthorized or API-key caller', async () => {
    const denied = deps({ canAdminOrg: vi.fn().mockResolvedValue(false) });
    expect((await request(app(denied)).get(`/folders/member-context?owner_user_id=${ANCHOR_A}&context_org_id=${OTHER_ORG}`)).status).toBe(403);
    expect(denied.getMemberContext).not.toHaveBeenCalled();
    expect((await request(app(deps(), { orgId: ORG })).get(`/folders/member-context?owner_user_id=${ANCHOR_A}&context_org_id=${ORG}`)).status).toBe(403);
  });

  it('does not treat platform read authority as exact-org write authority', async () => {
    const d = deps({
      isPlatformAdmin: vi.fn().mockResolvedValue(true),
      canAdminOrgExact: vi.fn().mockResolvedValue(false),
    });
    const res = await request(app(d)).post('/folders')
      .send({ name: 'Other tenant', owner_scope: 'ORG', org_id: OTHER_ORG });
    expect(res.status).toBe(403);
    expect(d.createFolder).not.toHaveBeenCalled();
    expect(d.isPlatformAdmin).not.toHaveBeenCalled();
  });

  it('keeps an API key organization bound above a platform principal read', async () => {
    const d = deps({
      isPlatformAdmin: vi.fn().mockResolvedValue(true),
      canReadOrg: vi.fn().mockResolvedValue(false),
    });
    const res = await request(app(d, { orgId: ORG, apiUserId: USER }))
      .get(`/folders?owner_scope=ORG&org_id=${OTHER_ORG}`);
    expect(res.status).toBe(403);
    expect(d.listFolders).not.toHaveBeenCalled();
    expect(d.isPlatformAdmin).not.toHaveBeenCalled();
  });

  it('checks exact membership before creating an own contextual personal folder', async () => {
    const d = deps({ canUsePersonalContext: vi.fn().mockResolvedValue(false) });
    const res = await request(app(d)).post('/folders')
      .send({ name: 'Legal', owner_scope: 'USER', context_org_id: OTHER_ORG });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('folder_context_forbidden');
    expect(d.createFolder).not.toHaveBeenCalled();
  });

  it('fails a cross-tenant organization create before writing', async () => {
    const d = deps({ canAdminOrgExact: vi.fn().mockResolvedValue(false) });
    const res = await request(app(d, { orgId: ORG }))
      .post('/folders')
      .send({ name: 'Legal', owner_scope: 'ORG', org_id: OTHER_ORG });
    expect(res.status).toBe(403);
    expect(d.createFolder).not.toHaveBeenCalled();
  });

  it('returns per-record results for a bounded bulk move', async () => {
    const d = deps({ bulkMove: vi.fn().mockResolvedValue({ moved: [ANCHOR_A], failed: [{ anchor_id: ANCHOR_B, code: 'not_authorized' }] }) });
    const res = await request(app(d)).post('/folders/bulk-move').send({ anchor_ids: [ANCHOR_A, ANCHOR_B], folder_id: FOLDER });
    expect(res.status).toBe(207);
    expect(res.body).toEqual({ moved: [ANCHOR_A], failed: [{ anchor_id: ANCHOR_B, code: 'not_authorized' }] });
  });

  it('accepts public record ids and preserves them in the dependency contract', async () => {
    const d = deps({ bulkMove: vi.fn().mockResolvedValue({
      moved: ['ARK-2026-ABC12345'], failed: [{ anchor_id: 'ARK-2026-MISSING1', code: 'not_authorized_or_not_found' }],
    }) });
    const res = await request(app(d)).post('/folders/bulk-move').send({
      record_public_ids: ['ARK-2026-ABC12345', 'ARK-2026-MISSING1'], folder_id: FOLDER,
    });
    expect(res.status).toBe(207);
    expect(d.bulkMove).toHaveBeenCalledWith(expect.objectContaining({
      recordPublicIds: ['ARK-2026-ABC12345', 'ARK-2026-MISSING1'],
    }));
    expect(JSON.stringify(res.body)).not.toContain(ANCHOR_A);
  });

  it('maps public-id outcomes without leaking resolved UUIDs', () => {
    const result = remapPublicIdMoveResult(
      ['ARK-2026-A', 'ARK-2026-B', 'ARK-2026-MISSING'],
      [{ id: ANCHOR_A, public_id: 'ARK-2026-A' }, { id: ANCHOR_B, public_id: 'ARK-2026-B' }],
      { moved: [ANCHOR_A], failed: [{ anchor_id: ANCHOR_B, code: 'not_authorized_or_not_found' }] },
    );
    expect(result).toMatchObject({ moved: ['ARK-2026-A'], failed: [
      { anchor_id: 'ARK-2026-B', code: 'not_authorized_or_not_found' },
      { anchor_id: 'ARK-2026-MISSING', code: 'not_authorized_or_not_found' },
    ] });
    expect(JSON.stringify(result)).not.toContain(ANCHOR_A);
    expect(JSON.stringify(result)).not.toContain(ANCHOR_B);
  });

  it('rejects ambiguous UUID and public-id bulk inputs', async () => {
    const d = deps();
    const res = await request(app(d)).post('/folders/bulk-move').send({
      anchor_ids: [ANCHOR_A], record_public_ids: ['ARK-2026-ABC12345'], folder_id: FOLDER,
    });
    expect(res.status).toBe(400);
    expect(d.bulkMove).not.toHaveBeenCalled();
  });

  it('rejects bulk requests over 100 before any write', async () => {
    const d = deps();
    const anchorIds = Array.from({ length: 101 }, (_, i) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`);
    const res = await request(app(d)).post('/folders/bulk-move').send({ anchor_ids: anchorIds, folder_id: FOLDER });
    expect(res.status).toBe(400);
    expect(d.bulkMove).not.toHaveBeenCalled();
  });

  it('emits an outbound event after a successful create', async () => {
    const d = deps();
    const res = await request(app(d)).post('/folders').send({ name: 'Legal', owner_scope: 'USER' });
    expect(res.status).toBe(201);
    expect(d.emitFolderEvent).toHaveBeenCalledWith('folder.created', null, {
      folder_public_id: 'FLD-LEGAL0000000001', owner_scope: 'USER',
    });
    const payload = vi.mocked(d.emitFolderEvent).mock.calls[0][2];
    expect(payload).not.toHaveProperty('user_id');
    expect(payload).not.toHaveProperty('org_id');
    expect(payload).not.toHaveProperty('connector_source_id');
    expect(payload).not.toHaveProperty('connector_connection_id');
  });

  it('maps adapter conflicts to a stable JSON error', async () => {
    const d = deps({ createFolder: vi.fn().mockRejectedValue(new Error('folder_name_conflict')) });
    const res = await request(app(d)).post('/folders').send({ name: 'Legal', owner_scope: 'USER' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'folder_name_conflict' });
  });
});
