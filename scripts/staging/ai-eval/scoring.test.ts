import { describe, it, expect } from 'vitest';

import {
  compareField,
  compareFields,
  computeFieldMetrics,
  computeWeightedF1,
  evaluateGate,
  f1,
  matchesGate,
  SCRUM_2382_GATE,
  type EntryEvalResult,
} from './scoring.js';

// ── SCRUM-2382 gate config parity (pins vendored copy to #1413) ──────────────

describe('SCRUM-2382 gate config parity with eval-gates.ts (#1413)', () => {
  it('pins the exact gate identity, thresholds, and field floors', () => {
    expect(SCRUM_2382_GATE.gateId).toBe('SCRUM-2382');
    expect(SCRUM_2382_GATE.blocksStory).toBe('SCRUM-2383');
    expect(SCRUM_2382_GATE.minimumEntries).toBe(48);
    expect(SCRUM_2382_GATE.minimumWeightedF1).toBe(0.8);
    expect(SCRUM_2382_GATE.datasetTag).toBe('s3-cpe-cle');
    expect(SCRUM_2382_GATE.requiredFields).toEqual([
      { field: 'creditHours', minimumF1: 0.85 },
      { field: 'issuedDate', minimumF1: 0.8 },
      { field: 'credentialType', minimumF1: 0.8 },
    ]);
  });
});

// ── f1 math ──────────────────────────────────────────────────────────────────

describe('f1', () => {
  it('is 1 for perfect precision+recall', () => {
    expect(f1(10, 0, 0)).toBe(1);
  });
  it('is 0 when there are no true positives', () => {
    expect(f1(0, 5, 5)).toBe(0);
  });
  it('computes the harmonic mean of precision and recall', () => {
    // TP=8, FP=2 (P=0.8), FN=2 (R=0.8) → F1=0.8
    expect(f1(8, 2, 2)).toBeCloseTo(0.8, 10);
  });
});

// ── compareField semantics (parity with scoring.ts) ──────────────────────────

describe('compareField', () => {
  it('counts both-missing as missing_both (true positive credit)', () => {
    expect(compareField('issuerName', undefined, undefined).matchType).toBe('missing_both');
  });
  it('flags expected-present/actual-missing as false_negative', () => {
    const r = compareField('credentialType', 'CPE', undefined);
    expect(r.correct).toBe(false);
    expect(r.matchType).toBe('false_negative');
  });
  it('flags expected-missing/actual-present as false_positive', () => {
    const r = compareField('courseId', undefined, 'X-1');
    expect(r.matchType).toBe('false_positive');
  });
  it('compares numeric creditHours by value, not string', () => {
    expect(compareField('creditHours', 8, '8').correct).toBe(true);
    expect(compareField('creditHours', 8, 7).correct).toBe(false);
  });
  it('normalizes issuedDate to zero-padded YYYY-MM-DD', () => {
    expect(compareField('issuedDate', '2026-1-5', '2026-01-05').correct).toBe(true);
  });
  it('mismatches a wrong credentialType', () => {
    expect(compareField('credentialType', 'CPE', 'CLE').matchType).toBe('mismatch');
  });
  it('normalizes case/whitespace for string fields', () => {
    expect(compareField('nasbaStatus', 'Approved', 'approved').correct).toBe(true);
  });
});

// ── compareFields only scores ALL_FIELDS, skips both-absent ──────────────────

describe('compareFields', () => {
  it('scores only known fields and skips fields absent from both sides', () => {
    const results = compareFields(
      { credentialType: 'CPE', creditHours: 8 },
      { credentialType: 'CPE', creditHours: 8, subType: 'ignored', foo: 'bar' },
    );
    const fields = results.map((r) => r.field);
    expect(fields).toContain('credentialType');
    expect(fields).toContain('creditHours');
    // extra/unknown keys are never scored
    expect(fields).not.toContain('subType');
    expect(fields).not.toContain('foo');
  });
});

// ── gate evaluation (fail-closed) ────────────────────────────────────────────

function perfectEntry(id: string, extraTags: string[] = []): EntryEvalResult {
  return {
    entryId: id,
    tags: ['synthetic', 's3-cpe-cle', 'cpe', 'clean', ...extraTags],
    fieldResults: [
      { field: 'credentialType', expected: 'CPE', actual: 'CPE', correct: true, matchType: 'exact' },
      { field: 'creditHours', expected: 8, actual: 8, correct: true, matchType: 'exact' },
      { field: 'issuedDate', expected: '2026-01-05', actual: '2026-01-05', correct: true, matchType: 'exact' },
    ],
  };
}

describe('evaluateGate (SCRUM-2382)', () => {
  it('fails on dataset coverage when < 48 matching gate entries', () => {
    const entries = Array.from({ length: 10 }, (_, i) => perfectEntry(`E-${i}`));
    const result = evaluateGate(entries);
    expect(result.passed).toBe(false);
    expect(result.reason).toBe('dataset_coverage_missing');
    expect(result.matchingEntries).toBe(10);
  });

  it('excludes held-out entries from the gate split', () => {
    const gate = Array.from({ length: 48 }, (_, i) => perfectEntry(`G-${i}`));
    const held = Array.from({ length: 12 }, (_, i) => perfectEntry(`H-${i}`, ['held-out']));
    expect(gate.every(matchesGate)).toBe(true);
    expect(held.every(matchesGate)).toBe(false);
    const result = evaluateGate([...gate, ...held]);
    expect(result.matchingEntries).toBe(48);
    expect(result.passed).toBe(true);
    expect(result.reason).toBe('passed');
    expect(result.weightedF1).toBe(1);
  });

  it('fails a per-field floor even when aggregate F1 clears 0.80', () => {
    // 48 entries: creditHours wrong on 20 of them → field F1 drops below 0.85
    // but the two other fields stay perfect so aggregate stays high.
    const entries = Array.from({ length: 48 }, (_, i) => {
      const e = perfectEntry(`F-${i}`);
      if (i < 20) {
        e.fieldResults[1] = {
          field: 'creditHours', expected: 8, actual: 7, correct: false, matchType: 'mismatch',
        };
      }
      return e;
    });
    const result = evaluateGate(entries);
    const creditHours = result.fieldResults.find((f) => f.field === 'creditHours')!;
    expect(creditHours.f1).toBeLessThan(0.85);
    expect(result.passed).toBe(false);
    expect(result.reason).toBe('field_threshold_failed');
  });
});

describe('computeFieldMetrics / computeWeightedF1', () => {
  it('reports per-field precision, recall, and F1', () => {
    const entries: EntryEvalResult[] = [
      {
        entryId: 'A', tags: ['s3-cpe-cle'],
        fieldResults: [{ field: 'credentialType', expected: 'CPE', actual: 'CPE', correct: true, matchType: 'exact' }],
      },
      {
        entryId: 'B', tags: ['s3-cpe-cle'],
        fieldResults: [{ field: 'credentialType', expected: 'CPE', actual: 'CLE', correct: false, matchType: 'mismatch' }],
      },
    ];
    const m = computeFieldMetrics(entries, 'credentialType');
    expect(m.truePositives).toBe(1);
    expect(m.falsePositives).toBe(1);
    expect(m.precision).toBeCloseTo(0.5, 10);
    expect(m.recall).toBe(1);
  });

  it('treats missing_both as a true positive in the aggregate (upstream caveat)', () => {
    const entries: EntryEvalResult[] = [
      {
        entryId: 'A', tags: ['s3-cpe-cle'],
        fieldResults: [{ field: 'expiryDate', expected: undefined, actual: undefined, correct: true, matchType: 'missing_both' }],
      },
    ];
    expect(computeWeightedF1(entries)).toBe(1);
  });
});
