/**
 * Tests for Eval Regression Baseline Metrics (NMT-13)
 */

import { describe, it, expect } from 'vitest';
import {
  checkRegression,
  formatRegressionReport,
  NESSIE_V5_BASELINE,
  GEMINI_GOLDEN_BASELINE,
  DEFAULT_THRESHOLDS,
  type BaselineMetrics,
  type RegressionThresholds,
} from './baseline-metrics.js';

describe('baseline-metrics', () => {
  // Helper to create metrics with overrides
  function makeMetrics(overrides: Partial<BaselineMetrics> = {}): BaselineMetrics {
    return {
      model: 'test-model',
      recordedAt: '2026-04-12T00:00:00.000Z',
      weightedF1: 0.872,
      macroF1: 0.757,
      ece: 0.110,
      confidenceCorrelation: 0.539,
      meanLatencyMs: 1500,
      evalSampleSize: 50,
      ...overrides,
    };
  }

  describe('checkRegression', () => {
    it('should pass when current equals baseline', () => {
      const baseline = makeMetrics();
      const current = makeMetrics();
      const result = checkRegression(baseline, current);
      expect(result.passed).toBe(true);
      expect(result.checks).toHaveLength(4);
      expect(result.checks.every(c => c.passed)).toBe(true);
    });

    it('should pass when current is better than baseline', () => {
      const baseline = makeMetrics();
      const current = makeMetrics({
        weightedF1: 0.90,
        ece: 0.08,
        confidenceCorrelation: 0.60,
        meanLatencyMs: 1200,
      });
      const result = checkRegression(baseline, current);
      expect(result.passed).toBe(true);
    });

    it('should pass when within threshold bounds', () => {
      const baseline = makeMetrics();
      // Drop 1.5pp in F1 (threshold is 2pp)
      const current = makeMetrics({ weightedF1: 0.857 });
      const result = checkRegression(baseline, current);
      expect(result.passed).toBe(true);
    });

    it('should fail when weighted F1 drops beyond threshold', () => {
      const baseline = makeMetrics({ weightedF1: 0.872 });
      // Drop 3pp (threshold is 2pp)
      const current = makeMetrics({ weightedF1: 0.842 });
      const result = checkRegression(baseline, current);
      expect(result.passed).toBe(false);
      const f1Check = result.checks.find(c => c.metric === 'weightedF1');
      expect(f1Check?.passed).toBe(false);
      expect(f1Check?.message).toContain('REGRESSION');
    });

    it('should fail when ECE increases beyond threshold', () => {
      const baseline = makeMetrics({ ece: 0.110 });
      // Increase 6pp (threshold is 5pp)
      const current = makeMetrics({ ece: 0.170 });
      const result = checkRegression(baseline, current);
      expect(result.passed).toBe(false);
      const eceCheck = result.checks.find(c => c.metric === 'ece');
      expect(eceCheck?.passed).toBe(false);
    });

    it('should fail when confidence correlation drops beyond threshold', () => {
      const baseline = makeMetrics({ confidenceCorrelation: 0.539 });
      // Drop 0.15 (threshold is 0.1)
      const current = makeMetrics({ confidenceCorrelation: 0.389 });
      const result = checkRegression(baseline, current);
      expect(result.passed).toBe(false);
      const corrCheck = result.checks.find(c => c.metric === 'confidenceCorrelation');
      expect(corrCheck?.passed).toBe(false);
    });

    it('should fail when latency exceeds factor threshold', () => {
      const baseline = makeMetrics({ meanLatencyMs: 1500 });
      // 2.5x slower (threshold is 2x)
      const current = makeMetrics({ meanLatencyMs: 3750 });
      const result = checkRegression(baseline, current);
      expect(result.passed).toBe(false);
      const latencyCheck = result.checks.find(c => c.metric === 'latency');
      expect(latencyCheck?.passed).toBe(false);
    });

    it('should fail if any single check fails', () => {
      const baseline = makeMetrics();
      // Only ECE regresses, everything else is fine
      const current = makeMetrics({ ece: 0.170 });
      const result = checkRegression(baseline, current);
      expect(result.passed).toBe(false);
      // Only ECE should fail
      const failedChecks = result.checks.filter(c => !c.passed);
      expect(failedChecks).toHaveLength(1);
      expect(failedChecks[0].metric).toBe('ece');
    });

    it('should respect custom thresholds', () => {
      const baseline = makeMetrics({ weightedF1: 0.872 });
      // Drop 3pp — would fail default (2pp) but pass with custom (5pp)
      const current = makeMetrics({ weightedF1: 0.842 });
      const lenientThresholds: RegressionThresholds = {
        ...DEFAULT_THRESHOLDS,
        maxWeightedF1Drop: 5.0,
      };
      const result = checkRegression(baseline, current, lenientThresholds);
      expect(result.passed).toBe(true);
    });

    it('should handle edge case: just within threshold', () => {
      const baseline = makeMetrics({ weightedF1: 0.870 });
      // Drop 1.9pp (threshold is 2pp — should pass)
      const current = makeMetrics({ weightedF1: 0.851 });
      const result = checkRegression(baseline, current);
      const f1Check = result.checks.find(c => c.metric === 'weightedF1');
      expect(f1Check?.passed).toBe(true);
    });
  });

  describe('stored baselines', () => {
    it('should have valid Nessie v5 baseline', () => {
      expect(NESSIE_V5_BASELINE.model).toBe('nessie-v5-fp16');
      expect(NESSIE_V5_BASELINE.weightedF1).toBe(0.872);
      expect(NESSIE_V5_BASELINE.evalSampleSize).toBe(100);
    });

    it('should have valid Gemini Golden baseline', () => {
      expect(GEMINI_GOLDEN_BASELINE.model).toBe('gemini-golden-v1');
      expect(GEMINI_GOLDEN_BASELINE.weightedF1).toBe(0.904);
    });

    it('should have Nessie v5 worse than Gemini Golden on F1', () => {
      expect(NESSIE_V5_BASELINE.weightedF1).toBeLessThan(GEMINI_GOLDEN_BASELINE.weightedF1);
    });

    it('should have Nessie v5 better confidence correlation than Gemini', () => {
      expect(NESSIE_V5_BASELINE.confidenceCorrelation).toBeGreaterThan(GEMINI_GOLDEN_BASELINE.confidenceCorrelation);
    });
  });

  describe('DEFAULT_THRESHOLDS', () => {
    it('should have sensible defaults', () => {
      expect(DEFAULT_THRESHOLDS.maxWeightedF1Drop).toBe(2.0);
      expect(DEFAULT_THRESHOLDS.maxECEIncrease).toBe(5.0);
      expect(DEFAULT_THRESHOLDS.maxConfCorrDrop).toBe(0.1);
      expect(DEFAULT_THRESHOLDS.maxLatencyFactor).toBe(2.0);
    });
  });

  describe('formatRegressionReport', () => {
    it('should format passing report', () => {
      const baseline = makeMetrics();
      const current = makeMetrics();
      const result = checkRegression(baseline, current);
      const report = formatRegressionReport(result);
      expect(report).toContain('PASSED');
      expect(report).toContain('test-model');
      expect(report).not.toContain('Failures');
    });

    it('should format failing report with failure details', () => {
      const baseline = makeMetrics({ weightedF1: 0.872 });
      const current = makeMetrics({ weightedF1: 0.800 });
      const result = checkRegression(baseline, current);
      const report = formatRegressionReport(result);
      expect(report).toContain('FAILED');
      expect(report).toContain('Failures');
      expect(report).toContain('REGRESSION');
    });

    it('should include markdown table', () => {
      const baseline = makeMetrics();
      const current = makeMetrics();
      const result = checkRegression(baseline, current);
      const report = formatRegressionReport(result);
      expect(report).toContain('| Metric |');
      expect(report).toContain('| weightedF1 |');
    });
  });
});
