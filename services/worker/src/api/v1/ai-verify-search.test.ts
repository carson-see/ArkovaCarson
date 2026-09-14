/**
 * Agentic Verification Search Tests (P8-S19 / SCRUM-3906)
 *
 * TDD: Tests for GET /api/v1/verify/search.
 * No real API calls (Constitution 1.7).
 *
 * SCRUM-3906: this route used to sit behind `aiSemanticSearchGate()` at the
 * router mount, so with ENABLE_SEMANTIC_SEARCH off (prod default) every
 * call 503'd — including every direct API-key caller. The route now owns
 * its own lexical fallback (mirroring the edge's `search_public_credentials`
 * path) instead of hard-failing. `search_mode` on the response distinguishes
 * the two paths; see ai-verify-search.ts for the full contract.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// generateEmbedding is a named mock so beforeEach can reset+reconfigure it
// directly — mockReturnValueOnce/mockRejectedValueOnce queued on it (or on
// db.rpc, checkAICredits, isSemanticSearchEnabled below) leak into the NEXT
// test whenever a test's control flow short-circuits before the queued call
// happens (e.g. the 401-before-API-key-check path never reaches
// isSemanticSearchEnabled). vi.resetAllMocks() in beforeEach clears every
// queue; every default below is then reapplied fresh each test.
const mockGenerateEmbedding = vi.fn();

vi.mock('../../ai/factory.js', () => ({
  createAIProvider: vi.fn(() => ({ name: 'mock', generateEmbedding: mockGenerateEmbedding })),
}));

vi.mock('../../ai/cost-tracker.js', () => ({
  checkAICredits: vi.fn(),
  deductAICredits: vi.fn(),
  logAIUsageEvent: vi.fn(),
}));

vi.mock('../../middleware/aiFeatureGate.js', () => ({
  isSemanticSearchEnabled: vi.fn(),
}));

vi.mock('../../utils/db.js', () => ({
  db: { rpc: vi.fn() },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config.js', () => ({
  config: { frontendUrl: 'https://app.arkova.ai' },
}));

import { Request, Response } from 'express';
import { aiVerifySearchRouter, SEARCH_MODE_SEMANTIC, SEARCH_MODE_LEXICAL } from './ai-verify-search.js';
import { db } from '../../utils/db.js';
import { checkAICredits, deductAICredits, logAIUsageEvent } from '../../ai/cost-tracker.js';
import { isSemanticSearchEnabled } from '../../middleware/aiFeatureGate.js';
import { logger } from '../../utils/logger.js';

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

const lexicalRow = {
  public_id: 'pub-lex-1',
  title: 'transcript.pdf',
  credential_type: 'TRANSCRIPT',
  status: 'SECURED',
  created_at: '2026-01-01T00:00:00Z',
  org_id: 'org-should-never-leak',
};

describe('GET /api/v1/verify/search', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGenerateEmbedding.mockResolvedValue({
      embedding: new Array(768).fill(0.1),
      model: 'text-embedding-004',
    });
    vi.mocked(isSemanticSearchEnabled).mockResolvedValue(true);
    vi.mocked(checkAICredits).mockResolvedValue({
      monthlyAllocation: 500,
      usedThisMonth: 10,
      remaining: 490,
      hasCredits: true,
    } as never);
    vi.mocked(deductAICredits).mockResolvedValue(true as never);
    vi.mocked(logAIUsageEvent).mockResolvedValue(undefined);
    vi.mocked(db.rpc).mockResolvedValue({
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
    } as never);
  });

  describe('semantic path (ENABLE_SEMANTIC_SEARCH on, RPC healthy)', () => {
    it('returns verification results in frozen schema format, labelled semantic_vector', async () => {
      const handler = getHandler('get');
      const { req, res } = createMockReqRes(
        { q: 'bachelor computer science michigan' },
        mockApiKey,
      );

      await handler(req, res);

      const response = vi.mocked(res.json).mock.calls[0][0];
      expect(response.search_mode).toBe(SEARCH_MODE_SEMANTIC);
      expect(response.results).toHaveLength(1);
      expect(response.results[0]).toEqual(
        expect.objectContaining({
          verified: true,
          status: 'SECURED',
          issuer_name: 'University of Michigan',
          record_uri: 'https://app.arkova.ai/verify/pub-123',
        }),
      );
      expect(deductAICredits).toHaveBeenCalledWith('org-456', undefined, 1);
      expect(logAIUsageEvent).toHaveBeenCalled();
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

    it('a zero-hit semantic response stays semantic (real answer, not a failure)', async () => {
      vi.mocked(db.rpc).mockResolvedValueOnce({ data: [], error: null } as never);

      const handler = getHandler('get');
      const { req, res } = createMockReqRes({ q: 'nonexistent' }, mockApiKey);

      await handler(req, res);

      const response = vi.mocked(res.json).mock.calls[0][0];
      expect(response.search_mode).toBe(SEARCH_MODE_SEMANTIC);
      expect(response.results).toHaveLength(0);
    });

    it('returns 402 insufficient_credits without attempting the RPC', async () => {
      vi.mocked(checkAICredits).mockResolvedValueOnce({
        monthlyAllocation: 10,
        usedThisMonth: 10,
        remaining: 0,
        hasCredits: false,
      } as never);

      const handler = getHandler('get');
      const { req, res } = createMockReqRes({ q: 'test' }, mockApiKey);

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(402);
      expect(db.rpc).not.toHaveBeenCalled();
    });
  });

  describe('lexical fallback — ENABLE_SEMANTIC_SEARCH off (SCRUM-3906 core fix)', () => {
    it('returns 200 with lexical results instead of 503, labelled lexical_substring', async () => {
      vi.mocked(isSemanticSearchEnabled).mockResolvedValueOnce(false);
      vi.mocked(db.rpc).mockResolvedValueOnce({ data: [lexicalRow], error: null } as never);

      const handler = getHandler('get');
      const { req, res } = createMockReqRes({ q: 'transcript' }, mockApiKey);

      await handler(req, res);

      expect(res.status).not.toHaveBeenCalledWith(503);
      const response = vi.mocked(res.json).mock.calls[0][0];
      expect(response.search_mode).toBe(SEARCH_MODE_LEXICAL);
      expect(response.results).toHaveLength(1);
      expect(response.results[0]).toEqual({
        verified: true,
        status: 'SECURED',
        credential_type: 'TRANSCRIPT',
        record_uri: 'https://app.arkova.ai/verify/pub-lex-1',
      });
    });

    it('calls search_public_credentials, never search_public_credential_embeddings', async () => {
      vi.mocked(isSemanticSearchEnabled).mockResolvedValueOnce(false);
      vi.mocked(db.rpc).mockResolvedValueOnce({ data: [lexicalRow], error: null } as never);

      const handler = getHandler('get');
      const { req, res } = createMockReqRes({ q: 'transcript' }, mockApiKey);

      await handler(req, res);

      expect(db.rpc).toHaveBeenCalledTimes(1);
      expect(db.rpc).toHaveBeenCalledWith(
        'search_public_credentials',
        expect.objectContaining({ p_query: 'transcript' }),
      );
    });

    it('never leaks org_id (§6) — response contains no internal ids', async () => {
      vi.mocked(isSemanticSearchEnabled).mockResolvedValueOnce(false);
      vi.mocked(db.rpc).mockResolvedValueOnce({ data: [lexicalRow], error: null } as never);

      const handler = getHandler('get');
      const { req, res } = createMockReqRes({ q: 'transcript' }, mockApiKey);

      await handler(req, res);

      const response = vi.mocked(res.json).mock.calls[0][0];
      const serialized = JSON.stringify(response);
      expect(serialized).not.toContain('org_id');
      expect(serialized).not.toContain('org-should-never-leak');
      for (const key of Object.keys(response.results[0])) {
        expect(['verified', 'status', 'credential_type', 'record_uri', 'issuer_name', 'issued_date', 'expiry_date', 'anchor_timestamp', 'similarity']).toContain(key);
      }
    });

    it('never checks or deducts AI credits on the lexical path', async () => {
      vi.mocked(isSemanticSearchEnabled).mockResolvedValueOnce(false);
      vi.mocked(db.rpc).mockResolvedValueOnce({ data: [], error: null } as never);

      const handler = getHandler('get');
      const { req, res } = createMockReqRes({ q: 'transcript' }, mockApiKey);

      await handler(req, res);

      expect(checkAICredits).not.toHaveBeenCalled();
      expect(deductAICredits).not.toHaveBeenCalled();
      expect(logAIUsageEvent).not.toHaveBeenCalled();
    });

    it('logs a bounded warn reason for the flag-off fallback (never silent)', async () => {
      vi.mocked(isSemanticSearchEnabled).mockResolvedValueOnce(false);
      vi.mocked(db.rpc).mockResolvedValueOnce({ data: [], error: null } as never);

      const handler = getHandler('get');
      const { req, res } = createMockReqRes({ q: 'transcript' }, mockApiKey);

      await handler(req, res);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'semantic_search_disabled' }),
        expect.any(String),
      );
    });

    it('still 401s without an API key even when semantic is off', async () => {
      vi.mocked(isSemanticSearchEnabled).mockResolvedValueOnce(false);

      const handler = getHandler('get');
      const { req, res } = createMockReqRes({ q: 'test' });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(db.rpc).not.toHaveBeenCalled();
    });
  });

  describe('semantic RPC / embedding failure falls back to lexical (SCRUM-3906)', () => {
    it('embedding provider throwing falls back to lexical, logged at warn', async () => {
      mockGenerateEmbedding.mockRejectedValueOnce(new Error('provider unavailable'));
      vi.mocked(db.rpc).mockResolvedValueOnce({ data: [lexicalRow], error: null } as never);

      const handler = getHandler('get');
      const { req, res } = createMockReqRes({ q: 'transcript' }, mockApiKey);

      await handler(req, res);

      const response = vi.mocked(res.json).mock.calls[0][0];
      expect(response.search_mode).toBe(SEARCH_MODE_LEXICAL);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'embedding_failed' }),
        expect.any(String),
      );
      expect(deductAICredits).not.toHaveBeenCalled();
    });

    it('embedding provider hanging (never resolving) falls back to lexical within the bounded timeout, not indefinitely', async () => {
      vi.useFakeTimers();
      try {
        // Never resolves or rejects — simulates a stalled connection to the
        // provider. generateEmbedding()'s underlying fetch carries no
        // AbortSignal (unlike the batch generateEmbeddings()), so without a
        // route-level bound this would hold the request open forever.
        mockGenerateEmbedding.mockReturnValueOnce(new Promise(() => {}));
        vi.mocked(db.rpc).mockResolvedValueOnce({ data: [lexicalRow], error: null } as never);

        const handler = getHandler('get');
        const { req, res } = createMockReqRes({ q: 'transcript' }, mockApiKey);

        const handlerDone = handler(req, res);
        await vi.advanceTimersByTimeAsync(8_000);
        await handlerDone;

        const response = vi.mocked(res.json).mock.calls[0][0];
        expect(response.search_mode).toBe(SEARCH_MODE_LEXICAL);
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'embedding_failed' }),
          expect.any(String),
        );
        expect(deductAICredits).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('search_public_credential_embeddings RPC error falls back to lexical (any error code, not just 42883)', async () => {
      vi.mocked(db.rpc)
        .mockResolvedValueOnce({
          data: null,
          error: { code: '57014', message: 'statement timeout' },
        } as never)
        .mockResolvedValueOnce({ data: [lexicalRow], error: null } as never);

      const handler = getHandler('get');
      const { req, res } = createMockReqRes({ q: 'transcript' }, mockApiKey);

      await handler(req, res);

      const response = vi.mocked(res.json).mock.calls[0][0];
      expect(response.search_mode).toBe(SEARCH_MODE_LEXICAL);
      expect(response.results).toHaveLength(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'embedding_rpc_error', code: '57014' }),
        expect.any(String),
      );
      expect(deductAICredits).not.toHaveBeenCalled();
    });

    it('handles the RPC-not-found case (42883) via the same fallback path', async () => {
      vi.mocked(db.rpc)
        .mockResolvedValueOnce({
          data: null,
          error: { code: '42883', message: 'function not found' },
        } as never)
        .mockResolvedValueOnce({ data: [], error: null } as never);

      const handler = getHandler('get');
      const { req, res } = createMockReqRes({ q: 'test' }, mockApiKey);

      await handler(req, res);

      const response = vi.mocked(res.json).mock.calls[0][0];
      expect(response.search_mode).toBe(SEARCH_MODE_LEXICAL);
      expect(response.results).toHaveLength(0);
    });

    it('lexical RPC also failing returns 500 search_failed (no fabricated empty 200)', async () => {
      vi.mocked(isSemanticSearchEnabled).mockResolvedValueOnce(false);
      vi.mocked(db.rpc).mockResolvedValueOnce({
        data: null,
        error: { code: '57014', message: 'statement timeout' },
      } as never);

      const handler = getHandler('get');
      const { req, res } = createMockReqRes({ q: 'test' }, mockApiKey);

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      const response = vi.mocked(res.json).mock.calls[0][0];
      expect(response.error).toBe('search_failed');
    });
  });
});
