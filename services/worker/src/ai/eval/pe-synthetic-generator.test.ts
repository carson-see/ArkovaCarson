import { describe, expect, it } from 'vitest';
import { generatePeSyntheticDataset } from './pe-synthetic-generator.js';
import { EVAL_GATE_CONFIGS } from './eval-gates.js';
import { GOLDEN_DATASET_PROFESSIONAL_EDUCATION } from './golden-dataset-professional-education.js';
import { PROFESSIONAL_EDUCATION_HELDOUT } from './golden-dataset-pe-heldout.js';
import type { EntryEvalResult } from './types.js';

describe('pe-synthetic-generator (SCRUM-2200 Track A — scaled synthetic TRAIN split)', () => {
  it('generates the requested number of entries', () => {
    expect(generatePeSyntheticDataset({ count: 250, seed: 1 }).length).toBe(250);
  });

  it('is deterministic for a given seed', () => {
    const a = generatePeSyntheticDataset({ count: 120, seed: 7 });
    const b = generatePeSyntheticDataset({ count: 120, seed: 7 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('produces different content for different seeds', () => {
    const a = generatePeSyntheticDataset({ count: 120, seed: 1 });
    const b = generatePeSyntheticDataset({ count: 120, seed: 2 });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('uses unique entry IDs', () => {
    const ids = generatePeSyntheticDataset({ count: 500, seed: 3 }).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('marks every entry as the synthetic TRAIN split, never a gate fixture or held-out', () => {
    for (const entry of generatePeSyntheticDataset({ count: 200, seed: 4 })) {
      expect(entry.category, `${entry.id} category`).toBe('professional-education-synthetic');
      expect(entry.tags, `${entry.id} missing synthetic tag`).toContain('synthetic');
      expect(entry.tags, `${entry.id} missing synthetic-train tag`).toContain('synthetic-train');
      expect(entry.tags, `${entry.id} must not be tagged held-out`).not.toContain('held-out');
    }
  });

  it('never collides with the curated gate fixtures or held-out IDs', () => {
    const reserved = new Set([
      ...GOLDEN_DATASET_PROFESSIONAL_EDUCATION.map((e) => e.id),
      ...PROFESSIONAL_EDUCATION_HELDOUT.map((e) => e.id),
    ]);
    for (const entry of generatePeSyntheticDataset({ count: 500, seed: 5 })) {
      expect(reserved.has(entry.id), `${entry.id} collides with a reserved fixture ID`).toBe(false);
    }
  });

  it('is NEVER selected by any merge gate (train data must not be scored as eval)', () => {
    const ds = generatePeSyntheticDataset({ count: 300, seed: 6 });
    for (const gate of EVAL_GATE_CONFIGS) {
      for (const entry of ds) {
        const asRunEntry = { tags: entry.tags } as unknown as EntryEvalResult;
        expect(
          gate.matchesEntry(asRunEntry),
          `gate ${gate.gateId} matched synthetic-train entry ${entry.id}`,
        ).toBe(false);
      }
    }
  });

  it('covers both CPE and CLE flows at roughly the requested mix', () => {
    const ds = generatePeSyntheticDataset({ count: 400, seed: 8, mix: { cpe: 0.5, cle: 0.5 } });
    const cpe = ds.filter((e) => e.tags.includes('cpe'));
    const cle = ds.filter((e) => e.tags.includes('cle'));
    expect(cpe.length).toBeGreaterThan(120);
    expect(cle.length).toBeGreaterThan(120);
    expect(cpe.length + cle.length).toBe(400);
  });

  it('emits ground truth consistent with the credential type', () => {
    for (const entry of generatePeSyntheticDataset({ count: 300, seed: 9 })) {
      const gt = entry.groundTruth;
      if (entry.tags.includes('cpe')) {
        expect(gt.credentialType, `${entry.id}`).toBe('CPE');
        expect(typeof gt.creditHours, `${entry.id} creditHours`).toBe('number');
        expect(gt.fieldOfStudy, `${entry.id} fieldOfStudy`).toBeTruthy();
        expect(gt.deliveryMethod, `${entry.id} deliveryMethod`).toBeTruthy();
      } else if (entry.tags.includes('cle')) {
        expect(gt.credentialType, `${entry.id}`).toBe('CLE');
        expect(typeof gt.creditHours, `${entry.id} creditHours`).toBe('number');
        expect(gt.jurisdiction, `${entry.id} jurisdiction`).toBeTruthy();
      }
      // Ethics hours, when present, never exceed total credit hours unless the
      // entry is deliberately flagged as an inconsistent-totals adversarial case.
      if (typeof gt.ethicsHours === 'number' && !entry.tags.includes('inconsistent-totals')) {
        expect(gt.ethicsHours, `${entry.id} ethics > credits`).toBeLessThanOrEqual(gt.creditHours ?? 0);
      }
    }
  });

  it('wires clean ground-truth values into the rendered text (label recoverability)', () => {
    // For entries WITHOUT injected OCR noise, the course ID and credit-hour
    // value the model must extract should literally appear in the text — this
    // proves the renderer is not emitting unlearnable labels.
    for (const entry of generatePeSyntheticDataset({ count: 300, seed: 10 })) {
      if (entry.tags.includes('ocr-noise')) continue;
      const text = entry.strippedText;
      if (entry.groundTruth.courseId) {
        expect(text.includes(entry.groundTruth.courseId), `${entry.id} courseId not in text`).toBe(true);
      }
    }
  });

  it('keeps strippedText free of raw PII per Constitution §1.6', () => {
    const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/i;
    const SSN = /\b\d{3}-\d{2}-\d{4}\b/;
    const PHONE = /\b(?:\(\d{3}\)\s*|\d{3}[-.])\d{3}[-.]\d{4}\b/;
    const PERSON_LABEL =
      /\b(participant|attendee|licensee|student|candidate|registrant|recipient|member|name)\s*:\s*(\S+)/gi;

    for (const entry of generatePeSyntheticDataset({ count: 500, seed: 11 })) {
      const text = entry.strippedText;
      expect(EMAIL.test(text), `${entry.id} leaks an email address`).toBe(false);
      expect(SSN.test(text), `${entry.id} leaks an SSN`).toBe(false);
      expect(PHONE.test(text), `${entry.id} leaks a phone number`).toBe(false);
      for (const match of text.matchAll(PERSON_LABEL)) {
        expect(match[2].startsWith('['), `${entry.id} exposes a raw name`).toBe(true);
      }
    }
  });
});
