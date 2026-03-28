/**
 * Golden Dataset Regression Tests (Phase 1 — Extraction Accuracy)
 *
 * Validates dataset integrity, coverage, and prompt alignment.
 * These tests run fast (no AI calls) and guard against regressions.
 */

import { describe, it, expect } from 'vitest';
import {
  FULL_GOLDEN_DATASET,
  getEntriesByType,
  getEntriesByTag,
} from './golden-dataset.js';
import { GOLDEN_DATASET_PHASE5 } from './golden-dataset-phase5.js';
import { GOLDEN_DATASET_PHASE6 } from './golden-dataset-phase6.js';
import { GOLDEN_DATASET_PHASE7 } from './golden-dataset-phase7.js';
import { EXTRACTION_SYSTEM_PROMPT } from '../prompts/extraction.js';

/** Credential types that Gemini classifies (user-uploaded documents) */
const GEMINI_CREDENTIAL_TYPES = [
  'DEGREE', 'LICENSE', 'CERTIFICATE', 'TRANSCRIPT', 'PROFESSIONAL',
  'CLE', 'BADGE', 'ATTESTATION', 'FINANCIAL', 'LEGAL', 'INSURANCE',
  'RESUME', 'MEDICAL', 'MILITARY', 'IDENTITY', 'OTHER',
] as const;

/** All credential types including pipeline-only (Nessie) types */
const ALL_CREDENTIAL_TYPES = [
  ...GEMINI_CREDENTIAL_TYPES,
  'SEC_FILING', 'PATENT', 'REGULATION', 'PUBLICATION',
] as const;

describe('Golden Dataset Integrity', () => {
  it('has at least 1150 total entries', () => {
    expect(FULL_GOLDEN_DATASET.length).toBeGreaterThanOrEqual(1150);
  });

  it('phase5 adds 200 entries', () => {
    expect(GOLDEN_DATASET_PHASE5.length).toBe(200);
  });

  it('phase6 adds 80 entries (user-document types)', () => {
    expect(GOLDEN_DATASET_PHASE6.length).toBe(80);
  });

  it('phase7 adds 150 entries (low-F1 credential types)', () => {
    expect(GOLDEN_DATASET_PHASE7.length).toBe(150);
  });

  it('all entries have unique IDs', () => {
    const ids = FULL_GOLDEN_DATASET.map(e => e.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('all entries have required fields', () => {
    for (const entry of FULL_GOLDEN_DATASET) {
      expect(entry.id).toBeTruthy();
      expect(entry.description).toBeTruthy();
      expect(entry.strippedText).toBeDefined();
      expect(entry.groundTruth.credentialType).toBeTruthy();
      expect(entry.source).toBeTruthy();
      expect(entry.category).toBeTruthy();
      expect(Array.isArray(entry.tags)).toBe(true);
    }
  });

  it('all groundTruth credentialTypes are valid', () => {
    for (const entry of FULL_GOLDEN_DATASET) {
      expect(ALL_CREDENTIAL_TYPES).toContain(entry.groundTruth.credentialType);
    }
  });

  it('all dates are valid ISO format', () => {
    const dateFields = ['issuedDate', 'expiryDate'] as const;
    for (const entry of FULL_GOLDEN_DATASET) {
      for (const field of dateFields) {
        const val = entry.groundTruth[field];
        if (val) {
          expect(val).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
      }
    }
  });

  it('no PII in stripped text', () => {
    const piiPatterns = [
      /\b\d{3}-\d{2}-\d{4}\b/,  // SSN
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b/i,  // Email
      /\(\d{3}\)\s*\d{3}-\d{4}/,  // Phone
    ];
    for (const entry of FULL_GOLDEN_DATASET) {
      for (const pattern of piiPatterns) {
        expect(
          pattern.test(entry.strippedText),
          `Entry ${entry.id} may contain PII matching ${pattern}`,
        ).toBe(false);
      }
    }
  });
});

describe('Golden Dataset Coverage', () => {
  it('every Gemini credential type has at least 5 entries', () => {
    for (const type of GEMINI_CREDENTIAL_TYPES) {
      const entries = getEntriesByType(type);
      expect(
        entries.length,
        `${type} has only ${entries.length} entries (need ≥5)`,
      ).toBeGreaterThanOrEqual(5);
    }
  });

  it('user-document types have sufficient entries after phase6', () => {
    const minPerType: Record<string, number> = {
      'RESUME': 15,
      'MEDICAL': 15,
      'MILITARY': 15,
      'IDENTITY': 15,
      'FINANCIAL': 10,
      'LEGAL': 10,
      'INSURANCE': 10,
      'ATTESTATION': 10,
    };
    for (const [type, min] of Object.entries(minPerType)) {
      const entries = getEntriesByType(type);
      expect(
        entries.length,
        `${type} has only ${entries.length} entries (need ≥${min})`,
      ).toBeGreaterThanOrEqual(min);
    }
  });

  it('has edge case entries (OCR noise, multilingual, sparse)', () => {
    expect(getEntriesByTag('ocr-noise').length).toBeGreaterThanOrEqual(5);
    expect(getEntriesByTag('non-english').length + getEntriesByTag('multilingual').length).toBeGreaterThanOrEqual(3);
  });

  it('has fraud/adversarial entries', () => {
    const fraudEntries = FULL_GOLDEN_DATASET.filter(
      e => e.groundTruth.fraudSignals && e.groundTruth.fraudSignals.length > 0,
    );
    expect(fraudEntries.length).toBeGreaterThanOrEqual(5);
  });
});

describe('Prompt Coverage', () => {
  it('extraction prompt covers all Gemini credential types', () => {
    for (const type of GEMINI_CREDENTIAL_TYPES) {
      expect(
        EXTRACTION_SYSTEM_PROMPT.includes(type),
        `EXTRACTION_SYSTEM_PROMPT missing type: ${type}`,
      ).toBe(true);
    }
  });

  it('extraction prompt has few-shot examples for RESUME', () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('RESUME');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('Resume');
  });

  it('extraction prompt has few-shot examples for MEDICAL', () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('MEDICAL');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('Vaccination');
  });

  it('extraction prompt has few-shot examples for MILITARY', () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('MILITARY');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('DD-214');
  });

  it('extraction prompt has few-shot examples for IDENTITY', () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('IDENTITY');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('Birth Certificate');
  });

  it('extraction prompt has at least 110 few-shot examples', () => {
    const exampleMatches = EXTRACTION_SYSTEM_PROMPT.match(/Example \d+/g);
    expect(exampleMatches).toBeTruthy();
    expect(exampleMatches!.length).toBeGreaterThanOrEqual(110);
  });
});
