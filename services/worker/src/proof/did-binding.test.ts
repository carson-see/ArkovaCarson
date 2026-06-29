/**
 * PROOF-06 (SCRUM-2339) — signed proof bundle binds the issuer DID.
 *
 * A verifier must be able to walk ONE trust chain:
 *   issuer DID → assertionMethod verification-method key → anchored proof.
 *
 * These tests prove:
 *   1. The issuer-binding block names the platform DID, the exact
 *      `assertionMethod` verification-method id, and the anchoring mechanism.
 *   2. The verification-method id is derived from the bundle's
 *      `signing_key_id`, so the DID document's `assertionMethod[]` entry that
 *      authorised the signature can be located deterministically.
 *   3. The SCRUM-2308 adversarial case: a forged/mismatched key id whose
 *      verification-method does NOT match the DID's assertionMethod is
 *      REJECTED — a verifier cannot be fooled into following a second key.
 *   4. SCRUM-900 backward compatibility: an unbound (legacy) bundle still
 *      verifies cryptographically; binding is additive.
 */

import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  ARKOVA_DID,
  buildArkovaDidDocument,
} from '../api/did-web.js';
import type { ProofKey } from '../api/proof-keys.js';
import {
  buildIssuerBinding,
  buildBoundProofPayload,
  verifyDidBinding,
  PROOF_ASSERTIONS,
  ANCHORING_MECHANISM,
} from './did-binding.js';
import {
  createSignedBundle,
  staticEd25519Signer,
  verifySignedBundle,
} from './signed-bundle.js';

function generateTestKeypair(): { privatePem: string; publicPem: string } {
  const kp = generateKeyPairSync('ed25519');
  return {
    privatePem: kp.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicPem: kp.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

/** A ProofKey carrying a real Ed25519 public PEM, id = signing_key_id. */
function activeKey(id: string, publicPem: string): ProofKey {
  return {
    id,
    alg: 'Ed25519',
    status: 'active',
    public_key_pem: publicPem,
    created_at: '2026-06-01T00:00:00Z',
  };
}

const KEY_ID = 'arkova-proof-2026-q2';

describe('PROOF-06 issuer-DID binding', () => {
  it('binds the platform DID, the assertionMethod vm-id, and the anchoring mechanism', () => {
    const binding = buildIssuerBinding(KEY_ID);
    expect(binding.did).toBe(ARKOVA_DID);
    // The vm-id must equal the DID document's assertionMethod entry exactly.
    expect(binding.assertion_method).toBe(`${ARKOVA_DID}#${KEY_ID}`);
    // The bundle must explicitly reference the anchoring mechanism.
    expect(binding.anchoring).toEqual(ANCHORING_MECHANISM);
    expect(binding.anchoring.chain).toBe('bitcoin');
  });

  it('the bound vm-id matches the active key entry in the resolved DID document', () => {
    const { publicPem } = generateTestKeypair();
    const didDoc = buildArkovaDidDocument(activeKey(KEY_ID, publicPem));
    const binding = buildIssuerBinding(KEY_ID);
    // The single trust chain: the binding points at an assertionMethod entry
    // that actually exists in the DID document.
    expect(didDoc.assertionMethod).toContain(binding.assertion_method);
    const vm = didDoc.verificationMethod.find((m) => m.id === binding.assertion_method);
    expect(vm).toBeDefined();
    expect(vm?.controller).toBe(ARKOVA_DID);
  });

  it('embeds the binding + §1.5 assertion wording into the proof payload (additive)', () => {
    const payload = { public_id: 'rec_abc', fingerprint: 'deadbeef', merkle_root: 'ab'.repeat(32) };
    const bound = buildBoundProofPayload(payload, KEY_ID);
    // Original fields untouched (backward compatible).
    expect(bound.public_id).toBe('rec_abc');
    expect(bound.fingerprint).toBe('deadbeef');
    // Issuer binding present.
    expect((bound.issuer as { did: string }).did).toBe(ARKOVA_DID);
    // §1.5 measured / asserted / NOT asserted wording present.
    expect(bound.assertions).toEqual(PROOF_ASSERTIONS);
  });

  it('verifyDidBinding accepts a bundle whose signing key matches the DID assertionMethod', async () => {
    const { privatePem, publicPem } = generateTestKeypair();
    const payload = buildBoundProofPayload(
      { public_id: 'rec_abc', fingerprint: 'deadbeef' },
      KEY_ID,
    );
    const bundle = await createSignedBundle({
      payload,
      sign: staticEd25519Signer(privatePem, KEY_ID),
    });
    const didDoc = buildArkovaDidDocument(activeKey(KEY_ID, publicPem));

    // Signature still verifies (cryptographic).
    expect(verifySignedBundle({ bundle, publicKeyPem: publicPem }).valid).toBe(true);
    // Full single-chain verdict: issuer DID → assertionMethod key → signature.
    const verdict = verifyDidBinding({ bundle, didDocument: didDoc });
    expect(verdict.valid).toBe(true);
    expect(verdict.verificationMethodId).toBe(`${ARKOVA_DID}#${KEY_ID}`);
  });

  it('SCRUM-2308: rejects a forged key id not listed as an assertionMethod', async () => {
    // Attacker re-signs the bundle with their OWN key and claims a key id
    // ("evil-key") that the DID document never authorised.
    const attacker = generateTestKeypair();
    const payload = buildBoundProofPayload(
      { public_id: 'rec_abc', fingerprint: 'deadbeef' },
      'evil-key',
    );
    const forged = await createSignedBundle({
      payload,
      sign: staticEd25519Signer(attacker.privatePem, 'evil-key'),
    });

    // The DID document only authorises the real key.
    const real = generateTestKeypair();
    const didDoc = buildArkovaDidDocument(activeKey(KEY_ID, real.publicPem));

    const verdict = verifyDidBinding({ bundle: forged, didDocument: didDoc });
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toContain('assertionMethod');
  });

  it('SCRUM-2308: rejects when signing_key_id disagrees with the bound assertion_method', async () => {
    // The envelope says it was signed by KEY_ID, but the payload's binding
    // points at a DIFFERENT vm-id — a mismatched/spoofed binding.
    const { privatePem, publicPem } = generateTestKeypair();
    const payload = buildBoundProofPayload(
      { public_id: 'rec_abc', fingerprint: 'deadbeef' },
      'some-other-key', // binding points elsewhere
    );
    const bundle = await createSignedBundle({
      payload,
      sign: staticEd25519Signer(privatePem, KEY_ID), // envelope signed by KEY_ID
    });
    const didDoc = buildArkovaDidDocument(activeKey(KEY_ID, publicPem));

    const verdict = verifyDidBinding({ bundle, didDocument: didDoc });
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toContain('signing_key_id');
  });

  it('SCRUM-2308: rejects when the signature itself fails under the DID key', async () => {
    // Right key id, but the bytes were signed by a different private key:
    // the DID's published public key cannot verify the signature.
    const signer = generateTestKeypair();
    const didKp = generateTestKeypair(); // different key published in the DID
    const payload = buildBoundProofPayload(
      { public_id: 'rec_abc', fingerprint: 'deadbeef' },
      KEY_ID,
    );
    const bundle = await createSignedBundle({
      payload,
      sign: staticEd25519Signer(signer.privatePem, KEY_ID),
    });
    const didDoc = buildArkovaDidDocument(activeKey(KEY_ID, didKp.publicPem));

    const verdict = verifyDidBinding({ bundle, didDocument: didDoc });
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toContain('signature');
  });

  it('SCRUM-900 backward compatibility: an unbound legacy bundle still verifies cryptographically', async () => {
    const { privatePem, publicPem } = generateTestKeypair();
    // Legacy payload with NO issuer/assertions block.
    const legacy = await createSignedBundle({
      payload: { fingerprint: 'deadbeef', chain_tx_id: 'tx', merkle_path: [] },
      sign: staticEd25519Signer(privatePem, KEY_ID),
    });
    expect(verifySignedBundle({ bundle: legacy, publicKeyPem: publicPem }).valid).toBe(true);

    // verifyDidBinding still confirms the key chain even without an embedded
    // binding (it derives the vm-id from signing_key_id), but flags the
    // bundle as legacy/unbound so callers know it predates PROOF-06.
    const didDoc = buildArkovaDidDocument(activeKey(KEY_ID, publicPem));
    const verdict = verifyDidBinding({ bundle: legacy, didDocument: didDoc });
    expect(verdict.valid).toBe(true);
    expect(verdict.bound).toBe(false);
  });

  it('a PROOF-06 bound bundle is flagged bound=true', async () => {
    const { privatePem, publicPem } = generateTestKeypair();
    const payload = buildBoundProofPayload(
      { public_id: 'rec_abc', fingerprint: 'deadbeef' },
      KEY_ID,
    );
    const bundle = await createSignedBundle({ payload, sign: staticEd25519Signer(privatePem, KEY_ID) });
    const didDoc = buildArkovaDidDocument(activeKey(KEY_ID, publicPem));
    const verdict = verifyDidBinding({ bundle, didDocument: didDoc });
    expect(verdict.valid).toBe(true);
    expect(verdict.bound).toBe(true);
  });
});
