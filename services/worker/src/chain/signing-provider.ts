/**
 * Signing Provider Interface + Implementations
 *
 * Abstracts cryptographic signing so that BitcoinChainClient can work with:
 *   - A WIF private key (Signet/testnet — ECPair)
 *   - GCP Cloud KMS (mainnet — production; see `gcp-kms-signing-provider.ts`)
 *   - AWS KMS (code-level abstraction ONLY — not deployed in production)
 *
 * **Production note (SCRUM-902 AWS-RM-01):** Arkova has no AWS account; the
 * `KmsSigningProvider` AWS path here exists for provider-plurality optionality
 * only. `KMS_PROVIDER=gcp` is the only production value. Do not promise AWS
 * KMS signing to customers — see `docs/confluence/14_kms_operations.md` and
 * `memory/feedback_no_aws.md`.
 *
 * sign() is async to accommodate KMS network calls. WIF resolves immediately.
 *
 * Constitution refs:
 *   - 1.4: Treasury/signing keys never logged or exposed
 *   - 1.1: bitcoinjs-lib + GCP Cloud KMS (production)
 *
 * Story: CRIT-2 (Bitcoin chain client completion); SCRUM-902 (AWS removal from customer claims)
 */

import * as ecc from 'tiny-secp256k1';
import { ECPairFactory } from 'ecpair';
import * as bitcoin from 'bitcoinjs-lib';
import { logger } from '../utils/logger.js';

const ECPair = ECPairFactory(ecc);

// ─── Interface ──────────────────────────────────────────────────────────

export interface SigningProvider {
  /**
   * Sign a 32-byte hash and return a 64-byte compact signature (r || s).
   * Async to support KMS — WIF implementation resolves immediately.
   */
  sign(hash: Buffer): Promise<Buffer>;

  /** Return the 33-byte compressed public key. */
  getPublicKey(): Buffer;

  /** Provider display name for logging. */
  readonly name: string;
}

// ─── WIF Signing Provider ───────────────────────────────────────────────

/**
 * Signing provider backed by a WIF (Wallet Import Format) private key.
 *
 * Wraps the ECPair from `ecpair` / `tiny-secp256k1`. Suitable for
 * Signet and testnet where keys are loaded from environment variables.
 *
 * The WIF is never logged or exposed (Constitution 1.4).
 */
export class WifSigningProvider implements SigningProvider {
  readonly name = 'WIF (ECPair)';
  private readonly keyPair: ReturnType<typeof ECPair.fromWIF>;

  /**
   * @param wif - Wallet Import Format private key
   * @param network - Bitcoin network (defaults to testnet/signet)
   * @throws if the WIF is invalid for the given network
   */
  constructor(wif: string, network: bitcoin.Network = bitcoin.networks.testnet) {
    try {
      this.keyPair = ECPair.fromWIF(wif, network);
    } catch {
      throw new Error(
        'Invalid WIF — cannot parse as WIF for the specified network',
      );
    }
  }

  async sign(hash: Buffer): Promise<Buffer> {
    return Buffer.from(this.keyPair.sign(hash));
  }

  getPublicKey(): Buffer {
    return Buffer.from(this.keyPair.publicKey);
  }
}

// ─── KMS Signing Provider ───────────────────────────────────────────────

export interface KmsSigningProviderConfig {
  /** AWS KMS key ID or ARN — NEVER logged (Constitution 1.4) */
  keyId: string;
  /** AWS region (e.g., 'us-east-1') */
  region?: string;
}

/**
 * Convert a DER-encoded ECDSA signature to 64-byte compact format (r || s).
 *
 * KMS returns signatures in DER encoding:
 *   0x30 <total-len> 0x02 <r-len> <r> 0x02 <s-len> <s>
 *
 * bitcoinjs-lib expects 64-byte compact: 32-byte r + 32-byte s (big-endian,
 * zero-padded on the left).
 */
export function derToCompact(derSig: Buffer): Buffer {
  // Validate outer SEQUENCE tag
  if (derSig[0] !== 0x30) {
    throw new Error('Invalid DER signature: missing SEQUENCE tag');
  }

  let offset = 2; // skip 0x30 + length byte

  // Parse r
  if (derSig[offset] !== 0x02) {
    throw new Error('Invalid DER signature: missing INTEGER tag for r');
  }
  offset++;
  const rLen = derSig[offset];
  offset++;
  let r = derSig.subarray(offset, offset + rLen);
  offset += rLen;

  // Parse s
  if (derSig[offset] !== 0x02) {
    throw new Error('Invalid DER signature: missing INTEGER tag for s');
  }
  offset++;
  const sLen = derSig[offset];
  offset++;
  let s = derSig.subarray(offset, offset + sLen);

  // Strip leading zero bytes (DER uses signed integers)
  if (r.length > 32 && r[0] === 0x00) {
    r = r.subarray(1);
  }
  if (s.length > 32 && s[0] === 0x00) {
    s = s.subarray(1);
  }

  // Pad to 32 bytes each
  const compact = Buffer.alloc(64);
  r.copy(compact, 32 - r.length);
  s.copy(compact, 64 - s.length);

  return compact;
}

/**
 * Signing provider backed by AWS KMS (ECDSA_SHA_256 on secp256k1).
 *
 * Uses an async factory (`create()`) because the public key must be
 * fetched from KMS at initialization time. The constructor is private
 * to enforce this pattern.
 *
 * The KMS key ID is never logged (Constitution 1.4).
 */
export class KmsSigningProvider implements SigningProvider {
  readonly name = 'AWS KMS';
  private readonly publicKey: Buffer;
  private readonly kmsKeyId: string;
  private readonly kmsClient: KmsClientLike;

  /** Use KmsSigningProvider.create() — constructor is private. */
  private constructor(
    publicKey: Buffer,
    kmsKeyId: string,
    kmsClient: KmsClientLike,
  ) {
    this.publicKey = publicKey;
    this.kmsKeyId = kmsKeyId;
    this.kmsClient = kmsClient;
  }

  /**
   * Create a KMS signing provider. Fetches and caches the public key.
   *
   * @param config - KMS key ID and optional region
   * @param kmsClient - Optional KMS client (for testing)
   */
  static async create(
    config: KmsSigningProviderConfig,
    kmsClient?: KmsClientLike,
  ): Promise<KmsSigningProvider> {
    const client = kmsClient ?? (await createRealKmsClient(config.region));

    // Fetch the public key from KMS
    const pubKeyResponse = await client.getPublicKey(config.keyId);

    if (!pubKeyResponse) {
      throw new Error('KMS returned empty public key');
    }

    // KMS returns an uncompressed SEC1 public key (65 bytes: 0x04 + x + y).
    // We need the 33-byte compressed form for bitcoinjs-lib.
    const uncompressedKey = Buffer.from(pubKeyResponse);
    const compressed = compressPublicKey(uncompressedKey);

    logger.info(
      { provider: 'kms', region: config.region ?? 'us-east-1' },
      'KMS signing provider initialized',
    );

    return new KmsSigningProvider(compressed, config.keyId, client);
  }

  async sign(hash: Buffer): Promise<Buffer> {
    const derSignature = await this.kmsClient.sign(this.kmsKeyId, hash);
    return derToCompact(Buffer.from(derSignature));
  }

  getPublicKey(): Buffer {
    return this.publicKey;
  }
}

// ─── KMS Client Abstraction (for testability) ──────────────────────────

/**
 * Minimal KMS client interface — abstracts @aws-sdk/client-kms
 * so tests can inject a mock without importing the real SDK.
 */
export interface KmsClientLike {
  /** Get the raw public key bytes for a KMS key */
  getPublicKey(keyId: string): Promise<Uint8Array>;
  /** Sign a hash and return the DER-encoded signature */
  sign(keyId: string, hash: Buffer): Promise<Uint8Array>;
}

/**
 * Create a real AWS KMS client. Lazily imports @aws-sdk/client-kms
 * so the dependency is optional (only needed for mainnet).
 */
/* v8 ignore start — AWS SDK integration boundary; tested via KmsClientLike mock (Constitution 1.7) */
async function createRealKmsClient(region?: string): Promise<KmsClientLike> {
  // Dynamic import — @aws-sdk/client-kms is only required for mainnet
  const { KMSClient, GetPublicKeyCommand, SignCommand } = await import(
    '@aws-sdk/client-kms'
  );

  const client = new KMSClient({ region: region ?? 'us-east-1' });

  return {
    async getPublicKey(keyId: string): Promise<Uint8Array> {
      const response = await client.send(
        new GetPublicKeyCommand({ KeyId: keyId }),
      );

      if (!response.PublicKey) {
        throw new Error('KMS GetPublicKey returned empty response');
      }

      // KMS returns the full SubjectPublicKeyInfo DER structure.
      // For secp256k1, the raw key starts at byte 23 (after the DER header).
      const spki = Buffer.from(response.PublicKey);
      // Extract the uncompressed point (65 bytes starting after the DER header)
      const uncompressedPoint = spki.subarray(spki.length - 65);
      return uncompressedPoint;
    },

    async sign(keyId: string, hash: Buffer): Promise<Uint8Array> {
      const response = await client.send(
        new SignCommand({
          KeyId: keyId,
          Message: hash,
          MessageType: 'DIGEST',
          SigningAlgorithm: 'ECDSA_SHA_256',
        }),
      );

      if (!response.Signature) {
        throw new Error('KMS Sign returned empty response');
      }

      return response.Signature;
    },
  };
}
/* v8 ignore stop */

// ─── Utilities ──────────────────────────────────────────────────────────

/**
 * Compress an uncompressed SEC1 public key (65 bytes: 0x04 + x + y)
 * to compressed form (33 bytes: 0x02/0x03 + x).
 */
export function compressPublicKey(uncompressed: Buffer): Buffer {
  if (uncompressed.length !== 65 || uncompressed[0] !== 0x04) {
    throw new Error(
      `Expected 65-byte uncompressed public key (0x04 prefix), got ${uncompressed.length} bytes`,
    );
  }

  const x = uncompressed.subarray(1, 33);
  const yLastByte = uncompressed[64];
  const prefix = yLastByte % 2 === 0 ? 0x02 : 0x03;

  return Buffer.concat([Buffer.from([prefix]), x]);
}

// ─── Factory ────────────────────────────────────────────────────────────

export type SigningProviderType = 'wif' | 'kms' | 'gcp-kms';

export interface SigningProviderFactoryConfig {
  type: SigningProviderType;
  /** WIF private key (required for 'wif' type) */
  wif?: string;
  /** Bitcoin network for WIF (defaults to testnet/signet) */
  network?: bitcoin.Network;
  /** KMS key ID (required for 'kms' type) */
  kmsKeyId?: string;
  /** AWS region for KMS (defaults to 'us-east-1') */
  kmsRegion?: string;
  /** Optional KMS client for testing */
  kmsClient?: KmsClientLike;
  /** GCP KMS key resource name (required for 'gcp-kms' type) */
  gcpKmsKeyResourceName?: string;
  /** GCP project ID (optional for 'gcp-kms' type) */
  gcpKmsProjectId?: string;
  /** Optional GCP KMS client for testing */
  gcpKmsClient?: import('./gcp-kms-signing-provider.js').GcpKmsClientLike;
}

/**
 * Create a signing provider based on configuration.
 *
 * - 'wif': Synchronous — wraps ECPair. For Signet/testnet.
 * - 'kms': Async — fetches public key from KMS. For mainnet.
 */
export async function createSigningProvider(
  factoryConfig: SigningProviderFactoryConfig,
): Promise<SigningProvider> {
  if (factoryConfig.type === 'wif') {
    if (!factoryConfig.wif) {
      throw new Error('WIF is required for WIF signing provider');
    }
    logger.info({ provider: 'wif' }, 'Creating WIF signing provider');
    return new WifSigningProvider(factoryConfig.wif, factoryConfig.network);
  }

  if (factoryConfig.type === 'kms') {
    if (!factoryConfig.kmsKeyId) {
      throw new Error('KMS key ID is required for KMS signing provider');
    }
    logger.info(
      { provider: 'kms', region: factoryConfig.kmsRegion ?? 'us-east-1' },
      'Creating KMS signing provider',
    );
    return KmsSigningProvider.create(
      { keyId: factoryConfig.kmsKeyId, region: factoryConfig.kmsRegion },
      factoryConfig.kmsClient,
    );
  }

  if (factoryConfig.type === 'gcp-kms') {
    if (!factoryConfig.gcpKmsKeyResourceName) {
      throw new Error('GCP KMS key resource name is required for GCP KMS signing provider');
    }
    logger.info(
      { provider: 'gcp-kms', project: factoryConfig.gcpKmsProjectId ?? 'default' },
      'Creating GCP KMS signing provider',
    );
    const { GcpKmsSigningProvider } = await import('./gcp-kms-signing-provider.js');
    return GcpKmsSigningProvider.create(
      {
        keyResourceName: factoryConfig.gcpKmsKeyResourceName,
        projectId: factoryConfig.gcpKmsProjectId,
      },
      factoryConfig.gcpKmsClient,
    );
  }

  throw new Error(`Unknown signing provider type: ${factoryConfig.type}`);
}
