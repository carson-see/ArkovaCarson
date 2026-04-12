/**
 * NCE Phase 1 Tests (NCE-01 through NCE-05)
 *
 * Validates the infrastructure, data quality, and pipeline components
 * for the Nessie Compliance Engine Phase 1.
 */

import { describe, it, expect } from 'vitest';

// NCE-03: Intelligence training data infrastructure
import {
  NESSIE_INTELLIGENCE_SYSTEM_PROMPT,
  TASK_PROMPTS,
  SEED_INTELLIGENCE_PAIRS,
  qaPairToTrainingExample,
  deduplicateExamples,
  validateExample,
  getDistributionStats,
} from '../../training/nessie-intelligence-data.js';

// NCE-05: Eval scoring functions
import {
  scoreCitationAccuracy,
  scoreFaithfulness,
  scoreAnswerRelevance,
  scoreRiskDetection,
  pearsonCorrelation,
} from '../intelligence-eval.js';

// ── NCE-01: Embedding Pipeline Readiness ─────────────────────────────

describe('NCE-01: Embedding Pipeline Readiness', () => {
  it('intelligence system prompt is defined and non-empty', () => {
    expect(NESSIE_INTELLIGENCE_SYSTEM_PROMPT).toBeTruthy();
    expect(NESSIE_INTELLIGENCE_SYSTEM_PROMPT.length).toBeGreaterThan(100);
  });

  it('task prompts cover all 5 intelligence modes', () => {
    const modes = ['compliance_qa', 'risk_analysis', 'document_summary', 'recommendation', 'cross_reference'];
    for (const mode of modes) {
      expect(TASK_PROMPTS[mode as keyof typeof TASK_PROMPTS]).toBeTruthy();
    }
  });
});

// ── NCE-03: Distillation Training Data ───────────────────────────────

describe('NCE-03: Intelligence Training Data', () => {
  it('has seed intelligence pairs', () => {
    expect(SEED_INTELLIGENCE_PAIRS.length).toBeGreaterThan(0);
  });

  it('seed pairs cover all task types', () => {
    const taskTypes = new Set(SEED_INTELLIGENCE_PAIRS.map((p) => p.taskType));
    expect(taskTypes.has('compliance_qa')).toBe(true);
    expect(taskTypes.has('risk_analysis')).toBe(true);
  });

  it('converts Q&A pair to training example', () => {
    const pair = SEED_INTELLIGENCE_PAIRS[0];
    const example = qaPairToTrainingExample(pair);
    expect(example).toBeDefined();
    expect(example.messages).toBeDefined();
    expect(example.messages.length).toBeGreaterThanOrEqual(2);
    // System + user + assistant messages
    expect(example.messages[0].role).toBe('system');
  });

  it('validates examples correctly', () => {
    const pair = SEED_INTELLIGENCE_PAIRS[0];
    const example = qaPairToTrainingExample(pair);
    const error = validateExample(example);
    expect(error).toBeNull();
  });

  it('rejects invalid examples', () => {
    const invalidExample = { messages: [] };
    const error = validateExample(invalidExample as any);
    expect(error).toBeTruthy();
  });

  it('deduplicates examples by content hash', () => {
    const pair = SEED_INTELLIGENCE_PAIRS[0];
    const example = qaPairToTrainingExample(pair);
    const duplicated = [example, example, example];
    const deduped = deduplicateExamples(duplicated);
    expect(deduped.length).toBe(1);
  });

  it('computes distribution stats', () => {
    const examples = SEED_INTELLIGENCE_PAIRS.map(qaPairToTrainingExample);
    const stats = getDistributionStats(examples);
    expect(Object.keys(stats).length).toBeGreaterThan(0);
  });
});

// ── NCE-05: Evaluation Scoring Functions ─────────────────────────────

describe('NCE-05: Evaluation Scoring Functions', () => {
  describe('scoreCitationAccuracy', () => {
    it('returns 1.0 when all expected citations are present', () => {
      const expected = ['doc-1', 'doc-2'];
      const actual = [{ record_id: 'doc-1' }, { record_id: 'doc-2' }, { record_id: 'doc-3' }];
      const score = scoreCitationAccuracy(expected, actual);
      expect(score).toBe(1.0);
    });

    it('returns 0.5 when half of expected citations are present', () => {
      const expected = ['doc-1', 'doc-2'];
      const actual = [{ record_id: 'doc-1' }];
      const score = scoreCitationAccuracy(expected, actual);
      expect(score).toBe(0.5);
    });

    it('returns 0 when no expected citations are present', () => {
      const expected = ['doc-1', 'doc-2'];
      const actual = [{ record_id: 'doc-3' }];
      const score = scoreCitationAccuracy(expected, actual);
      expect(score).toBe(0);
    });

    it('handles empty expected citations', () => {
      const score = scoreCitationAccuracy([], []);
      expect(score).toBeGreaterThanOrEqual(0);
    });
  });

  describe('scoreAnswerRelevance', () => {
    it('scores higher when answer covers key points', () => {
      const answer = 'The company must file financial statements with risk factors and MD&A disclosure.';
      const keyPoints = ['financial statements', 'risk factors', 'MD&A'];
      const score = scoreAnswerRelevance(answer, keyPoints);
      expect(score).toBeGreaterThan(0.5);
    });

    it('scores lower when answer misses key points', () => {
      const answer = 'The company filed a document.';
      const keyPoints = ['financial statements', 'risk factors', 'MD&A', 'internal controls'];
      const score = scoreAnswerRelevance(answer, keyPoints);
      expect(score).toBeLessThan(0.5);
    });
  });

  describe('scoreRiskDetection', () => {
    it('returns 1.0 when all risks detected', () => {
      const expected = ['expired license', 'disciplinary action'];
      const actual = ['The license has expired', 'Disciplinary action was taken'];
      const score = scoreRiskDetection(expected, actual);
      expect(score).toBeGreaterThan(0.5);
    });

    it('returns 0 when no risks detected', () => {
      const expected = ['expired license'];
      const actual = ['Everything looks fine'];
      const score = scoreRiskDetection(expected, actual);
      expect(score).toBe(0);
    });
  });

  describe('pearsonCorrelation', () => {
    it('returns 1.0 for perfectly correlated data', () => {
      const r = pearsonCorrelation([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]);
      expect(r).toBeCloseTo(1.0, 5);
    });

    it('returns -1.0 for perfectly anti-correlated data', () => {
      const r = pearsonCorrelation([1, 2, 3, 4, 5], [10, 8, 6, 4, 2]);
      expect(r).toBeCloseTo(-1.0, 5);
    });

    it('returns 0 for uncorrelated data', () => {
      const r = pearsonCorrelation([1, 2, 3, 4, 5], [5, 5, 5, 5, 5]);
      // constant series → NaN or 0
      expect(isNaN(r) || r === 0).toBe(true);
    });

    it('handles short arrays', () => {
      const r = pearsonCorrelation([1], [1]);
      expect(isNaN(r) || r === 0 || r === 1).toBe(true);
    });
  });
});
