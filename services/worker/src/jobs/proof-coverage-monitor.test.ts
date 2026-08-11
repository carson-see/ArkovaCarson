/**
 * Tests for the proof-coverage regression monitor (SCRUM-3187).
 *
 * The monitor watches the FORWARD path only: are anchors secured in the recent
 * window getting their per-document proof? The ~2.97M historical backlog is a
 * known, separately-tracked constant — folding it in would keep the alarm
 * permanently red and therefore permanently ignored.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MIN_COVERAGE_RATIO,
  DEFAULT_MIN_SAMPLE,
  evaluateProofCoverage,
} from './proof-coverage-monitor.js';

const base = {
  windowHours: 24,
  minCoverageRatio: DEFAULT_MIN_COVERAGE_RATIO,
  minSampleSize: DEFAULT_MIN_SAMPLE,
};

describe('evaluateProofCoverage', () => {
  it('stays silent when the forward path is fully covered', () => {
    const d = evaluateProofCoverage({ ...base, securedInWindow: 5_000, proofsInWindow: 5_000 });
    expect(d.shouldFire).toBe(false);
    expect(d.coverageRatio).toBe(1);
    expect(d.reason).toBe('healthy');
  });

  it('stays silent when nothing was secured in the window', () => {
    // No anchors to cover is not a coverage failure.
    const d = evaluateProofCoverage({ ...base, securedInWindow: 0, proofsInWindow: 0 });
    expect(d.shouldFire).toBe(false);
    expect(d.reason).toBe('no_anchors_in_window');
  });

  it('does not fire on a statistically meaningless sample', () => {
    const d = evaluateProofCoverage({ ...base, securedInWindow: 3, proofsInWindow: 0 });
    expect(d.shouldFire).toBe(false);
    expect(d.reason).toBe('insufficient_sample');
  });

  it('fires when coverage drops below the threshold', () => {
    const d = evaluateProofCoverage({ ...base, securedInWindow: 1_000, proofsInWindow: 900 });
    expect(d.shouldFire).toBe(true);
    expect(d.coverageRatio).toBeCloseTo(0.9, 5);
    expect(d.reason).toBe('coverage_below_threshold');
  });

  it('escalates to error severity on a severe regression', () => {
    const warn = evaluateProofCoverage({ ...base, securedInWindow: 1_000, proofsInWindow: 970 });
    expect(warn.severity).toBe('warning');

    const err = evaluateProofCoverage({ ...base, securedInWindow: 1_000, proofsInWindow: 100 });
    expect(err.severity).toBe('error');
  });

  it('treats a total forward-path outage as the most severe case', () => {
    const d = evaluateProofCoverage({ ...base, securedInWindow: 2_000, proofsInWindow: 0 });
    expect(d.shouldFire).toBe(true);
    expect(d.severity).toBe('error');
    expect(d.coverageRatio).toBe(0);
  });

  it('never reports a ratio above 1 even if proofs outnumber anchors', () => {
    // Can happen transiently while a batch is mid-write; must not read as a
    // negative coverage deficit.
    const d = evaluateProofCoverage({ ...base, securedInWindow: 100, proofsInWindow: 140 });
    expect(d.coverageRatio).toBe(1);
    expect(d.shouldFire).toBe(false);
  });

  it('is exactly at threshold => healthy, not firing', () => {
    const d = evaluateProofCoverage({
      ...base,
      minCoverageRatio: 0.99,
      securedInWindow: 10_000,
      proofsInWindow: 9_900,
    });
    expect(d.coverageRatio).toBeCloseTo(0.99, 6);
    expect(d.shouldFire).toBe(false);
  });

  it('reports the deficit so the alert can say how many records are affected', () => {
    const d = evaluateProofCoverage({ ...base, securedInWindow: 1_000, proofsInWindow: 940 });
    expect(d.missingCount).toBe(60);
  });

  it('defaults are strict enough to catch a real regression', () => {
    // A 1-in-100 miss on the forward path is already a broken promise.
    expect(DEFAULT_MIN_COVERAGE_RATIO).toBeGreaterThanOrEqual(0.99);
    expect(DEFAULT_MIN_SAMPLE).toBeGreaterThan(0);
  });
});
