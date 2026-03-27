/**
 * Agentic Verification Search Tests (P8-S19)
 *
 * TDD: Tests for GET /api/v1/verify/search.
 * No real API calls (Constitution 1.7).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../ai/factory.js', () => ({
  createAIProvider: vi.fn().mockReturnValue({
    name: 'mock',
    generateEmbedding: vi.fn().mockResolvedValue({
      embedding: new Array(768).fill(0.1),
      model: 'gemini-embedding-001',
    }),
  }),
}));

vi.mock('../../ai/cost-tracker.js', () => ({
  checkAICredits: vi.fn().mockResolvedValue({
    monthlyAllocation: 500,
    usedThisMonth: 10,
    remaining: 490,
    hasCredits: true,
  }),
  deductAICredits: vi.fn().mockResolvedValue(true),
  logAIUsageEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../utils/db.js', () => ({
  db: {
    rpc: vi.fn().mockResolvedValue({
      data: [
        {
          public_id: 'pub-123',
          status: 'SECURED',
          issuer_name: 'University of Michigan',
          credential_type: 'DEGREE',
          issued_date: '2025-06-15',
          expiry_date: null,
          anchor_timestamp: '2025-07-01T00:00:00Z',
          similarity: 0.88,
        },
      ],
      error: null,
    }),
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { Request, Response } from 'express';
import { aiVerifySearchRouter } from './ai-verify-search.js';
import { db } from '../../utils/db.js';

function getHandler(method: string, path = '/') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stack = (aiVerifySearchRouter as any).stack;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = stack.find((l: any) => l.route?.path === path && l.route?.methods?.[method]);
  return layer?.route?.stack[0].handle;
}

function createMockReqRes(
  query: Record<string, string> = {},
  apiKey?: { keyId: string; orgId: string; scopes: string[]; rateLimitTier: string; keyPrefix: string },
) {
  const req = {
    apiKey,
    query,
    body: {},
    method: 'GET',
    url: '/',
  } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return { req, res };
}

const mockApiKey = {
  keyId: 'key-123',
  orgId: 'org-456',
  scopes: ['verify'],
  rateLimitTier: 'paid' as const,
  keyPrefix: 'ak_test',
};

describe('GET /api/v1/verify/search', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns verification results in frozen schema format', async () => {
    const handler = getHandler('get');
    const { req, res } = createMockReqRes(
      { q: 'bachelor computer science michigan' },
      mockApiKey,
    );

    await handler(req, res);

    const response = vi.mocked(res.json).mock.calls[0][0];
    expect(response.results).toHaveLength(1);
    expect(response.results[0]).toEqual(
      expect.objectContaining({
        verified: true,
        status: 'SECURED',
        issuer_name: 'University of Michigan',
        record_uri: 'https://app.arkova.io/verify/pub-123',
      }),
    );
  });

  it('returns 401 without API key', async () => {
    const handler = getHandler('get');
    const { req, res } = createMockReqRes({ q: 'test' });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 400 for missing query', async () => {
    const handler = getHandler('get');
    const { req, res } = createMockReqRes({}, mockApiKey);

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns empty results gracefully', async () => {
    vi.mocked(db.rpc).mockResolvedValueOnce({ data: [], error: null } as never);

    const handler = getHandler('get');
    const { req, res } = createMockReqRes({ q: 'nonexistent' }, mockApiKey);

    await handler(req, res);

    const response = vi.mocked(res.json).mock.calls[0][0];
    expect(response.results).toHaveLength(0);
  });

  it('handles missing RPC gracefully', async () => {
    vi.mocked(db.rpc).mockResolvedValueOnce({
      data: null,
      error: { code: '42883', message: 'function not found' },
    } as never);

    const handler = getHandler('get');
    const { req, res } = createMockReqRes({ q: 'test' }, mockApiKey);

    await handler(req, res);

    const response = vi.mocked(res.json).mock.calls[0][0];
    expect(response.results).toHaveLength(0);
  });
});
