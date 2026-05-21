import { describe, expect, it } from 'vitest';
import { buildCtdlJsonLd, type CtdlAnchor } from './ctdl-serializer.js';

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
    expect(jsonLd['ceterms:ctid']).toBe('ce-ARK-2026-CTDL-001');
    expect(jsonLd['ceterms:offeredBy']['ceterms:name']).toBe('Michigan Legal Education Board');
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
  });

  it('throws for non-publishable statuses so routes can return 404', () => {
    expect(() => buildCtdlJsonLd({
      ...baseAnchor,
      status: 'PENDING',
    }, {
      verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-CTDL-001',
    })).toThrow(/non-publishable status/);
  });
});
