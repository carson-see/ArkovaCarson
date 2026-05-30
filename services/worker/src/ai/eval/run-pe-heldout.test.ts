import { describe, expect, it } from 'vitest';
import { runHeldoutEval, echoHeldoutGroundTruthExtractor } from './run-pe-heldout.js';
import { PROFESSIONAL_EDUCATION_HELDOUT } from './golden-dataset-pe-heldout.js';
import { MockAIProvider } from '../mock.js';

describe('run-pe-heldout (SCRUM-2200 Track A — held-out generalization measurement)', () => {
  it('evaluates every held-out entry', async () => {
    const result = await runHeldoutEval(new MockAIProvider(), echoHeldoutGroundTruthExtractor);
    expect(result.totalEntries).toBe(PROFESSIONAL_EDUCATION_HELDOUT.length);
    expect(result.entryResults).toHaveLength(PROFESSIONAL_EDUCATION_HELDOUT.length);
  });

  it('echo extractor scores near-perfect — proves the scoring wiring, not model quality', async () => {
    const result = await runHeldoutEval(new MockAIProvider(), echoHeldoutGroundTruthExtractor);
    expect(result.overall.weightedF1).toBeGreaterThan(0.99);
  });

  it('held-out set is exclusively held-out-tagged (no fixture/train contamination)', () => {
    expect(PROFESSIONAL_EDUCATION_HELDOUT.length).toBeGreaterThan(0);
    for (const entry of PROFESSIONAL_EDUCATION_HELDOUT) {
      expect(entry.tags).toContain('held-out');
    }
  });
});
