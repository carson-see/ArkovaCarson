/**
 * Tests for Usage Tracking Middleware (P4.5-TS-05)
 *
 * Verifies monthly quota enforcement for free tier (10K/month)
 * and usage tracking with response headers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getCurrentMonth,
  getNextResetDate,
  getCurrentUsage,
  usageTracking,
} from './usageTracking.js';
import type { Request, Response, NextFunction } from 'express';

// Mock DB + logger
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

function createMockReqRes(apiKey?: {
  keyId: string;
  orgId: string;
  scopes: string[];
  rateLimitTier: 'free' | 'paid' | 'custom';
  keyPrefix: string;
}) {
  const req = { apiKey } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as unknown as Response;
  const next = vi.fn() as NextFunction;
  return { req, res, next };
}

describe('getCurrentMonth', () => {
  it('returns YYYY-MM format', () => {
    const month = getCurrentMonth();
    expect(month).toMatch(/^\d{4}-\d{2}$/);
  });
});

describe('getNextResetDate', () => {
  it('returns an ISO date string', () => {
    const reset = getNextResetDate();
    expect(new Date(reset).toISOString()).toBe(reset);
  });

  it('returns the first day of the next month', () => {
    const reset = new Date(getNextResetDate());
    expect(reset.getUTCDate()).toBe(1);
  });
});

describe('usageTracking middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips tracking for anonymous requests (no apiKey)', async () => {
    const { req, res, next } = createMockReqRes(undefined);

    const middleware = usageTracking();
    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('sets quota headers for authenticated requests', async () => {
    // Mock getCurrentUsage to return 50
    const maybeSingleMock = vi.fn().mockResolvedValue({
      data: { request_count: 50 },
      error: null,
    });
    const eqMonthMock = vi.fn().mockReturnValue({ maybeSingle: maybeSingleMock });
    const eqKeyMock = vi.fn().mockReturnValue({ eq: eqMonthMock });
    const selectMock = vi.fn().mockReturnValue({ eq: eqKeyMock });

    // Mock incrementUsage upsert
    const upsertSingleMock = vi.fn().mockResolvedValue({
      data: { request_count: 51 },
      error: null,
    });
    const upsertSelectMock = vi.fn().mockReturnValue({ single: upsertSingleMock });
    const upsertMock = vi.fn().mockReturnValue({ select: upsertSelectMock });

    (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
      select: selectMock,
      upsert: upsertMock,
    });

    const { req, res, next } = createMockReqRes({
      keyId: 'key-1',
      orgId: 'org-1',
      scopes: ['verify'],
      rateLimitTier: 'free',
      keyPrefix: 'ak_live_xxx',
    });

    const middleware = usageTracking();
    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('X-Quota-Used', '50');
    expect(res.setHeader).toHaveBeenCalledWith('X-Quota-Limit', '10000');
    expect(res.setHeader).toHaveBeenCalledWith(
      'X-Quota-Reset',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    );
  });

  it('returns 429 when free tier quota is exceeded', async () => {
    // Mock getCurrentUsage to return 10000 (at limit)
    const maybeSingleMock = vi.fn().mockResolvedValue({
      data: { request_count: 10000 },
      error: null,
    });
    const eqMonthMock = vi.fn().mockReturnValue({ maybeSingle: maybeSingleMock });
    const eqKeyMock = vi.fn().mockReturnValue({ eq: eqMonthMock });
    const selectMock = vi.fn().mockReturnValue({ eq: eqKeyMock });

    (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
      select: selectMock,
    });

    const { req, res, next } = createMockReqRes({
      keyId: 'key-1',
      orgId: 'org-1',
      scopes: ['verify'],
      rateLimitTier: 'free',
      keyPrefix: 'ak_live_xxx',
    });

    const middleware = usageTracking();
    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'quota_exceeded',
        limit: 10000,
        upgrade_url: '/pricing',
      }),
    );
  });

  it('allows paid tier to exceed free quota', async () => {
    // Mock getCurrentUsage to return 50000 (over free limit)
    const maybeSingleMock = vi.fn().mockResolvedValue({
      data: { request_count: 50000 },
      error: null,
    });
    const eqMonthMock = vi.fn().mockReturnValue({ maybeSingle: maybeSingleMock });
    const eqKeyMock = vi.fn().mockReturnValue({ eq: eqMonthMock });
    const selectMock = vi.fn().mockReturnValue({ eq: eqKeyMock });

    const upsertSingleMock = vi.fn().mockResolvedValue({
      data: { request_count: 50001 },
      error: null,
    });
    const upsertSelectMock = vi.fn().mockReturnValue({ single: upsertSingleMock });
    const upsertMock = vi.fn().mockReturnValue({ select: upsertSelectMock });

    (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
      select: selectMock,
      upsert: upsertMock,
    });

    const { req, res, next } = createMockReqRes({
      keyId: 'key-2',
      orgId: 'org-2',
      scopes: ['verify'],
      rateLimitTier: 'paid',
      keyPrefix: 'ak_live_yyy',
    });

    const middleware = usageTracking();
    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('X-Quota-Limit', 'unlimited');
  });

  it('sets quota headers even when quota is exceeded', async () => {
    const maybeSingleMock = vi.fn().mockResolvedValue({
      data: { request_count: 10001 },
      error: null,
    });
    const eqMonthMock = vi.fn().mockReturnValue({ maybeSingle: maybeSingleMock });
    const eqKeyMock = vi.fn().mockReturnValue({ eq: eqMonthMock });
    const selectMock = vi.fn().mockReturnValue({ eq: eqKeyMock });

    (db.from as ReturnType<typeof vi.fn>).mockReturnValue({ select: selectMock });

    const { req, res, next } = createMockReqRes({
      keyId: 'key-1',
      orgId: 'org-1',
      scopes: ['verify'],
      rateLimitTier: 'free',
      keyPrefix: 'ak_live_xxx',
    });

    const middleware = usageTracking();
    await middleware(req, res, next);

    // Headers should still be set even on 429
    expect(res.setHeader).toHaveBeenCalledWith('X-Quota-Used', '10001');
    expect(res.setHeader).toHaveBeenCalledWith('X-Quota-Limit', '10000');
    expect(res.status).toHaveBeenCalledWith(429);
  });
});

describe('getCurrentUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 0 when no usage record exists', async () => {
    const maybeSingleMock = vi.fn().mockResolvedValue({ data: null, error: null });
    const eqMonthMock = vi.fn().mockReturnValue({ maybeSingle: maybeSingleMock });
    const eqKeyMock = vi.fn().mockReturnValue({ eq: eqMonthMock });
    const selectMock = vi.fn().mockReturnValue({ eq: eqKeyMock });
    (db.from as ReturnType<typeof vi.fn>).mockReturnValue({ select: selectMock });

    const usage = await getCurrentUsage('key-new');
    expect(usage).toBe(0);
  });

  it('returns the stored count', async () => {
    const maybeSingleMock = vi.fn().mockResolvedValue({
      data: { request_count: 4200 },
      error: null,
    });
    const eqMonthMock = vi.fn().mockReturnValue({ maybeSingle: maybeSingleMock });
    const eqKeyMock = vi.fn().mockReturnValue({ eq: eqMonthMock });
    const selectMock = vi.fn().mockReturnValue({ eq: eqKeyMock });
    (db.from as ReturnType<typeof vi.fn>).mockReturnValue({ select: selectMock });

    const usage = await getCurrentUsage('key-existing');
    expect(usage).toBe(4200);
  });

  it('returns 0 on DB error', async () => {
    (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockRejectedValue(new Error('DB down')),
          }),
        }),
      }),
    });

    const usage = await getCurrentUsage('key-error');
    expect(usage).toBe(0);
  });
});
