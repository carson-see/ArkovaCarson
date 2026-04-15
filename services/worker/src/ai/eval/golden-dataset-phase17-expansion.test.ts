/**
 * NPH-13: Golden Dataset Phase 17 Expansion Tests
 *
 * Validates the massive expansion targeting underrepresented types.
 */

import { describe, it, expect } from 'vitest';
import { GOLDEN_DATASET_PHASE17 } from './golden-dataset-phase17-expansion.js';

/** All valid credential types (including phase-14 rare types) */
const VALID_TYPES = [
  'DEGREE', 'LICENSE', 'CERTIFICATE', 'TRANSCRIPT', 'PROFESSIONAL',
  'CLE', 'BADGE', 'ATTESTATION', 'FINANCIAL', 'LEGAL', 'INSURANCE',
  'RESUME', 'MEDICAL', 'MILITARY', 'IDENTITY', 'OTHER',
  'SEC_FILING', 'PATENT', 'REGULATION', 'PUBLICATION',
  'CHARITY', 'ACCREDITATION', 'BUSINESS_ENTITY',
];

describe('Golden Dataset Phase 17 Expansion (NPH-13)', () => {
  it('has at least 500 entries', () => {
    expect(GOLDEN_DATASET_PHASE17.length).toBeGreaterThanOrEqual(500);
  });

  it('all IDs are unique', () => {
    const ids = GOLDEN_DATASET_PHASE17.map(e => e.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('all IDs are in GD-2xxx range', () => {
    for (const entry of GOLDEN_DATASET_PHASE17) {
      const num = parseInt(entry.id.replace('GD-', ''), 10);
      expect(num).toBeGreaterThanOrEqual(2200);
      expect(num).toBeLessThanOrEqual(2789);
    }
  });

  it('all entries have required fields', () => {
    for (const entry of GOLDEN_DATASET_PHASE17) {
      expect(entry.id, `Missing id`).toBeTruthy();
      expect(entry.description, `${entry.id}: missing description`).toBeTruthy();
      expect(entry.strippedText, `${entry.id}: missing strippedText`).toBeDefined();
      expect(entry.credentialTypeHint, `${entry.id}: missing credentialTypeHint`).toBeTruthy();
      expect(entry.groundTruth, `${entry.id}: missing groundTruth`).toBeTruthy();
      expect(entry.groundTruth.credentialType, `${entry.id}: missing credentialType`).toBeTruthy();
      expect(entry.source, `${entry.id}: missing source`).toBeTruthy();
      expect(entry.category, `${entry.id}: missing category`).toBeTruthy();
      expect(Array.isArray(entry.tags), `${entry.id}: tags not array`).toBe(true);
    }
  });

  it('all credentialTypes are valid', () => {
    for (const entry of GOLDEN_DATASET_PHASE17) {
      expect(
        VALID_TYPES,
        `${entry.id} has invalid type: ${entry.groundTruth.credentialType}`,
      ).toContain(entry.groundTruth.credentialType);
    }
  });

  it('all entries have reasoning field', () => {
    for (const entry of GOLDEN_DATASET_PHASE17) {
      const reasoning = entry.groundTruth.reasoning ?? '';
      expect(
        reasoning,
        `${entry.id}: missing reasoning`,
      ).toBeTruthy();
      expect(
        reasoning.length,
        `${entry.id}: reasoning too short`,
      ).toBeGreaterThan(10);
    }
  });

  it('has good type distribution — every target type has entries', () => {
    const typeCounts = new Map<string, number>();
    for (const entry of GOLDEN_DATASET_PHASE17) {
      const type = entry.groundTruth.credentialType ?? 'UNKNOWN';
      typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
    }

    const requiredTypes = [
      'MEDICAL', 'IDENTITY', 'RESUME', 'FINANCIAL', 'TRANSCRIPT',
      'MILITARY', 'PUBLICATION', 'INSURANCE', 'LEGAL', 'BADGE',
      'OTHER', 'CHARITY', 'PATENT', 'BUSINESS_ENTITY',
    ];

    for (const type of requiredTypes) {
      expect(
        typeCounts.get(type) ?? 0,
        `${type} should have entries`,
      ).toBeGreaterThan(0);
    }
  });

  it('MEDICAL has >= 40 entries', () => {
    const count = GOLDEN_DATASET_PHASE17.filter(e => e.groundTruth.credentialType === 'MEDICAL').length;
    expect(count).toBeGreaterThanOrEqual(40);
  });

  it('IDENTITY has >= 40 entries', () => {
    const count = GOLDEN_DATASET_PHASE17.filter(e => e.groundTruth.credentialType === 'IDENTITY').length;
    expect(count).toBeGreaterThanOrEqual(40);
  });

  it('~10% have non-empty fraudSignals', () => {
    const fraudCount = GOLDEN_DATASET_PHASE17.filter(
      e => e.groundTruth.fraudSignals && e.groundTruth.fraudSignals.length > 0,
    ).length;
    const ratio = fraudCount / GOLDEN_DATASET_PHASE17.length;
    // Accept 5-15% range
    expect(ratio).toBeGreaterThanOrEqual(0.05);
    expect(ratio).toBeLessThanOrEqual(0.15);
  });

  it('fraud entries have tags including "fraud" or "suspicious"', () => {
    const fraudEntries = GOLDEN_DATASET_PHASE17.filter(
      e => e.groundTruth.fraudSignals && e.groundTruth.fraudSignals.length > 0,
    );
    for (const entry of fraudEntries) {
      const hasFraudTag = entry.tags.includes('fraud') || entry.tags.includes('suspicious');
      expect(hasFraudTag, `${entry.id}: fraud entry should have fraud/suspicious tag`).toBe(true);
    }
  });

  it('no PII in strippedText (uses redaction patterns)', () => {
    const piiPatterns = [
      /\b\d{3}-\d{2}-\d{4}\b/,          // SSN
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}\b/, // Email
    ];

    for (const entry of GOLDEN_DATASET_PHASE17) {
      for (const pattern of piiPatterns) {
        expect(
          entry.strippedText,
          `${entry.id}: contains PII matching ${pattern}`,
        ).not.toMatch(pattern);
      }
    }
  });

  it('strippedText uses [REDACTED] patterns for PII', () => {
    const redactedCount = GOLDEN_DATASET_PHASE17.filter(
      e => e.strippedText.includes('REDACTED') || e.strippedText.includes('['),
    ).length;
    // Most entries should use redaction patterns
    expect(redactedCount / GOLDEN_DATASET_PHASE17.length).toBeGreaterThan(0.8);
  });
});
