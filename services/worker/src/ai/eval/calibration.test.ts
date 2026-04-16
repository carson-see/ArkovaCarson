/**
 * Tests for Confidence Calibration Analysis (AI-EVAL-02)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

describe('calibrateConfidence (v6 branch — SCRUM-794 / GME2-03)', () => {
  // v6 knots derived 2026-04-16 from stratified eval (n=249, Pearson r=0.26).
  // Gated by GEMINI_V6_PROMPT=true env var. Floor 0.67, ceiling 0.82.

  const savedEnv = process.env.GEMINI_V6_PROMPT;
  beforeEach(() => {
    process.env.GEMINI_V6_PROMPT = 'true';
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.GEMINI_V6_PROMPT;
    else process.env.GEMINI_V6_PROMPT = savedEnv;
  });

  it('maps raw 0.0 to v6 floor (0.67)', () => {
    expect(calibrateConfidence(0.0)).toBeCloseTo(0.67, 2);
  });

  it('maps raw 0.48 (low-mid) to calibrated 0.79', () => {
    expect(calibrateConfidence(0.48)).toBeCloseTo(0.79, 2);
  });

  it('maps raw 0.6 to around 0.80-0.82', () => {
    const r = calibrateConfidence(0.6);
    expect(r).toBeGreaterThanOrEqual(0.80);
    expect(r).toBeLessThanOrEqual(0.82);
  });

  it('caps raw 1.0 at v6 ceiling (0.82)', () => {
    expect(calibrateConfidence(1.0)).toBeCloseTo(0.82, 2);
  });

  it('is monotonically non-decreasing under v6 knots', () => {
    const values = [0.0, 0.1, 0.3, 0.48, 0.53, 0.6, 0.7, 0.9, 1.0];
    const calibrated = values.map(calibrateConfidence);
    for (let i = 1; i < calibrated.length; i++) {
      expect(calibrated[i]).toBeGreaterThanOrEqual(calibrated[i - 1]);
    }
  });

  it('lifts mean raw-~0.55 confidence to ~0.80 (matches stratified eval mean accuracy 78.3%)', () => {
    // Real v6 raw confidences cluster around 0.50-0.60; calibrated should land near 0.80.
    const rawSamples = [0.48, 0.50, 0.52, 0.53, 0.55, 0.56, 0.58, 0.60];
    const calibrated = rawSamples.map(calibrateConfidence);
    const meanCalibrated = calibrated.reduce((s, v) => s + v, 0) / calibrated.length;
    expect(meanCalibrated).toBeGreaterThan(0.78);
    expect(meanCalibrated).toBeLessThan(0.82);
  });

  it('falls back to v5 knots when GEMINI_V6_PROMPT is unset', () => {
    process.env.GEMINI_V6_PROMPT = 'false';
    expect(calibrateConfidence(0.0)).toBeCloseTo(0.76, 2); // v5 floor, not 0.67
    expect(calibrateConfidence(1.0)).toBeCloseTo(0.92, 2); // v5 ceiling, not 0.82
  });
});

describe('calibrateNessieConfidence', () => {
  // NMT-03: Nessie models are severely overconfident (85-90% reported, 34-46% actual)
  // These tests verify the Nessie-specific calibration curve maps scores DOWN.

  it('maps raw 0.87 (typical Nessie output) to ~0.40 actual accuracy', async () => {
    const { calibrateNessieConfidence } = await import('./calibration.js');
    const result = calibrateNessieConfidence(0.87);
    expect(result).toBeGreaterThan(0.35);
    expect(result).toBeLessThan(0.45);
  });

  it('maps raw 0.90 to ~0.45', async () => {
    const { calibrateNessieConfidence } = await import('./calibration.js');
    expect(calibrateNessieConfidence(0.90)).toBeCloseTo(0.45, 2);
  });

  it('maps raw 0.85 to ~0.38', async () => {
    const { calibrateNessieConfidence } = await import('./calibration.js');
    expect(calibrateNessieConfidence(0.85)).toBeCloseTo(0.38, 2);
  });

  it('caps at 0.58 for raw 1.0', async () => {
    const { calibrateNessieConfidence } = await import('./calibration.js');
    expect(calibrateNessieConfidence(1.0)).toBeCloseTo(0.58, 2);
  });

  it('maps raw 0.0 to floor 0.10', async () => {
    const { calibrateNessieConfidence } = await import('./calibration.js');
    expect(calibrateNessieConfidence(0.0)).toBeCloseTo(0.10, 2);
  });

  it('is monotonically non-decreasing', async () => {
    const { calibrateNessieConfidence } = await import('./calibration.js');
    const values = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 1.0];
    const calibrated = values.map(calibrateNessieConfidence);
    for (let i = 1; i < calibrated.length; i++) {
      expect(calibrated[i]).toBeGreaterThanOrEqual(calibrated[i - 1]);
    }
  });

  it('always returns values less than corresponding Gemini calibration', async () => {
    const { calibrateNessieConfidence, calibrateConfidence } = await import('./calibration.js');
    // Nessie calibrated confidence should always be lower than Gemini
    // (Nessie is overconfident, Gemini is underconfident)
    const testPoints = [0.5, 0.7, 0.8, 0.85, 0.9, 0.95, 1.0];
    for (const raw of testPoints) {
      expect(calibrateNessieConfidence(raw)).toBeLessThan(calibrateConfidence(raw));
    }
  });

  it('negative values return floor', async () => {
    const { calibrateNessieConfidence } = await import('./calibration.js');
    expect(calibrateNessieConfidence(-0.5)).toBeCloseTo(0.10, 2);
  });

  it('values > 1 return cap', async () => {
    const { calibrateNessieConfidence } = await import('./calibration.js');
    expect(calibrateNessieConfidence(1.5)).toBeCloseTo(0.58, 2);
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
