/**
 * `POST /api/v1/agents/:agentId/key` — minting a fresh API key must be
 * ORG_ADMIN-only, same as suspend and revoke (PR #3083 follow-on).
 *
 * `getCallerOrgId` here was called WITHOUT `requireAdmin: true`, so any
 * ordinary org member could mint a live, working credential for any agent in
 * their org. Agent registration has been admin-only since migration 0158,
 * and suspend/revoke closed the same gap on the lifecycle routes — minting a
 * credential is at least as privileged as suspending one, so leaving this
 * route member-reachable was the asymmetric half of that fix left open.
 */
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createChainableBuilder as builder, routeDbTables } from '../../test-utils/chainable-builder.js';

const dbFromMock = vi.fn();
vi.mock('../../utils/db.js', () => ({ db: { from: (...args: unknown[]) => dbFromMock(...args), rpc: vi.fn() } }));
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../utils/auditEvent.js', () => ({ recordAuditEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../config.js', () => ({ config: { apiKeyHmacSecret: 'test-hmac-secret' } }));

import { agentsRouter } from './agents.js';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '33333333-3333-3333-3333-333333333333';
const AGENT_ID = '22222222-2222-2222-2222-222222222222';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { authUserId: string; hmacSecret: string }).authUserId = USER_ID;
    (req as unknown as { authUserId: string; hmacSecret: string }).hmacSecret = 'test-hmac-secret';
    next();
  });
  app.use('/api/v1/agents', agentsRouter);
  return app;
}

const activeRow = { id: AGENT_ID, org_id: ORG_ID, name: 'a', status: 'active', allowed_scopes: ['verify'] };
const mintedKeyRow = {
  id: 'key-1',
  name: 'a — auto-generated',
  key_prefix: 'ak_test',
  scopes: ['verify'],
  created_at: '2026-01-01T00:00:00Z',
};

function setup(role: string) {
  const agents = builder({ data: activeRow });
  const apiKeys = builder({ data: mintedKeyRow });
  routeDbTables(dbFromMock, {
    profiles: builder({ data: { org_id: ORG_ID, role } }),
    agents,
    api_keys: apiKeys,
  });
  return { agents, apiKeys };
}

beforeEach(() => { vi.clearAllMocks(); dbFromMock.mockReset(); });

describe('POST /:agentId/key — key minting is ORG_ADMIN-only', () => {
  it('refuses a non-admin org member with 403 and never inserts a key row', async () => {
    const { agents, apiKeys } = setup('ORG_MEMBER');

    const res = await request(createApp()).post(`/api/v1/agents/${AGENT_ID}/key`);

    expect(res.status).toBe(403);
    // The 403 must land BEFORE any agent lookup or key insert — a 403 issued
    // after the key was already minted is worthless.
    expect(agents.select).not.toHaveBeenCalled();
    expect(apiKeys.insert).not.toHaveBeenCalled();
  });

  it('still allows an ORG_ADMIN to mint a key', async () => {
    const { apiKeys } = setup('ORG_ADMIN');

    const res = await request(createApp()).post(`/api/v1/agents/${AGENT_ID}/key`);

    expect(res.status).toBe(201);
    expect(apiKeys.insert).toHaveBeenCalledWith(expect.objectContaining({
      org_id: ORG_ID,
      agent_id: AGENT_ID,
    }));
  });
});
