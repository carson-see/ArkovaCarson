/** Wire-format helpers shared by connector routers; authorization stays provider-specific. */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

function stateSignature(encoded: string, secret: string): string {
  return createHmac('sha256', secret).update(encoded).digest('base64url');
}

export function signOAuthState(payload: unknown, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${stateSignature(encoded, secret)}`;
}

/** Decode only after authenticating. The caller owns TTL, scope and identity policy. */
export function readSignedOAuthState<T>(state: string, secret: string, accepts: (payload: T) => boolean): T | null {
  const [encoded, signature] = state.split('.');
  if (!encoded || !signature) return null;
  const supplied = Buffer.from(signature);
  const expected = Buffer.from(stateSignature(encoded, secret));
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as T;
    return accepts(payload) ? payload : null;
  } catch {
    return null;
  }
}

export function requestOrigin(req: Pick<Request, 'protocol' | 'headers'>): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] ?? req.protocol;
  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  return `${proto}://${host}`;
}

export function sameOriginReturnTo(returnTo: string | undefined, frontendUrl: string, fallback: string): string {
  if (!returnTo) return fallback;
  try {
    const requested = new URL(returnTo);
    return requested.origin === new URL(frontendUrl).origin ? requested.toString() : fallback;
  } catch {
    return fallback;
  }
}

export function appendOAuthResult(url: string, key: string, value: string): string {
  const result = new URL(url);
  result.searchParams.set('tab', 'settings');
  result.searchParams.set(key, value);
  return result.toString();
}

export function toPostgresBytea(buffer: Buffer): string {
  return String.raw`\x${buffer.toString('hex')}`;
}
