/**
 * Tests for Key Inventory Endpoint (COMP-05)
 *
 * GET /api/v1/signatures/key-inventory
 * Returns masked key metadata for audit purposes.
 * Constitution 1.4: Never returns raw key material, ARNs, or resource paths.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { buildKeyInventory, keyInventoryRouter } from './key-inventory.js';

vi.mock('../../utils/db.js', () => ({
  db: {
    from: vi.fn(),
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../_org-auth.js', () => ({
  getCallerOrgId: vi.fn(),
  isCallerOrgAdmin: vi.fn(),
}));

import { db } from '../../utils/db.js';
import { getCallerOrgId, isCallerOrgAdmin } from '../_org-auth.js';

function buildApp(userId?: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (userId) req.authUserId = userId;
    next();
  });
  app.use('/api/v1', keyInventoryRouter);
  return app;
}

describe('Key Inventory (COMP-05)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('buildKeyInventory', () => {
    it('returns inventory entries with masked key IDs', () => {
      const inventory = buildKeyInventory({
        kmsProvider: 'gcp',
        bitcoinNetwork: 'mainnet',
      });

      expect(inventory.length).toBeGreaterThan(0);
      for (const entry of inventory) {
        // Must never contain full key ARN or resource path
        expect(entry.keyId).not.toContain('arn:aws');
        expect(entry.keyId).not.toContain('projects/');
        expect(entry.keyId).toContain('***');
      }
    });

    it('includes required fields for each entry', () => {
      const inventory = buildKeyInventory({
        kmsProvider: 'gcp',
        bitcoinNetwork: 'mainnet',
      });

      for (const entry of inventory) {
        expect(entry).toHaveProperty('keyId');
        expect(entry).toHaveProperty('algorithm');
        expect(entry).toHaveProperty('purpose');
        expect(entry).toHaveProperty('status');
        expect(entry).toHaveProperty('provider');
      }
    });

    it('shows bitcoin signing key for mainnet', () => {
      const inventory = buildKeyInventory({
        kmsProvider: 'gcp',
        bitcoinNetwork: 'mainnet',
      });

      const btcKey = inventory.find(e => e.purpose === 'Bitcoin transaction signing');
      expect(btcKey).toBeDefined();
      expect(btcKey!.status).toBe('active');
      expect(btcKey!.provider).toBe('GCP Cloud KMS');
    });

    it('shows bitcoin signing key for AWS provider', () => {
      const inventory = buildKeyInventory({
        kmsProvider: 'aws',
        bitcoinNetwork: 'mainnet',
      });

      const btcKey = inventory.find(e => e.purpose === 'Bitcoin transaction signing');
      expect(btcKey).toBeDefined();
      expect(btcKey!.provider).toBe('AWS KMS');
    });

    it('shows WIF key for non-mainnet networks', () => {
      const inventory = buildKeyInventory({
        kmsProvider: undefined,
        bitcoinNetwork: 'signet',
      });

      const btcKey = inventory.find(e => e.purpose === 'Bitcoin transaction signing');
      expect(btcKey).toBeDefined();
      expect(btcKey!.provider).toBe('Environment variable (WIF)');
      expect(btcKey!.status).toBe('active');
    });

    it('includes API key HMAC signing key', () => {
      const inventory = buildKeyInventory({
        kmsProvider: 'gcp',
        bitcoinNetwork: 'mainnet',
      });

      const hmacKey = inventory.find(e => e.purpose === 'API key HMAC signing');
      expect(hmacKey).toBeDefined();
      expect(hmacKey!.algorithm).toBe('HMAC-SHA256');
    });

    it('never exposes raw key material', () => {
      const inventory = buildKeyInventory({
        kmsProvider: 'gcp',
        bitcoinNetwork: 'mainnet',
      });

      const serialized = JSON.stringify(inventory);
      // Must not contain anything resembling a real key
      expect(serialized).not.toMatch(/-----BEGIN/);
      expect(serialized).not.toMatch(/[A-Za-z0-9+/]{40,}/);
    });
  });

  describe('GET /api/v1/signatures/key-inventory — owner-inclusive org gate', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('requires authentication', async () => {
      const app = buildApp();
      await request(app).get('/api/v1/signatures/key-inventory').expect(401);
    });

    it('allows an org OWNER (resolved via profiles.org_id, no org_members row)', async () => {
      vi.mocked(getCallerOrgId).mockResolvedValue('org-1');
      vi.mocked(isCallerOrgAdmin).mockResolvedValue(true);

      // Fire-and-forget audit insert after the gate passes.
      vi.mocked(db.from).mockImplementation((table: string) => {
        if (table === 'audit_events') {
          return { insert: () => Promise.resolve({ data: null, error: null }) } as never;
        }
        return { select: () => ({}) } as never;
      });

      const app = buildApp('owner-1');
      const res = await request(app).get('/api/v1/signatures/key-inventory');

      expect(res.status).not.toBe(403);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('keys');
      expect(res.body.key_count).toBeGreaterThan(0);
      expect(getCallerOrgId).toHaveBeenCalledWith('owner-1');
      expect(isCallerOrgAdmin).toHaveBeenCalledWith('owner-1', 'org-1');
    });

    it('returns 403 when caller has no org (getCallerOrgId → null)', async () => {
      vi.mocked(getCallerOrgId).mockResolvedValue(null);
      vi.mocked(isCallerOrgAdmin).mockResolvedValue(false);

      const app = buildApp('user-1');
      const res = await request(app).get('/api/v1/signatures/key-inventory').expect(403);
      expect(res.body.error).toBe('Organization administrator role required');
    });

    it('returns 403 when caller is a non-admin member (isCallerOrgAdmin → false)', async () => {
      vi.mocked(getCallerOrgId).mockResolvedValue('org-1');
      vi.mocked(isCallerOrgAdmin).mockResolvedValue(false);

      const app = buildApp('member-1');
      const res = await request(app).get('/api/v1/signatures/key-inventory').expect(403);
      expect(res.body.error).toBe('Organization administrator role required');
    });
  });
});
