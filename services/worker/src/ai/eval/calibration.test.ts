/**
 * Tests for Confidence Calibration Analysis (AI-EVAL-02)
 */

import { describe, it, expect } from 'vitest';
import { analyzeCalibration, formatCalibrationReport, calibrateConfidence } from './calibration.js';
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

describe('analyzeCalibration', () => {
  it('returns empty result for no entries', () => {
    const result = analyzeCalibration([]);
    expect(result.isCalibrated).toBe(false);
    expect(result.recalibrationNeeded).toBe(true);
    expect(result.pearsonR).toBe(0);
  });

  it('detects well-calibrated model', () => {
    // Create entries where confidence closely matches accuracy
    const entries = [
      makeEntry({ reportedConfidence: 0.95, actualAccuracy: 0.93 }),
      makeEntry({ reportedConfidence: 0.90, actualAccuracy: 0.88 }),
      makeEntry({ reportedConfidence: 0.85, actualAccuracy: 0.82 }),
      makeEntry({ reportedConfidence: 0.70, actualAccuracy: 0.68 }),
      makeEntry({ reportedConfidence: 0.50, actualAccuracy: 0.48 }),
      makeEntry({ reportedConfidence: 0.30, actualAccuracy: 0.28 }),
      makeEntry({ reportedConfidence: 0.95, actualAccuracy: 0.90 }),
      makeEntry({ reportedConfidence: 0.80, actualAccuracy: 0.78 }),
      makeEntry({ reportedConfidence: 0.60, actualAccuracy: 0.55 }),
      makeEntry({ reportedConfidence: 0.40, actualAccuracy: 0.38 }),
    ];
    const result = analyzeCalibration(entries);
    expect(result.pearsonR).toBeGreaterThan(0.95);
    expect(result.isCalibrated).toBe(true);
    expect(result.recalibrationNeeded).toBe(false);
  });

  it('detects overconfident model', () => {
    // Confidence always high, accuracy varies
    const entries = [
      makeEntry({ reportedConfidence: 0.95, actualAccuracy: 0.30 }),
      makeEntry({ reportedConfidence: 0.92, actualAccuracy: 0.40 }),
      makeEntry({ reportedConfidence: 0.90, actualAccuracy: 0.25 }),
      makeEntry({ reportedConfidence: 0.88, actualAccuracy: 0.50 }),
      makeEntry({ reportedConfidence: 0.93, actualAccuracy: 0.35 }),
    ];
    const result = analyzeCalibration(entries);
    expect(result.overconfidentBuckets.length).toBeGreaterThan(0);
    expect(result.recalibrationNeeded).toBe(true);
  });

  it('computes ECE correctly', () => {
    const entries = [
      makeEntry({ reportedConfidence: 0.95, actualAccuracy: 0.95 }),
      makeEntry({ reportedConfidence: 0.85, actualAccuracy: 0.85 }),
    ];
    const result = analyzeCalibration(entries);
    // Perfect calibration = ECE near 0
    expect(result.expectedCalibrationError).toBeLessThan(0.05);
  });

  it('buckets entries correctly', () => {
    const entries = [
      makeEntry({ reportedConfidence: 0.95, actualAccuracy: 0.90 }),
      makeEntry({ reportedConfidence: 0.15, actualAccuracy: 0.10 }),
      makeEntry({ reportedConfidence: 0.55, actualAccuracy: 0.50 }),
    ];
    const result = analyzeCalibration(entries);
    const filledBuckets = result.buckets.filter(b => b.count > 0);
    expect(filledBuckets.length).toBe(3);
  });

  it('generates recalibration suggestions when needed', () => {
    // 50+ entries needed for prompt fix suggestions
    const entries = Array.from({ length: 60 }, (_, i) =>
      makeEntry({
        entryId: `test-${i}`,
        reportedConfidence: 0.90 + Math.random() * 0.1,
        actualAccuracy: 0.30 + Math.random() * 0.2,
      }),
    );
    const result = analyzeCalibration(entries);
    expect(result.recalibrationSuggestions.length).toBeGreaterThan(0);
    expect(result.recalibrationSuggestions.some(s => s.includes('PROMPT FIX'))).toBe(true);
  });
});

describe('calibrateConfidence', () => {
  it('maps raw 0.0 to floor value', () => {
    // New knots: floor = 0.76 (1030-entry dataset)
    expect(calibrateConfidence(0.0)).toBeCloseTo(0.76, 2);
  });

  it('maps raw 0.80 to ~0.92', () => {
    expect(calibrateConfidence(0.80)).toBeCloseTo(0.92, 2);
  });

  it('maps raw 0.90 to ~0.92 (ceiling)', () => {
    expect(calibrateConfidence(0.90)).toBeCloseTo(0.92, 2);
  });

  it('caps at 0.92 for raw 1.0', () => {
    expect(calibrateConfidence(1.0)).toBeCloseTo(0.92, 2);
  });

  it('interpolates between knots (raw 0.78 between 0.76→0.84 and 0.80→0.92)', () => {
    const result = calibrateConfidence(0.78);
    expect(result).toBeGreaterThan(0.84);
    expect(result).toBeLessThan(0.92);
    expect(result).toBeCloseTo(0.88, 2);
  });

  it('maps negative values to floor', () => {
    expect(calibrateConfidence(-0.5)).toBeCloseTo(0.76, 2);
  });

  it('maps values > 1 to cap', () => {
    expect(calibrateConfidence(1.5)).toBeCloseTo(0.92, 2);
  });

  it('is monotonically non-decreasing', () => {
    const values = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
    const calibrated = values.map(calibrateConfidence);
    for (let i = 1; i < calibrated.length; i++) {
      expect(calibrated[i]).toBeGreaterThanOrEqual(calibrated[i - 1]);
    }
  });
});

describe('formatCalibrationReport', () => {
  it('generates valid markdown', () => {
    const entries = [
      makeEntry({ reportedConfidence: 0.95, actualAccuracy: 0.90 }),
      makeEntry({ reportedConfidence: 0.50, actualAccuracy: 0.50 }),
    ];
    const cal = analyzeCalibration(entries);
    const report = formatCalibrationReport(cal);
    expect(report).toContain('# Confidence Calibration Report');
    expect(report).toContain('Calibration Status');
    expect(report).toContain('Pearson Correlation');
    expect(report).toContain('Calibration Table');
  });
});
