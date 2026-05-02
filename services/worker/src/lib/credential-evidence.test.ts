import { describe, expect, it } from 'vitest';
import {
  buildCredentialEvidencePackage,
  canonicalizeCredentialEvidence,
  computeCredentialEvidenceHash,
  normalizeCredentialSourceUrl,
  parsePublicCredentialEvidenceMetadata,
  parsePublicCredentialEvidenceMetadataResult,
  toPublicSafeCredentialEvidenceMetadata,
  type CredentialEvidenceHashInput,
} from './credential-evidence.js';
import {
  ACCREDIBLE_STYLE_EVIDENCE_INPUT,
  GENERIC_URL_EVIDENCE_INPUT,
  OPEN_BADGE_EVIDENCE_INPUT,
} from './credential-evidence.fixtures.js';

describe('credential-evidence', () => {
  it('builds a credential evidence package with a deterministic SHA-256 hash', () => {
    const evidence = buildCredentialEvidencePackage(GENERIC_URL_EVIDENCE_INPUT);

    expect(evidence.schemaVersion).toBe('credential_evidence_v1');
    expect(evidence.evidencePackageHash).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.source.url).toBe('https://credentials.example.edu/verify/abc-123?view=public');
    expect(evidence.credential.type).toBe('CERTIFICATE');
  });

  it('canonicalizes key order before hashing', () => {
    const reordered: CredentialEvidenceHashInput = {
      evidence: {
        confidence: 0.74,
        extractionMethod: 'html_metadata',
        verificationLevel: 'captured_url',
      },
      credential: {
        recipientIdentifierHash: 'b'.repeat(64),
        recipientDisplayName: 'Public Learner',
        expiresAt: '2028-04-15',
        issuedAt: '2026-04-15',
        issuerName: 'Example University',
        title: 'Advanced Data Stewardship Certificate',
        type: 'CERTIFICATE',
      },
      source: {
        payloadByteLength: 42_000,
        payloadContentType: 'text/html',
        payloadHash: 'A'.repeat(64),
        fetchedAt: '2026-05-01T14:00:00.000Z',
        id: 'abc-123',
        url: 'https://credentials.example.edu/verify/abc-123?view=public&utm_source=newsletter',
        provider: 'generic',
      },
      schemaVersion: 'credential_evidence_v1',
    };

    expect(computeCredentialEvidenceHash(reordered)).toBe(
      computeCredentialEvidenceHash(GENERIC_URL_EVIDENCE_INPUT),
    );
    expect(canonicalizeCredentialEvidence(reordered)).toBe(
      canonicalizeCredentialEvidence(GENERIC_URL_EVIDENCE_INPUT),
    );
  });

  it('hash changes when the source URL changes', () => {
    const changed = {
      ...GENERIC_URL_EVIDENCE_INPUT,
      source: {
        ...GENERIC_URL_EVIDENCE_INPUT.source,
        url: 'https://credentials.example.edu/verify/different',
      },
    };

    expect(computeCredentialEvidenceHash(changed)).not.toBe(
      computeCredentialEvidenceHash(GENERIC_URL_EVIDENCE_INPUT),
    );
  });

  it('normalizes and strips secrets from credential source URLs', () => {
    expect(
      normalizeCredentialSourceUrl(
        'HTTPS://Credentials.Example.com/path?token=secret&utm_campaign=ad&locale=en&view=public#access-token',
      ),
    ).toBe('https://credentials.example.com/path?locale=en&view=public');
  });

  it('sorts retained query parameters by deterministic UTF-8 byte order', () => {
    expect(
      normalizeCredentialSourceUrl('https://credentials.example.com/path?%C3%A9=1&z=2&a=3&k=%C3%A9&k=z'),
    ).toBe('https://credentials.example.com/path?a=3&k=z&k=%C3%A9&z=2&%C3%A9=1');
  });

  it('normalizes trailing dots before host allow/deny decisions', () => {
    expect(normalizeCredentialSourceUrl('https://Credentials.Example.com./path')).toBe(
      'https://credentials.example.com/path',
    );
    expect(() => normalizeCredentialSourceUrl('https://localhost./credential')).toThrow(
      'public internet host',
    );
    expect(() => normalizeCredentialSourceUrl('https://example.local./credential')).toThrow(
      'public internet host',
    );
  });

  it('rejects non-public or non-http source URLs', () => {
    expect(() => normalizeCredentialSourceUrl('javascript:alert(1)')).toThrow('http or https');
    expect(() => normalizeCredentialSourceUrl('https://localhost:3000/credential')).toThrow(
      'public internet host',
    );
    expect(() => normalizeCredentialSourceUrl('https://127.0.0.1/credential')).toThrow(
      'private IPv4',
    );
    expect(() => normalizeCredentialSourceUrl('https://100.64.0.1/credential')).toThrow(
      'private IPv4',
    );
    expect(() => normalizeCredentialSourceUrl('https://192.168.0.5/credential')).toThrow(
      'private IPv4',
    );
    expect(() => normalizeCredentialSourceUrl('https://[::ffff:127.0.0.1]/credential')).toThrow(
      'private IPv4',
    );
    expect(() => normalizeCredentialSourceUrl('https://[::ffff:100.64.0.1]/credential')).toThrow(
      'private IPv4',
    );
    expect(() => normalizeCredentialSourceUrl('https://[::1]/credential')).toThrow(
      'private IPv6',
    );
    expect(() => normalizeCredentialSourceUrl('https://[fe80::1]/credential')).toThrow(
      'private IPv6',
    );
    expect(() => normalizeCredentialSourceUrl('https://[fe90::1]/credential')).toThrow(
      'private IPv6',
    );
  });

  it('supports BADGE/Open Badge evidence without provider fetching', () => {
    const evidence = buildCredentialEvidencePackage(OPEN_BADGE_EVIDENCE_INPUT);

    expect(evidence.credential.type).toBe('BADGE');
    expect(evidence.evidence.verificationLevel).toBe('source_signed');
    expect(evidence.evidence.extractionMethod).toBe('open_badge');
    expect(evidence.source.url).toBe('https://www.credly.example/badges/badge-789/public_url?locale=en');
  });

  it('supports Accredible-style structured evidence fixtures', () => {
    const evidence = buildCredentialEvidencePackage(ACCREDIBLE_STYLE_EVIDENCE_INPUT);

    expect(evidence.source.provider).toBe('accredible');
    expect(evidence.source.url).toBe('https://credentials.example.com/12345678');
    expect(evidence.evidence.extractionManifestHash).toBe('2'.repeat(64));
  });

  it('creates public-safe metadata without raw recipient display names', () => {
    const evidence = buildCredentialEvidencePackage(GENERIC_URL_EVIDENCE_INPUT);
    const metadata = toPublicSafeCredentialEvidenceMetadata(evidence);

    expect(metadata).toMatchObject({
      evidence_schema_version: 'credential_evidence_v1',
      evidence_package_hash: evidence.evidencePackageHash,
      source_url: 'https://credentials.example.edu/verify/abc-123?view=public',
      source_provider: 'generic',
      source_payload_hash: 'a'.repeat(64),
      verification_level: 'captured_url',
      extraction_method: 'html_metadata',
      credential_title: 'Advanced Data Stewardship Certificate',
      credential_type: 'CERTIFICATE',
      credential_issuer: 'Example University',
      recipient_identifier_hash: 'b'.repeat(64),
    });
    expect(metadata).not.toHaveProperty('recipientDisplayName');
    expect(metadata).not.toHaveProperty('recipient_display_name');
  });

  it('parses only public-safe credential evidence metadata keys', () => {
    const evidence = buildCredentialEvidencePackage(GENERIC_URL_EVIDENCE_INPUT);
    const parsed = parsePublicCredentialEvidenceMetadata({
      ...toPublicSafeCredentialEvidenceMetadata(evidence),
      recipient_display_name: 'Should not persist',
      access_token: 'secret',
    });

    expect(parsed).toMatchObject({
      evidence_package_hash: evidence.evidencePackageHash,
      source_url: 'https://credentials.example.edu/verify/abc-123?view=public',
    });
    expect(parsed).not.toHaveProperty('recipient_display_name');
    expect(parsed).not.toHaveProperty('access_token');
  });

  it('returns structured metadata parse errors for observability', () => {
    const parsed = parsePublicCredentialEvidenceMetadataResult({
      source_url: 'https://[::ffff:127.0.0.1]/credential',
      source_provider: 'credly',
    });

    expect(parsed).toMatchObject({
      ok: false,
      reason: 'invalid_public_metadata',
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: 'source_url',
          message: expect.stringContaining('private IPv4'),
        }),
      ]),
    });
  });

  it('returns known fixture hashes to detect accidental canonicalization drift', () => {
    expect(computeCredentialEvidenceHash(GENERIC_URL_EVIDENCE_INPUT)).toBe(
      'f3010fe1086ec3a7ff521bf5fa10ddabc5813104fe814fef2cab6a1e17ccc5c5',
    );
    expect(computeCredentialEvidenceHash(OPEN_BADGE_EVIDENCE_INPUT)).toBe(
      '0f6e4eb9a1a64bc4c392335609f4fcda36465ddb6880d3f5f90246692b398167',
    );
    expect(computeCredentialEvidenceHash(ACCREDIBLE_STYLE_EVIDENCE_INPUT)).toBe(
      '1b34b3a45d31fb6a6cd86c5206ae22aecbc2c2892a0b9c30a41450c50168066a',
    );
  });
});
