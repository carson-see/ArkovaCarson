/**
 * NVI-13 — Canary routing + review + promotion-gate tests (SCRUM-817).
 *
 * Offline. Deterministic RNG injection lets us test the 5%-routing
 * behaviour without flakiness.
 */

import { describe, expect, it } from 'vitest';
import {
  type CanaryConfig,
  type CanaryReview,
  type CanaryShadowRecord,
  captureFailureAsScenario,
  promotionDecision,
  routeToCanary,
  summariseReviews,
} from './canary.js';

const CFG = (over: Partial<CanaryConfig> = {}): CanaryConfig => ({
  canaryPercent: 0.05,
  enabledDomains: ['fcra'],
  shadow: true,
  ...over,
});

describe('routeToCanary', () => {
  it('returns canary when RNG < canaryPercent', () => {
    const d = routeToCanary({ domain: 'fcra' }, CFG(), () => 0.02);
    expect(d.model).toBe('canary');
  });

  it('returns baseline when RNG >= canaryPercent', () => {
    const d = routeToCanary({ domain: 'fcra' }, CFG(), () => 0.99);
    expect(d.model).toBe('baseline');
  });

  it('returns baseline when domain is not enabled', () => {
    const d = routeToCanary({ domain: 'hipaa' }, CFG(), () => 0.0);
    expect(d.model).toBe('baseline');
    expect(d.reason).toMatch(/domain/i);
  });

  it('returns baseline when canaryPercent=0', () => {
    const d = routeToCanary({ domain: 'fcra' }, CFG({ canaryPercent: 0 }), () => 0.0);
    expect(d.model).toBe('baseline');
  });

  it('rejects canaryPercent out of [0,1]', () => {
    expect(() => routeToCanary({ domain: 'fcra' }, CFG({ canaryPercent: 1.5 }), () => 0.1)).toThrow(/canaryPercent/);
  });

  it('shadow is implied in the decision when shadow=true', () => {
    const d = routeToCanary({ domain: 'fcra' }, CFG({ shadow: true }), () => 0.99);
    expect(d.shadow).toBe(true);
  });

  it('shadow=false disables shadow logging', () => {
    const d = routeToCanary({ domain: 'fcra' }, CFG({ shadow: false }), () => 0.99);
    expect(d.shadow).toBe(false);
  });
});

describe('summariseReviews', () => {
  const reviews = (labels: CanaryReview['label'][]): CanaryReview[] =>
    labels.map((l, i) => ({
      shadowRecordId: `rec-${i}`,
      label: l,
      reviewerId: 'reviewer-1',
      reviewedAt: '2026-04-17',
      notes: '',
    }));

  it('counts by label', () => {
    const s = summariseReviews(reviews(['better', 'better', 'equal', 'worse', 'worse', 'worse']));
    expect(s.better).toBe(2);
    expect(s.equal).toBe(1);
    expect(s.worse).toBe(3);
    expect(s.total).toBe(6);
  });
});

describe('promotionDecision — canary ramp-up gate', () => {
  const mkReviews = (better: number, equal: number, worse: number): CanaryReview[] => {
    const out: CanaryReview[] = [];
    for (let i = 0; i < better; i++) out.push({ shadowRecordId: `b-${i}`, label: 'better', reviewerId: 'r', reviewedAt: '2026-04-17', notes: '' });
    for (let i = 0; i < equal; i++) out.push({ shadowRecordId: `e-${i}`, label: 'equal', reviewerId: 'r', reviewedAt: '2026-04-17', notes: '' });
    for (let i = 0; i < worse; i++) out.push({ shadowRecordId: `w-${i}`, label: 'worse', reviewerId: 'r', reviewedAt: '2026-04-17', notes: '' });
    return out;
  };

  it('holds when review sample is under the minimum', () => {
    // 50 reviews < minReviewed 100 → gate refuses regardless of match rate
    const d = promotionDecision(mkReviews(40, 5, 5), { minReviewed: 100, matchRatePct: 0.70, nextPercent: 0.25 });
    expect(d.canPromote).toBe(false);
    expect(d.reason).toMatch(/insufficient|minimum/i);
  });

  it('promotes when match rate (better+equal) meets the bar', () => {
    const d = promotionDecision(mkReviews(40, 35, 25), { minReviewed: 100, matchRatePct: 0.70, nextPercent: 0.25 });
    expect(d.canPromote).toBe(true);
    expect(d.nextPercent).toBe(0.25);
  });

  it('holds when match rate falls short of the bar', () => {
    const d = promotionDecision(mkReviews(30, 20, 50), { minReviewed: 100, matchRatePct: 0.70, nextPercent: 0.25 });
    expect(d.canPromote).toBe(false);
    expect(d.reason).toMatch(/match rate/i);
  });
});

describe('captureFailureAsScenario', () => {
  const shadow: CanaryShadowRecord = {
    id: 'shadow-1',
    query: 'Is our AA workflow compliant?',
    domain: 'fcra',
    category: 'adverse-action',
    baselineAnswer: {
      analysis: 'baseline says yes',
      citations: [{ record_id: 'fcra-615-a', quote: 'q', source: 'FCRA §615(a)' }],
      risks: ['r'],
      recommendations: ['rec'],
      confidence: 0.9,
      jurisdiction: 'federal',
      applicable_law: 'FCRA §615(a)',
    },
    canaryAnswer: {
      analysis: 'canary says no — missing elements',
      citations: [{ record_id: 'fcra-615-a', quote: 'q', source: 'FCRA §615(a)' }],
      risks: ['r-canary'],
      recommendations: ['rec-canary'],
      confidence: 0.8,
      jurisdiction: 'federal',
      applicable_law: 'FCRA §615(a)',
    },
    servedAt: '2026-04-17',
  };

  it('produces an IntelligenceScenario using the baseline answer (attorney-approved ground truth)', () => {
    const sc = captureFailureAsScenario(shadow);
    expect(sc.id).toMatch(/^prod-failure::shadow-1$/);
    expect(sc.category).toBe('adverse-action');
    expect(sc.query).toBe(shadow.query);
    // Default captures baseline answer as the "correct" answer the canary failed to match.
    expect(sc.expected).toBe(shadow.baselineAnswer);
  });

  it('allows overriding with a hand-crafted correct answer (NVI-05 tier-3 output)', () => {
    const corrected = { ...shadow.baselineAnswer, analysis: 'attorney-reviewed corrected' };
    const sc = captureFailureAsScenario(shadow, { correctAnswer: corrected });
    expect(sc.expected.analysis).toBe('attorney-reviewed corrected');
  });
});
