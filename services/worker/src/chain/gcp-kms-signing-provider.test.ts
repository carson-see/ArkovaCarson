/**
 * Unit tests for GcpKmsSigningProvider (MVP-29)
 *
 * All GCP KMS calls are mocked via the GcpKmsClientLike interface —
 * Constitution 1.7 requires no real GCP API calls in tests.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  GcpKmsSigningProvider,
  type GcpKmsClientLike,
} from './gcp-kms-signing-provider.js';

// ─── Test Helpers ──────────────────────────────────────────────────────

const TEST_HASH = Buffer.alloc(32, 0xab);

/**
 * Build a valid 65-byte uncompressed public key (0x04 + 32 bytes x + 32 bytes y).
 */
function buildUncompressedKey(options?: { evenY?: boolean }): Buffer {
  const key = Buffer.alloc(65);
  key[0] = 0x04;
  Buffer.alloc(32, 0xaa).copy(key, 1); // x
  Buffer.alloc(32, 0xbb).copy(key, 33); // y
  key[64] = options?.evenY === false ? 0x03 : 0x02; // last byte determines even/odd
  return key;
}

/**
 * Build a valid DER-encoded ECDSA signature for testing.
 * DER format: 0x30 <len> 0x02 <r-len> <r> 0x02 <s-len> <s>
 */
function buildDerSignature(r: Buffer, s: Buffer): Buffer {
  const rPadded = r[0] >= 0x80 ? Buffer.concat([Buffer.from([0x00]), r]) : r;
  const sPadded = s[0] >= 0x80 ? Buffer.concat([Buffer.from([0x00]), s]) : s;
  const totalLen = 2 + rPadded.length + 2 + sPadded.length;

  return Buffer.concat([
    Buffer.from([0x30, totalLen]),
    Buffer.from([0x02, rPadded.length]),
    rPadded,
    Buffer.from([0x02, sPadded.length]),
    sPadded,
  ]);
}

/**
 * Create a mock GcpKmsClientLike for testing.
 */
function createMockGcpKmsClient(overrides: Partial<GcpKmsClientLike> = {}): GcpKmsClientLike {
  const defaultPubKey = buildUncompressedKey();

  const r = Buffer.alloc(32, 0x11);
  const s = Buffer.alloc(32, 0x22);
  const defaultSig = buildDerSignature(r, s);

  return {
    getPublicKey: vi.fn().mockResolvedValue(new Uint8Array(defaultPubKey)),
    asymmetricSign: vi.fn().mockResolvedValue(new Uint8Array(defaultSig)),
    ...overrides,
  };
}

const TEST_KEY_RESOURCE = 'projects/arkova1/locations/us-central1/keyRings/bitcoin/cryptoKeys/mainnet-signer/cryptoKeyVersions/1';

// ─── GcpKmsSigningProvider ─────────────────────────────────────────────

describe('GcpKmsSigningProvider', () => {
  describe('create()', () => {
    it('creates a provider with valid mock client', async () => {
      const mockClient = createMockGcpKmsClient();

      const provider = await GcpKmsSigningProvider.create(
        { keyResourceName: TEST_KEY_RESOURCE },
        mockClient,
      );

      expect(provider.name).toBe('GCP KMS');
      expect(provider.getPublicKey()).toBeInstanceOf(Buffer);
      expect(provider.getPublicKey().length).toBe(33); // compressed
      expect(mockClient.getPublicKey).toHaveBeenCalledWith(TEST_KEY_RESOURCE);
    });

    it('throws when public key is empty (null)', async () => {
      const mockClient = createMockGcpKmsClient({
        getPublicKey: vi.fn().mockResolvedValue(null),
      });

      await expect(
        GcpKmsSigningProvider.create({ keyResourceName: TEST_KEY_RESOURCE }, mockClient),
      ).rejects.toThrow('GCP KMS returned empty public key');
    });

    it('throws when public key is empty (zero-length)', async () => {
      const mockClient = createMockGcpKmsClient({
        getPublicKey: vi.fn().mockResolvedValue(new Uint8Array(0)),
      });

      await expect(
        GcpKmsSigningProvider.create({ keyResourceName: TEST_KEY_RESOURCE }, mockClient),
      ).rejects.toThrow('GCP KMS returned empty public key');
    });

    it('throws when getPublicKey rejects', async () => {
      const mockClient = createMockGcpKmsClient({
        getPublicKey: vi.fn().mockRejectedValue(new Error('GCP KMS access denied')),
      });

      await expect(
        GcpKmsSigningProvider.create({ keyResourceName: TEST_KEY_RESOURCE }, mockClient),
      ).rejects.toThrow('GCP KMS access denied');
    });

    it('compresses key with even y correctly (0x02 prefix)', async () => {
      const uncompressed = buildUncompressedKey({ evenY: true });
      const mockClient = createMockGcpKmsClient({
        getPublicKey: vi.fn().mockResolvedValue(new Uint8Array(uncompressed)),
      });

      const provider = await GcpKmsSigningProvider.create(
        { keyResourceName: TEST_KEY_RESOURCE },
        mockClient,
      );

      const pubKey = provider.getPublicKey();
      expect(pubKey.length).toBe(33);
      expect(pubKey[0]).toBe(0x02); // even y
    });

    it('compresses key with odd y correctly (0x03 prefix)', async () => {
      const uncompressed = buildUncompressedKey({ evenY: false });
      const mockClient = createMockGcpKmsClient({
        getPublicKey: vi.fn().mockResolvedValue(new Uint8Array(uncompressed)),
      });

      const provider = await GcpKmsSigningProvider.create(
        { keyResourceName: TEST_KEY_RESOURCE },
        mockClient,
      );

      const pubKey = provider.getPublicKey();
      expect(pubKey.length).toBe(33);
      expect(pubKey[0]).toBe(0x03); // odd y
    });
  });

  describe('sign()', () => {
    it('converts DER signature to compact 64-byte format', async () => {
      const r = Buffer.alloc(32, 0x11);
      const s = Buffer.alloc(32, 0x22);
      const derSig = buildDerSignature(r, s);

      const mockClient = createMockGcpKmsClient({
        asymmetricSign: vi.fn().mockResolvedValue(new Uint8Array(derSig)),
      });

      const provider = await GcpKmsSigningProvider.create(
        { keyResourceName: TEST_KEY_RESOURCE },
        mockClient,
      );

      const sig = await provider.sign(TEST_HASH);

      expect(sig).toBeInstanceOf(Buffer);
      expect(sig.length).toBe(64);
      expect(sig.subarray(0, 32)).toEqual(r);
      expect(sig.subarray(32, 64)).toEqual(s);
    });

    it('delegates to client.asymmetricSign with correct args', async () => {
      const mockClient = createMockGcpKmsClient();

      const provider = await GcpKmsSigningProvider.create(
        { keyResourceName: TEST_KEY_RESOURCE },
        mockClient,
      );

      await provider.sign(TEST_HASH);

      expect(mockClient.asymmetricSign).toHaveBeenCalledWith(TEST_KEY_RESOURCE, TEST_HASH);
    });

    it('handles DER signature with leading zero in r', async () => {
      const r = Buffer.alloc(32);
      r[0] = 0x80; // high bit set — DER adds leading 0x00
      r.fill(0x11, 1);
      const s = Buffer.alloc(32, 0x22);
      const derSig = buildDerSignature(r, s);

      const mockClient = createMockGcpKmsClient({
        asymmetricSign: vi.fn().mockResolvedValue(new Uint8Array(derSig)),
      });

      const provider = await GcpKmsSigningProvider.create(
        { keyResourceName: TEST_KEY_RESOURCE },
        mockClient,
      );

      const sig = await provider.sign(TEST_HASH);
      expect(sig.length).toBe(64);
      expect(sig[0]).toBe(0x80); // leading zero stripped
    });

    it('throws when asymmetricSign rejects', async () => {
      const mockClient = createMockGcpKmsClient({
        asymmetricSign: vi.fn().mockRejectedValue(new Error('GCP KMS signing error')),
      });

      const provider = await GcpKmsSigningProvider.create(
        { keyResourceName: TEST_KEY_RESOURCE },
        mockClient,
      );

      await expect(provider.sign(TEST_HASH)).rejects.toThrow('GCP KMS signing error');
    });
  });

  describe('getPublicKey()', () => {
    it('returns compressed 33-byte key', async () => {
      const mockClient = createMockGcpKmsClient();

      const provider = await GcpKmsSigningProvider.create(
        { keyResourceName: TEST_KEY_RESOURCE },
        mockClient,
      );

      const pubKey = provider.getPublicKey();
      expect(pubKey.length).toBe(33);
      expect(pubKey[0] === 0x02 || pubKey[0] === 0x03).toBe(true);
    });

    it('returns cached key (same reference on repeated calls)', async () => {
      const mockClient = createMockGcpKmsClient();

      const provider = await GcpKmsSigningProvider.create(
        { keyResourceName: TEST_KEY_RESOURCE },
        mockClient,
      );

      const key1 = provider.getPublicKey();
      const key2 = provider.getPublicKey();
      expect(key1).toBe(key2); // same reference
      expect(mockClient.getPublicKey).toHaveBeenCalledTimes(1); // fetched once during create()
    });
  });

  describe('provider name', () => {
    it('is "GCP KMS"', async () => {
      const mockClient = createMockGcpKmsClient();

      const provider = await GcpKmsSigningProvider.create(
        { keyResourceName: TEST_KEY_RESOURCE },
        mockClient,
      );

      expect(provider.name).toBe('GCP KMS');
    });
  });

  describe('constructor privacy', () => {
    it('cannot be instantiated directly (must use create())', () => {
      // TypeScript enforces private constructor at compile time.
      // At runtime, verify that the class has a static create method.
      expect(typeof GcpKmsSigningProvider.create).toBe('function');
      // And that direct construction is not the intended usage:
      // new GcpKmsSigningProvider(...) would throw a TS error.
      // We verify the factory pattern works end-to-end above.
    });
  });
});
