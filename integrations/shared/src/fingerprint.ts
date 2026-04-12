/**
 * Shared fingerprint utility for Arkova integrations.
 *
 * Uses Web Crypto API (available in browsers and Node.js 16+).
 * Identical algorithm to `@arkova/sdk` Arkova.fingerprint().
 */

/**
 * Compute SHA-256 fingerprint of an ArrayBuffer.
 * Returns a 64-character lowercase hex string.
 */
export async function computeFingerprint(data: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}
