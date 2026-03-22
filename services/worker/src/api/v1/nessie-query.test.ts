/**
 * Nessie RAG Query Endpoint Tests (PH1-INT-02 + PH1-INT-03)
 *
 * TDD: Tests for GET /api/v1/nessie/query — basic retrieval and verified context mode.
 * No real API calls (Constitution 1.7).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted — cannot reference outer variables.
// Use vi.hoisted() to safely share mock fns.
const { mockGenerateEmbedding, mockGenerateContent, mockRpc, mockFrom } = vi.hoisted(() => ({
  mockGenerateEmbedding: vi.fn(),
  mockGenerateContent: vi.fn(),
  mockRpc: vi.fn(),
  mockFrom: vi.fn(),
}));

vi.mock('../../ai/factory.js', () => ({
  createAIProvider: vi.fn().mockReturnValue({
    name: 'mock',
    generateEmbedding: mockGenerateEmbedding,
  }),
}));

vi.mock('../../utils/db.js', () => ({
  db: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (...args: unknown[]) => mockFrom(...args),
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('@google/generative-ai', () => {
  return {
    GoogleGenerativeAI: class MockGoogleGenerativeAI {
      getGenerativeModel() {
        return { generateContent: mockGenerateContent };
      }
    },
  };
});

import express from 'express';
import request from 'supertest';
import { nessieQueryRouter } from './nessie-query.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/nessie/query', nessieQueryRouter);
  return app;
}

const MOCK_RECORDS = [
  {
    id: 'rec-1',
    source: 'edgar',
    source_url: 'https://sec.gov/filing/123',
    record_type: '10-K',
    title: 'Apple Inc Annual Report',
    content_hash: 'abc123',
    metadata: {
      chain_tx_id: 'tx-abc',
      merkle_root: 'root-abc',
      merkle_proof: ['proof1', 'proof2'],
      anchored_at: '2026-01-01T00:00:00Z',
      abstract: 'Annual report for fiscal year 2025',
    },
    anchor_id: 'anchor-1',
  },
  {
    id: 'rec-2',
    source: 'uspto',
    source_url: 'https://patents.google.com/patent/US123',
    record_type: 'patent_grant',
    title: 'Machine Learning Patent',
    content_hash: 'def456',
    metadata: {
      abstract: 'A method for improved neural network training',
    },
    anchor_id: null,
  },
];

describe('GET /nessie/query', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Set GEMINI_API_KEY for context mode tests
    process.env.GEMINI_API_KEY = 'test-key';

    // Default embedding mock
    mockGenerateEmbedding.mockResolvedValue({
      embedding: new Array(768).fill(0.1),
      model: 'text-embedding-004',
    });

    // Default: feature flag enabled + search results
    mockRpc.mockImplementation((name: string) => {
      if (name === 'get_flag') {
        return Promise.resolve({ data: true, error: null });
      }
      if (name === 'search_public_record_embeddings') {
        return Promise.resolve({
          data: [
            { public_record_id: 'rec-1', similarity: 0.92 },
            { public_record_id: 'rec-2', similarity: 0.78 },
          ],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        in: vi.fn().mockResolvedValue({
          data: MOCK_RECORDS,
          error: null,
        }),
      }),
    });
  });

  it('returns 400 if query is missing', async () => {
    const app = buildApp();
    const res = await request(app).get('/nessie/query');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
  });

  it('returns 503 if feature flag is disabled', async () => {
    mockRpc.mockImplementation((name: string) => {
      if (name === 'get_flag') return Promise.resolve({ data: false, error: null });
      return Promise.resolve({ data: null, error: null });
    });

    const app = buildApp();
    const res = await request(app).get('/nessie/query?q=test');
    expect(res.status).toBe(503);
  });

  it('returns results with anchor proofs in default (retrieval) mode', async () => {
    const app = buildApp();
    const res = await request(app).get('/nessie/query?q=apple+annual+report');

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[0].anchor_proof).toBeTruthy();
    expect(res.body.results[0].anchor_proof.chain_tx_id).toBe('tx-abc');
    expect(res.body.results[1].anchor_proof).toBeNull();
    expect(res.body.count).toBe(2);
  });

  it('returns empty results when no matches found', async () => {
    mockRpc.mockImplementation((name: string) => {
      if (name === 'get_flag') return Promise.resolve({ data: true, error: null });
      if (name === 'search_public_record_embeddings') {
        return Promise.resolve({ data: [], error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });

    const app = buildApp();
    const res = await request(app).get('/nessie/query?q=nonexistent');
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(0);
  });

  // PH1-INT-03: Verified context mode
  describe('mode=context (Gemini RAG)', () => {
    beforeEach(() => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => JSON.stringify({
            answer: 'Apple Inc reported strong financials in their 2025 annual report.',
            citations: [
              {
                record_id: 'rec-1',
                source: 'edgar',
                source_url: 'https://sec.gov/filing/123',
                title: 'Apple Inc Annual Report',
                relevance_score: 0.92,
                anchor_proof: {
                  chain_tx_id: 'tx-abc',
                  content_hash: 'abc123',
                },
                excerpt: 'Annual report for fiscal year 2025',
              },
            ],
            confidence: 0.88,
          }),
          usageMetadata: { totalTokenCount: 450 },
        },
      });
    });

    it('returns synthesized answer with citations when mode=context', async () => {
      const app = buildApp();
      const res = await request(app).get('/nessie/query?q=apple+financials&mode=context');

      expect(res.status).toBe(200);
      expect(res.body.answer).toBeDefined();
      expect(res.body.citations).toBeDefined();
      expect(res.body.citations.length).toBeGreaterThan(0);
      expect(res.body.confidence).toBeDefined();
      expect(res.body.query).toBe('apple financials');
    });

    it('includes anchor proofs in citations', async () => {
      const app = buildApp();
      const res = await request(app).get('/nessie/query?q=apple+report&mode=context');

      expect(res.status).toBe(200);
      const citation = res.body.citations[0];
      expect(citation.anchor_proof).toBeDefined();
      expect(citation.anchor_proof.chain_tx_id).toBe('tx-abc');
    });

    it('falls back to retrieval-only when no docs found for context mode', async () => {
      mockRpc.mockImplementation((name: string) => {
        if (name === 'get_flag') return Promise.resolve({ data: true, error: null });
        if (name === 'search_public_record_embeddings') {
          return Promise.resolve({ data: [], error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });

      const app = buildApp();
      const res = await request(app).get('/nessie/query?q=nothing&mode=context');
      expect(res.status).toBe(200);
      expect(res.body.answer).toBeDefined();
      expect(res.body.citations).toHaveLength(0);
    });

    it('falls back to retrieval mode when Gemini fails', async () => {
      mockGenerateContent.mockRejectedValue(new Error('Gemini unavailable'));

      const app = buildApp();
      const res = await request(app).get('/nessie/query?q=apple+report&mode=context');

      expect(res.status).toBe(200);
      expect(res.body.results).toBeDefined();
      expect(res.body.fallback).toBe(true);
    });
  });
});
