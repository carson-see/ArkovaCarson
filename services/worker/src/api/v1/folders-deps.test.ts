import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/db.js', () => ({ db: {} }));
vi.mock('../../utils/logger.js', () => ({ logger: { warn: vi.fn() } }));
vi.mock('../../webhooks/delivery.js', () => ({ dispatchWebhookEvent: vi.fn() }));

import { createDefaultFolderApiDeps } from './folders-deps.js';
import { createFoldersRouter } from './folders.js';
import { dispatchWebhookEvent } from '../../webhooks/delivery.js';

const PLATFORM = '99999999-0000-4000-8000-000000000001';
const TARGET = '88888888-0000-4000-8000-000000000001';
const ORG = 'dddddddd-0000-4000-8000-000000000001';

function query(data: unknown) {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.in = vi.fn(() => chain);
  chain.limit = vi.fn(() => chain);
  chain.order = vi.fn(() => chain);
  chain.single = vi.fn(async () => ({ data, error: null }));
  chain.maybeSingle = vi.fn(async () => ({ data, error: null }));
  return chain;
}

function appFor(profile: { is_platform_admin: boolean } | null, rpcData: unknown = []) {
  const rpc = vi.fn(async () => ({ data: rpcData, error: null }));
  const from = vi.fn((table: string) => {
    if (table === 'profiles') return query(profile);
    if (table === 'org_members') return query(null);
    if (table === 'organizations') return query({ parent_org_id: null, parent_approval_status: null });
    throw new Error(`unexpected table ${table}`);
  });
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => { req.authUserId = PLATFORM; next(); });
  server.use('/folders', createFoldersRouter(createDefaultFolderApiDeps({ from, rpc } as never)));
  return { server, from, rpc };
}

describe('SCRUM-5252 production folder adapter', () => {
  it('derives secondary member context from org_members rather than profile primary org', async () => {
    const profile = { id: TARGET, email: 'member@example.com', full_name: 'Member', avatar_url: null,
      role: 'INDIVIDUAL', created_at: '2026-01-01T00:00:00Z', org_id: 'primary-org' };
    const from = vi.fn((table: string) => table === 'org_members' ? query({ role: 'member' }) : query(profile));
    const member = await createDefaultFolderApiDeps({ from, rpc: vi.fn() } as never).getMemberContext({
      actorUserId: PLATFORM, apiKeyId: null, apiOrgId: null, apiPrincipalUserId: null,
      ownerUserId: TARGET, orgId: ORG,
    });
    expect(member).toMatchObject({ id: TARGET, org_id: ORG, membership_role: 'member' });
  });

  it('does not resurrect a stale primary profile after membership removal', async () => {
    const profile = { id: TARGET, email: 'member@example.com', full_name: null, avatar_url: null,
      role: 'ORG_ADMIN', created_at: '2026-01-01T00:00:00Z', org_id: ORG };
    const from = vi.fn((table: string) => table === 'org_members' ? query(null) : query(profile));
    const member = await createDefaultFolderApiDeps({ from, rpc: vi.fn() } as never).getMemberContext({
      actorUserId: PLATFORM, apiKeyId: null, apiOrgId: null, apiPrincipalUserId: null,
      ownerUserId: TARGET, orgId: ORG,
    });
    expect(member).toBeNull();
  });

  it('derives the displayed role from the exact membership', async () => {
    const profile = { id: TARGET, email: 'member@example.com', full_name: null, avatar_url: null,
      role: 'INDIVIDUAL', created_at: '2026-01-01T00:00:00Z', org_id: 'other' };
    const from = vi.fn((table: string) => table === 'org_members' ? query({ role: 'admin' }) : query(profile));
    const member = await createDefaultFolderApiDeps({ from, rpc: vi.fn() } as never).getMemberContext({
      actorUserId: PLATFORM, apiKeyId: null, apiOrgId: null, apiPrincipalUserId: null,
      ownerUserId: TARGET, orgId: ORG,
    });
    expect(member?.role).toBe('ORG_ADMIN');
  });
  it('verifies the exact JWT actor platform flag and reaches the service RPC', async () => {
    const { server, from, rpc } = appFor({ is_platform_admin: true });
    const response = await request(server).get(
      `/folders?owner_scope=USER&owner_user_id=${TARGET}&context_org_id=${ORG}`,
    );
    expect(response.status).toBe(200);
    expect(from).toHaveBeenCalledWith('profiles');
    expect(rpc).toHaveBeenCalledWith('folder_api_list', expect.objectContaining({
      p_actor_user_id: PLATFORM, p_api_org_id: null, p_owner_user_id: TARGET, p_context_org_id: ORG,
    }));
  });

  it('keeps a non-admin without organization authority denied', async () => {
    const { server, rpc } = appFor({ is_platform_admin: false });
    const response = await request(server).get(
      `/folders?owner_scope=USER&owner_user_id=${TARGET}&context_org_id=${ORG}`,
    );
    expect(response.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['rename', 'patch', `/folders/${TARGET}`, { name: 'forbidden' }],
    ['connector update', 'put', `/folders/${TARGET}/connector`, {
      provider: 'google_drive', source_id: 'source', connection_id: PLATFORM,
    }],
    ['delete', 'delete', `/folders/${TARGET}`, undefined],
  ] as const)('normalizes an all-null composite for denied %s and emits no webhook',
    async (_label, method, path, body) => {
      const nullComposite = {
        id: null, public_id: null, name: null, owner_scope: null, user_id: null,
        org_id: null, context_org_id: null, parent_folder_id: null,
        connector_provider: null, connector_source_id: null, connector_connection_id: null,
        created_at: null, updated_at: null,
      };
      const { server } = appFor({ is_platform_admin: true }, nullComposite);
      const operation = request(server)[method](path);
      const response = body ? await operation.send(body) : await operation;
      expect(response.status, response.text).toBe(404);
      expect(dispatchWebhookEvent).not.toHaveBeenCalled();
    });

  it('preserves a valid composite row and emits its organization webhook', async () => {
    const valid = {
      id: TARGET, public_id: 'FOL-VALID', name: 'renamed', owner_scope: 'ORG',
      user_id: null, org_id: ORG, context_org_id: null, parent_folder_id: null,
      connector_provider: null, connector_source_id: null, connector_connection_id: null,
      created_at: '2026-09-14T00:00:00Z', updated_at: '2026-09-14T00:00:00Z',
    };
    const { server } = appFor({ is_platform_admin: true }, valid);
    const response = await request(server).patch(`/folders/${TARGET}`).send({ name: 'renamed' });
    expect(response.status, response.text).toBe(200);
    expect(response.body.folder).toEqual(valid);
    expect(dispatchWebhookEvent).toHaveBeenCalledWith(
      ORG, 'folder.updated', expect.any(String),
      expect.objectContaining({ folder_public_id: 'FOL-VALID' }),
    );
  });
});
