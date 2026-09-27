import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createChainableBuilder as builder, routeDbTables } from '../../test-utils/chainable-builder.js';

const { dbFromMock, rpcMock, auditMock, hintMock } = vi.hoisted(() => ({
  dbFromMock: vi.fn(),
  rpcMock: vi.fn(),
  auditMock: vi.fn(),
  hintMock: vi.fn(),
}));

vi.mock('../../utils/db.js', () => ({
  db: { from: (...args: unknown[]) => dbFromMock(...args), rpc: rpcMock },
}));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../utils/auditEvent.js', () => ({ recordAuditEvent: auditMock }));
vi.mock('../../webhooks/agentEvents.js', () => ({ emitAgentEvent: vi.fn(), hintAgentWebhookDrain: hintMock }));

import { agentsRouter } from './agents.js';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const AGENT_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID = '33333333-3333-3333-3333-333333333333';
const activeAgent = { id: AGENT_ID, org_id: ORG_ID, name: 'a', status: 'active', allowed_scopes: ['verify'] };

function app() {
  const result = express();
  result.use(express.json());
  result.use((req, _res, next) => {
    (req as unknown as { authUserId: string }).authUserId = USER_ID;
    next();
  });
  result.use('/api/v1/agents', agentsRouter);
  return result;
}

function setup(role = 'ORG_ADMIN') {
  const agents = builder({ data: activeAgent });
  const apiKeys = builder({ data: null });
  routeDbTables(dbFromMock, {
    profiles: builder({ data: { org_id: ORG_ID, role } }),
    agents,
    api_keys: apiKeys,
  });
  return { agents, apiKeys };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbFromMock.mockReset();
  rpcMock.mockReset();
});

describe('DELETE /api/v1/agents/:agentId atomic revocation', () => {
  it('commits revocation through one service RPC and performs no route-level writes or audit', async () => {
    const { agents, apiKeys } = setup();
    rpcMock.mockResolvedValue({ data: { found: true, changed: true, status: 'revoked' }, error: null });

    const response = await request(app()).delete(`/api/v1/agents/${AGENT_ID}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'revoked', agent_id: AGENT_ID });
    expect(rpcMock).toHaveBeenCalledWith('revoke_agent_and_keys_with_outbox', {
      p_org_id: ORG_ID,
      p_agent_id: AGENT_ID,
      p_actor_id: USER_ID,
    });
    expect(agents.update).not.toHaveBeenCalled();
    expect(apiKeys.update).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
    expect(hintMock).toHaveBeenCalledOnce();
  });

  it('returns 500 and never reports success when the transaction fails', async () => {
    const { agents, apiKeys } = setup();
    rpcMock.mockResolvedValue({ data: null, error: { message: 'audit insert failed' } });

    const response = await request(app()).delete(`/api/v1/agents/${AGENT_ID}`);

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Failed to revoke agent' });
    expect(agents.update).not.toHaveBeenCalled();
    expect(apiKeys.update).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('maps a transaction-level not-found result without a success audit', async () => {
    setup();
    rpcMock.mockResolvedValue({ data: { found: false }, error: null });

    const response = await request(app()).delete(`/api/v1/agents/${AGENT_ID}`);

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Agent not found' });
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('rejects non-admin callers before invoking the privileged RPC', async () => {
    setup('ORG_MEMBER');

    const response = await request(app()).delete(`/api/v1/agents/${AGENT_ID}`);

    expect(response.status).toBe(403);
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
