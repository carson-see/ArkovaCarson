/**
 * Local Supabase JWT verification for the edge MCP server (SCRUM-926 / MCP-SEC-07).
 *
 * Defense-in-depth against trusting Supabase's `/auth/v1/user` blindly:
 * before the user lookup, verify the bearer token's signature and check
 * `exp`, `iat`, `aud`, `iss`. ES256 keys come from the bounded JWKS fetch;
 * legacy HS256 signatures use `SUPABASE_JWT_SECRET` locally.
 *
 * Supabase projects now sign session JWTs with an asymmetric **ES256** key
 * (`signing-keys` → `ES256 status=in_use`, `HS256 status=previously_used`,
 * read live on prod 2026-09-02 — BUG-2026-09-02-002). Until then this module
 * accepted HS256 only, which rejected every current token with `wrong_alg`.
 * ES256 is verified against the project JWKS
 * (`<SUPABASE_URL>/auth/v1/.well-known/jwks.json`, selected by `kid`, cached
 * in-isolate, refreshed on an unknown `kid` at most once every 30 seconds)
 * and needs NO shared secret. Concurrent requests share one refresh; failed
 * refreshes also observe the cooldown, and HTTP requests time out after 5 seconds.
 * HS256 remains as the fallback for tokens minted under the previously-used
 * key and is the only path that needs `SUPABASE_JWT_SECRET`. Any other `alg`
 * fails closed. Web Crypto only — no `jose` dep, matching `mcp-hmac.ts`.
 *
 * See also: `services/worker/src/auth.ts` `verifyJwtLocally` — same intent
 * on the Node worker side, uses `jose`. Keeping a parallel WebCrypto path
 * here so the edge bundle stays minimal.
 */

export type JwtVerifyResult =
  | { ok: true; userId: string; tier: string; scopes: string[] }
  | { ok: false; reason: string };

interface JwtHeader {
  alg?: string;
  typ?: string;
  kid?: string;
}

interface JwtPayload {
  sub?: string;
  aud?: string | string[];
  iss?: string;
  exp?: number;
  iat?: number;
  role?: string;
  email?: string;
  scope?: unknown;
  scopes?: unknown;
  app_metadata?: { scopes?: unknown };
}

const HS256 = 'HS256';
const ES256 = 'ES256';
/** Bound unauthenticated refresh traffic while allowing signing-key rotation. */
const JWKS_TTL_MS = 10 * 60 * 1000;
const JWKS_REFRESH_COOLDOWN_MS = 30_000;
const JWKS_FETCH_TIMEOUT_MS = 5_000;
const CLOCK_SKEW_SEC = 30;

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

// CF Worker isolates persist module-scope state across requests; cache the
// imported CryptoKey so we don't re-derive it from raw bytes on every
// authenticated MCP call. Keyed by secret value to handle key-rotation.
let cachedKey: { secret: string; key: CryptoKey } | null = null;
async function getHmacKey(secret: string): Promise<CryptoKey> {
  if (cachedKey?.secret === secret) return cachedKey.key;
  const key = await crypto.subtle.importKey(
    'raw',
    ENCODER.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  cachedKey = { secret, key };
  return key;
}

function base64UrlDecode(input: string): Uint8Array {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  const b64 = (input + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function decodeJsonSegment<T>(segment: string): T | null {
  try {
    const bytes = base64UrlDecode(segment);
    return JSON.parse(DECODER.decode(bytes)) as T;
  } catch {
    return null;
  }
}

async function hmacSignatureMatches(
  signingInput: string,
  signatureSegment: string,
  secret: string,
): Promise<boolean> {
  const key = await getHmacKey(secret);
  const sig = base64UrlDecode(signatureSegment);
  // Cast to BufferSource — TS 5.7+ types Uint8Array as Uint8Array<ArrayBufferLike>
  // which doesn't satisfy crypto.subtle.verify's BufferSource arg even though
  // Uint8Array is a valid BufferSource at runtime.
  return crypto.subtle.verify(
    'HMAC',
    key,
    sig as BufferSource,
    ENCODER.encode(signingInput) as BufferSource,
  );
}

export interface JsonWebKey256 {
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
  kid?: string;
  alg?: string;
  use?: string;
}
export type JwksFetcher = (url: string) => Promise<{ keys: JsonWebKey256[] }>;

async function defaultFetchJwks(url: string): Promise<{ keys: JsonWebKey256[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JWKS_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal });
    if (!res.ok) throw new Error(`jwks_http_${res.status}`);
    return await res.json() as { keys: JsonWebKey256[] };
  } finally {
    clearTimeout(timer);
  }
}

export function jwksUrlFor(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/+$/, '')}/auth/v1/.well-known/jwks.json`;
}

// In-isolate JWKS cache keyed by URL: { fetchedAt, keys by kid }.
let jwksCache: { url: string; fetchedAt: number; byKid: Map<string, CryptoKey> } | null = null;
// Retain failed attempts too: an attacker controls kid but cannot make every
// rejected token trigger another request to the authentication service.
let jwksRefreshAttempt: {
  url: string;
  startedAt: number;
  pending: boolean;
  promise: Promise<Map<string, CryptoKey>>;
} | null = null;

async function importEcPublicKey(jwk: JsonWebKey256): Promise<CryptoKey | null> {
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) return null;
  try {
    return await crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
  } catch {
    return null;
  }
}

async function fetchAndImportJwks(url: string, fetchJwks: JwksFetcher): Promise<Map<string, CryptoKey>> {
  const doc = await fetchJwks(url);
  const byKid = new Map<string, CryptoKey>();
  for (const jwk of doc.keys ?? []) {
    if (!jwk.kid) continue;
    const key = await importEcPublicKey(jwk);
    if (key) byKid.set(jwk.kid, key);
  }
  jwksCache = { url, fetchedAt: Date.now(), byKid };
  return byKid;
}

async function loadJwks(url: string, fetchJwks: JwksFetcher, force: boolean): Promise<Map<string, CryptoKey>> {
  const now = Date.now();
  if (!force && jwksCache?.url === url && now - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.byKid;
  }
  if (jwksRefreshAttempt?.url === url &&
      (jwksRefreshAttempt.pending || now - jwksRefreshAttempt.startedAt < JWKS_REFRESH_COOLDOWN_MS)) {
    return jwksRefreshAttempt.promise;
  }
  const attempt = {
    url,
    startedAt: now,
    pending: true,
    promise: fetchAndImportJwks(url, fetchJwks).finally(() => { attempt.pending = false; }),
  };
  jwksRefreshAttempt = attempt;
  return attempt.promise;
}

/** Test hook: drop the in-isolate JWKS cache. */
export function resetJwksCacheForTests(): void {
  jwksCache = null;
  jwksRefreshAttempt = null;
}

async function es256SignatureMatches(
  signingInput: string,
  signatureSegment: string,
  kid: string | undefined,
  supabaseUrl: string,
  fetchJwks: JwksFetcher,
): Promise<boolean | 'unknown_kid'> {
  if (!kid) return 'unknown_kid';
  const url = jwksUrlFor(supabaseUrl);
  let byKid = await loadJwks(url, fetchJwks, false);
  let key = byKid.get(kid);
  if (!key) {
    // Rotation refreshes share the same cooldown as cold and failed requests.
    byKid = await loadJwks(url, fetchJwks, true);
    key = byKid.get(kid);
    if (!key) return 'unknown_kid';
  }
  const sig = base64UrlDecode(signatureSegment);
  // JWS ES256 signatures are raw r||s (64 bytes) — exactly what WebCrypto ECDSA expects.
  if (sig.length !== 64) return false;
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    sig as BufferSource,
    ENCODER.encode(signingInput) as BufferSource,
  );
}

function audMatches(claim: string | string[] | undefined, expected: string): boolean {
  if (typeof claim === 'string') return claim === expected;
  if (Array.isArray(claim)) return claim.includes(expected);
  return false;
}

function coerceScopes(value: unknown): string[] {
  if (typeof value === 'string') return value.split(/\s+/).filter(Boolean);
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return [];
}

function scopesFromPayload(payload: JwtPayload): string[] {
  return [...new Set([
    ...coerceScopes(payload.scope),
    ...coerceScopes(payload.scopes),
    ...coerceScopes(payload.app_metadata?.scopes),
  ])];
}

/**
 * Verify a Supabase ES256 or legacy HS256 JWT before the remote user lookup.
 *
 * Returns ok+userId+tier on success. On failure returns ok:false with a
 * short reason — callers MUST short-circuit (no remote user lookup) so a
 * compromise of `/auth/v1/user` cannot back-channel forged tokens.
 *
 * Validates: structure, alg (ES256 via JWKS or HS256 via secret), signature, exp (with 30s skew),
 * iat (with 30s skew), aud (default "authenticated"), iss (must startWith
 * `<SUPABASE_URL>/auth/v1`).
 */
export async function verifySupabaseJwt(
  token: string,
  options: {
    /** Legacy HS256 secret. Optional — only the HS256 fallback needs it. */
    secret?: string;
    supabaseUrl: string;
    expectedAud?: string;
    nowSec?: number;
    /** Test hook / override for the JWKS fetch. */
    fetchJwks?: JwksFetcher;
  },
): Promise<JwtVerifyResult> {
  const { secret, supabaseUrl, expectedAud = 'authenticated', nowSec, fetchJwks = defaultFetchJwks } = options;
  if (!token) return { ok: false, reason: 'empty_token' };

  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [headerSeg, payloadSeg, sigSeg] = parts;

  const header = decodeJsonSegment<JwtHeader>(headerSeg);
  if (!header) return { ok: false, reason: 'bad_header' };
  if (header.alg !== HS256 && header.alg !== ES256) return { ok: false, reason: 'wrong_alg' };

  const payload = decodeJsonSegment<JwtPayload>(payloadSeg);
  if (!payload) return { ok: false, reason: 'bad_payload' };

  const signingInput = `${headerSeg}.${payloadSeg}`;
  if (header.alg === ES256) {
    let esOk: boolean | 'unknown_kid';
    try {
      esOk = await es256SignatureMatches(signingInput, sigSeg, header.kid, supabaseUrl, fetchJwks);
    } catch {
      return { ok: false, reason: 'jwks_unavailable' };
    }
    if (esOk === 'unknown_kid') return { ok: false, reason: 'unknown_kid' };
    if (!esOk) return { ok: false, reason: 'bad_signature' };
  } else {
    if (!secret) return { ok: false, reason: 'missing_secret' };
    const sigOk = await hmacSignatureMatches(signingInput, sigSeg, secret);
    if (!sigOk) return { ok: false, reason: 'bad_signature' };
  }

  const now = nowSec ?? Math.floor(Date.now() / 1000);

  if (typeof payload.exp !== 'number' || now > payload.exp + CLOCK_SKEW_SEC) {
    return { ok: false, reason: 'expired' };
  }
  if (typeof payload.iat === 'number' && payload.iat > now + CLOCK_SKEW_SEC) {
    return { ok: false, reason: 'iat_in_future' };
  }
  if (!audMatches(payload.aud, expectedAud)) {
    return { ok: false, reason: 'wrong_aud' };
  }
  const expectedIssPrefix = `${supabaseUrl.replace(/\/+$/, '')}/auth/v1`;
  if (typeof payload.iss !== 'string' || !payload.iss.startsWith(expectedIssPrefix)) {
    return { ok: false, reason: 'wrong_iss' };
  }
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    return { ok: false, reason: 'no_sub' };
  }

  return {
    ok: true,
    userId: payload.sub,
    tier: payload.role || 'authenticated',
    scopes: scopesFromPayload(payload),
  };
}
