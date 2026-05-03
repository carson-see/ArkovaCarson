/**
 * Edge MCP local JWT verification tests (SCRUM-926 / MCP-SEC-07).
 *
 * @vitest-environment node
 *
 * Covers verifySupabaseJwt — the local short-circuit that runs before the
 * `/auth/v1/user` round-trip in validateBearer(). Forged signatures,
 * expired tokens, wrong aud, wrong iss, and missing claims must all be
 * rejected without any network call.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto, createHmac } from 'node:crypto';

beforeAll(() => {
  if (!globalThis.crypto?.subtle?.importKey) {
    Object.defineProperty(globalThis, 'crypto', {
      value: webcrypto,
      writable: true,
    });
  }
});

import { verifySupabaseJwt } from '../../../services/edge/src/mcp-jwt-verify';

const SECRET = 'test-jwt-secret-for-vitest-mcp-sec-07';
const SUPABASE_URL = 'https://abc.supabase.co';
const ISS = `${SUPABASE_URL}/auth/v1`;
const AUD = 'authenticated';
const NOW = 1_750_000_000;

function b64url(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function sign(headerSeg: string, payloadSeg: string, secret: string): string {
  const sig = createHmac('sha256', secret).update(`${headerSeg}.${payloadSeg}`).digest();
  return b64url(sig);
}

function makeJwt(
  payloadOverrides: Record<string, unknown> = {},
  opts: { alg?: string; secret?: string } = {},
): string {
  const header = { alg: opts.alg ?? 'HS256', typ: 'JWT' };
  const payload = {
    sub: '00000000-0000-0000-0000-000000000001',
    aud: AUD,
    iss: ISS,
    role: 'authenticated',
    iat: NOW - 60,
    exp: NOW + 3600,
    ...payloadOverrides,
  };
  const headerSeg = b64url(JSON.stringify(header));
  const payloadSeg = b64url(JSON.stringify(payload));
  const sigSeg = sign(headerSeg, payloadSeg, opts.secret ?? SECRET);
  return `${headerSeg}.${payloadSeg}.${sigSeg}`;
}

describe('verifySupabaseJwt (SCRUM-926)', () => {
  it('accepts a valid HS256 token and returns sub + role', async () => {
    const token = makeJwt();
    const r = await verifySupabaseJwt(token, { secret: SECRET, supabaseUrl: SUPABASE_URL, nowSec: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.userId).toBe('00000000-0000-0000-0000-000000000001');
      expect(r.tier).toBe('authenticated');
    }
  });

  it('rejects forged signature (good structure, wrong key) without false-passing', async () => {
    const token = makeJwt({}, { secret: 'attacker-knows-format-not-secret' });
    const r = await verifySupabaseJwt(token, { secret: SECRET, supabaseUrl: SUPABASE_URL, nowSec: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_signature');
  });

  it('rejects malformed token (not 3 segments)', async () => {
    const r = await verifySupabaseJwt('not-a-jwt', { secret: SECRET, supabaseUrl: SUPABASE_URL, nowSec: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('malformed');
  });

  it('rejects empty token', async () => {
    const r = await verifySupabaseJwt('', { secret: SECRET, supabaseUrl: SUPABASE_URL, nowSec: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('empty_token');
  });

  it('rejects when secret is unset (operator misconfig)', async () => {
    const token = makeJwt();
    const r = await verifySupabaseJwt(token, { secret: '', supabaseUrl: SUPABASE_URL, nowSec: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('missing_secret');
  });

  it('rejects non-HS256 alg (e.g., none/RS256 downgrade attempts)', async () => {
    const token = makeJwt({}, { alg: 'none' });
    const r = await verifySupabaseJwt(token, { secret: SECRET, supabaseUrl: SUPABASE_URL, nowSec: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('wrong_alg');
  });

  it('rejects expired token (exp + skew < now)', async () => {
    const token = makeJwt({ exp: NOW - 3600, iat: NOW - 7200 });
    const r = await verifySupabaseJwt(token, { secret: SECRET, supabaseUrl: SUPABASE_URL, nowSec: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('expired');
  });

  it('accepts token at the edge of the 30s clock-skew window', async () => {
    const token = makeJwt({ exp: NOW - 10 });
    const r = await verifySupabaseJwt(token, { secret: SECRET, supabaseUrl: SUPABASE_URL, nowSec: NOW });
    expect(r.ok).toBe(true);
  });

  it('rejects iat-in-future tokens beyond skew', async () => {
    const token = makeJwt({ iat: NOW + 600 });
    const r = await verifySupabaseJwt(token, { secret: SECRET, supabaseUrl: SUPABASE_URL, nowSec: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('iat_in_future');
  });

  it('rejects wrong audience', async () => {
    const token = makeJwt({ aud: 'service_role' });
    const r = await verifySupabaseJwt(token, { secret: SECRET, supabaseUrl: SUPABASE_URL, nowSec: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('wrong_aud');
  });

  it('accepts audience array containing the expected aud', async () => {
    const token = makeJwt({ aud: ['authenticated', 'extra'] });
    const r = await verifySupabaseJwt(token, { secret: SECRET, supabaseUrl: SUPABASE_URL, nowSec: NOW });
    expect(r.ok).toBe(true);
  });

  it('rejects wrong issuer (cross-project token replay)', async () => {
    const token = makeJwt({ iss: 'https://attacker.supabase.co/auth/v1' });
    const r = await verifySupabaseJwt(token, { secret: SECRET, supabaseUrl: SUPABASE_URL, nowSec: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('wrong_iss');
  });

  it('accepts iss with a trailing path under /auth/v1', async () => {
    const token = makeJwt({ iss: `${ISS}/extra` });
    const r = await verifySupabaseJwt(token, { secret: SECRET, supabaseUrl: SUPABASE_URL, nowSec: NOW });
    expect(r.ok).toBe(true);
  });

  it('rejects missing sub claim', async () => {
    const token = makeJwt({ sub: undefined });
    const r = await verifySupabaseJwt(token, { secret: SECRET, supabaseUrl: SUPABASE_URL, nowSec: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_sub');
  });

  it('rejects payload that is not valid JSON (garbage segment)', async () => {
    const headerSeg = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payloadSeg = b64url('this-is-not-json');
    const sigSeg = sign(headerSeg, payloadSeg, SECRET);
    const token = `${headerSeg}.${payloadSeg}.${sigSeg}`;
    const r = await verifySupabaseJwt(token, { secret: SECRET, supabaseUrl: SUPABASE_URL, nowSec: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_payload');
  });

  it('handles SUPABASE_URL with trailing slash', async () => {
    const token = makeJwt();
    const r = await verifySupabaseJwt(token, { secret: SECRET, supabaseUrl: `${SUPABASE_URL}/`, nowSec: NOW });
    expect(r.ok).toBe(true);
  });
});
