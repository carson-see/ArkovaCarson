import { beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Request, type Response } from 'express';
import { SignJWT } from 'jose';
import request from 'supertest';

const { fromMock, rpcMock } = vi.hoisted(() => ({
  fromMock: vi.fn(), rpcMock: vi.fn(),
}));

const TEST_SECRET = 'uat19-mounted-queue-auth-secret';
vi.mock('../config.js', () => ({ config: { supabaseJwtSecret: 'uat19-mounted-queue-auth-secret', environment: 'test' } }));
vi.mock('../utils/db.js', () => ({ db: { from: fromMock, rpc: rpcMock } }));
vi.mock('../utils/rpc.js', () => ({ callRpc: (...args: unknown[]) => rpcMock(...args) }));
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../notifications/dispatcher.js', () => ({ emitOrgAdminNotifications: vi.fn() }));
vi.mock('../jobs/batch-anchor.js', () => ({ processBatchAnchors: vi.fn() }));
vi.mock('../jobs/org-queue-scheduler.js', () => ({ recordOrgQueueRunResult: vi.fn() }));

import { handleListPendingResolution, handleResolveQueue } from '../api/queue-resolution.js';
import { extractAuthUserId } from './middleware.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';

async function token(aal: 'aal1' | 'aal2', expiresIn: string | number = '1h') {
  return new SignJWT({ sub: USER_ID, role: 'authenticated', aal })
    .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(expiresIn)
    .sign(new TextEncoder().encode(TEST_SECRET));
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.get('/api/queue/pending', async (req: Request, res: Response) => {
    const userId = await extractAuthUserId(req);
    if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }
    await handleListPendingResolution(req, res, userId);
  });
  app.post('/api/queue/resolve', async (req: Request, res: Response) => {
    const userId = await extractAuthUserId(req);
    if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }
    await handleResolveQueue(req, res, userId);
  });
  return app;
}

function chain(result: unknown) {
  const builder: Record<string, unknown> = {};
  const pass = () => builder;
  for (const method of ['select', 'eq', 'is', 'not', 'order', 'limit']) builder[method] = pass;
  builder.maybeSingle = () => Promise.resolve(result);
  builder.then = (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return builder;
}

describe('mounted queue organization contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects missing session before any queue handler database access', async () => {
    const response = await request(buildApp()).get('/api/queue/pending');
    expect(response.status).toBe(401);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('rejects AAL1, expired AAL2, and malformed JWTs before database access', async () => {
    for (const bearer of [await token('aal1'), await token('aal2', -1), 'invalid-jwt']) {
      const response = await request(buildApp()).get('/api/queue/pending')
        .set('Authorization', `Bearer ${bearer}`);
      expect(response.status).toBe(401);
    }
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed selected organization through the mounted GET query parser', async () => {
    const response = await request(buildApp()).get('/api/queue/pending?org_id=not-a-uuid')
      .set('Authorization', `Bearer ${await token('aal2')}`);
    expect(response.status).toBe(400);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('allows an exact secondary owner with no primary profile organization', async () => {
    const orgId = '22222222-2222-4222-8222-222222222222';
    fromMock.mockImplementation((table: string) => {
      if (table === 'profiles') return chain({ data: { org_id: null, role: 'ORG_MEMBER', is_platform_admin: false }, error: null });
      if (table === 'org_members') return chain({ data: { role: 'owner' }, error: null });
      if (table === 'anchors') return chain({ data: [], error: null });
      throw new Error(`unexpected table ${table}`);
    });
    const response = await request(buildApp()).get(`/api/queue/pending?org_id=${orgId}`)
      .set('Authorization', `Bearer ${await token('aal2')}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: [], count: 0 });
  });

  it('denies a stale primary ORG_ADMIN who is only a member of the selected org', async () => {
    const orgId = '22222222-2222-4222-8222-222222222222';
    fromMock.mockImplementation((table: string) => {
      if (table === 'profiles') return chain({ data: {
        org_id: '11111111-1111-4111-8111-111111111111', role: 'ORG_ADMIN', is_platform_admin: false,
      }, error: null });
      if (table === 'org_members') return chain({ data: { role: 'member' }, error: null });
      if (table === 'organizations') return chain({ data: { parent_org_id: null, parent_approval_status: null }, error: null });
      if (table === 'anchors') throw new Error('denied caller reached anchors');
      throw new Error(`unexpected table ${table}`);
    });
    const response = await request(buildApp()).get(`/api/queue/pending?org_id=${orgId}`)
      .set('Authorization', `Bearer ${await token('aal2')}`);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('forbidden');
  });

  it('returns a bounded conflict before RPC when mounted resolve org does not match selected anchor', async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === 'profiles') return chain({ data: { org_id: null, role: null, is_platform_admin: true }, error: null });
      if (table === 'anchors') return chain({
        data: { org_id: '33333333-3333-4333-8333-333333333333', metadata: { external_file_id: 'file-1' } },
        error: null,
      });
      throw new Error(`unexpected table ${table}`);
    });
    const response = await request(buildApp()).post('/api/queue/resolve')
      .set('Authorization', `Bearer ${await token('aal2')}`).send({
      external_file_id: 'file-1', selected_public_id: 'PUBLIC-1',
      org_id: '22222222-2222-4222-8222-222222222222',
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('conflict');
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('denies resolve authority before looking up the selected anchor', async () => {
    const orgId = '22222222-2222-4222-8222-222222222222';
    fromMock.mockImplementation((table: string) => {
      if (table === 'profiles') return chain({ data: {
        org_id: '11111111-1111-4111-8111-111111111111', role: 'ORG_ADMIN', is_platform_admin: false,
      }, error: null });
      if (table === 'org_members') return chain({ data: { role: 'member' }, error: null });
      if (table === 'organizations') return chain({ data: { parent_org_id: null, parent_approval_status: null }, error: null });
      if (table === 'anchors') throw new Error('unauthorized caller reached selected anchor lookup');
      throw new Error(`unexpected table ${table}`);
    });

    const response = await request(buildApp()).post('/api/queue/resolve')
      .set('Authorization', `Bearer ${await token('aal2')}`).send({
        external_file_id: 'file-1', selected_public_id: 'PUBLIC-1', org_id: orgId,
      });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('forbidden');
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
