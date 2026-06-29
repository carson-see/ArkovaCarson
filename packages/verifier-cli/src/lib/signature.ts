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
import type { SignedProofBundle } from '../types.js';

export interface SignatureResult {
  /** 'verified' | 'failed' | 'skipped' (no bundle/key supplied). */
  status: 'verified' | 'failed' | 'skipped';
  reason?: string;
  signingKeyId?: string;
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
 * payload. `publicKeyPem` is the published Arkova key (fetched out-of-band by
 * the caller — e.g. from docs.arkova.ai/keys.json, which the auditor can pin).
 */
export function verifyBundleSignature(
  bundle: SignedProofBundle | undefined,
  publicKeyPem: string | undefined,
): SignatureResult {
  if (!bundle || !publicKeyPem) return { status: 'skipped' };

  if (bundle.signature?.alg !== 'Ed25519') {
    return { status: 'failed', reason: `unsupported signature alg ${bundle.signature?.alg}` };
  }
  const key = parsePublicKey(publicKeyPem);
  if (!key) return { status: 'failed', reason: 'invalid published key PEM' };

  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(bundle.signature.value, 'base64url');
  } catch {
    return { status: 'failed', reason: 'signature not base64url' };
  }

  const canonical = canonicaliseJson(bundle.payload);
  const ok = nodeVerify(null, Buffer.from(canonical, 'utf8'), key, signatureBytes);
  return ok
    ? { status: 'verified', signingKeyId: bundle.signing_key_id }
    : { status: 'failed', reason: 'signature verification failed', signingKeyId: bundle.signing_key_id };
}
