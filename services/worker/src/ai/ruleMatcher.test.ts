/**
 * Tests for ARK-109 semantic rule matcher pure layer.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  contentHashFor,
  cosineSimilarity,
  matchBySemantics,
  normalizeForHash,
  type EmbeddingCache,
  type Embedder,
} from './ruleMatcher.js';

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 10);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });

  it('is scale-invariant', () => {
    expect(cosineSimilarity([1, 1, 1], [2, 2, 2])).toBeCloseTo(1, 10);
  });

  it('returns 0 for a zero vector instead of NaN', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it('returns 0 on mismatched lengths (shared-fn contract)', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it('returns 0 on empty vectors (shared-fn contract)', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe('contentHashFor / normalizeForHash', () => {
  it('produces 64-char lowercase hex', () => {
    expect(contentHashFor('test')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('normalizes whitespace + case for cache reuse', () => {
    expect(contentHashFor('Match NDAs')).toBe(contentHashFor('  match   ndas  '));
  });

  it('NFC-normalizes Unicode', () => {
    // NFD é vs NFC é — same hash after normalization
    expect(contentHashFor('café')).toBe(contentHashFor('cafe\u0301'));
  });

  it('normalizeForHash strips inner whitespace runs', () => {
    expect(normalizeForHash('a  \t  b\nc')).toBe('a b c');
  });
});

describe('matchBySemantics', () => {
  function makeEmbedder(vector: (text: string) => number[]): Embedder {
    return {
      modelVersion: 'test-1',
      dimensions: 3,
      embed: vi.fn(async (t: string) => vector(t)),
    };
  }

  function makeCache(): EmbeddingCache & { store: Map<string, number[]> } {
    const store = new Map<string, number[]>();
    return {
      store,
      async get(h, v) {
        return store.get(`${h}:${v}`) ?? null;
      },
      async put(h, v, vec) {
        store.set(`${h}:${v}`, vec);
      },
    };
  }

  it('matches when cosine >= threshold', async () => {
    const embedder = makeEmbedder(() => [1, 0, 0]);
    const cache = makeCache();
    const r = await matchBySemantics(
      { ruleDescription: 'NDA', docText: 'contract.pdf', threshold: 0.5 },
      embedder,
      cache,
    );
    expect(r.matched).toBe(true);
    expect(r.score).toBeCloseTo(1, 10);
  });

  it('rejects when cosine < threshold', async () => {
    const embedder = makeEmbedder((t) => (t === 'NDA' ? [1, 0, 0] : [0, 1, 0]));
    const cache = makeCache();
    const r = await matchBySemantics(
      { ruleDescription: 'NDA', docText: 'unrelated', threshold: 0.5 },
      embedder,
      cache,
    );
    expect(r.matched).toBe(false);
    expect(r.nearMiss).toBe(false);
  });

  it('flags near-miss when score is within 0.05 of threshold', async () => {
    const embedder = makeEmbedder((t) =>
      t === 'NDA' ? [1, 0, 0] : [Math.cos(0.3), Math.sin(0.3), 0],
    );
    const cache = makeCache();
    const r = await matchBySemantics(
      { ruleDescription: 'NDA', docText: 'close', threshold: 0.97 },
      embedder,
      cache,
    );
    expect(r.matched).toBe(false);
    expect(r.nearMiss).toBe(true);
  });

  it('uses cache on a second call', async () => {
    const embedSpy = vi.fn(async () => [1, 0, 0]);
    const embedder: Embedder = { modelVersion: 'test-1', dimensions: 3, embed: embedSpy };
    const cache = makeCache();

    await matchBySemantics(
      { ruleDescription: 'x', docText: 'y', threshold: 0 },
      embedder,
      cache,
    );
    expect(embedSpy).toHaveBeenCalledTimes(2);

    await matchBySemantics(
      { ruleDescription: 'x', docText: 'y', threshold: 0 },
      embedder,
      cache,
    );
    // second call should be fully cached → no new embed calls
    expect(embedSpy).toHaveBeenCalledTimes(2);
  });

  it('reports cache hits per side', async () => {
    const embedder = makeEmbedder(() => [1, 0, 0]);
    const cache = makeCache();
    // Seed rule cache
    await cache.put(contentHashFor('rule'), embedder.modelVersion, [1, 0, 0]);
    const r = await matchBySemantics(
      { ruleDescription: 'rule', docText: 'doc', threshold: 0 },
      embedder,
      cache,
    );
    expect(r.cacheHits.description).toBe(true);
    expect(r.cacheHits.document).toBe(false);
  });
});
