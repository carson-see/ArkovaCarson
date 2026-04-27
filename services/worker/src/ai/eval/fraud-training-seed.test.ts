/**
 * Fraud Training Seed coverage tests (SCRUM-792).
 *
 * Locks the data layer that feeds gemini-fraud-v1-vertex.jsonl. Vertex AI
 * training + F1 verification are gated behind SCRUM-1040 (budget gate);
 * this suite only verifies the seed dataset itself meets the AC minimums
 * and structural integrity rules.
 */
import { describe, expect, it } from 'vitest';

import {
  FRAUD_CATEGORY_MIN,
  FRAUD_TRAINING_SEED,
  fraudSeedByCategory,
  validateFraudTrainingCoverage,
  type FraudTrainingCategory,
  type FraudTrainingEntry,
} from './fraud-training-seed.js';

const CLEAN_IDS = new Set(['FT-901', 'FT-902']);

function isFraudEntry(entry: FraudTrainingEntry): boolean {
  return !CLEAN_IDS.has(entry.id);
}

describe('fraud-training-seed coverage (SCRUM-792)', () => {
  it('total entry count — at least 100 fraud + 2 clean = 102 entries', () => {
    const fraud = FRAUD_TRAINING_SEED.filter(isFraudEntry);
    const clean = FRAUD_TRAINING_SEED.filter((e) => CLEAN_IDS.has(e.id));
    expect(fraud.length).toBeGreaterThanOrEqual(100);
    expect(clean.length).toBe(2);
    expect(FRAUD_TRAINING_SEED.length).toBeGreaterThanOrEqual(102);
  });

  it('diploma_mill min — at least 20 entries (AC SCRUM-792)', () => {
    const counts = fraudSeedByCategory();
    expect(counts.diploma_mill?.length ?? 0).toBeGreaterThanOrEqual(
      FRAUD_CATEGORY_MIN.diploma_mill,
    );
  });

  it('license_forgery min — at least 20 entries (AC SCRUM-792)', () => {
    const counts = fraudSeedByCategory();
    expect(counts.license_forgery?.length ?? 0).toBeGreaterThanOrEqual(
      FRAUD_CATEGORY_MIN.license_forgery,
    );
  });

  it('document_tampering min — at least 15 entries (AC SCRUM-792)', () => {
    const counts = fraudSeedByCategory();
    expect(counts.document_tampering?.length ?? 0).toBeGreaterThanOrEqual(
      FRAUD_CATEGORY_MIN.document_tampering,
    );
  });

  it('identity_mismatch min — at least 15 entries (AC SCRUM-792)', () => {
    const counts = fraudSeedByCategory();
    expect(counts.identity_mismatch?.length ?? 0).toBeGreaterThanOrEqual(
      FRAUD_CATEGORY_MIN.identity_mismatch,
    );
  });

  it('sophisticated min — at least 10 entries (AC SCRUM-792)', () => {
    const counts = fraudSeedByCategory();
    // The sophisticated category includes 2 clean baselines (FT-901, FT-902) which
    // are filed under sophisticated for the model to learn what NOT to flag.
    // The validator counts all sophisticated entries (fraud + clean) against the
    // AC minimum because that is what gets emitted into training-output.
    expect(counts.sophisticated?.length ?? 0).toBeGreaterThanOrEqual(
      FRAUD_CATEGORY_MIN.sophisticated,
    );
  });

  it('id pattern + uniqueness — every id matches /^FT-\\d{3}$/ and ids are unique', () => {
    const idPattern = /^FT-\d{3}$/;
    const ids = FRAUD_TRAINING_SEED.map((e) => e.id);
    const seen = new Set<string>();
    for (const entry of FRAUD_TRAINING_SEED) {
      expect(entry.id).toMatch(idPattern);
      expect(seen.has(entry.id)).toBe(false);
      seen.add(entry.id);
    }
    expect(seen.size).toBe(ids.length);
  });

  it('confidence calibration + signal emission — fraud entries have confidence >=0.7 and >=1 signal; clean entries have 0 signals', () => {
    for (const entry of FRAUD_TRAINING_SEED) {
      if (CLEAN_IDS.has(entry.id)) {
        expect(entry.expectedOutput.fraudSignals.length).toBe(0);
      } else {
        expect(entry.expectedOutput.confidence).toBeGreaterThanOrEqual(0.7);
        expect(entry.expectedOutput.fraudSignals.length).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('validateFraudTrainingCoverage returns ok=true when AC minimums are met', () => {
    const result = validateFraudTrainingCoverage();
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    // Sanity check the helper signature even when ok=true.
    const allCats: FraudTrainingCategory[] = [
      'diploma_mill',
      'license_forgery',
      'document_tampering',
      'identity_mismatch',
      'sophisticated',
    ];
    for (const cat of allCats) {
      expect(FRAUD_CATEGORY_MIN[cat]).toBeGreaterThan(0);
    }
  });
});
