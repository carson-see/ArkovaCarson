/**
 * Tests for Gemini Model Configuration (GME-01)
 *
 * Verifies centralized model references provide correct defaults
 * and respect environment variable overrides.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('gemini-config', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear relevant env vars before each test
    delete process.env.GEMINI_MODEL;
    delete process.env.GEMINI_EMBEDDING_MODEL;
    delete process.env.GEMINI_TUNED_MODEL;
    delete process.env.GEMINI_VISION_MODEL;
    // Force re-import to pick up env changes
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('exports correct default generation model', async () => {
    const { GEMINI_GENERATION_MODEL } = await import('./gemini-config.js');
    expect(GEMINI_GENERATION_MODEL).toBe('gemini-3-flash-preview');
  });

  it('exports correct default embedding model', async () => {
    const { GEMINI_EMBEDDING_MODEL } = await import('./gemini-config.js');
    expect(GEMINI_EMBEDDING_MODEL).toBe('gemini-embedding-001');
  });

  it('exports correct default vision model (same as generation)', async () => {
    const { GEMINI_VISION_MODEL } = await import('./gemini-config.js');
    expect(GEMINI_VISION_MODEL).toBe('gemini-3-flash-preview');
  });

  it('exports null for tuned model when env not set', async () => {
    const { GEMINI_TUNED_MODEL } = await import('./gemini-config.js');
    expect(GEMINI_TUNED_MODEL).toBeNull();
  });

  it('getGeminiConfig returns all model references', async () => {
    const { getGeminiConfig } = await import('./gemini-config.js');
    const config = getGeminiConfig();
    expect(config).toEqual({
      generationModel: 'gemini-3-flash-preview',
      embeddingModel: 'gemini-embedding-001',
      visionModel: 'gemini-3-flash-preview',
      tunedModel: null,
      liteModel: 'gemini-3-flash-lite-preview',
    });
  });

  it('respects GEMINI_MODEL env var override via getGeminiConfig()', async () => {
    process.env.GEMINI_MODEL = 'gemini-3-flash-preview';
    const { getGeminiConfig } = await import('./gemini-config.js');
    const config = getGeminiConfig();
    expect(config.generationModel).toBe('gemini-3-flash-preview');
  });

  it('respects GEMINI_EMBEDDING_MODEL env var override via getGeminiConfig()', async () => {
    process.env.GEMINI_EMBEDDING_MODEL = 'gemini-embedding-2-preview';
    const { getGeminiConfig } = await import('./gemini-config.js');
    const config = getGeminiConfig();
    expect(config.embeddingModel).toBe('gemini-embedding-2-preview');
  });

  it('respects GEMINI_TUNED_MODEL env var via getGeminiConfig()', async () => {
    process.env.GEMINI_TUNED_MODEL = 'projects/123/locations/us-central1/endpoints/456';
    const { getGeminiConfig } = await import('./gemini-config.js');
    const config = getGeminiConfig();
    expect(config.tunedModel).toBe('projects/123/locations/us-central1/endpoints/456');
  });
});
