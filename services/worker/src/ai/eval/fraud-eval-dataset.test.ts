/**
 * Fraud Eval Dataset Tests (Phase 5)
 *
 * Validates dataset integrity, coverage, and structure.
 */

import { describe, it, expect } from 'vitest';
import {
  FRAUD_EVAL_DATASET,
  getCleanEntries,
  getTamperedEntries,
  getEntriesByTamperingCategory,
  getFraudEntriesByType,
} from './fraud-eval-dataset.js';

describe('fraud-eval-dataset', () => {
  it('has exactly 100 entries', () => {
    expect(FRAUD_EVAL_DATASET).toHaveLength(100);
  });

  it('has unique IDs', () => {
    const ids = FRAUD_EVAL_DATASET.map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('all IDs follow FE-NNN pattern', () => {
    for (const entry of FRAUD_EVAL_DATASET) {
      expect(entry.id).toMatch(/^FE-\d{3}$/);
    }
  });

  it('has 50 clean and 50 tampered entries', () => {
    const clean = getCleanEntries();
    const tampered = getTamperedEntries();
    expect(clean).toHaveLength(50);
    expect(tampered).toHaveLength(50);
  });

  describe('clean entries', () => {
    it('all have isTampered=false', () => {
      const clean = getCleanEntries();
      expect(clean.every(e => !e.isTampered)).toBe(true);
    });

    it('all have LOW expected risk', () => {
      const clean = getCleanEntries();
      expect(clean.every(e => e.expectedRiskLevel === 'LOW')).toBe(true);
    });

    it('all have tamperingCategory=none', () => {
      const clean = getCleanEntries();
      expect(clean.every(e => e.tamperingCategory === 'none')).toBe(true);
    });

    it('all have empty expectedSignals', () => {
      const clean = getCleanEntries();
      expect(clean.every(e => e.expectedSignals.length === 0)).toBe(true);
    });

    it('none have tampering technique', () => {
      const clean = getCleanEntries();
      expect(clean.every(e => e.tamperingTechnique === null)).toBe(true);
    });
  });

  describe('tampered entries', () => {
    it('all have isTampered=true', () => {
      const tampered = getTamperedEntries();
      expect(tampered.every(e => e.isTampered)).toBe(true);
    });

    it('none have LOW expected risk', () => {
      const tampered = getTamperedEntries();
      expect(tampered.every(e => e.expectedRiskLevel !== 'LOW')).toBe(true);
    });

    it('all have a tampering technique', () => {
      const tampered = getTamperedEntries();
      expect(tampered.every(e => e.tamperingTechnique !== null)).toBe(true);
    });

    it('all have at least one expected signal', () => {
      const tampered = getTamperedEntries();
      expect(tampered.every(e => e.expectedSignals.length > 0)).toBe(true);
    });
  });

  describe('tampering categories', () => {
    it('has font tampering examples', () => {
      const font = getEntriesByTamperingCategory('font');
      expect(font.length).toBeGreaterThanOrEqual(5);
    });

    it('has layout tampering examples', () => {
      const layout = getEntriesByTamperingCategory('layout');
      expect(layout.length).toBeGreaterThanOrEqual(3);
    });

    it('has manipulation examples', () => {
      const manip = getEntriesByTamperingCategory('manipulation');
      expect(manip.length).toBeGreaterThanOrEqual(5);
    });

    it('has metadata inconsistency examples', () => {
      const meta = getEntriesByTamperingCategory('metadata');
      expect(meta.length).toBeGreaterThanOrEqual(3);
    });

    it('has security feature tampering', () => {
      const security = getEntriesByTamperingCategory('security_feature');
      expect(security.length).toBeGreaterThanOrEqual(3);
    });

    it('has composite tampering', () => {
      const composite = getEntriesByTamperingCategory('composite');
      expect(composite.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('credential type coverage', () => {
    it('covers DEGREE', () => {
      expect(getFraudEntriesByType('DEGREE').length).toBeGreaterThanOrEqual(5);
    });

    it('covers LICENSE', () => {
      expect(getFraudEntriesByType('LICENSE').length).toBeGreaterThanOrEqual(5);
    });

    it('covers CERTIFICATE', () => {
      expect(getFraudEntriesByType('CERTIFICATE').length).toBeGreaterThanOrEqual(5);
    });

    it('covers TRANSCRIPT', () => {
      expect(getFraudEntriesByType('TRANSCRIPT').length).toBeGreaterThanOrEqual(5);
    });
  });

  describe('data quality', () => {
    it('all entries have descriptions', () => {
      expect(FRAUD_EVAL_DATASET.every(e => e.description.length > 10)).toBe(true);
    });

    it('all entries have valid credential types', () => {
      const validTypes = new Set([
        'DEGREE', 'LICENSE', 'CERTIFICATE', 'TRANSCRIPT', 'PROFESSIONAL', 'CLE',
        'SEC_FILING', 'REGULATION', 'FINANCIAL', 'PUBLICATION', 'INSURANCE',
        'ATTESTATION', 'PATENT', 'LEGAL', 'OTHER',
      ]);
      expect(FRAUD_EVAL_DATASET.every(e => validTypes.has(e.credentialType))).toBe(true);
    });

    it('all entries have tags', () => {
      expect(FRAUD_EVAL_DATASET.every(e => e.tags.length > 0)).toBe(true);
    });

    it('valid risk levels', () => {
      const validLevels = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
      expect(FRAUD_EVAL_DATASET.every(e => validLevels.has(e.expectedRiskLevel))).toBe(true);
    });
  });
});
