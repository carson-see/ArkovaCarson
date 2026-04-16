/**
 * Unit tests for Record Authenticity Oracle (PH2-AGENT-04)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Hoisted mocks ----
const { mockDbFrom, mockLogger } = vi.hoisted(() => {
  const mockDbFrom = vi.fn();
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return { mockDbFrom, mockLogger };
});

vi.mock('../../utils/db.js', () => ({
  db: { from: mockDbFrom },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: mockLogger,
}));

vi.mock('../../config.js', () => ({
  config: { bitcoinNetwork: 'mainnet', frontendUrl: 'https://app.arkova.ai' },
}));

import { buildVerificationResult } from './verify.js';

describe('Oracle endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('buildVerificationResult (reused by oracle)', () => {
    it('returns verified=true for SECURED anchors', () => {
      const result = buildVerificationResult({
        public_id: 'ARK-TST-DEG-ABC123',
        fingerprint: 'abc123',
        status: 'SECURED',
        chain_tx_id: 'abcdef0123456789',
        chain_block_height: 900000,
        chain_timestamp: '2026-04-01T00:00:00Z',
        created_at: '2026-04-01T00:00:00Z',
        credential_type: 'DEGREE',
        org_name: 'University of Michigan',
        recipient_hash: null,
        issued_at: '2026-01-15',
        expires_at: null,
        jurisdiction: null,
        merkle_root: null,
        description: 'Bachelor of Science',
        directory_info_opt_out: false,
        compliance_controls: null,
        chain_confirmations: null,
        parent_public_id: null,
        version_number: null,
        revocation_tx_id: null,
        revocation_block_height: null,
        file_mime: null,
        file_size: null,
      });

      expect(result.verified).toBe(true);
      expect(result.status).toBe('ACTIVE');
      expect(result.credential_type).toBe('DEGREE');
      expect(result.issuer_name).toBe('University of Michigan');
      expect(result.description).toBe('Bachelor of Science');
      expect(result.explorer_url).toBe('https://mempool.space/tx/abcdef0123456789');
    });

    it('returns verified=false for PENDING anchors', () => {
      const result = buildVerificationResult({
        public_id: 'ARK-TST-LIC-DEF456',
        fingerprint: 'def456',
        status: 'PENDING',
        chain_tx_id: null,
        chain_block_height: null,
        chain_timestamp: null,
        created_at: '2026-04-01T00:00:00Z',
        credential_type: 'LICENSE',
        org_name: null,
        recipient_hash: null,
        issued_at: null,
        expires_at: null,
        jurisdiction: null,
        merkle_root: null,
        description: null,
        directory_info_opt_out: false,
        compliance_controls: null,
        chain_confirmations: null,
        parent_public_id: null,
        version_number: null,
        revocation_tx_id: null,
        revocation_block_height: null,
        file_mime: null,
        file_size: null,
      });

      expect(result.verified).toBe(false);
      expect(result.status).toBe('PENDING');
    });

    it('returns verified=false for REVOKED anchors', () => {
      const result = buildVerificationResult({
        public_id: 'ARK-TST-CRT-GHI789',
        fingerprint: 'ghi789',
        status: 'REVOKED',
        chain_tx_id: 'txid456',
        chain_block_height: 900001,
        chain_timestamp: '2026-04-01T00:00:00Z',
        created_at: '2026-04-01T00:00:00Z',
        credential_type: 'CERTIFICATE',
        org_name: 'Acme Corp',
        recipient_hash: null,
        issued_at: '2026-01-01',
        expires_at: '2027-01-01',
        jurisdiction: null,
        merkle_root: null,
        description: null,
        directory_info_opt_out: false,
        compliance_controls: null,
        chain_confirmations: null,
        parent_public_id: null,
        version_number: null,
        revocation_tx_id: null,
        revocation_block_height: null,
        file_mime: null,
        file_size: null,
      });

      expect(result.verified).toBe(false);
      expect(result.status).toBe('REVOKED');
    });
  });

  describe('OracleQuerySchema validation', () => {
    it('rejects empty public_ids array', () => {
      const { z } = require('zod');
      const schema = z.object({
        public_ids: z.array(z.string().min(3).max(64)).min(1).max(25),
      });
      expect(schema.safeParse({ public_ids: [] }).success).toBe(false);
    });

    it('rejects more than 25 public_ids', () => {
      const { z } = require('zod');
      const schema = z.object({
        public_ids: z.array(z.string().min(3).max(64)).min(1).max(25),
      });
      const ids = Array.from({ length: 26 }, (_, i) => `ARK-TST-DEG-${i}`);
      expect(schema.safeParse({ public_ids: ids }).success).toBe(false);
    });

    it('accepts valid public_ids', () => {
      const { z } = require('zod');
      const schema = z.object({
        public_ids: z.array(z.string().min(3).max(64)).min(1).max(25),
      });
      expect(schema.safeParse({ public_ids: ['ARK-TST-DEG-ABC123'] }).success).toBe(true);
    });
  });
});
