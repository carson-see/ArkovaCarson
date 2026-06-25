import { describe, expect, it } from 'vitest';
import { ANCHOR_CREDENTIAL_TYPES } from '../lib/credential-evidence.js';
import {
  CTDL_TYPE_MAP,
  isCtdlPublishableStatus,
  resolveCtdlType,
  statusAllowsExpiration,
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

  it('pins the registry-facing mappings called out by SCRUM-1875', () => {
    expect(resolveCtdlType('BADGE')).toBe('ceterms:OpenBadge');
    expect(resolveCtdlType('ATTESTATION')).toBe('ceterms:Certification');
    expect(resolveCtdlType('CERTIFICATE')).toBe('ceterms:Certificate');
    expect(resolveCtdlType('LICENSE')).toBe('ceterms:License');

    // CTDL models CEU as creditUnit:ContinuingEducationUnit, not a credential @type.
    expect(resolveCtdlType('CLE')).toBe('ceterms:Certificate');
    expect(resolveCtdlType('CPE')).toBe('ceterms:Certificate');
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

  // SCRUM-2374 (CE-03) — ceterms:expirationDate is a forward-looking validity
  // assertion. It is only coherent for statuses where the credential is (or was)
  // running out its own term: ACTIVE/SECURED (still valid) and EXPIRED (term
  // already lapsed). For REVOKED/SUPERSEDED the credential ended for a different
  // reason, so a future expiry would contradict the status (the conflation Jeanne
  // Kitchens flagged) — statusAllowsExpiration gates the emission at the source.
  it('allows ceterms:expirationDate only for term-bound statuses (CE-03)', () => {
    expect(statusAllowsExpiration('ACTIVE')).toBe(true);
    expect(statusAllowsExpiration('SECURED')).toBe(true);
    expect(statusAllowsExpiration('EXPIRED')).toBe(true);

    expect(statusAllowsExpiration('REVOKED')).toBe(false);
    expect(statusAllowsExpiration('SUPERSEDED')).toBe(false);

    // Non-publishable statuses never reach the serializer, but the gate is
    // closed for them too (defense in depth).
    expect(statusAllowsExpiration('PENDING')).toBe(false);
    expect(statusAllowsExpiration('SUBMITTED')).toBe(false);
  });
});
