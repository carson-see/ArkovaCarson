import { describe, expect, it } from 'vitest';
import { buildCtdlJsonLd, type CtdlAnchor } from './ctdl-serializer.js';
import { assertValidCtdlJsonLd, validateCtdlJsonLd } from './ctdl-validation.js';

const baseAnchor: CtdlAnchor = {
  publicId: 'ARK-2026-CTDL-001',
  status: 'SECURED',
  credentialType: 'DEGREE',
  subType: 'bachelor',
  label: 'Bachelor of Science',
  description: 'Public credential description',
  metadata: { fingerprint: 'a'.repeat(64), recipient_email: 'recipient@example.com' },
  createdAt: '2026-05-20T12:00:00.000Z',
  chainTimestamp: '2026-05-20T12:10:00.000Z',
  issuedAt: '2026-05-01T00:00:00.000Z',
  expiresAt: null,
  revokedAt: null,
  revocationReason: null,
  issuer: {
    name: 'Arkova University',
    publicId: 'ORG-ARKOVA-U',
    websiteUrl: 'https://example.edu',
  },
};

describe('validateCtdlJsonLd', () => {
  it('accepts serialized Arkova CTDL JSON-LD with required Credential Registry fields', () => {
    const jsonLd = buildCtdlJsonLd(baseAnchor, {
      verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001',
    });

    expect(validateCtdlJsonLd(jsonLd)).toEqual({ valid: true, errors: [] });
    expect(() => assertValidCtdlJsonLd(jsonLd)).not.toThrow();
  });

  it('rejects missing required CTDL structures without network schema access', () => {
    const invalid = {
      '@context': 'https://credreg.net/ctdl/schema/context/json',
      '@type': 'ceterms:BachelorDegree',
      'ceterms:name': 'Bachelor of Science',
      'ceterms:ctid': 'ce-11111111-1111-1111-1111-111111111111',
      'ceterms:credentialStatusType': 'ceterms:Active',
      'ceterms:dateEffective': '2026-05-01T00:00:00.000Z',
      'ceterms:offeredBy': { '@type': 'ceterms:Organization' },
      'ceterms:verificationServiceProfile': {
        '@type': 'ceterms:VerificationServiceProfile',
        'ceterms:name': 'Arkova credential verification',
      },
    };

    expect(validateCtdlJsonLd(invalid)).toEqual({
      valid: false,
      errors: [
        'ceterms:offeredBy.ceterms:name is required',
        'ceterms:verificationServiceProfile.ceterms:verificationService must be an absolute http(s) URL',
        'ceterms:identifier must be an object',
      ],
    });
    expect(() => assertValidCtdlJsonLd(invalid)).toThrow(/ceterms:offeredBy\.ceterms:name/);
  });

  it('rejects fake CTIDs derived from Arkova public IDs', () => {
    const jsonLd = buildCtdlJsonLd(baseAnchor, {
      verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001',
    });

    const invalid = {
      ...jsonLd,
      'ceterms:ctid': 'ce-ARK-2026-CTDL-001',
      'ceterms:offeredBy': {
        ...jsonLd['ceterms:offeredBy'],
        'ceterms:ctid': 'ce-ORG-ARKOVA-U',
      },
    };

    expect(validateCtdlJsonLd(invalid)).toEqual({
      valid: false,
      errors: [
        'ceterms:ctid must be a real Credential Engine CTID when present',
        'ceterms:offeredBy.ceterms:ctid must be a real Credential Engine CTID when present',
      ],
    });
  });

  it('rejects unsafe public JSON-LD keys and internal values anywhere in the document', () => {
    const jsonLd = buildCtdlJsonLd(baseAnchor, {
      verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001',
    });

    const unsafe = {
      ...jsonLd,
      anchor_id: 'internal-anchor-id',
      anchorId: 'internal-anchor-id',
      org_id: 'internal-org-id',
      user_id: 'internal-user-id',
      'ceterms:identifier': {
        ...jsonLd['ceterms:identifier'],
        fingerprint: 'a'.repeat(64),
        source_filename: 'transcript.pdf',
        sourceFilename: 'transcript.pdf',
      },
    };

    expect(validateCtdlJsonLd(unsafe)).toEqual({
      valid: false,
      errors: [
        'unsafe public CTDL key: anchor_id',
        'unsafe public CTDL key: anchorId',
        'unsafe public CTDL key: org_id',
        'unsafe public CTDL key: user_id',
        'unsafe public CTDL key: ceterms:identifier.fingerprint',
        'unsafe public CTDL key: ceterms:identifier.source_filename',
        'unsafe public CTDL key: ceterms:identifier.sourceFilename',
      ],
    });
  });

  // SCRUM-2374 (CE-03) — cross-field invariant: a Revoked or Superseded
  // credential must not carry a forward-looking ceterms:expirationDate. The
  // serializer suppresses it at the source; the validator is the independent
  // second check that catches any future code path that re-introduces the
  // conflation (the issue Jeanne Kitchens flagged).
  it('rejects ceterms:expirationDate on a Revoked credential (cross-field invariant)', () => {
    const jsonLd = buildCtdlJsonLd(baseAnchor, {
      verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001',
    });

    const invalid = {
      ...jsonLd,
      'ceterms:credentialStatusType': 'ceterms:Revoked',
      'ceterms:expirationDate': '2027-05-19T00:00:00.000Z',
    };

    const result = validateCtdlJsonLd(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'ceterms:expirationDate must not be present for a Revoked or Superseded credential',
    );
  });

  it('rejects ceterms:expirationDate on a Superseded credential (cross-field invariant)', () => {
    const jsonLd = buildCtdlJsonLd(baseAnchor, {
      verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001',
    });

    const invalid = {
      ...jsonLd,
      'ceterms:credentialStatusType': 'ceterms:Superseded',
      'ceterms:expirationDate': '2027-05-19T00:00:00.000Z',
    };

    const result = validateCtdlJsonLd(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'ceterms:expirationDate must not be present for a Revoked or Superseded credential',
    );
  });

  it('still accepts ceterms:expirationDate on an Active credential', () => {
    const jsonLd = buildCtdlJsonLd(baseAnchor, {
      verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001',
    });

    const active = {
      ...jsonLd,
      'ceterms:credentialStatusType': 'ceterms:Active',
      'ceterms:expirationDate': '2027-05-19T00:00:00.000Z',
    };

    expect(validateCtdlJsonLd(active)).toEqual({ valid: true, errors: [] });
  });
});
