/**
 * Calibration Regression Tests (Phase 2 — Confidence Calibration)
 *
 * Guards against regressions in calibration knots, per-type analysis,
 * and knot derivation. Tests run fast (no AI calls).
 */

import { describe, it, expect } from 'vitest';
import {
  analyzeCalibration,
  analyzeCalibrationByType,
  deriveCalibrationKnots,
  getCurrentCalibrationKnots,
  calibrateConfidence,
} from './calibration.js';
import type { EntryEvalResult } from './types.js';

function makeEntry(overrides: Partial<EntryEvalResult>): EntryEvalResult {
  return {
    entryId: 'test',
    credentialType: 'DEGREE',
    category: 'degree',
    tags: [],
    fieldResults: [],
    reportedConfidence: 0.85,
    actualAccuracy: 0.80,
    latencyMs: 100,
    provider: 'test',
    tokensUsed: 50,
    ...overrides,
  };
}

describe('Calibration Knots Integrity', () => {
  it('has exactly 7 knots', () => {
    const knots = getCurrentCalibrationKnots();
    expect(knots.length).toBe(7);
  });

  it('knots start at 0 and end at 1', () => {
    const knots = getCurrentCalibrationKnots();
    expect(knots[0][0]).toBe(0);
    expect(knots[knots.length - 1][0]).toBe(1);
  });

  it('knot x-values are strictly increasing', () => {
    const knots = getCurrentCalibrationKnots();
    for (let i = 1; i < knots.length; i++) {
      expect(knots[i][0]).toBeGreaterThan(knots[i - 1][0]);
    }
  });

  it('knot y-values are non-decreasing', () => {
    const knots = getCurrentCalibrationKnots();
    for (let i = 1; i < knots.length; i++) {
      expect(knots[i][1]).toBeGreaterThanOrEqual(knots[i - 1][1]);
    }
  });

  it('all calibrated values are in [0, 1]', () => {
    const knots = getCurrentCalibrationKnots();
    for (const [, y] of knots) {
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(1);
    }
  });

  it('calibration output is always in [0, 1]', () => {
    const inputs = [-1, -0.5, 0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 1.0, 1.5, 2];
    for (const input of inputs) {
      const result = calibrateConfidence(input);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(1);
    }
  });

  it('calibration is monotonically non-decreasing across full range', () => {
    const inputs = Array.from({ length: 101 }, (_, i) => i / 100);
    const outputs = inputs.map(calibrateConfidence);
    for (let i = 1; i < outputs.length; i++) {
      expect(
        outputs[i],
        `calibrateConfidence(${inputs[i]}) = ${outputs[i]} < calibrateConfidence(${inputs[i - 1]}) = ${outputs[i - 1]}`,
      ).toBeGreaterThanOrEqual(outputs[i - 1] - 0.001); // tiny epsilon for float
    }
  });

  it('calibration floor is >= 0.5 (model is never truly zero accuracy)', () => {
    expect(calibrateConfidence(0)).toBeGreaterThanOrEqual(0.5);
  });

  it('calibration ceiling is <= 0.98 (model never reaches perfect accuracy)', () => {
    expect(calibrateConfidence(1)).toBeLessThanOrEqual(0.98);
  });
});

describe('Per-Type Calibration Analysis', () => {
  it('returns empty for no entries', () => {
    const results = analyzeCalibrationByType([]);
    expect(results).toEqual([]);
  });

  it('groups entries by credential type', () => {
    const entries = [
      makeEntry({ credentialType: 'DEGREE', reportedConfidence: 0.9, actualAccuracy: 0.85 }),
      makeEntry({ credentialType: 'DEGREE', reportedConfidence: 0.8, actualAccuracy: 0.75 }),
      makeEntry({ credentialType: 'LICENSE', reportedConfidence: 0.7, actualAccuracy: 0.90 }),
      makeEntry({ credentialType: 'LICENSE', reportedConfidence: 0.6, actualAccuracy: 0.80 }),
    ];
    const results = analyzeCalibrationByType(entries);
    expect(results.length).toBe(2);

    const degree = results.find(r => r.credentialType === 'DEGREE')!;
    expect(degree.count).toBe(2);
    expect(degree.meanConfidence).toBeCloseTo(0.85, 2);
    expect(degree.meanAccuracy).toBeCloseTo(0.80, 2);
    expect(degree.gap).toBeCloseTo(0.05, 2); // slightly overconfident

    const license = results.find(r => r.credentialType === 'LICENSE')!;
    expect(license.count).toBe(2);
    expect(license.gap).toBeLessThan(0); // underconfident
  });

  it('skips types with < 2 entries (can\'t compute correlation)', () => {
    const entries = [
      makeEntry({ credentialType: 'DEGREE', reportedConfidence: 0.9, actualAccuracy: 0.85 }),
    ];
    const results = analyzeCalibrationByType(entries);
    expect(results.length).toBe(0);
  });

  it('sorts by gap (most underconfident first)', () => {
    const entries = [
      makeEntry({ credentialType: 'A', reportedConfidence: 0.9, actualAccuracy: 0.5 }),
      makeEntry({ credentialType: 'A', reportedConfidence: 0.8, actualAccuracy: 0.4 }),
      makeEntry({ credentialType: 'B', reportedConfidence: 0.3, actualAccuracy: 0.9 }),
      makeEntry({ credentialType: 'B', reportedConfidence: 0.2, actualAccuracy: 0.8 }),
    ];
    const results = analyzeCalibrationByType(entries);
    expect(results[0].credentialType).toBe('B'); // most underconfident
    expect(results[1].credentialType).toBe('A'); // most overconfident
  });
});

describe('Knot Derivation', () => {
  it('returns current knots when insufficient data', () => {
    const entries = [
      makeEntry({ reportedConfidence: 0.8, actualAccuracy: 0.7 }),
    ];
    const knots = deriveCalibrationKnots(entries);
    expect(knots).toEqual(getCurrentCalibrationKnots());
  });

  it('derives knots from well-distributed data', () => {
    // Generate 70 entries with known confidence-accuracy relationship
    const entries = Array.from({ length: 70 }, (_, i) => {
      const conf = i / 70;
      const acc = Math.min(conf + 0.05, 1.0); // slightly underconfident model
      return makeEntry({
        entryId: `derive-${i}`,
        reportedConfidence: conf,
        actualAccuracy: acc,
      });
    });

    const knots = deriveCalibrationKnots(entries, 7);
    expect(knots.length).toBe(7);

    // First knot should start at 0, last at 1
    expect(knots[0][0]).toBe(0);
    expect(knots[knots.length - 1][0]).toBe(1);
  });

  it('enforces monotonicity on derived knots', () => {
    // Create data where middle bucket has lower accuracy than lower bucket
    const entries: EntryEvalResult[] = [];
    // Low confidence, high accuracy (underconfident)
    for (let i = 0; i < 10; i++) {
      entries.push(makeEntry({
        entryId: `mono-low-${i}`,
        reportedConfidence: 0.1 + Math.random() * 0.1,
        actualAccuracy: 0.8,
      }));
    }
    // Medium confidence, low accuracy (overconfident)
    for (let i = 0; i < 10; i++) {
      entries.push(makeEntry({
        entryId: `mono-mid-${i}`,
        reportedConfidence: 0.4 + Math.random() * 0.1,
        actualAccuracy: 0.3,
      }));
    }
    // High confidence, high accuracy
    for (let i = 0; i < 10; i++) {
      entries.push(makeEntry({
        entryId: `mono-high-${i}`,
        reportedConfidence: 0.8 + Math.random() * 0.1,
        actualAccuracy: 0.9,
      }));
    }

    const knots = deriveCalibrationKnots(entries, 3);

    // Verify monotonicity
    for (let i = 1; i < knots.length; i++) {
      expect(knots[i][1]).toBeGreaterThanOrEqual(knots[i - 1][1]);
    }
  });

  it('derived knots produce values in [0, 1]', () => {
    const entries = Array.from({ length: 50 }, (_, i) =>
      makeEntry({
        entryId: `range-${i}`,
        reportedConfidence: Math.random(),
        actualAccuracy: Math.random(),
      }),
    );
    const knots = deriveCalibrationKnots(entries, 5);
    for (const [x, y] of knots) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(1);
    }
  });
});

describe('Calibration + Confidence Model Integration', () => {
  it('analyzeCalibration detects underconfident model patterns', () => {
    // Simulate the known issue: model reports ~0.76 avg but accuracy is ~0.94
    const entries = Array.from({ length: 100 }, (_, i) =>
      makeEntry({
        entryId: `undconf-${i}`,
        reportedConfidence: 0.70 + Math.random() * 0.12, // ~0.76 avg
        actualAccuracy: 0.90 + Math.random() * 0.08,     // ~0.94 avg
      }),
    );
    const result = analyzeCalibration(entries);
    expect(result.underconfidentBuckets.length).toBeGreaterThan(0);
    expect(result.recalibrationNeeded).toBe(true);
  });
});
