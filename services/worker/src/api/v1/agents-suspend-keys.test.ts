import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createChainableBuilder as builder, routeDbTables } from '../../test-utils/chainable-builder.js';
const { dbFromMock, rpcMock } = vi.hoisted(() => ({ dbFromMock: vi.fn(), rpcMock: vi.fn() }));
vi.mock('../../utils/db.js', () => ({ db: { from: (...args: unknown[]) => dbFromMock(...args), rpc: rpcMock } }));
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../utils/auditEvent.js', () => ({ recordAuditEvent: vi.fn() }));
vi.mock('../../webhooks/agentEvents.js', () => ({ hintAgentWebhookDrain: vi.fn(), emitAgentEvent: vi.fn() }));
import { agentsRouter } from './agents.js';
const ORG='11111111-1111-1111-1111-111111111111', USER='33333333-3333-3333-3333-333333333333', AGENT='22222222-2222-2222-2222-222222222222';
const active={id:AGENT,org_id:ORG,status:'active',allowed_scopes:['verify']};
function app(){const a=express();a.use(express.json());a.use((req,_res,next)=>{req.authUserId=USER;next();});a.use('/api/v1/agents',agentsRouter);return a;}
function setup(role='ORG_ADMIN',row:Record<string,unknown>=active){routeDbTables(dbFromMock,{profiles:builder({data:{org_id:ORG,role}}),agents:builder({data:row})});}
beforeEach(()=>{vi.clearAllMocks();dbFromMock.mockReset();rpcMock.mockReset();});
describe('atomic organization agent suspension/resume',()=>{
 it.each(['suspended','active'] as const)('delegates %s to the row-locking RPC',async(status)=>{setup('ORG_ADMIN',{...active,status:status==='active'?'suspended':'active'});rpcMock.mockResolvedValue({data:{found:true,agent:{...active,status}},error:null});const res=await request(app()).patch(`/api/v1/agents/${AGENT}`).send({status});expect(res.status).toBe(200);expect(rpcMock).toHaveBeenCalledWith('apply_admin_agent_status_transition',{p_org_id:ORG,p_agent_id:AGENT,p_next_status:status,p_updates:{},p_actor_kind:'user',p_actor_id:USER});});
 it('maps provider or terminal database guards to 409',async()=>{setup();rpcMock.mockResolvedValue({data:null,error:{code:'23514',message:'computeid_provider_suspension_active'}});const res=await request(app()).patch(`/api/v1/agents/${AGENT}`).send({status:'active'});expect(res.status).toBe(409);});
 it('returns 500 without success when the transaction fails',async()=>{setup();rpcMock.mockResolvedValue({data:null,error:{message:'audit failure'}});const res=await request(app()).patch(`/api/v1/agents/${AGENT}`).send({status:'suspended'});expect(res.status).toBe(500);});
 it('rejects member mutation before invoking the RPC',async()=>{setup('ORG_MEMBER');const res=await request(app()).patch(`/api/v1/agents/${AGENT}`).send({status:'suspended'});expect(res.status).toBe(403);expect(rpcMock).not.toHaveBeenCalled();});
});
