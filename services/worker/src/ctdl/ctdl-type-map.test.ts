import { describe, expect, it } from 'vitest';
import { ANCHOR_CREDENTIAL_TYPES } from '../lib/credential-evidence.js';
import {
  CTDL_TYPE_MAP,
  isCtdlPublishableStatus,
  resolveCtdlType,
  toCtdlCredentialStatusType,
} from './ctdl-type-map.js';

const sortStrings = (values: readonly string[]) =>
  [...values].sort((a, b) => a.localeCompare(b));

describe('CTDL_TYPE_MAP', () => {
  it('covers every Arkova credential type in the worker enum', () => {
    expect(sortStrings(Object.keys(CTDL_TYPE_MAP))).toEqual(sortStrings(ANCHOR_CREDENTIAL_TYPES));
  });

  it('maps every credential type to a CTDL term', () => {
    for (const credentialType of ANCHOR_CREDENTIAL_TYPES) {
      expect(CTDL_TYPE_MAP[credentialType]).toMatch(/^ceterms:[A-Za-z]+$/);
    }
  });

  it('derives specific CTDL degree classes from Arkova sub_type', () => {
    expect(resolveCtdlType('DEGREE', 'bachelor')).toBe('ceterms:BachelorDegree');
    expect(resolveCtdlType('DEGREE', 'master')).toBe('ceterms:MasterDegree');
    expect(resolveCtdlType('DEGREE', 'doctorate')).toBe('ceterms:DoctoralDegree');
    expect(resolveCtdlType('DEGREE', 'professional_jd')).toBe('ceterms:ProfessionalDegree');
  });

  it('fails closed for non-published anchor statuses', () => {
    expect(toCtdlCredentialStatusType('PENDING')).toBeNull();
    expect(toCtdlCredentialStatusType('SUBMITTED')).toBeNull();
    expect(isCtdlPublishableStatus('PENDING')).toBe(false);
    expect(isCtdlPublishableStatus('SECURED')).toBe(true);
    expect(isCtdlPublishableStatus('REVOKED')).toBe(true);
  });
});
