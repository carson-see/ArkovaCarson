import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createChainableBuilder as builder, routeDbTables } from '../../test-utils/chainable-builder.js';
const { dbFromMock } = vi.hoisted(() => ({ dbFromMock: vi.fn() }));
vi.mock('../../utils/db.js', () => ({ db: { from: (...args: unknown[]) => dbFromMock(...args) } }));
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../utils/auditEvent.js', () => ({ recordAuditEvent: vi.fn() }));
vi.mock('../../auth.js', () => ({ verifyAuthToken: vi.fn() }));
vi.mock('../../config.js', () => ({ config: {} }));
import { apiKeyAuth, hashApiKey } from '../../middleware/apiKeyAuth.js';
import { requireAgentLifecycleAuth } from '../../middleware/agentLifecycleAuth.js';
import { agentsRouter } from './agents.js';
const SECRET = 'integration-hmac'; const RAW = 'ak_live_integration';
const ORG = '11111111-1111-1111-1111-111111111111';
function app() { const a=express(); a.use(express.json()); a.use(apiKeyAuth(SECRET)); a.use('/api/v1/agents', requireAgentLifecycleAuth, agentsRouter); return a; }
function authRow(scopes: string[]) { return { id:'key', org_id:ORG, created_by:'owner', scopes, rate_limit_tier:'paid', key_prefix:'ak_live_int', is_active:true, expires_at:null, revoked_at:null, key_hash:hashApiKey(RAW,SECRET) }; }
beforeEach(()=>{ vi.clearAllMocks(); dbFromMock.mockReset(); });
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
});
