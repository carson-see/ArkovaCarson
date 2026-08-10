/**
 * DPA CONTRACT TEST — no raw caller IP may reach a persisted audit payload.
 *
 * Arkova's DPA Schedules 1 and 2 both warrant that IP addresses are processed
 * in HASHED form. Two `audit_events` writers contradicted that warranty by
 * serialising `req.ip` verbatim into `details.querying_ip`:
 *
 *   - services/worker/src/api/v1/verify.ts        (VERIFICATION_QUERIED)
 *   - services/worker/src/api/v1/credentials-ctdl.ts (ctdl.requested)
 *
 * Both are ANONYMOUS public endpoints, so the IP-derived value is the only
 * actor identifier available for abuse/enumeration investigation — hence a
 * keyed digest rather than a drop. These tests are the contract: the assertion
 * that matters is `JSON.stringify(details)` never containing the address, so a
 * future field rename cannot quietly reintroduce the leak.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createHash, createHmac } from 'node:crypto';

const TEST_PEPPER = 'test-ip-pepper-0123456789abcdef';
const CALLER_IPV4 = '203.0.113.42';
const CALLER_IPV6 = '2001:db8::dead:beef';

const { mockAuditInsert, mockGetCached, mockSetCached } = vi.hoisted(() => ({
  mockAuditInsert: vi.fn(),
  mockGetCached: vi.fn(),
  mockSetCached: vi.fn(),
}));

vi.mock('../../utils/db.js', () => ({
  db: { from: vi.fn(() => ({ insert: mockAuditInsert })) },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config.js', () => ({
  config: {
    bitcoinNetwork: 'signet',
    frontendUrl: 'https://app.arkova.ai',
    get ipHashPepper() {
      return process.env.__TEST_IP_PEPPER;
    },
  },
}));

vi.mock('../../utils/verifyCache.js', () => ({
  getCachedVerification: mockGetCached,
  setCachedVerification: mockSetCached,
}));

import { verifyRouter, type AnchorByPublicId, type PublicIdLookup } from './verify.js';
import { buildTestAnchor } from './__test-helpers__/build-anchor.js';
import { buildCredentialsCtdlRouter, type CredentialsCtdlLookup } from './credentials-ctdl.js';
import type { CtdlAnchor } from '../../ctdl/ctdl-serializer.js';

function buildVerifyApp(): express.Express {
  const app = express();
  // `trust proxy` makes `req.ip` resolve from X-Forwarded-For, which is how the
  // worker sees caller IPs behind Cloud Run / Cloudflare in production.
  app.set('trust proxy', true);
  const anchor = buildTestAnchor({ public_id: 'ARK-2026-VRF-001', status: 'SECURED' });
  const lookup: PublicIdLookup = { async lookupByPublicId() { return anchor as AnchorByPublicId; } };
  app.use((req, _res, next) => {
    (req as unknown as { _testLookup: PublicIdLookup })._testLookup = lookup;
    next();
  });
  app.use('/api/v1/verify', verifyRouter);
  return app;
}

function ctdlAnchor(): CtdlAnchor {
  return {
    publicId: 'ARK-2026-CTDL-001',
    status: 'SECURED',
    credentialType: 'DEGREE',
    subType: 'bachelor',
    label: 'Bachelor of Science',
    description: 'Public credential description',
    metadata: {},
    createdAt: '2026-05-20T12:00:00.000Z',
    chainTimestamp: '2026-05-20T12:10:00.000Z',
    issuedAt: '2026-05-01T00:00:00.000Z',
    expiresAt: null,
    revokedAt: null,
    revocationReason: null,
    issuer: { name: 'Arkova University', publicId: 'ORG-ARKOVA-U', websiteUrl: 'https://example.edu' },
  };
}

function buildCtdlApp(): express.Express {
  const app = express();
  app.set('trust proxy', true);
  const lookup: CredentialsCtdlLookup = {
    lookupByPublicId: vi.fn().mockResolvedValue(ctdlAnchor()),
  };
  app.use('/', buildCredentialsCtdlRouter(lookup));
  return app;
}

/** Drain the fire-and-forget audit promise chain. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function auditDetails(eventType: string): Record<string, unknown> {
  const rows = mockAuditInsert.mock.calls.map((c: unknown[]) => c[0]) as Array<Record<string, unknown>>;
  const row = rows.find((r) => r?.event_type === eventType);
  expect(row, `no ${eventType} audit row was written`).toBeDefined();
  return JSON.parse(row!.details as string) as Record<string, unknown>;
}

describe('audit_events must never persist a raw caller IP (DPA Schedules 1 + 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuditInsert.mockResolvedValue({ error: null });
    mockGetCached.mockResolvedValue(null);
    mockSetCached.mockResolvedValue(undefined);
    process.env.__TEST_IP_PEPPER = TEST_PEPPER;
  });

  describe('GET /api/v1/verify/:publicId — VERIFICATION_QUERIED', () => {
    it('does not serialise the raw IPv4 anywhere in the audit payload', async () => {
      await request(buildVerifyApp())
        .get('/api/v1/verify/ARK-2026-VRF-001')
        .set('X-Forwarded-For', CALLER_IPV4);
      await flush();

      const details = auditDetails('VERIFICATION_QUERIED');
      expect(JSON.stringify(details)).not.toContain(CALLER_IPV4);
      expect(details).not.toHaveProperty('querying_ip');
    });

    it('does not serialise the raw IPv6 anywhere in the audit payload', async () => {
      await request(buildVerifyApp())
        .get('/api/v1/verify/ARK-2026-VRF-001')
        .set('X-Forwarded-For', CALLER_IPV6);
      await flush();

      expect(JSON.stringify(auditDetails('VERIFICATION_QUERIED'))).not.toContain(CALLER_IPV6);
    });

    it('records a KEYED digest, not the bare sha256 an attacker precomputes', async () => {
      await request(buildVerifyApp())
        .get('/api/v1/verify/ARK-2026-VRF-001')
        .set('X-Forwarded-For', CALLER_IPV4);
      await flush();

      const details = auditDetails('VERIFICATION_QUERIED');
      expect(details.querying_ip_hash).toBe(
        createHmac('sha256', TEST_PEPPER).update(CALLER_IPV4, 'utf8').digest('hex'),
      );
      expect(details.querying_ip_hash).not.toBe(
        createHash('sha256').update(CALLER_IPV4, 'utf8').digest('hex'),
      );
    });

    it('writes null — never the raw IP — when the pepper is unavailable', async () => {
      delete process.env.__TEST_IP_PEPPER;

      await request(buildVerifyApp())
        .get('/api/v1/verify/ARK-2026-VRF-001')
        .set('X-Forwarded-For', CALLER_IPV4);
      await flush();

      const details = auditDetails('VERIFICATION_QUERIED');
      expect(details.querying_ip_hash).toBeNull();
      expect(JSON.stringify(details)).not.toContain(CALLER_IPV4);
    });
  });

  describe('GET /credentials/:publicId/ctdl — ctdl.requested', () => {
    it('does not serialise the raw IPv4 anywhere in the audit payload', async () => {
      await request(buildCtdlApp())
        .get('/ARK-2026-CTDL-001/ctdl')
        .set('X-Forwarded-For', CALLER_IPV4);
      await flush();

      const details = auditDetails('ctdl.requested');
      expect(JSON.stringify(details)).not.toContain(CALLER_IPV4);
      expect(details).not.toHaveProperty('querying_ip');
    });

    it('records a KEYED digest, not the bare sha256 an attacker precomputes', async () => {
      await request(buildCtdlApp())
        .get('/ARK-2026-CTDL-001/ctdl')
        .set('X-Forwarded-For', CALLER_IPV4);
      await flush();

      const details = auditDetails('ctdl.requested');
      expect(details.querying_ip_hash).toBe(
        createHmac('sha256', TEST_PEPPER).update(CALLER_IPV4, 'utf8').digest('hex'),
      );
      expect(details.querying_ip_hash).not.toBe(
        createHash('sha256').update(CALLER_IPV4, 'utf8').digest('hex'),
      );
    });

    it('writes null — never the raw IP — when the pepper is unavailable', async () => {
      delete process.env.__TEST_IP_PEPPER;

      await request(buildCtdlApp())
        .get('/ARK-2026-CTDL-001/ctdl')
        .set('X-Forwarded-For', CALLER_IPV4);
      await flush();

      const details = auditDetails('ctdl.requested');
      expect(details.querying_ip_hash).toBeNull();
      expect(JSON.stringify(details)).not.toContain(CALLER_IPV4);
    });
  });

  it('the two public audit writers agree on the field name', async () => {
    await request(buildVerifyApp())
      .get('/api/v1/verify/ARK-2026-VRF-001')
      .set('X-Forwarded-For', CALLER_IPV4);
    await flush();
    const verifyDetails = auditDetails('VERIFICATION_QUERIED');

    vi.clearAllMocks();
    mockAuditInsert.mockResolvedValue({ error: null });
    mockGetCached.mockResolvedValue(null);

    await request(buildCtdlApp())
      .get('/ARK-2026-CTDL-001/ctdl')
      .set('X-Forwarded-For', CALLER_IPV4);
    await flush();
    const ctdlDetails = auditDetails('ctdl.requested');

    expect(verifyDetails.querying_ip_hash).toBe(ctdlDetails.querying_ip_hash);
  });
});
