import { describe,it,expect,vi,beforeEach } from 'vitest';
import { validateAuth, projectMcpAuditArgs } from './mcp-server.js';
const fetchMock=vi.fn();
beforeEach(()=>{fetchMock.mockReset();vi.stubGlobal('fetch',fetchMock);});
const env={SUPABASE_URL:'https://db.test',SUPABASE_SERVICE_ROLE_KEY:'service'};
const request=(headers:Record<string,string>)=>new Request('https://edge.test/mcp',{headers});
const jwtSecret='fixture-secret-with-at-least-thirty-two-bytes';
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
async function validJwt(){
 const now=Math.floor(Date.now()/1000);
 const prefix=`${encode({alg:'HS256',typ:'JWT'})}.${encode({sub:'user-jwt',role:'authenticated',aal:'aal2',aud:'authenticated',iss:'https://db.test/auth/v1',iat:now,exp:now+300})}`;
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(jwtSecret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const signature=Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(prefix))).toString('base64url');
 return `${prefix}.${signature}`;
}
describe('hosted lifecycle ingress ambiguity',()=>{
 it.each([
  {'X-API-Key':'ak_valid',Authorization:'Bearer jwt'},
  {'X-API-Key':'ak_valid',Authorization:'malformed'},
  {'X-API-Key':'ak_one',Authorization:'Bearer ak_two'},
 ])('rejects dual credential shape %# before validation',async(headers)=>{expect(await validateAuth(request(headers),env as never)).toBeNull();expect(fetchMock).not.toHaveBeenCalled();});
 it('accepts one valid API key header',async()=>{fetchMock.mockResolvedValueOnce(Response.json({user_id:'u',tier:'free',api_key_id:'k',scopes:['agents:manage']}));const result=await validateAuth(request({'X-API-Key':'ak_valid'}),env as never);expect(result?.callerApiKey).toBe('ak_valid');expect(fetchMock).toHaveBeenCalledTimes(1);});
 it('accepts one valid bearer header',async()=>{const token=await validJwt();fetchMock.mockResolvedValueOnce(Response.json({id:'user-jwt'}));const result=await validateAuth(request({Authorization:`Bearer ${token}`}),{...env,SUPABASE_JWT_SECRET:jwtSecret} as never);expect(result?.callerAuthorization).toBe(`Bearer ${token}`);expect(fetchMock).toHaveBeenCalledTimes(1);});
 it('rejects a valid key plus a syntactically bearer invalid extra without validation',async()=>{expect(await validateAuth(request({'X-API-Key':'ak_valid',Authorization:'Bearer invalid.jwt'}),env as never)).toBeNull();expect(fetchMock).not.toHaveBeenCalled();});
 it('rejects an invalid key plus an otherwise valid bearer without fallback',async()=>{const token=await validJwt();expect(await validateAuth(request({'X-API-Key':'invalid-key',Authorization:`Bearer ${token}`}),{...env,SUPABASE_JWT_SECRET:jwtSecret} as never)).toBeNull();expect(fetchMock).not.toHaveBeenCalled();});
 it.each(['','   '])('rejects a presented empty/whitespace API-key header plus valid JWT without bearer fallback',async apiKey=>{const token=await validJwt();expect(await validateAuth(request({'X-API-Key':apiKey,Authorization:`Bearer ${token}`}),{...env,SUPABASE_JWT_SECRET:jwtSecret} as never)).toBeNull();expect(fetchMock).not.toHaveBeenCalled();});
 it.each(['','   '])('rejects a presented empty/whitespace API-key header plus Bearer API key without validation',async apiKey=>{expect(await validateAuth(request({'X-API-Key':apiKey,Authorization:'Bearer ak_valid'}),env as never)).toBeNull();expect(fetchMock).not.toHaveBeenCalled();});
 it('normalizes one exact duplicate API key',async()=>{fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({user_id:'u',tier:'free',api_key_id:'k',scopes:['agents:manage']}),{status:200}));const result=await validateAuth(request({'X-API-Key':'ak_same',Authorization:'Bearer ak_same'}),env as never);expect(result?.callerApiKey).toBe('ak_same');expect(result?.callerAuthorization).toBeNull();expect(fetchMock).toHaveBeenCalledTimes(1);});
});
describe('lifecycle telemetry projection',()=>{
 it('never serializes free text, metadata, receipts, caller keys, or returned keys',()=>{const sentinel='SENTINEL-SECRET';for(const tool of ['arkova_register_agent','arkova_update_agent','arkova_admit_computeid_agent','arkova_create_agent_key']){const projected=projectMcpAuditArgs(tool,{name:sentinel,metadata:{secret:sentinel},passport_id:sentinel,agent_id:sentinel,verification_receipt:{receipt_payload:sentinel},key:sentinel});expect(JSON.stringify(projected)).not.toContain(sentinel);}});
 it('keeps only validated safe identifiers',()=>{const id='aaaaaaaa-0000-4000-8000-000000000001';expect(projectMcpAuditArgs('arkova_update_agent',{agent_id:id,name:'secret'})).toEqual({agent_id:id});expect(projectMcpAuditArgs('arkova_admit_computeid_agent',{passport_id:id,verification_receipt:{secret:'x'}})).toEqual({passport_id:id});});
 it('does not persist private anchor tags or opaque cursors in MCP audit args',()=>{expect(projectMcpAuditArgs('arkova_list_anchors',{tag:'private-client',tag_scope:'user',cursor:'opaque-secret',limit:25})).toEqual({tag_scope:'user',limit:25});});
});
