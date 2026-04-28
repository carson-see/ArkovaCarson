/**
 * GCP Cloud KMS Ed25519 Signer for proof bundles (SCRUM-900 / PROOF-SIG-01).
 *
 * Builds a `SignerFn` (the contract from `signed-bundle.ts`) backed by a
 * GCP KMS Ed25519 key. The private key never leaves KMS — the worker
 * sends the canonical-JSON bytes and KMS returns the raw signature.
 *
 * Production wiring:
 *   - Set `PROOF_SIGNING_KMS_KEY` env var to the KMS key resource name
 *     (`projects/{p}/locations/{l}/keyRings/{kr}/cryptoKeys/{ck}/cryptoKeyVersions/{v}`)
 *   - Set `PROOF_SIGNING_KEY_ID` env var to the public key id used in the
 *     bundle (`signing_key_id`) and the `keys.json` registry entry
 *   - Service account binding: `roles/cloudkms.signerVerifier` on the key
 *
 * Tests inject a `KmsClientLike` mock so we don't hit live KMS.
 *
 * Constitution §1.4: key resource name is logged at info; signature
 * payloads are NEVER logged (the canonical JSON contains anchor data).
 */

import type { SignerFn } from './signed-bundle.js';

/**
 * Minimal interface for the GCP KMS client. Mirrors the pattern in
 * `chain/gcp-kms-signing-provider.ts` so tests can inject a mock without
 * pulling the real `@google-cloud/kms` SDK.
 */
export interface KmsClientLike {
  asymmetricSign(keyName: string, data: Buffer): Promise<Uint8Array>;
  getPublicKeyPem(keyName: string): Promise<string>;
}

export interface KmsSignerOptions {
  /** GCP KMS key version resource name. */
  kmsKeyName: string;
  /** Public-facing identifier embedded in the bundle (e.g. `arkova-proof-2026-04`). */
  signingKeyId: string;
  /** Optional KMS client override (for tests). */
  client?: KmsClientLike;
}

/** Build an Ed25519 SignerFn that delegates `sign` to GCP KMS. */
export function kmsEd25519Signer(opts: KmsSignerOptions): SignerFn {
  const { kmsKeyName, signingKeyId } = opts;
  if (!kmsKeyName) throw new Error('kmsEd25519Signer: kmsKeyName is required');
  if (!signingKeyId) throw new Error('kmsEd25519Signer: signingKeyId is required');

  let resolvedClient: KmsClientLike | null = opts.client ?? null;
  let logged = false;

  return async (canonical: string) => {
    if (!resolvedClient) {
      resolvedClient = await createRealKmsClient();
    }
    if (!logged) {
      // One-shot info log per signer instance — KMS key NAME is fine to
      // log (per §1.4 only key MATERIAL is forbidden). Using console
      // directly avoids pulling the pino/config chain during unit tests.
      console.info(
        '[proof-signer] kmsEd25519Signer initialized',
        JSON.stringify({ provider: 'gcp-kms', signingKeyId, kmsKeyName }),
      );
      logged = true;
    }
    const signatureBytes = await resolvedClient.asymmetricSign(
      kmsKeyName,
      Buffer.from(canonical, 'utf8'),
    );
    return {
      signatureBase64Url: Buffer.from(signatureBytes).toString('base64url'),
      signingKeyId,
    };
  };
}

/**
 * Fetch the Ed25519 public key (PEM) for a deployed KMS key. Used by
 * `scripts/proof/publish-public-key.ts` to populate the `keys.json`
 * registry without ever exporting the private key.
 */
export async function fetchKmsPublicKeyPem(
  kmsKeyName: string,
  client?: KmsClientLike,
): Promise<string> {
  const c = client ?? (await createRealKmsClient());
  const pem = await c.getPublicKeyPem(kmsKeyName);
  if (!pem.includes('BEGIN PUBLIC KEY')) {
    throw new Error('kms returned malformed public key PEM');
  }
  return pem;
}

/* v8 ignore start — GCP SDK integration boundary; tested via KmsClientLike mock */
async function createRealKmsClient(): Promise<KmsClientLike> {
  const { KeyManagementServiceClient } = await import('@google-cloud/kms');
  const client = new KeyManagementServiceClient();
  return {
    async asymmetricSign(keyName: string, data: Buffer): Promise<Uint8Array> {
      // Ed25519 signs the raw message bytes (no pre-hashing) — pass `data`
      // as the request `data` field, NOT `digest`.
      const [response] = await client.asymmetricSign({
        name: keyName,
        data,
      });
      if (!response.signature) {
        throw new Error('GCP KMS AsymmetricSign returned empty signature');
      }
      return response.signature as Uint8Array;
    },
    async getPublicKeyPem(keyName: string): Promise<string> {
      const [response] = await client.getPublicKey({ name: keyName });
      if (!response.pem) {
        throw new Error('GCP KMS GetPublicKey returned empty PEM');
      }
      return response.pem;
    },
  };
}
/* v8 ignore stop */
