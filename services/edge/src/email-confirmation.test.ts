import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifySupabaseJwt as verifyMcp } from './mcp-jwt-verify';
import { verifySupabaseJwt as verifyEdge } from './supabase-jwt';
import type { Env } from './env';
const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
const url = 'https://fixture.supabase.co';
async function token(role: string) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ alg: 'HS256' })}.${encode({ sub: 'fixture-user', role, aud: 'authenticated', iss: `${url}/auth/v1`, iat: 100, exp: 1000 })}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input));
  return `${input}.${Buffer.from(sig).toString('base64url')}`;
}
describe('pending account parity at both edge JWT entry points', () => {
  it('denies a correctly signed pending MCP bearer', async () => {
    expect(await verifyMcp(await token('arkova_email_pending'), { secret, supabaseUrl: url, nowSec: 200 }))
      .toEqual({ ok: false, reason: 'email_confirmation_required' });
  });
  it('denies a correctly signed pending general edge bearer', async () => {
    expect(await verifyEdge(await token('arkova_email_pending'), { SUPABASE_URL: url, SUPABASE_JWT_SECRET: secret } as Env, 200)).toBeNull();
  });
  it('preserves both normal authenticated positive controls', async () => {
    const bearer = await token('authenticated');
    expect(await verifyMcp(bearer, { secret, supabaseUrl: url, nowSec: 200 })).toMatchObject({ ok: true, userId: 'fixture-user' });
    expect(await verifyEdge(bearer, { SUPABASE_URL: url, SUPABASE_JWT_SECRET: secret } as Env, 200)).toMatchObject({ sub: 'fixture-user' });
  });
});

async function liveBearer(role: string, algorithm: 'HS256' | 'ES256', issuer: string) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const input = `${encode({ alg: algorithm, kid: 'owned-fixture' })}.${encode({
    sub: 'owned-fixture-user', role, aud: 'authenticated', iss: `${issuer}/auth/v1`, iat: now, exp: now + 300,
  })}`;
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'owned-fixture' };
  const hmac = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign(
    algorithm === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : 'HMAC',
    algorithm === 'ES256' ? pair.privateKey : hmac,
    new TextEncoder().encode(input),
  );
  return { bearer: `${input}.${Buffer.from(signature).toString('base64url')}`, jwk };
}

describe('actual MCP validateBearer confirmation boundary', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  async function fixture(role: string, algorithm: 'HS256' | 'ES256', returnedUser = 'owned-fixture-user') {
    // Each fixture has a distinct issuer, so imported-key caching cannot reuse
    // a previous fixture's public key or bypass this test's network assertions.
    const issuer = `https://${crypto.randomUUID()}.supabase.co`;
    const { bearer, jwk } = await liveBearer(role, algorithm, issuer);
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const target = String(input);
      if (target === `${issuer}/auth/v1/.well-known/jwks.json`) return Response.json({ keys: [jwk] });
      // A permissive user lookup must never rescue a signed pending token.
      if (target === `${issuer}/auth/v1/user`) return Response.json({ id: returnedUser, role: 'authenticated' });
      throw new Error('Unexpected fixture endpoint');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const env = {
      SUPABASE_URL: issuer,
      SUPABASE_SERVICE_ROLE_KEY: 'owned-fixture-service-key',
      ...(algorithm === 'HS256' ? { SUPABASE_JWT_SECRET: secret } : {}),
    } as Env;
    const { validateBearer } = await import('./mcp-server');
    return {
      result: await validateBearer(bearer, env),
      userLookups: fetchSpy.mock.calls.filter(([input]) => String(input).endsWith('/auth/v1/user')).length,
      jwksLookups: fetchSpy.mock.calls.filter(([input]) => String(input).endsWith('/jwks.json')).length,
    };
  }

  it.each(['HS256', 'ES256'] as const)('denies signed pending %s before getUser can return an authenticated role', async (algorithm) => {
    const observed = await fixture('arkova_email_pending', algorithm);
    expect(observed.result).toBeNull();
    expect(observed.userLookups).toBe(0);
    expect(observed.jwksLookups).toBe(algorithm === 'ES256' ? 1 : 0);
  });

  it('accepts ordinary ES256 without a shared secret after the matching user lookup', async () => {
    const observed = await fixture('authenticated', 'ES256');
    expect(observed.result).toMatchObject({ userId: 'owned-fixture-user', tier: 'authenticated' });
    expect(observed.jwksLookups).toBe(1);
    expect(observed.userLookups).toBe(1);
  });

  it('rejects an ES256 user lookup that disagrees with the signed subject', async () => {
    const observed = await fixture('authenticated', 'ES256', 'different-user');
    expect(observed.result).toBeNull();
    expect(observed.jwksLookups).toBe(1);
    expect(observed.userLookups).toBe(1);
  });

  it('preserves the ordinary legacy HS256 user-lookup control', async () => {
    const observed = await fixture('authenticated', 'HS256');
    expect(observed.result).toMatchObject({ userId: 'owned-fixture-user', tier: 'authenticated' });
    expect(observed.jwksLookups).toBe(0);
    expect(observed.userLookups).toBe(1);
  });
});
