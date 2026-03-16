/**
 * Tests for /api/verify-anchor endpoint.
 *
 * End-to-end test: dummy PDF → SHA-256 hash → mock Bitcoin receipt → verification match.
 *
 * Constitution 1.6: Documents never leave the user's device.
 * This endpoint accepts a HASH (not a file). Client-side code hashes
 * the document in-browser and sends only the 64-char hex fingerprint.
 */

import { describe, it, expect, vi } from 'vitest';
import { verifyAnchorByFingerprint } from './verify-anchor.js';
import { createHash } from 'crypto';

// Simulate the client-side flow: hash a dummy PDF, then verify server-side
function hashDummyPdf(): string {
  // Simulate a PDF file's raw bytes
  const pdfContent = Buffer.from('%PDF-1.4 dummy content for testing anchor verification');
  return createHash('sha256').update(pdfContent).digest('hex');
}

describe('verifyAnchorByFingerprint', () => {
  const dummyFingerprint = hashDummyPdf();

  it('returns verified=true when fingerprint matches a SECURED anchor', async () => {
    const mockDb = {
      lookupByFingerprint: vi.fn().mockResolvedValue({
        fingerprint: dummyFingerprint,
        status: 'SECURED',
        chain_tx_id: 'b8e381df09ca404eaae2e5e9d9b3d27567fe97ece39ead718f6d2c77ca60eb57',
        chain_block_height: 204567,
        chain_block_timestamp: '2026-03-12T10:30:00Z',
        public_id: 'ARK-2026-TEST-001',
        created_at: '2026-03-10T08:00:00Z',
      }),
    };

    const result = await verifyAnchorByFingerprint(dummyFingerprint, mockDb);

    expect(result.verified).toBe(true);
    expect(result.status).toBe('ACTIVE');
    expect(result.network_receipt_id).toBe('b8e381df09ca404eaae2e5e9d9b3d27567fe97ece39ead718f6d2c77ca60eb57');
    expect(result.record_uri).toContain('ARK-2026-TEST-001');
    expect(result.anchor_timestamp).toBeDefined();
  });

  it('returns verified=false when fingerprint is not found', async () => {
    const mockDb = {
      lookupByFingerprint: vi.fn().mockResolvedValue(null),
    };

    const result = await verifyAnchorByFingerprint('0'.repeat(64), mockDb);

    expect(result.verified).toBe(false);
    expect(result.status).toBeUndefined();
    expect(result.network_receipt_id).toBeUndefined();
  });

  it('returns verified=false for PENDING anchors (not yet on-chain)', async () => {
    const mockDb = {
      lookupByFingerprint: vi.fn().mockResolvedValue({
        fingerprint: dummyFingerprint,
        status: 'PENDING',
        chain_tx_id: null,
        chain_block_height: null,
        chain_block_timestamp: null,
        public_id: 'ARK-2026-TEST-002',
        created_at: '2026-03-10T08:00:00Z',
      }),
    };

    const result = await verifyAnchorByFingerprint(dummyFingerprint, mockDb);

    expect(result.verified).toBe(false);
    expect(result.status).toBe('PENDING');
    expect(result.network_receipt_id).toBeUndefined();
  });

  it('returns verified=false for REVOKED anchors', async () => {
    const mockDb = {
      lookupByFingerprint: vi.fn().mockResolvedValue({
        fingerprint: dummyFingerprint,
        status: 'REVOKED',
        chain_tx_id: 'abc123',
        chain_block_height: 204567,
        chain_block_timestamp: '2026-03-12T10:30:00Z',
        public_id: 'ARK-2026-TEST-003',
        created_at: '2026-03-10T08:00:00Z',
      }),
    };

    const result = await verifyAnchorByFingerprint(dummyFingerprint, mockDb);

    expect(result.verified).toBe(false);
    expect(result.status).toBe('REVOKED');
    // Still returns receipt even for revoked (it was once anchored)
    expect(result.network_receipt_id).toBe('abc123');
  });

  it('rejects invalid fingerprint format', async () => {
    const mockDb = {
      lookupByFingerprint: vi.fn(),
    };

    const result = await verifyAnchorByFingerprint('not-a-valid-hash', mockDb);

    expect(result.verified).toBe(false);
    expect(result.error).toContain('Invalid fingerprint');
    // Should NOT call the DB for invalid input
    expect(mockDb.lookupByFingerprint).not.toHaveBeenCalled();
  });

  it('rejects empty fingerprint', async () => {
    const mockDb = {
      lookupByFingerprint: vi.fn(),
    };

    const result = await verifyAnchorByFingerprint('', mockDb);

    expect(result.verified).toBe(false);
    expect(result.error).toBeDefined();
    expect(mockDb.lookupByFingerprint).not.toHaveBeenCalled();
  });

  it('omits jurisdiction when null (frozen schema compliance)', async () => {
    const mockDb = {
      lookupByFingerprint: vi.fn().mockResolvedValue({
        fingerprint: dummyFingerprint,
        status: 'SECURED',
        chain_tx_id: 'tx123',
        chain_block_height: 100,
        chain_block_timestamp: '2026-01-01T00:00:00Z',
        public_id: 'ARK-001',
        created_at: '2026-01-01T00:00:00Z',
        jurisdiction: null,
      }),
    };

    const result = await verifyAnchorByFingerprint(dummyFingerprint, mockDb);

    expect(result.verified).toBe(true);
    expect(result).not.toHaveProperty('jurisdiction');
  });

  it('includes jurisdiction when present', async () => {
    const mockDb = {
      lookupByFingerprint: vi.fn().mockResolvedValue({
        fingerprint: dummyFingerprint,
        status: 'SECURED',
        chain_tx_id: 'tx123',
        chain_block_height: 100,
        chain_block_timestamp: '2026-01-01T00:00:00Z',
        public_id: 'ARK-001',
        created_at: '2026-01-01T00:00:00Z',
        jurisdiction: 'US-MI',
      }),
    };

    const result = await verifyAnchorByFingerprint(dummyFingerprint, mockDb);

    expect(result.verified).toBe(true);
    expect(result.jurisdiction).toBe('US-MI');
  });
});

describe('End-to-end: dummy PDF → hash → anchor → verify', () => {
  it('full cycle: hash PDF client-side, mock anchor, verify by hash', async () => {
    // Step 1: Client hashes a dummy PDF (simulated)
    const pdfBytes = Buffer.from('%PDF-1.4 Official Degree Certificate - University of Michigan');
    const clientHash = createHash('sha256').update(pdfBytes).digest('hex');
    expect(clientHash).toMatch(/^[a-f0-9]{64}$/);

    // Step 2: Anchor is created with this fingerprint and processed
    const mockBitcoinReceipt = {
      fingerprint: clientHash,
      status: 'SECURED',
      chain_tx_id: 'b8e381df09ca404eaae2e5e9d9b3d27567fe97ece39ead718f6d2c77ca60eb57',
      chain_block_height: 204567,
      chain_block_timestamp: '2026-03-12T10:30:00Z',
      public_id: 'ARK-2026-E2E-001',
      created_at: '2026-03-10T08:00:00Z',
    };

    // Step 3: User re-hashes the same PDF and submits hash for verification
    const verificationHash = createHash('sha256').update(pdfBytes).digest('hex');
    expect(verificationHash).toBe(clientHash); // Same file = same hash

    // Step 4: Server looks up the hash and confirms it matches
    const mockDb = {
      lookupByFingerprint: vi.fn().mockResolvedValue(mockBitcoinReceipt),
    };

    const result = await verifyAnchorByFingerprint(verificationHash, mockDb);

    // Step 5: Verification succeeds
    expect(result.verified).toBe(true);
    expect(result.status).toBe('ACTIVE');
    expect(result.network_receipt_id).toBe(mockBitcoinReceipt.chain_tx_id);
    expect(result.record_uri).toBe('https://app.arkova.io/verify/ARK-2026-E2E-001');
  });

  it('modified document fails verification', async () => {
    // Original PDF
    const originalPdf = Buffer.from('%PDF-1.4 Official Degree Certificate');
    const originalHash = createHash('sha256').update(originalPdf).digest('hex');

    // Tampered PDF (single byte change)
    const tamperedPdf = Buffer.from('%PDF-1.4 Official Degree Certificat3'); // last char changed
    const tamperedHash = createHash('sha256').update(tamperedPdf).digest('hex');

    expect(tamperedHash).not.toBe(originalHash);

    // Only original is anchored
    const mockDb = {
      lookupByFingerprint: vi.fn().mockImplementation(async (fp: string) => {
        if (fp === originalHash) {
          return { fingerprint: originalHash, status: 'SECURED', chain_tx_id: 'tx1', chain_block_height: 1, chain_block_timestamp: '2026-01-01T00:00:00Z', public_id: 'ARK-001', created_at: '2026-01-01T00:00:00Z' };
        }
        return null;
      }),
    };

    // Tampered hash → not found
    const result = await verifyAnchorByFingerprint(tamperedHash, mockDb);
    expect(result.verified).toBe(false);
  });
});
