/**
 * Tests for Nessie Intelligence Evaluation (NMT-07, Phase E)
 */

import { describe, it, expect } from 'vitest';
import {
  scoreCitationAccuracy,
  scoreFaithfulness,
  scoreAnswerRelevance,
  scoreRiskDetection,
  pearsonCorrelation,
  aggregateResults,
} from './intelligence-eval.js';

describe('intelligence-eval', () => {
  describe('scoreCitationAccuracy', () => {
    it('returns 1.0 when all expected citations present', () => {
      expect(scoreCitationAccuracy(
        ['PR-001', 'PR-002'],
        [{ record_id: 'PR-001' }, { record_id: 'PR-002' }, { record_id: 'PR-003' }],
      )).toBe(1.0);
    });

    it('returns 0.5 when half of expected citations present', () => {
      expect(scoreCitationAccuracy(
        ['PR-001', 'PR-002'],
        [{ record_id: 'PR-001' }],
      )).toBe(0.5);
    });

    it('returns 0 when no expected citations present', () => {
      expect(scoreCitationAccuracy(
        ['PR-001'],
        [{ record_id: 'PR-999' }],
      )).toBe(0);
    });

    it('returns 1.0 when no citations expected', () => {
      expect(scoreCitationAccuracy([], [])).toBe(1.0);
    });
  });

  describe('scoreFaithfulness', () => {
    it('scores higher when answer words appear in context', () => {
      const answer = 'The company filed quarterly reports [PR-001] showing revenue growth.';
      const context = ['The company filed quarterly reports showing revenue growth of 15% year over year.'];
      expect(scoreFaithfulness(answer, context)).toBeGreaterThan(0.5);
    });

    it('returns 0 for empty answer', () => {
      expect(scoreFaithfulness('', ['some context'])).toBe(0);
    });

    // SCRUM-1281 (R3-8 sub-B): zero citations now grades 0, not 0.5. The
    // previous "0.5 = uncertain" floor graded a no-citation answer the same
    // as a 50%-grounded one — the recovery audit flagged this as a "free
    // quality" failure mode that obscured eval signal.
    it('returns 0 when answer has no citations (SCRUM-1281)', () => {
      expect(scoreFaithfulness('Some generic answer without citations.', ['context'])).toBe(0);
    });
  });

  describe('scoreAnswerRelevance', () => {
    it('scores 1.0 when all key points covered', () => {
      const answer = 'The filing shows compliance with quarterly reporting requirements and revenue disclosure.';
      const points = ['quarterly reporting', 'revenue disclosure'];
      expect(scoreAnswerRelevance(answer, points)).toBe(1.0);
    });

    it('scores 0.5 when half the key points covered', () => {
      const answer = 'The filing shows compliance with quarterly reporting.';
      const points = ['quarterly reporting', 'insider trading policy'];
      expect(scoreAnswerRelevance(answer, points)).toBe(0.5);
    });

    it('returns 1.0 when no key points expected', () => {
      expect(scoreAnswerRelevance('any answer', [])).toBe(1.0);
    });
  });

  describe('scoreRiskDetection', () => {
    it('scores 1.0 when all risks detected', () => {
      expect(scoreRiskDetection(
        ['expired credential', 'diploma mill'],
        ['The credential has expired', 'Known diploma mill detected'],
      )).toBe(1.0);
    });

    it('scores 0.5 when half the risks detected', () => {
      expect(scoreRiskDetection(
        ['expired credential', 'diploma mill'],
        ['The credential has expired'],
      )).toBe(0.5);
    });

    it('returns 1.0 when no risks expected', () => {
      expect(scoreRiskDetection([], ['false positive risk'])).toBe(1.0);
    });
  });

  describe('pearsonCorrelation', () => {
    it('returns 1.0 for perfect positive correlation', () => {
      expect(pearsonCorrelation([1, 2, 3, 4, 5], [2, 4, 6, 8, 10])).toBeCloseTo(1.0, 5);
    });

    it('returns -1.0 for perfect negative correlation', () => {
      expect(pearsonCorrelation([1, 2, 3, 4, 5], [10, 8, 6, 4, 2])).toBeCloseTo(-1.0, 5);
    });

    it('returns ~0 for uncorrelated data', () => {
      expect(Math.abs(pearsonCorrelation([1, 2, 3, 4, 5], [3, 1, 4, 1, 5]))).toBeLessThan(0.5);
    });

    it('returns 0 for insufficient data', () => {
      expect(pearsonCorrelation([1], [2])).toBe(0);
    });
  });

  describe('aggregateResults', () => {
    it('computes aggregate metrics from results', () => {
      const results = [
        { entryId: '1', citationAccuracy: 1.0, faithfulness: 0.9, answerRelevance: 0.8, riskDetectionRecall: 1.0, reportedConfidence: 0.85, actualQuality: 0.9, latencyMs: 1000, rawResponse: '' },
        { entryId: '2', citationAccuracy: 0.5, faithfulness: 0.7, answerRelevance: 0.6, riskDetectionRecall: 0.5, reportedConfidence: 0.6, actualQuality: 0.6, latencyMs: 2000, rawResponse: '' },
      ];
      const report = aggregateResults(results, 'test-model');
      expect(report.totalEntries).toBe(2);
      expect(report.metrics.meanCitationAccuracy).toBe(0.75);
      expect(report.metrics.meanFaithfulness).toBe(0.8);
      expect(report.metrics.meanAnswerRelevance).toBe(0.7);
      expect(report.model).toBe('test-model');
    });

    it('handles empty results', () => {
      const report = aggregateResults([], 'empty');
      expect(report.totalEntries).toBe(0);
      expect(report.metrics.meanCitationAccuracy).toBe(0);
    });
  });
});
