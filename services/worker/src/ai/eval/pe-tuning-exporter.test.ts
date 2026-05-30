import { describe, expect, it } from 'vitest';
import {
  buildVertexTuningExample,
  buildTuningTargetJson,
  toTuningJsonl,
  exportPeTuningDataset,
} from './pe-tuning-exporter.js';
import { PE_EVAL_SYSTEM_PROMPT, buildPeUserPrompt } from './pe-eval-extraction.js';
import { generatePeSyntheticDataset } from './pe-synthetic-generator.js';
import { PROFESSIONAL_EDUCATION_HELDOUT } from './golden-dataset-pe-heldout.js';
import type { GoldenDatasetEntry } from './types.js';

describe('pe-tuning-exporter (SCRUM-2200 Track A — Vertex Gemini supervised-tuning JSONL)', () => {
  const sample = (): GoldenDatasetEntry => generatePeSyntheticDataset({ count: 50, seed: 21 })[0];

  it('mirrors the eval inference contract: same system prompt + user prompt', () => {
    const entry = sample();
    const ex = buildVertexTuningExample(entry);
    expect(ex.systemInstruction.role).toBe('system');
    expect(ex.systemInstruction.parts[0].text).toBe(PE_EVAL_SYSTEM_PROMPT);
    expect(ex.contents.map((c) => c.role)).toEqual(['user', 'model']);
    expect(ex.contents[0].parts[0].text).toBe(buildPeUserPrompt(entry));
  });

  it('uses the ground-truth values as the model target', () => {
    const entry = generatePeSyntheticDataset({ count: 50, seed: 22 }).find((e) =>
      e.tags.includes('cle'),
    )!;
    const ex = buildVertexTuningExample(entry);
    const target = JSON.parse(ex.contents[1].parts[0].text) as Record<string, unknown>;
    if (entry.groundTruth.courseId) {
      expect(target.courseId).toBe(entry.groundTruth.courseId);
    }
    expect(target.creditHours).toBe(entry.groundTruth.creditHours);
    expect(target.confidence).toBe(1);
  });

  it('never trains the model to emit eval-control fields', () => {
    const target = buildTuningTargetJson({
      groundTruth: {
        courseId: 'X-1',
        creditHours: 8,
        manualReviewExpected: true,
        parseFailureExpected: true,
      },
    } as unknown as GoldenDatasetEntry);
    const parsed = JSON.parse(target) as Record<string, unknown>;
    expect(parsed.manualReviewExpected).toBeUndefined();
    expect(parsed.parseFailureExpected).toBeUndefined();
    expect(parsed.courseId).toBe('X-1');
  });

  it('refuses to export held-out TEST entries as TRAIN data (contamination guard)', () => {
    const heldOut = PROFESSIONAL_EDUCATION_HELDOUT[0];
    expect(() => buildVertexTuningExample(heldOut)).toThrow(/held-out/i);
  });

  it('emits one valid JSONL line per entry with a trailing newline', () => {
    const entries = generatePeSyntheticDataset({ count: 30, seed: 23 });
    const jsonl = toTuningJsonl(entries);
    expect(jsonl.endsWith('\n')).toBe(true);
    const lines = jsonl.trimEnd().split('\n');
    expect(lines.length).toBe(30);
    for (const line of lines) {
      const obj = JSON.parse(line);
      expect(obj.systemInstruction.parts[0].text).toBe(PE_EVAL_SYSTEM_PROMPT);
      expect(obj.contents).toHaveLength(2);
    }
  });

  it('exportPeTuningDataset is deterministic and reports the credential mix', () => {
    const a = exportPeTuningDataset({ count: 100, seed: 24, mix: { cpe: 0.5, cle: 0.5 } });
    const b = exportPeTuningDataset({ count: 100, seed: 24, mix: { cpe: 0.5, cle: 0.5 } });
    expect(a.jsonl).toBe(b.jsonl);
    expect(a.exampleCount).toBe(100);
    expect(a.byCredential.cpe + a.byCredential.cle).toBe(100);
    expect(a.byCredential.cpe).toBeGreaterThan(30);
    expect(a.byCredential.cle).toBeGreaterThan(30);
  });

  it('keeps the serialized tuning data free of raw PII (Constitution §1.6)', () => {
    const EMAIL = /[A-Z0-9._%+-]{1,64}@[A-Z0-9-]{1,63}(?:\.[A-Z0-9-]{1,63}){1,8}/i;
    const SSN = /\b\d{3}-\d{2}-\d{4}\b/;
    const { jsonl } = exportPeTuningDataset({ count: 200, seed: 25 });
    expect(EMAIL.test(jsonl)).toBe(false);
    expect(SSN.test(jsonl)).toBe(false);
  });
});
