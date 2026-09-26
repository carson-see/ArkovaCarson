import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createChainableBuilder as builder, routeDbTables } from '../../test-utils/chainable-builder.js';

const { dbFromMock, rpcMock, auditMock } = vi.hoisted(() => ({
  dbFromMock: vi.fn(), rpcMock: vi.fn(), auditMock: vi.fn(),
}));
vi.mock('../../utils/db.js', () => ({ db: { from: (...args: unknown[]) => dbFromMock(...args), rpc: rpcMock } }));
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../utils/auditEvent.js', () => ({ recordAuditEvent: auditMock }));
vi.mock('../../config.js', () => ({ config: { apiKeyHmacSecret: 'machine-test-hmac' } }));

import { agentsRouter } from './agents.js';
const ORG = '11111111-1111-1111-1111-111111111111';
const KEY = '22222222-2222-2222-2222-222222222222';
const OWNER = '33333333-3333-3333-3333-333333333333';
const AGENT = '44444444-4444-4444-4444-444444444444';

function app(scopes = ['agents:manage', 'verify']) {
  const result = express(); result.use(express.json());
  result.use((req, _res, next) => { req.apiKey = { keyId: KEY, keyPrefix: 'ak_live_test', orgId: ORG, userId: OWNER, scopes, rateLimitTier: 'paid' }; next(); });
  result.use('/api/v1/agents', agentsRouter); return result;
}

beforeEach(() => { vi.clearAllMocks(); dbFromMock.mockReset(); rpcMock.mockReset(); });

describe('generic agent lifecycle API-key caller', () => {
  it('lists only the trusted key tenant without a profile query', async () => {
    const agents = builder({ data: [{ id: AGENT, org_id: ORG, registered_by: OWNER, name: 'bot' }] });
    routeDbTables(dbFromMock, { agents });
    const response = await request(app()).get('/api/v1/agents');
    expect(response.status).toBe(200);
    expect(agents.eq).toHaveBeenCalledWith('org_id', ORG);
    expect(dbFromMock).not.toHaveBeenCalledWith('profiles');
    expect(response.body.agents[0]).not.toHaveProperty('org_id');
  });

  it('rejects registration beyond the caller scope ceiling before inserts', async () => {
    const agents = builder({ data: null }); routeDbTables(dbFromMock, { agents });
    const response = await request(app(['agents:manage'])).post('/api/v1/agents').send({ name: 'bot', allowed_scopes: ['verify'] });
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: 'delegation_scope_exceeded', missing: ['verify'] });
    expect(agents.insert).not.toHaveBeenCalled();
  });

  it('uses the machine revocation RPC and never impersonates the key owner', async () => {
    const agents = builder({ data: { id: AGENT, org_id: ORG, status: 'active' } });
    routeDbTables(dbFromMock, { agents });
    rpcMock.mockResolvedValue({ data: { found: true }, error: null });
    const response = await request(app()).delete(`/api/v1/agents/${AGENT}`);
    expect(response.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith('revoke_agent_and_keys_as_api_key', {
      p_org_id: ORG, p_agent_id: AGENT, p_actor_api_key_id: KEY,
    });
  });
  it('registers within the machine delegation ceiling with owner FK and machine audit', async () => {
    const row = { id: AGENT, org_id: ORG, registered_by: OWNER, name: 'bot', allowed_scopes: ['verify'] };
    const agents = builder({ data: row }); routeDbTables(dbFromMock, { agents });
    const response = await request(app()).post('/api/v1/agents').send({ name: 'bot', allowed_scopes: ['verify'] });
    expect(response.status).toBe(201);
    expect(agents.insert).toHaveBeenCalledWith(expect.objectContaining({ org_id: ORG, registered_by: OWNER }));
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ actor_id: null, org_id: ORG, details: expect.stringContaining('"actor_api_key_id"') }));
  });

  it('gets one tenant-owned agent and its active key metadata', async () => {
    const agents = builder({ data: { id: AGENT, org_id: ORG, registered_by: OWNER, name: 'bot' } });
    const keys = builder({ data: [{ id: KEY, key_prefix: 'ak_live_test' }] });
    routeDbTables(dbFromMock, { agents, api_keys: keys });
    const response = await request(app()).get(`/api/v1/agents/${AGENT}`);
    expect(response.status).toBe(200);
    expect(agents.eq).toHaveBeenCalledWith('org_id', ORG);
    expect(keys.eq).toHaveBeenCalledWith('org_id', ORG);
  });

  it('patches a tenant-owned agent within the caller scope ceiling', async () => {
    const agents = builder([{ data: { id: AGENT, org_id: ORG, status: 'active' } }, { data: { id: AGENT, org_id: ORG, name: 'renamed', status: 'active' } }]);
    routeDbTables(dbFromMock, { agents });
    const response = await request(app()).patch(`/api/v1/agents/${AGENT}`).send({ name: 'renamed', allowed_scopes: ['verify'] });
    expect(response.status).toBe(200);
    expect(agents.update).toHaveBeenCalledWith(expect.objectContaining({ name: 'renamed', allowed_scopes: ['verify'] }));
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ actor_id: null, org_id: ORG }));
  });

  it('mints a child key only when caller satisfies every agent scope', async () => {
    const agents = builder({ data: { id: AGENT, org_id: ORG, name: 'bot', status: 'active', allowed_scopes: ['verify'] } });
    const keys = builder({ data: { id: 'child', key_prefix: 'ak_live_child', scopes: ['verify'], created_at: 'now' } });
    routeDbTables(dbFromMock, { agents, api_keys: keys });
    const response = await request(app()).post(`/api/v1/agents/${AGENT}/key`);
    expect(response.status).toBe(201);
    expect(keys.insert).toHaveBeenCalledWith(expect.objectContaining({ org_id: ORG, agent_id: AGENT, created_by: OWNER, scopes: ['verify'] }));
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ actor_id: null, org_id: ORG }));
  });

  it('cannot manually resume a provider-suspended ComputeID agent', async () => {
    const agents = builder({ data: { id: AGENT, org_id: ORG, status: 'suspended', metadata: { computeid: { suspended_by: 'computeid' } } } });
    routeDbTables(dbFromMock, { agents });
    const response = await request(app()).patch(`/api/v1/agents/${AGENT}`).send({ status: 'active' });
    expect(response.status).toBe(409);
    expect(agents.update).not.toHaveBeenCalled();
  });

  it('cannot expand a ComputeID-bound agent beyond the provider scope ceiling', async () => {
    const agents = builder({ data: { id: AGENT, org_id: ORG, status: 'active', metadata: { computeid: { issuer: 'computeid', passport_id: 'p' } } } });
    routeDbTables(dbFromMock, { agents });
    const response = await request(app(['agents:manage', 'webhooks:manage'])).patch(`/api/v1/agents/${AGENT}`).send({ allowed_scopes: ['webhooks:manage'] });
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('provider_scope_ceiling_exceeded');
    expect(agents.update).not.toHaveBeenCalled();
  });

  it('cannot expand a ComputeID-bound agent beyond provider scope ceiling', async () => {
    const agents = builder({ data: { id: AGENT, org_id: ORG, status: 'active', metadata: { computeid: { issuer: 'computeid', passport_id: 'p' } } } });
    routeDbTables(dbFromMock, { agents });
    const response = await request(app(['agents:manage', 'webhooks:manage'])).patch(`/api/v1/agents/${AGENT}`).send({ allowed_scopes: ['webhooks:manage'] });
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('provider_scope_ceiling_exceeded');
    expect(agents.update).not.toHaveBeenCalled();
  });

  it('sends machine status plus fields through one atomic RPC with alias-aware delegation', async () => {
    const agents = builder({ data: { id: AGENT, org_id: ORG, status: 'active', metadata: {} } });
    routeDbTables(dbFromMock, { agents });
    rpcMock.mockResolvedValue({ data: { found: true, agent: { id: AGENT, status: 'suspended', name: 'paused' } }, error: null });
    const response = await request(app(['agents:manage', 'orgs:manage'])).patch(`/api/v1/agents/${AGENT}`).send({ status: 'suspended', name: 'paused', allowed_scopes: ['read:orgs'] });
    expect(response.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith('apply_admin_agent_status_transition', expect.objectContaining({ p_actor_kind: 'api_key', p_actor_id: KEY, p_updates: { name: 'paused', allowed_scopes: ['read:orgs'] } }));
    expect(agents.update).not.toHaveBeenCalled();
  });

});
