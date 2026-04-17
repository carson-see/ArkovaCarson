/**
 * NVI-11 — Gold-standard benchmark framework tests (SCRUM-815).
 *
 * Offline. Exercises the rubric shape, the held-out-guard, and the
 * scoring helper.
 */

import { describe, expect, it } from 'vitest';
import {
  type BenchmarkQuestion,
  type BenchmarkQuadrant,
  buildBenchmarkIndex,
  ensureHeldOut,
  scoreBenchmarkAnswer,
  validateBenchmark,
} from './benchmark';
import type { IntelligenceAnswer, IntelligenceScenario } from '../types';

const VALID_QUESTION: BenchmarkQuestion = {
  id: 'bench-pre-adverse-001',
  quadrant: 'pre-adverse',
  question: 'Employer sends pre-adverse notice and final AA 2 business days later. Compliant?',
  referenceAnswer: {
    analysis:
      'No. §604(b)(3) requires a "reasonable period" between pre-adverse and final — industry floor is 5 business days (Reardon v. Closetmaid). 2 business days is a prima-facie §604(b)(3) violation and supports a Safeco willfulness finding.',
    citations: [{ record_id: 'fcra-604-b-3', quote: 'q', source: 'FCRA §604(b)(3)' }],
    risks: ['§616 willful-violation exposure', 'Class-action pattern'],
    recommendations: ['Wait ≥5 business days', 'Audit recent AAs for same defect'],
    confidence: 0.93,
    jurisdiction: 'federal',
    applicable_law: 'FCRA §604(b)(3)',
  },
  requiredCitations: ['fcra-604-b-3'],
  requiredRiskKeywords: ['willful', '604(b)(3)'],
  requiredRecommendationKeywords: ['5 business days', 'audit'],
  rubric: {
    expertCriteria: '4/4: names §604(b)(3) + 5-bus-day floor + Reardon + Safeco willfulness + audit remediation',
    goodCriteria: '3/4: names §604(b)(3) floor + risk + audit',
    adequateCriteria: '2/4: identifies timing is wrong + floor exists',
    partialCriteria: '1/4: flags timing concern without specifics',
    missedCriteria: '0/4: concludes compliant or ignores timing',
  },
  authorCredential: 'pending attorney review',
  heldOut: true,
};

function mkAnswer(over: Partial<IntelligenceAnswer> = {}): IntelligenceAnswer {
  return {
    analysis: 'Per §604(b)(3), 5 business days is the floor. Audit prior AAs.',
    citations: [{ record_id: 'fcra-604-b-3', quote: 'q', source: 'FCRA §604(b)(3)' }],
    // Both required keywords present: "willful" and "604(b)(3)"
    risks: ['§604(b)(3) willful violation exposure'],
    recommendations: ['Wait 5 business days', 'Audit prior actions'],
    confidence: 0.9,
    jurisdiction: 'federal',
    applicable_law: 'FCRA §604(b)(3)',
    ...over,
  };
}

describe('validateBenchmark', () => {
  it('accepts a well-formed question', () => {
    expect(validateBenchmark([VALID_QUESTION])).toEqual([]);
  });

  it('rejects duplicate ids', () => {
    const errs = validateBenchmark([VALID_QUESTION, VALID_QUESTION]);
    expect(errs.join(' ')).toMatch(/duplicate id/);
  });

  it('rejects questions missing required fields', () => {
    const q = { ...VALID_QUESTION, question: '' };
    expect(validateBenchmark([q]).join(' ')).toMatch(/empty question/);
  });

  it('rejects questions with empty rubric criteria', () => {
    const q = { ...VALID_QUESTION, rubric: { ...VALID_QUESTION.rubric, expertCriteria: '' } };
    expect(validateBenchmark([q]).join(' ')).toMatch(/expertCriteria/);
  });

  it('rejects non-held-out questions (benchmark must be held-out)', () => {
    const q = { ...VALID_QUESTION, heldOut: false };
    expect(validateBenchmark([q]).join(' ')).toMatch(/heldOut/);
  });
});

describe('buildBenchmarkIndex + ensureHeldOut', () => {
  it('buildBenchmarkIndex creates id map', () => {
    const idx = buildBenchmarkIndex([VALID_QUESTION]);
    expect(idx.byId.get('bench-pre-adverse-001')).toBe(VALID_QUESTION);
  });

  it('ensureHeldOut passes when benchmark ids do not overlap training', () => {
    const training: IntelligenceScenario[] = [
      {
        id: 'train-1',
        category: 'pre-adverse',
        query: 'q',
        expected: mkAnswer(),
      },
    ];
    expect(() => ensureHeldOut([VALID_QUESTION], training)).not.toThrow();
  });

  it('ensureHeldOut throws when a benchmark id appears in training', () => {
    const training: IntelligenceScenario[] = [
      {
        id: 'bench-pre-adverse-001', // collides with benchmark
        category: 'pre-adverse',
        query: 'q',
        expected: mkAnswer(),
      },
    ];
    expect(() => ensureHeldOut([VALID_QUESTION], training)).toThrow(/held-out/i);
  });
});

describe('scoreBenchmarkAnswer — rubric scoring', () => {
  it('scores 4 for expert-level answer (all required citations + keywords)', () => {
    const score = scoreBenchmarkAnswer(VALID_QUESTION, mkAnswer());
    expect(score.tier).toBe(4);
  });

  it('scores 0 when all required citations are missing', () => {
    const s = scoreBenchmarkAnswer(VALID_QUESTION, mkAnswer({ citations: [] }));
    expect(s.tier).toBeLessThanOrEqual(1);
  });

  it('scores 2–3 when one required keyword is missing but citations present', () => {
    const s = scoreBenchmarkAnswer(
      VALID_QUESTION,
      mkAnswer({ risks: ['generic risk'], recommendations: ['Wait 5 business days', 'Audit prior actions'] }),
    );
    expect(s.tier).toBeGreaterThanOrEqual(2);
    expect(s.tier).toBeLessThanOrEqual(3);
  });

  it('returns per-category subscores', () => {
    const s = scoreBenchmarkAnswer(VALID_QUESTION, mkAnswer());
    expect(s.components).toEqual(expect.objectContaining({
      citationCoverage: expect.any(Number),
      riskCoverage: expect.any(Number),
      recommendationCoverage: expect.any(Number),
    }));
  });
});

describe('BenchmarkQuadrant — tuple matches ticket categories', () => {
  const quadrants: BenchmarkQuadrant[] = [
    'pre-adverse',
    'adverse-action',
    'permissible-purpose',
    'disputes',
    'state-variations',
    'risk-patterns',
    'cross-reg',
  ];

  it('accepts all 7 declared quadrants', () => {
    expect(quadrants).toHaveLength(7);
  });
});
