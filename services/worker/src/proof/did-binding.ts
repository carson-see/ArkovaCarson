/**
 * PROOF-06 (SCRUM-2339) — bind the signed proof bundle to the issuer DID.
 *
 * Goal: a verifier follows ONE trust chain and nothing else —
 *
 *     issuer DID  →  assertionMethod key  →  anchored proof
 *
 * SCRUM-900 (`signed-bundle.ts`) already wraps a proof payload in a detached
 * Ed25519 signature carrying a bare `signing_key_id`. That proved
 * *authenticity of bytes* but left two gaps a verifier had to bridge by hand:
 *
 *   (a) it never said WHICH issuer identity those bytes belong to, and
 *   (b) the `signing_key_id` was a bare handle, not a DID `assertionMethod`
 *       verification-method id — so a verifier could not mechanically connect
 *       the signature to the published did:web document (`did-web.ts`).
 *
 * This module closes both. `buildIssuerBinding` derives the EXACT
 * `assertionMethod` verification-method id from the signing key id
 * (`${ARKOVA_DID}#${signing_key_id}`) — the same id `buildArkovaDidDocument`
 * emits — and declares the anchoring mechanism. `buildBoundProofPayload`
 * embeds that binding plus the §1.5 measured / asserted / NOT-asserted wording
 * into the payload BEFORE signing, so the binding is itself covered by the
 * signature. `verifyDidBinding` then walks the single chain and rejects the
 * SCRUM-2308 forged/mismatched-key attacks.
 *
 * HARD CONSTRAINT (Lane 3 key custody): we bind to the EXISTING active key
 * `arkova-proof-2026-q2`. We never rotate it. Historical SCRUM-900 bundles
 * stay verifiable: each bundle's `signing_key_id` still maps to its
 * verification-method id, and `verifyDidBinding` accepts unbound legacy
 * bundles (flagging `bound: false`) so nothing pre-PROOF-06 breaks.
 *
 * CLAIMS (R-7 / §1.5): the proof asserts ONLY that a document fingerprint is
 * included in an on-chain Merkle root committed at a network-observed time,
 * and that the bundle was asserted by the bound issuer DID identity. It does
 * NOT assert document contents, signer identity beyond the key, or any legal
 * conclusion. See `PROOF_ASSERTIONS`.
 */

import { createPublicKey } from 'node:crypto';
import {
  ARKOVA_DID,
  type DidDocument,
} from '../api/did-web.js';
import { verifySignedBundle, type SignedBundle } from './signed-bundle.js';

/**
 * The anchoring mechanism the proof binds to. Declared explicitly in the
 * bundle so a verifier does not have to infer it. Arkova anchors ONLY to
 * Bitcoin; the document fingerprint is included in an app-level Merkle root
 * whose root is committed on-chain in an OP_RETURN.
 */
export const ANCHORING_MECHANISM = {
  chain: 'bitcoin',
  method: 'merkle-root-op-return',
  commitment: 'The document fingerprint is a leaf of a Merkle tree whose root is committed on the Bitcoin blockchain in an OP_RETURN output.',
} as const;

export type AnchoringMechanism = typeof ANCHORING_MECHANISM;

/**
 * §1.5 / R-7 proof-package wording describing the unified trust chain. States
 * what is MEASURED, what is ASSERTED, and — critically — what is NOT asserted.
 */
export const PROOF_ASSERTIONS = {
  measured: [
    'A document fingerprint (SHA-256) is a leaf of a Merkle tree whose root is committed on the Bitcoin blockchain.',
    'The block time at which that Merkle root was observed on the Production Network.',
  ],
  asserted: [
    'This proof bundle was signed by the Arkova issuer identity identified by the bound DID and its assertionMethod key.',
    'A verifier can follow a single trust chain: issuer DID → assertionMethod key → anchored Merkle root, with no Arkova online dependency.',
  ],
  not_asserted: [
    'The contents, meaning, validity, or legal effect of the underlying document.',
    'The identity of any human signer beyond the cryptographic signature.',
    'Any endorsement, accreditation, or registry listing not separately evidenced.',
    'Existence of the document before the network-observed block time.',
  ],
} as const;

export type ProofAssertions = typeof PROOF_ASSERTIONS;

/** The issuer-binding block embedded in a bound proof payload. */
export interface IssuerBinding {
  /** The platform did:web identity that issued (signed) this bundle. */
  did: string;
  /**
   * The EXACT `assertionMethod` verification-method id in the DID document
   * whose key authorised the signature: `${did}#${signing_key_id}`.
   */
  assertion_method: string;
  /** The anchoring mechanism the proof binds to. */
  anchoring: AnchoringMechanism;
}

/**
 * Derive the issuer binding for a given signing key id. The verification-method
 * id MUST match what `buildArkovaDidDocument` emits for the same key.
 */
export function buildIssuerBinding(signingKeyId: string): IssuerBinding {
  return {
    did: ARKOVA_DID,
    assertion_method: `${ARKOVA_DID}#${signingKeyId}`,
    anchoring: ANCHORING_MECHANISM,
  };
}

/**
 * Embed the issuer binding + §1.5 assertion wording into a proof payload,
 * additively. Original fields are preserved verbatim (SCRUM-900 backward
 * compatible). The returned object is signed by the caller, so the binding is
 * itself covered by the Ed25519 signature.
 */
export function buildBoundProofPayload(
  payload: Record<string, unknown>,
  signingKeyId: string,
): Record<string, unknown> {
  return {
    ...payload,
    issuer: buildIssuerBinding(signingKeyId),
    assertions: PROOF_ASSERTIONS,
  };
}

export interface VerifyDidBindingInput {
  bundle: SignedBundle;
  /** The resolved did:web document for the issuer DID. */
  didDocument: DidDocument;
}

export interface DidBindingVerdict {
  valid: boolean;
  /** The verification-method id the chain resolved to (when valid). */
  verificationMethodId?: string;
  /** True when the payload carried a PROOF-06 issuer binding; false for legacy bundles. */
  bound: boolean;
  /** Machine-stable short reason on failure (never leaks document bytes). */
  reason?: string;
}

function readEmbeddedBinding(payload: Record<string, unknown>): IssuerBinding | null {
  const issuer = payload.issuer;
  if (
    typeof issuer === 'object' &&
    issuer !== null &&
    typeof (issuer as Record<string, unknown>).assertion_method === 'string'
  ) {
    return issuer as unknown as IssuerBinding;
  }
  return null;
}

/**
 * Verify the single trust chain: issuer DID → assertionMethod key → signature.
 *
 * Steps (fail closed at each):
 *   1. Derive the verification-method id from the bundle's `signing_key_id`.
 *   2. Require that vm-id to be listed in the DID document's `assertionMethod`
 *      (a key not authorised to assert is rejected — SCRUM-2308 forged-key).
 *   3. If the payload carries an embedded binding, its `assertion_method` MUST
 *      equal the vm-id derived from `signing_key_id` (no spoofed binding).
 *   4. Convert that verification-method's public JWK to a PEM and require the
 *      detached Ed25519 signature to verify under it.
 *
 * Legacy SCRUM-900 bundles with no embedded binding still verify (the vm-id is
 * derived from `signing_key_id`); they are flagged `bound: false`.
 */
export function verifyDidBinding(input: VerifyDidBindingInput): DidBindingVerdict {
  const { bundle, didDocument } = input;
  const embedded = readEmbeddedBinding(bundle.payload);
  const bound = embedded !== null;

  const signingKeyId = bundle.signing_key_id;
  if (typeof signingKeyId !== 'string' || signingKeyId.length === 0) {
    return { valid: false, bound, reason: 'bundle is missing signing_key_id' };
  }

  // 1. Derive the vm-id the signer's key id maps to under the DID.
  const vmId = `${didDocument.id}#${signingKeyId}`;

  // 2. The vm-id must be an authorised assertionMethod entry.
  if (!Array.isArray(didDocument.assertionMethod) || !didDocument.assertionMethod.includes(vmId)) {
    return {
      valid: false,
      bound,
      reason: `signing_key_id ${signingKeyId} is not listed as an assertionMethod in the issuer DID document`,
    };
  }

  // 3. If a binding is embedded, it must agree with the signing_key_id (no
  //    spoofed binding pointing a verifier at a different key).
  if (embedded) {
    if (embedded.did !== didDocument.id) {
      return { valid: false, bound, reason: 'embedded issuer.did does not match the resolved DID document id' };
    }
    if (embedded.assertion_method !== vmId) {
      return {
        valid: false,
        bound,
        reason: 'embedded issuer.assertion_method disagrees with signing_key_id — mismatched binding rejected',
      };
    }
  }

  // 4. Resolve the verification-method's public key and verify the signature.
  const vm = didDocument.verificationMethod.find((m) => m.id === vmId);
  if (!vm) {
    return { valid: false, bound, reason: `verification method ${vmId} not found in DID document` };
  }
  let publicKeyPem: string;
  try {
    publicKeyPem = ed25519JwkToPem(vm.publicKeyJwk);
  } catch {
    return { valid: false, bound, reason: 'verification method public key is not a valid Ed25519 JWK' };
  }

  const sigResult = verifySignedBundle({ bundle, publicKeyPem });
  if (!sigResult.valid) {
    return { valid: false, bound, reason: `signature did not verify under the DID assertionMethod key: ${sigResult.reason ?? 'unknown'}` };
  }

  return { valid: true, bound, verificationMethodId: vmId };
}

/**
 * Convert an OKP/Ed25519 public JWK (as published in the DID document) back to
 * an SPKI PEM so Node `crypto` can verify the detached signature against it.
 */
function ed25519JwkToPem(jwk: { kty: string; crv: string; x: string }): string {
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    throw new Error('not an Ed25519 OKP JWK');
  }
  // Round-trip the JWK through Node crypto to obtain the SPKI PEM. This avoids
  // hand-assembling DER and reuses the same key import the rest of the proof
  // stack relies on.
  const key = createPublicKey({
    key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x },
    format: 'jwk',
  });
  return key.export({ format: 'pem', type: 'spki' }).toString();
}
