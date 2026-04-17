/**
 * NVI-10 — Adversarial + "I don't know" humility tests (SCRUM-814).
 *
 * Offline. Covers the validator that catches confidence + escalation
 * misalignment on refuse-to-answer scenarios.
 */

import { describe, expect, it } from 'vitest';
import { validateAdversarialAnswer, isEscalationRecommendation } from './adversarial';
import type { IntelligenceAnswer } from './types';

function mkAnswer(over: Partial<IntelligenceAnswer> = {}): IntelligenceAnswer {
  return {
    analysis: 'This is an open legal question…',
    citations: [{ record_id: 'fcra-604-a', quote: 'q', source: 'FCRA §604(a)' }],
    risks: ['open-question risk'],
    recommendations: ['Consult qualified FCRA counsel'],
    confidence: 0.6,
    jurisdiction: 'federal',
    applicable_law: 'FCRA §604(a)',
    should_refuse: true,
    escalation_trigger: true,
    ...over,
  };
}

describe('isEscalationRecommendation', () => {
  it('matches "consult … counsel"', () => {
    expect(isEscalationRecommendation('Consult qualified FCRA counsel.')).toBe(true);
  });

  it('matches "review with … expert"', () => {
    expect(isEscalationRecommendation('Review with a state-specific compliance expert.')).toBe(true);
  });

  it('matches "seek legal advice"', () => {
    expect(isEscalationRecommendation('Seek legal advice before proceeding.')).toBe(true);
  });

  it('returns false for regular imperative recommendations', () => {
    expect(isEscalationRecommendation('Classify each pull with a §604(a) purpose code.')).toBe(false);
  });
});

describe('validateAdversarialAnswer', () => {
  it('passes on a well-formed should_refuse answer', () => {
    expect(validateAdversarialAnswer(mkAnswer())).toEqual([]);
  });

  it('requires confidence ≤ 0.70 when should_refuse=true', () => {
    const errs = validateAdversarialAnswer(mkAnswer({ confidence: 0.9 }));
    expect(errs.join(' ')).toMatch(/confidence.*0\.70/);
  });

  it('requires at least one escalation-style recommendation when should_refuse=true', () => {
    const errs = validateAdversarialAnswer(
      mkAnswer({ recommendations: ['Just do X.'] }),
    );
    expect(errs.join(' ')).toMatch(/escalation/i);
  });

  it('requires escalation_trigger=true when should_refuse=true', () => {
    const errs = validateAdversarialAnswer(mkAnswer({ escalation_trigger: false }));
    expect(errs.join(' ')).toMatch(/escalation_trigger/);
  });

  it('passes non-adversarial answers without should_refuse as no-ops', () => {
    expect(validateAdversarialAnswer(mkAnswer({ should_refuse: false, escalation_trigger: false, confidence: 0.9 }))).toEqual([]);
  });

  it('passes when should_refuse omitted entirely (legacy scenarios)', () => {
    const { should_refuse: _unused, escalation_trigger: _unused2, ...legacy } = mkAnswer();
    expect(validateAdversarialAnswer(legacy as IntelligenceAnswer)).toEqual([]);
  });
});
