/**
 * `PATCH /api/v1/agents/:agentId` — revoked is terminal (SCRUM-4493 follow-on).
 *
 * Passport revocations (and DELETE /:agentId) set status 'revoked'. Before this
 * guard an org admin could PATCH {status:'active'} onto a revoked row and then
 * mint keys via POST /:agentId/key, undoing a partner revocation.
 */
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createChainableBuilder as builder, routeDbTables } from '../../test-utils/chainable-builder.js';

const { dbFromMock, rpcMock } = vi.hoisted(() => ({ dbFromMock: vi.fn(), rpcMock: vi.fn() }));
vi.mock('../../utils/db.js', () => ({ db: { from: (...args: unknown[]) => dbFromMock(...args), rpc: rpcMock } }));
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../utils/auditEvent.js', () => ({ recordAuditEvent: vi.fn().mockResolvedValue(undefined) }));

import { agentsRouter } from './agents.js';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '33333333-3333-3333-3333-333333333333';
const AGENT_ID = '22222222-2222-2222-2222-222222222222';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as unknown as { authUserId: string }).authUserId = USER_ID; next(); });
  app.use('/api/v1/agents', agentsRouter);
  return app;
}
const revokedRow = { id: AGENT_ID, org_id: ORG_ID, name: 'a', status: 'revoked', allowed_scopes: ['verify'] };

beforeEach(() => { vi.clearAllMocks(); dbFromMock.mockReset(); rpcMock.mockReset(); });

describe('PATCH /api/v1/agents/:agentId on a revoked agent', () => {
  it('409 when the patch tries to change status (revocation is terminal)', async () => {
    const agents = builder({ data: revokedRow });
    routeDbTables(dbFromMock, { profiles: builder({ data: { org_id: ORG_ID, role: 'ORG_ADMIN' } }), agents });
    const res = await request(createApp()).patch(`/api/v1/agents/${AGENT_ID}`).send({ status: 'active' });
    expect(res.status).toBe(409);
    expect(agents.update).not.toHaveBeenCalled();
  });
  it('still allows non-status edits (name) on a revoked agent', async () => {
    const agents = builder([{ data: revokedRow }, { data: { ...revokedRow, name: 'renamed' } }]);
    routeDbTables(dbFromMock, { profiles: builder({ data: { org_id: ORG_ID, role: 'ORG_ADMIN' } }), agents });
    const res = await request(createApp()).patch(`/api/v1/agents/${AGENT_ID}`).send({ name: 'renamed' });
    expect(res.status).toBe(200);
    expect(agents.update).toHaveBeenCalledWith(expect.objectContaining({ name: 'renamed' }));
  });
});


it('returns 409 when the atomic RPC rejects a stale resume after concurrent revocation', async () => {
  const agents = builder({ data: { ...revokedRow, status: 'active' } });
  routeDbTables(dbFromMock, { profiles: builder({ data: { org_id: ORG_ID, role: 'ORG_ADMIN' } }), agents });
  rpcMock.mockResolvedValue({ data: null, error: { code: '23514', message: 'agent_revocation_is_terminal' } });
  const response = await request(createApp()).patch(`/api/v1/agents/${AGENT_ID}`).send({ status: 'active' });
  expect(response.status).toBe(409);
  expect(rpcMock).toHaveBeenCalled();
});
