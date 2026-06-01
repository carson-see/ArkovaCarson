/**
 * Accredible adapter tests — SCRUM-1613 CSI-04C.
 * TDD red→green pin per CLAUDE.md §0 rule 1.
 */
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';

import {
  accredibleCredentialToEvidence,
  ACCREDIBLE_SOURCE_PROVIDER_SLUG,
} from './adapter.js';
import type { AccredibleCredential } from './client.js';

const PLAIN_CREDENTIAL: AccredibleCredential = {
  id: 987654,
  name: 'Advanced Data Stewardship Certificate',
  issued_on: '2026-04-15',
  expired_on: null,
  public_url: 'https://accredible.example/credential/987654',
  recipient: { email: 'pat@example.com', name: 'Pat Example' },
  group: {
    id: 'g-data-stewardship',
    name: 'Data Stewardship Program',
    organization: { name: 'Example University' },
  },
};

const SIGNED_CREDENTIAL: AccredibleCredential = {
  ...PLAIN_CREDENTIAL,
  id: 1111111,
  credential_data: {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    type: ['VerifiableCredential', 'OpenBadgeCredential'],
  },
  proof: {
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-rdfc-2022',
    proofValue: 'z6Mvx...redacted',
  },
};

const RAW_BYTES = Buffer.from(JSON.stringify(PLAIN_CREDENTIAL), 'utf8');
const RAW_BYTES_HASH = createHash('sha256').update(RAW_BYTES).digest('hex');

describe('SCRUM-1613 — accredibleCredentialToEvidence', () => {
  it('produces a credential_evidence_v1 package with provider=accredible and type=CERTIFICATE', () => {
    const result = accredibleCredentialToEvidence(PLAIN_CREDENTIAL, {
      fetchedAt: '2026-05-01T00:00:00.000Z',
      payloadHash: RAW_BYTES_HASH,
      payloadByteLength: RAW_BYTES.length,
      recipientEmail: 'pat@example.com',
    });

    expect(result.evidence.schemaVersion).toBe('credential_evidence_v1');
    expect(result.evidence.source.provider).toBe(ACCREDIBLE_SOURCE_PROVIDER_SLUG);
    expect(result.evidence.credential.type).toBe('CERTIFICATE');
    expect(result.evidence.credential.title).toBe(
      'Advanced Data Stewardship Certificate',
    );
    expect(result.evidence.credential.issuerName).toBe('Example University');
    expect(result.evidence.source.url).toBe(PLAIN_CREDENTIAL.public_url);
    expect(result.package.evidencePackageHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stringifies numeric ids for canonical recording', () => {
    const result = accredibleCredentialToEvidence(PLAIN_CREDENTIAL, {
      fetchedAt: '2026-05-01T00:00:00.000Z',
      payloadHash: RAW_BYTES_HASH,
    });
    expect(result.evidence.source.id).toBe('987654');
  });

  it('sets verification_level to account_linked (issuer-API confirmed) and extraction_method to issuer_api', () => {
    const result = accredibleCredentialToEvidence(PLAIN_CREDENTIAL, {
      fetchedAt: '2026-05-01T00:00:00.000Z',
      payloadHash: RAW_BYTES_HASH,
    });
    expect(result.evidence.evidence.verificationLevel).toBe('account_linked');
    expect(result.evidence.evidence.extractionMethod).toBe('issuer_api');
  });

  it('NEVER sets verification_level to source_signed even when proof present (v1.0 trust gap closed)', () => {
    const result = accredibleCredentialToEvidence(SIGNED_CREDENTIAL, {
      fetchedAt: '2026-05-01T00:00:00.000Z',
      payloadHash: RAW_BYTES_HASH,
    });
    expect(result.evidence.evidence.verificationLevel).not.toBe('source_signed');
    expect(result.evidence.evidence.verificationLevel).toBe('account_linked');
    expect(result.proofDetected).toBe(true);
  });

  it('proofDetected fires on either proof block OR credential_data envelope', () => {
    const proofOnly: AccredibleCredential = {
      ...PLAIN_CREDENTIAL,
      proof: { type: 'DataIntegrityProof' },
    };
    const dataOnly: AccredibleCredential = {
      ...PLAIN_CREDENTIAL,
      credential_data: { '@context': [] },
    };

    expect(
      accredibleCredentialToEvidence(proofOnly, {
        fetchedAt: '2026-05-01T00:00:00.000Z',
        payloadHash: RAW_BYTES_HASH,
      }).proofDetected,
    ).toBe(true);
    expect(
      accredibleCredentialToEvidence(dataOnly, {
        fetchedAt: '2026-05-01T00:00:00.000Z',
        payloadHash: RAW_BYTES_HASH,
      }).proofDetected,
    ).toBe(true);
  });

  it('proofDetected is false when no proof / credential_data is present', () => {
    const result = accredibleCredentialToEvidence(PLAIN_CREDENTIAL, {
      fetchedAt: '2026-05-01T00:00:00.000Z',
      payloadHash: RAW_BYTES_HASH,
    });
    expect(result.proofDetected).toBe(false);
  });

  it('hashes the recipient email (lowercased + trimmed) into recipientIdentifierHash', () => {
    const a = accredibleCredentialToEvidence(PLAIN_CREDENTIAL, {
      fetchedAt: '2026-05-01T00:00:00.000Z',
      payloadHash: RAW_BYTES_HASH,
      recipientEmail: 'Pat@Example.com',
    });
    const b = accredibleCredentialToEvidence(PLAIN_CREDENTIAL, {
      fetchedAt: '2026-05-01T00:00:00.000Z',
      payloadHash: RAW_BYTES_HASH,
      recipientEmail: '  pat@example.com  ',
    });
    expect(a.evidence.credential.recipientIdentifierHash).toEqual(
      b.evidence.credential.recipientIdentifierHash,
    );
    expect(a.evidence.credential.recipientIdentifierHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does NOT leak the raw recipient email anywhere in the evidence package', () => {
    const result = accredibleCredentialToEvidence(PLAIN_CREDENTIAL, {
      fetchedAt: '2026-05-01T00:00:00.000Z',
      payloadHash: RAW_BYTES_HASH,
      recipientEmail: 'pat@example.com',
    });
    const serialised = JSON.stringify(result.package);
    expect(serialised).not.toContain('pat@example.com');
    expect(serialised).not.toContain('Pat@Example.com');
  });

  it('falls back to a canonical API URL when public_url is missing', () => {
    const noUrl: AccredibleCredential = { ...PLAIN_CREDENTIAL, public_url: undefined };
    const result = accredibleCredentialToEvidence(noUrl, {
      fetchedAt: '2026-05-01T00:00:00.000Z',
      payloadHash: RAW_BYTES_HASH,
    });
    expect(result.evidence.source.url).toMatch(
      /^https:\/\/api\.accredible\.com\/v1\/credentials\//,
    );
  });

  it('throws on missing id', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const broken: AccredibleCredential = { ...PLAIN_CREDENTIAL, id: '' as any };
    expect(() =>
      accredibleCredentialToEvidence(broken, {
        fetchedAt: '2026-05-01T00:00:00.000Z',
        payloadHash: RAW_BYTES_HASH,
      }),
    ).toThrow(/missing required `id`/);
  });

  it('throws on missing name', () => {
    const broken: AccredibleCredential = { ...PLAIN_CREDENTIAL, name: undefined };
    expect(() =>
      accredibleCredentialToEvidence(broken, {
        fetchedAt: '2026-05-01T00:00:00.000Z',
        payloadHash: RAW_BYTES_HASH,
      }),
    ).toThrow(/missing required `name`/);
  });

  it('produces a deterministic evidencePackageHash for the same inputs', () => {
    const a = accredibleCredentialToEvidence(PLAIN_CREDENTIAL, {
      fetchedAt: '2026-05-01T00:00:00.000Z',
      payloadHash: RAW_BYTES_HASH,
      payloadByteLength: RAW_BYTES.length,
    });
    const b = accredibleCredentialToEvidence(PLAIN_CREDENTIAL, {
      fetchedAt: '2026-05-01T00:00:00.000Z',
      payloadHash: RAW_BYTES_HASH,
      payloadByteLength: RAW_BYTES.length,
    });
    expect(a.package.evidencePackageHash).toBe(b.package.evidencePackageHash);
  });
});
