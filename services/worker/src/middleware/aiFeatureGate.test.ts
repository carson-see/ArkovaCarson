/**
 * Tests for AI Feature Gate Middleware (P8-S3)
 *
 * Verifies that AI endpoints are gated behind the
 * ENABLE_AI_EXTRACTION, ENABLE_SEMANTIC_SEARCH, and ENABLE_AI_FRAUD
 * switchboard flags.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isAIExtractionEnabled,
  isSemanticSearchEnabled,
  isAIFraudEnabled,
  aiExtractionGate,
  aiSemanticSearchGate,
  aiFraudGate,
  _resetAIFlagCache,
} from './aiFeatureGate.js';
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
  } as unknown as Response;
  const next = vi.fn() as NextFunction;
  return { req, res, next };
}

function mockFlagQuery(flagKey: string, value: boolean | null, error: unknown = null) {
  const singleMock = vi.fn().mockResolvedValue({
    data: value !== null ? { value } : null,
    error,
  });
  const eqMock = vi.fn().mockReturnValue({ single: singleMock });
  const selectMock = vi.fn().mockReturnValue({ eq: eqMock });
  (db.from as ReturnType<typeof vi.fn>).mockReturnValue({ select: selectMock });
}

describe('aiFeatureGate middleware', () => {
  beforeEach(() => {
    _resetAIFlagCache();
    vi.clearAllMocks();
  });

  describe('isAIExtractionEnabled', () => {
    it('returns true when flag is boolean true', async () => {
      mockFlagQuery('ENABLE_AI_EXTRACTION', true);
      expect(await isAIExtractionEnabled()).toBe(true);
    });

    it('returns false when flag is boolean false', async () => {
      mockFlagQuery('ENABLE_AI_EXTRACTION', false);
      expect(await isAIExtractionEnabled()).toBe(false);
    });

    it('returns false when flag is not found', async () => {
      mockFlagQuery('ENABLE_AI_EXTRACTION', null, { message: 'not found' });
      expect(await isAIExtractionEnabled()).toBe(false);
    });

    it('returns false on DB error (fail-closed)', async () => {
      (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockRejectedValue(new Error('connection refused')),
          }),
        }),
      });
      expect(await isAIExtractionEnabled()).toBe(false);
    });

    it('caches the result for subsequent calls', async () => {
      mockFlagQuery('ENABLE_AI_EXTRACTION', true);
      await isAIExtractionEnabled();
      await isAIExtractionEnabled();
      await isAIExtractionEnabled();
      expect(db.from).toHaveBeenCalledTimes(1);
    });

    it('refreshes cache after reset', async () => {
      mockFlagQuery('ENABLE_AI_EXTRACTION', true);
      await isAIExtractionEnabled();
      expect(db.from).toHaveBeenCalledTimes(1);

      _resetAIFlagCache();
      mockFlagQuery('ENABLE_AI_EXTRACTION', false);
      const result = await isAIExtractionEnabled();
      expect(result).toBe(false);
      expect(db.from).toHaveBeenCalledTimes(2);
    });
  });

  describe('isSemanticSearchEnabled', () => {
    it('returns true when flag is enabled', async () => {
      mockFlagQuery('ENABLE_SEMANTIC_SEARCH', true);
      expect(await isSemanticSearchEnabled()).toBe(true);
    });

    it('returns false when flag is disabled', async () => {
      mockFlagQuery('ENABLE_SEMANTIC_SEARCH', false);
      expect(await isSemanticSearchEnabled()).toBe(false);
    });
  });

  describe('isAIFraudEnabled', () => {
    it('returns true when flag is enabled', async () => {
      mockFlagQuery('ENABLE_AI_FRAUD', true);
      expect(await isAIFraudEnabled()).toBe(true);
    });

    it('returns false when flag is disabled', async () => {
      mockFlagQuery('ENABLE_AI_FRAUD', false);
      expect(await isAIFraudEnabled()).toBe(false);
    });
  });

  describe('aiExtractionGate middleware', () => {
    it('calls next() when extraction is enabled', async () => {
      mockFlagQuery('ENABLE_AI_EXTRACTION', true);
      const { req, res, next } = createMockReqRes();

      const middleware = aiExtractionGate();
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('returns 503 when extraction is disabled', async () => {
      mockFlagQuery('ENABLE_AI_EXTRACTION', false);
      const { req, res, next } = createMockReqRes();

      const middleware = aiExtractionGate();
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({
        error: 'service_unavailable',
        message: 'AI extraction is not currently enabled',
      });
    });

    it('returns 503 on DB failure (fail-closed)', async () => {
      (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockRejectedValue(new Error('DB down')),
          }),
        }),
      });
      const { req, res, next } = createMockReqRes();

      const middleware = aiExtractionGate();
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
    });
  });

  describe('aiSemanticSearchGate middleware', () => {
    it('calls next() when enabled', async () => {
      mockFlagQuery('ENABLE_SEMANTIC_SEARCH', true);
      const { req, res, next } = createMockReqRes();
      await aiSemanticSearchGate()(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('returns 503 when disabled', async () => {
      mockFlagQuery('ENABLE_SEMANTIC_SEARCH', false);
      const { req, res, next } = createMockReqRes();
      await aiSemanticSearchGate()(req, res, next);
      expect(res.status).toHaveBeenCalledWith(503);
    });
  });

  describe('aiFraudGate middleware', () => {
    it('calls next() when enabled', async () => {
      mockFlagQuery('ENABLE_AI_FRAUD', true);
      const { req, res, next } = createMockReqRes();
      await aiFraudGate()(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('returns 503 when disabled', async () => {
      mockFlagQuery('ENABLE_AI_FRAUD', false);
      const { req, res, next } = createMockReqRes();
      await aiFraudGate()(req, res, next);
      expect(res.status).toHaveBeenCalledWith(503);
    });
  });
});
