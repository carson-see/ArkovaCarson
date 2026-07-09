/**
 * Optional Ed25519 signature verification of a signed proof bundle against the
 * PUBLISHED Arkova key (docs.arkova.ai/keys.json / did:web:app.arkova.ai).
 *
 * IMPORTANT (verifier-oss-sdk-predesign §2.4, §6): the signature proves only
 * that *Arkova issued this packet*. It is NEVER a substitute for recomputation
 * — the on-chain fact is established solely by the Merkle recompute + the
 * independent tx/block confirmation. This module is reported independently and
 * never gates the cryptographic verdict.
 *
 * The canonicalisation is byte-identical to the server signer
 * (`vendor/canonical-json.ts`, a verbatim copy guarded by the sync test) so a
 * bundle signed server-side verifies here without trusting Arkova at runtime.
 */

import { createPublicKey, verify as nodeVerify, type KeyObject } from 'node:crypto';
import { canonicaliseJson } from '../vendor/canonical-json.js';
import type { PublishedKeys, SignedProofBundle } from '../types.js';

export interface SignatureResult {
  /** 'verified' | 'failed' | 'skipped' (no bundle/key supplied). */
  status: 'verified' | 'failed' | 'skipped';
  reason?: string;
  signingKeyId?: string;
  /**
   * Machine failure class when status === 'failed' (S3-B frozen enum):
   *  - 'SIG_INVALID'    — the Ed25519 check itself failed (bad bytes/alg/key);
   *  - 'DID_UNRESOLVED' — the bundle's signing_key_id is not present in the
   *    supplied published key set (the verifier never guesses a key).
   */
  failureCode?: 'SIG_INVALID' | 'DID_UNRESOLVED';
}

function parsePublicKey(pem: string): KeyObject | null {
  try {
    return createPublicKey(pem);
  } catch {
    return null;
  }
}

/**
 * Verify the bundle's detached Ed25519 signature over the canonicalised
 * payload against the published Arkova key material (fetched out-of-band by
 * the caller — e.g. from docs.arkova.ai/keys.json, which the auditor can pin).
 *
 * Key resolution (S3-B):
 *  - When a `publishedKeys` SET is supplied, the bundle's `signing_key_id` is
 *    resolved against `keys[].kid`. An id that resolves to no key fails closed
 *    (`DID_UNRESOLVED`) — the verifier NEVER falls back to "try every key".
 *  - A bare `publicKeyPem` (raw PEM / single-key file) keeps the legacy
 *    behaviour: verify directly against that key, no id resolution.
 */
export function verifyBundleSignature(
  bundle: SignedProofBundle | undefined,
  publicKeyPem: string | undefined,
  publishedKeys?: PublishedKeys,
): SignatureResult {
  const haveKeySet = publishedKeys != null && publishedKeys.keys.length > 0;
  if (!bundle || (!publicKeyPem && !haveKeySet)) return { status: 'skipped' };

  let pem = publicKeyPem;
  if (haveKeySet) {
    // Fail closed BEFORE resolution when the bundle names no real signing key
    // id: malformed runtime JSON must not match a kid-less key entry via
    // `undefined === undefined` and sneak past the DID_UNRESOLVED gate.
    if (typeof bundle.signing_key_id !== 'string' || bundle.signing_key_id.trim() === '') {
      return {
        status: 'failed',
        failureCode: 'DID_UNRESOLVED',
        reason: 'the bundle carries no signing key id — the signer identity cannot be resolved against the published key set',
      };
    }
    const resolved = publishedKeys.keys.find((k) => typeof k.kid === 'string' && k.kid === bundle.signing_key_id);
    if (!resolved) {
      return {
        status: 'failed',
        failureCode: 'DID_UNRESOLVED',
        reason: `signing key id "${bundle.signing_key_id}" is not present in the published key set — the signer identity cannot be resolved`,
        signingKeyId: bundle.signing_key_id,
      };
    }
    pem = resolved.pem;
  }

  if (bundle.signature?.alg !== 'Ed25519') {
    return {
      status: 'failed',
      failureCode: 'SIG_INVALID',
      reason: `unsupported signature alg ${bundle.signature?.alg}`,
    };
  }
  const key = parsePublicKey(pem as string);
  if (!key) return { status: 'failed', failureCode: 'SIG_INVALID', reason: 'invalid published key PEM' };

  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(bundle.signature.value, 'base64url');
  } catch {
    return { status: 'failed', failureCode: 'SIG_INVALID', reason: 'signature not base64url' };
  }

  const canonical = canonicaliseJson(bundle.payload);
  const ok = nodeVerify(null, Buffer.from(canonical, 'utf8'), key, signatureBytes);
  return ok
    ? { status: 'verified', signingKeyId: bundle.signing_key_id }
    : {
        status: 'failed',
        failureCode: 'SIG_INVALID',
        reason: 'signature verification failed',
        signingKeyId: bundle.signing_key_id,
      };
}
