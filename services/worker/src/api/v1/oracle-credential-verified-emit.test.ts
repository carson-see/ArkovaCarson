/**
 * Tests for credential.verified webhook emit on
 * POST /api/v1/oracle/verify (SCRUM-1799 / SCRUM-1743 Phase 2b oracle path).
 *
 * Mirrors verify-credential-verified-emit.test.ts but for the agent batch
 * endpoint. Same flag (ENABLE_CREDENTIAL_VERIFIED_WEBHOOK), same status
 * mapping, but the oracle path:
 *   - has no verify cache (every call is a fresh DB lookup)
 *   - is intrinsically batch (1–25 ids per request)
 *   - records emit counts in the existing ORACLE_QUERY audit row
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockDispatchWebhookEvent, mockAuditInsert, mockAnchorsSelect, mockOrgsSelect } =
  vi.hoisted(() => ({
    mockDispatchWebhookEvent: vi.fn(),
    mockAuditInsert: vi.fn().mockResolvedValue({ error: null }),
    mockAnchorsSelect: vi.fn(),
    mockOrgsSelect: vi.fn(),
  }));

// Build a chainable mock for `db.from('anchors').select(...).in(...).is(...)`
function makeAnchorsChain() {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.in = vi.fn(() => chain);
  chain.is = vi.fn(() => mockAnchorsSelect());
  return chain;
}

function makeOrgsChain() {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.in = vi.fn(() => mockOrgsSelect());
  return chain;
}

vi.mock('../../utils/db.js', () => ({
  db: {
    from: vi.fn((table: string) => {
      if (table === 'anchors') return makeAnchorsChain();
      if (table === 'organizations') return makeOrgsChain();
      if (table === 'audit_events') return { insert: mockAuditInsert };
      return {};
    }),
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config.js', () => ({
  config: {
    bitcoinNetwork: 'signet',
    frontendUrl: 'https://app.arkova.ai',
    get enableCredentialVerifiedWebhook() {
      return process.env.ENABLE_CREDENTIAL_VERIFIED_WEBHOOK === 'true';
    },
  },
}));

vi.mock('../../webhooks/delivery.js', () => ({
  dispatchWebhookEvent: mockDispatchWebhookEvent,
}));

import { oracleRouter } from './oracle.js';

function buildApp(apiKeyId: string | null = 'agent-key-1') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (apiKeyId) {
      (req as unknown as { apiKey: { keyId: string } }).apiKey = { keyId: apiKeyId };
    }
    next();
  });
  app.use('/api/v1/oracle', oracleRouter);
  return app;
}

const ANCHOR_ROW = (overrides: Record<string, unknown> = {}) => ({
  public_id: 'ARK-2026-ORC-1',
  fingerprint: 'a'.repeat(64),
  status: 'SECURED',
  chain_tx_id: 'tx-orc',
  chain_block_height: 200200,
  chain_timestamp: '2026-04-01T00:00:00Z',
  created_at: '2026-04-01T00:00:00Z',
  credential_type: 'DEGREE',
  issued_at: '2026-01-01',
  expires_at: null,
  org_id: 'org-orc',
  description: null,
  directory_info_opt_out: false,
  ...overrides,
});

describe('POST /api/v1/oracle/verify — credential.verified emit', () => {
  const ORIGINAL_FLAG = process.env.ENABLE_CREDENTIAL_VERIFIED_WEBHOOK;
  const ORIGINAL_HMAC = process.env.API_KEY_HMAC_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.API_KEY_HMAC_SECRET = 'test-hmac-secret';
    mockDispatchWebhookEvent.mockResolvedValue(undefined);
    mockAnchorsSelect.mockReturnValue({ data: [ANCHOR_ROW()], error: null });
    mockOrgsSelect.mockReturnValue({
      data: [{ id: 'org-orc', display_name: 'Test Org' }],
      error: null,
    });
  });

  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) {
      delete process.env.ENABLE_CREDENTIAL_VERIFIED_WEBHOOK;
    } else {
      process.env.ENABLE_CREDENTIAL_VERIFIED_WEBHOOK = ORIGINAL_FLAG;
    }
    if (ORIGINAL_HMAC === undefined) {
      delete process.env.API_KEY_HMAC_SECRET;
    } else {
      process.env.API_KEY_HMAC_SECRET = ORIGINAL_HMAC;
    }
  });

  it('does NOT dispatch credential.verified when flag is unset', async () => {
    delete process.env.ENABLE_CREDENTIAL_VERIFIED_WEBHOOK;

    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/oracle/verify')
      .send({ public_ids: ['ARK-2026-ORC-1'] });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(mockDispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it('dispatches credential.verified for each terminal-status result when flag is on', async () => {
    process.env.ENABLE_CREDENTIAL_VERIFIED_WEBHOOK = 'true';
    mockAnchorsSelect.mockReturnValue({
      data: [
        ANCHOR_ROW({ public_id: 'ARK-2026-ORC-1', status: 'SECURED', credential_type: 'DEGREE' }),
        ANCHOR_ROW({ public_id: 'ARK-2026-ORC-2', status: 'REVOKED', credential_type: 'TRANSCRIPT' }),
        ANCHOR_ROW({ public_id: 'ARK-2026-ORC-3', status: 'EXPIRED', credential_type: 'CERTIFICATE' }),
      ],
      error: null,
    });

    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/oracle/verify')
      .send({ public_ids: ['ARK-2026-ORC-1', 'ARK-2026-ORC-2', 'ARK-2026-ORC-3'] });

    expect(res.status).toBe(200);
    // Drain microtasks: oracle fan-out is detached
    for (let i = 0; i < 20; i++) await Promise.resolve();

    expect(mockDispatchWebhookEvent).toHaveBeenCalledTimes(3);
    expect(mockDispatchWebhookEvent).toHaveBeenCalledWith(
      'org-orc',
      'credential.verified',
      'ARK-2026-ORC-1',
      expect.objectContaining({ status: 'SECURED', credential_type: 'DEGREE' }),
    );
    expect(mockDispatchWebhookEvent).toHaveBeenCalledWith(
      'org-orc',
      'credential.verified',
      'ARK-2026-ORC-2',
      expect.objectContaining({ status: 'REVOKED', credential_type: 'TRANSCRIPT' }),
    );
    expect(mockDispatchWebhookEvent).toHaveBeenCalledWith(
      'org-orc',
      'credential.verified',
      'ARK-2026-ORC-3',
      expect.objectContaining({ status: 'EXPIRED', credential_type: 'CERTIFICATE' }),
    );
  });

  it('skips ineligible results: not-found, no org_id, non-terminal status', async () => {
    process.env.ENABLE_CREDENTIAL_VERIFIED_WEBHOOK = 'true';
    mockAnchorsSelect.mockReturnValue({
      data: [
        ANCHOR_ROW({ public_id: 'ARK-2026-OK', status: 'SECURED' }),
        ANCHOR_ROW({ public_id: 'ARK-2026-ORPHAN', status: 'SECURED', org_id: null }),
        ANCHOR_ROW({ public_id: 'ARK-2026-PENDING', status: 'PENDING' }),
        // ARK-2026-MISSING omitted so anchorMap.get returns undefined
      ],
      error: null,
    });

    const app = buildApp();
    await request(app)
      .post('/api/v1/oracle/verify')
      .send({
        public_ids: ['ARK-2026-OK', 'ARK-2026-ORPHAN', 'ARK-2026-PENDING', 'ARK-2026-MISSING'],
      });

    for (let i = 0; i < 20; i++) await Promise.resolve();

    // Only the SECURED with org_id emits.
    expect(mockDispatchWebhookEvent).toHaveBeenCalledTimes(1);
    expect(mockDispatchWebhookEvent).toHaveBeenCalledWith(
      'org-orc',
      'credential.verified',
      'ARK-2026-OK',
      expect.any(Object),
    );
  });

  it('records credential_verified_emit_planned + _skipped in ORACLE_QUERY audit row', async () => {
    process.env.ENABLE_CREDENTIAL_VERIFIED_WEBHOOK = 'true';
    mockAnchorsSelect.mockReturnValue({
      data: [
        ANCHOR_ROW({ public_id: 'ARK-OK-1', status: 'SECURED' }),
        ANCHOR_ROW({ public_id: 'ARK-OK-2', status: 'REVOKED' }),
        ANCHOR_ROW({ public_id: 'ARK-PEND', status: 'PENDING' }),
      ],
      error: null,
    });

    const app = buildApp();
    await request(app)
      .post('/api/v1/oracle/verify')
      .send({ public_ids: ['ARK-OK-1', 'ARK-OK-2', 'ARK-PEND', 'ARK-MISSING'] });

    for (let i = 0; i < 5; i++) await Promise.resolve();

    const row = mockAuditInsert.mock.calls[0]?.[0];
    expect(row).toBeDefined();
    expect(row.event_type).toBe('ORACLE_QUERY');
    const details = JSON.parse(row.details);
    expect(details.credential_verified_emit_planned).toBe(2);
    // 1 PENDING + 1 not-found = 2 skipped
    expect(details.credential_verified_emit_skipped).toBe(2);
  });

  it('does not 500 the response when a per-emit dispatch throws (best-effort)', async () => {
    process.env.ENABLE_CREDENTIAL_VERIFIED_WEBHOOK = 'true';
    mockDispatchWebhookEvent.mockImplementationOnce(() => {
      throw new Error('endpoint blew up');
    });
    mockAnchorsSelect.mockReturnValue({
      data: [ANCHOR_ROW({ public_id: 'ARK-2026-FAIL', status: 'SECURED' })],
      error: null,
    });

    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/oracle/verify')
      .send({ public_ids: ['ARK-2026-FAIL'] });

    expect(res.status).toBe(200);
    expect(res.body.results[0].verified).toBe(true);
  });
});
