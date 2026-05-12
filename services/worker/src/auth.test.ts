/**
 * Tests for JWT verification (auth.ts)
 *
 * Tests both local verification (HMAC-SHA256 via jose) and
 * Supabase API fallback paths.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SignJWT } from 'jose';
import { verifyAuthToken } from './auth.js';

const TEST_SECRET = 'super-secret-jwt-key-for-testing-only';
const TEST_USER_ID = '550e8400-e29b-41d4-a716-446655440000';

const mockLogger = {
  warn: vi.fn(),
  error: vi.fn(),
};

/** Generate a valid HS256 JWT with the given claims */
async function createTestJwt(
  claims: Record<string, unknown>,
  secret: string = TEST_SECRET,
): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);
}

describe('verifyAuthToken', () => {
  beforeEach(() => {
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
  });

  describe('local JWT verification (with supabaseJwtSecret)', () => {
    const config = {
      supabaseJwtSecret: TEST_SECRET,
      supabaseUrl: 'https://test.supabase.co',
      supabaseServiceKey: 'test-service-key',
    };

    it('returns user ID from valid JWT sub claim', async () => {
      const token = await createTestJwt({ sub: TEST_USER_ID });
      const result = await verifyAuthToken(token, config, mockLogger);
      expect(result).toBe(TEST_USER_ID);
    });

    it('returns null for empty token', async () => {
      const result = await verifyAuthToken('', config, mockLogger);
      expect(result).toBeNull();
    });

    it('returns null for invalid JWT', async () => {
      const result = await verifyAuthToken('not-a-jwt', config, mockLogger);
      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(Error) }),
        'JWT local verification failed',
      );
    });

    it('returns null for JWT signed with wrong secret', async () => {
      const token = await createTestJwt({ sub: TEST_USER_ID }, 'wrong-secret');
      const result = await verifyAuthToken(token, config, mockLogger);
      expect(result).toBeNull();
    });

    it('returns null for expired JWT', async () => {
      const key = new TextEncoder().encode(TEST_SECRET);
      const token = await new SignJWT({ sub: TEST_USER_ID })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt(Math.floor(Date.now() / 1000) - 7200) // 2 hours ago
        .setExpirationTime(Math.floor(Date.now() / 1000) - 3600) // 1 hour ago
        .sign(key);

      const result = await verifyAuthToken(token, config, mockLogger);
      expect(result).toBeNull();
    });

    it('returns null when JWT has no sub claim', async () => {
      const token = await createTestJwt({ role: 'admin' }); // no sub
      const result = await verifyAuthToken(token, config, mockLogger);
      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith('JWT verified but missing sub claim');
    });
  });

  describe('Supabase API fallback (no supabaseJwtSecret)', () => {
    const config = {
      // No supabaseJwtSecret — triggers fallback
      supabaseUrl: 'https://test.supabase.co',
      supabaseServiceKey: 'test-service-key',
    };

    it('returns user ID from Supabase getUser', async () => {
      // Mock the shared getDb() singleton so verifyJwtViaSupabase uses it
      vi.doMock('./utils/db.js', () => ({
        getDb: () => ({
          auth: {
            getUser: vi.fn().mockResolvedValue({
              data: { user: { id: TEST_USER_ID } },
              error: null,
            }),
          },
        }),
      }));

      const result = await verifyAuthToken('some-token', config, mockLogger);
      expect(result).toBe(TEST_USER_ID);

      vi.doUnmock('./utils/db.js');
    });

    it('returns null when getUser returns error', async () => {
      vi.doMock('./utils/db.js', () => ({
        getDb: () => ({
          auth: {
            getUser: vi.fn().mockResolvedValue({
              data: { user: null },
              error: new Error('Invalid token'),
            }),
          },
        }),
      }));

      const result = await verifyAuthToken('bad-token', config, mockLogger);
      expect(result).toBeNull();

      vi.doUnmock('./utils/db.js');
    });
  });
});
