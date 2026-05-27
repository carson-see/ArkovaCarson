/**
 * Tests for GET /api/v1/verify/attestation/:attestationId (SCRUM-1873)
 *
 * Verification endpoint for legally binding attestations. Public, anonymous
 * access — verification is a public good (Constitution 1.10: 100 req/min anon).
 *
 * Tests follow TDD red-green-refactor per CLAUDE.md rule 1.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock db and logger to avoid config validation at import time
vi.mock('../../../utils/db.js', () => ({
  db: { from: vi.fn() },
}));

vi.mock('../../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../config.js', () => ({
  config: {
    bitcoinNetwork: 'signet',
    frontendUrl: 'https://app.arkova.ai',
  },
}));

import {
  buildAttestationVerificationResult,
  type LegallyBindingAttestationRow,
} from './attestation.js';

// ── Factory ─────────────────────────────────────────────────

function createLba(
  overrides: Partial<LegallyBindingAttestationRow> = {},
): LegallyBindingAttestationRow {
  return {
    attestation_id: 'ARK-ATT-ABC123',
    attestation_type: 'notarized',
    attesting_org_name: 'Acme Legal Inc.',
    org_verified: true,
    subject_name: 'Jane Doe',
    // attestation_statement intentionally omitted (never selected per privacy policy)
    status: 'anchored',
    notary_name: 'John Notary',
    notary_commission_state: 'CA',
    notary_commission_number: 'N-12345',
    notarization_completed_at: '2026-05-20T15:00:00Z',
    anchor_public_id: 'ARK-2026-ANC-001',
    anchor_status: 'SECURED',
    anchor_fingerprint: 'a'.repeat(64),
    anchor_chain_tx_id: 'b8e381df09ca404eaae2e5e9d9b3d27567fe97ece39ead718f6d2c77ca60eb57',
    anchor_chain_block_height: 204567,
    anchor_chain_timestamp: '2026-05-21T10:30:00Z',
    anchor_timestamp: '2026-05-21T10:30:00Z',
    created_at: '2026-05-19T08:00:00Z',
    updated_at: '2026-05-21T11:00:00Z',
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────

describe('buildAttestationVerificationResult', () => {
  it('returns verified=true for a fully anchored notarized attestation', () => {
    const lba = createLba();
    const result = buildAttestationVerificationResult(lba);

    expect(result.verified).toBe(true);
    expect(result.attestation.public_id).toBe('ARK-ATT-ABC123');
    expect(result.attestation.type).toBe('notarized');
    expect(result.attestation.status).toBe('anchored');
    expect(result.attestation.attesting_org.name).toBe('Acme Legal Inc.');
    expect(result.attestation.attesting_org.verified).toBe(true);
    expect(result.attestation.subject.name).toBe('Jane Doe');
    expect(result.attestation.created_at).toBe('2026-05-19T08:00:00Z');
  });

  it('includes notarization details for notarized attestations', () => {
    const lba = createLba();
    const result = buildAttestationVerificationResult(lba);

    expect(result.attestation.notarization).toBeDefined();
    expect(result.attestation.notarization!.status).toBe('completed');
    expect(result.attestation.notarization!.notary_name).toBe('John Notary');
    expect(result.attestation.notarization!.commission_state).toBe('CA');
    expect(result.attestation.notarization!.commission_number).toBe('N-12345');
    expect(result.attestation.notarization!.completed_at).toBe('2026-05-20T15:00:00Z');
  });

  it('includes anchor proof for anchored attestations', () => {
    const lba = createLba();
    const result = buildAttestationVerificationResult(lba);

    expect(result.anchor).toBeDefined();
    expect(result.anchor!.status).toBe('SECURED');
    expect(result.anchor!.fingerprint).toBe('a'.repeat(64));
    expect(result.anchor!.network_receipt).toBe(
      'b8e381df09ca404eaae2e5e9d9b3d27567fe97ece39ead718f6d2c77ca60eb57',
    );
    expect(result.anchor!.anchored_at).toBe('2026-05-21T10:30:00Z');
    expect(result.anchor!.block_height).toBe(204567);
    expect(result.anchor!.explorer_url).toMatch(/mempool\.space.*\/tx\//);
  });

  it('returns verified=false for a draft attestation', () => {
    const lba = createLba({ status: 'draft', anchor_public_id: null, anchor_status: null });
    const result = buildAttestationVerificationResult(lba);

    expect(result.verified).toBe(false);
    expect(result.attestation.status).toBe('draft');
    expect(result.anchor).toBeNull();
  });

  it('returns verified=false for pending_notarization attestation', () => {
    const lba = createLba({
      status: 'pending_notarization',
      notary_name: null,
      notarization_completed_at: null,
      anchor_public_id: null,
      anchor_status: null,
    });
    const result = buildAttestationVerificationResult(lba);

    expect(result.verified).toBe(false);
    expect(result.attestation.status).toBe('pending_notarization');
    expect(result.attestation.notarization).toBeDefined();
    expect(result.attestation.notarization!.status).toBe('pending');
  });

  it('returns verified=false for notarized but not-yet-anchored attestation', () => {
    const lba = createLba({
      status: 'notarized',
      anchor_public_id: null,
      anchor_status: null,
      anchor_fingerprint: null,
      anchor_chain_tx_id: null,
      anchor_chain_block_height: null,
      anchor_chain_timestamp: null,
      anchor_timestamp: null,
    });
    const result = buildAttestationVerificationResult(lba);

    expect(result.verified).toBe(false);
    expect(result.attestation.status).toBe('notarized');
    expect(result.anchor).toBeNull();
  });

  it('returns verified=false for requires_review attestation', () => {
    const lba = createLba({ status: 'requires_review' });
    const result = buildAttestationVerificationResult(lba);

    expect(result.verified).toBe(false);
    expect(result.attestation.status).toBe('requires_review');
  });

  it('omits notarization block for standard (non-notarized) attestation types', () => {
    const lba = createLba({
      attestation_type: 'standard',
      notary_name: null,
      notary_commission_state: null,
      notary_commission_number: null,
      notarization_completed_at: null,
    });
    const result = buildAttestationVerificationResult(lba);

    expect(result.attestation.notarization).toBeUndefined();
  });

  it('omits notarization block for witnessed attestation types', () => {
    const lba = createLba({
      attestation_type: 'witnessed',
      notary_name: null,
      notary_commission_state: null,
      notary_commission_number: null,
      notarization_completed_at: null,
    });
    const result = buildAttestationVerificationResult(lba);

    expect(result.attestation.notarization).toBeUndefined();
  });

  it('includes anchor proof with null chain fields for PENDING anchor', () => {
    const lba = createLba({
      anchor_status: 'PENDING',
      anchor_chain_tx_id: null,
      anchor_chain_block_height: null,
      anchor_chain_timestamp: null,
    });
    const result = buildAttestationVerificationResult(lba);

    expect(result.verified).toBe(true); // attestation is anchored (DB status), even if chain is pending
    expect(result.anchor).toBeDefined();
    expect(result.anchor!.status).toBe('PENDING');
    expect(result.anchor!.network_receipt).toBeNull();
    expect(result.anchor!.block_height).toBeNull();
  });

  it('omits explorer_url when chain_tx_id is null', () => {
    const lba = createLba({
      anchor_chain_tx_id: null,
    });
    const result = buildAttestationVerificationResult(lba);

    if (result.anchor) {
      expect(result.anchor.explorer_url).toBeUndefined();
    }
  });

  it('does not leak internal UUIDs in any field', () => {
    const lba = createLba();
    const result = buildAttestationVerificationResult(lba);
    const serialized = JSON.stringify(result);

    // UUID v4 pattern: 8-4-4-4-12 hex chars
    expect(serialized).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
  });

  it('does not include attestation_statement in the response (privacy guard)', () => {
    const lba = createLba();
    const result = buildAttestationVerificationResult(lba);
    const serialized = JSON.stringify(result);

    // attestation_statement is marked as private in the migration comment
    expect(serialized).not.toContain('attestation_statement');
    expect(serialized).not.toContain('I attest that the credential is authentic.');
  });

  it('uses compliant terminology — no banned words in response', () => {
    const lba = createLba();
    const result = buildAttestationVerificationResult(lba);

    // Per CLAUDE.md 1.3: no "transaction", "hash", "blockchain", "bitcoin"
    // in user-visible API response keys
    const keys = extractAllKeys(result);
    const bannedKeyWords = ['transaction', 'hash', 'blockchain', 'bitcoin', 'wallet', 'crypto'];
    for (const key of keys) {
      const lower = key.toLowerCase();
      for (const banned of bannedKeyWords) {
        expect(lower).not.toContain(banned);
      }
    }
  });

  it('includes verify_url pointing to the attestation verification page', () => {
    const lba = createLba();
    const result = buildAttestationVerificationResult(lba);

    expect(result.verify_url).toBe('https://app.arkova.ai/verify/attestation/ARK-ATT-ABC123');
  });
});

// ── Helpers ─────────────────────────────────────────────────

function extractAllKeys(obj: unknown, prefix = ''): string[] {
  const keys: string[] = [];
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      keys.push(prefix ? `${prefix}.${key}` : key);
      keys.push(...extractAllKeys(value, prefix ? `${prefix}.${key}` : key));
    }
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      keys.push(...extractAllKeys(item, prefix));
    }
  }
  return keys;
}
