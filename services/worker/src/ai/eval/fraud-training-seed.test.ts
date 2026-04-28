/**
 * Fraud Training Seed Tests (SCRUM-792 / GME2-01)
 *
 * Locks the per-category counts and structural integrity required by the
 * GME2-01 acceptance criteria: 100+ distinct fraud patterns spanning
 * 5 categories, with description / extractedFields / expectedOutput /
 * source on every entry, calibrated confidence, and signal codes drawn
 * from the FRAUD_SYSTEM_PROMPT vocabulary.
 */

import { describe, it, expect } from 'vitest';
import {
  FRAUD_TRAINING_SEED,
  FRAUD_SYSTEM_PROMPT,
  FRAUD_SIGNALS,
  FRAUD_CATEGORIES,
} from './fraud-training-seed.js';

const VALID_SIGNALS: ReadonlySet<string> = new Set(FRAUD_SIGNALS);
const VALID_CATEGORIES: ReadonlySet<string> = new Set(FRAUD_CATEGORIES);

const MIN_TOTAL = 100;
const MIN_FRAUD = 80;
const MIN_CLEAN = 10;
const PER_CATEGORY_MIN: ReadonlyArray<readonly [(typeof FRAUD_CATEGORIES)[number], number]> = [
  ['diploma_mill', 20],
  ['license_forgery', 20],
  ['document_tampering', 15],
  ['identity_mismatch', 15],
  ['sophisticated', 10],
  ['clean', 10],
];

function countByCategory(category: string): number {
  return FRAUD_TRAINING_SEED.filter(e => e.category === category).length;
}

describe('fraud-training-seed (SCRUM-792)', () => {
  it(`has ${MIN_TOTAL}+ total entries`, () => {
    expect(FRAUD_TRAINING_SEED.length).toBeGreaterThanOrEqual(MIN_TOTAL);
  });

  it(`has ${MIN_FRAUD}+ fraud-signal entries (clean controls excluded)`, () => {
    const fraud = FRAUD_TRAINING_SEED.filter(e => e.expectedOutput.fraudSignals.length > 0);
    expect(fraud.length).toBeGreaterThanOrEqual(MIN_FRAUD);
  });

  it(`has ${MIN_CLEAN}+ clean control entries (anchors false-positive rate)`, () => {
    const clean = FRAUD_TRAINING_SEED.filter(e => e.expectedOutput.fraudSignals.length === 0);
    expect(clean.length).toBeGreaterThanOrEqual(MIN_CLEAN);
  });

  describe('per-category counts (GME2-01 scope)', () => {
    it.each(PER_CATEGORY_MIN)('%s: at least %d', (category, min) => {
      expect(countByCategory(category)).toBeGreaterThanOrEqual(min);
    });
  });

  describe('per-entry integrity', () => {
    it('all IDs are unique', () => {
      const ids = FRAUD_TRAINING_SEED.map(e => e.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('all IDs follow FT-NNN pattern', () => {
      for (const entry of FRAUD_TRAINING_SEED) {
        expect(entry.id).toMatch(/^FT-\d{3}$/);
      }
    });

    it('all entries have a meaningful description', () => {
      for (const entry of FRAUD_TRAINING_SEED) {
        expect(entry.description.length).toBeGreaterThanOrEqual(15);
      }
    });

    it('all entries have a credentialType in extractedFields', () => {
      for (const entry of FRAUD_TRAINING_SEED) {
        expect(entry.extractedFields.credentialType).toBeTruthy();
      }
    });

    it('all entries have a category in the allowed set', () => {
      for (const entry of FRAUD_TRAINING_SEED) {
        expect(VALID_CATEGORIES.has(entry.category)).toBe(true);
      }
    });

    it('all entries have a non-empty source', () => {
      for (const entry of FRAUD_TRAINING_SEED) {
        expect(entry.source.length).toBeGreaterThan(0);
      }
    });

    it('all entries have reasoning >= 40 chars (forces real explanation)', () => {
      for (const entry of FRAUD_TRAINING_SEED) {
        expect(entry.expectedOutput.reasoning.length).toBeGreaterThanOrEqual(40);
      }
    });

    it('all confidences are in [0, 1]', () => {
      for (const entry of FRAUD_TRAINING_SEED) {
        expect(entry.expectedOutput.confidence).toBeGreaterThanOrEqual(0);
        expect(entry.expectedOutput.confidence).toBeLessThanOrEqual(1);
      }
    });

    it('all fraudSignals are in the FRAUD_SYSTEM_PROMPT vocabulary', () => {
      for (const entry of FRAUD_TRAINING_SEED) {
        for (const signal of entry.expectedOutput.fraudSignals) {
          expect(VALID_SIGNALS.has(signal)).toBe(true);
        }
      }
    });

    it('FRAUD_SYSTEM_PROMPT lists every signal used in the dataset', () => {
      for (const entry of FRAUD_TRAINING_SEED) {
        for (const signal of entry.expectedOutput.fraudSignals) {
          expect(FRAUD_SYSTEM_PROMPT).toContain(signal);
        }
      }
    });
  });

  describe('confidence calibration shape', () => {
    it('clean entries (no signals) sit in the high-confidence band (>= 0.85)', () => {
      const clean = FRAUD_TRAINING_SEED.filter(e => e.expectedOutput.fraudSignals.length === 0);
      for (const entry of clean) {
        expect(entry.expectedOutput.confidence).toBeGreaterThanOrEqual(0.85);
      }
    });

    it('has at least 10 entries flagged with confidence >= 0.9 (unambiguous fraud)', () => {
      const highConfFraud = FRAUD_TRAINING_SEED.filter(
        e => e.expectedOutput.fraudSignals.length > 0 && e.expectedOutput.confidence >= 0.9,
      );
      expect(highConfFraud.length).toBeGreaterThanOrEqual(10);
    });

    it('has at least 10 entries in the verification-needed band (0.5–0.75)', () => {
      const verifyBand = FRAUD_TRAINING_SEED.filter(
        e =>
          e.expectedOutput.fraudSignals.length > 0 &&
          e.expectedOutput.confidence >= 0.5 &&
          e.expectedOutput.confidence < 0.75,
      );
      expect(verifyBand.length).toBeGreaterThanOrEqual(10);
    });
  });

  describe('source attribution (FTC / GAO / state AG anchors)', () => {
    it('at least 5 entries cite an FTC enforcement source', () => {
      const ftc = FRAUD_TRAINING_SEED.filter(e => /ftc/i.test(e.source));
      expect(ftc.length).toBeGreaterThanOrEqual(5);
    });

    it('at least 2 entries cite a GAO source', () => {
      const gao = FRAUD_TRAINING_SEED.filter(e => /gao/i.test(e.source));
      expect(gao.length).toBeGreaterThanOrEqual(2);
    });

    it('at least 5 entries cite a state AG / state-board source', () => {
      const state = FRAUD_TRAINING_SEED.filter(e => /\b(AG|attorney general|state bar|medical board|board of|state of|department)\b/i.test(e.source));
      expect(state.length).toBeGreaterThanOrEqual(5);
    });
  });
});
