import { describe, it, expect, vi } from 'vitest';

import {
  callAiEndpoint,
  parseIdentities,
  AI_PATHS,
  type FetchLike,
  type WorkerIdentity,
} from './ai-client.js';

const IDENTITY: WorkerIdentity = { label: 'u1', jwt: 'eyJheader.eyJpayload.sig' };

function fakeResponse(status: number, body: string, headers: Record<string, string> = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => body,
  };
}

describe('parseIdentities', () => {
  it('parses labelled and bare JWTs, never mangling the token', () => {
    const parsed = parseIdentities('u1:eyJa.b.c, eyJx.y.z');
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ label: 'u1', jwt: 'eyJa.b.c' });
    expect(parsed[1].jwt).toBe('eyJx.y.z');
    expect(parsed[1].label).toBe('ai-soak-user-2');
  });
  it('returns an empty pool for empty/undefined input', () => {
    expect(parseIdentities(undefined)).toEqual([]);
    expect(parseIdentities('   ')).toEqual([]);
  });
});

describe('callAiEndpoint', () => {
  it('POSTs to the right path with a Supabase Bearer JWT and JSON body', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200, '{"fields":{"credentialType":"CPE"},"confidence":0.9}')) as unknown as FetchLike;
    const result = await callAiEndpoint('https://rig.example', 'extract', { strippedText: 'x', credentialType: 'CPE', fingerprint: 'f'.repeat(64) }, IDENTITY, fetchImpl);

    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`https://rig.example${AI_PATHS.extract}`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer eyJheader.eyJpayload.sig');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ fields: { credentialType: 'CPE' } });
  });

  it('surfaces a 429 with parsed Retry-After (never silently drops it)', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(429, 'rate limited', { 'retry-after': '12' })) as unknown as FetchLike;
    const result = await callAiEndpoint('https://rig.example', 'template', { fields: {}, confidence: 0.5 }, IDENTITY, fetchImpl);
    expect(result.status).toBe(429);
    expect(result.ok).toBe(false);
    expect(result.retryAfterSec).toBe(12);
  });

  it('records a transport failure as status 0 rather than throwing', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNRESET'); }) as unknown as FetchLike;
    const result = await callAiEndpoint('https://rig.example', 'tags', { fields: {} }, IDENTITY, fetchImpl);
    expect(result.status).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.transportError).toContain('ECONNRESET');
  });

  it('tolerates a non-JSON body without throwing', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(503, '<html>gate closed</html>')) as unknown as FetchLike;
    const result = await callAiEndpoint('https://rig.example', 'extract', {}, IDENTITY, fetchImpl);
    expect(result.status).toBe(503);
    expect(result.body).toBeUndefined();
  });
});
