import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, it, expect } from 'vitest';
import {
  CREDENTIAL_TYPES,
  CREDENTIAL_SUB_TYPES,
  ALL_SUB_TYPES,
  isValidSubType,
} from '../validators';
import { formatCredentialSubType } from '../copy';

describe('Credential Sub-Type Taxonomy (GRE-01)', () => {
  it('every credential type has at least one sub-type', () => {
    for (const type of CREDENTIAL_TYPES) {
      const subTypes = CREDENTIAL_SUB_TYPES[type];
      expect(subTypes, `${type} should have sub-types`).toBeDefined();
      expect(subTypes.length, `${type} should have at least 1 sub-type`).toBeGreaterThanOrEqual(1);
    }
  });

  it('no duplicate sub-types within a credential type', () => {
    for (const type of CREDENTIAL_TYPES) {
      const subTypes = CREDENTIAL_SUB_TYPES[type];
      const unique = new Set(subTypes);
      expect(unique.size, `${type} has duplicate sub-types`).toBe(subTypes.length);
    }
  });

  it('sub-types use snake_case format', () => {
    for (const type of CREDENTIAL_TYPES) {
      for (const subType of CREDENTIAL_SUB_TYPES[type]) {
        expect(subType, `${type}.${subType} should be snake_case`).toMatch(/^[a-z0-9_]+$/);
      }
    }
  });

  it('every sub-type has a readable public display label', () => {
    for (const subType of ALL_SUB_TYPES) {
      const label = formatCredentialSubType(subType);
      expect(label, `${subType} should have a display label`).toBeTruthy();
      expect(label).not.toContain('_');
      expect(label).toMatch(/^[A-Z0-9]/);
    }
    expect(formatCredentialSubType('professional_certification')).toBe('Professional Certification');
  });

  it('ALL_SUB_TYPES contains all sub-types from all types', () => {
    const expectedTotal = Object.values(CREDENTIAL_SUB_TYPES)
      .reduce((sum, arr) => sum + arr.length, 0);
    expect(ALL_SUB_TYPES.length).toBe(expectedTotal);
  });

  it('isValidSubType returns true for valid combinations', () => {
    expect(isValidSubType('DEGREE', 'bachelor')).toBe(true);
    expect(isValidSubType('LICENSE', 'nursing_rn')).toBe(true);
    expect(isValidSubType('TRANSCRIPT', 'official_undergraduate')).toBe(true);
    expect(isValidSubType('CLE', 'ethics_cle')).toBe(true);
    expect(isValidSubType('MEDICAL', 'npi_registration')).toBe(true);
    expect(isValidSubType('BUSINESS_ENTITY', 'certificate_of_good_standing')).toBe(true);
  });

  it('isValidSubType returns false for invalid combinations', () => {
    expect(isValidSubType('DEGREE', 'nursing_rn')).toBe(false);
    expect(isValidSubType('LICENSE', 'bachelor')).toBe(false);
    expect(isValidSubType('TRANSCRIPT', 'utility_patent')).toBe(false);
    expect(isValidSubType('OTHER', 'bachelor')).toBe(false);
  });

  it('isValidSubType returns false for non-existent sub-types', () => {
    expect(isValidSubType('DEGREE', 'phd')).toBe(false); // should be 'doctorate'
    expect(isValidSubType('LICENSE', 'rn')).toBe(false); // should be 'nursing_rn'
  });

  it('key credential types have comprehensive sub-types', () => {
    const degreeSubTypes = CREDENTIAL_SUB_TYPES.DEGREE;
    expect(degreeSubTypes).toContain('bachelor');
    expect(degreeSubTypes).toContain('master');
    expect(degreeSubTypes).toContain('doctorate');
    expect(degreeSubTypes).toContain('associate');

    const transcriptSubTypes = CREDENTIAL_SUB_TYPES.TRANSCRIPT;
    expect(transcriptSubTypes).toContain('official_undergraduate');
    expect(transcriptSubTypes).toContain('official_graduate');
    expect(transcriptSubTypes).toContain('unofficial');
    expect(transcriptSubTypes).toContain('international_wes');

    const licenseSubTypes = CREDENTIAL_SUB_TYPES.LICENSE;
    expect(licenseSubTypes).toContain('nursing_rn');
    expect(licenseSubTypes).toContain('law_bar_admission');
    expect(licenseSubTypes).toContain('engineering_pe');
    expect(licenseSubTypes).toContain('real_estate');
    expect(licenseSubTypes).toContain('teaching');
    expect(licenseSubTypes).toContain('cpa');

    const bizSubTypes = CREDENTIAL_SUB_TYPES.BUSINESS_ENTITY;
    expect(bizSubTypes).toContain('articles_of_incorporation');
    expect(bizSubTypes).toContain('certificate_of_good_standing');
    expect(bizSubTypes).toContain('dissolution');
  });

  it('extraction prompt lists every credential type sub-type (drift guard)', () => {
    const promptPath = resolve(__dirname, '../../../services/worker/src/ai/prompts/extraction.ts');
    const promptSource = readFileSync(promptPath, 'utf-8');

    for (const type of CREDENTIAL_TYPES) {
      const subTypes = CREDENTIAL_SUB_TYPES[type];
      for (const subType of subTypes) {
        expect(
          promptSource,
          `extraction prompt missing ${type}.${subType} — update services/worker/src/ai/prompts/extraction.ts`,
        ).toContain(subType);
      }
    }
  });
});
