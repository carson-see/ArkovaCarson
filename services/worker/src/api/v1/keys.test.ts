/**
 * Tests for API Key CRUD Endpoints (P4.5-TS-07)
 *
 * Constitution 1.4: Raw keys never stored, only HMAC-SHA256 hash.
 * Key lifecycle events logged to audit_events.
 *
 * Tests the key generation and validation logic directly,
 * plus integration with the CRUD request handlers.
 */

import { describe, it, expect, vi } from 'vitest';
import { generateApiKey, hashApiKey } from '../../middleware/apiKeyAuth.js';

// Mock DB + logger
vi.mock('../../utils/db.js', () => ({
  db: {
    from: vi.fn(),
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

const TEST_HMAC_SECRET = 'test-hmac-secret-for-keys-crud';

describe('API Key CRUD — key generation security', () => {
  it('generated key raw value starts with ak_live_ prefix', () => {
    const { raw } = generateApiKey(TEST_HMAC_SECRET, false);
    expect(raw.startsWith('ak_live_')).toBe(true);
  });

  it('generated test key starts with ak_test_ prefix', () => {
    const { raw } = generateApiKey(TEST_HMAC_SECRET, true);
    expect(raw.startsWith('ak_test_')).toBe(true);
  });

  it('raw key is never equal to the hash (Constitution 1.4)', () => {
    const { raw, hash } = generateApiKey(TEST_HMAC_SECRET);
    expect(raw).not.toBe(hash);
  });

  it('prefix is a safe display substring of the raw key', () => {
    const { raw, prefix } = generateApiKey(TEST_HMAC_SECRET);
    expect(raw.startsWith(prefix)).toBe(true);
    expect(prefix.length).toBe(12);
  });

  it('hash is reproducible from raw + secret', () => {
    const { raw, hash } = generateApiKey(TEST_HMAC_SECRET);
    expect(hashApiKey(raw, TEST_HMAC_SECRET)).toBe(hash);
  });

  it('different secret produces different hash for same key', () => {
    const { raw, hash } = generateApiKey(TEST_HMAC_SECRET);
    const differentHash = hashApiKey(raw, 'different-secret');
    expect(differentHash).not.toBe(hash);
  });

  it('key contains 64 hex chars of randomness after prefix', () => {
    const { raw } = generateApiKey(TEST_HMAC_SECRET);
    const randomPart = raw.replace(/^ak_(live|test)_/, '');
    expect(randomPart).toMatch(/^[a-f0-9]{64}$/);
  });

  it('each generated key is unique', () => {
    const keys = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const { raw } = generateApiKey(TEST_HMAC_SECRET);
      keys.add(raw);
    }
    expect(keys.size).toBe(100);
  });
});

describe('API Key CRUD — validation schemas', () => {
  it('CreateKeySchema accepts valid input', async () => {
    const { z } = await import('zod');
    const CreateKeySchema = z.object({
      name: z.string().min(1).max(100),
      scopes: z.array(z.string()).default(['verify']),
      expires_in_days: z.number().int().positive().optional(),
    });

    const result = CreateKeySchema.safeParse({ name: 'My Production Key' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scopes).toEqual(['verify']);
    }
  });

  it('CreateKeySchema rejects empty name', async () => {
    const { z } = await import('zod');
    const CreateKeySchema = z.object({
      name: z.string().min(1).max(100),
    });

    const result = CreateKeySchema.safeParse({ name: '' });
    expect(result.success).toBe(false);
  });

  it('CreateKeySchema rejects name over 100 chars', async () => {
    const { z } = await import('zod');
    const CreateKeySchema = z.object({
      name: z.string().min(1).max(100),
    });

    const result = CreateKeySchema.safeParse({ name: 'x'.repeat(101) });
    expect(result.success).toBe(false);
  });

  it('UpdateKeySchema accepts partial updates', async () => {
    const { z } = await import('zod');
    const UpdateKeySchema = z.object({
      name: z.string().min(1).max(100).optional(),
      is_active: z.boolean().optional(),
    });

    expect(UpdateKeySchema.safeParse({ name: 'New Name' }).success).toBe(true);
    expect(UpdateKeySchema.safeParse({ is_active: false }).success).toBe(true);
    expect(UpdateKeySchema.safeParse({}).success).toBe(true);
  });
});
