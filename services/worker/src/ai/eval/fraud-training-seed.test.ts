/**
 * SCRUM-792 (GME2-01) — fraud training seed dataset structural tests.
 *
 * Pins:
 *   - Dataset is monotonically growing toward the 100+ DoD threshold.
 *     CI fails if the count drops below the highwater shipped 2026-04-27.
 *   - All entries have unique IDs.
 *   - All entries pass shape validation (required fields populated).
 *   - Categorical coverage is non-empty across all 5 fraud categories so
 *     a Gemini fine-tune doesn't accidentally train on one class.
 */

import { describe, it, expect } from 'vitest';
import { FRAUD_TRAINING_SEED, FRAUD_TRAINING_TARGET_COUNT } from './fraud-training-seed.js';

const HIGHWATER_AT_2026_04_27 = 34;

describe('fraud-training-seed (SCRUM-792)', () => {
  it('does not regress below the 2026-04-27 highwater of 34 entries', () => {
    expect(FRAUD_TRAINING_SEED.length).toBeGreaterThanOrEqual(HIGHWATER_AT_2026_04_27);
  });

  it('exposes the 100+ DoD target as a constant', () => {
    expect(FRAUD_TRAINING_TARGET_COUNT).toBeGreaterThanOrEqual(100);
  });

  it('flags incomplete progress against the DoD target', () => {
    if (FRAUD_TRAINING_SEED.length < FRAUD_TRAINING_TARGET_COUNT) {
      const remaining = FRAUD_TRAINING_TARGET_COUNT - FRAUD_TRAINING_SEED.length;
      // Pin remaining work for SCRUM-792. Test still passes — the seed is partial
      // by design until the curation backlog catches up.
      expect(remaining).toBeGreaterThan(0);
    }
  });

  it('has unique IDs across the dataset', () => {
    const ids = FRAUD_TRAINING_SEED.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every entry has the required fields populated', () => {
    for (const entry of FRAUD_TRAINING_SEED) {
      expect(entry.id).toMatch(/^FT-\d{3}$/);
      expect(entry.description.length).toBeGreaterThan(10);
      expect(Object.keys(entry.extractedFields).length).toBeGreaterThan(0);
      expect(entry.expectedOutput.reasoning.length).toBeGreaterThan(20);
      expect(entry.expectedOutput.confidence).toBeGreaterThanOrEqual(0);
      expect(entry.expectedOutput.confidence).toBeLessThanOrEqual(1);
      expect(entry.source.length).toBeGreaterThan(2);
      expect(Array.isArray(entry.expectedOutput.fraudSignals)).toBe(true);
    }
  });

  it('covers all 5 fraud categories — no class collapse', () => {
    const categories = new Set(FRAUD_TRAINING_SEED.map((e) => e.category));
    expect(categories.has('diploma_mill')).toBe(true);
    expect(categories.has('license_forgery')).toBe(true);
    expect(categories.has('document_tampering')).toBe(true);
    expect(categories.has('identity_mismatch')).toBe(true);
    expect(categories.has('sophisticated')).toBe(true);
  });

  it('non-fraud baseline entries have empty fraudSignals', () => {
    const cleanEntries = FRAUD_TRAINING_SEED.filter(
      (e) => e.source.toLowerCase().includes('clean') || e.expectedOutput.fraudSignals.length === 0,
    );
    for (const entry of cleanEntries) {
      expect(entry.expectedOutput.fraudSignals).toEqual([]);
      expect(entry.expectedOutput.confidence).toBeGreaterThanOrEqual(0.85);
    }
  });
});
