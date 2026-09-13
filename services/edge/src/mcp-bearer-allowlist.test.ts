import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleMcpRequest } from './mcp-server';
import { __resetKillSwitchCache } from './mcp-kill-switch';
import { realPublicAnchorRow } from './__fixtures__/publicAnchor';
import type { Env } from './env';

const userId = 'verified-fixture-user';
const apiKeyId = 'verified-fixture-key';
const origin = 'https://app.arkova.ai';
const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
const allowlistSecret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

async function hmac(value: string, signingSecret: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
}

async function signedEntry(mode: 'allowlist' | 'deny' = 'allowlist') {
  const value = JSON.stringify({ mode, origins: [origin] });
  return JSON.stringify({ value, signature: (await hmac(value, allowlistSecret)).toString('hex') });
}

interface FixtureOptions {
  algorithm?: 'HS256' | 'ES256';
  subject?: string | null;
  returnedUser?: string;
  role?: string;
  forged?: boolean;
  apiKey?: boolean;
  apiKeyWithoutId?: boolean;
  requestOrigin?: string;
  entries?: Record<string, string>;
}

async function fixture(options: FixtureOptions = {}) {
  const algorithm = options.algorithm ?? 'ES256';
  const issuer = `https://${crypto.randomUUID()}.supabase.co`;
  const now = Math.floor(Date.now() / 1000);
  const subject = options.subject === undefined ? userId : options.subject;
  const payload = { ...(subject === null ? {} : { sub: subject }),
    role: options.role ?? 'authenticated', aal: 'aal2', aud: 'authenticated', iss: `${issuer}/auth/v1`,
    iat: now, exp: now + 300 };
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true,
    ['sign', 'verify']) as CryptoKeyPair;
  const jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'fixture-key' };
  const prefix = `${encode({ alg: algorithm, kid: 'fixture-key' })}.${encode(payload)}`;
  const sig = algorithm === 'HS256' ? await hmac(prefix, secret)
    : Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey,
      new TextEncoder().encode(prefix)));
  const bearer = `${options.forged
    ? `${encode({ alg: algorithm, kid: 'fixture-key' })}.${encode({ ...payload, sub: 'forged-user' })}`
    : prefix}.${sig.toString('base64url')}`;
  const entries = options.entries ?? { [`allow-user:${userId}`]: await signedEntry() };
  const kvGet = vi.fn(async (key: string) => entries[key] ?? null);
  const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
    const target = String(input);
    if (target === `${issuer}/rest/v1/rpc/get_flag`) return Response.json(true);
    if (target === `${issuer}/auth/v1/.well-known/jwks.json`) return Response.json({ keys: [jwk] });
    if (target === `${issuer}/auth/v1/user`) return Response.json({ id: options.returnedUser ?? userId });
    if (target === `${issuer}/rest/v1/rpc/validate_api_key`) return Response.json({
      user_id: userId, tier: 'authenticated', scopes: [],
      ...(options.apiKeyWithoutId ? {} : { api_key_id: apiKeyId }),
    });
    if (target === `${issuer}/rest/v1/rpc/get_public_anchor`) return Response.json(realPublicAnchorRow());
    if (target === `${issuer}/rest/v1/audit_events`) return new Response(null, { status: 201 });
    throw new Error('Unexpected fixture endpoint');
  });
  vi.stubGlobal('fetch', fetchSpy);
  const env = { SUPABASE_URL: issuer, SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-key',
    ...(algorithm === 'HS256' ? { SUPABASE_JWT_SECRET: secret } : {}),
    MCP_ORIGIN_ALLOWLIST_KV: { get: kvGet }, MCP_ALLOWLIST_HMAC_SECRET: allowlistSecret,
  } as unknown as Env;
  const pending: Promise<unknown>[] = [];
  const response = await handleMcpRequest(new Request('https://edge.example/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      Origin: options.requestOrigin ?? origin, 'CF-Connecting-IP': '192.0.2.10',
      ...(options.apiKey ? { 'X-API-Key': 'fixture-api-key' } : { Authorization: `Bearer ${bearer}` }),
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'arkova_verify_anchor', arguments: { public_id: 'ARK-2026-TEST0001' } } }),
  }), env, { waitUntil: promise => { pending.push(promise); }, passThroughOnException() {} });
  const body = await response.json() as {
    result: { isError?: boolean; content: { text: string }[] };
  };
  await Promise.all(pending);
  return { status: response.status, body, kvGet,
    userLookups: fetchSpy.mock.calls.filter(([input]) => String(input).endsWith('/auth/v1/user')).length,
    toolCalls: fetchSpy.mock.calls.filter(([input]) => String(input).endsWith('/rpc/get_public_anchor')).length };
}

describe('MCP HTTP bearer origin allowlist', () => {
  beforeEach(() => { __resetKillSwitchCache(); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it.each(['HS256', 'ES256'] as const)('executes a tool for a verified %s user with a signed user entry', async algorithm => {
    const result = await fixture({ algorithm });
    expect(result.status).toBe(200);
    expect(result.body.result.isError).not.toBe(true);
    expect(JSON.parse(result.body.result.content[0].text)).toMatchObject({ verified: true });
    expect(result.kvGet).toHaveBeenCalledExactlyOnceWith(`allow-user:${userId}`);
    expect(result.userLookups).toBe(1);
    expect(result.toolCalls).toBe(1);
  });

  it.each(['HS256', 'ES256'] as const)('rejects a forged %s subject before user/KV/tool calls', async algorithm => {
    const result = await fixture({ algorithm, forged: true });
    expect(result.status).toBe(401);
    expect(result.userLookups).toBe(0);
    expect(result.kvGet).not.toHaveBeenCalled();
    expect(result.toolCalls).toBe(0);
  });

  it.each(['HS256', 'ES256'] as const)('rejects a signed %s token missing its subject', async algorithm => {
    const result = await fixture({ algorithm, subject: null });
    expect(result.status).toBe(401);
    expect(result.userLookups).toBe(0);
    expect(result.kvGet).not.toHaveBeenCalled();
    expect(result.toolCalls).toBe(0);
  });

  it.each(['HS256', 'ES256'] as const)('keeps signed pending-role %s denial terminal', async algorithm => {
    const result = await fixture({ algorithm, role: 'arkova_email_pending' });
    expect(result.status).toBe(401);
    expect(result.userLookups).toBe(0);
    expect(result.kvGet).not.toHaveBeenCalled();
    expect(result.toolCalls).toBe(0);
  });

  it('rejects a returned user that disagrees with the signed subject', async () => {
    const result = await fixture({ returnedUser: 'other-user' });
    expect(result.status).toBe(401);
    expect(result.userLookups).toBe(1);
    expect(result.kvGet).not.toHaveBeenCalled();
    expect(result.toolCalls).toBe(0);
  });

  it.each(['missing', 'api-key-namespace', 'other-user', 'tampered', 'denied', 'origin-mismatch'] as const)(
    'does not grant bearer access with a %s entry', async kind => {
      const entry = await signedEntry(kind === 'denied' ? 'deny' : 'allowlist');
      const entries: Record<string, string> = kind === 'missing' ? {} : kind === 'api-key-namespace' ? { [`allow:${userId}`]: entry }
        : kind === 'other-user' ? { 'allow-user:other-user': entry }
        : { [`allow-user:${userId}`]: kind === 'tampered' ? entry.replace('allowlist', 'challenge') : entry };
      const result = await fixture({ entries, requestOrigin: kind === 'origin-mismatch' ? 'https://untrusted.example' : origin });
      expect(result.status).toBe(403);
      expect(result.kvGet).toHaveBeenCalledExactlyOnceWith(`allow-user:${userId}`);
      expect(result.toolCalls).toBe(0);
    });

  it('preserves API-key default access when its restriction entry is absent', async () => {
    const result = await fixture({ apiKey: true, entries: {} });
    expect(result.status).toBe(200);
    expect(result.kvGet).toHaveBeenCalledExactlyOnceWith(`allow:${apiKeyId}`);
    expect(result.toolCalls).toBe(1);
  });

  it('preserves API-key denial without falling back to an allowed user entry', async () => {
    const result = await fixture({ apiKey: true, entries: {
      [`allow:${apiKeyId}`]: await signedEntry('deny'), [`allow-user:${userId}`]: await signedEntry(),
    } });
    expect(result.status).toBe(403);
    expect(result.kvGet).toHaveBeenCalledExactlyOnceWith(`allow:${apiKeyId}`);
    expect(result.toolCalls).toBe(0);
  });

  it('does not treat an API-key response without an id as a verified bearer', async () => {
    const result = await fixture({ apiKey: true, apiKeyWithoutId: true });
    expect(result.status).toBe(403);
    expect(result.kvGet).not.toHaveBeenCalled();
    expect(result.toolCalls).toBe(0);
  });
});
