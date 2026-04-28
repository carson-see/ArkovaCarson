/**
 * SCRUM-900 PROOF-SIG-01 — GCP Cloud KMS Ed25519 SignerFn adapter.
 *
 * Builds a `SignerFn` (the contract from `signed-bundle.ts`) backed by
 * GCP KMS `asymmetricSign` against an Ed25519 key version
 * (`EC_SIGN_ED25519`). Production deploys provision the KMS key version
 * via Terraform; the worker only ever holds the `keyResourceName` and
 * never sees the private-key bytes (per `feedback_no_aws.md` we are GCP
 * KMS only).
 *
 * The signer caches the key resource name as the `signing_key_id` on
 * the bundle. Court clerks / regulators verify offline with the public
 * key registry served at `/.well-known/arkova-keys.json`, which lists
 * every active + retired key id alongside its PEM, so historical
 * bundles remain verifiable across rotations.
 */

import type { SignerFn } from './signed-bundle.js';

/** Minimal interface for GCP KMS — abstracts @google-cloud/kms for tests. */
export interface KmsEd25519ClientLike {
  /**
   * Sign `data` directly (no pre-hash). Ed25519 in GCP KMS expects the
   * message body, not a digest, per
   * https://cloud.google.com/kms/docs/algorithms#ed25519
   * Returns the raw 64-byte Ed25519 signature.
   */
  asymmetricSignEd25519(keyName: string, data: Buffer): Promise<Uint8Array>;
}

export interface KmsEd25519SignerConfig {
  /** Full GCP KMS key version resource (used as the `signing_key_id` on the bundle). */
  keyResourceName: string;
  /**
   * Short id surfaced to verifiers (e.g. `arkova-proof-2026-q2`). Falls
   * back to the resource-name tail if omitted. Surfaced in the public
   * key registry so callers can match on a stable handle even if the
   * underlying KMS resource path is rotated.
   */
  shortKeyId?: string;
}

/**
 * Build a `SignerFn` backed by GCP KMS Ed25519.
 *
 * Tests inject `client`. Production calls `createRealGcpKmsEd25519Client()`
 * which lazy-loads `@google-cloud/kms`.
 */
export function gcpKmsEd25519Signer(
  config: KmsEd25519SignerConfig,
  client: KmsEd25519ClientLike,
): SignerFn {
  const signingKeyId =
    config.shortKeyId ??
    config.keyResourceName.split('/').slice(-1)[0] ??
    'kms';

  return async (canonical: string) => {
    const data = Buffer.from(canonical, 'utf8');
    const signature = await client.asymmetricSignEd25519(config.keyResourceName, data);
    if (!signature || signature.length === 0) {
      throw new Error('GCP KMS asymmetricSign returned empty signature');
    }
    return {
      signatureBase64Url: Buffer.from(signature).toString('base64url'),
      signingKeyId,
    };
  };
}

/* v8 ignore start — GCP SDK integration boundary; tested via KmsEd25519ClientLike mock. */
export async function createRealGcpKmsEd25519Client(): Promise<KmsEd25519ClientLike> {
  const { KeyManagementServiceClient } = await import('@google-cloud/kms');
  const client = new KeyManagementServiceClient();
  return {
    async asymmetricSignEd25519(keyName: string, data: Buffer): Promise<Uint8Array> {
      // Real KMS accepts `data: Buffer` for Ed25519 (no pre-hash) per
      // https://cloud.google.com/kms/docs/algorithms#ed25519. The
      // local @google-cloud/kms type stub at types/google-cloud-kms.d.ts
      // only declares the SHA-digest variant; cast through the runtime
      // call shape, which the real SDK accepts.
      const [response] = await (
        client.asymmetricSign as unknown as (
          req: { name: string; data: Buffer },
        ) => Promise<[{ signature?: Uint8Array }]>
      )({ name: keyName, data });
      if (!response.signature) {
        throw new Error('GCP KMS asymmetricSign returned empty signature');
      }
      return response.signature as Uint8Array;
    },
  };
}
/* v8 ignore stop */
