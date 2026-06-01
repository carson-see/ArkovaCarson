/**
 * Credly adapter tests — SCRUM-1612 CSI-04B.
 *
 * TDD red→green pin per CLAUDE.md §0 rule 1. Uses inline OB3-shaped
 * fixtures; no real HTTP, no real KMS.
 */
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';

import {
  credlyBadgeToEvidence,
  CREDLY_SOURCE_PROVIDER_SLUG,
} from './adapter.js';
import type { CredlyIssuedBadge } from './client.js';

/** A minimal-but-realistic Credly issued-badge fixture (no proof). */
const PLAIN_BADGE: CredlyIssuedBadge = {
  id: 'bdg-abc-123',
  issued_at: '2026-04-15T12:00:00Z',
  expires_at: null,
  public_url: 'https://www.credly.com/badges/bdg-abc-123/public_url',
  image_url: 'https://images.credly.com/bdg-abc-123.png',
  recipient: { email: 'alex@example.com' },
  badge_template: {
    id: 'tpl-cloud-arch',
    name: 'Cloud Architecture Fundamentals',
    description: 'Foundational cloud architecture credential',
    owner: { name: 'Example Cloud' },
  },
};

/** Same badge but with an OB3-style top-level `proof` block. */
const SIGNED_BADGE: CredlyIssuedBadge = {
  ...PLAIN_BADGE,
  id: 'bdg-signed-456',
  '@context': [
    'https://www.w3.org/ns/credentials/v2',
    'https://purl.imsglobal.org/spec/ob/v3p0/context.json',
  ],
  proof: {
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-rdfc-2022',
    proofValue: 'z3Mvx...redacted',
    verificationMethod:
      'did:web:credly.com#key-1',
    created: '2026-04-15T12:00:00Z',
  },
};

const RAW_BYTES = Buffer.from(JSON.stringify(PLAIN_BADGE), 'utf8');
const RAW_BYTES_HASH = createHash('sha256').update(RAW_BYTES).digest('hex');

describe('SCRUM-1612 — credlyBadgeToEvidence', () => {
  it('produces a credential_evidence_v1 package with provider=credly and type=BADGE', async () => {
    const result = credlyBadgeToEvidence(PLAIN_BADGE, {
      fetchedAt: '2026-05-01T00:00:00.000Z',
      payloadHash: RAW_BYTES_HASH,
      payloadByteLength: RAW_BYTES.length,
      recipientEmail: 'alex@example.com',
    });

    expect(result.evidence.schemaVersion).toBe('credential_evidence_v1');
    expect(result.evidence.source.provider).toBe(CREDLY_SOURCE_PROVIDER_SLUG);
    expect(result.evidence.credential.type).toBe('BADGE');
    expect(result.evidence.credential.title).toBe(
      'Cloud Architecture Fundamentals',
    );
    expect(result.evidence.credential.issuerName).toBe('Example Cloud');
    expect(result.evidence.source.url).toBe(PLAIN_BADGE.public_url);
    expect(result.package.evidencePackageHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sets verification_level to account_linked (issuer-API confirmed) and extraction_method to issuer_api', () => {
    const result = credlyBadgeToEvidence(PLAIN_BADGE, {
      fetchedAt: '2026-05-01T00:00:00.000Z',
      payloadHash: RAW_BYTES_HASH,
    });
    expect(result.evidence.evidence.verificationLevel).toBe('account_linked');
    expect(result.evidence.evidence.extractionMethod).toBe('issuer_api');
  });

  it('NEVER sets verification_level to source_signed even when proof block present (v1.0 trust gap closed)', () => {
    const result = credlyBadgeToEvidence(SIGNED_BADGE, {
      fetchedAt: '2026-05-01T00:00:00.000Z',
      payloadHash: RAW_BYTES_HASH,
    });
    expect(result.evidence.evidence.verificationLevel).not.toBe('source_signed');
    expect(result.evidence.evidence.verificationLevel).toBe('account_linked');
    // But proofDetected must surface so v1.1 can scan + upgrade
    expect(result.proofDetected).toBe(true);
  });

  it('proofDetected is false when no `proof` block is present', () => {
    const result = credlyBadgeToEvidence(PLAIN_BADGE, {
      fetchedAt: '2026-05-01T00:00:00.000Z',
      payloadHash: RAW_BYTES_HASH,
    });
    expect(result.proofDetected).toBe(false);
  });

  it('hashes the recipient email (lowercased + trimmed) into recipientIdentifierHash', () => {
    const a = credlyBadgeToEvidence(PLAIN_BADGE, {
      fetchedAt: '2026-05-01T00:00:00.000Z',
      payloadHash: RAW_BYTES_HASH,
      recipientEmail: 'Alex@Example.com',
    });
    const b = credlyBadgeToEvidence(PLAIN_BADGE, {
      fetchedAt: '2026-05-01T00:00:00.000Z',
      payloadHash: RAW_BYTES_HASH,
      recipientEmail: '  alex@example.com  ',
    });
    expect(a.evidence.credential.recipientIdentifierHash).toEqual(
      b.evidence.credential.recipientIdentifierHash,
    );
    expect(a.evidence.credential.recipientIdentifierHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes the credential id rather than copying it', () => {
    const result = credlyBadgeToEvidence(PLAIN_BADGE, {
      fetchedAt: '2026-05-01T00:00:00.000Z',
      payloadHash: RAW_BYTES_HASH,
    });
    expect(result.evidence.credential.credentialIdHash).toBe(
      createHash('sha256').update(PLAIN_BADGE.id, 'utf8').digest('hex'),
    );
  });

  it('does NOT leak the raw recipient email anywhere in the evidence package', () => {
    const result = credlyBadgeToEvidence(PLAIN_BADGE, {
      fetchedAt: '2026-05-01T00:00:00.000Z',
      payloadHash: RAW_BYTES_HASH,
      recipientEmail: 'alex@example.com',
    });
    const serialised = JSON.stringify(result.package);
    expect(serialised).not.toContain('alex@example.com');
    expect(serialised).not.toContain('Alex@Example.com');
  });

  it('falls back to a canonical API URL when public_url is missing', () => {
    const noUrl: CredlyIssuedBadge = { ...PLAIN_BADGE, public_url: undefined };
    const result = credlyBadgeToEvidence(noUrl, {
      fetchedAt: '2026-05-01T00:00:00.000Z',
      payloadHash: RAW_BYTES_HASH,
    });
    expect(result.evidence.source.url).toMatch(
      /^https:\/\/api\.credly\.com\/v1\/issued_badges\//,
    );
  });

  it('throws on missing id (defence-in-depth — Credly response shape regression)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const broken: CredlyIssuedBadge = { ...PLAIN_BADGE, id: '' as any };
    expect(() =>
      credlyBadgeToEvidence(broken, {
        fetchedAt: '2026-05-01T00:00:00.000Z',
        payloadHash: RAW_BYTES_HASH,
      }),
    ).toThrow(/missing required `id`/);
  });

  it('throws on missing badge_template.name', () => {
    const broken: CredlyIssuedBadge = {
      ...PLAIN_BADGE,
      badge_template: { id: 'x' },
    };
    expect(() =>
      credlyBadgeToEvidence(broken, {
        fetchedAt: '2026-05-01T00:00:00.000Z',
        payloadHash: RAW_BYTES_HASH,
      }),
    ).toThrow(/missing required `badge_template.name`/);
  });

  it('produces a deterministic evidencePackageHash for the same inputs', () => {
    const a = credlyBadgeToEvidence(PLAIN_BADGE, {
      fetchedAt: '2026-05-01T00:00:00.000Z',
      payloadHash: RAW_BYTES_HASH,
      payloadByteLength: RAW_BYTES.length,
    });
    const b = credlyBadgeToEvidence(PLAIN_BADGE, {
      fetchedAt: '2026-05-01T00:00:00.000Z',
      payloadHash: RAW_BYTES_HASH,
      payloadByteLength: RAW_BYTES.length,
    });
    expect(a.package.evidencePackageHash).toBe(b.package.evidencePackageHash);
  });
});
