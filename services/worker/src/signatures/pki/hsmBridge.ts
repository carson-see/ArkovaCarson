/**
 * HSM Bridge — Abstract signing interface over AWS KMS and GCP Cloud HSM.
 *
 * Private key material NEVER enters worker memory (Constitution 1.4).
 * Extends existing KMS infrastructure from services/worker/src/chain/
 * with support for RSA and ECDSA P-256/P-384 (AdES uses different curves
 * than Bitcoin's secp256k1).
 *
 * Story: PH3-ESIG-01 (SCRUM-422)
 */

import { logger } from '../../utils/logger.js';
import type {
  KmsProvider,
  HsmSignRequest,
  HsmSignResponse,
} from '../types.js';
import { KEY_ALGORITHM_TO_KMS, BANNED_ALGORITHMS, MIN_RSA_KEY_SIZE } from '../constants.js';

// ─── Interface ─────────────────────────────────────────────────────────

export interface HsmBridge {
  sign(request: HsmSignRequest): Promise<HsmSignResponse>;
  getPublicKey(provider: KmsProvider, keyId: string): Promise<Buffer>;
  readonly name: string;
}

// ─── AWS KMS Implementation ────────────────────────────────────────────

export class AwsKmsHsmBridge implements HsmBridge {
  readonly name = 'AWS KMS';
  private client: unknown | null = null;

  private async getClient(): Promise<unknown> {
    if (this.client) return this.client;
    // Lazy-load AWS SDK (same pattern as chain/signing-provider.ts)
    const { KMSClient } = await import('@aws-sdk/client-kms');
    this.client = new KMSClient({
      region: process.env.ADES_KMS_REGION || process.env.BITCOIN_KMS_REGION || 'us-east-1',
    });
    return this.client;
  }

  async sign(request: HsmSignRequest): Promise<HsmSignResponse> {
    validateSignRequest(request);
    const client = await this.getClient() as any;
    const { SignCommand } = await import('@aws-sdk/client-kms');

    const kmsAlgorithm = KEY_ALGORITHM_TO_KMS[request.algorithm]?.aws;
    if (!kmsAlgorithm) {
      throw new Error(`Unsupported algorithm for AWS KMS: ${request.algorithm}`);
    }

    const command = new SignCommand({
      KeyId: request.keyId,
      Message: request.data,
      MessageType: 'DIGEST',
      SigningAlgorithm: kmsAlgorithm,
    });

    const response = await client.send(command);
    if (!response.Signature) {
      throw new Error('AWS KMS returned empty signature');
    }

    logger.info({
      provider: 'aws_kms',
      algorithm: request.algorithm,
      keyId: request.keyId.substring(0, 12) + '...',
    }, 'HSM sign completed');

    return {
      signature: Buffer.from(response.Signature),
      algorithm: kmsAlgorithm,
    };
  }

  async getPublicKey(provider: KmsProvider, keyId: string): Promise<Buffer> {
    const client = await this.getClient() as any;
    const { GetPublicKeyCommand } = await import('@aws-sdk/client-kms');

    const command = new GetPublicKeyCommand({ KeyId: keyId });
    const response = await client.send(command);
    if (!response.PublicKey) {
      throw new Error('AWS KMS returned empty public key');
    }

    return Buffer.from(response.PublicKey);
  }
}

// ─── GCP Cloud HSM Implementation ──────────────────────────────────────

export class GcpKmsHsmBridge implements HsmBridge {
  readonly name = 'GCP Cloud HSM';
  private client: unknown | null = null;

  private async getClient(): Promise<unknown> {
    if (this.client) return this.client;
    const { KeyManagementServiceClient } = await import('@google-cloud/kms');
    this.client = new KeyManagementServiceClient();
    return this.client;
  }

  async sign(request: HsmSignRequest): Promise<HsmSignResponse> {
    validateSignRequest(request);
    const client = await this.getClient() as any;

    const [response] = await client.asymmetricSign({
      name: request.keyId,
      digest: {
        sha256: request.data,
      },
    });

    if (!response.signature) {
      throw new Error('GCP KMS returned empty signature');
    }

    logger.info({
      provider: 'gcp_kms',
      algorithm: request.algorithm,
      keyId: request.keyId.substring(0, 20) + '...',
    }, 'HSM sign completed');

    return {
      signature: Buffer.from(response.signature),
      algorithm: request.algorithm,
    };
  }

  async getPublicKey(_provider: KmsProvider, keyId: string): Promise<Buffer> {
    const client = await this.getClient() as any;
    const [response] = await client.getPublicKey({ name: keyId });
    if (!response.pem) {
      throw new Error('GCP KMS returned empty public key');
    }
    return Buffer.from(response.pem);
  }
}

// ─── Mock HSM (testing) ────────────────────────────────────────────────

export class MockHsmBridge implements HsmBridge {
  readonly name = 'Mock HSM';
  public signCalls: HsmSignRequest[] = [];

  async sign(request: HsmSignRequest): Promise<HsmSignResponse> {
    validateSignRequest(request);
    this.signCalls.push(request);
    // Return deterministic mock signature
    const mockSig = Buffer.alloc(64, 0xAB);
    return { signature: mockSig, algorithm: request.algorithm };
  }

  async getPublicKey(_provider: KmsProvider, _keyId: string): Promise<Buffer> {
    return Buffer.alloc(65, 0xCD);
  }
}

// ─── Factory ───────────────────────────────────────────────────────────

export function createHsmBridge(provider: KmsProvider): HsmBridge {
  switch (provider) {
    case 'aws_kms':
      return new AwsKmsHsmBridge();
    case 'gcp_kms':
      return new GcpKmsHsmBridge();
    default:
      throw new Error(`Unknown KMS provider: ${provider}`);
  }
}

/** Create a mock HSM bridge for tests. */
export function createMockHsmBridge(): MockHsmBridge {
  return new MockHsmBridge();
}

// ─── Validation ────────────────────────────────────────────────────────

function validateSignRequest(request: HsmSignRequest): void {
  // Enforce ETSI TS 119 312 — no banned algorithms
  if (BANNED_ALGORITHMS.has(request.algorithm)) {
    throw new Error(`Algorithm '${request.algorithm}' is banned per ETSI TS 119 312`);
  }

  // Enforce minimum RSA key size
  if (request.algorithm.startsWith('RSA-')) {
    const keySize = parseInt(request.algorithm.split('-')[1], 10);
    if (keySize < MIN_RSA_KEY_SIZE) {
      throw new Error(`RSA key size ${keySize} is below minimum ${MIN_RSA_KEY_SIZE} bits`);
    }
  }

  // Data must be a hash (32 bytes for SHA-256, 48 for SHA-384, 64 for SHA-512)
  const validHashSizes = [32, 48, 64];
  if (!validHashSizes.includes(request.data.length)) {
    throw new Error(`Sign data must be a hash digest (${request.data.length} bytes received, expected 32/48/64)`);
  }
}
