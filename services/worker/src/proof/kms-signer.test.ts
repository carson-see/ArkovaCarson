/**
 * SCRUM-900 PROOF-SIG-01 — GCP KMS Ed25519 SignerFn adapter tests.
 *
 * The KMS adapter is a thin shim around `client.asymmetricSign`. We
 * verify the round-trip works end-to-end against `verifySignedBundle`
 * by faking the KMS client with a deterministic Ed25519 keypair from
 * `node:crypto`. That guarantees:
 *   - the canonical-JSON bytes the bundle commits to are exactly what
 *     the signer signs (no double-encode, no whitespace drift);
 *   - the bundle envelope carries the configured short key id;
 *   - empty / missing signatures from KMS surface as a hard error so
 *     the proof endpoint can return 503 instead of shipping an
 *     unsigned bundle by accident.
 */

import { describe, expect, it } from 'vitest';
import { createPrivateKey, generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import {
  createSignedBundle,
  verifySignedBundle,
} from './signed-bundle.js';
import {
  gcpKmsEd25519Signer,
  type KmsEd25519ClientLike,
} from './kms-signer.js';

function buildFakeKmsClient(privatePem: string): KmsEd25519ClientLike {
  const privateKey = createPrivateKey(privatePem);
  return {
    async asymmetricSignEd25519(_keyName: string, data: Buffer): Promise<Uint8Array> {
      // Real GCP KMS Ed25519 returns the raw 64-byte signature; mirror it.
      return nodeSign(null, data, privateKey);
    },
  };
}

function generateTestKeypair(): { privatePem: string; publicPem: string } {
  const kp = generateKeyPairSync('ed25519');
  return {
    privatePem: kp.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicPem: kp.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

describe('SCRUM-900 gcpKmsEd25519Signer', () => {
  it('signs a bundle that round-trips through verifySignedBundle', async () => {
    const { privatePem, publicPem } = generateTestKeypair();
    const client = buildFakeKmsClient(privatePem);
    const signer = gcpKmsEd25519Signer(
      {
        keyResourceName:
          'projects/arkova1/locations/us-central1/keyRings/proof/cryptoKeys/proof-signer/cryptoKeyVersions/1',
        shortKeyId: 'arkova-proof-2026-q2',
      },
      client,
    );
    const bundle = await createSignedBundle({
      payload: { fingerprint: 'deadbeef', chain_tx_id: 'abc123', merkle_path: [] },
      sign: signer,
    });
    expect(bundle.signing_key_id).toBe('arkova-proof-2026-q2');
    const result = verifySignedBundle({ bundle, publicKeyPem: publicPem });
    expect(result.valid).toBe(true);
  });

  it('falls back to the resource-name tail when shortKeyId is omitted', async () => {
    const { privatePem } = generateTestKeypair();
    const signer = gcpKmsEd25519Signer(
      {
        keyResourceName:
          'projects/arkova1/locations/us-central1/keyRings/proof/cryptoKeys/proof-signer/cryptoKeyVersions/3',
      },
      buildFakeKmsClient(privatePem),
    );
    const bundle = await createSignedBundle({
      payload: { fingerprint: 'deadbeef' },
      sign: signer,
    });
    expect(bundle.signing_key_id).toBe('3');
  });

  it('throws when the KMS client returns an empty signature', async () => {
    const emptyClient: KmsEd25519ClientLike = {
      async asymmetricSignEd25519() {
        return new Uint8Array(0);
      },
    };
    const signer = gcpKmsEd25519Signer(
      { keyResourceName: 'projects/x/locations/y/keyRings/k/cryptoKeys/c/cryptoKeyVersions/1' },
      emptyClient,
    );
    await expect(
      createSignedBundle({ payload: { fingerprint: 'deadbeef' }, sign: signer }),
    ).rejects.toThrow(/empty signature/);
  });

  it('signs the canonical JSON bytes exactly — no double-encoding', async () => {
    const { privatePem } = generateTestKeypair();
    let observedBytes: Buffer | null = null;
    const peekClient: KmsEd25519ClientLike = {
      async asymmetricSignEd25519(_keyName: string, data: Buffer): Promise<Uint8Array> {
        observedBytes = Buffer.from(data);
        return nodeSign(null, data, createPrivateKey(privatePem));
      },
    };
    const signer = gcpKmsEd25519Signer(
      {
        keyResourceName: 'projects/x/locations/y/keyRings/k/cryptoKeys/c/cryptoKeyVersions/1',
        shortKeyId: 'k1',
      },
      peekClient,
    );
    await createSignedBundle({
      payload: { b: 1, a: [{ y: 2, x: 1 }] },
      sign: signer,
    });
    expect(observedBytes).not.toBeNull();
    // Canonicalised: keys sorted alphabetically, no whitespace.
    expect(observedBytes!.toString('utf8')).toBe('{"a":[{"x":1,"y":2}],"b":1}');
  });
});
