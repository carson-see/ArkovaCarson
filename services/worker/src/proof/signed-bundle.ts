/**
 * Signed Proof Bundle.
 *
 * Wraps a proof payload in a detached Ed25519 signature so court clerks,
 * regulators, and auditors can verify authenticity without an Arkova
 * online dependency. The bundle shape is:
 *
 *   { payload, signature: { alg, value }, signing_key_id, signed_at_utc, bundle_version }
 *
 * Signing uses an injected `SignerFn`. Production calls GCP KMS
 * `asymmetricSign`; tests use a static Ed25519 key for deterministic
 * round-trips. Verification runs Node `crypto` against a key fetched from a
 * local cache or the published registry at `docs.arkova.ai/keys.json`.
 * Historical bundles remain verifiable after key rotation because each
 * bundle carries its `signing_key_id`.
 */

import { createPublicKey, createPrivateKey, sign as nodeSign, verify as nodeVerify, type KeyObject } from 'node:crypto';
import { canonicaliseJson } from '../utils/canonical-json.js';

export const BUNDLE_VERSION = '1.0.0';
export const SIGNATURE_ALG = 'Ed25519' as const;

export interface SignedBundle {
  payload: Record<string, unknown>;
  signature: { alg: typeof SIGNATURE_ALG; value: string };
  signing_key_id: string;
  signed_at_utc: string;
  bundle_version: typeof BUNDLE_VERSION;
}

export interface SignerFn {
  (canonicalJson: string): Promise<{ signatureBase64Url: string; signingKeyId: string }>;
}

export interface VerifyInput {
  bundle: SignedBundle;
  publicKeyPem: string;
}

export interface CreateSignedBundleInput {
  payload: Record<string, unknown>;
  sign: SignerFn;
  now?: () => Date;
}

/**
 * Re-exported for test + external use. Deterministic serialisation is
 * critical so verification reproduces the exact bytes that were signed.
 */
export const canonicalise = canonicaliseJson;

export async function createSignedBundle(
  input: CreateSignedBundleInput,
): Promise<SignedBundle> {
  const canonical = canonicaliseJson(input.payload);
  const { signatureBase64Url, signingKeyId } = await input.sign(canonical);
  const now = (input.now ?? (() => new Date()))();
  return {
    payload: input.payload,
    signature: { alg: SIGNATURE_ALG, value: signatureBase64Url },
    signing_key_id: signingKeyId,
    signed_at_utc: now.toISOString(),
    bundle_version: BUNDLE_VERSION,
  };
}

// Parsed-key cache so high-QPS verify doesn't re-parse the same PEM per call.
const publicKeyCache = new Map<string, KeyObject>();

function getCachedPublicKey(pem: string): KeyObject | null {
  const cached = publicKeyCache.get(pem);
  if (cached) return cached;
  try {
    const key = createPublicKey(pem);
    publicKeyCache.set(pem, key);
    return key;
  } catch {
    return null;
  }
}

export function verifySignedBundle(input: VerifyInput): {
  valid: boolean;
  reason?: string;
} {
  const { bundle, publicKeyPem } = input;
  if (bundle.bundle_version !== BUNDLE_VERSION) {
    return { valid: false, reason: `unsupported bundle_version ${bundle.bundle_version}` };
  }
  if (bundle.signature?.alg !== SIGNATURE_ALG) {
    return { valid: false, reason: `unsupported signature alg ${bundle.signature?.alg}` };
  }
  const canonical = canonicaliseJson(bundle.payload);
  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(bundle.signature.value, 'base64url');
  } catch {
    return { valid: false, reason: 'signature not base64url' };
  }
  const publicKey = getCachedPublicKey(publicKeyPem);
  if (!publicKey) return { valid: false, reason: 'invalid public key PEM' };
  const ok = nodeVerify(null, Buffer.from(canonical, 'utf8'), publicKey, signatureBytes);
  if (!ok) return { valid: false, reason: 'signature verification failed' };
  return { valid: true };
}

// Memoised private-key parse — same-PEM signers share one KeyObject.
const privateKeyCache = new Map<string, KeyObject>();

/** Build a SignerFn backed by a static Ed25519 private key (dev + tests). */
export function staticEd25519Signer(
  privateKeyPem: string,
  signingKeyId: string,
): SignerFn {
  let key = privateKeyCache.get(privateKeyPem);
  if (!key) {
    key = createPrivateKey(privateKeyPem);
    privateKeyCache.set(privateKeyPem, key);
  }
  const privateKey = key;
  return async (canonical: string) => {
    const signature = nodeSign(null, Buffer.from(canonical, 'utf8'), privateKey);
    return {
      signatureBase64Url: signature.toString('base64url'),
      signingKeyId,
    };
  };
}
