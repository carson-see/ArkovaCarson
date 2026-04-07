/**
 * Hybrid Search Tests (NMT-SEARCH)
 *
 * Tests for BM25 + Dense retrieval with Reciprocal Rank Fusion.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock logger to prevent config loading (config requires env vars)
vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  reciprocalRankFusion,
  buildTsQuery,
  type SearchHit,
} from './hybrid-search.js';

describe('reciprocalRankFusion', () => {
  it('merges two ranked lists using RRF scoring', () => {
    const bm25: SearchHit[] = [
      { public_record_id: 'doc-a', score: 10 },
      { public_record_id: 'doc-b', score: 8 },
      { public_record_id: 'doc-c', score: 5 },
    ];
    const dense: SearchHit[] = [
      { public_record_id: 'doc-b', score: 0.95 },
      { public_record_id: 'doc-a', score: 0.88 },
      { public_record_id: 'doc-d', score: 0.72 },
    ];

    const results = reciprocalRankFusion(bm25, dense, 60, 10);

    // doc-a and doc-b appear in both lists → should have highest RRF scores
    expect(results.length).toBe(4);
    // doc-b: rank 2 in BM25 + rank 1 in dense → highest combined
    // doc-a: rank 1 in BM25 + rank 2 in dense → close second
    const topIds = results.slice(0, 2).map((r) => r.public_record_id);
    expect(topIds).toContain('doc-a');
    expect(topIds).toContain('doc-b');
  });

  it('handles documents appearing in only one list', () => {
    const bm25: SearchHit[] = [{ public_record_id: 'only-bm25', score: 5 }];
    const dense: SearchHit[] = [{ public_record_id: 'only-dense', score: 0.9 }];

    const results = reciprocalRankFusion(bm25, dense, 60, 10);

    expect(results.length).toBe(2);
    const bm25Result = results.find((r) => r.public_record_id === 'only-bm25');
    const denseResult = results.find((r) => r.public_record_id === 'only-dense');
    expect(bm25Result?.bm25_rank).toBe(1);
    expect(bm25Result?.dense_rank).toBeNull();
    expect(denseResult?.dense_rank).toBe(1);
    expect(denseResult?.bm25_rank).toBeNull();
  });

  it('respects topN limit', () => {
    const bm25: SearchHit[] = Array.from({ length: 20 }, (_, i) => ({
      public_record_id: `bm25-${i}`,
      score: 20 - i,
    }));
    const dense: SearchHit[] = Array.from({ length: 20 }, (_, i) => ({
      public_record_id: `dense-${i}`,
      score: 0.99 - i * 0.01,
    }));

    const results = reciprocalRankFusion(bm25, dense, 60, 5);
    expect(results.length).toBe(5);
  });

  it('handles empty lists', () => {
    expect(reciprocalRankFusion([], [], 60, 10)).toHaveLength(0);
    expect(reciprocalRankFusion([], [{ public_record_id: 'a', score: 1 }], 60, 10)).toHaveLength(1);
    expect(reciprocalRankFusion([{ public_record_id: 'a', score: 1 }], [], 60, 10)).toHaveLength(1);
  });

  it('documents in both lists score higher than single-list documents', () => {
    const bm25: SearchHit[] = [
      { public_record_id: 'both', score: 5 },
      { public_record_id: 'bm25-only', score: 10 }, // Higher BM25 score
    ];
    const dense: SearchHit[] = [
      { public_record_id: 'both', score: 0.7 },
      { public_record_id: 'dense-only', score: 0.99 }, // Higher dense score
    ];

    const results = reciprocalRankFusion(bm25, dense, 60, 10);
    // 'both' should be ranked first despite lower individual scores
    expect(results[0].public_record_id).toBe('both');
  });
});

describe('buildTsQuery', () => {
  it('converts natural language to Postgres tsquery format', () => {
    expect(buildTsQuery('FCRA adverse action notice')).toBe('fcra & adverse & action & notice');
  });

  it('strips stop words', () => {
    const result = buildTsQuery('what are the requirements for compliance');
    expect(result).not.toContain('what');
    expect(result).not.toContain('are');
    expect(result).not.toContain('the');
    expect(result).not.toContain('for');
    expect(result).toContain('requirements');
    expect(result).toContain('compliance');
  });

  it('handles special characters', () => {
    const result = buildTsQuery('SEC Rule 10b-5 (anti-fraud)');
    expect(result).not.toContain('(');
    expect(result).not.toContain(')');
    expect(result).toContain('sec');
    expect(result).toContain('rule');
    expect(result).toContain('10b-5');
  });

  it('handles empty/short input', () => {
    expect(buildTsQuery('a')).toBe('a'); // Falls through to raw query
    expect(buildTsQuery('  ')).toBe('');
  });
});
