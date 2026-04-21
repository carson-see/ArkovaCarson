/**
 * MCP HMAC Envelope Signing (SCRUM-920 MCP-SEC-02)
 *
 * Signs the oracle_batch_verify response envelope with HMAC-SHA256 so
 * callers can detect tampering between Arkova and their system.
 *
 * Uses WebCrypto API (available in Cloudflare Workers natively).
 */

const ALG = 'HMAC';
const HASH = 'SHA-256';
const KEY_ID = 'mcp-signing-v1';

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hmacSha256(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: ALG, hash: HASH },
    false,
    ['sign'],
  );
  const sig = await globalThis.crypto.subtle.sign(ALG, cryptoKey, enc.encode(message));
  return toHex(sig);
}

export interface SignedEnvelope<T> {
  payload: T;
  signature: string;
  alg: 'HMAC-SHA256';
  key_id: string;
}

export async function signEnvelope<T>(
  payload: T,
  signingKey: string,
): Promise<SignedEnvelope<T>> {
  const canonical = JSON.stringify(payload);
  const signature = await hmacSha256(signingKey, canonical);
  return { payload, signature, alg: 'HMAC-SHA256', key_id: KEY_ID };
}

export async function verifyEnvelope<T>(
  envelope: SignedEnvelope<T>,
  signingKey: string,
): Promise<boolean> {
  const canonical = JSON.stringify(envelope.payload);
  const expected = await hmacSha256(signingKey, canonical);
  return expected === envelope.signature;
}
