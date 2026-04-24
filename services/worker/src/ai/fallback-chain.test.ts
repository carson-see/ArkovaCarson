/**
 * GME-19: Multi-Model Fallback Chain Tests
 *
 * Verifies that the fallback chain:
 * - Tries providers in order (Tuned → Base → Nessie → error)
 * - Falls back on 429/503/deprecation errors
 * - Tracks per-model metrics
 * - Does NOT fall back on validation/parse errors (those are content issues, not model issues)
 */

import { describe, it, expect } from 'vitest';
import { FallbackChainProvider } from './fallback-chain.js';
import type { IAIProvider, ExtractionRequest, ExtractionResult, EmbeddingResult, ProviderHealth } from './types.js';

function makeRequest(): ExtractionRequest {
  return {
    strippedText: 'University of Test — Bachelor of Science',
    credentialType: 'DEGREE',
    fingerprint: 'a'.repeat(64),
  };
}

function makeMockProvider(
  name: string,
  behavior: 'succeed' | 'fail-429' | 'fail-503' | 'fail-deprecated' | 'fail-generic',
): IAIProvider {
  return {
    name,
    async extractMetadata(): Promise<ExtractionResult> {
      switch (behavior) {
        case 'succeed':
          return {
            fields: { credentialType: 'DEGREE', issuerName: `from-${name}` },
            confidence: 0.9,
            provider: name,
            modelVersion: name,
          };
        case 'fail-429':
          throw Object.assign(new Error('Rate limited'), { status: 429 });
        case 'fail-503':
          throw Object.assign(new Error('Service unavailable'), { status: 503 });
        case 'fail-deprecated':
          throw new Error('model is deprecated');
        case 'fail-generic':
          throw new Error('Schema validation failed');
      }
    },
    async generateEmbedding(): Promise<EmbeddingResult> {
      return { embedding: [0.1, 0.2], model: name };
    },
    async healthCheck(): Promise<ProviderHealth> {
      return { healthy: behavior === 'succeed', provider: name, latencyMs: 50 };
    },
  };
}

describe('GME-19: FallbackChainProvider', () => {
  it('uses the first provider when it succeeds', async () => {
    const chain = new FallbackChainProvider([
      makeMockProvider('tuned', 'succeed'),
      makeMockProvider('base', 'succeed'),
    ]);

    const result = await chain.extractMetadata(makeRequest());
    expect(result.provider).toBe('tuned');
  });

  it('falls back to second provider on 429 error', async () => {
    const chain = new FallbackChainProvider([
      makeMockProvider('tuned', 'fail-429'),
      makeMockProvider('base', 'succeed'),
    ]);

    const result = await chain.extractMetadata(makeRequest());
    expect(result.provider).toBe('base');
  });

  it('falls back to second provider on 503 error', async () => {
    const chain = new FallbackChainProvider([
      makeMockProvider('tuned', 'fail-503'),
      makeMockProvider('base', 'succeed'),
    ]);

    const result = await chain.extractMetadata(makeRequest());
    expect(result.provider).toBe('base');
  });

  it('falls back on deprecation error', async () => {
    const chain = new FallbackChainProvider([
      makeMockProvider('tuned', 'fail-deprecated'),
      makeMockProvider('base', 'succeed'),
    ]);

    const result = await chain.extractMetadata(makeRequest());
    expect(result.provider).toBe('base');
  });

  it('does NOT fall back on generic/validation errors', async () => {
    const chain = new FallbackChainProvider([
      makeMockProvider('tuned', 'fail-generic'),
      makeMockProvider('base', 'succeed'),
    ]);

    await expect(chain.extractMetadata(makeRequest())).rejects.toThrow('Schema validation');
  });

  it('cascades through all providers', async () => {
    const chain = new FallbackChainProvider([
      makeMockProvider('tuned', 'fail-429'),
      makeMockProvider('base', 'fail-503'),
      makeMockProvider('nessie', 'succeed'),
    ]);

    const result = await chain.extractMetadata(makeRequest());
    expect(result.provider).toBe('nessie');
  });

  it('throws if all providers fail with retriable errors', async () => {
    const chain = new FallbackChainProvider([
      makeMockProvider('tuned', 'fail-429'),
      makeMockProvider('base', 'fail-503'),
    ]);

    await expect(chain.extractMetadata(makeRequest())).rejects.toThrow();
  });

  it('tracks per-model metrics', async () => {
    const chain = new FallbackChainProvider([
      makeMockProvider('tuned', 'fail-429'),
      makeMockProvider('base', 'succeed'),
    ]);

    await chain.extractMetadata(makeRequest());
    const metrics = chain.getMetrics();

    expect(metrics).toHaveProperty('tuned');
    expect(metrics).toHaveProperty('base');
    expect(metrics.tuned.failures).toBe(1);
    expect(metrics.tuned.successes).toBe(0);
    expect(metrics.base.successes).toBe(1);
    expect(metrics.base.failures).toBe(0);
  });

  it('delegates embeddings to first available provider', async () => {
    const chain = new FallbackChainProvider([
      makeMockProvider('tuned', 'succeed'),
      makeMockProvider('base', 'succeed'),
    ]);

    const result = await chain.generateEmbedding('test text');
    expect(result.embedding).toHaveLength(2);
  });

  it('health check reports which providers are up/down', async () => {
    const chain = new FallbackChainProvider([
      makeMockProvider('tuned', 'fail-429'),
      makeMockProvider('base', 'succeed'),
    ]);

    const health = await chain.healthCheck();
    expect(health.healthy).toBe(true); // at least one is up
    expect(health.provider).toBe('fallback-chain');
  });
});
