/**
 * Tests for JWT verification (auth.ts)
 *
 * Tests both local verification (HMAC-SHA256 via jose) and
 * Supabase API fallback paths.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SignJWT, generateKeyPair, type CryptoKey } from 'jose';
import { verifyAuthToken } from './auth.js';

/**
 * Key returned by the stubbed remote JWKS resolver. Set per-test.
 * Only `createRemoteJWKSet` is stubbed — every other `jose` export stays real,
 * so the HS256 tests below still exercise genuine signature verification.
 */
let mockJwksKey: CryptoKey | undefined;

vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();
  return {
    ...actual,
    createRemoteJWKSet: () => async () => {
      if (!mockJwksKey) throw new Error('JWKS unavailable');
      return mockJwksKey;
    },
  };
});

const TEST_SECRET = 'super-secret-jwt-key-for-testing-only';
const TEST_USER_ID = '550e8400-e29b-41d4-a716-446655440000';
const SUPABASE_URL = 'https://test.supabase.co';

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

  describe('OIDC token detection — skips Supabase auth call (with secret)', () => {
    const config = {
      supabaseJwtSecret: TEST_SECRET,
      supabaseUrl: 'https://test.supabase.co',
      supabaseServiceKey: 'test-service-key',
    };

    it('returns null without calling Supabase auth for Google OIDC tokens', async () => {
      const key = new TextEncoder().encode('google-oidc-key-not-supabase');
      const oidcToken = await new SignJWT({ sub: '12345', iss: 'https://accounts.google.com', aud: 'my-audience' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(key);

      const getUser = vi.fn();
      vi.doMock('./utils/db.js', () => ({
        getDb: () => ({ auth: { getUser } }),
      }));

      const result = await verifyAuthToken(oidcToken, config, mockLogger);

      expect(result).toBeNull();
      expect(getUser).not.toHaveBeenCalled();

      vi.doUnmock('./utils/db.js');
    });
  });

  describe('OIDC token detection — without supabaseJwtSecret', () => {
    const config = {
      // No supabaseJwtSecret — the OIDC short-circuit must still fire
      supabaseUrl: 'https://test.supabase.co',
      supabaseServiceKey: 'test-service-key',
    };

    it('returns null without calling Supabase auth for Google OIDC tokens even when JWT secret is missing', async () => {
      const key = new TextEncoder().encode('google-oidc-key-not-supabase');
      const oidcToken = await new SignJWT({ sub: '12345', iss: 'https://accounts.google.com', aud: 'my-audience' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(key);

      const getUser = vi.fn();
      vi.doMock('./utils/db.js', () => ({
        getDb: () => ({ auth: { getUser } }),
      }));

      const result = await verifyAuthToken(oidcToken, config, mockLogger);

      expect(result).toBeNull();
      expect(getUser).not.toHaveBeenCalled();

      vi.doUnmock('./utils/db.js');
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

  /**
   * INCIDENT 2026-08-11: a Google OIDC cron token produced
   * `JWT local verification failed — ERR_JOSE_ALG_NOT_ALLOWED` on every single
   * Cloud Scheduler request. The request then succeeded via the OIDC path in
   * cron.ts, so the warning was pure noise on the happy path — but during a
   * production incident it was indistinguishable from a real auth failure and
   * sent the investigation down a dead end for ~30 minutes.
   *
   * A non-Supabase issuer must never be checked against Supabase credentials.
   */
  describe('log hygiene — non-Supabase issuers must not warn', () => {
    const config = {
      supabaseJwtSecret: TEST_SECRET,
      supabaseUrl: SUPABASE_URL,
      supabaseServiceKey: 'test-service-key',
    };

    it('does not emit "JWT local verification failed" for a Google OIDC token', async () => {
      // RS256, exactly like a real Cloud Scheduler OIDC token.
      const { privateKey } = await generateKeyPair('RS256');
      const oidcToken = await new SignJWT({
        sub: '12345',
        iss: 'https://accounts.google.com',
        aud: 'https://arkova-worker.example.run.app',
      })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);

      const result = await verifyAuthToken(oidcToken, config, mockLogger);

      expect(result).toBeNull();
      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        expect.anything(),
        'JWT local verification failed',
      );
    });
  });

  /**
   * Supabase migrated this project to asymmetric JWT signing: the project JWKS
   * at /auth/v1/.well-known/jwks.json serves an ES256 key. `verifyJwtLocally`
   * pins `algorithms: ['HS256']` against the symmetric SUPABASE_JWT_SECRET, so
   * an ES256 user token cannot verify locally and silently degrades every
   * authenticated request to a per-request network call to the Supabase auth
   * API. These tests pin the JWKS path.
   */
  describe('asymmetric (ES256) Supabase user tokens via JWKS', () => {
    const config = {
      supabaseJwtSecret: TEST_SECRET,
      supabaseUrl: SUPABASE_URL,
      supabaseServiceKey: 'test-service-key',
    };

    beforeEach(() => {
      mockJwksKey = undefined;
    });

    it('verifies an ES256 token against the project JWKS without any DB call', async () => {
      const { publicKey, privateKey } = await generateKeyPair('ES256');
      mockJwksKey = publicKey;

      const token = await new SignJWT({ sub: TEST_USER_ID })
        .setProtectedHeader({ alg: 'ES256' })
        .setIssuer(`${SUPABASE_URL}/auth/v1`)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);

      const getUser = vi.fn();
      vi.doMock('./utils/db.js', () => ({ getDb: () => ({ auth: { getUser } }) }));

      const result = await verifyAuthToken(token, config, mockLogger);

      expect(result).toBe(TEST_USER_ID);
      expect(getUser).not.toHaveBeenCalled();

      vi.doUnmock('./utils/db.js');
    });

    it('rejects an ES256 token issued by a DIFFERENT Supabase project', async () => {
      const { publicKey, privateKey } = await generateKeyPair('ES256');
      mockJwksKey = publicKey;

      // Correctly signed, but the issuer is another project. Issuer pinning is
      // the only thing preventing cross-project token replay.
      const token = await new SignJWT({ sub: TEST_USER_ID })
        .setProtectedHeader({ alg: 'ES256' })
        .setIssuer('https://attacker-project.supabase.co/auth/v1')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);

      vi.doMock('./utils/db.js', () => ({
        getDb: () => ({
          auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: new Error('bad') }) },
        }),
      }));

      const result = await verifyAuthToken(token, config, mockLogger);
      expect(result).toBeNull();

      vi.doUnmock('./utils/db.js');
    });

    it('rejects an ES256 token whose signature does not match the JWKS key', async () => {
      const { publicKey } = await generateKeyPair('ES256');
      const { privateKey: wrongKey } = await generateKeyPair('ES256');
      mockJwksKey = publicKey;

      const token = await new SignJWT({ sub: TEST_USER_ID })
        .setProtectedHeader({ alg: 'ES256' })
        .setIssuer(`${SUPABASE_URL}/auth/v1`)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(wrongKey);

      vi.doMock('./utils/db.js', () => ({
        getDb: () => ({
          auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: new Error('bad') }) },
        }),
      }));

      const result = await verifyAuthToken(token, config, mockLogger);
      expect(result).toBeNull();

      vi.doUnmock('./utils/db.js');
    });

    it('still verifies HS256 tokens locally (legacy projects keep working)', async () => {
      const token = await createTestJwt({ sub: TEST_USER_ID });
      const result = await verifyAuthToken(token, config, mockLogger);
      expect(result).toBe(TEST_USER_ID);
    });
  });
});
