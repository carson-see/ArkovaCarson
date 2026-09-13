/**
 * mcp-jwt-verify — ES256 (JWKS) + HS256 (legacy secret) verification.
 * BUG-2026-09-02-002: prod signs ES256; the HS256-only pin rejected every token.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { verifySupabaseJwt, resetJwksCacheForTests, jwksUrlFor, type JwksFetcher } from './mcp-jwt-verify';

const SUPABASE_URL = 'https://rig.supabase.co';
const enc = new TextEncoder();
const b64u = (bytes: Uint8Array | string): string => {
  const b = typeof bytes === 'string' ? enc.encode(bytes) : bytes;
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

async function esPair() {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', kp.publicKey)) as JsonWebKey;
  return { priv: kp.privateKey, jwk: { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y!, kid: 'kid-1', alg: 'ES256', use: 'sig' } };
}
async function mintES256(priv: CryptoKey, kid: string, payload: Record<string, unknown>) {
  const h = b64u(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid }));
  const p = b64u(JSON.stringify(payload));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, enc.encode(`${h}.${p}`)));
  return `${h}.${p}.${b64u(sig)}`;
}
async function mintHS256(secret: string, payload: Record<string, unknown>) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify(payload));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${h}.${p}`)));
  return `${h}.${p}.${b64u(sig)}`;
}
const now = Math.floor(Date.now() / 1000);
const claims = { sub: 'user-1', aud: 'authenticated', iss: `${SUPABASE_URL}/auth/v1`, exp: now + 600, iat: now - 5, role: 'authenticated', aal: 'aal2' };

describe('verifySupabaseJwt — ES256 via JWKS', () => {
  beforeEach(() => resetJwksCacheForTests());
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('bounds JWKS requests when unauthenticated callers send many unknown kids', async () => {
    const { priv, jwk } = await esPair();
    const fetchJwks = vi.fn(async () => ({ keys: [jwk] }));
    const good = await mintES256(priv, 'kid-1', claims);
    expect(await verifySupabaseJwt(good, { supabaseUrl: SUPABASE_URL, fetchJwks })).toMatchObject({ ok: true });
    for (let i = 0; i < 20; i++) {
      const token = await mintES256(priv, `untrusted-${i}`, claims);
      expect(await verifySupabaseJwt(token, { supabaseUrl: SUPABASE_URL, fetchJwks })).toEqual({ ok: false, reason: 'unknown_kid' });
    }
    expect(fetchJwks).toHaveBeenCalledTimes(1);
  });

  it('shares one JWKS request across simultaneous cold verifications', async () => {
    const { priv, jwk } = await esPair();
    const token = await mintES256(priv, 'kid-1', claims);
    const fetchJwks = vi.fn(async () => ({ keys: [jwk] }));
    const results = await Promise.all(Array.from({ length: 12 }, () => verifySupabaseJwt(token, { supabaseUrl: SUPABASE_URL, fetchJwks })));
    expect(results.every(result => result.ok)).toBe(true);
    expect(fetchJwks).toHaveBeenCalledTimes(1);
  });

  it('refreshes for a legitimate rotated key after the short cooldown', async () => {
    const first = await esPair(); const second = await esPair();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    const fetchJwks = vi.fn()
      .mockResolvedValueOnce({ keys: [first.jwk] })
      .mockResolvedValueOnce({ keys: [{ ...second.jwk, kid: 'kid-2' }] });
    expect(await verifySupabaseJwt(await mintES256(first.priv, 'kid-1', claims), { supabaseUrl: SUPABASE_URL, fetchJwks })).toMatchObject({ ok: true });
    clock.mockReturnValue(now * 1000 + 30_001);
    expect(await verifySupabaseJwt(await mintES256(second.priv, 'kid-2', claims), { supabaseUrl: SUPABASE_URL, fetchJwks })).toMatchObject({ ok: true });
    expect(fetchJwks).toHaveBeenCalledTimes(2);
  });

  it('bounds retries during a JWKS outage without accepting a token', async () => {
    const { priv } = await esPair();
    const token = await mintES256(priv, 'kid-1', claims);
    const fetchJwks = vi.fn(async () => { throw new Error('upstream unavailable'); });
    for (let i = 0; i < 8; i++) {
      expect(await verifySupabaseJwt(token, { supabaseUrl: SUPABASE_URL, fetchJwks })).toEqual({ ok: false, reason: 'jwks_unavailable' });
    }
    expect(fetchJwks).toHaveBeenCalledTimes(1);
  });

  it('accepts an ES256 token whose kid resolves in the JWKS, with NO secret configured', async () => {
    const { priv, jwk } = await esPair();
    const fetchJwks: JwksFetcher = async () => ({ keys: [jwk] });
    const token = await mintES256(priv, 'kid-1', claims);
    const r = await verifySupabaseJwt(token, { supabaseUrl: SUPABASE_URL, fetchJwks });
    expect(r).toMatchObject({ ok: true, userId: 'user-1' });
  });

  it('aborts a stalled JWKS HTTP request and fails closed within five seconds', async () => {
    const { priv } = await esPair();
    const token = await mintES256(priv, 'kid-1', claims);
    vi.useFakeTimers();
    const httpFetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    vi.stubGlobal('fetch', httpFetch);
    const verification = verifySupabaseJwt(token, { supabaseUrl: SUPABASE_URL });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await verification).toEqual({ ok: false, reason: 'jwks_unavailable' });
    expect(httpFetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('can recover from a failed JWKS refresh after the cooldown', async () => {
    const { priv, jwk } = await esPair();
    const token = await mintES256(priv, 'kid-1', claims);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    const fetchJwks = vi.fn()
      .mockRejectedValueOnce(new Error('temporarily unavailable'))
      .mockResolvedValueOnce({ keys: [jwk] });
    expect(await verifySupabaseJwt(token, { supabaseUrl: SUPABASE_URL, fetchJwks })).toEqual({ ok: false, reason: 'jwks_unavailable' });
    clock.mockReturnValue(now * 1000 + 30_001);
    expect(await verifySupabaseJwt(token, { supabaseUrl: SUPABASE_URL, fetchJwks })).toMatchObject({ ok: true });
    expect(fetchJwks).toHaveBeenCalledTimes(2);
  });

  it('keeps accepting a known cached key when an unknown-key refresh fails', async () => {
    const { priv, jwk } = await esPair();
    const token = await mintES256(priv, 'kid-1', claims);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    const fetchJwks = vi.fn()
      .mockResolvedValueOnce({ keys: [jwk] })
      .mockRejectedValueOnce(new Error('temporarily unavailable'));
    expect(await verifySupabaseJwt(token, { supabaseUrl: SUPABASE_URL, fetchJwks })).toMatchObject({ ok: true });
    clock.mockReturnValue(now * 1000 + 30_001);
    const unknown = await mintES256(priv, 'untrusted', claims);
    expect(await verifySupabaseJwt(unknown, { supabaseUrl: SUPABASE_URL, fetchJwks })).toEqual({ ok: false, reason: 'jwks_unavailable' });
    expect(await verifySupabaseJwt(token, { supabaseUrl: SUPABASE_URL, fetchJwks })).toMatchObject({ ok: true });
    expect(fetchJwks).toHaveBeenCalledTimes(2);
  });

  it('derives the JWKS URL from SUPABASE_URL', () => {
    expect(jwksUrlFor('https://rig.supabase.co/')).toBe('https://rig.supabase.co/auth/v1/.well-known/jwks.json');
  });

  it('rejects an unknown kid without immediately repeating a cold fetch', async () => {
    const { priv, jwk } = await esPair();
    let calls = 0;
    const fetchJwks: JwksFetcher = async () => { calls++; return { keys: [jwk] }; };
    const token = await mintES256(priv, 'kid-other', claims);
    const r = await verifySupabaseJwt(token, { supabaseUrl: SUPABASE_URL, fetchJwks });
    expect(r).toEqual({ ok: false, reason: 'unknown_kid' });
    expect(calls).toBe(1);
  });

  it('rejects a tampered signature', async () => {
    const { priv, jwk } = await esPair();
    const fetchJwks: JwksFetcher = async () => ({ keys: [jwk] });
    const token = await mintES256(priv, 'kid-1', claims);
    const [h, p, s] = token.split('.');
    const flipped = (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    const r = await verifySupabaseJwt(`${h}.${p}.${flipped}`, { supabaseUrl: SUPABASE_URL, fetchJwks });
    expect(r).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects expired and wrong-aud ES256 tokens', async () => {
    const { priv, jwk } = await esPair();
    const fetchJwks: JwksFetcher = async () => ({ keys: [jwk] });
    expect(await verifySupabaseJwt(await mintES256(priv, 'kid-1', { ...claims, exp: now - 120 }), { supabaseUrl: SUPABASE_URL, fetchJwks })).toEqual({ ok: false, reason: 'expired' });
    expect(await verifySupabaseJwt(await mintES256(priv, 'kid-1', { ...claims, aud: 'anon' }), { supabaseUrl: SUPABASE_URL, fetchJwks })).toEqual({ ok: false, reason: 'wrong_aud' });
  });

  it('caches the JWKS across verifications', async () => {
    const { priv, jwk } = await esPair();
    let calls = 0;
    const fetchJwks: JwksFetcher = async () => { calls++; return { keys: [jwk] }; };
    const token = await mintES256(priv, 'kid-1', claims);
    await verifySupabaseJwt(token, { supabaseUrl: SUPABASE_URL, fetchJwks });
    await verifySupabaseJwt(token, { supabaseUrl: SUPABASE_URL, fetchJwks });
    expect(calls).toBe(1);
  });

  it('reports jwks_unavailable when the JWKS endpoint fails', async () => {
    const { priv } = await esPair();
    const fetchJwks: JwksFetcher = async () => { throw new Error('jwks_http_503'); };
    const r = await verifySupabaseJwt(await mintES256(priv, 'kid-1', claims), { supabaseUrl: SUPABASE_URL, fetchJwks });
    expect(r).toEqual({ ok: false, reason: 'jwks_unavailable' });
  });
});

describe('verifySupabaseJwt — HS256 fallback + alg pinning', () => {
  it('accepts an HS256 token when the legacy secret is configured', async () => {
    const r = await verifySupabaseJwt(await mintHS256('s3cret', claims), { secret: 's3cret', supabaseUrl: SUPABASE_URL });
    expect(r).toMatchObject({ ok: true, userId: 'user-1' });
  });
  it('fails closed on an HS256 token when no secret is configured', async () => {
    const r = await verifySupabaseJwt(await mintHS256('s3cret', claims), { supabaseUrl: SUPABASE_URL });
    expect(r).toEqual({ ok: false, reason: 'missing_secret' });
  });
  it('rejects alg=none and any non-ES256/HS256 alg', async () => {
    const h = b64u(JSON.stringify({ alg: 'none' }));
    const p = b64u(JSON.stringify(claims));
    expect(await verifySupabaseJwt(`${h}.${p}.`, { secret: 'x', supabaseUrl: SUPABASE_URL })).toEqual({ ok: false, reason: 'wrong_alg' });
    const h2 = b64u(JSON.stringify({ alg: 'RS256', kid: 'k' }));
    expect(await verifySupabaseJwt(`${h2}.${p}.AAAA`, { supabaseUrl: SUPABASE_URL, fetchJwks: async () => ({ keys: [] }) })).toEqual({ ok: false, reason: 'wrong_alg' });
  });
});

describe('verifySupabaseJwt — malformed segments never escape as a thrown DOMException', () => {
  beforeEach(() => resetJwksCacheForTests());
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  // An unauthenticated caller controls every byte of the token. `atob` throws a
  // DOMException on a non-base64 signature segment, and nothing between here and
  // the Worker's fetch handler catches it — that surfaced as a generic runtime
  // error instead of the 401 the auth contract promises.
  it('returns bad_signature (not a throw) for a non-base64 HS256 signature segment', async () => {
    const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const p = b64u(JSON.stringify(claims));
    const r = await verifySupabaseJwt(`${h}.${p}.$$$$`, { secret: 's3cret', supabaseUrl: SUPABASE_URL });
    expect(r).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('returns bad_signature (not a throw) for a non-base64 ES256 signature segment', async () => {
    const { jwk } = await esPair();
    const fetchJwks: JwksFetcher = async () => ({ keys: [jwk] });
    const h = b64u(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'kid-1' }));
    const p = b64u(JSON.stringify(claims));
    const r = await verifySupabaseJwt(`${h}.${p}.$$$$`, { supabaseUrl: SUPABASE_URL, fetchJwks });
    expect(r).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('never rejects for garbage three-segment inputs, on either alg', async () => {
    const { jwk } = await esPair();
    const fetchJwks: JwksFetcher = async () => ({ keys: [jwk] });
    const goodPayload = b64u(JSON.stringify(claims));
    const garbage = ['$$$$', '!!', '====', '   ', 'ではない', ' ', '.', 'a', '%%%%%%%%', '~~~~'];
    const headers = [
      b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
      b64u(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'kid-1' })),
      ...garbage,
    ];

    for (const header of headers) {
      for (const payload of [goodPayload, ...garbage]) {
        for (const sig of garbage) {
          const result = await verifySupabaseJwt(`${header}.${payload}.${sig}`, {
            secret: 's3cret',
            supabaseUrl: SUPABASE_URL,
            fetchJwks,
          });
          expect(result.ok).toBe(false);
          if (!result.ok) expect(typeof result.reason).toBe('string');
        }
      }
    }
  });
});
