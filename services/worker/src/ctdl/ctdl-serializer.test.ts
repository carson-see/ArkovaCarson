import { describe, expect, it } from 'vitest';
import { buildCtdlJsonLd, type CtdlAnchor } from './ctdl-serializer.js';
import { FabricatedCtidError } from './ctdl-ctid-guard.js';
import { ProhibitedClaimError } from './ctdl-claims-guard.js';
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
      verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001',
    });

    expect(jsonLd['@context']).toBe('https://credreg.net/ctdl/schema/context/json');
    expect(jsonLd['@type']).toBe('ceterms:Certificate');
    expect(jsonLd['ceterms:name']).toBe('Ethics CLE Completion');
    expect(jsonLd).not.toHaveProperty('ceterms:ctid');
    expect(jsonLd['ceterms:offeredBy']['ceterms:name']).toBe('Michigan Legal Education Board');
    expect(jsonLd['ceterms:offeredBy']).not.toHaveProperty('ceterms:ctid');
    expect(jsonLd['ceterms:credentialStatusType']).toBe('ceterms:Active');
    expect(jsonLd['ceterms:dateEffective']).toBe('2026-05-19T00:00:00.000Z');
    expect(jsonLd['ceterms:verificationServiceProfile']['ceterms:verificationService']).toBe(
      'https://app.arkova.ai/verify/ARK-2026-CTDL-001',
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
    expect(body).not.toContain('ce-ARK-2026-CTDL-001');
    expect(body).not.toContain('ce-ORG-MI-CLE');
  });

  it('preserves real Credential Engine CTIDs when provided explicitly', () => {
    const jsonLd = buildCtdlJsonLd({
      ...baseAnchor,
      ctid: 'ce-11111111-1111-1111-1111-111111111111',
      issuer: {
        ...baseAnchor.issuer,
        ctid: 'ce-22222222-2222-2222-2222-222222222222',
      },
    }, {
      verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001',
    });

    expect(jsonLd['ceterms:ctid']).toBe('ce-11111111-1111-1111-1111-111111111111');
    expect(jsonLd['ceterms:offeredBy']['ceterms:ctid']).toBe('ce-22222222-2222-2222-2222-222222222222');
  });

  // SCRUM-2373 (CE-02) — the serializer now FAILS CLOSED on a fabricated CTID
  // instead of silently dropping it. Real/absent paths are covered above.
  it('throws FabricatedCtidError when the credential carries a fabricated CTID', () => {
    expect(() =>
      buildCtdlJsonLd(
        { ...baseAnchor, ctid: 'ce-ARK-2026-CTDL-001' },
        { verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001' },
      ),
    ).toThrow(FabricatedCtidError);
  });

  it('throws FabricatedCtidError when the issuer carries a fabricated CTID', () => {
    expect(() =>
      buildCtdlJsonLd(
        { ...baseAnchor, issuer: { ...baseAnchor.issuer, ctid: 'urn:ctid:ORG-MI-CLE' } },
        { verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001' },
      ),
    ).toThrow(FabricatedCtidError);
  });

  it('still omits ceterms:ctid (never synthesizes one) when no CTID is present', () => {
    const jsonLd = buildCtdlJsonLd(baseAnchor, {
      verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001',
    });
    expect(jsonLd).not.toHaveProperty('ceterms:ctid');
    expect(jsonLd['ceterms:offeredBy']).not.toHaveProperty('ceterms:ctid');
  });

  it('marks revoked credentials as revoked while still returning a CTDL body', () => {
    const jsonLd = buildCtdlJsonLd({
      ...baseAnchor,
      status: 'REVOKED',
      revokedAt: '2026-05-21T00:00:00.000Z',
      revocationReason: 'Issuer revoked the completion.',
    }, {
      verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001',
    });

    expect(jsonLd['ceterms:credentialStatusType']).toBe('ceterms:Revoked');
    expect(jsonLd['ceterms:revocationDate']).toBe('2026-05-21T00:00:00.000Z');
    expect(jsonLd['ceterms:revocationReason']).toBe('Issuer revoked the completion.');
    // SCRUM-2374 (CE-03): baseAnchor carries a future issued-person expiresAt,
    // which is NEVER emitted as ceterms:expirationDate regardless of status.
    expect(jsonLd).not.toHaveProperty('ceterms:expirationDate');
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

  // SCRUM-2374 (CE-03) — expiration SEMANTICS, per Jeanne Kitchens (Credential
  // Engine, SCRUM-2294 comment 2026-06-10): CTDL `ceterms:expirationDate` is the
  // date beyond which the credential RESOURCE (the offering) is no longer
  // available. It must NOT carry the expiration of a credential issued to a
  // PERSON. These two meanings are tested independently below.
  describe('ceterms:expirationDate expiration semantics (CE-03)', () => {
    // MEANING 1 — ISSUED-PERSON expiry (anchor.expiresAt) is never emitted as
    // ceterms:expirationDate, whatever the status. Person-level validity belongs
    // in the OB3/W3C VC layer (SCRUM-2296), not class-level CTDL.
    it('never emits ceterms:expirationDate from an issued-person expiry (ACTIVE)', () => {
      const jsonLd = buildCtdlJsonLd(
        { ...baseAnchor, status: 'ACTIVE', expiresAt: '2027-05-19T00:00:00.000Z' },
        { verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001' },
      );

      expect(jsonLd['ceterms:credentialStatusType']).toBe('ceterms:Active');
      expect(jsonLd).not.toHaveProperty('ceterms:expirationDate');
    });

    it('never emits ceterms:expirationDate from an issued-person expiry (SECURED)', () => {
      const jsonLd = buildCtdlJsonLd(
        { ...baseAnchor, status: 'SECURED', expiresAt: '2027-05-19T00:00:00.000Z' },
        { verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001' },
      );

      expect(jsonLd['ceterms:credentialStatusType']).toBe('ceterms:Active');
      expect(jsonLd).not.toHaveProperty('ceterms:expirationDate');
    });

    it('never emits ceterms:expirationDate from an issued-person expiry (EXPIRED)', () => {
      const jsonLd = buildCtdlJsonLd(
        { ...baseAnchor, status: 'EXPIRED', expiresAt: '2025-01-01T00:00:00.000Z' },
        { verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001' },
      );

      expect(jsonLd['ceterms:credentialStatusType']).toBe('ceterms:Expired');
      expect(jsonLd).not.toHaveProperty('ceterms:expirationDate');
    });

    // MEANING 2 — RESOURCE-AVAILABILITY / offering expiry (resourceAvailableUntil)
    // IS the correct source for ceterms:expirationDate, still status-gated.
    it('emits ceterms:expirationDate from a resource-availability expiry (ACTIVE)', () => {
      const jsonLd = buildCtdlJsonLd(
        { ...baseAnchor, status: 'ACTIVE', expiresAt: null, resourceAvailableUntil: '2028-01-01T00:00:00.000Z' },
        { verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001' },
      );

      expect(jsonLd['ceterms:credentialStatusType']).toBe('ceterms:Active');
      expect(jsonLd['ceterms:expirationDate']).toBe('2028-01-01T00:00:00.000Z');
    });

    it('emits ceterms:expirationDate from a resource-availability expiry (EXPIRED — offering term lapsed)', () => {
      const jsonLd = buildCtdlJsonLd(
        { ...baseAnchor, status: 'EXPIRED', expiresAt: null, resourceAvailableUntil: '2025-01-01T00:00:00.000Z' },
        { verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001' },
      );

      expect(jsonLd['ceterms:credentialStatusType']).toBe('ceterms:Expired');
      expect(jsonLd['ceterms:expirationDate']).toBe('2025-01-01T00:00:00.000Z');
    });

    it('prefers resource-availability expiry and ignores issued-person expiry when both are present', () => {
      const jsonLd = buildCtdlJsonLd(
        {
          ...baseAnchor,
          status: 'SECURED',
          expiresAt: '2027-05-19T00:00:00.000Z', // issued-person — must NOT appear
          resourceAvailableUntil: '2030-12-31T00:00:00.000Z', // offering — must appear
        },
        { verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001' },
      );

      expect(jsonLd['ceterms:expirationDate']).toBe('2030-12-31T00:00:00.000Z');
      expect(JSON.stringify(jsonLd)).not.toContain('2027-05-19');
    });

    it('suppresses resource-availability expiry for a SUPERSEDED credential', () => {
      const jsonLd = buildCtdlJsonLd(
        { ...baseAnchor, status: 'SUPERSEDED', resourceAvailableUntil: '2028-01-01T00:00:00.000Z' },
        { verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001' },
      );

      expect(jsonLd['ceterms:credentialStatusType']).toBe('ceterms:Superseded');
      expect(jsonLd).not.toHaveProperty('ceterms:expirationDate');
    });

    it('suppresses resource-availability expiry for a REVOKED credential', () => {
      const jsonLd = buildCtdlJsonLd(
        {
          ...baseAnchor,
          status: 'REVOKED',
          resourceAvailableUntil: '2028-01-01T00:00:00.000Z',
          revokedAt: '2026-05-21T00:00:00.000Z',
        },
        { verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001' },
      );

      expect(jsonLd['ceterms:credentialStatusType']).toBe('ceterms:Revoked');
      expect(jsonLd).not.toHaveProperty('ceterms:expirationDate');
    });

    // CE-06b sign-off breadcrumb (SCRUM-2377): Jeanne Kitchens' correction (1)
    // says the two expiry meanings are DISTINCT properties in CTDL-land:
    // `ceterms:expirationDate` = resource/offering availability; issued-PERSON
    // credential expiry has NO class-level CTDL property and belongs to the
    // OB3/W3C VC issued-credential layer (SCRUM-2296). The exact property
    // choice for surfacing person-level validity (OB3 `expirationDate` on the
    // issued credential vs a VC `expirationDate`/`validUntil`) is the OPEN
    // QUESTION for CE-06b sign-off. Until that sign-off, the only executable
    // truth is: the CTDL projection NEVER carries the person-level expiry —
    // under any status — even when no offering expiry exists to shadow it.
    it('documents the CE-06b property-choice question: person expiry maps to NO CTDL property today', () => {
      for (const status of ['ACTIVE', 'SECURED', 'EXPIRED', 'SUPERSEDED'] as const) {
        const jsonLd = buildCtdlJsonLd(
          {
            ...baseAnchor,
            status,
            expiresAt: '2031-03-03T00:00:00.000Z',
            resourceAvailableUntil: null,
          },
          { verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001' },
        );
        expect(jsonLd).not.toHaveProperty('ceterms:expirationDate');
        expect(JSON.stringify(jsonLd)).not.toContain('2031-03-03');
      }
    });
  });

  // SCRUM-2375 (CE-04) — CE continuing-education credit is expressed as a
  // ceterms:ValueProfile with schema:value + ceterms:creditUnitType ContactHour,
  // per Jeanne Kitchens' CTDL correction (2). NEVER a bare scalar; NEVER
  // fabricated when absent/zero. CONFLATION GUARD: this "credit" is the CE
  // ContactHour credit value of the credential — it has NOTHING to do with the
  // Arkova billing credit_ledger (paid anchoring credits).
  describe('ceterms:creditValue ContactHour ValueProfile (CE-04)', () => {
    const verify = { verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001' };

    // Golden fixture 1 — integer credit: a 2.0-hour CLE ethics completion.
    it('emits a golden ContactHour ValueProfile for a 2.0-hour CLE ethics credit', () => {
      const jsonLd = buildCtdlJsonLd(
        { ...baseAnchor, credentialType: 'CLE', subType: 'ethics_cle', contactHours: 2 },
        verify,
      );

      expect(jsonLd['ceterms:creditValue']).toEqual([
        {
          '@type': 'ceterms:ValueProfile',
          'schema:value': 2,
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
      ]);
    });

    // Golden fixture 2 — fractional credit: a 1.5-contact-hour CPE completion.
    it('emits a golden fractional ContactHour ValueProfile for a 1.5-hour CPE credit', () => {
      const jsonLd = buildCtdlJsonLd(
        {
          ...baseAnchor,
          credentialType: 'CPE',
          subType: 'accounting_cpe',
          label: 'Accounting Update CPE',
          contactHours: 1.5,
        },
        verify,
      );

      expect(jsonLd['@type']).toBe('ceterms:Certificate');
      expect(jsonLd['ceterms:creditValue']).toEqual([
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
      ]);
    });

    // Golden fixture 3 — absent credit: NEVER fabricate a ValueProfile.
    it('omits ceterms:creditValue entirely when no credit value is present', () => {
      const jsonLd = buildCtdlJsonLd({ ...baseAnchor, credentialType: 'CLE' }, verify);
      expect(jsonLd).not.toHaveProperty('ceterms:creditValue');
    });

    it('omits ceterms:creditValue for a zero credit value (never a fabricated 0-hour profile)', () => {
      const jsonLd = buildCtdlJsonLd(
        { ...baseAnchor, credentialType: 'CPE', contactHours: 0 },
        verify,
      );
      expect(jsonLd).not.toHaveProperty('ceterms:creditValue');
    });

    it('omits ceterms:creditValue for negative or non-finite credit values', () => {
      for (const bogus of [-1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        const jsonLd = buildCtdlJsonLd(
          { ...baseAnchor, credentialType: 'CLE', contactHours: bogus },
          verify,
        );
        expect(jsonLd).not.toHaveProperty('ceterms:creditValue');
      }
    });

    // Golden fixture 4 — CPE vs CLE: both are continuing-education credit and
    // both express the credit as ContactHour; the distinction lives in @type
    // resolution + name, never in the credit unit.
    it('emits ContactHour for both CPE and CLE with the same unit vocabulary (CPE vs CLE case)', () => {
      const cle = buildCtdlJsonLd(
        { ...baseAnchor, credentialType: 'CLE', subType: 'ethics_cle', contactHours: 2 },
        verify,
      );
      const cpe = buildCtdlJsonLd(
        { ...baseAnchor, credentialType: 'CPE', subType: 'tax_cpe', contactHours: 8 },
        verify,
      );

      const cleUnit = cle['ceterms:creditValue']?.[0]['ceterms:creditUnitType'][0]['ceterms:targetNode'];
      const cpeUnit = cpe['ceterms:creditValue']?.[0]['ceterms:creditUnitType'][0]['ceterms:targetNode'];
      expect(cleUnit).toBe('creditUnit:ContactHour');
      expect(cpeUnit).toBe('creditUnit:ContactHour');
      expect(cle['ceterms:creditValue']?.[0]['schema:value']).toBe(2);
      expect(cpe['ceterms:creditValue']?.[0]['schema:value']).toBe(8);
    });

    // Honest-omission guard: contact hours on a non-continuing-education type
    // are not a CE credit assertion we can stand behind — omit.
    it('omits ceterms:creditValue for non-continuing-education credential types', () => {
      const jsonLd = buildCtdlJsonLd(
        { ...baseAnchor, credentialType: 'DEGREE', subType: 'bachelor', contactHours: 3 },
        verify,
      );
      expect(jsonLd).not.toHaveProperty('ceterms:creditValue');
    });

    it('keeps the CTDL body valid when a ContactHour ValueProfile is present', () => {
      // buildCtdlJsonLd runs assertValidCtdlJsonLd internally — reaching the
      // expectation means the validator accepted the ValueProfile shape.
      const jsonLd = buildCtdlJsonLd(
        { ...baseAnchor, credentialType: 'CLE', contactHours: 2 },
        verify,
      );
      expect(jsonLd['ceterms:creditValue']).toHaveLength(1);
    });
  });

  // SCRUM-2377 (CE-06a) — fail-closed claims-review gate (R-7): the public CTDL
  // projection can NEVER ship a Registry-listing assertion ("listed in the
  // Registry" etc.) or a "legally sufficient" claim. Issuer-authored free text
  // carrying an overclaim is suppressed (honest omission, like PII); any string
  // that still reaches the assembled body trips the final assert (throw -> the
  // route's generic catch -> 500, no body). This EXTENDS the CE-01/CE-02
  // fail-closed chain in buildCtdlJsonLd — it is not a parallel gate.
  describe('claims-review gate — no Registry-listing overclaims (CE-06a)', () => {
    const verify = { verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001' };

    it('suppresses an issuer description asserting Registry listing (honest omission)', () => {
      const jsonLd = buildCtdlJsonLd(
        {
          ...baseAnchor,
          description: 'This credential is listed in the Credential Registry.',
        },
        verify,
      );

      expect(jsonLd).not.toHaveProperty('ceterms:description');
      expect(JSON.stringify(jsonLd)).not.toMatch(/listed in the/i);
    });

    it('suppresses an overclaim-bearing label instead of publishing it as the name', () => {
      const jsonLd = buildCtdlJsonLd(
        {
          ...baseAnchor,
          label: 'Registry-listed Ethics CLE',
          description: null,
          metadata: { courseTitle: 'Ethics and Professional Responsibility' },
        },
        verify,
      );

      expect(jsonLd['ceterms:name']).toBe('Ethics and Professional Responsibility');
      expect(JSON.stringify(jsonLd)).not.toMatch(/registry-listed/i);
    });

    it('fails closed (throws ProhibitedClaimError) when a revocation reason carries the overclaim', () => {
      expect(() =>
        buildCtdlJsonLd(
          {
            ...baseAnchor,
            status: 'REVOKED',
            revokedAt: '2026-05-21T00:00:00.000Z',
            revocationReason: 'Superseded by the version listed in the Registry.',
          },
          verify,
        ),
      ).toThrow(ProhibitedClaimError);
    });

    it('suppresses a "legally sufficient" claim in free text', () => {
      const jsonLd = buildCtdlJsonLd(
        {
          ...baseAnchor,
          description: 'This record is legally sufficient in all jurisdictions.',
        },
        verify,
      );
      expect(jsonLd).not.toHaveProperty('ceterms:description');
      expect(JSON.stringify(jsonLd)).not.toMatch(/legally sufficient/i);
    });

    it('publishing to the CE Registry stays OFF: the projection asserts no listing status at all', () => {
      // The whole CE "publish path" today is this read-only projection behind
      // the CE-01 publishability gate. There is no Registry write path, and no
      // body field may assert one. (The lint test additionally verifies no CE
      // Registry publish endpoint is wired anywhere in the worker.)
      const jsonLd = buildCtdlJsonLd(baseAnchor, verify);
      const body = JSON.stringify(jsonLd);
      expect(body).not.toMatch(/listed in the/i);
      expect(body).not.toMatch(/registry[-\s]listed/i);
      expect(body).not.toMatch(/in the credential registry/i);
      expect(body).not.toMatch(/legally sufficient/i);
    });
  });
});
