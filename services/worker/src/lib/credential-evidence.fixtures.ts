import {
  CREDENTIAL_EVIDENCE_SCHEMA_VERSION,
  type CredentialEvidenceHashInput,
} from './credential-evidence.js';

export const GENERIC_URL_EVIDENCE_INPUT: CredentialEvidenceHashInput = {
  schemaVersion: CREDENTIAL_EVIDENCE_SCHEMA_VERSION,
  source: {
    provider: 'generic',
    url: 'https://credentials.example.edu/verify/abc-123?utm_source=newsletter&view=public',
    id: 'abc-123',
    fetchedAt: '2026-05-01T14:00:00.000Z',
    payloadHash: 'a'.repeat(64),
    payloadContentType: 'text/html',
    payloadByteLength: 42_000,
  },
  credential: {
    type: 'CERTIFICATE',
    title: 'Advanced Data Stewardship Certificate',
    issuerName: 'Example University',
    issuedAt: '2026-04-15',
    expiresAt: '2028-04-15',
    recipientDisplayName: 'Public Learner',
    recipientIdentifierHash: 'b'.repeat(64),
  },
  evidence: {
    verificationLevel: 'captured_url',
    extractionMethod: 'html_metadata',
    confidence: 0.74,
  },
};

export const OPEN_BADGE_EVIDENCE_INPUT: CredentialEvidenceHashInput = {
  schemaVersion: CREDENTIAL_EVIDENCE_SCHEMA_VERSION,
  source: {
    provider: 'credly',
    url: 'https://www.credly.example/badges/badge-789/public_url?token=secret-token&locale=en',
    id: 'badge-789',
    fetchedAt: '2026-05-01T15:00:00.000Z',
    payloadHash: 'c'.repeat(64),
    payloadContentType: 'application/ld+json',
    payloadByteLength: 12_288,
  },
  credential: {
    type: 'BADGE',
    title: 'Cloud Architecture Fundamentals',
    issuerName: 'Example Cloud',
    issuedAt: '2026-03-20T00:00:00.000Z',
    credentialIdHash: 'd'.repeat(64),
    recipientIdentifierHash: 'e'.repeat(64),
  },
  evidence: {
    verificationLevel: 'source_signed',
    extractionMethod: 'open_badge',
    confidence: 0.97,
  },
};

export const ACCREDIBLE_STYLE_EVIDENCE_INPUT: CredentialEvidenceHashInput = {
  schemaVersion: CREDENTIAL_EVIDENCE_SCHEMA_VERSION,
  source: {
    provider: 'accredible',
    url: 'https://credentials.example.com/12345678?signature=signed-value&key=api-key',
    id: '12345678',
    fetchedAt: '2026-05-01T16:00:00.000Z',
    payloadHash: 'f'.repeat(64),
    payloadContentType: 'application/json',
    payloadByteLength: 9_876,
  },
  credential: {
    type: 'CERTIFICATE',
    title: 'Board Governance Credential',
    issuerName: 'Example Association',
    issuedAt: '2025-12-01',
    expiresAt: '2027-12-01',
    credentialIdHash: '1'.repeat(64),
  },
  evidence: {
    verificationLevel: 'captured_url',
    extractionMethod: 'json_ld',
    extractionManifestHash: '2'.repeat(64),
    confidence: 0.86,
  },
};
