/**
 * Shared webhook HMAC verifier (SCRUM-1148 / SCRUM-1030).
 *
 * Multiple vendors sign their webhooks with HMAC-SHA256 over the raw HTTP
 * body. They differ on header name and digest encoding (base64 vs hex), but
 * the underlying crypto is identical. Centralized here so vendors can't
 * drift on the timing-safe-equal path or the length check.
 */
import crypto from 'node:crypto';

export type HmacEncoding = 'base64' | 'hex';

export function verifyHmacSha256(args: {
  rawBody: Buffer | string;
  signature: string | undefined;
  secret: string;
  encoding: HmacEncoding;
}): boolean {
  if (!args.signature || !args.secret) return false;
  const body = Buffer.isBuffer(args.rawBody) ? args.rawBody : Buffer.from(args.rawBody);
  const expected = crypto.createHmac('sha256', args.secret).update(body).digest(args.encoding);
  const received = args.signature.trim();
  const a = Buffer.from(expected, args.encoding);
  let b: Buffer;
  try {
    b = Buffer.from(received, args.encoding);
  } catch {
    return false;
  }
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function verifyHmacSha256Base64(args: {
  rawBody: Buffer | string;
  signature: string | undefined;
  secret: string;
}): boolean {
  return verifyHmacSha256({ ...args, encoding: 'base64' });
}

export function verifyHmacSha256Hex(args: {
  rawBody: Buffer | string;
  signature: string | undefined;
  secret: string;
}): boolean {
  return verifyHmacSha256({ ...args, encoding: 'hex' });
}
