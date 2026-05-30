import { describe, expect, it } from 'vitest';
import { compareFields } from './scoring.js';
import {
  GOLDEN_DATASET_PROFESSIONAL_EDUCATION,
  PROFESSIONAL_EDUCATION_GATE_MINIMUMS,
} from './golden-dataset-professional-education.js';

describe('golden-dataset-professional-education', () => {
  const cpeEntries = GOLDEN_DATASET_PROFESSIONAL_EDUCATION.filter((entry) => entry.tags.includes('cpe'));
  const cleEntries = GOLDEN_DATASET_PROFESSIONAL_EDUCATION.filter(
    (entry) => entry.tags.includes('cle') && !entry.tags.includes('cpe'),
  );
  const courseIdOnlyEntries = GOLDEN_DATASET_PROFESSIONAL_EDUCATION.filter(
    (entry) => entry.tags.includes('course-id') && !entry.tags.includes('cpe') && !entry.tags.includes('cle'),
  );

  it('covers SCRUM-1953 professional education extraction scenarios', () => {
    const tags = new Set(GOLDEN_DATASET_PROFESSIONAL_EDUCATION.flatMap((entry) => entry.tags));

    expect(tags.has('cpe')).toBe(true);
    expect(tags.has('cle')).toBe(true);
    expect(tags.has('nasba')).toBe(true);
    expect(tags.has('ethics')).toBe(true);
    expect(tags.has('multi-state-cle')).toBe(true);
    expect(tags.has('course-id')).toBe(true);
    expect(tags.has('parse-failure')).toBe(true);
    expect(tags.has('manual-review')).toBe(true);
  });

  it('keeps CPE and CLE coverage aligned to SCRUM-1962/1963 gate minimum fixtures', () => {
    expect(cpeEntries.length).toBeGreaterThanOrEqual(PROFESSIONAL_EDUCATION_GATE_MINIMUMS.cpe);
    expect(cleEntries.length).toBeGreaterThanOrEqual(PROFESSIONAL_EDUCATION_GATE_MINIMUMS.cle);
  });

  it('contains the Phase 5 coverage volume required by SCRUM-1953', () => {
    expect(GOLDEN_DATASET_PROFESSIONAL_EDUCATION.length).toBeGreaterThanOrEqual(60);
    expect(cpeEntries.length).toBeGreaterThanOrEqual(PROFESSIONAL_EDUCATION_GATE_MINIMUMS.cpe);
    expect(cleEntries.length).toBeGreaterThanOrEqual(PROFESSIONAL_EDUCATION_GATE_MINIMUMS.cle);
    expect(courseIdOnlyEntries.length).toBeGreaterThanOrEqual(PROFESSIONAL_EDUCATION_GATE_MINIMUMS.courseIdOnly);
  });

  it('keeps professional education gate entries field-complete', () => {
    expect(cpeEntries.every((entry) => entry.groundTruth.creditHours !== undefined)).toBe(true);
    expect(cpeEntries.every((entry) => entry.groundTruth.fieldOfStudy !== undefined)).toBe(true);
    expect(cpeEntries.every((entry) => entry.groundTruth.deliveryMethod !== undefined)).toBe(true);
    expect(cpeEntries.every((entry) => entry.groundTruth.courseId !== undefined)).toBe(true);

    expect(cleEntries.every((entry) => entry.groundTruth.creditHours !== undefined)).toBe(true);
    expect(cleEntries.every((entry) => entry.groundTruth.ethicsHours !== undefined)).toBe(true);
    expect(cleEntries.every((entry) => entry.groundTruth.courseId !== undefined)).toBe(true);

    expect(courseIdOnlyEntries.every((entry) => entry.groundTruth.courseId !== undefined)).toBe(true);
  });

  it('labels professional education fields used by gates and manual review expectations', () => {
    const cpe = GOLDEN_DATASET_PROFESSIONAL_EDUCATION.find((entry) => entry.id === 'GD-PE-001');
    const cle = GOLDEN_DATASET_PROFESSIONAL_EDUCATION.find((entry) => entry.id === 'GD-PE-004');
    const parseFailure = GOLDEN_DATASET_PROFESSIONAL_EDUCATION.find((entry) => entry.id === 'GD-PE-008');

    expect(cpe?.groundTruth).toMatchObject({
      credentialType: 'CPE',
      creditHours: 8,
      deliveryMethod: 'Group Internet Based',
      nasbaStatus: 'active',
      courseId: 'AICPA-TAX-2026-118',
    });
    expect(cle?.groundTruth).toMatchObject({
      creditHours: 6,
      ethicsHours: 1,
      jurisdiction: 'New York; California; Illinois; Texas; Florida; Pennsylvania',
      courseId: 'PLI-SEC-2026-001',
    });
    expect(parseFailure?.groundTruth).toMatchObject({
      credentialType: 'OTHER',
      parseFailureExpected: true,
      manualReviewExpected: true,
    });
  });

  it('keeps strippedText free of raw PII per Constitution §1.6', () => {
    // strippedText models the on-device-stripped payload that actually leaves the
    // browser. Raw PII must never appear in it — only redaction placeholders.
    // Linear-time form: the dot separator is not in the repeated label class, so
    // there is no overlapping-quantifier backtracking (no ReDoS).
    const EMAIL = /[A-Z0-9._%+-]{1,64}@[A-Z0-9-]{1,63}(?:\.[A-Z0-9-]{1,63}){1,8}/i;
    const SSN = /\b\d{3}-\d{2}-\d{4}\b/;
    const PHONE = /\b(?:\(\d{3}\)\s*|\d{3}[-.])\d{3}[-.]\d{4}\b/;
    const PERSON_LABEL = /\b(participant|attendee|licensee|student|candidate|registrant|recipient)\s*:\s*(\S+)/gi;

    for (const entry of GOLDEN_DATASET_PROFESSIONAL_EDUCATION) {
      const text = entry.strippedText;
      expect(EMAIL.test(text), `${entry.id} leaks an email address`).toBe(false);
      expect(SSN.test(text), `${entry.id} leaks an SSN`).toBe(false);
      expect(PHONE.test(text), `${entry.id} leaks a phone number`).toBe(false);

      // Any individual-name label must be followed by a redaction placeholder.
      for (const match of text.matchAll(PERSON_LABEL)) {
        expect(match[2].startsWith('['), `${entry.id} exposes a raw name after "${match[1]}:"`).toBe(true);
      }
    }
  });

  it('redacts participant names where they appear', () => {
    const named = GOLDEN_DATASET_PROFESSIONAL_EDUCATION.filter((entry) =>
      /\bparticipant\s*:/i.test(entry.strippedText),
    );
    expect(named.length).toBeGreaterThan(0);
    expect(named.every((entry) => /\[NAME_REDACTED\]/.test(entry.strippedText))).toBe(true);
  });

  it('compares professional education-specific extraction fields', () => {
    const entry = GOLDEN_DATASET_PROFESSIONAL_EDUCATION[0];
    const results = compareFields(entry.groundTruth, {
      ...entry.groundTruth,
      deliveryMethod: 'group internet based',
      nasbaStatus: 'ACTIVE',
      courseId: 'AICPA-TAX-2026-118',
    });

    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'deliveryMethod', correct: true }),
      expect.objectContaining({ field: 'nasbaStatus', correct: true }),
      expect.objectContaining({ field: 'courseId', correct: true }),
    ]));
  });
});