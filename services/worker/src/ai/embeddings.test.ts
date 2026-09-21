/**
 * Embedding Service Tests (P8-S11)
 *
 * TDD: Tests written first, then implementation.
 * Uses MockAIProvider — no real API calls (Constitution 1.7).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IAIProvider, EmbeddingResult } from './types.js';

const mockDb = vi.hoisted(() => {
  const credentialEmbeddingSnapshotFilter = vi.fn().mockResolvedValue({
    data: [],
    error: null,
  });
  const credentialEmbeddingSingle = vi.fn().mockResolvedValue({
    data: { org_id: 'org-123', metadata: { issuerName: 'Test University' } },
    error: null,
  });
  const credentialEmbeddingEq = vi.fn().mockReturnValue({
    single: credentialEmbeddingSingle,
  });
  const credentialEmbeddingDeleteFilter = vi.fn().mockResolvedValue({ error: null });

  return {
    credentialEmbeddingUpsert: vi.fn().mockResolvedValue({ error: null }),
    credentialEmbeddingSelect: vi.fn().mockReturnValue({
      eq: credentialEmbeddingEq,
      in: credentialEmbeddingSnapshotFilter,
    }),
    credentialEmbeddingSnapshotFilter,
    credentialEmbeddingEq,
    credentialEmbeddingSingle,
    credentialEmbeddingDelete: vi.fn().mockReturnValue({
      in: credentialEmbeddingDeleteFilter,
    }),
    credentialEmbeddingDeleteFilter,
  };
});

// Mock the db module before importing the service
vi.mock('../utils/db.js', () => ({
  db: {
    from: vi.fn().mockReturnValue({
      insert: vi.fn().mockReturnValue({ error: null }),
      upsert: mockDb.credentialEmbeddingUpsert,
      delete: mockDb.credentialEmbeddingDelete,
      select: mockDb.credentialEmbeddingSelect,
    }),
    rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('./cost-tracker.js', () => ({
  checkAICredits: vi.fn().mockResolvedValue({
    monthlyAllocation: 500,
    usedThisMonth: 10,
    remaining: 490,
    hasCredits: true,
  }),
  deductAICredits: vi.fn().mockResolvedValue(true),
  logAIUsageEvent: vi.fn().mockResolvedValue(undefined),
}));

// Import after mocks
import {
  generateEmbedding,
  generateAndStoreEmbedding,
  batchReEmbed,
  buildEmbeddingText,
} from './embeddings.js';
import { checkAICredits, deductAICredits, logAIUsageEvent } from './cost-tracker.js';

// Create a mock provider
function createMockProvider(): IAIProvider {
  return {
    name: 'mock',
    extractMetadata: vi.fn(),
    generateEmbedding: vi.fn().mockResolvedValue({
      embedding: new Array(768).fill(0.1),
      model: 'gemini-embedding-001',
    } satisfies EmbeddingResult),
    healthCheck: vi.fn(),
  };
}

function createBatchMockProvider(): IAIProvider {
  return {
    ...createMockProvider(),
    name: 'gemini',
    generateEmbedding: vi.fn(),
    generateEmbeddings: vi.fn().mockResolvedValue({
      embeddings: [
        { embedding: new Array(768).fill(0.1), model: 'gemini-embedding-001' },
        { embedding: new Array(768).fill(0.2), model: 'gemini-embedding-001' },
        { embedding: new Array(768).fill(0.3), model: 'gemini-embedding-001' },
      ],
      model: 'gemini-embedding-001',
    }),
  };
}

describe('embeddings', () => {
  let mockProvider: IAIProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.credentialEmbeddingUpsert.mockResolvedValue({ error: null });
    mockDb.credentialEmbeddingSelect.mockReturnValue({
      eq: mockDb.credentialEmbeddingEq,
      in: mockDb.credentialEmbeddingSnapshotFilter,
    });
    mockDb.credentialEmbeddingSnapshotFilter.mockResolvedValue({
      data: [],
      error: null,
    });
    mockDb.credentialEmbeddingEq.mockReturnValue({
      single: mockDb.credentialEmbeddingSingle,
    });
    mockDb.credentialEmbeddingSingle.mockResolvedValue({
      data: { org_id: 'org-123', metadata: { issuerName: 'Test University' } },
      error: null,
    });
    mockDb.credentialEmbeddingDelete.mockReturnValue({
      in: mockDb.credentialEmbeddingDeleteFilter,
    });
    mockDb.credentialEmbeddingDeleteFilter.mockResolvedValue({ error: null });
    mockProvider = createMockProvider();
  });

  describe('buildEmbeddingText', () => {
    it('builds text from credential metadata fields', () => {
      const text = buildEmbeddingText({
        credentialType: 'DEGREE',
        issuerName: 'University of Michigan',
        fieldOfStudy: 'Computer Science',
        degreeLevel: 'Bachelor of Science',
        issuedDate: '2025-06-15',
      });

      expect(text).toContain('DEGREE');
      expect(text).toContain('University of Michigan');
      expect(text).toContain('Computer Science');
      expect(text).toContain('Bachelor of Science');
    });

    it('handles minimal metadata gracefully', () => {
      const text = buildEmbeddingText({ credentialType: 'CERTIFICATE' });
      expect(text).toContain('CERTIFICATE');
      expect(text.length).toBeGreaterThan(0);
    });

    it('omits undefined/null fields', () => {
      const text = buildEmbeddingText({
        credentialType: 'LICENSE',
        issuerName: undefined,
        fieldOfStudy: undefined,
      });

      expect(text).toContain('LICENSE');
      expect(text).not.toContain('undefined');
      expect(text).not.toContain('null');
    });
  });

  describe('generateEmbedding', () => {
    it('calls provider.generateEmbedding with text', async () => {
      const result = await generateEmbedding(mockProvider, 'DEGREE University of Michigan');

      expect(mockProvider.generateEmbedding).toHaveBeenCalledWith(
        'DEGREE University of Michigan',
        undefined,
      );
      expect(result.embedding).toHaveLength(768);
      expect(result.model).toBe('gemini-embedding-001');
    });

    it('returns 768-dimensional embedding', async () => {
      const result = await generateEmbedding(mockProvider, 'test credential');

      expect(result.embedding).toHaveLength(768);
      expect(result.embedding.every((v: number) => typeof v === 'number')).toBe(true);
    });

    it('propagates provider errors', async () => {
      const failingProvider = createMockProvider();
      vi.mocked(failingProvider.generateEmbedding).mockRejectedValue(
        new Error('Rate limited'),
      );

      await expect(generateEmbedding(failingProvider, 'test')).rejects.toThrow(
        'Rate limited',
      );
    });
  });

  describe('generateAndStoreEmbedding', () => {
    it('generates embedding and stores in credential_embeddings', async () => {
      const { db } = await import('../utils/db.js');

      const result = await generateAndStoreEmbedding(mockProvider, {
        anchorId: 'anchor-123',
        orgId: 'org-123',
        metadata: {
          credentialType: 'DEGREE',
          issuerName: 'Test University',
        },
      });

      expect(result.success).toBe(true);
      expect(result.model).toBe('gemini-embedding-001');
      expect(mockProvider.generateEmbedding).toHaveBeenCalled();
      expect(db.from).toHaveBeenCalledWith('credential_embeddings');
      expect(db.from).not.toHaveBeenCalledWith('public_record_embeddings');
    });

    it('checks and deducts AI credits', async () => {
      await generateAndStoreEmbedding(mockProvider, {
        anchorId: 'anchor-123',
        orgId: 'org-123',
        metadata: { credentialType: 'DEGREE' },
      });

      expect(checkAICredits).toHaveBeenCalledWith('org-123', undefined);
      expect(deductAICredits).toHaveBeenCalledWith('org-123', undefined, 1);
    });

    it('logs usage event', async () => {
      await generateAndStoreEmbedding(mockProvider, {
        anchorId: 'anchor-123',
        orgId: 'org-123',
        metadata: { credentialType: 'DEGREE' },
      });

      expect(logAIUsageEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: 'org-123',
          eventType: 'embedding',
          success: true,
        }),
      );
    });

    it('returns failure when credits are exhausted', async () => {
      vi.mocked(checkAICredits).mockResolvedValueOnce({
        monthlyAllocation: 50,
        usedThisMonth: 50,
        remaining: 0,
        hasCredits: false,
      });

      const result = await generateAndStoreEmbedding(mockProvider, {
        anchorId: 'anchor-123',
        orgId: 'org-123',
        metadata: { credentialType: 'DEGREE' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('credit');
      // B1: genuine exhaustion is the ONE case that may become a 402.
      expect(result.code).toBe('insufficient_credits');
    });

    it('returns failure on provider error', async () => {
      vi.mocked(mockProvider.generateEmbedding).mockRejectedValue(
        new Error('Provider down'),
      );

      const result = await generateAndStoreEmbedding(mockProvider, {
        anchorId: 'anchor-123',
        orgId: 'org-123',
        metadata: { credentialType: 'DEGREE' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Provider down');
      expect(result.code).toBe('embedding_failed');
    });

    // B1: a provider failure whose TEXT happens to contain the word "credit"
    // must still be an `embedding_failed`. The route used to sniff the message
    // for that substring, so this input answered 402 "insufficient_credits".
    it('does not classify a provider error as a credit failure because of its wording', async () => {
      vi.mocked(mockProvider.generateEmbedding).mockRejectedValue(
        new Error('credential credit scoring model timed out'),
      );

      const result = await generateAndStoreEmbedding(mockProvider, {
        anchorId: 'anchor-123',
        orgId: 'org-123',
        metadata: { credentialType: 'DEGREE' },
      });

      expect(result.success).toBe(false);
      expect(result.code).toBe('embedding_failed');
    });

    it('reports a storage failure as database_error, not a credit failure', async () => {
      mockDb.credentialEmbeddingUpsert.mockResolvedValueOnce({
        error: { message: 'insufficient credit on the storage node' },
      });

      const result = await generateAndStoreEmbedding(mockProvider, {
        anchorId: 'anchor-123',
        orgId: 'org-123',
        metadata: { credentialType: 'DEGREE' },
      });

      expect(result.success).toBe(false);
      expect(result.code).toBe('database_error');
    });

    it('rejects invalid embedding rows before storing them', async () => {
      vi.mocked(mockProvider.generateEmbedding).mockResolvedValueOnce({
        embedding: [Number.NaN],
        model: 'gemini-embedding-001',
      });

      const result = await generateAndStoreEmbedding(mockProvider, {
        anchorId: 'anchor-123',
        orgId: 'org-123',
        metadata: { credentialType: 'DEGREE' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid credential embedding row');
      expect(mockDb.credentialEmbeddingUpsert).not.toHaveBeenCalled();
      expect(deductAICredits).not.toHaveBeenCalled();
    });

    // SCRUM-4939 follow-up (migration 0483). `deductAICredits` NEVER throws —
    // it catches internally and returns `false` for every failure, including a
    // 55P03 lock timeout from `deduct_ai_credits`'s `SELECT … FOR UPDATE`. The
    // rollback path above is reached only by a rejected promise, so a falsy
    // return sailed straight past it: the embedding row stayed stored, the
    // caller got `{ success: true }`, and NO credit was debited. That is a
    // hollow success and a revenue leak on the same defect class ai-extract.ts
    // already closed (SCRUM-3502).
    //
    // There is no unmetered/beta ambiguity to preserve here: this function
    // already returns early when `checkAICredits` is null, so by the time the
    // debit runs the org is known to have a finite, metered balance and a
    // falsy debit can only mean "not charged".
    it('fails CLOSED and rolls back when the debit returns falsy (55P03 lock timeout)', async () => {
      vi.mocked(deductAICredits).mockResolvedValueOnce(false);

      const result = await generateAndStoreEmbedding(mockProvider, {
        anchorId: 'anchor-123',
        orgId: 'org-123',
        metadata: { credentialType: 'DEGREE' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('credit');
      // B1: the debit RPC being unavailable (55P03, outage) is OUR failure and
      // retryable — it must never be reported as customer credit exhaustion.
      expect(result.code).toBe('credit_debit_unavailable');
      expect(mockDb.credentialEmbeddingDeleteFilter).toHaveBeenCalledWith('anchor_id', [
        'anchor-123',
      ]);
      // and nothing stored survives the failure.
      expect(mockDb.credentialEmbeddingDelete).toHaveBeenCalledTimes(1);
    });

    it('classifies a throwing debit as credit_debit_unavailable and keeps no row', async () => {
      vi.mocked(deductAICredits).mockRejectedValueOnce(new Error('ECONNRESET'));

      const result = await generateAndStoreEmbedding(mockProvider, {
        anchorId: 'anchor-123',
        orgId: 'org-123',
        metadata: { credentialType: 'DEGREE' },
      });

      expect(result.success).toBe(false);
      expect(result.code).toBe('credit_debit_unavailable');
      expect(mockDb.credentialEmbeddingDeleteFilter).toHaveBeenCalledWith('anchor_id', [
        'anchor-123',
      ]);
    });

    it('returns rollback delete failures when credit deduction fails after storing a new row', async () => {
      vi.mocked(deductAICredits).mockRejectedValueOnce(new Error('Credit ledger unavailable'));
      mockDb.credentialEmbeddingDeleteFilter.mockResolvedValueOnce({
        error: { message: 'delete denied' },
      });

      const result = await generateAndStoreEmbedding(mockProvider, {
        anchorId: 'anchor-123',
        orgId: 'org-123',
        metadata: { credentialType: 'DEGREE' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to delete new credential embeddings during rollback');
      expect(result.error).toContain('anchor-123');
      expect(result.error).toContain('delete denied');
      // A rollback that itself failed leaves an UNCHARGED row behind. That is
      // still an infrastructure failure of the credit path, never a 402.
      expect(result.code).toBe('credit_debit_unavailable');
    });
  });

  describe('batchReEmbed', () => {
    it('uses a provider-native batch embedding call when available', async () => {
      const batchProvider = createBatchMockProvider();

      const results = await batchReEmbed(batchProvider, 'org-123', [
        { anchorId: 'a1', metadata: { credentialType: 'DEGREE', issuerName: 'State University' } },
        { anchorId: 'a2', metadata: { credentialType: 'CERTIFICATE', issuerName: 'Example Academy' } },
        { anchorId: 'a3', metadata: { credentialType: 'LICENSE', jurisdiction: 'MI' } },
      ], 'user-123');

      expect(results).toMatchObject({
        total: 3,
        succeeded: 3,
        failed: 0,
        errors: [],
      });
      expect(batchProvider.generateEmbeddings).toHaveBeenCalledTimes(1);
      expect(batchProvider.generateEmbeddings).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ text: expect.stringContaining('DEGREE') }),
          expect.objectContaining({ text: expect.stringContaining('CERTIFICATE') }),
          expect.objectContaining({ text: expect.stringContaining('LICENSE') }),
        ]),
        'RETRIEVAL_DOCUMENT',
      );
      expect(batchProvider.generateEmbedding).not.toHaveBeenCalled();
      expect(checkAICredits).toHaveBeenCalledTimes(1);
      expect(checkAICredits).toHaveBeenCalledWith('org-123', 'user-123');
      expect(deductAICredits).toHaveBeenCalledTimes(1);
      expect(deductAICredits).toHaveBeenCalledWith('org-123', 'user-123', 3);
      expect(logAIUsageEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: 'org-123',
          userId: 'user-123',
          eventType: 'embedding',
          provider: 'gemini',
          creditsConsumed: 3,
          success: true,
        }),
      );
    });

    it('splits provider-native batch embedding calls at 250 inputs', async () => {
      const generateEmbeddings = vi.fn().mockImplementation(async (
        inputs: Array<{ text: string }>,
      ) => ({
        embeddings: inputs.map((_, index) => ({
          embedding: new Array(768).fill(index / 1000),
          model: 'gemini-embedding-001',
        })),
        model: 'gemini-embedding-001',
      }));
      const batchProvider: IAIProvider = {
        ...createMockProvider(),
        name: 'gemini',
        generateEmbedding: vi.fn(),
        generateEmbeddings,
      };
      const items = Array.from({ length: 251 }, (_, index) => ({
        anchorId: `anchor-${index}`,
        metadata: { credentialType: 'CERTIFICATE', issuerName: `Issuer ${index}` },
      }));

      const results = await batchReEmbed(batchProvider, 'org-123', items, 'user-123');

      expect(results).toMatchObject({
        total: 251,
        succeeded: 251,
        failed: 0,
      });
      expect(generateEmbeddings).toHaveBeenCalledTimes(2);
      expect(generateEmbeddings.mock.calls[0]?.[0]).toHaveLength(250);
      expect(generateEmbeddings.mock.calls[1]?.[0]).toHaveLength(1);
      expect(deductAICredits).toHaveBeenCalledWith('org-123', 'user-123', 251);
    });

    it('fails the whole batch without provider calls when credits cannot cover every item', async () => {
      const batchProvider = createBatchMockProvider();
      vi.mocked(checkAICredits).mockResolvedValueOnce({
        monthlyAllocation: 2,
        usedThisMonth: 0,
        remaining: 2,
        hasCredits: true,
      });

      const results = await batchReEmbed(batchProvider, 'org-123', [
        { anchorId: 'a1', metadata: { credentialType: 'DEGREE' } },
        { anchorId: 'a2', metadata: { credentialType: 'CERTIFICATE' } },
        { anchorId: 'a3', metadata: { credentialType: 'LICENSE' } },
      ], 'user-123');

      expect(results.total).toBe(3);
      expect(results.succeeded).toBe(0);
      expect(results.failed).toBe(3);
      expect(results.errors).toEqual([
        { anchorId: 'a1', error: 'Insufficient AI credits for embedding batch', code: 'insufficient_credits' },
        { anchorId: 'a2', error: 'Insufficient AI credits for embedding batch', code: 'insufficient_credits' },
        { anchorId: 'a3', error: 'Insufficient AI credits for embedding batch', code: 'insufficient_credits' },
      ]);
      expect(batchProvider.generateEmbeddings).not.toHaveBeenCalled();
      expect(batchProvider.generateEmbedding).not.toHaveBeenCalled();
      expect(deductAICredits).not.toHaveBeenCalled();
    });

    it('returns batch errors when the native credit pre-check rejects', async () => {
      const batchProvider = createBatchMockProvider();
      vi.mocked(checkAICredits).mockRejectedValueOnce(new Error('credit service unavailable'));

      const results = await batchReEmbed(batchProvider, 'org-123', [
        { anchorId: 'a1', metadata: { credentialType: 'DEGREE' } },
        { anchorId: 'a2', metadata: { credentialType: 'CERTIFICATE' } },
      ], 'user-123');

      expect(results).toMatchObject({
        total: 2,
        succeeded: 0,
        failed: 2,
      });
      // A REJECTED pre-check is the credit system being unreachable, not the
      // org being out of credit: it must not reach the caller as a 402.
      expect(results.errors).toEqual([
        { anchorId: 'a1', error: 'credit service unavailable', code: 'credit_check_unavailable' },
        { anchorId: 'a2', error: 'credit service unavailable', code: 'credit_check_unavailable' },
      ]);
      expect(batchProvider.generateEmbeddings).not.toHaveBeenCalled();
      expect(mockDb.credentialEmbeddingUpsert).not.toHaveBeenCalled();
      expect(deductAICredits).not.toHaveBeenCalled();
    });

    it('rejects duplicate anchor IDs before native embedding generation', async () => {
      const batchProvider = createBatchMockProvider();

      const results = await batchReEmbed(batchProvider, 'org-123', [
        { anchorId: 'a1', metadata: { credentialType: 'DEGREE' } },
        { anchorId: 'a1', metadata: { credentialType: 'CERTIFICATE' } },
        { anchorId: 'a2', metadata: { credentialType: 'LICENSE' } },
      ], 'user-123');

      expect(results).toMatchObject({
        total: 3,
        succeeded: 0,
        failed: 3,
      });
      expect(results.errors).toEqual([
        { anchorId: 'a1', error: 'Duplicate anchorId in batch', code: 'duplicate_anchor_id' },
        { anchorId: 'a1', error: 'Duplicate anchorId in batch', code: 'duplicate_anchor_id' },
        { anchorId: 'a2', error: 'Duplicate anchorId in batch', code: 'duplicate_anchor_id' },
      ]);
      expect(checkAICredits).not.toHaveBeenCalled();
      expect(batchProvider.generateEmbeddings).not.toHaveBeenCalled();
      expect(mockDb.credentialEmbeddingUpsert).not.toHaveBeenCalled();
      expect(deductAICredits).not.toHaveBeenCalled();
    });

    it('rejects invalid native batch rows before storing them', async () => {
      const batchProvider = createBatchMockProvider();
      vi.mocked(batchProvider.generateEmbeddings!).mockResolvedValueOnce({
        embeddings: [
          { embedding: new Array(768).fill(0.1), model: 'gemini-embedding-001' },
          { embedding: [Number.NaN], model: 'gemini-embedding-001' },
          { embedding: new Array(768).fill(0.3), model: 'gemini-embedding-001' },
        ],
        model: 'gemini-embedding-001',
      });

      const results = await batchReEmbed(batchProvider, 'org-123', [
        { anchorId: 'a1', metadata: { credentialType: 'DEGREE' } },
        { anchorId: 'a2', metadata: { credentialType: 'CERTIFICATE' } },
        { anchorId: 'a3', metadata: { credentialType: 'LICENSE' } },
      ], 'user-123');

      expect(results).toMatchObject({
        total: 3,
        succeeded: 0,
        failed: 3,
      });
      expect(results.errors).toEqual([
        { anchorId: 'a1', error: expect.stringContaining('Invalid credential embedding row'), code: 'embedding_failed' },
        { anchorId: 'a2', error: expect.stringContaining('Invalid credential embedding row'), code: 'embedding_failed' },
        { anchorId: 'a3', error: expect.stringContaining('Invalid credential embedding row'), code: 'embedding_failed' },
      ]);
      expect(mockDb.credentialEmbeddingUpsert).not.toHaveBeenCalled();
      expect(deductAICredits).not.toHaveBeenCalled();
    });

    it('rolls back native batch rows when credit deduction fails after storage', async () => {
      const batchProvider = createBatchMockProvider();
      vi.mocked(deductAICredits).mockRejectedValueOnce(new Error('Credit ledger unavailable'));

      const results = await batchReEmbed(batchProvider, 'org-123', [
        { anchorId: 'a1', metadata: { credentialType: 'DEGREE' } },
        { anchorId: 'a2', metadata: { credentialType: 'CERTIFICATE' } },
        { anchorId: 'a3', metadata: { credentialType: 'LICENSE' } },
      ], 'user-123');

      expect(results).toMatchObject({
        total: 3,
        succeeded: 0,
        failed: 3,
      });
      expect(results.errors).toEqual([
        { anchorId: 'a1', error: 'Credit ledger unavailable', code: 'credit_debit_unavailable' },
        { anchorId: 'a2', error: 'Credit ledger unavailable', code: 'credit_debit_unavailable' },
        { anchorId: 'a3', error: 'Credit ledger unavailable', code: 'credit_debit_unavailable' },
      ]);
      expect(mockDb.credentialEmbeddingUpsert).toHaveBeenCalledTimes(1);
      expect(mockDb.credentialEmbeddingDelete).toHaveBeenCalledTimes(1);
      expect(mockDb.credentialEmbeddingDeleteFilter).toHaveBeenCalledWith('anchor_id', [
        'a1',
        'a2',
        'a3',
      ]);
    });

    // Same fail-closed rule as the single-item path: a falsy batch debit is a
    // failed debit, not a silently-free batch of `items.length` embeddings.
    it('fails CLOSED and rolls back native batch rows when the debit returns falsy', async () => {
      const batchProvider = createBatchMockProvider();
      vi.mocked(deductAICredits).mockResolvedValueOnce(false);

      const results = await batchReEmbed(batchProvider, 'org-123', [
        { anchorId: 'a1', metadata: { credentialType: 'DEGREE' } },
        { anchorId: 'a2', metadata: { credentialType: 'CERTIFICATE' } },
        { anchorId: 'a3', metadata: { credentialType: 'LICENSE' } },
      ], 'user-123');

      expect(results).toMatchObject({ total: 3, succeeded: 0, failed: 3 });
      expect(results.errors.every((e) => e.error.includes('credit'))).toBe(true);
      expect(results.errors.every((e) => e.code === 'credit_debit_unavailable')).toBe(true);
      expect(mockDb.credentialEmbeddingDeleteFilter).toHaveBeenCalledWith('anchor_id', [
        'a1',
        'a2',
        'a3',
      ]);
    });

    it('restores previous native batch rows when credit deduction fails after replacing them', async () => {
      const batchProvider = createBatchMockProvider();
      const previousRow = {
        anchor_id: 'a1',
        org_id: 'org-123',
        embedding: new Array(768).fill(0.9),
        model_version: 'previous-model',
        source_text_hash: 'a'.repeat(64),
      };
      mockDb.credentialEmbeddingSnapshotFilter.mockResolvedValueOnce({
        data: [previousRow],
        error: null,
      });
      vi.mocked(deductAICredits).mockRejectedValueOnce(new Error('Credit ledger unavailable'));

      const results = await batchReEmbed(batchProvider, 'org-123', [
        { anchorId: 'a1', metadata: { credentialType: 'DEGREE' } },
        { anchorId: 'a2', metadata: { credentialType: 'CERTIFICATE' } },
        { anchorId: 'a3', metadata: { credentialType: 'LICENSE' } },
      ], 'user-123');

      expect(results).toMatchObject({
        total: 3,
        succeeded: 0,
        failed: 3,
      });
      expect(mockDb.credentialEmbeddingUpsert).toHaveBeenCalledTimes(2);
      expect(mockDb.credentialEmbeddingDeleteFilter).toHaveBeenCalledWith('anchor_id', [
        'a2',
        'a3',
      ]);
      expect(mockDb.credentialEmbeddingUpsert).toHaveBeenLastCalledWith(
        [previousRow],
        { onConflict: 'anchor_id' },
      );
    });

    it('returns rollback restore failures when credit deduction fails after replacing rows', async () => {
      const batchProvider = createBatchMockProvider();
      const previousRow = {
        anchor_id: 'a1',
        org_id: 'org-123',
        embedding: new Array(768).fill(0.9),
        model_version: 'previous-model',
        source_text_hash: 'a'.repeat(64),
      };
      mockDb.credentialEmbeddingSnapshotFilter.mockResolvedValueOnce({
        data: [previousRow],
        error: null,
      });
      mockDb.credentialEmbeddingUpsert
        .mockResolvedValueOnce({ error: null })
        .mockResolvedValueOnce({ error: { message: 'restore denied' } });
      vi.mocked(deductAICredits).mockRejectedValueOnce(new Error('Credit ledger unavailable'));

      const results = await batchReEmbed(batchProvider, 'org-123', [
        { anchorId: 'a1', metadata: { credentialType: 'DEGREE' } },
        { anchorId: 'a2', metadata: { credentialType: 'CERTIFICATE' } },
        { anchorId: 'a3', metadata: { credentialType: 'LICENSE' } },
      ], 'user-123');

      expect(results).toMatchObject({
        total: 3,
        succeeded: 0,
        failed: 3,
      });
      expect(results.errors).toEqual([
        {
          anchorId: 'a1',
          error: expect.stringContaining(
            'Failed to restore previous credential embeddings during rollback',
          ),
          code: 'credit_debit_unavailable',
        },
        {
          anchorId: 'a2',
          error: expect.stringContaining(
            'Failed to restore previous credential embeddings during rollback',
          ),
          code: 'credit_debit_unavailable',
        },
        {
          anchorId: 'a3',
          error: expect.stringContaining(
            'Failed to restore previous credential embeddings during rollback',
          ),
          code: 'credit_debit_unavailable',
        },
      ]);
      expect(results.errors[0]?.error).toContain('a1');
      expect(results.errors[0]?.error).toContain('restore denied');
    });

    it('processes multiple anchors', async () => {
      const results = await batchReEmbed(mockProvider, 'org-123', [
        { anchorId: 'a1', metadata: { credentialType: 'DEGREE' } },
        { anchorId: 'a2', metadata: { credentialType: 'CERTIFICATE' } },
      ]);

      expect(results.total).toBe(2);
      expect(results.succeeded).toBe(2);
      expect(results.failed).toBe(0);
    });

    it('handles partial failures', async () => {
      vi.mocked(mockProvider.generateEmbedding)
        .mockResolvedValueOnce({ embedding: new Array(768).fill(0.1), model: 'test' })
        .mockRejectedValueOnce(new Error('Failed'));

      const results = await batchReEmbed(mockProvider, 'org-123', [
        { anchorId: 'a1', metadata: { credentialType: 'DEGREE' } },
        { anchorId: 'a2', metadata: { credentialType: 'LICENSE' } },
      ]);

      expect(results.total).toBe(2);
      expect(results.succeeded).toBe(1);
      expect(results.failed).toBe(1);
    });

    it('returns empty results for empty input', async () => {
      const results = await batchReEmbed(mockProvider, 'org-123', []);

      expect(results.total).toBe(0);
      expect(results.succeeded).toBe(0);
      expect(results.failed).toBe(0);
    });
  });
});
