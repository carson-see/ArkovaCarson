/**
 * Tests for IAIProvider interface and shared AI types.
 *
 * Validates that the type contracts are correct and the mock provider
 * properly implements the interface.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type {
  IAIProvider,
  BatchEmbeddingResult,
  ExtractionRequest,
  ExtractionResult,
  EmbeddingResult,
} from './types.js';
import { MockAIProvider } from './mock.js';

describe('IAIProvider interface (via MockAIProvider)', () => {
  let provider: IAIProvider;

  beforeEach(() => {
    provider = new MockAIProvider();
  });

  it('has a name property', () => {
    expect(provider.name).toBe('mock');
  });

  it('extractMetadata returns structured fields from PII-stripped input', async () => {
    const request: ExtractionRequest = {
      strippedText: 'Bachelor of Science, University of Michigan, 2025',
      credentialType: 'DEGREE',
      fingerprint: 'abc123',
    };

    const result: ExtractionResult = await provider.extractMetadata(request);

    expect(result.fields).toBeDefined();
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(result.provider).toBe('mock');
  });

  it('generateEmbedding returns a 768-dimensional vector', async () => {
    const result: EmbeddingResult = await provider.generateEmbedding('University of Michigan');

    expect(result.embedding).toHaveLength(768);
    expect(result.model).toBeDefined();
    result.embedding.forEach((v) => expect(typeof v).toBe('number'));
  });

  it('generateEmbeddings returns one vector per batch input when implemented', async () => {
    const result: BatchEmbeddingResult = await provider.generateEmbeddings!([
      { text: 'University of Michigan' },
      { text: 'State Bar CLE' },
    ], 'RETRIEVAL_DOCUMENT');

    expect(result.embeddings).toHaveLength(2);
    expect(result.model).toBeDefined();
    result.embeddings.forEach((embedding) => {
      expect(embedding.embedding).toHaveLength(768);
      expect(embedding.model).toBeDefined();
    });
  });

  it('healthCheck returns provider status', async () => {
    const health = await provider.healthCheck();

    expect(health.healthy).toBe(true);
    expect(health.provider).toBe('mock');
    expect(typeof health.latencyMs).toBe('number');
  });
});
