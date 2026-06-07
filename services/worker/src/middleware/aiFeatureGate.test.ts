/**
 * Tests for AI Feature Gate Middleware (P8-S3)
 *
 * Verifies that AI endpoints are gated behind the
 * ENABLE_AI_EXTRACTION, ENABLE_SEMANTIC_SEARCH, and ENABLE_AI_FRAUD
 * switchboard flags.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isAIExtractionEnabled,
  isSemanticSearchEnabled,
  isAIFraudEnabled,
  isAIReportsEnabled,
  isVisualFraudDetectionEnabled,
  aiExtractionGate,
  aiSemanticSearchGate,
  aiFraudGate,
  visualFraudDetectionGate,
  _resetAIFlagCache,
  _expireAIFlagCache,
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

function mockFlagQuery(_flagKey: string, flagValue: boolean | null, error: unknown = null) {
  // Mirror the runtime query shape:
  //   select('enabled').eq('flag_key', flagKey).single()
  // Pre-fix code used `value` + `id` which silently errored against the
  // (id uuid, flag_key text, enabled boolean, ...) schema and fell back
  // to env var on every call. Tests now assert the post-fix contract.
  const singleMock = vi.fn().mockResolvedValue({
    data: flagValue !== null ? { enabled: flagValue } : null,
    error,
  });
  const eqMock = vi.fn().mockReturnValue({ single: singleMock });
  const selectMock = vi.fn().mockReturnValue({ eq: eqMock });
  (db.from as ReturnType<typeof vi.fn>).mockReturnValue({ select: selectMock });
}

/** Mock a thrown DB read (e.g. transient connection drop / timeout). */
function mockFlagThrow(err: Error = new Error('connection refused')) {
  (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        single: vi.fn().mockRejectedValue(err),
      }),
    }),
  });
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

  describe('visualFraudDetectionGate middleware (CLAUDE.md §1.6 carve-out)', () => {
    it('calls next() when ENABLE_VISUAL_FRAUD_DETECTION enabled', async () => {
      mockFlagQuery('ENABLE_VISUAL_FRAUD_DETECTION', true);
      const { req, res, next } = createMockReqRes();
      await visualFraudDetectionGate()(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('returns 503 when disabled (the documents-never-leave-device default)', async () => {
      mockFlagQuery('ENABLE_VISUAL_FRAUD_DETECTION', false);
      const { req, res, next } = createMockReqRes();
      await visualFraudDetectionGate()(req, res, next);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(next).not.toHaveBeenCalled();
    });

    it('fails closed when DB read errors AND env var unset (no implicit allow)', async () => {
      // Force the env fallback path via DB error, with env var absent.
      delete process.env.ENABLE_VISUAL_FRAUD_DETECTION;
      mockFlagQuery('ENABLE_VISUAL_FRAUD_DETECTION', null, new Error('connection lost'));
      expect(await isVisualFraudDetectionEnabled()).toBe(false);
    });

    it('stays off by default when no DB row or env override exists', async () => {
      delete process.env.ENABLE_VISUAL_FRAUD_DETECTION;
      mockFlagQuery('ENABLE_VISUAL_FRAUD_DETECTION', null, { code: 'PGRST116', message: 'not found' });
      expect(await isVisualFraudDetectionEnabled()).toBe(false);
    });

    it('middleware itself returns 503 (not next) under DB-error fail-closed path', async () => {
      delete process.env.ENABLE_VISUAL_FRAUD_DETECTION;
      mockFlagQuery('ENABLE_VISUAL_FRAUD_DETECTION', null, new Error('db down'));
      const { req, res, next } = createMockReqRes();
      await visualFraudDetectionGate()(req, res, next);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(next).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // SCRUM-2247 (HARDEN-1-D): kill-switchable flags must NOT re-open on a
  // transient DB blip. The SEV1 scenario is env=true (set in Cloud Run) +
  // DB=false (switchboard kill-switch flipped off) + a transient Supabase
  // read error. Pre-fix code returned `envFallback` (true) → silently
  // re-enabled the killed feature. Post-fix: fail CLOSED (false), preferring
  // last-known-good DB value over env on a transient blip.
  // ───────────────────────────────────────────────────────────────────────
  describe('SCRUM-2247 fail-closed for kill-switchable flags', () => {
    const originalEnv = { ...process.env };
    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('SEV1: ENABLE_SEMANTIC_SEARCH fails CLOSED when env=true but DB read throws', async () => {
      process.env.ENABLE_SEMANTIC_SEARCH = 'true';
      mockFlagThrow(new Error('connection refused'));
      // Must NOT return the env-var fallback (true). Kill-switchable → false.
      expect(await isSemanticSearchEnabled()).toBe(false);
    });

    it('SEV1: ENABLE_AI_FRAUD fails CLOSED when env=true but DB row is null', async () => {
      process.env.ENABLE_AI_FRAUD = 'true';
      mockFlagQuery('ENABLE_AI_FRAUD', null, { code: 'PGRST116', message: 'timeout' });
      expect(await isAIFraudEnabled()).toBe(false);
    });

    it('SEV1: ENABLE_AI_REPORTS fails CLOSED when env=true but DB read throws', async () => {
      process.env.ENABLE_AI_REPORTS = 'true';
      mockFlagThrow(new Error('ETIMEDOUT'));
      expect(await isAIReportsEnabled()).toBe(false);
    });

    it('SEV1: ENABLE_VISUAL_FRAUD_DETECTION fails CLOSED when env=true but DB errors', async () => {
      process.env.ENABLE_VISUAL_FRAUD_DETECTION = 'true';
      mockFlagThrow(new Error('socket hang up'));
      expect(await isVisualFraudDetectionEnabled()).toBe(false);
    });

    it('SEV1 middleware: semantic-search gate returns 503 (not next) when env=true + DB throws', async () => {
      process.env.ENABLE_SEMANTIC_SEARCH = 'true';
      mockFlagThrow(new Error('db down'));
      const { req, res, next } = createMockReqRes();
      await aiSemanticSearchGate()(req, res, next);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(next).not.toHaveBeenCalled();
    });

    it('prefers last-known-good DB value (false) over env=true on a transient blip', async () => {
      process.env.ENABLE_AI_FRAUD = 'true';
      // First read succeeds with DB=false (kill-switch is OFF).
      mockFlagQuery('ENABLE_AI_FRAUD', false);
      expect(await isAIFraudEnabled()).toBe(false);

      // Cache expires, then a transient blip hits. Must keep the last-known-good
      // DB value (false), NOT jump to env=true.
      _expireAIFlagCache();
      mockFlagThrow(new Error('transient blip'));
      expect(await isAIFraudEnabled()).toBe(false);
    });

    it('prefers last-known-good DB value (true) over a blip — no false 503 storm', async () => {
      delete process.env.ENABLE_SEMANTIC_SEARCH;
      mockFlagQuery('ENABLE_SEMANTIC_SEARCH', true);
      expect(await isSemanticSearchEnabled()).toBe(true);

      _expireAIFlagCache();
      mockFlagThrow(new Error('transient blip'));
      // Last-known-good was true → keep serving rather than fail closed on a blip.
      expect(await isSemanticSearchEnabled()).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // ENABLE_AI_EXTRACTION is launch-required (CLAUDE.md §1.6 — default true in
  // prod). It is NOT a kill-switch, so a transient DB blip must keep its
  // launch default rather than blanket fail-closed to 503 the launch path.
  // ───────────────────────────────────────────────────────────────────────
  describe('SCRUM-2247 ENABLE_AI_EXTRACTION keeps launch default on a blip', () => {
    const originalEnv = { ...process.env };
    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('keeps launch default (env=true) when DB read throws (no false 503 on launch path)', async () => {
      process.env.ENABLE_AI_EXTRACTION = 'true';
      mockFlagThrow(new Error('transient blip'));
      expect(await isAIExtractionEnabled()).toBe(true);
    });

    it('still honors an explicit DB=false (admin disabled) over env=true', async () => {
      process.env.ENABLE_AI_EXTRACTION = 'true';
      mockFlagQuery('ENABLE_AI_EXTRACTION', false);
      expect(await isAIExtractionEnabled()).toBe(false);
    });

    it('prefers last-known-good DB value (false) over env on a subsequent blip', async () => {
      process.env.ENABLE_AI_EXTRACTION = 'true';
      mockFlagQuery('ENABLE_AI_EXTRACTION', false);
      expect(await isAIExtractionEnabled()).toBe(false);

      _expireAIFlagCache();
      mockFlagThrow(new Error('transient blip'));
      // Admin had turned it OFF; a blip must not silently re-enable via env.
      expect(await isAIExtractionEnabled()).toBe(false);
    });
  });
});
