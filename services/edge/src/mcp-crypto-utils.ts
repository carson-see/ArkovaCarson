/**
 * Shared crypto helpers for MCP edge modules.
 * WebCrypto API only (Cloudflare Workers runtime).
 */

export function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return toHex(digest);
}

/**
 * Keyed HMAC-SHA256, hex-encoded.
 *
 * Use this — not {@link sha256Hex} — for any low-entropy input whose digest we
 * persist. An IPv4 address has ~4.3e9 possible values, so a bare sha256 of one
 * is a rainbow-table lookup away from the plaintext and is an encoding rather
 * than a pseudonymisation control. Keying with a server-held secret is what
 * makes the mapping non-invertible off-box.
 */
export async function hmacSha256Hex(input: string, key: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(input));
  return toHex(signature);
}

/**
 * Constant-time comparison for two hex strings of equal expected length.
 * Prevents timing side-channel leakage of HMAC signatures.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
