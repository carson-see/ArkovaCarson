import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Arkova, ArkovaError } from './client';

const AGENT = {
  id: '11111111-1111-4111-8111-111111111111', name: 'Verifier', description: null,
  agent_type: 'custom', status: 'active', allowed_scopes: ['verify'], framework: null,
  version: null, callback_url: null, metadata: {},
};
const RECEIPT = { passport_id: AGENT.id, status: 'verified', issued_at: '2026-09-26T00:00:00Z', expires_at: '2026-09-27T00:00:00Z', key_id: '0123456789abcdef', receipt_signature: 'sig', receipt_algorithm: 'EdDSA', receipt_payload: '{}', extension: 'preserve' };
const ADMISSION_AGENT = { id: AGENT.id, name: AGENT.name, status: 'active', agent_type: 'llm_agent', allowed_scopes: ['verify'], created_at: '2026-09-26T00:00:00Z' };

describe('agent lifecycle client parity', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });

  it('keeps a nullable-metadata agent reachable through list and get', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({agents:[{...AGENT,metadata:null},AGENT]}))
      .mockResolvedValueOnce(Response.json({...AGENT,metadata:null}));
    const client = new Arkova({apiKey:'ak_caller',baseUrl:'https://api.example.test'});
    const agents = await client.agents.list();
    expect(agents).toHaveLength(2);
    expect(agents[0].metadata).toEqual({});
    expect((await client.agents.get(AGENT.id)).metadata).toEqual({});
  });

  it.each([[], 'invalid', 7])('rejects non-object agent metadata %j', async metadata => {
    fetchMock.mockResolvedValueOnce(Response.json({agents:[{...AGENT,metadata}]}));
    await expect(new Arkova({apiKey:'ak_caller'}).agents.list()).rejects.toMatchObject({code:'unexpected_response'});
  });

  it('maps all six generic operations to their exact non-retrying wire calls', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(AGENT), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ agents: [AGENT] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...AGENT, api_keys: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...AGENT, name: 'Updated' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'revoked', agent_id: AGENT.id })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ key: 'ak_once', key_id: 'key-1', key_prefix: 'ak_once', agent_id: AGENT.id, agent_name: 'Verifier', scopes: ['verify'], created_at: '2026-09-26T00:00:00Z', warning: 'once' }), { status: 201 }));
    const client = new Arkova({ apiKey: 'ak_caller', baseUrl: 'https://api.example.test', retry: { retries: 2, baseDelayMs: 0, maxDelayMs: 0 } });

    expect((await client.agents.register({ name: 'Verifier' })).agentType).toBe('custom');
    expect(await client.agents.list()).toHaveLength(1);
    expect((await client.agents.get(AGENT.id)).apiKeys).toEqual([]);
    expect((await client.agents.update(AGENT.id, { name: 'Updated' })).name).toBe('Updated');
    expect(await client.agents.revoke(AGENT.id)).toEqual({ status: 'revoked', agentId: AGENT.id });
    expect((await client.agents.createKey(AGENT.id)).key).toBe('ak_once');

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init.method ?? 'GET', init.headers['X-API-Key'], init.body])).toEqual([
      ['https://api.example.test/api/v1/agents', 'POST', 'ak_caller', JSON.stringify({ name: 'Verifier' })],
      ['https://api.example.test/api/v1/agents', 'GET', 'ak_caller', undefined],
      [`https://api.example.test/api/v1/agents/${AGENT.id}`, 'GET', 'ak_caller', undefined],
      [`https://api.example.test/api/v1/agents/${AGENT.id}`, 'PATCH', 'ak_caller', JSON.stringify({ name: 'Updated' })],
      [`https://api.example.test/api/v1/agents/${AGENT.id}`, 'DELETE', 'ak_caller', undefined],
      [`https://api.example.test/api/v1/agents/${AGENT.id}/key`, 'POST', 'ak_caller', undefined],
    ]);
  });

  it('admits a signed ComputeID receipt once and preserves nested errors', async () => {
    const receipt = RECEIPT;
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ agent: ADMISSION_AGENT, binding: { issuer: 'computeid', passport_id: AGENT.id, bound_at: '2026-09-26T00:00:00Z', receipt_expires_at: '2026-09-27T00:00:00Z' }, key: 'ak_admitted', key_id: 'key-2', key_prefix: 'ak_admit', scopes: ['verify'], warning: 'once' }), { status: 201 }));
    const client = new Arkova({ apiKey: 'ak_caller', baseUrl: 'https://api.example.test' });
    expect((await client.agents.admitComputeId({ passportId: AGENT.id, verificationReceipt: receipt })).key).toBe('ak_admitted');
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ passport_id: AGENT.id, verification_receipt: receipt });

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'receipt_invalid', reason: 'expired' } }), { status: 401 }));
    await expect(client.agents.admitComputeId({ passportId: AGENT.id, verificationReceipt: receipt })).rejects.toMatchObject({ statusCode: 401, code: 'receipt_invalid' } satisfies Partial<ArkovaError>);
  });

  it('never retries mutations after a retryable response', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'temporary' }), { status: 503 }));
    const client = new Arkova({ apiKey: 'ak_caller', baseUrl: 'https://api.example.test', retry: { retries: 3, baseDelayMs: 0, maxDelayMs: 0 } });
    await expect(client.agents.register({ name: 'Verifier' })).rejects.toBeInstanceOf(ArkovaError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['register', () => new Arkova({ apiKey: 'ak', baseUrl: 'https://api.example.test' }).agents.register({ name: 'x' }), null],
    ['list', () => new Arkova({ apiKey: 'ak', baseUrl: 'https://api.example.test' }).agents.list(), null],
    ['get', () => new Arkova({ apiKey: 'ak', baseUrl: 'https://api.example.test' }).agents.get(AGENT.id), {}],
    ['update', () => new Arkova({ apiKey: 'ak', baseUrl: 'https://api.example.test' }).agents.update(AGENT.id, { name: 'x' }), null],
    ['revoke', () => new Arkova({ apiKey: 'ak', baseUrl: 'https://api.example.test' }).agents.revoke(AGENT.id), { status: 'active', agent_id: AGENT.id }],
    ['mint', () => new Arkova({ apiKey: 'ak', baseUrl: 'https://api.example.test' }).agents.createKey(AGENT.id), { key: 'ak_once', key_id: 'key-1', key_prefix: 'ak_once', agent_id: AGENT.id, agent_name: 'Verifier', scopes: ['verify'], warning: 'once' }],
    ['admit', () => new Arkova({ apiKey: 'ak', baseUrl: 'https://api.example.test' }).agents.admitComputeId({ passportId: AGENT.id, verificationReceipt: RECEIPT }), null],
  ])('rejects malformed %s success bodies as a scrubbed typed error', async (_name, call, body) => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
    await expect(call()).rejects.toMatchObject({ code: 'unexpected_response' });
  });

  it('drops unknown and ill-typed nested error fields', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'bad', message: 7, reason: {}, key: 'ak_secret' } }), { status: 400 }));
    const client = new Arkova({ apiKey: 'ak', baseUrl: 'https://api.example.test' });
    const error = await client.agents.get(AGENT.id).catch((value: unknown) => value as ArkovaError);
    expect(error).toMatchObject({ code: 'bad', details: { code: 'bad' } });
    expect(JSON.stringify(error)).not.toContain('ak_secret');
  });

  it('rejects unsafe agent and admission inputs before fetch', async () => {
    const client = new Arkova({ apiKey: 'ak', baseUrl: 'https://api.example.test' });
    await expect(client.agents.register({ name: 'x', callbackUrl: 'http://unsafe.test' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(client.agents.register({ name: 'x', callbackUrl: 'https://' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(client.agents.update(AGENT.id, { status: 'revoked' as never })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(client.agents.admitComputeId({ passportId: AGENT.id, verificationReceipt: RECEIPT, allowedScopes: ['agents:manage'] as never })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
