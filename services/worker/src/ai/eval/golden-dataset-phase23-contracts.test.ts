/**
 * SCRUM-860: Contract dataset curation tests.
 *
 * Validates the GME10.2 contracts golden dataset against the Jira acceptance
 * distribution, privacy, and field-completeness requirements.
 */

import { describe, expect, it } from 'vitest';
import {
  CONTRACT_PHASE23_FIELD_HISTOGRAM,
  CONTRACT_PHASE23_TYPE_COUNTS,
  GOLDEN_DATASET_PHASE23_CONTRACTS,
} from './golden-dataset-phase23-contracts.js';
import type { GoldenDatasetEntry } from './types.js';

const EXPECTED_TOTAL = Object.values(CONTRACT_PHASE23_TYPE_COUNTS).reduce(
  (sum, count) => sum + count,
  0,
);

function nonEmptyGroundTruthFields(entry: GoldenDatasetEntry): number {
  return Object.values(entry.groundTruth).filter(value => {
    if (Array.isArray(value)) return value.length > 0;
    return value !== undefined && value !== '';
  }).length;
}

describe('Golden Dataset Phase 23 Contracts (SCRUM-860)', () => {
  it('matches the acceptance distribution total', () => {
    expect(EXPECTED_TOTAL).toBe(1040);
    expect(GOLDEN_DATASET_PHASE23_CONTRACTS).toHaveLength(EXPECTED_TOTAL);
  });

  it('has the exact contract subtype distribution required by Jira', () => {
    const observed = new Map<string, number>();
    for (const entry of GOLDEN_DATASET_PHASE23_CONTRACTS) {
      const contractType = entry.groundTruth.contractType ?? 'missing';
      observed.set(contractType, (observed.get(contractType) ?? 0) + 1);
    }

    for (const [contractType, expected] of Object.entries(CONTRACT_PHASE23_TYPE_COUNTS)) {
      expect(observed.get(contractType), contractType).toBe(expected);
    }
  });

  it('uses unique non-overlapping GD-4000+ IDs', () => {
    const ids = GOLDEN_DATASET_PHASE23_CONTRACTS.map(entry => entry.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const id of ids) {
      const numericId = Number(id.replace('GD-', ''));
      expect(numericId, id).toBeGreaterThanOrEqual(4000);
      expect(numericId, id).toBeLessThan(5100);
    }
  });

  it('has rich ground truth with at least eight non-null fields per entry', () => {
    for (const entry of GOLDEN_DATASET_PHASE23_CONTRACTS) {
      expect(nonEmptyGroundTruthFields(entry), entry.id).toBeGreaterThanOrEqual(8);
    }
  });

  it('includes parties and signatories for known non-adversarial contracts', () => {
    const knownContracts = GOLDEN_DATASET_PHASE23_CONTRACTS.filter(
      entry => !entry.tags.includes('adversarial'),
    );

    for (const entry of knownContracts) {
      expect(entry.groundTruth.parties, entry.id).toHaveLength(2);
      expect(entry.groundTruth.signatories?.length ?? 0, entry.id).toBeGreaterThanOrEqual(1);
    }
  });

  it('uses ISO dates for issued, effective, and expiry fields', () => {
    const dateFields = ['issuedDate', 'effectiveDate', 'expiryDate'] as const;

    for (const entry of GOLDEN_DATASET_PHASE23_CONTRACTS) {
      for (const field of dateFields) {
        const value = entry.groundTruth[field];
        if (value) {
          expect(value, `${entry.id}.${field}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
      }
    }
  });

  it('PII-strips source text and preserves redaction markers', () => {
    const piiPatterns = [
      /\b\d{3}-\d{2}-\d{4}\b/,
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b/i,
      /\(\d{3}\)\s*\d{3}-\d{4}/,
    ];

    for (const entry of GOLDEN_DATASET_PHASE23_CONTRACTS) {
      expect(entry.strippedText, entry.id).toContain('REDACTED');
      for (const pattern of piiPatterns) {
        expect(pattern.test(entry.strippedText), entry.id).toBe(false);
      }
    }
  });

  it('contains the required 60 adversarial/fraud contracts with fraud tags', () => {
    const fraudEntries = GOLDEN_DATASET_PHASE23_CONTRACTS.filter(
      entry => (entry.groundTruth.fraudSignals?.length ?? 0) > 0,
    );

    expect(fraudEntries).toHaveLength(CONTRACT_PHASE23_TYPE_COUNTS.adversarial_fraud);
    for (const entry of fraudEntries) {
      expect(entry.tags, entry.id).toContain('fraud');
      expect(entry.tags, entry.id).toContain('adversarial');
    }
  });

  it('publishes a field-presence histogram for the stats report', () => {
    expect(CONTRACT_PHASE23_FIELD_HISTOGRAM.contractType).toBe(EXPECTED_TOTAL);
    expect(CONTRACT_PHASE23_FIELD_HISTOGRAM.parties).toBe(EXPECTED_TOTAL);
    expect(CONTRACT_PHASE23_FIELD_HISTOGRAM.signatories).toBeGreaterThanOrEqual(980);
    expect(CONTRACT_PHASE23_FIELD_HISTOGRAM.paymentTerms).toBeGreaterThanOrEqual(980);
  });
});
