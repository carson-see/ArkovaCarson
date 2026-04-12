/**
 * GME-17: Batch Processing Optimization Tests
 *
 * Verifies batch extraction infrastructure for Gemini 3.
 */

import { describe, it, expect } from 'vitest';
import { BatchProcessor, type BatchResult } from './batch-processing.js';
import type { IAIProvider, ExtractionRequest, ExtractionResult, EmbeddingResult, ProviderHealth } from './types.js';

const mockProvider: IAIProvider = {
  name: 'mock',
  async extractMetadata(req: ExtractionRequest): Promise<ExtractionResult> {
    return {
      fields: { credentialType: 'DEGREE' },
      confidence: 0.9,
      provider: 'mock',
      modelVersion: 'mock',
    };
  },
  async generateEmbedding(): Promise<EmbeddingResult> {
    return { embedding: [0.1], model: 'mock' };
  },
  async healthCheck(): Promise<ProviderHealth> {
    return { healthy: true, provider: 'mock', latencyMs: 10 };
  },
};

describe('GME-17: BatchProcessor', () => {
  it('processes multiple requests concurrently', async () => {
    const processor = new BatchProcessor(mockProvider, { concurrency: 3 });
    const requests: ExtractionRequest[] = Array.from({ length: 5 }, (_, i) => ({
      strippedText: `Document ${i}`,
      credentialType: 'DEGREE',
      fingerprint: 'a'.repeat(64),
    }));

    const results = await processor.extractBatch(requests);
    expect(results).toHaveLength(5);
    expect(results.every(r => r.success)).toBe(true);
  });

  it('handles individual failures without failing the batch', async () => {
    let callCount = 0;
    const failingProvider: IAIProvider = {
      ...mockProvider,
      async extractMetadata(): Promise<ExtractionResult> {
        callCount++;
        if (callCount === 3) throw new Error('Extraction failed');
        return { fields: { credentialType: 'DEGREE' }, confidence: 0.9, provider: 'mock', modelVersion: 'mock' };
      },
    };

    const processor = new BatchProcessor(failingProvider, { concurrency: 1 });
    const requests = Array.from({ length: 5 }, (_, i) => ({
      strippedText: `Doc ${i}`,
      credentialType: 'DEGREE',
      fingerprint: 'a'.repeat(64),
    }));

    const results = await processor.extractBatch(requests);
    expect(results).toHaveLength(5);
    expect(results.filter(r => r.success)).toHaveLength(4);
    expect(results.filter(r => !r.success)).toHaveLength(1);
  });

  it('respects concurrency limit', async () => {
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const slowProvider: IAIProvider = {
      ...mockProvider,
      async extractMetadata(): Promise<ExtractionResult> {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise(r => setTimeout(r, 10));
        currentConcurrent--;
        return { fields: {}, confidence: 0.5, provider: 'mock', modelVersion: 'mock' };
      },
    };

    const processor = new BatchProcessor(slowProvider, { concurrency: 2 });
    const requests = Array.from({ length: 6 }, () => ({
      strippedText: 'test',
      credentialType: 'DEGREE',
      fingerprint: 'a'.repeat(64),
    }));

    await processor.extractBatch(requests);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });
});
