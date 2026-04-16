/**
 * Embedding Service Tests (P8-S11)
 *
 * TDD: Tests written first, then implementation.
 * Uses MockAIProvider — no real API calls (Constitution 1.7).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IAIProvider, EmbeddingResult } from './types.js';

// Mock the db module before importing the service
vi.mock('../utils/db.js', () => ({
  db: {
    from: vi.fn().mockReturnValue({
      insert: vi.fn().mockReturnValue({ error: null }),
      upsert: vi.fn().mockReturnValue({ error: null }),
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { org_id: 'org-123', metadata: { issuerName: 'Test University' } },
            error: null,
          }),
        }),
      }),
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

describe('embeddings', () => {
  let mockProvider: IAIProvider;

  beforeEach(() => {
    vi.clearAllMocks();
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
    });
  });

  describe('batchReEmbed', () => {
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
