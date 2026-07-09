/**
 * Signature verification — the published-key Ed25519 check is OPTIONAL and is
 * reported independently. It NEVER substitutes for recomputation: a passing
 * signature over a packet whose recompute fails must still yield NOT VERIFIED.
 */

import { describe, it, expect } from 'vitest';
import { verifyBundleSignature } from '../src/lib/signature.js';
import { verifyProof } from '../src/verify.js';
import { readFixtureFile, offlineNode, loadSyntheticFixtures } from './helpers.js';
import type { PublishedKeys, SignedProofBundle } from '../src/types.js';

const bundle = JSON.parse(readFixtureFile('signed-bundle.json')) as SignedProofBundle;
// The raw PEM is sourced from the tracked keys.json (a *.pem file would be
// git-ignored by the repo-wide secret-hygiene rule).
const pem = (JSON.parse(readFixtureFile('published-keys.json')) as { keys: { pem: string }[] })
  .keys[0].pem;

describe('verifyBundleSignature', () => {
  it('verifies a genuine signature against the published key', () => {
    const r = verifyBundleSignature(bundle, pem);
    expect(r.status).toBe('verified');
    expect(r.signingKeyId).toBe('arkova-proof-2026-q2');
  });

  it('skips when no bundle/key supplied', () => {
    expect(verifyBundleSignature(undefined, pem).status).toBe('skipped');
    expect(verifyBundleSignature(bundle, undefined).status).toBe('skipped');
  });

  it('fails on a tampered payload', () => {
    const tampered: SignedProofBundle = {
      ...bundle,
      payload: { ...bundle.payload, fingerprint: 'ff'.repeat(32) },
    };
    expect(verifyBundleSignature(tampered, pem).status).toBe('failed');
  });

  it('fails closed (DID_UNRESOLVED) when the bundle carries no signing key id', () => {
    // Malformed runtime JSON: no signing_key_id on the bundle AND a key set
    // whose entries carry no kid. `undefined === undefined` must NOT resolve a
    // key — the signer identity is unresolved and the check fails closed.
    const keySet = JSON.parse(readFixtureFile('published-keys.json')) as PublishedKeys;
    const anonymousKeys: PublishedKeys = { keys: keySet.keys.map((k) => ({ pem: k.pem })) };
    const { signing_key_id: _dropped, ...rest } = bundle;
    const stripped = rest as unknown as SignedProofBundle;
    const r = verifyBundleSignature(stripped, undefined, anonymousKeys);
    expect(r.status).toBe('failed');
    expect(r.failureCode).toBe('DID_UNRESOLVED');
  });
});

describe('signature NEVER substitutes for recomputation', () => {
  it('valid signature over a recompute-FAILING packet still yields NOT VERIFIED', async () => {
    // Take a fixture's chain, but feed a tampered fingerprint with a valid-looking
    // signature bundle — the signature passes, recompute fails ⇒ ok must be false.
    const fail = loadSyntheticFixtures().find((f) => f.name === 'tampered-fingerprint-fail')!;
    const signedOverGood: SignedProofBundle = bundle; // signature is over the GOOD packet
    const report = await verifyProof(fail.packet, {
      chain: offlineNode(fail),
      signedBundle: signedOverGood,
      publicKeyPem: pem,
    });
    expect(report.ok).toBe(false);
    // The signature line is reported independently of the verdict.
    expect(['verified', 'failed']).toContain(report.signature.status);
  });
});
