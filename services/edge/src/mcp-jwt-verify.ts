/**
 * Local Supabase JWT verification for the edge MCP server (SCRUM-926 / MCP-SEC-07).
 *
 * Defense-in-depth against trusting Supabase's `/auth/v1/user` blindly:
 * before any network round-trip, verify the bearer token's HS256 signature
 * against `SUPABASE_JWT_SECRET` and check `exp`, `iat`, `aud`, `iss` locally.
 *
 * Supabase issues HS256-signed JWTs with a symmetric secret, so Web Crypto
 * (already available in CF Workers + Node 20+) suffices — no `jose` dep
 * needed, matching the lean approach used by `mcp-hmac.ts`.
 *
 * See also: `services/worker/src/auth.ts` `verifyJwtLocally` — same intent
 * on the Node worker side, uses `jose`. Keeping a parallel WebCrypto path
 * here so the edge bundle stays minimal.
 */

export type JwtVerifyResult =
  | { ok: true; userId: string; tier: string }
  | { ok: false; reason: string };

interface JwtHeader {
  alg?: string;
  typ?: string;
}

interface JwtPayload {
  sub?: string;
  aud?: string | string[];
  iss?: string;
  exp?: number;
  iat?: number;
  role?: string;
  email?: string;
}

const ALLOWED_ALG = 'HS256';
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

function audMatches(claim: string | string[] | undefined, expected: string): boolean {
  if (typeof claim === 'string') return claim === expected;
  if (Array.isArray(claim)) return claim.includes(expected);
  return false;
}

/**
 * Verify a Supabase HS256 JWT locally.
 *
 * Returns ok+userId+tier on success. On failure returns ok:false with a
 * short reason — callers MUST short-circuit (no network round-trip) so a
 * compromise of `/auth/v1/user` cannot back-channel forged tokens.
 *
 * Validates: structure, alg=HS256, signature, exp (with 30s skew),
 * iat (with 30s skew), aud (default "authenticated"), iss (must startWith
 * `<SUPABASE_URL>/auth/v1`).
 */
export async function verifySupabaseJwt(
  token: string,
  options: {
    secret: string;
    supabaseUrl: string;
    expectedAud?: string;
    nowSec?: number;
  },
): Promise<JwtVerifyResult> {
  const { secret, supabaseUrl, expectedAud = 'authenticated', nowSec } = options;
  if (!secret) return { ok: false, reason: 'missing_secret' };
  if (!token) return { ok: false, reason: 'empty_token' };

  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [headerSeg, payloadSeg, sigSeg] = parts;

  const header = decodeJsonSegment<JwtHeader>(headerSeg);
  if (!header) return { ok: false, reason: 'bad_header' };
  if (header.alg !== ALLOWED_ALG) return { ok: false, reason: 'wrong_alg' };

  const payload = decodeJsonSegment<JwtPayload>(payloadSeg);
  if (!payload) return { ok: false, reason: 'bad_payload' };

  const signingInput = `${headerSeg}.${payloadSeg}`;
  const sigOk = await hmacSignatureMatches(signingInput, sigSeg, secret);
  if (!sigOk) return { ok: false, reason: 'bad_signature' };

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

  return { ok: true, userId: payload.sub, tier: payload.role || 'authenticated' };
}
