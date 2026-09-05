import { describe, expect, it } from 'vitest';
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
