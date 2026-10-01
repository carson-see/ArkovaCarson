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

  it.each([0, -1, 1.5, 120_001, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid timeoutMs %s before any request', timeoutMs => {
    expect(() => new Arkova({ timeoutMs })).toThrow(RangeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('times out a stalled mutation before headers without retrying it', async () => {
    fetchMock.mockImplementationOnce((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    const client = new Arkova({ apiKey: 'ak_caller', timeoutMs: 20 });
    await expect(client.agents.createKey(AGENT.id)).rejects.toMatchObject({ code: 'request_timeout', statusCode: 408 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('times out a stalled response body without misclassifying it as malformed', async () => {
    fetchMock.mockImplementationOnce((_url, init: RequestInit) => Promise.resolve(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"key":'));
        init.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true });
      },
    }), { status: 201 })));
    const client = new Arkova({ apiKey: 'ak_caller', timeoutMs: 20 });
    await expect(client.agents.createKey(AGENT.id)).rejects.toMatchObject({ code: 'request_timeout', statusCode: 408 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves an external AbortSignal on generic requests', async () => {
    fetchMock.mockImplementationOnce((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('caller aborted', 'AbortError')), { once: true });
    }));
    const controller = new AbortController();
    const client = new Arkova({ apiKey: 'ak_caller', timeoutMs: 100 });
    const pending = client.request('/api/v1/agents', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a read after the caller aborts during backoff', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'temporary' }, { status: 503 }));
    const controller = new AbortController();
    const client = new Arkova({ apiKey: 'ak_caller', retry: { sleep: async () => controller.abort() } });
    await expect(client.request('/api/v1/agents', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['folders', 'webhooks'] as const)('releases the deadline after %s delete succeeds with a body', async surface => {
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true }, { status: 200 }));
    const client = new Arkova({ apiKey: 'ak_caller', timeoutMs: 20 });
    await client[surface].delete(AGENT.id);
    const signal = fetchMock.mock.calls[0]![1].signal as AbortSignal;
    await new Promise(resolve => setTimeout(resolve, 35));
    expect(signal.aborted).toBe(false);
  });

  it.each(['query', 'ask'] as const)('releases the deadline after %s rejects without reading the body', async surface => {
    fetchMock.mockResolvedValueOnce(Response.json({ code: 'nessie_disabled' }, { status: 403 }));
    const client = new Arkova({ apiKey: 'ak_caller', timeoutMs: 20 });
    await expect(client[surface]('blocked')).rejects.toMatchObject({ statusCode: 403 });
    const signal = fetchMock.mock.calls[0]![1].signal as AbortSignal;
    await new Promise(resolve => setTimeout(resolve, 35));
    expect(signal.aborted).toBe(false);
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

  it.each([false, true])('preserves safe scope recovery details (nested=%s)', async nested => {
    const fields = { required: 'agents:manage', granted: ['verify'], missing: ['keys:manage'], permitted: ['verify'], key: 'ak_secret', receipt_payload: 'private-receipt' };
    const body = nested ? { error: { code: 'insufficient_scope', ...fields } } : { error: 'insufficient_scope', ...fields };
    fetchMock.mockResolvedValueOnce(Response.json(body, { status: 403 }));
    const error = await new Arkova({ apiKey: 'ak_caller' }).agents.createKey(AGENT.id).catch(value => value as ArkovaError);
    expect(error).toMatchObject({ code: 'insufficient_scope', details: { required: 'agents:manage', granted: ['verify'], missing: ['keys:manage'], permitted: ['verify'] } });
    expect(JSON.stringify(error)).not.toContain('ak_secret');
    expect(JSON.stringify(error)).not.toContain('private-receipt');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { required: ['verify'], missing: ['verify', 7], granted: 'verify', permitted: ['verify', {}] },
    { required: 'a'.repeat(81), missing: ['verify\n'], granted: Array(33).fill('verify'), permitted: [null] },
  ])('omits invalid scope recovery fields without manufacturing a partial list', async fields => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: { code: 'insufficient_scope', ...fields } }, { status: 403 }));
    const error = await new Arkova({ apiKey: 'ak_caller' }).agents.createKey(AGENT.id).catch(value => value as ArkovaError);
    expect(error).toBeInstanceOf(ArkovaError);
    expect((error as ArkovaError).details).toEqual({ code: 'insufficient_scope' });
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
