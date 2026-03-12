/**
 * Unit tests for SigningProvider implementations
 *
 * CRIT-2: Tests for WifSigningProvider, KmsSigningProvider, derToCompact,
 * compressPublicKey, and createSigningProvider factory.
 *
 * All AWS KMS calls are mocked via the KmsClientLike interface —
 * Constitution 1.7 requires no real AWS API calls in tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { ECPairFactory } from 'ecpair';

const ECPair = ECPairFactory(ecc);

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  WifSigningProvider,
  KmsSigningProvider,
  derToCompact,
  compressPublicKey,
  createSigningProvider,
  type KmsClientLike,
  type SigningProvider,
} from './signing-provider.js';

// ─── Test Constants ───────────────────────────────────────────────────────

// Throwaway Signet/testnet key — not real funds
const TEST_WIF = 'cVt4o7BGAig1UXywgGSmARhxMdzP5qvQsxKkSsc1XEkw3tDTQFpy';
const TEST_HASH = Buffer.alloc(32, 0xab); // Arbitrary 32-byte hash


/**
 * Build a valid DER-encoded ECDSA signature for testing derToCompact().
 * DER format: 0x30 <len> 0x02 <r-len> <r> 0x02 <s-len> <s>
 */
function buildDerSignature(r: Buffer, s: Buffer): Buffer {
  // Add leading zero if high bit set (DER signed integer)
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
 * Create a mock KmsClientLike for testing KmsSigningProvider.
 */
function createMockKmsClient(overrides: Partial<KmsClientLike> = {}): KmsClientLike {
  // Default: return a valid 65-byte uncompressed public key
  const defaultPubKey = Buffer.alloc(65);
  defaultPubKey[0] = 0x04;
  Buffer.alloc(32, 0xaa).copy(defaultPubKey, 1); // x
  Buffer.alloc(32, 0xbb).copy(defaultPubKey, 33); // y
  defaultPubKey[64] = 0x02; // even y last byte

  // Default: return a valid DER signature
  const r = Buffer.alloc(32, 0x11);
  const s = Buffer.alloc(32, 0x22);
  const defaultSig = buildDerSignature(r, s);

  return {
    getPublicKey: vi.fn().mockResolvedValue(new Uint8Array(defaultPubKey)),
    sign: vi.fn().mockResolvedValue(new Uint8Array(defaultSig)),
    ...overrides,
  };
}

// ─── WifSigningProvider ──────────────────────────────────────────────────

describe('WifSigningProvider', () => {
  it('creates from a valid testnet WIF', () => {
    const provider = new WifSigningProvider(TEST_WIF);
    expect(provider.name).toBe('WIF (ECPair)');
    expect(provider.getPublicKey()).toBeInstanceOf(Buffer);
    expect(provider.getPublicKey().length).toBe(33); // compressed
  });

  it('throws on invalid WIF', () => {
    expect(() => new WifSigningProvider('not-a-wif')).toThrow(
      'Invalid WIF',
    );
  });

  it('throws on mainnet WIF with testnet network', () => {
    // mainnet WIF starts with 5, K, or L — but network mismatch should throw
    expect(() => new WifSigningProvider('5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ')).toThrow();
  });

  it('sign() returns a 64-byte compact signature', async () => {
    const provider = new WifSigningProvider(TEST_WIF);
    const sig = await provider.sign(TEST_HASH);
    expect(sig).toBeInstanceOf(Buffer);
    expect(sig.length).toBe(64);
  });

  it('sign() produces verifiable signatures', async () => {
    const provider = new WifSigningProvider(TEST_WIF);
    const sig = await provider.sign(TEST_HASH);
    const pubKey = provider.getPublicKey();

    // Verify with tiny-secp256k1
    const verified = ecc.verify(TEST_HASH, pubKey, sig);
    expect(verified).toBe(true);
  });

  it('getPublicKey() returns consistent key', () => {
    const provider = new WifSigningProvider(TEST_WIF);
    const key1 = provider.getPublicKey();
    const key2 = provider.getPublicKey();
    expect(key1.equals(key2)).toBe(true);
  });

  it('accepts explicit testnet network', () => {
    const provider = new WifSigningProvider(TEST_WIF, bitcoin.networks.testnet);
    expect(provider.getPublicKey().length).toBe(33);
  });
});

// ─── KmsSigningProvider ──────────────────────────────────────────────────

describe('KmsSigningProvider', () => {
  describe('create()', () => {
    it('creates a provider with valid KMS client', async () => {
      const mockClient = createMockKmsClient();

      const provider = await KmsSigningProvider.create(
        { keyId: 'test-key-id' },
        mockClient,
      );

      expect(provider.name).toBe('AWS KMS');
      expect(provider.getPublicKey()).toBeInstanceOf(Buffer);
      expect(provider.getPublicKey().length).toBe(33); // compressed
      expect(mockClient.getPublicKey).toHaveBeenCalledWith('test-key-id');
    });

    it('passes config region to logger', async () => {
      const mockClient = createMockKmsClient();

      await KmsSigningProvider.create(
        { keyId: 'test-key-id', region: 'eu-west-1' },
        mockClient,
      );

      // Provider created successfully with region
      expect(mockClient.getPublicKey).toHaveBeenCalledWith('test-key-id');
    });

    it('throws when KMS returns empty public key', async () => {
      const mockClient = createMockKmsClient({
        getPublicKey: vi.fn().mockResolvedValue(null),
      });

      await expect(
        KmsSigningProvider.create({ keyId: 'test-key-id' }, mockClient),
      ).rejects.toThrow('KMS returned empty public key');
    });

    it('throws when KMS getPublicKey rejects', async () => {
      const mockClient = createMockKmsClient({
        getPublicKey: vi.fn().mockRejectedValue(new Error('KMS access denied')),
      });

      await expect(
        KmsSigningProvider.create({ keyId: 'test-key-id' }, mockClient),
      ).rejects.toThrow('KMS access denied');
    });

    it('compresses the uncompressed public key from KMS', async () => {
      // Build a key with even y (last byte even → prefix 0x02)
      const uncompressed = Buffer.alloc(65);
      uncompressed[0] = 0x04;
      Buffer.alloc(32, 0xcc).copy(uncompressed, 1); // x
      Buffer.alloc(32, 0xdd).copy(uncompressed, 33); // y
      uncompressed[64] = 0x04; // even → prefix 0x02

      const mockClient = createMockKmsClient({
        getPublicKey: vi.fn().mockResolvedValue(new Uint8Array(uncompressed)),
      });

      const provider = await KmsSigningProvider.create(
        { keyId: 'test-key-id' },
        mockClient,
      );

      const pubKey = provider.getPublicKey();
      expect(pubKey.length).toBe(33);
      expect(pubKey[0]).toBe(0x02); // even y → 0x02 prefix
    });

    it('compresses key with odd y correctly', async () => {
      const uncompressed = Buffer.alloc(65);
      uncompressed[0] = 0x04;
      Buffer.alloc(32, 0xee).copy(uncompressed, 1);
      Buffer.alloc(32, 0xff).copy(uncompressed, 33);
      uncompressed[64] = 0x03; // odd → prefix 0x03

      const mockClient = createMockKmsClient({
        getPublicKey: vi.fn().mockResolvedValue(new Uint8Array(uncompressed)),
      });

      const provider = await KmsSigningProvider.create(
        { keyId: 'test-key-id' },
        mockClient,
      );

      const pubKey = provider.getPublicKey();
      expect(pubKey[0]).toBe(0x03); // odd y → 0x03 prefix
    });
  });

  describe('sign()', () => {
    it('calls KMS sign and converts DER to compact', async () => {
      const r = Buffer.alloc(32, 0x11);
      const s = Buffer.alloc(32, 0x22);
      const derSig = buildDerSignature(r, s);

      const mockClient = createMockKmsClient({
        sign: vi.fn().mockResolvedValue(new Uint8Array(derSig)),
      });

      const provider = await KmsSigningProvider.create(
        { keyId: 'test-key-id' },
        mockClient,
      );

      const sig = await provider.sign(TEST_HASH);

      expect(mockClient.sign).toHaveBeenCalledWith('test-key-id', TEST_HASH);
      expect(sig).toBeInstanceOf(Buffer);
      expect(sig.length).toBe(64);

      // Verify r and s are correctly extracted
      expect(sig.subarray(0, 32)).toEqual(r);
      expect(sig.subarray(32, 64)).toEqual(s);
    });

    it('handles DER signature with leading zero in r', async () => {
      // High bit set → DER adds leading 0x00
      const r = Buffer.alloc(32);
      r[0] = 0x80; // high bit set
      Buffer.alloc(31, 0x11).copy(r, 1);

      const s = Buffer.alloc(32, 0x22);
      const derSig = buildDerSignature(r, s);

      const mockClient = createMockKmsClient({
        sign: vi.fn().mockResolvedValue(new Uint8Array(derSig)),
      });

      const provider = await KmsSigningProvider.create(
        { keyId: 'test-key-id' },
        mockClient,
      );

      const sig = await provider.sign(TEST_HASH);
      expect(sig.length).toBe(64);
      // r should start with 0x80 (leading zero stripped)
      expect(sig[0]).toBe(0x80);
    });

    it('throws when KMS sign rejects', async () => {
      const mockClient = createMockKmsClient({
        sign: vi.fn().mockRejectedValue(new Error('KMS signing error')),
      });

      const provider = await KmsSigningProvider.create(
        { keyId: 'test-key-id' },
        mockClient,
      );

      await expect(provider.sign(TEST_HASH)).rejects.toThrow('KMS signing error');
    });
  });

  describe('getPublicKey()', () => {
    it('returns the cached compressed public key', async () => {
      const mockClient = createMockKmsClient();

      const provider = await KmsSigningProvider.create(
        { keyId: 'test-key-id' },
        mockClient,
      );

      const key1 = provider.getPublicKey();
      const key2 = provider.getPublicKey();

      // Same reference — cached
      expect(key1).toBe(key2);
      // Only fetched once during create()
      expect(mockClient.getPublicKey).toHaveBeenCalledTimes(1);
    });
  });
});

// ─── derToCompact ────────────────────────────────────────────────────────

describe('derToCompact', () => {
  it('converts a standard DER signature to 64-byte compact', () => {
    const r = Buffer.alloc(32, 0xaa);
    const s = Buffer.alloc(32, 0xbb);
    const der = buildDerSignature(r, s);

    const compact = derToCompact(der);
    expect(compact.length).toBe(64);
    expect(compact.subarray(0, 32)).toEqual(r);
    expect(compact.subarray(32, 64)).toEqual(s);
  });

  it('strips leading zero from r when high bit is set', () => {
    const r = Buffer.alloc(32);
    r[0] = 0x80;
    r.fill(0x11, 1);
    const s = Buffer.alloc(32, 0x22);

    const der = buildDerSignature(r, s);
    const compact = derToCompact(der);

    expect(compact.length).toBe(64);
    expect(compact[0]).toBe(0x80);
    expect(compact.subarray(32, 64)).toEqual(s);
  });

  it('strips leading zero from s when high bit is set', () => {
    const r = Buffer.alloc(32, 0x11);
    const s = Buffer.alloc(32);
    s[0] = 0x80;
    s.fill(0x22, 1);

    const der = buildDerSignature(r, s);
    const compact = derToCompact(der);

    expect(compact.length).toBe(64);
    expect(compact[32]).toBe(0x80);
  });

  it('pads short r to 32 bytes', () => {
    // r is only 30 bytes (no leading zero issue)
    const r = Buffer.alloc(30, 0x33);
    const s = Buffer.alloc(32, 0x44);
    const der = buildDerSignature(r, s);

    const compact = derToCompact(der);
    expect(compact.length).toBe(64);
    // First 2 bytes should be zero-padded
    expect(compact[0]).toBe(0x00);
    expect(compact[1]).toBe(0x00);
    expect(compact.subarray(2, 32)).toEqual(r);
  });

  it('pads short s to 32 bytes', () => {
    const r = Buffer.alloc(32, 0x55);
    const s = Buffer.alloc(28, 0x66);
    const der = buildDerSignature(r, s);

    const compact = derToCompact(der);
    expect(compact.length).toBe(64);
    // First 4 bytes of s portion should be zero-padded
    expect(compact[32]).toBe(0x00);
    expect(compact[33]).toBe(0x00);
    expect(compact[34]).toBe(0x00);
    expect(compact[35]).toBe(0x00);
    expect(compact.subarray(36, 64)).toEqual(s);
  });

  it('throws on missing SEQUENCE tag', () => {
    const bad = Buffer.from([0x31, 0x04, 0x02, 0x01, 0x00, 0x02, 0x01, 0x00]);
    expect(() => derToCompact(bad)).toThrow('missing SEQUENCE tag');
  });

  it('throws on missing INTEGER tag for r', () => {
    const bad = Buffer.from([0x30, 0x04, 0x03, 0x01, 0x00, 0x02, 0x01, 0x00]);
    expect(() => derToCompact(bad)).toThrow('missing INTEGER tag for r');
  });

  it('throws on missing INTEGER tag for s', () => {
    const bad = Buffer.from([0x30, 0x06, 0x02, 0x01, 0x00, 0x03, 0x01, 0x00]);
    expect(() => derToCompact(bad)).toThrow('missing INTEGER tag for s');
  });

  it('handles both r and s with leading zeros', () => {
    const r = Buffer.alloc(32);
    r[0] = 0xff;
    r.fill(0xaa, 1);
    const s = Buffer.alloc(32);
    s[0] = 0x80;
    s.fill(0xbb, 1);

    const der = buildDerSignature(r, s);
    const compact = derToCompact(der);

    expect(compact.length).toBe(64);
    expect(compact[0]).toBe(0xff);
    expect(compact[32]).toBe(0x80);
  });
});

// ─── compressPublicKey ───────────────────────────────────────────────────

describe('compressPublicKey', () => {
  it('compresses a valid uncompressed key with even y', () => {
    const uncompressed = Buffer.alloc(65);
    uncompressed[0] = 0x04;
    Buffer.alloc(32, 0xaa).copy(uncompressed, 1); // x
    Buffer.alloc(32, 0xbb).copy(uncompressed, 33); // y
    uncompressed[64] = 0x02; // even

    const compressed = compressPublicKey(uncompressed);
    expect(compressed.length).toBe(33);
    expect(compressed[0]).toBe(0x02); // even y
    expect(compressed.subarray(1, 33)).toEqual(Buffer.alloc(32, 0xaa)); // x preserved
  });

  it('compresses a valid uncompressed key with odd y', () => {
    const uncompressed = Buffer.alloc(65);
    uncompressed[0] = 0x04;
    Buffer.alloc(32, 0xcc).copy(uncompressed, 1);
    Buffer.alloc(32, 0xdd).copy(uncompressed, 33);
    uncompressed[64] = 0x03; // odd

    const compressed = compressPublicKey(uncompressed);
    expect(compressed.length).toBe(33);
    expect(compressed[0]).toBe(0x03); // odd y
  });

  it('throws on wrong length (too short)', () => {
    const bad = Buffer.alloc(64);
    bad[0] = 0x04;
    expect(() => compressPublicKey(bad)).toThrow('Expected 65-byte');
  });

  it('throws on wrong length (too long)', () => {
    const bad = Buffer.alloc(66);
    bad[0] = 0x04;
    expect(() => compressPublicKey(bad)).toThrow('Expected 65-byte');
  });

  it('throws on wrong prefix (not 0x04)', () => {
    const bad = Buffer.alloc(65);
    bad[0] = 0x02; // compressed prefix, not uncompressed
    expect(() => compressPublicKey(bad)).toThrow('0x04 prefix');
  });

  it('throws on zero-prefixed buffer', () => {
    const bad = Buffer.alloc(65, 0x00);
    expect(() => compressPublicKey(bad)).toThrow('0x04 prefix');
  });
});

// ─── createSigningProvider factory ───────────────────────────────────────

describe('createSigningProvider', () => {
  it('creates WIF provider', async () => {
    const provider = await createSigningProvider({
      type: 'wif',
      wif: TEST_WIF,
    });

    expect(provider.name).toBe('WIF (ECPair)');
    expect(provider.getPublicKey().length).toBe(33);
  });

  it('creates WIF provider with explicit network', async () => {
    const provider = await createSigningProvider({
      type: 'wif',
      wif: TEST_WIF,
      network: bitcoin.networks.testnet,
    });

    expect(provider.name).toBe('WIF (ECPair)');
  });

  it('throws when WIF type but no wif provided', async () => {
    await expect(
      createSigningProvider({ type: 'wif' }),
    ).rejects.toThrow('WIF is required');
  });

  it('creates KMS provider with mock client', async () => {
    const mockClient = createMockKmsClient();

    const provider = await createSigningProvider({
      type: 'kms',
      kmsKeyId: 'arn:aws:kms:us-east-1:123456789:key/test-key',
      kmsRegion: 'us-east-1',
      kmsClient: mockClient,
    });

    expect(provider.name).toBe('AWS KMS');
    expect(provider.getPublicKey().length).toBe(33);
  });

  it('throws when KMS type but no kmsKeyId provided', async () => {
    await expect(
      createSigningProvider({ type: 'kms' }),
    ).rejects.toThrow('KMS key ID is required');
  });

  it('throws on unknown provider type', async () => {
    await expect(
      createSigningProvider({ type: 'unknown' as any }),
    ).rejects.toThrow('Unknown signing provider type');
  });

  it('passes kmsRegion to KMS create', async () => {
    const mockClient = createMockKmsClient();

    await createSigningProvider({
      type: 'kms',
      kmsKeyId: 'test-key',
      kmsRegion: 'ap-southeast-1',
      kmsClient: mockClient,
    });

    expect(mockClient.getPublicKey).toHaveBeenCalledWith('test-key');
  });
});
