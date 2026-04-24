/**
 * Tests for GRE-05: Reasoning Few-Shot Examples
 *
 * Validates structure, coverage, and quality of reasoning few-shot examples
 * used to guide Gemini's chain-of-thought extraction.
 */

import { describe, it, expect } from 'vitest';
import { REASONING_FEWSHOTS } from './reasoning-fewshots.js';

/** All credential types that must have at least one few-shot example */
const REQUIRED_TYPES = [
  'DEGREE', 'LICENSE', 'CERTIFICATE', 'TRANSCRIPT', 'PROFESSIONAL',
  'CLE', 'BADGE', 'ATTESTATION', 'FINANCIAL', 'LEGAL', 'INSURANCE',
  'RESUME', 'MEDICAL', 'MILITARY', 'IDENTITY', 'OTHER', 'BUSINESS_ENTITY',
] as const;

/** Minimum counts per credential type */
const MIN_COUNTS: Record<string, number> = {
  DEGREE: 8,
  LICENSE: 8,
  CERTIFICATE: 6,
  TRANSCRIPT: 6,
  PROFESSIONAL: 5,
  CLE: 5,
  BADGE: 3,
  ATTESTATION: 4,
  FINANCIAL: 3,
  LEGAL: 3,
  INSURANCE: 3,
  RESUME: 2,
  MEDICAL: 3,
  MILITARY: 2,
  IDENTITY: 2,
  OTHER: 2,
  BUSINESS_ENTITY: 3,
};

describe('GRE-05: Reasoning Few-Shot Examples', () => {
  it('has at least 80 examples', () => {
    expect(REASONING_FEWSHOTS.length).toBeGreaterThanOrEqual(80);
  });

  it('all credential types are covered', () => {
    const typesPresent = new Set(
      REASONING_FEWSHOTS.map(e => e.expectedOutput.credentialType),
    );
    for (const type of REQUIRED_TYPES) {
      expect(typesPresent.has(type), `Missing type: ${type}`).toBe(true);
    }
  });

  it('meets minimum count per credential type', () => {
    const counts: Record<string, number> = {};
    for (const ex of REASONING_FEWSHOTS) {
      const t = ex.expectedOutput.credentialType;
      counts[t] = (counts[t] || 0) + 1;
    }
    for (const [type, min] of Object.entries(MIN_COUNTS)) {
      expect(
        counts[type] || 0,
        `${type}: expected >= ${min}, got ${counts[type] || 0}`,
      ).toBeGreaterThanOrEqual(min);
    }
  });

  it('all examples have reasoning field', () => {
    for (const ex of REASONING_FEWSHOTS) {
      expect(ex.expectedOutput.reasoning, `Missing reasoning in example for ${ex.expectedOutput.credentialType}`).toBeTruthy();
    }
  });

  it('all examples have concerns array', () => {
    for (const ex of REASONING_FEWSHOTS) {
      expect(Array.isArray(ex.expectedOutput.concerns), `Missing concerns array in example for ${ex.expectedOutput.credentialType}`).toBe(true);
    }
  });

  it('all examples have confidence between 0 and 1', () => {
    for (const ex of REASONING_FEWSHOTS) {
      expect(ex.expectedOutput.confidence).toBeGreaterThanOrEqual(0);
      expect(ex.expectedOutput.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('no duplicate input texts', () => {
    const texts = REASONING_FEWSHOTS.map(e => e.inputText);
    const uniqueTexts = new Set(texts);
    expect(uniqueTexts.size).toBe(texts.length);
  });

  it('fraud examples have non-empty fraudSignals', () => {
    const fraudExamples = REASONING_FEWSHOTS.filter(
      e => e.expectedOutput.fraudSignals && e.expectedOutput.fraudSignals.length > 0,
    );
    expect(fraudExamples.length).toBeGreaterThanOrEqual(6);
    for (const ex of fraudExamples) {
      expect(ex.expectedOutput.fraudSignals!.length).toBeGreaterThan(0);
    }
  });

  it('all examples have non-empty inputText', () => {
    for (const ex of REASONING_FEWSHOTS) {
      expect(ex.inputText.length).toBeGreaterThan(50);
    }
  });

  it('all examples have subType', () => {
    for (const ex of REASONING_FEWSHOTS) {
      expect(ex.expectedOutput.subType, `Missing subType for ${ex.expectedOutput.credentialType}`).toBeTruthy();
    }
  });

  it('all examples have confidenceReasoning', () => {
    for (const ex of REASONING_FEWSHOTS) {
      expect(ex.expectedOutput.confidenceReasoning, `Missing confidenceReasoning`).toBeTruthy();
    }
  });

  it('no PII in input texts', () => {
    const piiPatterns = [
      /\b\d{3}-\d{2}-\d{4}\b/,  // SSN
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b/i,  // Email
      /\(\d{3}\)\s*\d{3}-\d{4}/,  // Phone
    ];
    for (const ex of REASONING_FEWSHOTS) {
      for (const pattern of piiPatterns) {
        expect(
          pattern.test(ex.inputText),
          `PII found in: ${ex.inputText.substring(0, 60)}`,
        ).toBe(false);
      }
    }
  });

  it('includes international examples', () => {
    const international = REASONING_FEWSHOTS.filter(
      e => e.inputText.toLowerCase().includes('international') ||
           e.inputText.includes('WES') ||
           e.expectedOutput.credentialType === 'DEGREE' && e.inputText.match(/India|Germany|Nigeria|Japan|UK|Kenya|Australia|Brazil|France/i),
    );
    expect(international.length).toBeGreaterThanOrEqual(3);
  });

  it('includes expired credential examples', () => {
    const expired = REASONING_FEWSHOTS.filter(
      e => e.expectedOutput.concerns?.some(c => c.toLowerCase().includes('expir')) ||
           e.inputText.toLowerCase().includes('expired'),
    );
    expect(expired.length).toBeGreaterThanOrEqual(2);
  });
});
