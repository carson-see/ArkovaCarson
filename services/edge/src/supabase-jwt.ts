import type { Env } from './env';

const CLOCK_SKEW_SECONDS = 60;
const SUPABASE_AUD = 'authenticated';

export interface SupabaseJwtClaims {
  sub: string;
  aud: string | string[];
  iss: string;
  exp: number;
  iat: number;
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i += 1) {
      const byte = binary.codePointAt(i);
      if (byte === undefined || byte > 255) return null;
      bytes[i] = byte;
    }

    return bytes;
  } catch {
    return null;
  }
}

function decodeJsonPart(value: string): unknown {
  const bytes = base64UrlToBytes(value);
  if (!bytes) return null;
  const json = new TextDecoder().decode(bytes);

  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') {
    end -= 1;
  }
  return value.slice(0, end);
}

function expectedIssuer(env: Env): string {
  return `${trimTrailingSlashes(env.SUPABASE_URL)}/auth/v1`;
}

function hasExpectedAudience(aud: string | string[]): boolean {
  return Array.isArray(aud)
    ? aud.includes(SUPABASE_AUD)
    : aud === SUPABASE_AUD;
}

function coerceClaims(payload: unknown): SupabaseJwtClaims | null {
  if (!isRecord(payload)) return null;
  const { sub, aud, iss, exp, iat } = payload;

  if (typeof sub !== 'string' || !sub) return null;
  if (!(typeof aud === 'string' || (Array.isArray(aud) && aud.every((item) => typeof item === 'string')))) {
    return null;
  }
  if (typeof iss !== 'string' || !iss) return null;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
  if (typeof iat !== 'number' || !Number.isFinite(iat)) return null;

  return { sub, aud, iss, exp, iat };
}

function claimsAreCurrent(claims: SupabaseJwtClaims, nowSeconds: number): boolean {
  return claims.exp > nowSeconds - CLOCK_SKEW_SECONDS
    && claims.iat <= nowSeconds + CLOCK_SKEW_SECONDS;
}

async function verifyHs256Signature(signingInput: string, signaturePart: string, secret: string): Promise<boolean> {
  const signature = base64UrlToBytes(signaturePart);
  if (!signature) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  return crypto.subtle.verify(
    'HMAC',
    key,
    signature,
    new TextEncoder().encode(signingInput),
  );
}

export async function verifySupabaseJwt(
  token: string,
  env: Env,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<SupabaseJwtClaims | null> {
  const jwtSecret = env.SUPABASE_JWT_SECRET;
  if (!jwtSecret) return null;

  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return null;

  const header = decodeJsonPart(parts[0]);
  if (!isRecord(header) || header.alg !== 'HS256') return null;

  const payload = decodeJsonPart(parts[1]);
  const claims = coerceClaims(payload);
  if (!claims) return null;
  if (!hasExpectedAudience(claims.aud)) return null;
  if (claims.iss !== expectedIssuer(env)) return null;
  if (!claimsAreCurrent(claims, nowSeconds)) return null;

  const signatureIsValid = await verifyHs256Signature(`${parts[0]}.${parts[1]}`, parts[2], jwtSecret);
  return signatureIsValid ? claims : null;
}
