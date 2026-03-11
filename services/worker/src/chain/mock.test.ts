/**
 * Unit tests for MockChainClient
 *
 * HARDENING-2: Verify MockChainClient exercises the ChainClient interface
 * contract. When the real bitcoinjs-lib client is implemented, it must
 * pass these same behavioral expectations.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../config.js', () => ({
  config: {
    chainNetwork: 'testnet' as const,
    nodeEnv: 'test',
    useMocks: true,
    logLevel: 'info',
  },
  getNetworkDisplayName: vi.fn(() => 'Test Environment'),
}));

import { MockChainClient } from './mock.js';
import type { ChainClient, SubmitFingerprintRequest } from './types.js';

describe('MockChainClient', () => {
  let client: MockChainClient;

  beforeEach(() => {
    // Fresh instance each test to avoid cross-test state via the in-memory maps
    client = new MockChainClient();
  });

  // ---- Interface compliance ----

  describe('interface compliance', () => {
    it('implements ChainClient interface', () => {
      // TypeScript compile-time check: assignment to ChainClient must work
      const chainClient: ChainClient = client;
      expect(chainClient).toBeDefined();
      expect(typeof chainClient.submitFingerprint).toBe('function');
      expect(typeof chainClient.verifyFingerprint).toBe('function');
      expect(typeof chainClient.getReceipt).toBe('function');
      expect(typeof chainClient.healthCheck).toBe('function');
    });
  });

  // ---- submitFingerprint ----

  describe('submitFingerprint', () => {
    const request: SubmitFingerprintRequest = {
      fingerprint: 'sha256-test-fingerprint-001',
      timestamp: '2026-01-01T00:00:00Z',
    };

    it('returns a ChainReceipt with all required fields', async () => {
      const receipt = await client.submitFingerprint(request);

      expect(receipt).toHaveProperty('receiptId');
      expect(receipt).toHaveProperty('blockHeight');
      expect(receipt).toHaveProperty('blockTimestamp');
      expect(receipt).toHaveProperty('confirmations');
    });

    it('returns a string receiptId', async () => {
      const receipt = await client.submitFingerprint(request);
      expect(typeof receipt.receiptId).toBe('string');
      expect(receipt.receiptId.length).toBeGreaterThan(0);
    });

    it('returns a numeric blockHeight', async () => {
      const receipt = await client.submitFingerprint(request);
      expect(typeof receipt.blockHeight).toBe('number');
      expect(receipt.blockHeight).toBeGreaterThan(0);
    });

    it('returns a valid ISO timestamp for blockTimestamp', async () => {
      const receipt = await client.submitFingerprint(request);
      const parsed = new Date(receipt.blockTimestamp);
      expect(parsed.toISOString()).toBe(receipt.blockTimestamp);
    });

    it('returns a non-negative confirmations count', async () => {
      const receipt = await client.submitFingerprint(request);
      expect(receipt.confirmations).toBeGreaterThanOrEqual(0);
    });

    it('generates unique receiptIds for different submissions', async () => {
      const receipt1 = await client.submitFingerprint(request);
      const receipt2 = await client.submitFingerprint({
        fingerprint: 'sha256-different-fingerprint',
        timestamp: '2026-01-02T00:00:00Z',
      });

      expect(receipt1.receiptId).not.toBe(receipt2.receiptId);
    });

    it('increments blockHeight across submissions', async () => {
      const receipt1 = await client.submitFingerprint(request);
      const receipt2 = await client.submitFingerprint({
        fingerprint: 'sha256-another',
        timestamp: '2026-01-02T00:00:00Z',
      });

      expect(receipt2.blockHeight).toBeGreaterThan(receipt1.blockHeight);
    });

    it('accepts optional metadata without error', async () => {
      const requestWithMeta: SubmitFingerprintRequest = {
        fingerprint: 'sha256-with-meta',
        timestamp: '2026-01-01T00:00:00Z',
        metadata: { source: 'test', version: '1' },
      };

      const receipt = await client.submitFingerprint(requestWithMeta);
      expect(receipt.receiptId).toBeDefined();
    });
  });

  // ---- verifyFingerprint ----

  describe('verifyFingerprint', () => {
    it('returns verified=false for an unknown fingerprint', async () => {
      const result = await client.verifyFingerprint('sha256-never-submitted');

      expect(result.verified).toBe(false);
      expect(result.error).toBeDefined();
      expect(typeof result.error).toBe('string');
    });

    it('returns verified=true for a previously submitted fingerprint', async () => {
      const fingerprint = 'sha256-verify-roundtrip';
      await client.submitFingerprint({
        fingerprint,
        timestamp: '2026-01-01T00:00:00Z',
      });

      const result = await client.verifyFingerprint(fingerprint);

      expect(result.verified).toBe(true);
      expect(result.receipt).toBeDefined();
    });

    it('returns the matching receipt for a verified fingerprint', async () => {
      const fingerprint = 'sha256-receipt-match';
      const submitted = await client.submitFingerprint({
        fingerprint,
        timestamp: '2026-01-01T00:00:00Z',
      });

      const result = await client.verifyFingerprint(fingerprint);

      expect(result.receipt?.receiptId).toBe(submitted.receiptId);
      expect(result.receipt?.blockHeight).toBe(submitted.blockHeight);
    });

    it('does not include error field when verification succeeds', async () => {
      const fingerprint = 'sha256-no-error';
      await client.submitFingerprint({
        fingerprint,
        timestamp: '2026-01-01T00:00:00Z',
      });

      const result = await client.verifyFingerprint(fingerprint);

      expect(result.error).toBeUndefined();
    });
  });

  // ---- getReceipt ----

  describe('getReceipt', () => {
    it('returns null for an unknown receiptId', async () => {
      const result = await client.getReceipt('nonexistent_receipt');
      expect(result).toBeNull();
    });

    it('returns the receipt for a known receiptId', async () => {
      const submitted = await client.submitFingerprint({
        fingerprint: 'sha256-get-receipt',
        timestamp: '2026-01-01T00:00:00Z',
      });

      const result = await client.getReceipt(submitted.receiptId);

      expect(result).not.toBeNull();
      expect(result?.receiptId).toBe(submitted.receiptId);
      expect(result?.blockHeight).toBe(submitted.blockHeight);
      expect(result?.blockTimestamp).toBe(submitted.blockTimestamp);
      expect(result?.confirmations).toBe(submitted.confirmations);
    });
  });

  // ---- healthCheck ----

  describe('healthCheck', () => {
    it('returns true', async () => {
      const result = await client.healthCheck();
      expect(result).toBe(true);
    });

    it('returns a boolean', async () => {
      const result = await client.healthCheck();
      expect(typeof result).toBe('boolean');
    });
  });

  // ---- Cross-method consistency ----

  describe('cross-method consistency', () => {
    it('submit → verify → getReceipt all agree on the same receipt', async () => {
      const fingerprint = 'sha256-consistency-check';
      const submitted = await client.submitFingerprint({
        fingerprint,
        timestamp: '2026-01-01T00:00:00Z',
      });

      const verified = await client.verifyFingerprint(fingerprint);
      const fetched = await client.getReceipt(submitted.receiptId);

      // All three should reference the same receipt
      expect(verified.receipt?.receiptId).toBe(submitted.receiptId);
      expect(fetched?.receiptId).toBe(submitted.receiptId);
      expect(fetched?.blockHeight).toBe(submitted.blockHeight);
    });
  });
});
