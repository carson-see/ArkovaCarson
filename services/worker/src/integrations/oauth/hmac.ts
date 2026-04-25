/**
 * Shared webhook HMAC verifier (SCRUM-1148).
 *
 * DocuSign Connect and Adobe Sign both sign their webhooks with HMAC-SHA256
 * over the raw HTTP body, base64-encoded. Different headers, identical
 * crypto. Centralized here so vendors can't drift on the timing-safe-equal
 * path or the base64 length check.
 */
import crypto from 'node:crypto';

export function verifyHmacSha256Base64(args: {
  rawBody: Buffer | string;
  signature: string | undefined;
  secret: string;
}): boolean {
  if (!args.signature || !args.secret) return false;
  const body = Buffer.isBuffer(args.rawBody) ? args.rawBody : Buffer.from(args.rawBody);
  const expected = crypto.createHmac('sha256', args.secret).update(body).digest('base64');
  const received = args.signature.trim();
  const a = Buffer.from(expected, 'base64');
  let b: Buffer;
  try {
    b = Buffer.from(received, 'base64');
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
