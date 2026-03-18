/**
 * Tests for POST /api/v1/verify/batch (P4.5-TS-02)
 */

import { describe, it, expect, vi } from 'vitest';
import { batchRequestSchema, processBatchSync } from './batch.js';
import { type PublicIdLookup, type AnchorByPublicId } from './verify.js';

vi.mock('../../utils/db.js', () => ({
  db: { from: vi.fn() },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function createAnchor(publicId: string, status = 'SECURED'): AnchorByPublicId {
  return {
    public_id: publicId,
    fingerprint: 'a'.repeat(64),
    status,
    chain_tx_id: 'tx_123',
    chain_block_height: 100,
    chain_timestamp: '2026-03-12T00:00:00Z',
    created_at: '2026-03-10T00:00:00Z',
    credential_type: 'DIPLOMA',
    org_name: 'Test University',
    recipient_hash: null,
    issued_at: '2026-01-01T00:00:00Z',
    expires_at: null,
    jurisdiction: null,
    merkle_root: null,
    description: null,
  };
}

describe('batchRequestSchema', () => {
  it('accepts valid batch of public_ids', () => {
    const result = batchRequestSchema.safeParse({
      public_ids: ['ARK-001', 'ARK-002', 'ARK-003'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty array', () => {
    const result = batchRequestSchema.safeParse({ public_ids: [] });
    expect(result.success).toBe(false);
  });

  it('rejects array exceeding 100 items', () => {
    const ids = Array.from({ length: 101 }, (_, i) => `ARK-${i}`);
    const result = batchRequestSchema.safeParse({ public_ids: ids });
    expect(result.success).toBe(false);
  });

  it('rejects items shorter than 3 chars', () => {
    const result = batchRequestSchema.safeParse({ public_ids: ['AB'] });
    expect(result.success).toBe(false);
  });

  it('rejects missing public_ids field', () => {
    const result = batchRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe('processBatchSync', () => {
  it('returns results for all items in batch', async () => {
    const lookup: PublicIdLookup = {
      lookupByPublicId: vi.fn().mockImplementation((id: string) =>
        Promise.resolve(createAnchor(id)),
      ),
    };

    const results = await processBatchSync(['ARK-001', 'ARK-002'], lookup);

    expect(results).toHaveLength(2);
    expect(results[0].public_id).toBe('ARK-001');
    expect(results[0].verified).toBe(true);
    expect(results[1].public_id).toBe('ARK-002');
    expect(results[1].verified).toBe(true);
  });

  it('returns not found for missing anchors', async () => {
    const lookup: PublicIdLookup = {
      lookupByPublicId: vi.fn().mockResolvedValue(null),
    };

    const results = await processBatchSync(['ARK-MISSING'], lookup);

    expect(results).toHaveLength(1);
    expect(results[0].verified).toBe(false);
    expect(results[0].error).toBe('Record not found');
  });

  it('handles mixed found and not-found results', async () => {
    const lookup: PublicIdLookup = {
      lookupByPublicId: vi.fn().mockImplementation((id: string) => {
        if (id === 'ARK-001') return Promise.resolve(createAnchor(id));
        return Promise.resolve(null);
      }),
    };

    const results = await processBatchSync(['ARK-001', 'ARK-MISSING'], lookup);

    expect(results).toHaveLength(2);
    expect(results[0].verified).toBe(true);
    expect(results[1].verified).toBe(false);
    expect(results[1].error).toBe('Record not found');
  });

  it('handles lookup errors gracefully', async () => {
    const lookup: PublicIdLookup = {
      lookupByPublicId: vi.fn().mockRejectedValue(new Error('DB down')),
    };

    const results = await processBatchSync(['ARK-001'], lookup);

    expect(results).toHaveLength(1);
    expect(results[0].verified).toBe(false);
    expect(results[0].error).toBe('Verification failed');
  });

  it('includes frozen schema fields in results', async () => {
    const lookup: PublicIdLookup = {
      lookupByPublicId: vi.fn().mockResolvedValue(createAnchor('ARK-001')),
    };

    const results = await processBatchSync(['ARK-001'], lookup);

    expect(results[0].status).toBe('ACTIVE');
    expect(results[0].issuer_name).toBe('Test University');
    expect(results[0].credential_type).toBe('DIPLOMA');
    expect(results[0].record_uri).toBe('https://app.arkova.io/verify/ARK-001');
  });

  it('handles REVOKED anchors in batch', async () => {
    const lookup: PublicIdLookup = {
      lookupByPublicId: vi.fn().mockResolvedValue(createAnchor('ARK-001', 'REVOKED')),
    };

    const results = await processBatchSync(['ARK-001'], lookup);

    expect(results[0].verified).toBe(false);
    expect(results[0].status).toBe('REVOKED');
  });
});
