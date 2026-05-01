/**
 * SCRUM-1283 (R3-10) sub-issue C — HMAC-signed R2 download URLs.
 *
 * Cloudflare R2 doesn't expose presigned-URL generation through the
 * Workers binding (you'd need the S3-compatible API + an access-key
 * secret). Instead, this module signs a Worker-served download path
 * with HMAC-SHA256 + an expiry timestamp. The /reports/dl route on
 * the main edge Worker verifies the signature and expiry, then streams
 * the bytes from R2.
 *
 * The signed payload binds the R2 key + expiry timestamp; the secret
 * lives only in `R2_REPORT_DOWNLOAD_SECRET`. Verification uses a
 * constant-time hex compare.
 */

const ENCODER = new TextEncoder();

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    ENCODER.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, ENCODER.encode(message));
  return Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Build an HMAC-signed download URL for an R2 report key.
 *
 * The returned URL points at the main edge Worker (`/reports/dl/<key>`)
 * with `expires` (unix seconds) and `sig` query params. The receiving
 * handler verifies the signature and expiry before streaming R2 bytes.
 *
 * @param baseUrl   absolute origin including scheme — e.g. https://edge.arkova.ai
 * @param key       R2 object key (path under the bucket; usually built by buildR2Key())
 * @param secret    HMAC secret from env.R2_REPORT_DOWNLOAD_SECRET
 * @param expiresInSec  seconds from now until the URL stops being honored
 */
export async function buildSignedReportUrl(
  baseUrl: string,
  key: string,
  secret: string,
  expiresInSec: number,
): Promise<string> {
  if (!secret) throw new Error('R2_REPORT_DOWNLOAD_SECRET is required to sign report URLs');
  const expires = Math.floor(Date.now() / 1000) + expiresInSec;
  const sig = await hmacSha256Hex(secret, `${key}\n${expires}`);
  // Encode the key path so any slashes / unicode chars survive the URL round-trip.
  const url = new URL(`/reports/dl/${encodeURIComponent(key)}`, baseUrl);
  url.searchParams.set('expires', String(expires));
  url.searchParams.set('sig', sig);
  return url.toString();
}

export type VerifyResult =
  | { ok: true; key: string }
  | { ok: false; reason: 'expired' | 'invalid_signature' | 'malformed' };

/**
 * Verify an incoming `/reports/dl/<key>?expires=…&sig=…` request.
 *
 * Returns `{ ok: true, key }` when the signature matches and the
 * expiry is in the future. Otherwise returns the failure reason so
 * the caller can return a precise HTTP status.
 */
export async function verifySignedReportUrl(
  url: URL,
  secret: string,
): Promise<VerifyResult> {
  if (!secret) return { ok: false, reason: 'malformed' };
  // Path is `/reports/dl/<encoded-key>`; everything after the prefix is the
  // url-encoded key. We do NOT use URL.pathname.split because keys can
  // contain encoded slashes that would otherwise be lost.
  const prefix = '/reports/dl/';
  if (!url.pathname.startsWith(prefix)) return { ok: false, reason: 'malformed' };
  const encodedKey = url.pathname.slice(prefix.length);
  if (!encodedKey) return { ok: false, reason: 'malformed' };
  let key: string;
  try {
    key = decodeURIComponent(encodedKey);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const expiresStr = url.searchParams.get('expires');
  const sig = url.searchParams.get('sig');
  if (!expiresStr || !sig) return { ok: false, reason: 'malformed' };
  const expires = Number(expiresStr);
  if (!Number.isFinite(expires)) return { ok: false, reason: 'malformed' };
  if (expires < Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired' };
  const expected = await hmacSha256Hex(secret, `${key}\n${expires}`);
  if (!constantTimeEqualHex(expected, sig)) return { ok: false, reason: 'invalid_signature' };
  return { ok: true, key };
}
