/**
 * Tests for Golden Dataset Phase 16 — Compliance Expansion (NCX-05)
 *
 * 200 compliance-focused entries: REGULATION, LICENSE, CLE, CERTIFICATE,
 * DEGREE, TRANSCRIPT, PROFESSIONAL, BUSINESS_ENTITY, FINANCIAL, INSURANCE, LEGAL.
 */

import { describe, it, expect } from 'vitest';
import { GOLDEN_DATASET_PHASE16 } from './golden-dataset-phase16-compliance.js';
import { FULL_GOLDEN_DATASET } from './golden-dataset.js';

describe('golden-dataset-phase16-compliance', () => {
  it('should have exactly 200 entries', () => {
    expect(GOLDEN_DATASET_PHASE16.length).toBe(200);
  });

  it('should have unique IDs', () => {
    const ids = GOLDEN_DATASET_PHASE16.map(e => e.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('should have IDs in GD-2xxx range', () => {
    for (const entry of GOLDEN_DATASET_PHASE16) {
      expect(entry.id).toMatch(/^GD-2\d{3}$/);
    }
  });

  it('should have IDs starting from GD-2000', () => {
    const numericIds = GOLDEN_DATASET_PHASE16.map(e => parseInt(e.id.replace('GD-', ''), 10));
    expect(Math.min(...numericIds)).toBe(2000);
  });

  it('should not collide with existing FULL_GOLDEN_DATASET IDs', () => {
    const existingIds = new Set(FULL_GOLDEN_DATASET.map(e => e.id));
    for (const entry of GOLDEN_DATASET_PHASE16) {
      expect(existingIds.has(entry.id)).toBe(false);
    }
  });

  it('should have reasoning field in all groundTruth entries', () => {
    for (const entry of GOLDEN_DATASET_PHASE16) {
      expect(entry.groundTruth.reasoning).toBeDefined();
      expect(typeof entry.groundTruth.reasoning).toBe('string');
      expect(entry.groundTruth.reasoning!.length).toBeGreaterThan(10);
    }
  });

  it('should have concerns array in all groundTruth entries', () => {
    for (const entry of GOLDEN_DATASET_PHASE16) {
      expect(entry.groundTruth.concerns).toBeDefined();
      expect(Array.isArray(entry.groundTruth.concerns)).toBe(true);
    }
  });

  it('should have no empty strippedText', () => {
    for (const entry of GOLDEN_DATASET_PHASE16) {
      expect(entry.strippedText.length).toBeGreaterThan(0);
    }
  });

  it('should have groundTruth with credentialType for all entries', () => {
    for (const entry of GOLDEN_DATASET_PHASE16) {
      expect(entry.groundTruth.credentialType).toBeDefined();
    }
  });

  // Distribution checks
  it('should have at least 40 REGULATION entries', () => {
    const count = GOLDEN_DATASET_PHASE16.filter(
      e => e.groundTruth.credentialType === 'REGULATION',
    ).length;
    expect(count).toBeGreaterThanOrEqual(40);
  });

  it('should have at least 30 LICENSE entries', () => {
    const count = GOLDEN_DATASET_PHASE16.filter(
      e => e.groundTruth.credentialType === 'LICENSE',
    ).length;
    expect(count).toBeGreaterThanOrEqual(30);
  });

  it('should have at least 25 CLE entries', () => {
    const count = GOLDEN_DATASET_PHASE16.filter(
      e => e.groundTruth.credentialType === 'CLE',
    ).length;
    expect(count).toBeGreaterThanOrEqual(25);
  });

  it('should have at least 20 CERTIFICATE entries', () => {
    const count = GOLDEN_DATASET_PHASE16.filter(
      e => e.groundTruth.credentialType === 'CERTIFICATE',
    ).length;
    expect(count).toBeGreaterThanOrEqual(20);
  });

  it('should have at least 15 DEGREE entries', () => {
    const count = GOLDEN_DATASET_PHASE16.filter(
      e => e.groundTruth.credentialType === 'DEGREE',
    ).length;
    expect(count).toBeGreaterThanOrEqual(15);
  });

  it('should have at least 15 TRANSCRIPT entries', () => {
    const count = GOLDEN_DATASET_PHASE16.filter(
      e => e.groundTruth.credentialType === 'TRANSCRIPT',
    ).length;
    expect(count).toBeGreaterThanOrEqual(15);
  });

  it('should have at least 15 PROFESSIONAL entries', () => {
    const count = GOLDEN_DATASET_PHASE16.filter(
      e => e.groundTruth.credentialType === 'PROFESSIONAL',
    ).length;
    expect(count).toBeGreaterThanOrEqual(15);
  });

  it('should have at least 15 BUSINESS_ENTITY entries', () => {
    const count = GOLDEN_DATASET_PHASE16.filter(
      e => e.groundTruth.credentialType === 'BUSINESS_ENTITY',
    ).length;
    expect(count).toBeGreaterThanOrEqual(15);
  });

  it('should have at least 10 FINANCIAL entries', () => {
    const count = GOLDEN_DATASET_PHASE16.filter(
      e => e.groundTruth.credentialType === 'FINANCIAL',
    ).length;
    expect(count).toBeGreaterThanOrEqual(10);
  });

  it('should have at least 10 INSURANCE entries', () => {
    const count = GOLDEN_DATASET_PHASE16.filter(
      e => e.groundTruth.credentialType === 'INSURANCE',
    ).length;
    expect(count).toBeGreaterThanOrEqual(10);
  });

  it('should have at least 5 LEGAL entries', () => {
    const count = GOLDEN_DATASET_PHASE16.filter(
      e => e.groundTruth.credentialType === 'LEGAL',
    ).length;
    expect(count).toBeGreaterThanOrEqual(5);
  });

  it('should include international compliance entries', () => {
    const international = GOLDEN_DATASET_PHASE16.filter(
      e => e.tags.includes('international'),
    );
    expect(international.length).toBeGreaterThanOrEqual(10);
  });

  it('should include entries with non-empty concerns', () => {
    const withConcerns = GOLDEN_DATASET_PHASE16.filter(
      e => e.groundTruth.concerns && e.groundTruth.concerns.length > 0,
    );
    expect(withConcerns.length).toBeGreaterThanOrEqual(10);
  });

  it('should include compliance-tagged entries', () => {
    const compliance = GOLDEN_DATASET_PHASE16.filter(
      e => e.tags.includes('compliance'),
    );
    expect(compliance.length).toBeGreaterThanOrEqual(50);
  });
});
