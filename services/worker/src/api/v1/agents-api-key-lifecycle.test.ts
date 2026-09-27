import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createChainableBuilder as builder, routeDbTables } from '../../test-utils/chainable-builder.js';

const { dbFromMock, rpcMock, auditMock, agentEventMock } = vi.hoisted(() => ({
  dbFromMock: vi.fn(), rpcMock: vi.fn(), auditMock: vi.fn(), agentEventMock: vi.fn(),
}));
vi.mock('../../utils/db.js', () => ({ db: { from: (...args: unknown[]) => dbFromMock(...args), rpc: rpcMock } }));
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../utils/auditEvent.js', () => ({ recordAuditEvent: auditMock }));
vi.mock('../../config.js', () => ({ config: { apiKeyHmacSecret: 'machine-test-hmac' } }));
vi.mock('../../webhooks/agentEvents.js', () => ({ emitAgentEvent: agentEventMock, hintAgentWebhookDrain: vi.fn() }));

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
    rpcMock.mockResolvedValue({ data: { found: true, changed: true }, error: null });
    const response = await request(app()).delete(`/api/v1/agents/${AGENT}`);
    expect(response.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith('revoke_agent_and_keys_as_api_key_with_outbox', {
      p_org_id: ORG, p_agent_id: AGENT, p_actor_api_key_id: KEY,
    });
    expect(agentEventMock).not.toHaveBeenCalled();
  });
  it('suppresses revocation when the RPC reports changed=false', async () => {
    const agents = builder({ data: { id: AGENT, org_id: ORG, status: 'revoked' } }); routeDbTables(dbFromMock, { agents });
    rpcMock.mockResolvedValue({ data: { found: true, changed: false }, error: null });
    expect((await request(app()).delete(`/api/v1/agents/${AGENT}`)).status).toBe(200);
    expect(agentEventMock).not.toHaveBeenCalled();
  });
  it('registers within the machine delegation ceiling with owner FK and machine audit', async () => {
    const row = { id: AGENT, org_id: ORG, registered_by: OWNER, name: 'bot', allowed_scopes: ['verify'], metadata: { environment: 'staging' } };
    const agents = builder({ data: row }); routeDbTables(dbFromMock, { agents });
    rpcMock.mockResolvedValue({ data: { agent: row }, error: null });
    const response = await request(app()).post('/api/v1/agents').send({
      name: 'bot', allowed_scopes: ['verify'], metadata: { environment: 'staging' },
    });
    expect(response.status).toBe(201);
    expect(rpcMock).toHaveBeenCalledWith('register_agent_with_outbox', expect.objectContaining({
      p_org_id: ORG, p_actor_kind: 'api_key', p_actor_id: KEY,
      p_metadata: { environment: 'staging' },
    }));
    expect(agentEventMock).not.toHaveBeenCalled();
    expect(response.body.metadata).toEqual({ environment: 'staging' });
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
    const agents = builder([{ data: { id: AGENT, org_id: ORG, status: 'active' } }, { data: { id: AGENT, org_id: ORG, name: 'renamed', status: 'active', updated_at: '2026-09-26T14:00:00.000Z' } }]);
    routeDbTables(dbFromMock, { agents });
    rpcMock.mockResolvedValue({ data: { found: true, changed: true, agent: { id: AGENT, name: 'renamed', status: 'active' } }, error: null });
    const response = await request(app()).patch(`/api/v1/agents/${AGENT}`).send({ name: 'renamed', allowed_scopes: ['verify'] });
    expect(response.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith('update_agent_with_outbox', expect.objectContaining({
      p_actor_kind: 'api_key', p_actor_id: KEY,
      p_updates: { name: 'renamed', allowed_scopes: ['verify'] },
    }));
    expect(agentEventMock).not.toHaveBeenCalled();
  });

  it('mints a child key only when caller satisfies every agent scope', async () => {
    const agents = builder({ data: { id: AGENT, org_id: ORG, name: 'bot', status: 'active', allowed_scopes: ['verify'] } });
    const keys = builder({ data: { id: 'child', key_prefix: 'ak_live_child', scopes: ['verify'], created_at: 'now' } });
    routeDbTables(dbFromMock, { agents, api_keys: keys });
    rpcMock.mockResolvedValue({ data: { found: true,
      agent: { id: AGENT, org_id: ORG, name: 'bot', status: 'active', allowed_scopes: ['verify'] },
      key: { id: 'child', key_prefix: 'ak_live_child', scopes: ['verify'], created_at: 'now' } }, error: null });
    const response = await request(app()).post(`/api/v1/agents/${AGENT}/key`);
    expect(response.status).toBe(201);
    expect(rpcMock).toHaveBeenCalledWith('create_agent_key_with_outbox', expect.objectContaining({
      p_org_id: ORG, p_agent_id: AGENT, p_actor_kind: 'api_key', p_actor_id: KEY,
    }));
    expect(agentEventMock).not.toHaveBeenCalled();
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
    rpcMock.mockResolvedValue({ data: { found: true, changed: true, agent: { id: AGENT, status: 'suspended', name: 'paused', updated_at: '2026-09-26T14:00:00.000Z' } }, error: null });
    const response = await request(app(['agents:manage', 'orgs:manage'])).patch(`/api/v1/agents/${AGENT}`).send({ status: 'suspended', name: 'paused', allowed_scopes: ['read:orgs'] });
    expect(response.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith('apply_admin_agent_status_transition_with_outbox', expect.objectContaining({ p_actor_kind: 'api_key', p_actor_id: KEY, p_updates: { name: 'paused', allowed_scopes: ['read:orgs'] } }));
    expect(agents.update).not.toHaveBeenCalled();
    expect(agentEventMock).not.toHaveBeenCalled();
  });

  it('suppresses status notification when the authoritative RPC reports changed=false', async () => {
    const agents = builder({ data: { id: AGENT, org_id: ORG, status: 'suspended', metadata: {} } }); routeDbTables(dbFromMock, { agents });
    rpcMock.mockResolvedValue({ data: { found: true, changed: false, agent: { id: AGENT, status: 'suspended' } }, error: null });
    expect((await request(app()).patch(`/api/v1/agents/${AGENT}`).send({ status: 'suspended' })).status).toBe(200);
    expect(agentEventMock).not.toHaveBeenCalled();
  });

  it('denies status-only resume when existing scopes exceed the machine caller ceiling', async () => {
    const agents = builder({ data: { id: AGENT, org_id: ORG, status: 'suspended', metadata: {}, allowed_scopes: ['anchor:write'] } });
    routeDbTables(dbFromMock, { agents });
    const response = await request(app(['agents:manage'])).patch(`/api/v1/agents/${AGENT}`).send({ status: 'active' });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'delegation_scope_exceeded', missing: ['anchor:write'] });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('maps and scrubs authoritative transition authorization failures', async () => {
    const agents = builder({ data: { id: AGENT, org_id: ORG, status: 'suspended', metadata: {}, allowed_scopes: ['verify'] } });
    routeDbTables(dbFromMock, { agents });
    rpcMock.mockResolvedValue({ data: null, error: { code: '42501', message: 'private SQL detail' } });
    const response = await request(app()).patch(`/api/v1/agents/${AGENT}`).send({ status: 'active' });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'forbidden' });
  });

});
