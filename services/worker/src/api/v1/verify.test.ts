/**
 * Tests for GET /api/v1/verify/:publicId (P4.5-TS-01)
 *
 * Verifies the frozen verification response schema (CLAUDE.md Section 10).
 */

import { describe, it, expect, vi } from 'vitest';

// Mock db and logger to avoid config validation at import time
vi.mock('../../utils/db.js', () => ({
  db: { from: vi.fn() },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config.js', () => ({
  config: { bitcoinNetwork: 'signet' },
}));

import { buildVerificationResult, type AnchorByPublicId } from './verify.js';

function createAnchor(overrides: Partial<AnchorByPublicId> = {}): AnchorByPublicId {
  return {
    public_id: 'ARK-2026-TEST-001',
    fingerprint: 'a'.repeat(64),
    status: 'SECURED',
    chain_tx_id: 'b8e381df09ca404eaae2e5e9d9b3d27567fe97ece39ead718f6d2c77ca60eb57',
    chain_block_height: 204567,
    chain_timestamp: '2026-03-12T10:30:00Z',
    created_at: '2026-03-10T08:00:00Z',
    credential_type: 'DIPLOMA',
    org_name: 'University of Michigan',
    recipient_hash: 'sha256:recipient@example.com',
    issued_at: '2026-01-15T00:00:00Z',
    expires_at: null,
    jurisdiction: null,
    merkle_root: null,
    description: null,
    ...overrides,
  };
}

describe('buildVerificationResult', () => {
  it('returns verified=true for SECURED anchor with full frozen schema', () => {
    const anchor = createAnchor();
    const result = buildVerificationResult(anchor);

    expect(result.verified).toBe(true);
    expect(result.status).toBe('ACTIVE');
    expect(result.issuer_name).toBe('University of Michigan');
    expect(result.recipient_identifier).toBe('sha256:recipient@example.com');
    expect(result.credential_type).toBe('DIPLOMA');
    expect(result.issued_date).toBe('2026-01-15T00:00:00Z');
    expect(result.expiry_date).toBeNull();
    expect(result.anchor_timestamp).toBe('2026-03-10T08:00:00Z');
    expect(result.bitcoin_block).toBe(204567);
    expect(result.network_receipt_id).toBe('b8e381df09ca404eaae2e5e9d9b3d27567fe97ece39ead718f6d2c77ca60eb57');
    expect(result.record_uri).toBe('https://app.arkova.io/verify/ARK-2026-TEST-001');
  });

  it('returns verified=false for REVOKED anchor', () => {
    const anchor = createAnchor({ status: 'REVOKED' });
    const result = buildVerificationResult(anchor);

    expect(result.verified).toBe(false);
    expect(result.status).toBe('REVOKED');
    // Still includes chain receipt (it was once anchored)
    expect(result.network_receipt_id).toBeDefined();
  });

  it('returns verified=false for PENDING anchor', () => {
    const anchor = createAnchor({
      status: 'PENDING',
      chain_tx_id: null,
      chain_block_height: null,
    });
    const result = buildVerificationResult(anchor);

    expect(result.verified).toBe(false);
    expect(result.status).toBe('PENDING');
    expect(result.network_receipt_id).toBeNull();
    expect(result.bitcoin_block).toBeNull();
  });

  it('returns verified=false for EXPIRED anchor', () => {
    const anchor = createAnchor({ status: 'EXPIRED' });
    const result = buildVerificationResult(anchor);

    expect(result.verified).toBe(false);
    expect(result.status).toBe('EXPIRED');
  });

  it('returns verified=false for SUPERSEDED anchor', () => {
    const anchor = createAnchor({ status: 'SUPERSEDED' });
    const result = buildVerificationResult(anchor);

    expect(result.verified).toBe(false);
    expect(result.status).toBe('SUPERSEDED');
  });

  it('omits jurisdiction when null (frozen schema compliance)', () => {
    const anchor = createAnchor({ jurisdiction: null });
    const result = buildVerificationResult(anchor);

    expect(result).not.toHaveProperty('jurisdiction');
  });

  it('includes jurisdiction when present', () => {
    const anchor = createAnchor({ jurisdiction: 'US-MI' });
    const result = buildVerificationResult(anchor);

    expect(result.jurisdiction).toBe('US-MI');
  });

  it('omits optional fields when null', () => {
    const anchor = createAnchor({
      credential_type: null,
      org_name: null,
      recipient_hash: null,
    });
    const result = buildVerificationResult(anchor);

    expect(result).not.toHaveProperty('credential_type');
    expect(result).not.toHaveProperty('issuer_name');
    expect(result).not.toHaveProperty('recipient_identifier');
  });

  it('record_uri uses HTTPS per ADR-001', () => {
    const anchor = createAnchor();
    const result = buildVerificationResult(anchor);

    expect(result.record_uri).toMatch(/^https:\/\//);
    expect(result.record_uri).not.toMatch(/^arkova:\/\//);
  });

  it('maps ACTIVE status correctly', () => {
    const anchor = createAnchor({ status: 'ACTIVE' });
    const result = buildVerificationResult(anchor);

    expect(result.verified).toBe(true);
    expect(result.status).toBe('ACTIVE');
  });

  it('handles unknown status gracefully', () => {
    const anchor = createAnchor({ status: 'UNKNOWN_STATUS' });
    const result = buildVerificationResult(anchor);

    expect(result.verified).toBe(false);
    expect(result.status).toBeUndefined();
  });

  it('includes merkle_proof_hash when present', () => {
    const anchor = createAnchor({ merkle_root: 'deadbeef' + 'a'.repeat(56) });
    const result = buildVerificationResult(anchor);

    expect(result.merkle_proof_hash).toBe('deadbeef' + 'a'.repeat(56));
  });

  // BETA-11: explorer_url field (additive, nullable — Constitution 1.8)
  it('includes explorer_url when chain_tx_id is present', () => {
    const anchor = createAnchor({ chain_tx_id: 'abc123' });
    const result = buildVerificationResult(anchor);

    expect(result.explorer_url).toMatch(/mempool\.space.*\/tx\/abc123/);
  });

  it('omits explorer_url when chain_tx_id is null', () => {
    const anchor = createAnchor({ chain_tx_id: null });
    const result = buildVerificationResult(anchor);

    expect(result.explorer_url).toBeUndefined();
  });

  // BETA-12: description field (additive, nullable — Constitution 1.8)
  it('includes description when present', () => {
    const anchor = createAnchor({ description: 'A diploma from UMich' });
    const result = buildVerificationResult(anchor);

    expect(result.description).toBe('A diploma from UMich');
  });

  it('omits description when null', () => {
    const anchor = createAnchor({ description: null });
    const result = buildVerificationResult(anchor);

    expect(result).not.toHaveProperty('description');
  });
});
