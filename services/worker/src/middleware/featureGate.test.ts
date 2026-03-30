/**
 * Tests for Feature Gate Middleware (P4.5-TS-12)
 *
 * Verifies that /api/v1/* endpoints are gated behind the
 * ENABLE_VERIFICATION_API switchboard flag.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isVerificationApiEnabled, verificationApiGate, _resetFlagCache } from './featureGate.js';
import type { Request, Response, NextFunction } from 'express';

// Mock the DB module
vi.mock('../utils/db.js', () => ({
  db: {
    from: vi.fn(),
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { db } from '../utils/db.js';

function createMockReqRes() {
  const req = {} as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
  } as unknown as Response;
  const next = vi.fn() as NextFunction;
  return { req, res, next };
}

function mockFlagQuery(flagValue: string | boolean | null, error: unknown = null) {
  const selectMock = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      single: vi.fn().mockResolvedValue({
        data: flagValue !== null ? { value: flagValue } : null,
        error,
      }),
    }),
  });
  (db.from as ReturnType<typeof vi.fn>).mockReturnValue({ select: selectMock });
}

describe('featureGate middleware', () => {
  beforeEach(() => {
    _resetFlagCache();
    vi.clearAllMocks();
  });

  describe('isVerificationApiEnabled', () => {
    it('returns true when flag is boolean true', async () => {
      mockFlagQuery(true);
      expect(await isVerificationApiEnabled()).toBe(true);
    });

    it('returns false when flag is boolean false', async () => {
      mockFlagQuery(false);
      expect(await isVerificationApiEnabled()).toBe(false);
    });

    it('returns false for string value (strict boolean check)', async () => {
      mockFlagQuery('true');
      expect(await isVerificationApiEnabled()).toBe(false);
    });

    it('falls back to env var when flag is not found in DB', async () => {
      const origEnv = process.env.ENABLE_VERIFICATION_API;
      process.env.ENABLE_VERIFICATION_API = 'true';
      mockFlagQuery(null, { message: 'not found' });
      expect(await isVerificationApiEnabled()).toBe(true);
      process.env.ENABLE_VERIFICATION_API = origEnv;
    });

    it('returns false on DB error when env var not set', async () => {
      const origEnv = process.env.ENABLE_VERIFICATION_API;
      delete process.env.ENABLE_VERIFICATION_API;
      (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockRejectedValue(new Error('connection refused')),
          }),
        }),
      });
      expect(await isVerificationApiEnabled()).toBe(false);
      process.env.ENABLE_VERIFICATION_API = origEnv;
    });

    it('caches the result for subsequent calls', async () => {
      mockFlagQuery(true);

      await isVerificationApiEnabled();
      await isVerificationApiEnabled();
      await isVerificationApiEnabled();

      // DB should only be called once due to caching
      expect(db.from).toHaveBeenCalledTimes(1);
    });

    it('refreshes cache after TTL expires', async () => {
      mockFlagQuery(true);

      await isVerificationApiEnabled();
      expect(db.from).toHaveBeenCalledTimes(1);

      // Expire the cache by resetting
      _resetFlagCache();

      mockFlagQuery(false);
      const result = await isVerificationApiEnabled();
      expect(result).toBe(false);
      expect(db.from).toHaveBeenCalledTimes(2);
    });
  });

  describe('verificationApiGate middleware', () => {
    it('calls next() when API is enabled', async () => {
      mockFlagQuery(true);
      const { req, res, next } = createMockReqRes();

      const middleware = verificationApiGate();
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('returns 503 when API is disabled', async () => {
      mockFlagQuery(false);
      const { req, res, next } = createMockReqRes();

      const middleware = verificationApiGate();
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({
        error: 'service_unavailable',
        message: 'Verification API is not currently enabled',
        retry_after: 60,
      });
    });

    it('returns 503 on DB failure when env not set (fail-closed)', async () => {
      const origEnv = process.env.ENABLE_VERIFICATION_API;
      delete process.env.ENABLE_VERIFICATION_API;
      (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockRejectedValue(new Error('DB down')),
          }),
        }),
      });
      const { req, res, next } = createMockReqRes();

      const middleware = verificationApiGate();
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
      process.env.ENABLE_VERIFICATION_API = origEnv;
    });
  });
});
