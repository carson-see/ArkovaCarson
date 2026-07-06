/**
 * AI-02 (SCRUM-2382) — deterministic F1 eval gate for the S3 CPE/CLE set.
 *
 * The `fixture` provider mode REPLAYS recorded model outputs from a committed
 * fixture file — zero live model calls in the CI path. Gate logic: aggregate
 * weighted F1 >= 0.80 AND per-critical-field floors (creditHours, issuedDate,
 * credentialType) — fail below either. The held-out leakage check from AI-01 is
 * a precondition of the s3 dataset run. Reports carry field NAMES + scores
 * only — never fixture field values.
 */

import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEval } from './runner.js';
import { evaluateEvalGates, EVAL_GATE_CONFIGS } from './eval-gates.js';
import {
  resolveRequestedGates,
  resolveDataset,
  loadRecordedOutputs,
  createFixtureReplayExtractor,
  buildRecordedOutputsFromGroundTruth,
  formatGateReport,
  checkS3LeakagePrecondition,
  S3_RECORDED_OUTPUTS_DEFAULT_PATH,
  type RecordedOutputs,
} from './run-pe-gates.js';
import {
  CPE_CLE_S3_GATE_ENTRIES,
  GOLDEN_DATASET_CPE_CLE_S3,
} from './golden-dataset-cpe-cle-s3.js';
import { MockAIProvider } from '../mock.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = resolve(__dirname, '..', '..', '..');

describe('SCRUM-2382 gate config', () => {
  const gate = EVAL_GATE_CONFIGS.find((g) => g.gateId === 'SCRUM-2382');

  it('exists with aggregate F1 >= 0.80 and the three critical-field floors', () => {
    expect(gate).toBeDefined();
    expect(gate!.minimumWeightedF1).toBeGreaterThanOrEqual(0.8);
    const fields = Object.fromEntries(gate!.requiredFields.map((f) => [f.field, f.minimumF1]));
    expect(fields.creditHours).toBeGreaterThanOrEqual(0.8);
    expect(fields.issuedDate).toBeGreaterThanOrEqual(0.8);
    expect(fields.credentialType).toBeGreaterThanOrEqual(0.8);
  });

  it('requires the full 48-entry gate split (fail-closed coverage)', () => {
    expect(gate!.minimumEntries).toBe(CPE_CLE_S3_GATE_ENTRIES.length);
  });
});

describe('resolveDataset', () => {
  it('defaults to the professional-education dataset with the PE gates', () => {
    const dataset = resolveDataset(undefined);
    expect('error' in dataset).toBe(false);
    if ('error' in dataset) return;
    expect(dataset.name).toBe('pe');
    expect(dataset.defaultGates).toEqual(['SCRUM-1962', 'SCRUM-1963', 'SCRUM-2187']);
  });

  it('resolves s3 to the gate split (held-out entries are never gate-scored)', () => {
    const dataset = resolveDataset('s3');
    expect('error' in dataset).toBe(false);
    if ('error' in dataset) return;
    expect(dataset.name).toBe('s3');
    expect(dataset.defaultGates).toEqual(['SCRUM-2382']);
    expect(dataset.entries).toHaveLength(CPE_CLE_S3_GATE_ENTRIES.length);
    for (const entry of dataset.entries) {
      expect(entry.tags).not.toContain('held-out');
    }
  });

  it('rejects unknown datasets', () => {
    expect(resolveDataset('nope')).toEqual({ error: expect.stringContaining('nope') });
  });
});

describe('resolveRequestedGates with dataset defaults', () => {
  it('defaults to the dataset gates when --gates omitted', () => {
    expect(resolveRequestedGates(undefined, ['SCRUM-2382'])).toEqual({ gates: ['SCRUM-2382'] });
  });

  it('accepts SCRUM-2382 as an explicit selection', () => {
    expect(resolveRequestedGates('SCRUM-2382')).toEqual({ gates: ['SCRUM-2382'] });
  });
});

describe('fixture replay extractor (zero live model calls)', () => {
  it('replays recorded outputs deterministically', async () => {
    const recorded = buildRecordedOutputsFromGroundTruth(CPE_CLE_S3_GATE_ENTRIES);
    const extract = createFixtureReplayExtractor(recorded);
    const provider = new MockAIProvider();
    const entry = CPE_CLE_S3_GATE_ENTRIES[0];

    const first = await extract(provider, entry);
    const second = await extract(provider, entry);
    expect(first).toEqual(second);
    expect(first.fields.credentialType).toBe(entry.groundTruth.credentialType);
    expect(first.tokensUsed).toBe(0);
  });

  it('FAILS CLOSED when an entry has no recorded output', async () => {
    const recorded: RecordedOutputs = {
      meta: {
        recordedFrom: 'mock-echo',
        recordedAt: '2026-07-06',
        datasetTag: 's3-cpe-cle',
        note: 'test',
      },
      outputs: {},
    };
    const extract = createFixtureReplayExtractor(recorded);
    await expect(extract(new MockAIProvider(), CPE_CLE_S3_GATE_ENTRIES[0])).rejects.toThrow(
      /no recorded output/i,
    );
  });

  it('loadRecordedOutputs parses the COMMITTED fixture file and covers every gate entry', () => {
    const recorded = loadRecordedOutputs(resolve(WORKER_ROOT, S3_RECORDED_OUTPUTS_DEFAULT_PATH));
    expect(recorded.meta.recordedFrom).toBe('mock-echo');
    // The mock seed must be clearly marked as NOT a real model measurement.
    expect(recorded.meta.note.toLowerCase()).toContain('not a live-model measurement');
    for (const entry of CPE_CLE_S3_GATE_ENTRIES) {
      expect(recorded.outputs[entry.id], `missing recorded output for ${entry.id}`).toBeDefined();
    }
    // Held-out fixtures must NOT be present in the committed recorded file
    // (they would otherwise leak ids into a committed corpus).
    for (const entry of GOLDEN_DATASET_CPE_CLE_S3.filter((e) => e.tags.includes('held-out'))) {
      expect(recorded.outputs[entry.id]).toBeUndefined();
    }
  });

  it('loadRecordedOutputs rejects malformed files', () => {
    expect(() => loadRecordedOutputs(resolve(__dirname, 'cpe-cle-s3-manifest.json'))).toThrow();
  });
});

describe('SCRUM-2382 gate end-to-end (deterministic CI path)', () => {
  it('passes on the committed recorded fixture (replay -> score -> gate)', async () => {
    const recorded = loadRecordedOutputs(resolve(WORKER_ROOT, S3_RECORDED_OUTPUTS_DEFAULT_PATH));
    const result = await runEval({
      provider: new MockAIProvider(),
      entries: CPE_CLE_S3_GATE_ENTRIES,
      concurrency: 10,
      extract: createFixtureReplayExtractor(recorded),
    });
    const [gate] = evaluateEvalGates(result, ['SCRUM-2382']);
    expect(gate.passed, `reason=${gate.reason}`).toBe(true);
    expect(gate.matchingEntries).toBe(CPE_CLE_S3_GATE_ENTRIES.length);
    expect(gate.weightedF1).toBeGreaterThanOrEqual(0.8);
  });

  it('FAILS when a critical field (creditHours) degrades below its floor', async () => {
    const recorded = buildRecordedOutputsFromGroundTruth(CPE_CLE_S3_GATE_ENTRIES);
    // Corrupt creditHours on 60% of recorded outputs — aggregate F1 stays high
    // but the per-field floor must trip the gate.
    const ids = Object.keys(recorded.outputs);
    for (const id of ids.slice(0, Math.ceil(ids.length * 0.6))) {
      recorded.outputs[id].fields.creditHours = 999;
    }
    const result = await runEval({
      provider: new MockAIProvider(),
      entries: CPE_CLE_S3_GATE_ENTRIES,
      concurrency: 10,
      extract: createFixtureReplayExtractor(recorded),
    });
    const [gate] = evaluateEvalGates(result, ['SCRUM-2382']);
    expect(gate.passed).toBe(false);
    expect(gate.reason).toBe('field_threshold_failed');
    const creditField = gate.fieldResults.find((f) => f.field === 'creditHours');
    expect(creditField?.passed).toBe(false);
  });

  it('FAILS when aggregate F1 drops below 0.80 even if critical fields hold', async () => {
    const recorded = buildRecordedOutputsFromGroundTruth(CPE_CLE_S3_GATE_ENTRIES);
    // Corrupt many NON-critical fields across all outputs to drag aggregate F1
    // down while the three critical-field floors stay green.
    for (const id of Object.keys(recorded.outputs)) {
      const fields = recorded.outputs[id].fields;
      for (const key of Object.keys(fields)) {
        if (!['creditHours', 'issuedDate', 'credentialType'].includes(key)) {
          fields[key] = 'CORRUPTED-VALUE';
        }
      }
    }
    const result = await runEval({
      provider: new MockAIProvider(),
      entries: CPE_CLE_S3_GATE_ENTRIES,
      concurrency: 10,
      extract: createFixtureReplayExtractor(recorded),
    });
    const [gate] = evaluateEvalGates(result, ['SCRUM-2382']);
    expect(gate.passed).toBe(false);
    for (const field of ['creditHours', 'issuedDate', 'credentialType']) {
      expect(gate.fieldResults.find((f) => f.field === field)?.passed, field).toBe(true);
    }
  });
});

describe('report value-omission (field names + scores ONLY)', () => {
  it('the gate report never contains fixture field values', async () => {
    const recorded = loadRecordedOutputs(resolve(WORKER_ROOT, S3_RECORDED_OUTPUTS_DEFAULT_PATH));
    const result = await runEval({
      provider: new MockAIProvider(),
      entries: CPE_CLE_S3_GATE_ENTRIES,
      concurrency: 10,
      extract: createFixtureReplayExtractor(recorded),
    });
    const gateResults = evaluateEvalGates(result, ['SCRUM-2382']);
    const report = formatGateReport(gateResults, {
      provider: 'fixture',
      promptVersionHash: 'test',
      timestamp: '2026-07-06T00:00:00Z',
      totalEntries: result.totalEntries,
    });

    // Field NAMES are allowed; field VALUES are not. Sample distinctive values
    // from the ground truth across the whole gate split.
    for (const entry of CPE_CLE_S3_GATE_ENTRIES) {
      const values = [
        entry.groundTruth.courseId,
        entry.groundTruth.issuerName,
        entry.groundTruth.issuedDate,
      ].filter((v): v is string => typeof v === 'string');
      for (const value of values) {
        expect(report).not.toContain(value);
      }
    }
    // And the JSON-serialized gate results are equally value-free.
    const serialized = JSON.stringify(gateResults);
    for (const entry of CPE_CLE_S3_GATE_ENTRIES.slice(0, 5)) {
      expect(serialized).not.toContain(entry.groundTruth.courseId as string);
    }
    expect(report).toContain('creditHours');
  });
});

describe('leakage precondition wiring (AI-01 -> AI-02)', () => {
  it('the s3 dataset precondition runs the held-out leakage scan and is clean', () => {
    const violations = checkS3LeakagePrecondition(WORKER_ROOT);
    expect(violations).toEqual([]);
  });
});
