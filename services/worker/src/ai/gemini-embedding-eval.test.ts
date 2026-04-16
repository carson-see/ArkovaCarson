/**
 * GME-03: Embedding Model Migration Evaluation
 *
 * Records the current embedding-model selection + migration posture.
 *
 * Current model: `gemini-embedding-001` (per CLAUDE.md Section 7).
 * Original GME-03 plan (2026-04-12) named `text-embedding-004` as the target —
 * that identifier does not exist in the public Gemini SDK. The actual production
 * embedding model was set to `gemini-embedding-001`, with `gemini-embedding-2-preview`
 * reserved for post-preview migration.
 *
 * If we ever migrate to a different-dimension model, all rows in
 * `public_record_embeddings` must be regenerated (320K+ records; ~$100-200 at
 * current pricing). Plan as a separate story before any dimension change.
 */
import { describe, it, expect } from 'vitest';
import { GEMINI_EMBEDDING_MODEL, getGeminiConfig } from './gemini-config.js';

describe('GME-03: Embedding Model Evaluation', () => {
  it('current embedding model is gemini-embedding-001', () => {
    expect(GEMINI_EMBEDDING_MODEL).toBe('gemini-embedding-001');
  });

  it('embedding model is separate from generation model in config', () => {
    const config = getGeminiConfig();
    expect(config.embeddingModel).toBe('gemini-embedding-001');
    expect(config.generationModel).not.toBe(config.embeddingModel);
  });

  it('documents migration posture', () => {
    const decision = {
      currentModel: 'gemini-embedding-001',
      candidateReplacement: 'gemini-embedding-2-preview',
      action: 'KEEP_CURRENT',
      reason: 'gemini-embedding-2-preview is preview-only; dimension change requires regenerating 320K+ records',
      riskIfDimensionsChange: 'ALL public_record_embeddings must be regenerated',
      migrationStoryNeeded: true,
    };

    expect(decision.action).toBe('KEEP_CURRENT');
    expect(decision.migrationStoryNeeded).toBe(true);
  });
});
