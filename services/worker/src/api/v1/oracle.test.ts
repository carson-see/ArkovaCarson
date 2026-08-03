/**
 * Unit tests for Record Authenticity Oracle (PH2-AGENT-04)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

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
  config: { bitcoinNetwork: 'mainnet', frontendUrl: 'https://app.arkova.ai', enableCredentialVerifiedWebhook: false },
}));

vi.mock('../../webhooks/delivery.js', () => ({
  dispatchWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../utils/concurrency.js', () => ({
  runWithConcurrency: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../utils/auditEvent.js', () => ({
  recordAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

import { buildVerificationResult } from './verify.js';
import { oracleRouter } from './oracle.js';
import type { Request, Response } from 'express';

// ---- Route-level test helpers (mirrors ai-verify-search.test.ts's pattern:
// pull the raw handler off the router's internal stack and invoke it
// directly, rather than standing up a full Express app + supertest) ----
function getOracleHandler() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stack = (oracleRouter as any).stack;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = stack.find((l: any) => l.route?.path === '/verify' && l.route?.methods?.post);
  return layer?.route?.stack[0].handle;
}

function createOracleReqRes(
  body: Record<string, unknown> = {},
  apiKey?: { keyId: string; orgId: string; userId: string; scopes: string[]; rateLimitTier: string; keyPrefix: string },
) {
  const req = {
    apiKey,
    body,
    method: 'POST',
    url: '/verify',
  } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return { req, res };
}

const mockOracleApiKey = {
  keyId: 'key-123',
  orgId: 'org-456',
  userId: 'user-789',
  scopes: ['verify'],
  rateLimitTier: 'paid' as const,
  keyPrefix: 'ak_test',
};

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
        confidence_scores: null,
        sub_type: null,
        fingerprint_source: null,
      });

      expect(result.verified).toBe(true);
      expect(result.status).toBe('ACTIVE');
      expect(result.credential_type).toBe('DEGREE');
      expect(result.issuer_name).toBe('University of Michigan');
      // DEGREE is an ACADEMIC RECORD, so it emits no issuer- or
      // extraction-authored free text — `description` is omitted regardless of
      // its content. This assertion used to read
      // `toBe('Bachelor of Science')`; it was pinning the leak. The oracle
      // reuses `buildVerificationResult`, so it inherits the gate, which is the
      // point of putting the gate at that seam rather than in the route.
      // Rule + rationale: scripts/ci/public-pii-projection-contract.json.
      expect(result.description).toBeUndefined();
      expect(result.explorer_url).toBe('https://mempool.space/tx/abcdef0123456789');
    });

    it('still publishes a description on a NON-academic credential type', () => {
      // The companion to the assertion above: the gate is scoped to academic
      // records plus the value detectors, not a blanket description blackout.
      const result = buildVerificationResult({
        public_id: 'ARK-TST-CLE-ABC123',
        fingerprint: 'abc123',
        status: 'SECURED',
        chain_tx_id: 'abcdef0123456789',
        chain_block_height: 900000,
        chain_timestamp: '2026-04-01T00:00:00Z',
        created_at: '2026-04-01T00:00:00Z',
        credential_type: 'CLE',
        org_name: 'University of Michigan',
        recipient_hash: null,
        issued_at: '2026-01-15',
        expires_at: null,
        jurisdiction: null,
        merkle_root: null,
        description: 'Ethics for Trial Lawyers',
        directory_info_opt_out: false,
        compliance_controls: null,
        chain_confirmations: null,
        parent_public_id: null,
        version_number: null,
        revocation_tx_id: null,
        revocation_block_height: null,
        file_mime: null,
        file_size: null,
        confidence_scores: null,
        sub_type: null,
        fingerprint_source: null,
      });

      expect(result.description).toBe('Ethics for Trial Lawyers');
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
        confidence_scores: null,
        sub_type: null,
        fingerprint_source: null,
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
        confidence_scores: null,
        sub_type: null,
        fingerprint_source: null,
      });

      expect(result.verified).toBe(false);
      expect(result.status).toBe('REVOKED');
    });
  });

  describe('OracleQuerySchema validation', () => {
    it('rejects empty public_ids array', () => {
      // z imported at top level
      const schema = z.object({
        public_ids: z.array(z.string().min(3).max(64)).min(1).max(25),
      });
      expect(schema.safeParse({ public_ids: [] }).success).toBe(false);
    });

    it('rejects more than 25 public_ids', () => {
      // z imported at top level
      const schema = z.object({
        public_ids: z.array(z.string().min(3).max(64)).min(1).max(25),
      });
      const ids = Array.from({ length: 26 }, (_, i) => `ARK-TST-DEG-${i}`);
      expect(schema.safeParse({ public_ids: ids }).success).toBe(false);
    });

    it('accepts valid public_ids', () => {
      // z imported at top level
      const schema = z.object({
        public_ids: z.array(z.string().min(3).max(64)).min(1).max(25),
      });
      expect(schema.safeParse({ public_ids: ['ARK-TST-DEG-ABC123'] }).success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/oracle/verify — authentication (this session's finding).
  //
  // THE BUG: oracle.ts's own header claims this endpoint "Requires an API
  // key (identifies the querying agent)", unlike the public anonymous
  // GET /verify/:publicId. But it is mounted at router.ts:462 as
  // `router.use('/oracle', requireScope('verify'), oracleRouter)` —
  // `requireScope()` explicitly falls through for an anonymous request
  // ("Anonymous requests are handled by other auth guards" —
  // apiKeyAuth.ts:120), and `apiKeyAuth()` itself is mounted at router.ts:191
  // WITHOUT `{ required: true }`, so a keyless request is explicitly allowed
  // through (apiKeyAuth.ts:175 "Anonymous access allowed"). Unlike its
  // closest sibling ai-verify-search.ts:36-37 (`if (!req.apiKey) { res
  // .status(401)... }`), oracle.ts's handler reads `req.apiKey?.keyId ??
  // null` and proceeds unconditionally — so a fully anonymous POST reaches
  // the DB, gets a complete HMAC-"signed" OracleResult back (indistinguishable
  // from an authenticated agent's signed response), and the audit row records
  // `org_id: undefined` / `agent_key_id: null` — no caller identity at all.
  // -------------------------------------------------------------------------
  describe('POST /api/v1/oracle/verify — authentication', () => {
    it('returns 401 without an API key and never touches the database (anonymous callers must not reach a signed result)', async () => {
      const handler = getOracleHandler();
      const { req, res } = createOracleReqRes({ public_ids: ['ARK-TST-DEG-ABC123'] });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringMatching(/authentication_required|api_key/i) }),
      );
      // The strongest form of this assertion: the handler must short-circuit
      // BEFORE any DB work, not merely also return 401 after querying anyway.
      expect(mockDbFrom).not.toHaveBeenCalled();
    });

    it('still builds a signed result when a valid API key IS present (non-regression)', async () => {
      process.env.API_KEY_HMAC_SECRET = 'test-oracle-hmac-secret';
      mockDbFrom.mockImplementation((table: string) => {
        if (table === 'anchors') {
          return {
            select: () => ({
              in: () => ({
                is: () =>
                  Promise.resolve({
                    data: [
                      {
                        public_id: 'ARK-TST-DEG-ABC123',
                        fingerprint: 'abc123',
                        status: 'SECURED',
                        chain_tx_id: 'txid',
                        chain_block_height: 900000,
                        chain_timestamp: '2026-04-01T00:00:00Z',
                        created_at: '2026-04-01T00:00:00Z',
                        credential_type: 'DEGREE',
                        issued_at: '2026-01-01',
                        expires_at: null,
                        org_id: 'org-456',
                        description: 'Bachelor of Science',
                        directory_info_opt_out: false,
                      },
                    ],
                    error: null,
                  }),
              }),
            }),
          };
        }
        if (table === 'organizations') {
          return { select: () => ({ in: () => Promise.resolve([]) }) };
        }
        throw new Error(`unexpected table in oracle test: ${table}`);
      });

      const handler = getOracleHandler();
      const { req, res } = createOracleReqRes(
        { public_ids: ['ARK-TST-DEG-ABC123'] },
        mockOracleApiKey,
      );

      await handler(req, res);

      expect(res.status).not.toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_key_id: mockOracleApiKey.keyId,
          signature: expect.any(String),
          results: expect.arrayContaining([
            expect.objectContaining({ public_id: 'ARK-TST-DEG-ABC123' }),
          ]),
        }),
      );
      delete process.env.API_KEY_HMAC_SECRET;
    });
  });
});
