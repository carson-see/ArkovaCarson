import { describe, expect, it } from 'vitest';
import { buildCtdlJsonLd, type CtdlAnchor } from './ctdl-serializer.js';
import { ARKOVA_DID } from '../api/did-web.js';

const baseAnchor: CtdlAnchor = {
  publicId: 'ARK-2026-CTDL-001',
  status: 'SECURED',
  credentialType: 'CLE',
  subType: 'ethics_cle',
  label: 'Ethics CLE Completion',
  description: 'Continuing Legal Education completion record.',
  createdAt: '2026-05-20T14:00:00.000Z',
  chainTimestamp: '2026-05-20T14:05:00.000Z',
  issuedAt: '2026-05-19T00:00:00.000Z',
  expiresAt: '2027-05-19T00:00:00.000Z',
  issuer: {
    name: 'Michigan Legal Education Board',
    publicId: 'ORG-MI-CLE',
    websiteUrl: 'https://example.edu/cle',
  },
  metadata: {
    recipient_email: 'recipient@example.com',
    fingerprint: 'a'.repeat(64),
    title: 'Do not need this because label wins',
  },
};

describe('buildCtdlJsonLd', () => {
  it('builds the required public CTDL JSON-LD fields', () => {
    const jsonLd = buildCtdlJsonLd(baseAnchor, {
      verifyUrl: 'https://app.arkova.ai/verify',
    });

    expect(jsonLd['@context']).toBe('https://credreg.net/ctdl/schema/context/json');
    expect(jsonLd['@type']).toBe('ceterms:Certificate');
    expect(jsonLd['ceterms:name']).toBe('Ethics CLE Completion');
    expect(jsonLd).not.toHaveProperty('ceterms:ctid');
    expect(jsonLd['ceterms:identifier']).toEqual({
      'ceterms:identifierType': 'Arkova public ID',
      'ceterms:identifierValue': 'ARK-2026-CTDL-001',
    });
    expect(jsonLd['ceterms:offeredBy']['ceterms:name']).toBe('Michigan Legal Education Board');
    expect(jsonLd).not.toHaveProperty('ceterms:credentialStatusType');
    expect(jsonLd).not.toHaveProperty('ceterms:dateEffective');
    expect(jsonLd).not.toHaveProperty('ceterms:expirationDate');
    expect(jsonLd['ceterms:verificationServiceProfile']['ceterms:verificationService']).toBe(
      'https://app.arkova.ai/verify',
    );
  });

  it('does not leak banned internal or sensitive fields from raw metadata', () => {
    const jsonLd = buildCtdlJsonLd(baseAnchor, {
      verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001',
    });
    const body = JSON.stringify(jsonLd);

    expect(body).not.toContain('recipient@example.com');
    expect(body).not.toContain('fingerprint');
    expect(body).not.toContain('filename');
    expect(body).not.toContain('user_id');
    expect(body).not.toContain('org_id');
  });

  it('suppresses PII-bearing free-text values before public CTDL serialization', () => {
    const jsonLd = buildCtdlJsonLd({
      ...baseAnchor,
      label: null,
      description: 'Learner contact jane.student@example.edu or 555-867-5309.',
      metadata: {
        title: 'Course certificate for jane.student@example.edu',
        courseTitle: 'Ethics and Professional Responsibility',
      },
    }, {
      verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001',
    });
    const body = JSON.stringify(jsonLd);

    expect(jsonLd['ceterms:name']).toBe('Ethics and Professional Responsibility');
    expect(jsonLd).not.toHaveProperty('ceterms:description');
    expect(body).not.toContain('jane.student@example.edu');
    expect(body).not.toContain('555-867-5309');
  });

  it('fails closed for transcript-like education records when learner-name PII confidence is low', () => {
    expect(() => buildCtdlJsonLd({
      ...baseAnchor,
      credentialType: 'DEGREE',
      subType: 'transcript',
      label: 'Official transcript for Jane Q Student',
      description: 'Transcript record for learner Jane Q Student.',
      metadata: {
        document_type: 'official transcript',
      },
    }, {
      verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001',
    })).toThrow(/CTDL PII safety gate/);
  });

  it('fails closed for name-first transcript labels that previously evaded the learner-name gate', () => {
    expect(() => buildCtdlJsonLd({
      ...baseAnchor,
      credentialType: 'DEGREE',
      subType: 'academic_record',
      label: "Jane Q Student's transcript",
      description: 'Official academic record.',
      metadata: {
        document_type: 'transcript',
      },
    }, {
      verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001',
    })).toThrow(/CTDL PII safety gate/);
  });

  it('suppresses learner-name free text across non-transcript credential types', () => {
    const jsonLd = buildCtdlJsonLd({
      ...baseAnchor,
      credentialType: 'CLE',
      subType: 'ethics_cle',
      label: 'Certificate awarded to Jane Q Student',
      description: 'Completion credential held by Jane Q Student',
      metadata: {
        courseTitle: 'Ethics and Professional Responsibility',
      },
    }, {
      verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001',
    });
    const body = JSON.stringify(jsonLd);

    expect(jsonLd['ceterms:name']).toBe('Ethics and Professional Responsibility');
    expect(jsonLd).not.toHaveProperty('ceterms:description');
    expect(body).not.toContain('Jane Q Student');
  });

  it('omits issued revocation lifecycle fields from the CTDL class body', () => {
    const jsonLd = buildCtdlJsonLd({
      ...baseAnchor,
      status: 'REVOKED',
      revokedAt: '2026-05-21T00:00:00.000Z',
      revocationReason: 'Issuer revoked the completion.',
    }, {
      verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001',
    });

    expect(jsonLd).not.toHaveProperty('ceterms:credentialStatusType');
    expect(jsonLd).not.toHaveProperty('ceterms:revocationDate');
    expect(jsonLd).not.toHaveProperty('ceterms:revocationReason');
  });

  it('throws for non-publishable statuses so routes can return 404', () => {
    expect(() => buildCtdlJsonLd({
      ...baseAnchor,
      status: 'PENDING',
    }, {
      verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001',
    })).toThrow(/non-publishable status/);
  });

  // SCRUM-1922 R-CTDL-FR9 — offeredBy carries the issuing org's did:web DID.
  it('links the issuer DID via ceterms:sameAs when the org has a public id', () => {
    const jsonLd = buildCtdlJsonLd(baseAnchor, {
      verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001',
    });

    expect(jsonLd['ceterms:offeredBy']['ceterms:sameAs']).toEqual([
      `${ARKOVA_DID}:orgs:ORG-MI-CLE`,
    ]);
  });

  it('omits ceterms:sameAs when the issuer has no public id', () => {
    const jsonLd = buildCtdlJsonLd(
      { ...baseAnchor, issuer: { name: 'Unidentified Board' } },
      { verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001' },
    );

    expect(jsonLd['ceterms:offeredBy']['ceterms:sameAs']).toBeUndefined();
  });

  it('keeps the CTDL body valid with the DID added (sameAs is not an unsafe key)', () => {
    const jsonLd = buildCtdlJsonLd(baseAnchor, {
      verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001',
    });

    // buildCtdlJsonLd calls assertValidCtdlJsonLd internally, so reaching this
    // line means the validator accepted the DID. Double-check the value shape.
    const sameAs = jsonLd['ceterms:offeredBy']['ceterms:sameAs'];
    expect(Array.isArray(sameAs)).toBe(true);
    expect(sameAs?.[0]).toMatch(/^did:web:app\.arkova\.ai:orgs:/);
  });

  it('does not fabricate credential or issuer CTIDs from Arkova public IDs', () => {
    const jsonLd = buildCtdlJsonLd(baseAnchor, {
      verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001',
    });

    expect(jsonLd).not.toHaveProperty('ceterms:ctid');
    expect(jsonLd['ceterms:offeredBy']).not.toHaveProperty('ceterms:ctid');
    expect(JSON.stringify(jsonLd)).not.toContain('ce-ARK-2026-CTDL-001');
    expect(JSON.stringify(jsonLd)).not.toContain('ce-ORG-MI-CLE');
  });

  it('preserves real Credential Engine CTIDs when provided explicitly', () => {
    const jsonLd = buildCtdlJsonLd({
      ...baseAnchor,
      ctid: 'ce-11111111-1111-1111-1111-111111111111',
      issuer: {
        ...baseAnchor.issuer,
        ctid: 'ce-22222222-2222-2222-2222-222222222222',
      },
    } as CtdlAnchor, {
      verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001',
    });

    expect(jsonLd['ceterms:ctid']).toBe('ce-11111111-1111-1111-1111-111111111111');
    expect(jsonLd['ceterms:offeredBy']['ceterms:ctid']).toBe('ce-22222222-2222-2222-2222-222222222222');
  });

  it('maps CLE credit and ethics hours as CTDL ValueProfiles without competency overclaim', () => {
    const jsonLd = buildCtdlJsonLd({
      ...baseAnchor,
      credentialType: 'CLE',
      metadata: {
        cle_metadata: {
          credit_hours: 6,
          ethics_hours: 2,
          credit_type: 'CLE',
          jurisdiction: 'MI',
        },
        claimed_skills: ['Professional Responsibility'],
      },
    }, {
      verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001',
    });

    expect(jsonLd['ceterms:requires']).toEqual([{
      '@type': 'ceterms:ConditionProfile',
      'ceterms:name': 'Continuing education credit value',
      'ceterms:creditValue': [
        {
          '@type': 'ceterms:ValueProfile',
          'schema:value': 6,
          'ceterms:creditUnitType': 'creditUnit:ContactHour',
          'schema:description': 'CLE credit hours',
        },
        {
          '@type': 'ceterms:ValueProfile',
          'schema:value': 2,
          'ceterms:creditUnitType': 'creditUnit:ContactHour',
          'schema:description': 'CLE ethics credit hours',
        },
      ],
    }]);
    const body = JSON.stringify(jsonLd);
    expect(body).not.toContain('Professional Responsibility');
    expect(body).not.toContain('claimed_skills');
    expect(body).not.toContain('ceterms:targetCompetency');
    expect(body).not.toContain('ceasn:competencyText');
  });

  it('maps CPE credit hours from source metadata without leaking unsafe credit type text', () => {
    const jsonLd = buildCtdlJsonLd({
      ...baseAnchor,
      credentialType: 'CPE',
      metadata: {
        cpe_metadata: {
          credit_hours: 4.5,
          credit_type: 'NASBA CPE for jane.learner@example.edu',
        },
      },
    }, {
      verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001',
    });

    expect(jsonLd['ceterms:requires']).toEqual([{
      '@type': 'ceterms:ConditionProfile',
      'ceterms:name': 'Continuing education credit value',
      'ceterms:creditValue': [{
        '@type': 'ceterms:ValueProfile',
        'schema:value': 4.5,
        'ceterms:creditUnitType': 'creditUnit:ContactHour',
        'schema:description': 'CPE credit hours',
      }],
    }]);
    expect(JSON.stringify(jsonLd)).not.toContain('jane.learner@example.edu');
  });

  it('uses deterministic CLE credit descriptions instead of learner-bearing credit type text', () => {
    const jsonLd = buildCtdlJsonLd({
      ...baseAnchor,
      credentialType: 'CLE',
      metadata: {
        cle_metadata: {
          credit_hours: 1,
          credit_type: 'CLE for Jane Q Student',
        },
      },
    }, {
      verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001',
    });

    expect(jsonLd['ceterms:requires']?.[0]['ceterms:creditValue'][0]['schema:description']).toBe('CLE credit hours');
    expect(JSON.stringify(jsonLd)).not.toContain('Jane Q Student');
  });

  it.each([
    ['negative', -1],
    ['not numeric', 'NaN'],
    ['too large', 1001],
  ])('rejects %s CPE credit hour values instead of publishing invalid CTDL', (_label, creditHours) => {
    expect(() => buildCtdlJsonLd({
      ...baseAnchor,
      credentialType: 'CPE',
      metadata: {
        cpe_metadata: {
          credit_hours: creditHours,
        },
      },
    }, {
      verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001',
    })).toThrow(/Invalid CTDL credit value: CPE credit hours/);
  });
});
