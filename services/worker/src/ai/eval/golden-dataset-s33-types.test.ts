import { describe, expect, it } from 'vitest';
import { EXTRACTION_V6_SYSTEM_PROMPT } from '../prompts/extraction-v6.js';
import {
  S33_PROPOSED_SUBTYPES,
  V6_SUBTYPE_TAXONOMY,
  countS33SubstantiveGroundTruthFields,
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
});
