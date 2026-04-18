/**
 * SCRUM-900 PROOF-SIG-01 — signed proof bundle sign + verify round-trip.
 */

import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  BUNDLE_VERSION,
  SIGNATURE_ALG,
  canonicalise,
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

describe('SCRUM-900 signed proof bundle', () => {
  it('canonicalises object keys in sorted order recursively', () => {
    const a = canonicalise({ b: 1, a: [{ y: 2, x: 1 }] });
    const b = canonicalise({ a: [{ x: 1, y: 2 }], b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":[{"x":1,"y":2}],"b":1}');
  });

  it('produces a bundle with the required envelope fields', async () => {
    const { privatePem } = generateTestKeypair();
    const bundle = await createSignedBundle({
      payload: { fingerprint: 'deadbeef', chain_tx_id: 'abc123', merkle_path: [] },
      sign: staticEd25519Signer(privatePem, 'arkova-proof-2026-q2'),
      now: () => new Date('2026-04-18T00:00:00Z'),
    });
    expect(bundle.bundle_version).toBe(BUNDLE_VERSION);
    expect(bundle.signature.alg).toBe(SIGNATURE_ALG);
    expect(bundle.signing_key_id).toBe('arkova-proof-2026-q2');
    expect(bundle.signed_at_utc).toBe('2026-04-18T00:00:00.000Z');
    expect(bundle.payload.fingerprint).toBe('deadbeef');
  });

  it('verifies a bundle signed with the matching key', async () => {
    const { privatePem, publicPem } = generateTestKeypair();
    const bundle = await createSignedBundle({
      payload: { fingerprint: 'deadbeef', chain_tx_id: 'tx', merkle_path: [{ hash: 'a', position: 'left' }] },
      sign: staticEd25519Signer(privatePem, 'arkova-proof-2026-q2'),
    });
    const result = verifySignedBundle({ bundle, publicKeyPem: publicPem });
    expect(result.valid).toBe(true);
  });

  it('rejects a bundle whose payload has been tampered with after signing', async () => {
    const { privatePem, publicPem } = generateTestKeypair();
    const bundle = await createSignedBundle({
      payload: { fingerprint: 'deadbeef', chain_tx_id: 'tx' },
      sign: staticEd25519Signer(privatePem, 'arkova-proof-2026-q2'),
    });
    const tampered = {
      ...bundle,
      payload: { ...bundle.payload, fingerprint: 'cafebabe' },
    };
    const result = verifySignedBundle({ bundle: tampered, publicKeyPem: publicPem });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('signature verification failed');
  });

  it('rejects when verified with a different key (supports rotation)', async () => {
    const kp1 = generateTestKeypair();
    const kp2 = generateTestKeypair();
    const bundle = await createSignedBundle({
      payload: { fingerprint: 'ab' },
      sign: staticEd25519Signer(kp1.privatePem, 'key-1'),
    });
    const wrongKey = verifySignedBundle({ bundle, publicKeyPem: kp2.publicPem });
    expect(wrongKey.valid).toBe(false);
    const rightKey = verifySignedBundle({ bundle, publicKeyPem: kp1.publicPem });
    expect(rightKey.valid).toBe(true);
  });

  it('rejects bundles with an unsupported bundle_version', async () => {
    const { privatePem, publicPem } = generateTestKeypair();
    const bundle = await createSignedBundle({
      payload: { a: 1 },
      sign: staticEd25519Signer(privatePem, 'key'),
    });
    const result = verifySignedBundle({
      bundle: { ...bundle, bundle_version: '9.9.9' as '1.0.0' },
      publicKeyPem: publicPem,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('unsupported bundle_version');
  });

  it('rejects bundles with an unsupported signature alg', async () => {
    const { privatePem, publicPem } = generateTestKeypair();
    const bundle = await createSignedBundle({
      payload: { a: 1 },
      sign: staticEd25519Signer(privatePem, 'key'),
    });
    const result = verifySignedBundle({
      bundle: { ...bundle, signature: { alg: 'RSA' as 'Ed25519', value: bundle.signature.value } },
      publicKeyPem: publicPem,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('unsupported signature alg');
  });

  it('signature is stable across key reordering (canonicalisation proof)', async () => {
    const { privatePem, publicPem } = generateTestKeypair();
    const b1 = await createSignedBundle({
      payload: { fingerprint: 'ab', chain_tx_id: 'cd', nested: { y: 2, x: 1 } },
      sign: staticEd25519Signer(privatePem, 'key'),
    });
    const b2 = await createSignedBundle({
      payload: { nested: { x: 1, y: 2 }, chain_tx_id: 'cd', fingerprint: 'ab' },
      sign: staticEd25519Signer(privatePem, 'key'),
    });
    expect(b1.signature.value).toBe(b2.signature.value);
    const v1 = verifySignedBundle({ bundle: b1, publicKeyPem: publicPem });
    const v2 = verifySignedBundle({ bundle: b2, publicKeyPem: publicPem });
    expect(v1.valid && v2.valid).toBe(true);
  });
});
