/**
 * Tests for `generateAuditProof` org scoping — SECURITY fix (2026-07-28).
 *
 * `generateAuditProof` previously took only `signaturePublicId` with no org
 * scoping, so `GET /api/v1/signatures/:id/audit-proof` (signatureCompliance.ts)
 * could return ANY org's signature audit proof. It now requires `orgId` and
 * scopes the `signatures` query by it (`.eq('org_id', orgId)`), matching
 * `bulkExportSignatures`' scoping. This is the function-level proof that the
 * org id is actually used in the query, complementing the route-level test in
 * `api/v1/signatureCompliance.test.ts` (which mocks this function and checks
 * the route forwards the caller-resolved org).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const eqCalls: Array<[string, unknown]> = [];

vi.mock('../../utils/db.js', () => {
  const builder: Record<string, unknown> = {};
  builder.select = vi.fn(() => builder);
  builder.eq = vi.fn((col: string, val: unknown) => {
    eqCalls.push([col, val]);
    return builder;
  });
  builder.single = vi.fn().mockResolvedValue({
    data: {
      public_id: 'sig-1',
      org_id: 'org-A',
      document_fingerprint: 'fp',
      format: 'PAdES',
      level: 'B-B',
      status: 'valid',
      signer_name: 'Jane',
      signer_org: 'Org A',
      signature_algorithm: 'RSA',
      signed_at: '2026-01-01T00:00:00Z',
      jurisdiction: null,
      anchor_id: null,
      timestamp_token_id: null,
      ltv_data_embedded: false,
      archive_timestamp_id: null,
      signature_value: 'sig-bytes',
      signing_certificates: null,
    },
    error: null,
  });
  return { db: { from: vi.fn(() => builder) } };
});

import { generateAuditProof } from './auditProofExporter.js';
import { db } from '../../utils/db.js';

describe('generateAuditProof — org scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eqCalls.length = 0;
  });

  it('scopes the signatures query by BOTH public_id and org_id', async () => {
    await generateAuditProof('sig-1', 'org-A');
    expect(db.from).toHaveBeenCalledWith('signatures');
    expect(eqCalls).toContainEqual(['public_id', 'sig-1']);
    expect(eqCalls).toContainEqual(['org_id', 'org-A']);
  });

  it('returns null (never the proof) when the query finds no row for that org — no cross-org existence leak', async () => {
    const fromMock = db.from as unknown as ReturnType<typeof vi.fn>;
    fromMock.mockReturnValueOnce({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: { message: 'no rows' } }),
    });
    const result = await generateAuditProof('sig-1', 'org-B');
    expect(result).toBeNull();
  });

  it('returns the proof when the signature belongs to the requested org', async () => {
    const result = await generateAuditProof('sig-1', 'org-A');
    expect(result).not.toBeNull();
    expect(result?.signature?.public_id).toBe('sig-1');
  });
});
