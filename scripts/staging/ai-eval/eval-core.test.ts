import { describe, it, expect } from 'vitest';

import {
  fieldsFromExtractResponse,
  scoreEntry,
  buildEvalRecord,
  buildExtractPayload,
  certifyRound,
  providerFromBody,
  type EvalRecord,
} from './eval-core.js';
import type { GoldenEntry } from './scoring.js';

const ENTRY: GoldenEntry = {
  id: 'GD-S3-CPE-001',
  description: 'clean CPE',
  strippedText: 'Certificate of CPE ... 8.0 CPE credits ... issued 2026-01-05',
  credentialTypeHint: 'CPE',
  issuerHint: 'Acme CPE Institute',
  groundTruth: { credentialType: 'CPE', creditHours: 8, issuedDate: '2026-01-05' },
  source: 'synthetic/s3-cpe-cle/cpe-001',
  category: 'professional-education',
  tags: ['synthetic', 's3-cpe-cle', 'cpe', 'clean'],
};

describe('buildExtractPayload', () => {
  it('maps a golden entry to the /ai/extract request shape with a 64-hex fingerprint', () => {
    const payload = buildExtractPayload(ENTRY);
    expect(payload.strippedText).toBe(ENTRY.strippedText);
    expect(payload.credentialType).toBe('CPE');
    expect(payload.issuerHint).toBe('Acme CPE Institute');
    expect(payload.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('derives a deterministic fingerprint from the entry id (stable across runs)', () => {
    expect(buildExtractPayload(ENTRY).fingerprint).toBe(buildExtractPayload(ENTRY).fingerprint);
  });
});

describe('fieldsFromExtractResponse', () => {
  it('pulls the flat fields map out of a successful /ai/extract body', () => {
    const body = { fields: { credentialType: 'CPE', creditHours: 8, issuedDate: '2026-01-05' }, confidence: 0.9 };
    expect(fieldsFromExtractResponse(body)).toEqual({ credentialType: 'CPE', creditHours: 8, issuedDate: '2026-01-05' });
  });
  it('returns an empty map when the body has no fields (error/gate response)', () => {
    expect(fieldsFromExtractResponse({ error: 'service_unavailable' })).toEqual({});
    expect(fieldsFromExtractResponse(undefined)).toEqual({});
  });
});

describe('scoreEntry', () => {
  it('produces a scored EntryEvalResult carrying the entry tags for gate matching', () => {
    const result = scoreEntry(ENTRY, { credentialType: 'CPE', creditHours: 8, issuedDate: '2026-01-05' });
    expect(result.entryId).toBe('GD-S3-CPE-001');
    expect(result.tags).toEqual(ENTRY.tags);
    const credType = result.fieldResults.find((f) => f.field === 'credentialType')!;
    expect(credType.correct).toBe(true);
  });
  it('records an extraction error so a dead AI path is visible, not silently 0-scored', () => {
    const result = scoreEntry(ENTRY, {}, 'circuit breaker open');
    expect(result.extractionError).toBe('circuit breaker open');
    // every ground-truth field reads as a miss
    expect(result.fieldResults.every((f) => !f.correct)).toBe(true);
  });
});

describe('buildEvalRecord', () => {
  it('assembles a rolling record with gate verdict, per-field P/R/F1, and misclassifications', () => {
    // 48 gate entries all correct → gate passes with weighted F1 = 1
    const scored = Array.from({ length: 48 }, (_, i) =>
      scoreEntry({ ...ENTRY, id: `GD-${i}` }, { credentialType: 'CPE', creditHours: 8, issuedDate: '2026-01-05' }),
    );
    const record = buildEvalRecord({
      sampledAt: '2026-07-07T00:00:00Z',
      apiBase: 'https://pr-1413---arkova-worker-staging.run.app',
      provider: 'gemini',
      scored,
    });
    expect(record.gate.gateId).toBe('SCRUM-2382');
    expect(record.gate.passed).toBe(true);
    expect(record.gate.weightedF1).toBe(1);
    expect(record.perField.credentialType.f1).toBe(1);
    expect(record.sampleCount).toBe(48);
    expect(record.misclassifications).toEqual([]);
    expect(record.provider).toBe('gemini');
  });

  it('captures up to N sample misclassifications for triage without dumping every entry', () => {
    // Wrong credentialType on 20 of 48 → field F1 drops below the 0.80 floor,
    // so the gate genuinely fails and we exercise the failing-gate record path.
    const scored = Array.from({ length: 48 }, (_, i) =>
      scoreEntry(
        { ...ENTRY, id: `GD-${i}` },
        { credentialType: i < 20 ? 'CLE' : 'CPE', creditHours: 8, issuedDate: '2026-01-05' },
      ),
    );
    const record = buildEvalRecord({
      sampledAt: '2026-07-07T00:00:00Z',
      apiBase: 'https://pr-1413---arkova-worker-staging.run.app',
      provider: 'gemini',
      scored,
      maxMisclassifications: 3,
    });
    expect(record.gate.passed).toBe(false);
    expect(record.perField.credentialType.passed).toBe(false);
    expect(record.misclassifications.length).toBe(3);
    expect(record.misclassifications[0]).toMatchObject({ field: 'credentialType', expected: 'CPE', actual: 'CLE' });
  });
});

describe('providerFromBody', () => {
  it('reads the server-reported provider', () => {
    expect(providerFromBody({ provider: 'gemini' })).toBe('gemini');
    expect(providerFromBody({ provider: 'mock' })).toBe('mock');
  });
  it('is "unknown" when absent', () => {
    expect(providerFromBody({})).toBe('unknown');
    expect(providerFromBody(undefined)).toBe('unknown');
  });
});

describe('certifyRound (real-vs-mock guard)', () => {
  const passingRecord: EvalRecord = {
    sampledAt: 'now', apiBase: 'x', provider: 'gemini', sampleCount: 48, gateSampleCount: 48,
    extractionErrorCount: 0,
    gate: {
      gateId: 'SCRUM-2382', label: 'x', blocksStory: 'SCRUM-2383', passed: true, reason: 'passed',
      matchingEntries: 48, minimumEntries: 48, weightedF1: 0.9, minimumWeightedF1: 0.8, fieldResults: [],
    },
    perField: {}, misclassifications: [],
  };

  it('merits a passing gate on a real Gemini provider', () => {
    const { merited, notes } = certifyRound(passingRecord, ['gemini'], true);
    expect(merited).toBe(true);
    expect(notes).toEqual([]);
  });

  it('REFUSES to merit a passing gate that ran on a mock provider under --require-live', () => {
    const { merited, notes } = certifyRound(passingRecord, ['mock'], true);
    expect(merited).toBe(false);
    expect(notes.join(' ')).toMatch(/non-live\/mock provider/);
    expect(notes.join(' ')).toMatch(/GEMINI_API_KEY/);
  });

  it('flags a mock provider even without --require-live (advisory note, still merited if gate passed)', () => {
    const { merited, notes } = certifyRound(passingRecord, ['mock'], false);
    expect(merited).toBe(true); // gate passed; note is advisory
    expect(notes.join(' ')).toMatch(/Non-live provider/);
  });

  it('never merits a failing gate regardless of provider', () => {
    const failing: EvalRecord = { ...passingRecord, gate: { ...passingRecord.gate, passed: false, reason: 'aggregate_threshold_failed' } };
    expect(certifyRound(failing, ['gemini'], false).merited).toBe(false);
  });

  it('notes extraction errors so a partly-dead AI path is visible', () => {
    const withErrors: EvalRecord = { ...passingRecord, extractionErrorCount: 4 };
    const { notes } = certifyRound(withErrors, ['gemini'], true);
    expect(notes.join(' ')).toMatch(/4 extraction error/);
  });
});
