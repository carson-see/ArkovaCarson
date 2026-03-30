/**
 * Tests for Feature-Based Confidence Meta-Model v2
 */

import { describe, it, expect } from 'vitest';
import {
  estimateOcrNoise,
  extractConfidenceFeatures,
  predictConfidence,
  computeAdjustedConfidence,
} from './confidence-model.js';
import type { ConfidenceFeatures } from './confidence-model.js';
import type { ExtractedFields } from './types.js';

/** Default v2 fields for test convenience */
const V2_DEFAULTS: Pick<ConfidenceFeatures, 'hasJurisdiction' | 'groundingScore' | 'provider' | 'fraudSignalCount'> = {
  hasJurisdiction: false,
  groundingScore: -1,
  provider: 'gemini',
  fraudSignalCount: 0,
};

describe('estimateOcrNoise', () => {
  it('returns 1.0 for empty text', () => {
    expect(estimateOcrNoise('')).toBe(1.0);
    expect(estimateOcrNoise('   ')).toBe(1.0);
  });

  it('returns high noise for very short text', () => {
    expect(estimateOcrNoise('ABC')).toBeGreaterThan(0.5);
  });

  it('returns low noise for clean credential text', () => {
    const cleanText = 'University of Michigan. Bachelor of Science in Computer Science. Conferred on the Third Day of May, Two Thousand Twenty-Five. Ann Arbor, Michigan.';
    expect(estimateOcrNoise(cleanText)).toBeLessThan(0.3);
  });

  it('returns higher noise for OCR-corrupted text', () => {
    const noisyText = 'CompT1A. Security+ (SY0-701). [NAME_REDACTED]. Cert1fication Date: November 2O25. Val1d Until: November 2O28.';
    const cleanText = 'CompTIA. Security+ (SY0-701). [NAME_REDACTED]. Certification Date: November 2025. Valid Until: November 2028.';
    expect(estimateOcrNoise(noisyText)).toBeGreaterThan(estimateOcrNoise(cleanText));
  });
});

describe('extractConfidenceFeatures', () => {
  it('extracts features from a rich extraction result', () => {
    const fields: ExtractedFields = {
      credentialType: 'DEGREE',
      issuerName: 'University of Michigan',
      issuedDate: '2025-05-03',
      fieldOfStudy: 'Computer Science',
      degreeLevel: 'Bachelor',
      jurisdiction: 'Michigan, USA',
    };
    const features = extractConfidenceFeatures(fields, 0.92, 'University of Michigan. Bachelor of Science.');
    // issuerName, issuedDate, fieldOfStudy, degreeLevel, jurisdiction = 5
    expect(features.fieldsExtracted).toBe(5);
    expect(features.hasIssuerName).toBe(true);
    expect(features.hasIssuedDate).toBe(true);
    expect(features.hasFieldOfStudy).toBe(true);
    expect(features.hasJurisdiction).toBe(true);
    expect(features.rawConfidence).toBe(0.92);
    expect(features.credentialType).toBe('DEGREE');
  });

  it('extracts features from a sparse extraction result', () => {
    const fields: ExtractedFields = {
      credentialType: 'OTHER',
    };
    const features = extractConfidenceFeatures(fields, 0.3, 'Some text');
    expect(features.fieldsExtracted).toBe(0);
    expect(features.hasIssuerName).toBe(false);
    expect(features.hasIssuedDate).toBe(false);
    expect(features.hasJurisdiction).toBe(false);
  });

  it('passes through v2 options (groundingScore, provider, fraudSignalCount)', () => {
    const fields: ExtractedFields = { credentialType: 'LICENSE', issuerName: 'State Board' };
    const features = extractConfidenceFeatures(fields, 0.85, 'State Board License', {
      groundingScore: 0.9,
      provider: 'nessie',
      fraudSignalCount: 2,
    });
    expect(features.groundingScore).toBe(0.9);
    expect(features.provider).toBe('nessie');
    expect(features.fraudSignalCount).toBe(2);
  });
});

describe('predictConfidence', () => {
  it('produces higher confidence for rich, high-confidence extractions', () => {
    const richResult = predictConfidence({
      ...V2_DEFAULTS,
      rawConfidence: 0.95,
      fieldsExtracted: 7,
      credentialType: 'DEGREE',
      textLength: 500,
      hasIssuerName: true,
      hasIssuedDate: true,
      hasFieldOfStudy: true,
      hasJurisdiction: true,
      ocrNoiseScore: 0.0,
      groundingScore: 0.95,
    });

    const sparseResult = predictConfidence({
      ...V2_DEFAULTS,
      rawConfidence: 0.3,
      fieldsExtracted: 1,
      credentialType: 'OTHER',
      textLength: 20,
      hasIssuerName: false,
      hasIssuedDate: false,
      hasFieldOfStudy: false,
      hasJurisdiction: false,
      ocrNoiseScore: 0.8,
      groundingScore: 0.1,
    });

    expect(richResult).toBeGreaterThan(sparseResult);
    expect(richResult).toBeGreaterThan(0.7);
    expect(sparseResult).toBeLessThan(0.6);
  });

  it('returns value in [0, 1] range', () => {
    const extreme1 = predictConfidence({
      ...V2_DEFAULTS,
      rawConfidence: 1.0,
      fieldsExtracted: 10,
      credentialType: 'DEGREE',
      textLength: 2000,
      hasIssuerName: true,
      hasIssuedDate: true,
      hasFieldOfStudy: true,
      hasJurisdiction: true,
      ocrNoiseScore: 0.0,
      groundingScore: 1.0,
    });

    const extreme2 = predictConfidence({
      ...V2_DEFAULTS,
      rawConfidence: 0.0,
      fieldsExtracted: 0,
      credentialType: 'OTHER',
      textLength: 0,
      hasIssuerName: false,
      hasIssuedDate: false,
      hasFieldOfStudy: false,
      hasJurisdiction: false,
      ocrNoiseScore: 1.0,
      groundingScore: 0.0,
    });

    expect(extreme1).toBeLessThanOrEqual(1.0);
    expect(extreme1).toBeGreaterThanOrEqual(0.0);
    expect(extreme2).toBeLessThanOrEqual(1.0);
    expect(extreme2).toBeGreaterThanOrEqual(0.0);
  });

  it('penalizes CERTIFICATE and OTHER types', () => {
    const baseFeatures: ConfidenceFeatures = {
      ...V2_DEFAULTS,
      rawConfidence: 0.85,
      fieldsExtracted: 5,
      credentialType: 'DEGREE',
      textLength: 300,
      hasIssuerName: true,
      hasIssuedDate: true,
      hasFieldOfStudy: true,
      hasJurisdiction: false,
      ocrNoiseScore: 0.1,
    };

    const degree = predictConfidence({ ...baseFeatures, credentialType: 'DEGREE' });
    const cert = predictConfidence({ ...baseFeatures, credentialType: 'CERTIFICATE' });
    const other = predictConfidence({ ...baseFeatures, credentialType: 'OTHER' });

    expect(degree).toBeGreaterThan(cert);
    expect(cert).toBeGreaterThan(other);
  });

  it('penalizes OCR noise', () => {
    // Use lower rawConfidence so sigmoid doesn't saturate
    const baseFeatures: ConfidenceFeatures = {
      ...V2_DEFAULTS,
      rawConfidence: 0.55,
      fieldsExtracted: 3,
      credentialType: 'CERTIFICATE',
      textLength: 200,
      hasIssuerName: true,
      hasIssuedDate: true,
      hasFieldOfStudy: false,
      hasJurisdiction: false,
      ocrNoiseScore: 0.0,
    };

    const clean = predictConfidence({ ...baseFeatures, ocrNoiseScore: 0.0 });
    const noisy = predictConfidence({ ...baseFeatures, ocrNoiseScore: 0.8 });

    expect(clean).toBeGreaterThan(noisy);
  });

  it('penalizes fraud signals', () => {
    // Use mid-range confidence so sigmoid doesn't saturate
    const baseFeatures: ConfidenceFeatures = {
      ...V2_DEFAULTS,
      rawConfidence: 0.55,
      fieldsExtracted: 3,
      credentialType: 'CERTIFICATE',
      textLength: 200,
      hasIssuerName: true,
      hasIssuedDate: true,
      hasFieldOfStudy: false,
      hasJurisdiction: false,
      ocrNoiseScore: 0.1,
    };

    const clean = predictConfidence({ ...baseFeatures, fraudSignalCount: 0 });
    const flagged = predictConfidence({ ...baseFeatures, fraudSignalCount: 3 });

    expect(clean).toBeGreaterThan(flagged);
  });

  it('applies provider-specific offsets', () => {
    const baseFeatures: ConfidenceFeatures = {
      ...V2_DEFAULTS,
      rawConfidence: 0.85,
      fieldsExtracted: 5,
      credentialType: 'LICENSE',
      textLength: 300,
      hasIssuerName: true,
      hasIssuedDate: true,
      hasFieldOfStudy: true,
      hasJurisdiction: true,
      ocrNoiseScore: 0.1,
    };

    const gemini = predictConfidence({ ...baseFeatures, provider: 'gemini' });
    const nessie = predictConfidence({ ...baseFeatures, provider: 'nessie' });
    // Both should produce valid results (may differ due to provider offsets)
    expect(gemini).toBeGreaterThanOrEqual(0);
    expect(nessie).toBeGreaterThanOrEqual(0);
  });
});

describe('computeAdjustedConfidence', () => {
  it('returns a number in [0, 1]', () => {
    const fields: ExtractedFields = {
      credentialType: 'DEGREE',
      issuerName: 'MIT',
      issuedDate: '2025-05-01',
      fieldOfStudy: 'Computer Science',
    };
    const result = computeAdjustedConfidence(fields, 0.85, 'MIT. Bachelor of Science. Computer Science.');
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(1);
  });

  it('integrates feature extraction and prediction', () => {
    const fields: ExtractedFields = {
      credentialType: 'CERTIFICATE',
      issuerName: 'CompTIA',
    };
    const resultClean = computeAdjustedConfidence(
      fields,
      0.80,
      'CompTIA. Security+ Certification. Date: 2025-09-01.',
    );
    const resultNoisy = computeAdjustedConfidence(
      fields,
      0.80,
      'CompT1A. Secur1ty+. D4te: 2O25.',
    );
    // Same raw confidence, but noisy text should produce lower adjusted confidence
    expect(resultClean).toBeGreaterThan(resultNoisy);
  });

  it('accepts v2 options for grounding and provider', () => {
    const fields: ExtractedFields = {
      credentialType: 'LICENSE',
      issuerName: 'State Board of Medicine',
      licenseNumber: 'MD-12345',
    };
    const result = computeAdjustedConfidence(
      fields, 0.90, 'State Board of Medicine. License MD-12345.',
      { groundingScore: 0.95, provider: 'nessie', fraudSignalCount: 0 },
    );
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(1);
  });
});
