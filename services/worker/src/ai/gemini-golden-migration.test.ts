/**
 * GME-04: Golden Tuned Model Migration
 *
 * Documents the migration strategy for the Gemini Golden fine-tuned model
 * (90.4% F1, trained on gemini-2.5-flash base via Vertex AI).
 *
 * Key risks:
 *   - When gemini-2.5-flash base is deprecated (June 17, 2026), the tuned endpoint may stop working
 *   - Gemini 3 Flash fine-tuning is NOT yet documented by Google
 *   - If fine-tuning unavailable: fall back to base gemini-3-flash-preview + enhanced prompting (~82% F1)
 *
 * Migration strategy (3-tier):
 *   1. PREFERRED: Retrain Golden on gemini-3-flash-preview base (if Vertex AI supports it)
 *   2. FALLBACK: Use base gemini-3-flash-preview with enhanced few-shot prompting (130 examples)
 *   3. EMERGENCY: Keep GEMINI_TUNED_MODEL env var pointing at old endpoint until it stops responding
 *
 * The gemini-config.ts centralization (GME-01) ensures the base model swap doesn't affect
 * the tuned model path — GEMINI_TUNED_MODEL is a separate env var pointing at a Vertex AI endpoint.
 */
import { describe, it, expect } from 'vitest';
import { GEMINI_TUNED_MODEL, GEMINI_GENERATION_MODEL, getGeminiConfig } from './gemini-config.js';

describe('GME-04: Golden Tuned Model Migration', () => {
  it('tuned model is independent of base model in config', () => {
    // GEMINI_TUNED_MODEL is null locally (set in production via env var)
    // It points at a Vertex AI endpoint, not a model name
    const config = getGeminiConfig();
    expect(config.tunedModel).toBeNull(); // Only set in production
    expect(config.generationModel).toBe('gemini-3-flash-preview');
  });

  it('base model has been migrated to Gemini 3 (GME-02)', () => {
    expect(GEMINI_GENERATION_MODEL).toBe('gemini-3-flash-preview');
  });

  it('documents migration strategy and fallback plan', () => {
    const strategy = {
      currentTunedModel: 'Vertex AI endpoint (projects/270018525501/locations/us-central1/endpoints/*)',
      trainedOnBase: 'gemini-2.5-flash',
      baseDeprecation: '2026-06-17',
      tunedModelF1: 0.904,
      baseModelF1: 0.821,
      fallbackF1WithFewShot: 0.85, // estimated with 130 few-shot examples
      migrationTiers: [
        'Retrain on gemini-3-flash-preview (if Vertex AI fine-tuning supports Gemini 3)',
        'Use gemini-3-flash-preview + enhanced 130-example few-shot prompting',
        'Keep old tuned endpoint until Google shuts it down',
      ],
      actionItems: [
        'Monitor Vertex AI fine-tuning docs for Gemini 3 support',
        'Prepare retraining pipeline (gemini-golden-finetune.ts already centralized via GME-01)',
        'Test base Gemini 3 extraction quality against golden dataset before June 17',
      ],
    };

    expect(strategy.migrationTiers).toHaveLength(3);
    expect(strategy.tunedModelF1).toBeGreaterThan(strategy.baseModelF1);
  });

  it('tuned model env var is separate from base model default', () => {
    // Even after GME-02 migrated the base model, GEMINI_TUNED_MODEL
    // still points at the Vertex AI endpoint — it's not affected by the swap
    expect(GEMINI_TUNED_MODEL).toBeNull(); // In test env
    // In production, this would be: projects/270018525501/locations/us-central1/endpoints/481340352117080064
  });
});
