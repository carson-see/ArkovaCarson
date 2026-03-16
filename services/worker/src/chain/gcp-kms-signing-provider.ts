/**
 * GCP Cloud KMS Signing Provider (MVP-29)
 *
 * SigningProvider implementation using Google Cloud KMS for Bitcoin
 * transaction signing. Uses secp256k1 keys (EC_SIGN_SECP256K1_SHA256).
 *
 * Constitution 1.4: Key IDs never logged.
 * Constitution 1.1: GCP KMS as alternative to AWS KMS for mainnet.
 */

import type { SigningProvider } from './signing-provider.js';
import { derToCompact, compressPublicKey } from './signing-provider.js';
import { logger } from '../utils/logger.js';

export interface GcpKmsConfig {
  /** GCP KMS key resource name (projects/{p}/locations/{l}/keyRings/{kr}/cryptoKeys/{ck}/cryptoKeyVersions/{v}) */
  keyResourceName: string;
  /** GCP project ID */
  projectId?: string;
}

/**
 * Minimal interface for GCP KMS client — abstracts @google-cloud/kms
 * so tests can inject a mock without the real SDK.
 */
export interface GcpKmsClientLike {
  getPublicKey(keyName: string): Promise<Uint8Array>;
  asymmetricSign(keyName: string, digest: Buffer): Promise<Uint8Array>;
}

/**
 * Signing provider backed by GCP Cloud KMS (EC_SIGN_SECP256K1_SHA256).
 *
 * Uses async factory (create()) because the public key must be
 * fetched from KMS at init. Constructor is private.
 */
export class GcpKmsSigningProvider implements SigningProvider {
  readonly name = 'GCP KMS';
  private readonly publicKey: Buffer;
  private readonly keyResourceName: string;
  private readonly client: GcpKmsClientLike;

  private constructor(publicKey: Buffer, keyResourceName: string, client: GcpKmsClientLike) {
    this.publicKey = publicKey;
    this.keyResourceName = keyResourceName;
    this.client = client;
  }

  /**
   * Create a GCP KMS signing provider. Fetches and caches the public key.
   *
   * @param config - GCP KMS key resource name and optional project ID
   * @param client - Optional GCP KMS client (for testing)
   */
  static async create(config: GcpKmsConfig, client?: GcpKmsClientLike): Promise<GcpKmsSigningProvider> {
    const kmsClient = client ?? (await createRealGcpKmsClient());

    const pubKeyBytes = await kmsClient.getPublicKey(config.keyResourceName);
    if (!pubKeyBytes || pubKeyBytes.length === 0) {
      throw new Error('GCP KMS returned empty public key');
    }

    const uncompressedKey = Buffer.from(pubKeyBytes);
    const compressed = compressPublicKey(uncompressedKey);

    logger.info(
      { provider: 'gcp-kms', project: config.projectId ?? 'default' },
      'GCP KMS signing provider initialized',
    );

    return new GcpKmsSigningProvider(compressed, config.keyResourceName, kmsClient);
  }

  async sign(hash: Buffer): Promise<Buffer> {
    const derSignature = await this.client.asymmetricSign(this.keyResourceName, hash);
    return derToCompact(Buffer.from(derSignature));
  }

  getPublicKey(): Buffer {
    return this.publicKey;
  }
}

/* v8 ignore start — GCP SDK integration boundary; tested via GcpKmsClientLike mock */
async function createRealGcpKmsClient(): Promise<GcpKmsClientLike> {
  const { KeyManagementServiceClient } = await import('@google-cloud/kms');
  const client = new KeyManagementServiceClient();

  return {
    async getPublicKey(keyName: string): Promise<Uint8Array> {
      const [response] = await client.getPublicKey({ name: keyName });
      if (!response.pem) {
        throw new Error('GCP KMS GetPublicKey returned empty PEM');
      }
      // Parse PEM to extract raw key bytes
      const pemBody = response.pem
        .replace(/-----BEGIN PUBLIC KEY-----/, '')
        .replace(/-----END PUBLIC KEY-----/, '')
        .replace(/\n/g, '');
      const derBuffer = Buffer.from(pemBody, 'base64');
      // Extract uncompressed point (65 bytes) from SubjectPublicKeyInfo
      const uncompressedPoint = derBuffer.subarray(derBuffer.length - 65);
      return uncompressedPoint;
    },

    async asymmetricSign(keyName: string, digest: Buffer): Promise<Uint8Array> {
      const [response] = await client.asymmetricSign({
        name: keyName,
        digest: { sha256: digest },
      });
      if (!response.signature) {
        throw new Error('GCP KMS AsymmetricSign returned empty signature');
      }
      return response.signature as Uint8Array;
    },
  };
}
/* v8 ignore stop */
