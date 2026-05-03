/**
 * Tests for Feature Gate Middleware (P4.5-TS-12)
 *
 * Verifies that /api/v1/* endpoints are gated behind the
 * ENABLE_VERIFICATION_API switchboard flag.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
import { logger } from '../utils/logger.js';

const mockedRpc = vi.mocked(db.rpc);
const mockedLogger = vi.mocked(logger);

interface MockRpcError {
  message: string;
  code?: string;
}

function mockRpcResponse(data: boolean | null, error: MockRpcError | null = null) {
  return {
    data,
    error: error
      ? {
          message: error.message,
          code: error.code ?? '',
          details: '',
          hint: '',
          name: 'PostgrestError',
          toJSON: () => error,
        }
      : null,
    count: null,
    status: error ? 500 : 200,
    statusText: error ? 'Internal Server Error' : 'OK',
  } as Awaited<ReturnType<typeof db.rpc>>;
}

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

function mockFlagRpc(flagValue: boolean | null, error: MockRpcError | null = null) {
  mockedRpc.mockResolvedValue(mockRpcResponse(flagValue, error));
}

describe('featureGate middleware', () => {
  beforeEach(() => {
    _resetFlagCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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
      vi.stubEnv('ENABLE_VERIFICATION_API', 'true');
      mockFlagRpc(false);
      expect(await isVerificationApiEnabled()).toBe(false);
    });

    it('fails closed when flag RPC returns an error', async () => {
      vi.stubEnv('ENABLE_VERIFICATION_API', 'true');
      mockFlagRpc(null, { message: 'not found' });
      expect(await isVerificationApiEnabled()).toBe(false);
      expect(await isVerificationApiEnabled()).toBe(false);
      expect(mockedRpc).toHaveBeenCalledTimes(1);
      expect(mockedLogger.warn).toHaveBeenCalledWith(
        {
          error: expect.objectContaining({ message: 'not found' }),
          flagKey: 'ENABLE_VERIFICATION_API',
        },
        'Failed to read ENABLE_VERIFICATION_API flag from DB, failing closed',
      );
      expect(mockedLogger.warn).not.toHaveBeenCalledWith(
        expect.objectContaining({ envFallback: expect.any(Boolean) }),
        expect.any(String),
      );
    });

    it('fails closed when flag RPC returns non-boolean data without an error', async () => {
      vi.stubEnv('ENABLE_VERIFICATION_API', 'true');
      mockedRpc.mockResolvedValue(mockRpcResponse(null));
      expect(await isVerificationApiEnabled()).toBe(false);
      expect(await isVerificationApiEnabled()).toBe(false);
      expect(mockedRpc).toHaveBeenCalledTimes(1);
    });

    it('fails closed when get_flag returns a normalized RPC_THREW error', async () => {
      vi.stubEnv('ENABLE_VERIFICATION_API', 'true');
      mockFlagRpc(null, { message: 'connection refused', code: 'RPC_THREW' });
      expect(await isVerificationApiEnabled()).toBe(false);
      expect(await isVerificationApiEnabled()).toBe(false);
      expect(mockedRpc).toHaveBeenCalledTimes(1);
    });

    it('returns false on DB error when env var is not set', async () => {
      vi.stubEnv('ENABLE_VERIFICATION_API', undefined);
      mockFlagRpc(null, { message: 'connection refused', code: 'RPC_THREW' });
      expect(await isVerificationApiEnabled()).toBe(false);
      expect(await isVerificationApiEnabled()).toBe(false);
      expect(mockedRpc).toHaveBeenCalledTimes(1);
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
      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '60');
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({
        error: 'service_unavailable',
        message: 'Verification API is not currently enabled',
        retry_after: 60,
      });
      expect(res.json).toHaveBeenCalledWith({
        error: 'service_unavailable',
        message: 'Verification API is not currently enabled',
        retry_after: 60,
      });
    });

    it('returns 503 on DB failure when env not set (fail-closed)', async () => {
      vi.stubEnv('ENABLE_VERIFICATION_API', undefined);
      mockFlagRpc(null, { message: 'DB down', code: 'RPC_THREW' });
      const { req, res, next } = createMockReqRes();

      const middleware = verificationApiGate();
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '60');
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({
        error: 'service_unavailable',
        message: 'Verification API is not currently enabled',
        retry_after: 60,
      });
    });

    it('returns 503 on DB failure when env is true (fail-closed)', async () => {
      vi.stubEnv('ENABLE_VERIFICATION_API', 'true');
      mockFlagRpc(null, { message: 'DB down', code: 'RPC_THREW' });
      const { req, res, next } = createMockReqRes();

      const middleware = verificationApiGate();
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '60');
      expect(res.status).toHaveBeenCalledWith(503);
    });
  });
});
