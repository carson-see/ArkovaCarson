import { describe, expect, it, vi } from 'vitest';
import {
  applyLexicalLeakagePolicy,
  canonicalManifestHash,
  compareEmbeddingLeakage,
  computeLexicalLeakageMetrics,
  scanEmbeddingLeakage,
  selectManifestSeededSample,
  type EmbeddingBatchProvider,
} from './s33-batch-acceptance.js';

describe('S3.3 batch acceptance — manifest-seeded sampling', () => {
  const ids = Array.from({ length: 81 }, (_, index) => `S33-${String(index + 1).padStart(3, '0')}`);

  it('canonicalizes object key order before hashing', () => {
    expect(canonicalManifestHash({ batchId: 'wave-1', revision: 2, counts: { ke: 11, au: 11 } }))
      .toBe(canonicalManifestHash({ counts: { au: 11, ke: 11 }, revision: 2, batchId: 'wave-1' }));
  });

  it('selects ceil(10%) of 81 entries, deterministically and without duplicates', () => {
    const manifest = { batchId: 's33-wave-1', revision: 2, entryCount: 81 };
    const first = selectManifestSeededSample(ids, manifest, { ratio: 0.1, minimum: 5 });
    const second = selectManifestSeededSample([...ids].reverse(), manifest, { ratio: 0.1, minimum: 5 });

    expect(first).toHaveLength(9);
    expect(new Set(first)).toHaveLength(9);
    expect(second).toEqual(first);
  });

  it('fails closed on an empty batch or duplicate entry ids', () => {
    expect(() => selectManifestSeededSample([], { batchId: 'empty' })).toThrow(/empty/i);
    expect(() => selectManifestSeededSample(['A', 'A'], { batchId: 'dupe' })).toThrow(/duplicate/i);
  });
});

describe('S3.3 batch acceptance — lexical leakage metrics', () => {
  const normalization = {
    unicodeForm: 'NFKC',
    caseFold: 'lowercase',
    nonAlphanumeric: 'space',
    whitespace: 'collapse',
  } as const;
  const heldout = {
    id: 'KE-001',
    text: 'Nursing Council registration certificate for a licensed practitioner in Nairobi County',
  };
  const corpus = {
    id: 'training-data/example.jsonl:4',
    text: 'A nursing council registration certificate for a licensed practitioner in Nairobi County was supplied',
  };

  it('emits auditable 6–13 token metrics without silently choosing a verdict threshold', () => {
    const metrics = computeLexicalLeakageMetrics(
      [heldout],
      [corpus],
      { minN: 6, maxN: 13, normalization },
    );

    expect(metrics.map((metric) => metric.n)).toEqual([6, 7, 8, 9, 10, 11, 12, 13]);
    expect(metrics[0]).toMatchObject({
      heldoutId: 'KE-001',
      corpusId: 'training-data/example.jsonl:4',
      n: 6,
      sharedNgrams: 6,
    });
    expect(metrics[0].heldoutContainment).toBe(1);
  });

  it('requires an explicit signed-policy shape to turn metrics into hits', () => {
    const metrics = computeLexicalLeakageMetrics(
      [heldout],
      [corpus],
      { minN: 6, maxN: 13, normalization },
    );

    const hits = applyLexicalLeakagePolicy(metrics, {
      allowedN: [6, 7, 8, 9, 10, 11, 12, 13],
      minimumSharedNgrams: 3,
      minimumHeldoutContainment: 0.5,
      combination: 'all',
    });
    expect(hits.some((hit) => hit.n === 6)).toBe(true);
    expect(() => applyLexicalLeakagePolicy(metrics, {
      allowedN: [],
      minimumSharedNgrams: 0,
      minimumHeldoutContainment: -1,
      combination: 'all',
    })).toThrow(/policy/i);
  });

  it('fails closed when the signed normalization policy is absent', () => {
    expect(() => computeLexicalLeakageMetrics(
      [heldout],
      [corpus],
      { minN: 6, maxN: 13 } as never,
    )).toThrow(/normalization/i);
  });

  it('refuses a lexical scan that omits any required n=6–13 metric', () => {
    expect(() => computeLexicalLeakageMetrics(
      [heldout],
      [corpus],
      { minN: 7, maxN: 13, normalization },
    )).toThrow(/6.*13/i);
  });
});

describe('S3.3 batch acceptance — embedding leakage', () => {
  it('compares only the explicitly pinned model and threshold', () => {
    const hits = compareEmbeddingLeakage(
      [{ id: 'held-1', model: 'gemini-embedding-test@001', vector: [1, 0] }],
      [
        { id: 'near', model: 'gemini-embedding-test@001', vector: [0.99, 0.01] },
        { id: 'far', model: 'gemini-embedding-test@001', vector: [0, 1] },
      ],
      { model: 'gemini-embedding-test@001', minimumCosineSimilarity: 0.95 },
    );

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ heldoutId: 'held-1', corpusId: 'near' });
    expect(hits[0].cosineSimilarity).toBeGreaterThan(0.99);
  });

  it('fails closed on model drift, malformed vectors, or missing vectors', () => {
    expect(() => compareEmbeddingLeakage(
      [{ id: 'held', model: 'model-a', vector: [1, 0] }],
      [{ id: 'corpus', model: 'model-b', vector: [1, 0] }],
      { model: 'model-a', minimumCosineSimilarity: 0.9 },
    )).toThrow(/model/i);
    expect(() => compareEmbeddingLeakage(
      [{ id: 'held', model: 'model-a', vector: [1, Number.NaN] }],
      [{ id: 'corpus', model: 'model-a', vector: [1, 0] }],
      { model: 'model-a', minimumCosineSimilarity: 0.9 },
    )).toThrow(/vector/i);
    expect(() => compareEmbeddingLeakage(
      [],
      [{ id: 'corpus', model: 'model-a', vector: [1, 0] }],
      { model: 'model-a', minimumCosineSimilarity: 0.9 },
    )).toThrow(/empty/i);
  });

  it('propagates provider failure and rejects incomplete embedding output', async () => {
    const failedProvider: EmbeddingBatchProvider = {
      embed: vi.fn().mockRejectedValue(new Error('provider unavailable')),
    };
    await expect(scanEmbeddingLeakage(
      [{ id: 'held', text: 'held text' }],
      [{ id: 'corpus', text: 'corpus text' }],
      failedProvider,
      { model: 'model-a', minimumCosineSimilarity: 0.9 },
    )).rejects.toThrow(/provider unavailable/i);

    const incompleteProvider: EmbeddingBatchProvider = {
      embed: vi.fn().mockResolvedValue([]),
    };
    await expect(scanEmbeddingLeakage(
      [{ id: 'held', text: 'held text' }],
      [{ id: 'corpus', text: 'corpus text' }],
      incompleteProvider,
      { model: 'model-a', minimumCosineSimilarity: 0.9 },
    )).rejects.toThrow(/count/i);
  });
});
