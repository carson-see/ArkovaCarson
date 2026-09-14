import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/db.js', () => ({ db: {} }));
vi.mock('../../utils/logger.js', () => ({ logger: { warn: vi.fn() } }));
vi.mock('../../webhooks/delivery.js', () => ({ dispatchWebhookEvent: vi.fn() }));

import { createDefaultFolderApiDeps } from './folders-deps.js';
import { createFoldersRouter } from './folders.js';

const PLATFORM = '99999999-0000-4000-8000-000000000001';
const TARGET = '88888888-0000-4000-8000-000000000001';
const ORG = 'dddddddd-0000-4000-8000-000000000001';

function query(data: unknown) {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.in = vi.fn(() => chain);
  chain.limit = vi.fn(() => chain);
  chain.single = vi.fn(async () => ({ data, error: null }));
  chain.maybeSingle = vi.fn(async () => ({ data, error: null }));
  return chain;
}

function appFor(profile: { is_platform_admin: boolean } | null) {
  const rpc = vi.fn(async () => ({ data: [], error: null }));
  const from = vi.fn((table: string) => {
    if (table === 'profiles') return query(profile);
    if (table === 'org_members') return query(null);
    if (table === 'organizations') return query({ parent_org_id: null, parent_approval_status: null });
    throw new Error(`unexpected table ${table}`);
  });
  const server = express();
  server.use((req, _res, next) => { req.authUserId = PLATFORM; next(); });
  server.use('/folders', createFoldersRouter(createDefaultFolderApiDeps({ from, rpc } as never)));
  return { server, from, rpc };
}

describe('SCRUM-5252 production folder adapter', () => {
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
});
