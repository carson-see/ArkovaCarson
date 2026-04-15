/**
 * Tests for GRE-06: Golden Dataset SubType Backfill
 *
 * Validates that backfill entries reference valid golden dataset IDs,
 * use valid subType values, and meet coverage requirements.
 */

import { describe, it, expect } from 'vitest';
import { SUBTYPE_BACKFILL } from './golden-dataset-subtype-backfill.js';
import { FULL_GOLDEN_DATASET } from './golden-dataset.js';

/** Valid subType values by credential type */
const VALID_SUBTYPES: Record<string, string[]> = {
  DEGREE: ['associate', 'bachelor', 'master', 'doctorate', 'honorary', 'professional_jd', 'professional_md', 'professional_dds', 'professional_pharmd', 'professional_edd'],
  LICENSE: [
    'nursing_rn', 'nursing_lpn', 'medical_md', 'pharmacist', 'law_bar_admission',
    'real_estate', 'engineering_pe', 'teaching', 'cpa', 'cosmetology',
    'dental', 'veterinary', 'pilot', 'notary', 'architect', 'social_work',
    'psychology', 'optometry', 'chiropractic', 'electrician', 'plumber',
    'speech_language_pathology', 'general',
  ],
  CERTIFICATE: [
    'professional_certification', 'it_certification', 'accreditation_certificate',
    'completion_certificate', 'training_certificate', 'trade_certification',
  ],
  TRANSCRIPT: [
    'official_undergraduate', 'official_graduate', 'unofficial',
    'international_wes', 'high_school',
  ],
  CLE: ['ethics_cle', 'general_cle', 'specialized_cle', 'elimination_of_bias'],
  PROFESSIONAL: [
    'board_certification', 'residency', 'fellowship', 'membership',
  ],
};

describe('GRE-06: Golden Dataset SubType Backfill', () => {
  const backfillEntries = Object.entries(SUBTYPE_BACKFILL);
  const backfillIds = new Set(Object.keys(SUBTYPE_BACKFILL));
  const goldenIds = new Set(FULL_GOLDEN_DATASET.map(e => e.id));

  it('has at least 200 entries', () => {
    expect(backfillEntries.length).toBeGreaterThanOrEqual(200);
  });

  it('all subType values are non-empty strings', () => {
    for (const [id, data] of backfillEntries) {
      expect(typeof data.subType).toBe('string');
      expect(data.subType.length, `Empty subType for ${id}`).toBeGreaterThan(0);
    }
  });

  it('no duplicate IDs', () => {
    // Record keys are inherently unique, but verify count matches
    expect(backfillIds.size).toBe(backfillEntries.length);
  });

  it('all IDs exist in FULL_GOLDEN_DATASET', () => {
    for (const id of backfillIds) {
      expect(goldenIds.has(id), `ID ${id} not found in FULL_GOLDEN_DATASET`).toBe(true);
    }
  });

  it('has at least 5 different subType values', () => {
    const subTypes = new Set(backfillEntries.map(([, data]) => data.subType));
    expect(subTypes.size).toBeGreaterThanOrEqual(5);
  });

  it('has at least 15 different subType values for good coverage', () => {
    const subTypes = new Set(backfillEntries.map(([, data]) => data.subType));
    expect(subTypes.size).toBeGreaterThanOrEqual(15);
  });

  it('covers multiple credential types', () => {
    const typesBackfilled = new Set<string>();
    for (const id of backfillIds) {
      const entry = FULL_GOLDEN_DATASET.find(e => e.id === id);
      if (entry) {
        typesBackfilled.add(entry.groundTruth.credentialType!);
      }
    }
    expect(typesBackfilled.size).toBeGreaterThanOrEqual(5);
  });

  it('subType values follow snake_case convention', () => {
    for (const [id, data] of backfillEntries) {
      expect(
        data.subType,
        `Invalid subType format for ${id}: ${data.subType}`,
      ).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('concerns arrays contain only strings when present', () => {
    for (const [id, data] of backfillEntries) {
      if (data.concerns) {
        expect(Array.isArray(data.concerns), `concerns for ${id} is not array`).toBe(true);
        for (const c of data.concerns) {
          expect(typeof c).toBe('string');
        }
      }
    }
  });

  it('reasoning fields are strings when present', () => {
    for (const [, data] of backfillEntries) {
      if (data.reasoning !== undefined) {
        expect(typeof data.reasoning).toBe('string');
        expect(data.reasoning.length).toBeGreaterThan(0);
      }
    }
  });

  it('does not backfill entries that already have subType in phase 15', () => {
    // Phase 15 entries (GD-1901+) already have reasoning; we should not backfill them
    for (const id of backfillIds) {
      const numId = parseInt(id.replace('GD-', ''), 10);
      expect(numId, `Should not backfill phase 15+ entry ${id}`).toBeLessThan(1901);
    }
  });
});
