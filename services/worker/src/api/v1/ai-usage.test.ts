/**
 * Tests for AI Usage Endpoint (P8-S2)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/db.js', () => ({
  db: {
    from: vi.fn(),
    rpc: vi.fn(),
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

import { db } from '../../utils/db.js';
import { Request, Response } from 'express';

// Import the router to get the handler
import { aiUsageRouter } from './ai-usage.js';

function createMockReqRes(authUserId?: string) {
  const req = {
    authUserId: authUserId,
    method: 'GET',
    url: '/',
  } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return { req, res };
}

describe('AI Usage Endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when not authenticated', async () => {
    const { req, res } = createMockReqRes();

    // Extract the GET handler from the router
    const layer = (aiUsageRouter as { stack: Array<{ route?: { methods: { get: boolean }; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack
      .find((l) => l.route?.methods?.get);
    const handler = layer?.route?.stack[0].handle;

    if (handler) {
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
    }
  });

  it('returns credit balance and usage events', async () => {
    const { req, res } = createMockReqRes('user-123');

    // Mock profile lookup
    const profileMock = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { org_id: 'org-456' },
        error: null,
      }),
    };

    // Mock usage events query
    const usageMock = {
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({
        data: [
          { event_type: 'extraction', provider: 'gemini', credits_consumed: 1, success: true, created_at: '2026-03-15' },
        ],
        error: null,
      }),
    };

    (db.from as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(profileMock)  // profiles query
      .mockReturnValueOnce(usageMock);   // ai_usage_events query

    // Mock RPC for credit check
    (db.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [{
        monthly_allocation: 500,
        used_this_month: 10,
        remaining: 490,
        has_credits: true,
      }],
      error: null,
    });

    const layer = (aiUsageRouter as { stack: Array<{ route?: { methods: { get: boolean }; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack
      .find((l) => l.route?.methods?.get);
    const handler = layer?.route?.stack[0].handle;

    if (handler) {
      await handler(req, res);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          credits: expect.objectContaining({
            monthlyAllocation: 500,
            remaining: 490,
            hasCredits: true,
          }),
          recentEvents: expect.any(Array),
        }),
      );
    }
  });
});
