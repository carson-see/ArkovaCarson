/**
 * GME-12: Multimodal Embedding Tests
 *
 * Verifies multimodal embedding configuration and feature flag.
 */

import { describe, it, expect } from 'vitest';
import {
  isMultimodalEmbeddingEnabled,
  MULTIMODAL_EMBEDDING_CONFIG,
} from './multimodal-embedding.js';

describe('GME-12: Multimodal Embedding', () => {
  it('multimodal embedding is disabled by default', () => {
    delete process.env.ENABLE_MULTIMODAL_EMBEDDINGS;
    expect(isMultimodalEmbeddingEnabled()).toBe(false);
  });

  it('can be enabled via switchboard flag', () => {
    process.env.ENABLE_MULTIMODAL_EMBEDDINGS = 'true';
    expect(isMultimodalEmbeddingEnabled()).toBe(true);
    delete process.env.ENABLE_MULTIMODAL_EMBEDDINGS;
  });

  it('config specifies supported media types', () => {
    expect(MULTIMODAL_EMBEDDING_CONFIG.supportedMimeTypes).toContain('image/png');
    expect(MULTIMODAL_EMBEDDING_CONFIG.supportedMimeTypes).toContain('image/jpeg');
    expect(MULTIMODAL_EMBEDDING_CONFIG.supportedMimeTypes).toContain('application/pdf');
  });

  it('config specifies the embedding model', () => {
    expect(MULTIMODAL_EMBEDDING_CONFIG.model).toBeDefined();
    expect(MULTIMODAL_EMBEDDING_CONFIG.model.length).toBeGreaterThan(0);
  });
});
