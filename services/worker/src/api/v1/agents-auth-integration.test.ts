import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createChainableBuilder as builder, routeDbTables } from '../../test-utils/chainable-builder.js';
const { dbFromMock, rpcMock } = vi.hoisted(() => ({ dbFromMock: vi.fn(), rpcMock: vi.fn() }));
vi.mock('../../utils/db.js', () => ({ db: { from: (...args: unknown[]) => dbFromMock(...args), rpc: rpcMock } }));
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../utils/auditEvent.js', () => ({ recordAuditEvent: vi.fn() }));
vi.mock('../../auth.js', () => ({ verifyAuthToken: vi.fn() }));
vi.mock('../../config.js', () => ({ config: {} }));
vi.mock('../../webhooks/agentEvents.js', () => ({ emitAgentEvent: vi.fn(), hintAgentWebhookDrain: vi.fn() }));
import { apiKeyAuth, hashApiKey } from '../../middleware/apiKeyAuth.js';
import { requireAgentLifecycleAuth } from '../../middleware/agentLifecycleAuth.js';
import { agentsMaintenanceRouter } from './agents-maintenance.js';
const SECRET = 'integration-hmac'; const RAW = 'ak_live_integration';
const ORG = '11111111-1111-1111-1111-111111111111';
function app() { const a=express(); a.use(express.json()); a.use(apiKeyAuth(SECRET)); a.use('/api/v1/agents', requireAgentLifecycleAuth, agentsMaintenanceRouter); return a; }
function authRow(scopes: string[]) { return { id:'key', org_id:ORG, created_by:'owner', scopes, rate_limit_tier:'paid', key_prefix:'ak_live_int', is_active:true, expires_at:null, revoked_at:null, key_hash:hashApiKey(RAW,SECRET) }; }
beforeEach(()=>{ vi.clearAllMocks(); dbFromMock.mockReset(); rpcMock.mockReset(); });
describe('real API-key auth to generic lifecycle wiring',()=>{
  it('authenticates an agents:manage key and reaches tenant-scoped list',async()=>{
    const keys=builder({data:authRow(['agents:manage'])}); const agents=builder({data:[]}); routeDbTables(dbFromMock,{api_keys:keys,agents});
    const res=await request(app()).get('/api/v1/agents').set('X-API-Key',RAW);
    expect(res.status).toBe(200); expect(agents.eq).toHaveBeenCalledWith('org_id',ORG);
  });
  it('stops wrong scope before any agents query',async()=>{
    const keys=builder({data:authRow(['verify'])}); routeDbTables(dbFromMock,{api_keys:keys});
    const res=await request(app()).post('/api/v1/agents').set('X-API-Key',RAW).send({name:'x'});
    expect(res.status).toBe(403); expect(dbFromMock).not.toHaveBeenCalledWith('agents');
  });
  it('stops an invalid key before any agents query',async()=>{
    const keys=builder({data:null,error:{message:'not found'}}); routeDbTables(dbFromMock,{api_keys:keys});
    const res=await request(app()).get('/api/v1/agents').set('X-API-Key','ak_live_bad');
    expect(res.status).toBe(401); expect(dbFromMock).not.toHaveBeenCalledWith('agents');
  });
  it('still authenticates before the compatibility maintenance boundary',async()=>{
    const res=await request(app()).post('/api/v1/agents').send({name:'x'});
    expect(res.status).toBe(401);
    expect(res.body.error.code).not.toBe('compatibility_floor_read_only');
    expect(dbFromMock).not.toHaveBeenCalledWith('agents');
  });
  it.each([
    ['post','/api/v1/agents',{name:'x'}],
    ['patch','/api/v1/agents/22222222-2222-4222-8222-222222222222',{name:'x'}],
    ['post','/api/v1/agents/22222222-2222-4222-8222-222222222222/key',undefined],
  ] as const)('returns the immutable maintenance response for %s %s without an agent write',async(method,url,body)=>{
    const keys=builder({data:authRow(['agents:manage'])}); routeDbTables(dbFromMock,{api_keys:keys});
    const call=request(app())[method](url).set('X-API-Key',RAW);
    const res=body===undefined?await call:await call.send(body);
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('300');
    expect(res.body).toEqual({error:{code:'compatibility_floor_read_only',message:'Agent lifecycle mutations are temporarily unavailable during compatibility maintenance.'}});
    expect(dbFromMock).not.toHaveBeenCalledWith('agents');
  });
  it('allows authenticated emergency revocation through the durable outbox transaction',async()=>{
    const agentId='22222222-2222-4222-8222-222222222222';
    const keys=builder({data:authRow(['agents:manage'])});
    const agents=builder({data:{id:agentId,org_id:ORG,status:'active'}});
    routeDbTables(dbFromMock,{api_keys:keys,agents});
    rpcMock.mockResolvedValue({data:{found:true,changed:true},error:null});
    const res=await request(app()).delete(`/api/v1/agents/${agentId}`).set('X-API-Key',RAW);
    expect(res.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith('revoke_agent_and_keys_as_api_key_with_outbox',{
      p_org_id:ORG,p_agent_id:agentId,p_actor_api_key_id:'key',
    });
  });
  it('rejects emergency revocation without agents:manage before agent lookup or RPC',async()=>{
    const agentId='22222222-2222-4222-8222-222222222222';
    const keys=builder({data:authRow(['verify'])});
    routeDbTables(dbFromMock,{api_keys:keys});
    const res=await request(app()).delete(`/api/v1/agents/${agentId}`).set('X-API-Key',RAW);
    expect(res.status).toBe(403);
    expect(dbFromMock).not.toHaveBeenCalledWith('agents');
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
