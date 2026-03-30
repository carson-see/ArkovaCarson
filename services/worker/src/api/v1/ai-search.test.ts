/**
 * AI Semantic Search Endpoint Tests (P8-S12)
 *
 * TDD: Tests for GET /api/v1/ai/search.
 * No real API calls (Constitution 1.7).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../ai/factory.js', () => {
  const mockProvider = {
    name: 'mock',
    generateEmbedding: vi.fn().mockResolvedValue({
      embedding: new Array(768).fill(0.1),
      model: 'gemini-embedding-001',
    }),
  };
  return {
    createAIProvider: vi.fn().mockReturnValue(mockProvider),
    createEmbeddingProvider: vi.fn().mockReturnValue(mockProvider),
  };
});

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
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { org_id: 'org-123' },
            error: null,
          }),
        }),
        in: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({
            data: [
              {
                id: 'anchor-1',
                public_id: 'pub-1',
                filename: 'diploma.pdf',
                credential_type: 'DEGREE',
                metadata: { issuerName: 'Test University' },
                status: 'SECURED',
                created_at: '2025-01-01T00:00:00Z',
              },
            ],
            error: null,
          }),
        }),
      }),
    }),
    rpc: vi.fn().mockResolvedValue({
      data: [{ anchor_id: 'anchor-1', similarity: 0.92 }],
      error: null,
    }),
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// QA-PERF-6: passthrough mock — monitorQuery just delegates to the query fn
vi.mock('../../utils/queryMonitor.js', () => ({
  monitorQuery: async (_endpoint: string, queryFn: () => Promise<unknown>) => queryFn(),
  recordQueryMetric: vi.fn(),
}));

import { Request, Response } from 'express';
import { aiSearchRouter } from './ai-search.js';
import { checkAICredits } from '../../ai/cost-tracker.js';

function getHandler(method: string, path = '/') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stack = (aiSearchRouter as any).stack;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = stack.find((l: any) => l.route?.path === path && l.route?.methods?.[method]);
  return layer?.route?.stack[0].handle;
}

function createMockReqRes(query: Record<string, string> = {}, authUserId?: string) {
  const req = { authUserId, query, body: {}, method: 'GET', url: '/' } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return { req, res };
}

describe('GET /api/v1/ai/search', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns search results with similarity scores', async () => {
    const handler = getHandler('get');
    const { req, res } = createMockReqRes({ q: 'computer science degree' }, 'user-123');

    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'computer science degree',
        count: 1,
      }),
    );
  });

  it('returns 400 for missing query', async () => {
    const handler = getHandler('get');
    const { req, res } = createMockReqRes({}, 'user-123');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 401 without auth', async () => {
    const handler = getHandler('get');
    const { req, res } = createMockReqRes({ q: 'test' });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 402 when credits exhausted', async () => {
    vi.mocked(checkAICredits).mockResolvedValueOnce({
      monthlyAllocation: 50,
      usedThisMonth: 50,
      remaining: 0,
      hasCredits: false,
    });

    const handler = getHandler('get');
    const { req, res } = createMockReqRes({ q: 'test' }, 'user-123');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(402);
  });

  it('includes creditsRemaining in response', async () => {
    const handler = getHandler('get');
    const { req, res } = createMockReqRes({ q: 'test' }, 'user-123');

    await handler(req, res);

    const response = vi.mocked(res.json).mock.calls[0][0];
    expect(response.creditsRemaining).toBeDefined();
  });
});
