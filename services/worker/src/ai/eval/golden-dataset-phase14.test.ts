/**
 * Tests for Golden Dataset Phase 14 — Rare Type Expansion (NMT-14)
 */

import { describe, it, expect } from 'vitest';
import { GOLDEN_DATASET_PHASE14 } from './golden-dataset-phase14.js';

describe('golden-dataset-phase14', () => {
  it('should have 120 entries', () => {
    expect(GOLDEN_DATASET_PHASE14.length).toBe(120);
  });

  it('should have unique IDs', () => {
    const ids = GOLDEN_DATASET_PHASE14.map(e => e.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('should have IDs starting from GD-1766', () => {
    const numericIds = GOLDEN_DATASET_PHASE14
      .filter(e => e.id.startsWith('GD-'))
      .map(e => parseInt(e.id.replace('GD-', ''), 10));
    expect(Math.min(...numericIds)).toBe(1766);
  });

  it('should have no empty strippedText', () => {
    for (const entry of GOLDEN_DATASET_PHASE14) {
      expect(entry.strippedText.length).toBeGreaterThan(0);
    }
  });

  it('should have groundTruth with credentialType for all entries', () => {
    for (const entry of GOLDEN_DATASET_PHASE14) {
      expect(entry.groundTruth.credentialType).toBeDefined();
    }
  });

  it('should cover CHARITY type', () => {
    const charity = GOLDEN_DATASET_PHASE14.filter(
      e => e.groundTruth.credentialType === 'CHARITY',
    );
    expect(charity.length).toBeGreaterThanOrEqual(15);
  });

  it('should cover ACCREDITATION type', () => {
    const accreditation = GOLDEN_DATASET_PHASE14.filter(
      e => e.groundTruth.credentialType === 'ACCREDITATION',
    );
    expect(accreditation.length).toBeGreaterThanOrEqual(15);
  });

  it('should cover BADGE type', () => {
    const badge = GOLDEN_DATASET_PHASE14.filter(
      e => e.groundTruth.credentialType === 'BADGE',
    );
    expect(badge.length).toBeGreaterThanOrEqual(15);
  });

  it('should cover ATTESTATION type', () => {
    const attestation = GOLDEN_DATASET_PHASE14.filter(
      e => e.groundTruth.credentialType === 'ATTESTATION',
    );
    expect(attestation.length).toBeGreaterThanOrEqual(15);
  });

  it('should cover MEDICAL type', () => {
    const medical = GOLDEN_DATASET_PHASE14.filter(
      e => e.groundTruth.credentialType === 'MEDICAL',
    );
    expect(medical.length).toBeGreaterThanOrEqual(15);
  });

  it('should include edge cases', () => {
    const edgeCases = GOLDEN_DATASET_PHASE14.filter(
      e => e.category === 'edge-case',
    );
    expect(edgeCases.length).toBeGreaterThanOrEqual(10);
  });

  it('should include fraud/suspicious entries', () => {
    const fraud = GOLDEN_DATASET_PHASE14.filter(
      e => e.groundTruth.fraudSignals && e.groundTruth.fraudSignals.length > 0,
    );
    expect(fraud.length).toBeGreaterThanOrEqual(5);
  });

  it('should include international entries', () => {
    const international = GOLDEN_DATASET_PHASE14.filter(
      e => e.tags.includes('international'),
    );
    expect(international.length).toBeGreaterThanOrEqual(10);
  });

  it('should have valid fraud signal values', () => {
    const validSignals = new Set([
      'EXPIRED_ISSUER', 'SUSPICIOUS_DATES', 'KNOWN_DIPLOMA_MILL',
      'INVALID_FORMAT', 'INCONSISTENT_ISSUER', 'UNVERIFIABLE_ISSUER',
      'EXPIRED_CREDENTIAL', 'REVOKED_STATUS', 'SUSPICIOUS_TIMELINE',
      'MATERIAL_MISSTATEMENT', 'DUPLICATE_REGISTRATION',
      'RETRACTED_VERIFICATION', 'ENFORCEMENT_ACTION',
    ]);
    for (const entry of GOLDEN_DATASET_PHASE14) {
      if (entry.groundTruth.fraudSignals) {
        for (const signal of entry.groundTruth.fraudSignals) {
          expect(validSignals.has(signal)).toBe(true);
        }
      }
    }
  });
});
