import { describe, expect, it } from 'vitest';
import { buildCtdlJsonLd, type CtdlAnchor } from './ctdl-serializer.js';
import { MAX_CONTACT_HOURS, assertValidCtdlJsonLd, validateCtdlJsonLd } from './ctdl-validation.js';

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

  // LOW non-ISO / MED PII-leak — isIsoDateLike must be a real ISO-8601 check, not
  // a lenient Date.parse(). Loose values like "12/31/2030" or an email-prefixed
  // date parse under Date.parse but are NOT ISO 8601, so the validator (the
  // independent second check) must reject them in ceterms:expirationDate.
  it.each([
    '12/31/2030',
    'recipient@example.com 2030-01-01',
    'December 31, 2030',
    'sometime in 2030',
  ])('rejects a non-ISO-8601 ceterms:expirationDate value: %s', (bad) => {
    const jsonLd = buildCtdlJsonLd(baseAnchor, {
      verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001',
    });

    const invalid = {
      ...jsonLd,
      'ceterms:credentialStatusType': 'ceterms:Active',
      'ceterms:expirationDate': bad,
    };

    const result = validateCtdlJsonLd(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('ceterms:expirationDate must be a date string');
  });

  it.each([
    '2030-12-31',
    '2030-12-31T00:00:00.000Z',
    '2030-12-31T00:00:00Z',
    '2030-12-31T00:00:00+00:00',
  ])('accepts a canonical ISO-8601 ceterms:expirationDate value: %s', (good) => {
    const jsonLd = buildCtdlJsonLd(baseAnchor, {
      verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001',
    });

    const active = {
      ...jsonLd,
      'ceterms:credentialStatusType': 'ceterms:Active',
      'ceterms:expirationDate': good,
    };

    expect(validateCtdlJsonLd(active)).toEqual({ valid: true, errors: [] });
  });

  // SCRUM-2375 (CE-04) — independent second check on the ContactHour
  // ValueProfile: `ceterms:creditValue` must be a ValueProfile array carrying a
  // positive finite schema:value and a ContactHour creditUnitType, never a bare
  // scalar and never a fabricated/zero value.
  describe('ceterms:creditValue ValueProfile validation (CE-04)', () => {
    const validCreditValue = [
      {
        '@type': 'ceterms:ValueProfile',
        'schema:value': 1.5,
        'ceterms:creditUnitType': [
          {
            '@type': 'ceterms:CredentialAlignmentObject',
            'ceterms:framework': 'https://credreg.net/ctdl/terms/creditUnit',
            'ceterms:frameworkName': 'Credit Unit',
            'ceterms:targetNode': 'creditUnit:ContactHour',
            'ceterms:targetNodeName': 'Contact Hour',
          },
        ],
      },
    ];

    function bodyWithCreditValue(creditValue: unknown) {
      const jsonLd = buildCtdlJsonLd(baseAnchor, {
        verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001',
      });
      return { ...jsonLd, 'ceterms:creditValue': creditValue };
    }

    it('accepts a well-formed ContactHour ValueProfile', () => {
      expect(validateCtdlJsonLd(bodyWithCreditValue(validCreditValue))).toEqual({
        valid: true,
        errors: [],
      });
    });

    it('rejects a bare scalar credit value (the exact shape Jeanne corrected)', () => {
      const result = validateCtdlJsonLd(bodyWithCreditValue(1.5));
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('ceterms:creditValue must be an array of ceterms:ValueProfile objects');
    });

    it('rejects a ValueProfile without a ceterms:ValueProfile @type', () => {
      const result = validateCtdlJsonLd(
        bodyWithCreditValue([{ ...validCreditValue[0], '@type': 'schema:QuantitativeValue' }]),
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('ceterms:creditValue[0].@type must be ceterms:ValueProfile');
    });

    it.each([0, -2, Number.NaN, 'two', null])(
      'rejects a non-positive or non-numeric schema:value: %s',
      (bad) => {
        const result = validateCtdlJsonLd(
          bodyWithCreditValue([{ ...validCreditValue[0], 'schema:value': bad }]),
        );
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('ceterms:creditValue[0].schema:value must be a positive finite number');
      },
    );

    it('rejects a ValueProfile whose creditUnitType is missing or not ContactHour', () => {
      const missing = validateCtdlJsonLd(
        bodyWithCreditValue([{ '@type': 'ceterms:ValueProfile', 'schema:value': 2 }]),
      );
      expect(missing.valid).toBe(false);
      expect(missing.errors).toContain(
        'ceterms:creditValue[0].ceterms:creditUnitType must be a non-empty array of alignment objects',
      );

      const wrongUnit = validateCtdlJsonLd(
        bodyWithCreditValue([
          {
            ...validCreditValue[0],
            'ceterms:creditUnitType': [
              { ...validCreditValue[0]['ceterms:creditUnitType'][0], 'ceterms:targetNode': 'creditUnit:SemesterHour' },
            ],
          },
        ]),
      );
      expect(wrongUnit.valid).toBe(false);
      expect(wrongUnit.errors).toContain(
        'ceterms:creditValue[0].ceterms:creditUnitType[0].ceterms:targetNode must be creditUnit:ContactHour',
      );
    });

    it('rejects an empty creditValue array (omit the property instead)', () => {
      const result = validateCtdlJsonLd(bodyWithCreditValue([]));
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('ceterms:creditValue must be an array of ceterms:ValueProfile objects');
    });

    // Round-1 review finding 4: the validator is the independent second check,
    // so it must enforce the same plausibility ceiling the serializer applies
    // (MAX_CONTACT_HOURS) and the single-element invariant of the
    // [CtdlContactHourValueProfile] tuple — a future code path bypassing the
    // serializer must not be able to publish an implausible or multi-profile
    // credit the emission side can never produce.
    it('rejects a schema:value above the shared plausibility ceiling (e.g. 1e9)', () => {
      const result = validateCtdlJsonLd(
        bodyWithCreditValue([{ ...validCreditValue[0], 'schema:value': 1e9 }]),
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        `ceterms:creditValue[0].schema:value must be at most ${MAX_CONTACT_HOURS} contact hours`,
      );
    });

    it('accepts a schema:value exactly at the ceiling', () => {
      const result = validateCtdlJsonLd(
        bodyWithCreditValue([{ ...validCreditValue[0], 'schema:value': MAX_CONTACT_HOURS }]),
      );
      expect(result).toEqual({ valid: true, errors: [] });
    });

    it('rejects a creditValue array with more than one ValueProfile (single-element invariant)', () => {
      const result = validateCtdlJsonLd(
        bodyWithCreditValue([validCreditValue[0], { ...validCreditValue[0], 'schema:value': 3 }]),
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        'ceterms:creditValue must contain exactly one ceterms:ValueProfile',
      );
    });
  });
});
