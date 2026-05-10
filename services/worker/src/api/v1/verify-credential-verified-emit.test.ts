/**
 * Tests for the credential.verified webhook emit on
 * GET /api/v1/verify/:publicId (SCRUM-1799 / SCRUM-1743 Phase 2b).
 *
 * Covers:
 *   - Default OFF: emit suppressed unless ENABLE_CREDENTIAL_VERIFIED_WEBHOOK=true
 *   - Cache MISS path emits when flag on + terminal status resolved
 *   - Cache HIT path skips emit (sampling-by-cache TTL)
 *   - Status mapping: SECURED, ACTIVE → 'SECURED'; REVOKED → 'REVOKED'; EXPIRED → 'EXPIRED'
 *   - Non-terminal statuses (PENDING, SUBMITTED) skip emit
 *   - Anchors without org_id or public_id skip emit (orphan / pre-publish)
 *   - Best-effort: dispatch failure does NOT 500 the response
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockDispatchWebhookEvent, mockGetCached, mockSetCached } = vi.hoisted(() => ({
  mockDispatchWebhookEvent: vi.fn(),
  mockGetCached: vi.fn(),
  mockSetCached: vi.fn(),
}));

const { mockAuditInsert } = vi.hoisted(() => ({
  mockAuditInsert: vi.fn().mockResolvedValue({ error: null }),
}));

vi.mock('../../utils/db.js', () => ({
  db: {
    from: vi.fn(() => ({
      insert: mockAuditInsert,
    })),
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config.js', () => ({
  // SCRUM-1258 baseline compliance: production code reads
  // config.enableCredentialVerifiedWebhook (not process.env directly). This
  // getter forwards to process.env so existing tests that toggle the env var
  // continue to drive the gate. CI's ad-hoc-env scan stays clean.
  config: {
    bitcoinNetwork: 'signet',
    frontendUrl: 'https://app.arkova.ai',
    get enableCredentialVerifiedWebhook() {
      return process.env.ENABLE_CREDENTIAL_VERIFIED_WEBHOOK === 'true';
    },
  },
}));

vi.mock('../../utils/verifyCache.js', () => ({
  getCachedVerification: mockGetCached,
  setCachedVerification: mockSetCached,
}));

vi.mock('../../webhooks/delivery.js', () => ({
  dispatchWebhookEvent: mockDispatchWebhookEvent,
}));

import { verifyRouter, type AnchorByPublicId, type PublicIdLookup } from './verify.js';

function buildAnchor(overrides: Partial<AnchorByPublicId> = {}): AnchorByPublicId {
  return {
    public_id: 'ARK-2026-VRF-001',
    fingerprint: 'a'.repeat(64),
    status: 'SECURED',
    org_id: 'org-1',
    chain_tx_id: 'tx-abc',
    chain_block_height: 200100,
    chain_timestamp: '2026-04-01T00:00:00Z',
    created_at: '2026-03-30T00:00:00Z',
    credential_type: 'DEGREE',
    org_name: 'Test University',
    recipient_hash: null,
    issued_at: '2026-01-01T00:00:00Z',
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
    ...overrides,
  };
}

function buildApp(anchor: AnchorByPublicId | null) {
  const app = express();
  app.use(express.json());
  const lookup: PublicIdLookup = {
    async lookupByPublicId() {
      return anchor;
    },
  };
  app.use((req, _res, next) => {
    (req as unknown as { _testLookup: PublicIdLookup })._testLookup = lookup;
    next();
  });
  app.use('/api/v1/verify', verifyRouter);
  return app;
}

describe('GET /api/v1/verify/:publicId — credential.verified emit', () => {
  const ORIGINAL_FLAG = process.env.ENABLE_CREDENTIAL_VERIFIED_WEBHOOK;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCached.mockResolvedValue(null); // default: cache miss
    mockSetCached.mockResolvedValue(undefined);
    mockDispatchWebhookEvent.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) {
      delete process.env.ENABLE_CREDENTIAL_VERIFIED_WEBHOOK;
    } else {
      process.env.ENABLE_CREDENTIAL_VERIFIED_WEBHOOK = ORIGINAL_FLAG;
    }
  });

  it('does NOT dispatch credential.verified when flag is unset (default OFF)', async () => {
    delete process.env.ENABLE_CREDENTIAL_VERIFIED_WEBHOOK;

    const app = buildApp(buildAnchor({ status: 'SECURED' }));
    const res = await request(app).get('/api/v1/verify/ARK-2026-VRF-001');

    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    expect(mockDispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it('does NOT dispatch credential.verified when flag is "false"', async () => {
    process.env.ENABLE_CREDENTIAL_VERIFIED_WEBHOOK = 'false';

    const app = buildApp(buildAnchor({ status: 'SECURED' }));
    const res = await request(app).get('/api/v1/verify/ARK-2026-VRF-001');

    expect(res.status).toBe(200);
    expect(mockDispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it('dispatches credential.verified on cache MISS when flag is "true" and status SECURED', async () => {
    process.env.ENABLE_CREDENTIAL_VERIFIED_WEBHOOK = 'true';

    const app = buildApp(buildAnchor({ status: 'SECURED', credential_type: 'DEGREE' }));
    const res = await request(app).get('/api/v1/verify/ARK-2026-VRF-001');

    expect(res.status).toBe(200);
    expect(mockDispatchWebhookEvent).toHaveBeenCalledTimes(1);
    expect(mockDispatchWebhookEvent).toHaveBeenCalledWith(
      'org-1',
      'credential.verified',
      'ARK-2026-VRF-001',
      expect.objectContaining({
        public_id: 'ARK-2026-VRF-001',
        credential_type: 'DEGREE',
        status: 'SECURED',
        verified_at: expect.any(String),
      }),
    );
  });

  it('maps anchor.status ACTIVE → "SECURED" in the credential.verified payload', async () => {
    process.env.ENABLE_CREDENTIAL_VERIFIED_WEBHOOK = 'true';

    const app = buildApp(buildAnchor({ status: 'ACTIVE' }));
    const res = await request(app).get('/api/v1/verify/ARK-2026-VRF-001');

    expect(res.status).toBe(200);
    expect(mockDispatchWebhookEvent).toHaveBeenCalledWith(
      'org-1',
      'credential.verified',
      'ARK-2026-VRF-001',
      expect.objectContaining({ status: 'SECURED' }),
    );
  });

  it('maps anchor.status REVOKED → "REVOKED"', async () => {
    process.env.ENABLE_CREDENTIAL_VERIFIED_WEBHOOK = 'true';

    const app = buildApp(buildAnchor({ status: 'REVOKED' }));
    const res = await request(app).get('/api/v1/verify/ARK-2026-VRF-001');

    expect(res.status).toBe(200);
    expect(mockDispatchWebhookEvent).toHaveBeenCalledWith(
      'org-1',
      'credential.verified',
      'ARK-2026-VRF-001',
      expect.objectContaining({ status: 'REVOKED' }),
    );
  });

  it('maps anchor.status EXPIRED → "EXPIRED"', async () => {
    process.env.ENABLE_CREDENTIAL_VERIFIED_WEBHOOK = 'true';

    const app = buildApp(buildAnchor({ status: 'EXPIRED' }));
    const res = await request(app).get('/api/v1/verify/ARK-2026-VRF-001');

    expect(res.status).toBe(200);
    expect(mockDispatchWebhookEvent).toHaveBeenCalledWith(
      'org-1',
      'credential.verified',
      'ARK-2026-VRF-001',
      expect.objectContaining({ status: 'EXPIRED' }),
    );
  });

  it('skips dispatch for non-terminal status (PENDING)', async () => {
    process.env.ENABLE_CREDENTIAL_VERIFIED_WEBHOOK = 'true';

    const app = buildApp(buildAnchor({ status: 'PENDING' }));
    const res = await request(app).get('/api/v1/verify/ARK-2026-VRF-001');

    expect(res.status).toBe(200);
    expect(mockDispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it('skips dispatch for non-terminal status (SUBMITTED)', async () => {
    process.env.ENABLE_CREDENTIAL_VERIFIED_WEBHOOK = 'true';

    const app = buildApp(buildAnchor({ status: 'SUBMITTED' }));
    const res = await request(app).get('/api/v1/verify/ARK-2026-VRF-001');

    expect(res.status).toBe(200);
    expect(mockDispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it('skips dispatch on cache HIT (sampling by cache TTL)', async () => {
    process.env.ENABLE_CREDENTIAL_VERIFIED_WEBHOOK = 'true';
    mockGetCached.mockResolvedValueOnce({
      verified: true,
      status: 'ACTIVE',
      record_uri: 'https://app.arkova.ai/verify/ARK-2026-VRF-001',
    });

    const app = buildApp(buildAnchor({ status: 'SECURED' }));
    const res = await request(app).get('/api/v1/verify/ARK-2026-VRF-001');

    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    expect(mockDispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it('skips dispatch when org_id is missing (orphan anchor)', async () => {
    process.env.ENABLE_CREDENTIAL_VERIFIED_WEBHOOK = 'true';

    const app = buildApp(buildAnchor({ org_id: null }));
    const res = await request(app).get('/api/v1/verify/ARK-2026-VRF-001');

    expect(res.status).toBe(200);
    expect(mockDispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it('falls back to credential_type "OTHER" when anchor.credential_type is null', async () => {
    process.env.ENABLE_CREDENTIAL_VERIFIED_WEBHOOK = 'true';

    const app = buildApp(buildAnchor({ credential_type: null }));
    const res = await request(app).get('/api/v1/verify/ARK-2026-VRF-001');

    expect(res.status).toBe(200);
    expect(mockDispatchWebhookEvent).toHaveBeenCalledWith(
      'org-1',
      'credential.verified',
      'ARK-2026-VRF-001',
      expect.objectContaining({ credential_type: 'OTHER' }),
    );
  });

  it('still returns 200 when dispatchWebhookEvent throws (best-effort)', async () => {
    process.env.ENABLE_CREDENTIAL_VERIFIED_WEBHOOK = 'true';
    mockDispatchWebhookEvent.mockImplementationOnce(() => {
      throw new Error('webhook delivery offline');
    });

    const app = buildApp(buildAnchor({ status: 'SECURED' }));
    const res = await request(app).get('/api/v1/verify/ARK-2026-VRF-001');

    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
  });

  // ---- SCRUM-1799: VERIFICATION_QUERIED audit row enrichment ----

  it('records credential_verified_dispatched=true in the VERIFICATION_QUERIED audit row when emit succeeds', async () => {
    process.env.ENABLE_CREDENTIAL_VERIFIED_WEBHOOK = 'true';

    const app = buildApp(buildAnchor({ status: 'SECURED' }));
    await request(app).get('/api/v1/verify/ARK-2026-VRF-001');
    for (let i = 0; i < 10; i++) await Promise.resolve();

    const calls = mockAuditInsert.mock.calls.map((c: unknown[]) => c[0]);
    const queryRow = calls.find(
      (row: any) => row?.event_type === 'VERIFICATION_QUERIED',
    ) as { details: string } | undefined;
    expect(queryRow).toBeDefined();
    const details = JSON.parse(queryRow!.details);
    expect(details.credential_verified_dispatched).toBe(true);
  });

  it('records credential_verified_dispatched=false + dispatch_error when emit throws', async () => {
    process.env.ENABLE_CREDENTIAL_VERIFIED_WEBHOOK = 'true';
    mockDispatchWebhookEvent.mockImplementationOnce(() => {
      throw new Error('endpoint timeout');
    });

    const app = buildApp(buildAnchor({ status: 'SECURED' }));
    await request(app).get('/api/v1/verify/ARK-2026-VRF-001');
    for (let i = 0; i < 10; i++) await Promise.resolve();

    const calls = mockAuditInsert.mock.calls.map((c: unknown[]) => c[0]);
    const queryRow = calls.find(
      (row: any) => row?.event_type === 'VERIFICATION_QUERIED',
    ) as { details: string } | undefined;
    expect(queryRow).toBeDefined();
    const details = JSON.parse(queryRow!.details);
    expect(details.credential_verified_dispatched).toBe(false);
    expect(details.credential_verified_dispatch_error).toBe('endpoint timeout');
  });

  it('omits credential_verified_dispatched when flag is OFF (emit path not exercised)', async () => {
    delete process.env.ENABLE_CREDENTIAL_VERIFIED_WEBHOOK;

    const app = buildApp(buildAnchor({ status: 'SECURED' }));
    await request(app).get('/api/v1/verify/ARK-2026-VRF-001');
    for (let i = 0; i < 10; i++) await Promise.resolve();

    const calls = mockAuditInsert.mock.calls.map((c: unknown[]) => c[0]);
    const queryRow = calls.find(
      (row: any) => row?.event_type === 'VERIFICATION_QUERIED',
    ) as { details: string } | undefined;
    expect(queryRow).toBeDefined();
    const details = JSON.parse(queryRow!.details);
    expect(details.credential_verified_dispatched).toBeUndefined();
  });
});
