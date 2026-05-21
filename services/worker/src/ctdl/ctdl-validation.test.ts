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
      'ceterms:ctid': 'ce-ARK-2026-CTDL-001',
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

  it('rejects unsafe public JSON-LD keys and internal values anywhere in the document', () => {
    const jsonLd = buildCtdlJsonLd(baseAnchor, {
      verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001',
    });

    const unsafe = {
      ...jsonLd,
      org_id: 'internal-org-id',
      'ceterms:identifier': {
        ...jsonLd['ceterms:identifier'],
        fingerprint: 'a'.repeat(64),
      },
    };

    expect(validateCtdlJsonLd(unsafe)).toEqual({
      valid: false,
      errors: [
        'unsafe public CTDL key: org_id',
        'unsafe public CTDL key: ceterms:identifier.fingerprint',
      ],
    });
  });
});
