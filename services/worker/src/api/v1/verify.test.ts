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
  config: { bitcoinNetwork: 'signet', frontendUrl: 'https://app.arkova.ai' },
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
    directory_info_opt_out: false,
    // API-RICH-01 defaults (all null — opt-in per anchor)
    compliance_controls: null,
    chain_confirmations: null,
    parent_public_id: null,
    version_number: null,
    revocation_tx_id: null,
    revocation_block_height: null,
    file_mime: null,
    file_size: null,
    // API-RICH-02 (SCRUM-895)
    confidence_scores: null,
    sub_type: null,
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
    expect(result.record_uri).toBe('https://app.arkova.ai/verify/ARK-2026-TEST-001');
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

  // REG-03: FERPA re-disclosure notice tests
  it('includes FERPA notice for DEGREE credential type', () => {
    const anchor = createAnchor({ credential_type: 'DEGREE' });
    const result = buildVerificationResult(anchor);

    expect(result.ferpa_notice).toBeDefined();
    expect(result.ferpa_notice).toContain('Section 99.33');
  });

  it('includes FERPA notice for TRANSCRIPT credential type', () => {
    const anchor = createAnchor({ credential_type: 'TRANSCRIPT' });
    const result = buildVerificationResult(anchor);

    expect(result.ferpa_notice).toContain('education records');
  });

  it('includes FERPA notice for CERTIFICATE credential type', () => {
    const anchor = createAnchor({ credential_type: 'CERTIFICATE' });
    const result = buildVerificationResult(anchor);

    expect(result.ferpa_notice).toBeDefined();
  });

  it('includes FERPA notice for CLE credential type', () => {
    const anchor = createAnchor({ credential_type: 'CLE' });
    const result = buildVerificationResult(anchor);

    expect(result.ferpa_notice).toBeDefined();
  });

  it('omits FERPA notice for non-education credential types', () => {
    const anchor = createAnchor({ credential_type: 'INSURANCE' });
    const result = buildVerificationResult(anchor);

    expect(result).not.toHaveProperty('ferpa_notice');
  });

  it('omits FERPA notice when credential_type is null', () => {
    const anchor = createAnchor({ credential_type: null });
    const result = buildVerificationResult(anchor);

    expect(result).not.toHaveProperty('ferpa_notice');
  });

  // REG-02: Directory Information Opt-Out (FERPA Section 99.37)
  describe('directory_info_opt_out', () => {
    it('suppresses directory fields for education type when opt-out is true', () => {
      const anchor = createAnchor({
        credential_type: 'DEGREE',
        directory_info_opt_out: true,
        org_name: 'University of Michigan',
        recipient_hash: 'sha256:student@edu',
        issued_at: '2026-01-15T00:00:00Z',
        expires_at: '2030-01-15T00:00:00Z',
      });
      const result = buildVerificationResult(anchor);

      expect(result.verified).toBe(true);
      expect(result.credential_type).toBe('DEGREE');
      // Directory fields suppressed
      expect(result).not.toHaveProperty('issuer_name');
      expect(result).not.toHaveProperty('recipient_identifier');
      expect(result).not.toHaveProperty('issued_date');
      expect(result).not.toHaveProperty('expiry_date');
      expect(result.directory_info_suppressed).toBe(true);
    });

    it('does not suppress fields when opt-out is false', () => {
      const anchor = createAnchor({
        credential_type: 'DEGREE',
        directory_info_opt_out: false,
        org_name: 'University of Michigan',
      });
      const result = buildVerificationResult(anchor);

      expect(result.issuer_name).toBe('University of Michigan');
      expect(result).not.toHaveProperty('directory_info_suppressed');
    });

    it('does not suppress fields for non-education types even when opt-out is true', () => {
      const anchor = createAnchor({
        credential_type: 'INSURANCE',
        directory_info_opt_out: true,
        org_name: 'Aetna Health',
        recipient_hash: 'sha256:patient@health',
      });
      const result = buildVerificationResult(anchor);

      // Non-education type — opt-out does not apply
      expect(result.issuer_name).toBe('Aetna Health');
      expect(result.recipient_identifier).toBe('sha256:patient@health');
      expect(result).not.toHaveProperty('directory_info_suppressed');
    });

    it('suppresses for TRANSCRIPT type with opt-out', () => {
      const anchor = createAnchor({
        credential_type: 'TRANSCRIPT',
        directory_info_opt_out: true,
        org_name: 'Stanford University',
      });
      const result = buildVerificationResult(anchor);

      expect(result).not.toHaveProperty('issuer_name');
      expect(result.directory_info_suppressed).toBe(true);
    });

    it('suppresses for CERTIFICATE type with opt-out', () => {
      const anchor = createAnchor({
        credential_type: 'CERTIFICATE',
        directory_info_opt_out: true,
      });
      const result = buildVerificationResult(anchor);

      expect(result.directory_info_suppressed).toBe(true);
    });

    it('suppresses for CLE type with opt-out', () => {
      const anchor = createAnchor({
        credential_type: 'CLE',
        directory_info_opt_out: true,
      });
      const result = buildVerificationResult(anchor);

      expect(result.directory_info_suppressed).toBe(true);
    });
  });

  describe('API-RICH-01 — additive rich fields (SCRUM-772 / 2026-04-16)', () => {
    it('omits all new fields when all are null (backwards-compat baseline)', () => {
      const result = buildVerificationResult(createAnchor());
      expect(result.compliance_controls).toBeUndefined();
      expect(result.chain_confirmations).toBeUndefined();
      expect(result.parent_public_id).toBeUndefined();
      expect(result.version_number).toBeUndefined();
      expect(result.revocation_tx_id).toBeUndefined();
      expect(result.revocation_block_height).toBeUndefined();
      expect(result.file_mime).toBeUndefined();
      expect(result.file_size).toBeUndefined();
    });

    it('surfaces compliance_controls JSON when present', () => {
      const result = buildVerificationResult(createAnchor({
        compliance_controls: { soc2: ['CC6.1', 'CC6.2'], ferpa: ['99.31'] },
      }));
      expect(result.compliance_controls).toEqual({
        soc2: ['CC6.1', 'CC6.2'],
        ferpa: ['99.31'],
      });
    });

    it('surfaces chain_confirmations when non-null', () => {
      const result = buildVerificationResult(createAnchor({ chain_confirmations: 6 }));
      expect(result.chain_confirmations).toBe(6);
    });

    it('accepts chain_confirmations=0 (unconfirmed) without omitting', () => {
      const result = buildVerificationResult(createAnchor({ chain_confirmations: 0 }));
      expect(result.chain_confirmations).toBe(0);
    });

    it('surfaces parent_public_id (never raw UUID)', () => {
      const result = buildVerificationResult(createAnchor({ parent_public_id: 'ARK-2025-PARENT-001' }));
      expect(result.parent_public_id).toBe('ARK-2025-PARENT-001');
    });

    it('omits version_number when it equals default (1) to keep response lean', () => {
      const result = buildVerificationResult(createAnchor({ version_number: 1 }));
      expect(result.version_number).toBeUndefined();
    });

    it('surfaces version_number when > 1', () => {
      const result = buildVerificationResult(createAnchor({ version_number: 3 }));
      expect(result.version_number).toBe(3);
    });

    it('surfaces revocation_tx_id + revocation_block_height for REVOKED anchors', () => {
      const result = buildVerificationResult(createAnchor({
        status: 'REVOKED',
        revocation_tx_id: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        revocation_block_height: 900123,
      }));
      expect(result.revocation_tx_id).toBe('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
      expect(result.revocation_block_height).toBe(900123);
    });

    it('surfaces file_mime + file_size when present', () => {
      const result = buildVerificationResult(createAnchor({
        file_mime: 'application/pdf',
        file_size: 128_456,
      }));
      expect(result.file_mime).toBe('application/pdf');
      expect(result.file_size).toBe(128_456);
    });

    it('does not leak an internal UUID in any output field', () => {
      // Constitution 1.4: never expose anchors.id / user_id / org_id publicly.
      const result = buildVerificationResult(createAnchor({
        parent_public_id: 'ARK-2025-PARENT-XYZ',
      }));
      const serialized = JSON.stringify(result);
      // UUID v4 pattern: 8-4-4-4-12 hex chars
      expect(serialized).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    });
  });

  // API-RICH-02 (SCRUM-895): per-field confidence_scores + sub_type surfaced
  // on the verify response. confidence_scores comes from the latest extraction
  // manifest; sub_type comes from anchors.sub_type (GRE-01 column).
  describe('API-RICH-02 (SCRUM-895): confidence_scores + sub_type', () => {
    it('surfaces confidence_scores when present on the latest manifest', () => {
      const result = buildVerificationResult(createAnchor({
        confidence_scores: { overall: 0.92, grounding: 0.88, fields: { issuerName: 0.95, issuedDate: 0.9 } },
      }));
      expect(result.confidence_scores).toEqual({
        overall: 0.92,
        grounding: 0.88,
        fields: { issuerName: 0.95, issuedDate: 0.9 },
      });
    });

    it('omits confidence_scores when no manifest exists', () => {
      const result = buildVerificationResult(createAnchor({ confidence_scores: null }));
      expect(result).not.toHaveProperty('confidence_scores');
    });

    it('surfaces sub_type when anchors.sub_type is set (GRE-01)', () => {
      const result = buildVerificationResult(createAnchor({
        credential_type: 'TRANSCRIPT',
        sub_type: 'official_undergraduate',
      }));
      expect(result.sub_type).toBe('official_undergraduate');
    });

    it('omits sub_type when null', () => {
      const result = buildVerificationResult(createAnchor({ sub_type: null }));
      expect(result).not.toHaveProperty('sub_type');
    });

    it('does not include fraudSignals (gated behind ENABLE_FRAUD_SIGNALS, default off)', () => {
      const result = buildVerificationResult(createAnchor({
        confidence_scores: { overall: 0.7, grounding: 0.6, fields: {} },
      }));
      expect(result).not.toHaveProperty('fraudSignals');
      expect(result).not.toHaveProperty('fraud_signals');
    });
  });
});
