/**
 * Industry Benchmarking Tests (NCE-17)
 */

import { describe, it, expect } from 'vitest';
import { computeBenchmark, type BenchmarkInput } from './benchmarking.js';

describe('computeBenchmark', () => {
  it('computes percentile, average, and top quartile from scores', () => {
    const input: BenchmarkInput = {
      orgScore: 75,
      peerScores: [60, 65, 70, 80, 85, 90, 95],
    };
    const result = computeBenchmark(input);
    expect(result.percentile).toBeGreaterThan(0);
    expect(result.percentile).toBeLessThanOrEqual(100);
    expect(result.industry_average).toBeGreaterThan(0);
    expect(result.top_quartile_threshold).toBeGreaterThanOrEqual(result.industry_average);
  });

  it('returns null when fewer than 5 peers (privacy threshold)', () => {
    const input: BenchmarkInput = {
      orgScore: 75,
      peerScores: [60, 70, 80],
    };
    const result = computeBenchmark(input);
    expect(result).toBeNull();
  });

  it('handles org at bottom of distribution', () => {
    const input: BenchmarkInput = {
      orgScore: 30,
      peerScores: [50, 60, 70, 80, 90],
    };
    const result = computeBenchmark(input);
    expect(result).not.toBeNull();
    expect(result!.percentile).toBeLessThan(50);
  });

  it('handles org at top of distribution', () => {
    const input: BenchmarkInput = {
      orgScore: 98,
      peerScores: [50, 60, 70, 80, 90],
    };
    const result = computeBenchmark(input);
    expect(result).not.toBeNull();
    expect(result!.percentile).toBeGreaterThan(50);
  });

  it('computes correct average', () => {
    const input: BenchmarkInput = {
      orgScore: 70,
      peerScores: [60, 70, 80, 90, 100],
    };
    const result = computeBenchmark(input);
    expect(result).not.toBeNull();
    expect(result!.industry_average).toBe(80); // (60+70+80+90+100)/5
  });

  it('returns org_count reflecting peer count', () => {
    const input: BenchmarkInput = {
      orgScore: 70,
      peerScores: [60, 65, 70, 75, 80, 85, 90],
    };
    const result = computeBenchmark(input);
    expect(result).not.toBeNull();
    expect(result!.org_count).toBe(7);
  });
});
