/**
 * Tests for the Partner Provisioning Feature Gate (SCRUM-2990).
 *
 * The whole partner-provisioning surface is OFF by default behind the
 * ENABLE_PARTNER_PROVISIONING switchboard flag. Mirrors the
 * ENABLE_VERIFICATION_API gate mechanism exactly (featureGate.ts / CLAUDE.md
 * §1.9): get_flag RPC + 60s TTL cache, and FAIL CLOSED — flag absent, false,
 * non-boolean, or read-error all leave the surface dark. The env var is NOT a
 * runtime fallback (an unseeded switchboard row = surface dark, by design; the
 * flag row is seeded by release-ops, not by this PR).
 *
 * Dark = HTTP 404 (the surface does not exist until the flag is on), unlike the
 * verification gate's 503: /api/v1 is a published API that can be "temporarily
 * unavailable", while partner provisioning is unreleased and must not disclose
 * its existence pre-launch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isPartnerProvisioningEnabled,
  partnerProvisioningGate,
  _resetPartnerProvisioningFlagCache,
} from './partnerProvisioningGate.js';
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

describe('partnerProvisioningGate middleware (SCRUM-2990)', () => {
  beforeEach(() => {
    _resetPartnerProvisioningFlagCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('isPartnerProvisioningEnabled', () => {
    it('returns true when the switchboard flag is boolean true', async () => {
      mockFlagRpc(true);
      expect(await isPartnerProvisioningEnabled()).toBe(true);
      expect(mockedRpc).toHaveBeenCalledWith('get_flag', {
        p_flag_key: 'ENABLE_PARTNER_PROVISIONING',
      });
    });

    it('returns false when the flag is boolean false', async () => {
      mockFlagRpc(false);
      expect(await isPartnerProvisioningEnabled()).toBe(false);
    });

    it('fails closed when the flag RPC errors — env var is NOT a fallback', async () => {
      vi.stubEnv('ENABLE_PARTNER_PROVISIONING', 'true');
      mockFlagRpc(null, { message: 'not found' });
      expect(await isPartnerProvisioningEnabled()).toBe(false);
      expect(await isPartnerProvisioningEnabled()).toBe(false);
      // Negative result is cached — a failing switchboard is not hammered.
      expect(mockedRpc).toHaveBeenCalledTimes(1);
      expect(mockedLogger.warn).toHaveBeenCalledWith(
        {
          error: expect.objectContaining({ message: 'not found' }),
          flagKey: 'ENABLE_PARTNER_PROVISIONING',
        },
        'Failed to read ENABLE_PARTNER_PROVISIONING flag from DB, failing closed',
      );
    });

    it('fails closed when the flag row is absent (get_flag → non-boolean/null)', async () => {
      vi.stubEnv('ENABLE_PARTNER_PROVISIONING', 'true');
      mockedRpc.mockResolvedValue(mockRpcResponse(null));
      expect(await isPartnerProvisioningEnabled()).toBe(false);
      expect(mockedRpc).toHaveBeenCalledTimes(1);
    });

    it('fails closed on a normalized RPC_THREW error', async () => {
      mockFlagRpc(null, { message: 'connection refused', code: 'RPC_THREW' });
      expect(await isPartnerProvisioningEnabled()).toBe(false);
    });

    it('caches the result for subsequent calls (TTL)', async () => {
      mockFlagRpc(true);
      await isPartnerProvisioningEnabled();
      await isPartnerProvisioningEnabled();
      await isPartnerProvisioningEnabled();
      expect(mockedRpc).toHaveBeenCalledTimes(1);
    });

    it('re-reads after the cache is reset', async () => {
      mockFlagRpc(true);
      await isPartnerProvisioningEnabled();
      expect(mockedRpc).toHaveBeenCalledTimes(1);

      _resetPartnerProvisioningFlagCache();
      mockFlagRpc(false);
      expect(await isPartnerProvisioningEnabled()).toBe(false);
      expect(mockedRpc).toHaveBeenCalledTimes(2);
    });
  });

  describe('partnerProvisioningGate', () => {
    it('calls next() when the flag is on', async () => {
      mockFlagRpc(true);
      const { req, res, next } = createMockReqRes();

      await partnerProvisioningGate()(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('returns 404 when the flag is off (surface dark)', async () => {
      mockFlagRpc(false);
      const { req, res, next } = createMockReqRes();

      await partnerProvisioningGate()(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'not_found' });
    });

    it('returns 404 on a DB read failure even when the env var is true (fail closed)', async () => {
      vi.stubEnv('ENABLE_PARTNER_PROVISIONING', 'true');
      mockFlagRpc(null, { message: 'DB down', code: 'RPC_THREW' });
      const { req, res, next } = createMockReqRes();

      await partnerProvisioningGate()(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'not_found' });
    });

    it('returns 404 when the flag row is simply unseeded (absent → dark, safe default)', async () => {
      mockedRpc.mockResolvedValue(mockRpcResponse(null));
      const { req, res, next } = createMockReqRes();

      await partnerProvisioningGate()(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(404);
    });
  });
});
