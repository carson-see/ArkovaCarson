/**
 * GME-03: Embedding Model Migration Evaluation
 *
 * Documents the evaluation of text-embedding-004 deprecation and migration path.
 * Deprecation date: July 14, 2026 (93 days from 2026-04-12)
 * Recommended replacement: text-embedding-004
 *
 * Decision: KEEP text-embedding-004 for now.
 * Rationale:
 *   - 93 days until shutdown (less urgent than Flash model at 66 days)
 *   - text-embedding-004 dimensions may differ (768 vs unknown) — re-embedding 320K+ records needed
 *   - Re-embedding cost: ~$100-200 at current Gemini pricing
 *   - Migration should be planned as a separate story before July 2026
 *
 * IMPORTANT: text-embedding-004 may have different vector dimensions.
 * If dimensions differ, ALL public_record_embeddings rows must be regenerated.
 */
import { describe, it, expect } from 'vitest';
import { GEMINI_EMBEDDING_MODEL, getGeminiConfig } from './gemini-config.js';

describe('GME-03: Embedding Model Evaluation', () => {
  it('current embedding model is text-embedding-004', () => {
    expect(GEMINI_EMBEDDING_MODEL).toBe('text-embedding-004');
  });

  it('embedding model is separate from generation model in config', () => {
    const config = getGeminiConfig();
    expect(config.embeddingModel).toBe('text-embedding-004');
    expect(config.generationModel).not.toBe(config.embeddingModel);
  });

  it('documents deprecation timeline', () => {
    // This test documents the decision made during GME-03 evaluation
    const decision = {
      currentModel: 'text-embedding-004',
      deprecationDate: '2026-07-14',
      recommendedReplacement: 'text-embedding-004',
      action: 'KEEP_CURRENT',
      reason: 'Shutdown 93 days away; re-embedding 320K+ records is expensive; plan separate migration story',
      riskIfDimensionsChange: 'ALL public_record_embeddings must be regenerated',
      migrationStoryNeeded: true,
    };

    expect(decision.action).toBe('KEEP_CURRENT');
    expect(decision.migrationStoryNeeded).toBe(true);
  });
});
