import { describe, expect, it } from 'vitest';
import { EXTRACTION_V6_SYSTEM_PROMPT } from '../prompts/extraction-v6.js';
import {
  S33_COVERED_MINIMUM_POST_VALIDATION_DEPTH,
  S33_PROPOSED_SUBTYPES,
  V6_SUBTYPE_TAXONOMY,
  assertS33HeldoutGroundTruthContract,
  countS33SubstantiveGroundTruthFields,
  evaluateS33HeldoutGroundTruthContract,
  normalizeForFingerprint,
} from './golden-dataset-s33-types.js';

function promptSubtypeTaxonomy(): Record<string, string[]> {
  const block = EXTRACTION_V6_SYSTEM_PROMPT
    .split('SUBTYPE TAXONOMY (use these exact values when applicable):')[1]
    ?.split('Other →')[0];
  if (!block) throw new Error('v6 subtype taxonomy block is missing');
  return Object.fromEntries(block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[A-Z_]+:/.test(line))
    .map((line) => {
      const [credentialType, valuesWithNote] = line.split(':', 2);
      const values = valuesWithNote.split(' (e.g.,', 1)[0]
        .split('|')
        .map((value) => value.trim());
      return [credentialType, values];
    }));
}

describe('S3.3 held-out shared taxonomy support', () => {
  it('mirrors the ratified v6 prompt taxonomy exactly', () => {
    expect(V6_SUBTYPE_TAXONOMY).toEqual(promptSubtypeTaxonomy());
  });

  it('keeps the CPE extension quarantined as proposed and absent from v6', () => {
    expect(S33_PROPOSED_SUBTYPES).toEqual({
      CPE: ['general_cpe', 'ethics_cpe', 'specialized_cpe'],
    });
    expect(V6_SUBTYPE_TAXONOMY).not.toHaveProperty('CPE');
    expect(EXTRACTION_V6_SYSTEM_PROMPT).not.toMatch(/^CPE:/m);
  });

  it('normalizes case and whitespace without changing substantive tokens', () => {
    expect(normalizeForFingerprint('  Nursing\n Council\tCertificate  '))
      .toBe('nursing council certificate');
  });

  it('does not let taxonomy labels or fraudSignals inflate the five-field floor', () => {
    expect(countS33SubstantiveGroundTruthFields({
      credentialType: 'LICENSE',
      subType: 'nursing_rn',
      fraudSignals: [],
      issuerName: 'Nursing Council',
      issuedDate: '2026-01-01',
      jurisdiction: 'KE',
      licenseNumber: 'NCK-001',
    })).toBe(4);
  });

  it('counts five extraction fields independently of taxonomy labels', () => {
    expect(countS33SubstantiveGroundTruthFields({
      credentialType: 'LICENSE',
      subType: 'nursing_rn',
      issuerName: 'Nursing Council',
      issuedDate: '2026-01-01',
      jurisdiction: 'KE',
      licenseNumber: 'NCK-001',
      fieldOfStudy: 'Community Health Nursing',
    })).toBe(5);
  });

  it('does not count eval-only control or reasoning metadata as extraction facts', () => {
    expect(countS33SubstantiveGroundTruthFields({
      credentialType: 'LICENSE',
      subType: 'nursing_rn',
      fraudSignals: [],
      manualReviewExpected: true,
      parseFailureExpected: false,
      reasoning: 'Expected reasoning used only by the evaluator',
      concerns: ['Expected concern used only by the evaluator'],
      issuerName: 'Nursing Council',
      jurisdiction: 'KE',
      licenseNumber: 'NCK-001',
    })).toBe(3);
  });

  it('counts only meaningful values while preserving a legitimate zero', () => {
    expect(countS33SubstantiveGroundTruthFields({
      issuerName: '   ',
      issuedDate: null as unknown as string,
      parties: [],
      signatories: [''],
      creditHours: 0,
    })).toBe(1);
  });

  it('does not count unknown structural keys toward the depth floor', () => {
    const groundTruthWithExtras = {
      issuerName: 'Nursing Council of Kenya',
      bogusA: 'not a truth field',
      bogusB: 'not a truth field',
      bogusC: 'not a truth field',
      bogusD: 'not a truth field',
    };

    expect(countS33SubstantiveGroundTruthFields(groundTruthWithExtras)).toBe(1);
  });

  it.each([
    ['CERTIFICATE', 'providerName', {
      issuerName: 'Issuer', issuedDate: '2026-01-01', fieldOfStudy: 'Safety', jurisdiction: 'KE',
    }],
    ['CERTIFICATE', 'courseId', {
      issuerName: 'Issuer', issuedDate: '2026-01-01', fieldOfStudy: 'Safety', jurisdiction: 'KE',
    }],
    ['FINANCIAL', 'providerName', {
      issuerName: 'Issuer', issuedDate: '2026-01-01', fieldOfStudy: 'Audit', jurisdiction: 'KE',
    }],
    ['IDENTITY', 'deliveryMethod', {
      issuerName: 'Issuer', issuedDate: '2026-01-01', expiryDate: '2036-01-01', jurisdiction: 'KE',
    }],
    ['LICENSE', 'goodStandingStatus', {
      issuerName: 'Board', issuedDate: '2026-01-01', licenseNumber: 'L-1', jurisdiction: 'KE',
    }],
    ['ATTESTATION', 'goodStandingStatus', {
      issuerName: 'Board', issuedDate: '2026-01-01', fieldOfStudy: 'Law', jurisdiction: 'KE',
    }],
    ['BUSINESS_ENTITY', 'firmName', {
      issuerName: 'Registry', issuedDate: '2026-01-01', entityType: 'LLC', jurisdiction: 'KE',
    }],
    ['LICENSE', 'barNumber', {
      issuerName: 'Bar', issuedDate: '2026-01-01', licenseNumber: 'B-1', jurisdiction: 'KE',
    }],
  ] as const)(
    'measures %s depth after production strips invalid %s',
    (credentialType, invalidField, validGroundTruth) => {
      const groundTruth = {
        credentialType,
        subType: 'concrete',
        fraudSignals: [],
        ...validGroundTruth,
        [invalidField]: 'must-not-count',
      };

      expect(countS33SubstantiveGroundTruthFields(groundTruth)).toBe(4);
      expect(evaluateS33HeldoutGroundTruthContract({
        id: 'GD-S33-COVERED-001',
        groundTruth,
      })).toMatchObject({
        accepted: false,
        kind: 'covered',
        postValidationDepth: 4,
        strippedFields: expect.arrayContaining([invalidField]),
      });
    },
  );

  it('accepts only the exact OOD abstention shape and exempts it from depth/subtype floors', () => {
    expect(evaluateS33HeldoutGroundTruthContract({
      id: 'GD-S33-OOD-001',
      groundTruth: {
        credentialType: 'OTHER',
        subType: 'other',
        fraudSignals: [],
      },
    })).toEqual({
      accepted: true,
      entryId: 'GD-S33-OOD-001',
      errors: [],
      kind: 'ood-abstention',
      postValidationDepth: null,
      strippedFields: [],
    });

    expect(evaluateS33HeldoutGroundTruthContract({
      id: 'GD-S33-OOD-002',
      groundTruth: {
        credentialType: 'OTHER',
        subType: 'other',
        fraudSignals: [],
        issuerName: 'invented padding',
      },
    })).toMatchObject({ accepted: false, kind: 'ood-abstention' });

    expect(evaluateS33HeldoutGroundTruthContract({
      id: 'GD-S33-KE-001',
      groundTruth: {
        credentialType: 'OTHER',
        subType: 'other',
        fraudSignals: [],
      },
    })).toMatchObject({ accepted: false, kind: 'covered' });
  });

  it('enforces the concrete subtype rule on covered entries after the CTO OOD split', () => {
    expect(evaluateS33HeldoutGroundTruthContract({
      id: 'GD-S33-KE-001',
      groundTruth: {
        credentialType: 'LICENSE',
        subType: 'other',
        issuerName: 'Board',
        issuedDate: '2026-01-01',
        expiryDate: '2027-01-01',
        licenseNumber: 'L-1',
        jurisdiction: 'KE',
      },
    })).toMatchObject({
      accepted: false,
      postValidationDepth: S33_COVERED_MINIMUM_POST_VALIDATION_DEPTH,
    });
  });

  it('checks every covered row rather than accepting a sampled prefix', () => {
    const coveredEntries = Array.from({ length: 72 }, (_, index) => ({
      id: `GD-S33-COVERED-${String(index + 1).padStart(3, '0')}`,
      groundTruth: {
        credentialType: 'LICENSE',
        subType: 'nursing_rn',
        issuerName: 'Board',
        issuedDate: '2026-01-01',
        expiryDate: '2027-01-01',
        licenseNumber: `L-${index + 1}`,
        jurisdiction: 'KE',
        fraudSignals: [],
      },
    }));

    expect(() => assertS33HeldoutGroundTruthContract(coveredEntries)).not.toThrow();
    Reflect.deleteProperty(coveredEntries[71].groundTruth, 'expiryDate');
    expect(() => assertS33HeldoutGroundTruthContract(coveredEntries))
      .toThrow(/GD-S33-COVERED-072.*post-production.*4.*minimum 5/i);
  });
});
