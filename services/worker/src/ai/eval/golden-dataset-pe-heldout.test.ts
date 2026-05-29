import { describe, expect, it } from 'vitest';
import { PROFESSIONAL_EDUCATION_HELDOUT } from './golden-dataset-pe-heldout.js';
import { GOLDEN_DATASET_PROFESSIONAL_EDUCATION } from './golden-dataset-professional-education.js';
import { EVAL_GATE_CONFIGS } from './eval-gates.js';
import type { EntryEvalResult } from './types.js';

describe('golden-dataset-pe-heldout (SCRUM-2200 held-out TEST split)', () => {
  it('provides a meaningful volume of hard held-out cases', () => {
    expect(PROFESSIONAL_EDUCATION_HELDOUT.length).toBeGreaterThanOrEqual(18);
  });

  it('tags every entry as a hard held-out professional-education case', () => {
    for (const entry of PROFESSIONAL_EDUCATION_HELDOUT) {
      expect(entry.category, `${entry.id} category`).toBe('professional-education-heldout');
      expect(entry.tags, `${entry.id} missing held-out tag`).toContain('held-out');
      expect(entry.tags, `${entry.id} missing hard tag`).toContain('hard');
      expect(entry.tags, `${entry.id} missing professional-education tag`).toContain('professional-education');
    }
  });

  it('uses unique entry IDs', () => {
    const ids = PROFESSIONAL_EDUCATION_HELDOUT.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers the adversarial failure modes that make the gate fixtures look saturated', () => {
    const tags = new Set(PROFESSIONAL_EDUCATION_HELDOUT.flatMap((entry) => entry.tags));
    // Each of these is a distinct way the production model can fail that the
    // 100%-saturated merge-gate fixtures never exercise.
    expect(tags.has('ocr-noise')).toBe(true);
    expect(tags.has('near-miss')).toBe(true);
    expect(tags.has('decoy-id')).toBe(true);
    expect(tags.has('hallucination-trap')).toBe(true);
    expect(tags.has('delivery-ambiguity')).toBe(true);
    expect(tags.has('ood')).toBe(true);
    expect(tags.has('unit-trap')).toBe(true);
    expect(tags.has('adversarial')).toBe(true);
    expect(tags.has('multi-course')).toBe(true);
    expect(tags.has('embedded-id')).toBe(true);
    expect(tags.has('fractional')).toBe(true);
    expect(tags.has('dual-credit')).toBe(true);
  });

  it('keeps both CPE and CLE flows represented', () => {
    const cpe = PROFESSIONAL_EDUCATION_HELDOUT.filter((entry) => entry.tags.includes('cpe'));
    const cle = PROFESSIONAL_EDUCATION_HELDOUT.filter((entry) => entry.tags.includes('cle'));
    expect(cpe.length).toBeGreaterThanOrEqual(5);
    expect(cle.length).toBeGreaterThanOrEqual(5);
  });

  it('NEVER leaks held-out IDs into the merge-gate fixtures (no train/test contamination)', () => {
    const gateIds = new Set(GOLDEN_DATASET_PROFESSIONAL_EDUCATION.map((entry) => entry.id));
    for (const entry of PROFESSIONAL_EDUCATION_HELDOUT) {
      expect(gateIds.has(entry.id), `${entry.id} appears in the gate fixtures`).toBe(false);
    }
  });

  it('is NEVER selected by any merge gate, even if accidentally mixed into a run', () => {
    // The merge gates score model quality on the stable gate fixtures only.
    // matchesEntry filters by tag, and held-out entries share cpe/cle/course-id
    // tags — so the gates carry an explicit `held-out` exclusion. This guards
    // against train/test contamination if the arrays are ever concatenated.
    for (const gate of EVAL_GATE_CONFIGS) {
      for (const entry of PROFESSIONAL_EDUCATION_HELDOUT) {
        const asRunEntry = { tags: entry.tags } as unknown as EntryEvalResult;
        expect(
          gate.matchesEntry(asRunEntry),
          `gate ${gate.gateId} matched held-out entry ${entry.id}`,
        ).toBe(false);
      }
    }
  });

  it('keeps strippedText free of raw PII per Constitution §1.6', () => {
    // strippedText models the on-device-stripped payload that actually leaves
    // the browser. Raw PII must never appear — only redaction placeholders.
    // Linear-time forms (dot separator excluded from the repeated label class)
    // so there is no overlapping-quantifier backtracking (no ReDoS).
    const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/i;
    const SSN = /\b\d{3}-\d{2}-\d{4}\b/;
    const PHONE = /\b(?:\(\d{3}\)\s*|\d{3}[-.])\d{3}[-.]\d{4}\b/;
    const PERSON_LABEL =
      /\b(participant|attendee|licensee|student|candidate|registrant|recipient|member|solicitor|name)\s*:\s*(\S+)/gi;

    for (const entry of PROFESSIONAL_EDUCATION_HELDOUT) {
      const text = entry.strippedText;
      expect(EMAIL.test(text), `${entry.id} leaks an email address`).toBe(false);
      expect(SSN.test(text), `${entry.id} leaks an SSN`).toBe(false);
      expect(PHONE.test(text), `${entry.id} leaks a phone number`).toBe(false);

      for (const match of text.matchAll(PERSON_LABEL)) {
        expect(
          match[2].startsWith('['),
          `${entry.id} exposes a raw name after "${match[1]}:"`,
        ).toBe(true);
      }
    }
  });

  it('redacts named individuals with the [NAME_REDACTED] placeholder', () => {
    const named = PROFESSIONAL_EDUCATION_HELDOUT.filter((entry) =>
      /\[NAME_REDACTED\]/.test(entry.strippedText),
    );
    // Nearly every certificate names a person, and where it does the name must
    // be the placeholder (the PII test enforces "no raw name after a label").
    // A small number of record-style entries name no individual at all, so this
    // asserts the placeholder is broadly exercised rather than universal.
    expect(named.length).toBeGreaterThanOrEqual(PROFESSIONAL_EDUCATION_HELDOUT.length - 1);
  });

  it('labels every gate-scored field it claims to exercise', () => {
    // An entry tagged for a field must actually carry that field in ground
    // truth, otherwise the held-out F1 for that field is silently undercounted.
    for (const entry of PROFESSIONAL_EDUCATION_HELDOUT) {
      if (entry.tags.includes('course-id')) {
        expect(entry.groundTruth.courseId, `${entry.id} tagged course-id but has none`).toBeDefined();
      }
      if (entry.tags.includes('ethics')) {
        expect(entry.groundTruth.ethicsHours, `${entry.id} tagged ethics but has none`).toBeDefined();
      }
    }
  });

  it('includes hallucination traps where a gate-scored field is genuinely absent', () => {
    // These are the cases that punish over-eager extraction: the model must
    // leave the field blank rather than fabricate a plausible value.
    const noCourseId = PROFESSIONAL_EDUCATION_HELDOUT.find((entry) => entry.id === 'GD-PE-HO-011');
    const noFieldOfStudy = PROFESSIONAL_EDUCATION_HELDOUT.find((entry) => entry.id === 'GD-PE-HO-012');
    const noEthics = PROFESSIONAL_EDUCATION_HELDOUT.find((entry) => entry.id === 'GD-PE-HO-006');

    expect(noCourseId?.groundTruth.courseId).toBeUndefined();
    expect(noFieldOfStudy?.groundTruth.fieldOfStudy).toBeUndefined();
    expect(noEthics?.groundTruth.ethicsHours).toBeUndefined();
  });
});
