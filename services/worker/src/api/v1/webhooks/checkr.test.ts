/**
 * Checkr webhook handler tests (SCRUM-1030 / SCRUM-1151).
 *
 * Checkr signs webhooks with HMAC-SHA256 hex via the `X-Checkr-Signature`
 * header over the raw body — different encoding from DocuSign/Adobe (base64).
 */
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbFromMock = vi.fn();
const rpcMock = vi.fn();

vi.mock('../../../utils/db.js', () => ({
  db: {
    from: (...args: unknown[]) => dbFromMock(...args),
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

vi.mock('../../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { checkrWebhookRouter } from './checkr.js';

const TEST_SECRET = 'checkr-fixture-secret-aaaa';
const ORG_ID = '11111111-1111-1111-1111-111111111111';
const INTEGRATION_ID = '22222222-2222-2222-2222-222222222222';
const REPORT_ID = 'a8e4b5c6-7777-4888-9aaa-bbbbccccdddd';

function createApp() {
  const app = express();
  app.use(
    '/webhooks/checkr',
    express.raw({ type: 'application/json' }),
    (req, _res, next) => {
      (req as unknown as { rawBody: Buffer }).rawBody = req.body as Buffer;
      next();
    },
    checkrWebhookRouter,
  );
  return app;
}

function sign(body: string | Buffer): string {
  // Checkr documents hex encoding; mirror that here.
  return crypto.createHmac('sha256', TEST_SECRET).update(body).digest('hex');
}

function validBody(overrides: Partial<{ type: string; reportId: string; candidateId: string }> = {}): string {
  return JSON.stringify({
    type: overrides.type ?? 'report.completed',
    data: {
      object: {
        id: overrides.reportId ?? REPORT_ID,
        status: 'complete',
        candidate_id: overrides.candidateId ?? 'cand-9999',
        uri: 'https://api.checkr.com/v1/reports/abc',
      },
    },
  });
}

function integrationLookup(data: unknown, error: unknown = null) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error }),
  };
}

function nonceInsertMock(error: { code: string; message?: string } | null = null) {
  return { insert: vi.fn().mockResolvedValue({ data: null, error }) };
}

function dlqInsertMock() {
  return { insert: vi.fn().mockResolvedValue({ data: null, error: null }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CHECKR_WEBHOOK_SECRET = TEST_SECRET;
});

describe('POST /webhooks/checkr (SCRUM-1030 / 1151)', () => {
  it('returns 503 when secret is not configured', async () => {
    delete process.env.CHECKR_WEBHOOK_SECRET;
    const body = validBody();
    const res = await request(createApp())
      .post('/webhooks/checkr')
      .set('Content-Type', 'application/json')
      .set('X-Checkr-Signature', sign(body))
      .send(body);
    expect(res.status).toBe(503);
  });

  it('rejects tampered payloads with 401 before any DB write', async () => {
    const body = validBody();
    const res = await request(createApp())
      .post('/webhooks/checkr')
      .set('Content-Type', 'application/json')
      .set('X-Checkr-Signature', '00'.repeat(32))
      .send(body);
    expect(res.status).toBe(401);
    expect(dbFromMock).not.toHaveBeenCalled();
  });

  it('200 + ignored=true for non-completed Checkr events', async () => {
    const body = validBody({ type: 'report.created' });
    const res = await request(createApp())
      .post('/webhooks/checkr')
      .set('Content-Type', 'application/json')
      .set('X-Checkr-Signature', sign(body))
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, ignored: true });
  });

  it('200 + orphaned=true when no integration matches the account_id header', async () => {
    dbFromMock.mockImplementation((table: string) => {
      if (table === 'org_integrations') return integrationLookup(null);
      throw new Error(`unexpected: ${table}`);
    });
    const body = validBody();
    const res = await request(createApp())
      .post('/webhooks/checkr')
      .set('Content-Type', 'application/json')
      .set('X-Checkr-Signature', sign(body))
      .set('X-Checkr-Account-Id', 'acct-unknown')
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, orphaned: true });
  });

  it('202 + rule_event_id for valid completed report from connected integration', async () => {
    dbFromMock.mockImplementation((table: string) => {
      if (table === 'org_integrations') {
        return integrationLookup({ id: INTEGRATION_ID, org_id: ORG_ID, account_id: 'acct-acme' });
      }
      if (table === 'checkr_webhook_nonces') return nonceInsertMock(null);
      throw new Error(`unexpected: ${table}`);
    });
    rpcMock.mockResolvedValueOnce({ data: 'rule-event-uuid', error: null });
    const body = validBody();
    const res = await request(createApp())
      .post('/webhooks/checkr')
      .set('Content-Type', 'application/json')
      .set('X-Checkr-Signature', sign(body))
      .set('X-Checkr-Account-Id', 'acct-acme')
      .send(body);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ ok: true, rule_event_id: 'rule-event-uuid' });
    expect(rpcMock).toHaveBeenCalledWith(
      'enqueue_rule_event',
      expect.objectContaining({
        p_org_id: ORG_ID,
        p_trigger_type: 'CONNECTOR_DOCUMENT_RECEIVED',
        p_vendor: 'checkr',
        p_external_file_id: REPORT_ID,
      }),
    );
  });

  it('idempotent: duplicate delivery returns 200 + duplicate=true', async () => {
    dbFromMock.mockImplementation((table: string) => {
      if (table === 'org_integrations') {
        return integrationLookup({ id: INTEGRATION_ID, org_id: ORG_ID, account_id: 'acct-acme' });
      }
      if (table === 'checkr_webhook_nonces') return nonceInsertMock({ code: '23505' });
      throw new Error(`unexpected: ${table}`);
    });
    const body = validBody();
    const res = await request(createApp())
      .post('/webhooks/checkr')
      .set('Content-Type', 'application/json')
      .set('X-Checkr-Signature', sign(body))
      .set('X-Checkr-Account-Id', 'acct-acme')
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, duplicate: true });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('500 + DLQ insert when enqueue_rule_event RPC fails', async () => {
    const dlq = dlqInsertMock();
    dbFromMock.mockImplementation((table: string) => {
      if (table === 'org_integrations') {
        return integrationLookup({ id: INTEGRATION_ID, org_id: ORG_ID, account_id: 'acct-acme' });
      }
      if (table === 'checkr_webhook_nonces') return nonceInsertMock(null);
      if (table === 'webhook_dlq') return dlq;
      throw new Error(`unexpected: ${table}`);
    });
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'rpc boom' } });
    const body = validBody();
    const res = await request(createApp())
      .post('/webhooks/checkr')
      .set('Content-Type', 'application/json')
      .set('X-Checkr-Signature', sign(body))
      .set('X-Checkr-Account-Id', 'acct-acme')
      .send(body);
    expect(res.status).toBe(500);
    expect(dlq.insert).toHaveBeenCalledTimes(1);
  });

  it('400 + DLQ insert on malformed JSON', async () => {
    const dlq = dlqInsertMock();
    dbFromMock.mockImplementation((table: string) => {
      if (table === 'webhook_dlq') return dlq;
      throw new Error(`unexpected: ${table}`);
    });
    const body = '{ not json';
    const res = await request(createApp())
      .post('/webhooks/checkr')
      .set('Content-Type', 'application/json')
      .set('X-Checkr-Signature', sign(body))
      .send(body);
    expect(res.status).toBe(400);
    expect(dlq.insert).toHaveBeenCalledTimes(1);
  });
});
