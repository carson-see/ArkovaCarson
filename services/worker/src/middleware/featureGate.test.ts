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
    rpc: vi.fn(),
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

const mockedRpc = db.rpc as ReturnType<typeof vi.fn>;

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

function mockFlagRpc(flagValue: boolean | null, error: { message: string; code?: string } | null = null) {
  mockedRpc.mockResolvedValue({
    data: flagValue,
    error,
  });
}

function restoreVerificationApiEnv(value: string | undefined) {
  if (value === undefined) {
    delete process.env.ENABLE_VERIFICATION_API;
    return;
  }
  process.env.ENABLE_VERIFICATION_API = value;
}

describe('featureGate middleware', () => {
  beforeEach(() => {
    _resetFlagCache();
    vi.clearAllMocks();
  });

  describe('isVerificationApiEnabled', () => {
    it('returns true when flag is boolean true', async () => {
      mockFlagRpc(true);
      expect(await isVerificationApiEnabled()).toBe(true);
      expect(mockedRpc).toHaveBeenCalledWith('get_flag', {
        p_flag_key: 'ENABLE_VERIFICATION_API',
      });
    });

    it('returns false when flag is boolean false', async () => {
      const origEnv = process.env.ENABLE_VERIFICATION_API;
      process.env.ENABLE_VERIFICATION_API = 'true';
      mockFlagRpc(false);
      expect(await isVerificationApiEnabled()).toBe(false);
      restoreVerificationApiEnv(origEnv);
    });

    it('falls back to env var when flag RPC returns an error', async () => {
      const origEnv = process.env.ENABLE_VERIFICATION_API;
      process.env.ENABLE_VERIFICATION_API = 'true';
      mockFlagRpc(null, { message: 'not found' });
      expect(await isVerificationApiEnabled()).toBe(true);
      restoreVerificationApiEnv(origEnv);
    });

    it('falls back to env var when flag RPC throws', async () => {
      const origEnv = process.env.ENABLE_VERIFICATION_API;
      process.env.ENABLE_VERIFICATION_API = 'true';
      mockedRpc.mockRejectedValue(new Error('connection refused'));
      expect(await isVerificationApiEnabled()).toBe(true);
      restoreVerificationApiEnv(origEnv);
    });

    it('returns false on DB error when env var is not set', async () => {
      const origEnv = process.env.ENABLE_VERIFICATION_API;
      delete process.env.ENABLE_VERIFICATION_API;
      mockedRpc.mockRejectedValue(new Error('connection refused'));
      expect(await isVerificationApiEnabled()).toBe(false);
      restoreVerificationApiEnv(origEnv);
    });

    it('caches the result for subsequent calls', async () => {
      mockFlagRpc(true);

      await isVerificationApiEnabled();
      await isVerificationApiEnabled();
      await isVerificationApiEnabled();

      expect(mockedRpc).toHaveBeenCalledTimes(1);
    });

    it('refreshes cache after TTL expires', async () => {
      mockFlagRpc(true);

      await isVerificationApiEnabled();
      expect(mockedRpc).toHaveBeenCalledTimes(1);

      // Expire the cache by resetting
      _resetFlagCache();

      mockFlagRpc(false);
      const result = await isVerificationApiEnabled();
      expect(result).toBe(false);
      expect(mockedRpc).toHaveBeenCalledTimes(2);
    });
  });

  describe('verificationApiGate middleware', () => {
    it('calls next() when API is enabled', async () => {
      mockFlagRpc(true);
      const { req, res, next } = createMockReqRes();

      const middleware = verificationApiGate();
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('returns 503 when API is disabled', async () => {
      mockFlagRpc(false);
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
      mockedRpc.mockRejectedValue(new Error('DB down'));
      const { req, res, next } = createMockReqRes();

      const middleware = verificationApiGate();
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
      restoreVerificationApiEnv(origEnv);
    });
  });
});
