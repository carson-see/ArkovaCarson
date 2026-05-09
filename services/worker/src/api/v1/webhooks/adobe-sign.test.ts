/**
 * Adobe Sign webhook handler tests (SCRUM-1148).
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

import { adobeSignWebhookRouter } from './adobe-sign.js';

const TEST_SECRET = 'adobe-fixture-secret-aaaa';
const ORG_ID = '11111111-1111-1111-1111-111111111111';
const INTEGRATION_ID = '22222222-2222-2222-2222-222222222222';
const WEBHOOK_ID = 'webhook-abc-123';
const AGREEMENT_ID = 'CBSCTBAAA-agreement-xyz';

function createApp() {
  const app = express();
  app.use(
    '/webhooks/adobe-sign',
    express.raw({ type: 'application/json' }),
    (req, _res, next) => {
      (req as unknown as { rawBody: Buffer }).rawBody = req.body as Buffer;
      next();
    },
    adobeSignWebhookRouter,
  );
  return app;
}

function sign(body: string | Buffer): string {
  return crypto.createHmac('sha256', TEST_SECRET).update(body).digest('base64');
}

function validBody(overrides: Partial<{
  event: string;
  agreementId: string;
  webhookId: string;
}> = {}): string {
  return JSON.stringify({
    event: overrides.event ?? 'AGREEMENT_WORKFLOW_COMPLETED',
    eventDate: '2026-04-25T00:00:00Z',
    webhookId: overrides.webhookId ?? WEBHOOK_ID,
    agreement: {
      id: overrides.agreementId ?? AGREEMENT_ID,
      name: 'Sample MSA.pdf',
      senderInfo: { email: 'sender@example.com' },
      documents: [{ id: 'doc-1', name: 'Sample MSA.pdf' }],
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
  process.env.ADOBE_SIGN_CLIENT_SECRET = TEST_SECRET;
});

describe('POST /webhooks/adobe-sign (SCRUM-1148)', () => {
  it('returns 503 when client secret is not configured', async () => {
    delete process.env.ADOBE_SIGN_CLIENT_SECRET;
    const body = validBody();
    const res = await request(createApp())
      .post('/webhooks/adobe-sign')
      .set('Content-Type', 'application/json')
      .set('X-AdobeSign-ClientId-Authentication-Sha256', sign(body))
      .send(body);
    expect(res.status).toBe(503);
  });

  it('rejects tampered payloads with 401 before any DB write', async () => {
    const body = validBody();
    const res = await request(createApp())
      .post('/webhooks/adobe-sign')
      .set('Content-Type', 'application/json')
      .set('X-AdobeSign-ClientId-Authentication-Sha256', 'AAAA')
      .send(body);
    expect(res.status).toBe(401);
    expect(dbFromMock).not.toHaveBeenCalled();
  });

  it('200 + ignored=true for non-completed events (CREATED, RECALLED, REJECTED)', async () => {
    const body = validBody({ event: 'AGREEMENT_CREATED' });
    const res = await request(createApp())
      .post('/webhooks/adobe-sign')
      .set('Content-Type', 'application/json')
      .set('X-AdobeSign-ClientId-Authentication-Sha256', sign(body))
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, ignored: true });
  });

  it('200 + orphaned=true when webhook_id has no connected integration', async () => {
    dbFromMock.mockImplementation((table: string) => {
      if (table === 'org_integrations') return integrationLookup(null);
      throw new Error(`unexpected: ${table}`);
    });
    const body = validBody();
    const res = await request(createApp())
      .post('/webhooks/adobe-sign')
      .set('Content-Type', 'application/json')
      .set('X-AdobeSign-ClientId-Authentication-Sha256', sign(body))
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, orphaned: true });
  });

  it('202 + rule_event_id when payload is valid, integration is connected, and enqueue succeeds', async () => {
    dbFromMock.mockImplementation((table: string) => {
      if (table === 'org_integrations') {
        return integrationLookup({ id: INTEGRATION_ID, org_id: ORG_ID, webhook_id: WEBHOOK_ID });
      }
      if (table === 'adobe_sign_webhook_nonces') return nonceInsertMock(null);
      throw new Error(`unexpected: ${table}`);
    });
    rpcMock.mockResolvedValueOnce({ data: 'rule-event-uuid', error: null });
    const body = validBody();
    const res = await request(createApp())
      .post('/webhooks/adobe-sign')
      .set('Content-Type', 'application/json')
      .set('X-AdobeSign-ClientId-Authentication-Sha256', sign(body))
      .send(body);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ ok: true, rule_event_id: 'rule-event-uuid' });
    expect(rpcMock).toHaveBeenCalledWith(
      'enqueue_rule_event',
      expect.objectContaining({
        p_org_id: ORG_ID,
        p_trigger_type: 'ESIGN_COMPLETED',
        p_vendor: 'adobe_sign',
        p_external_file_id: AGREEMENT_ID,
      }),
    );
  });

  it('idempotent: duplicate delivery (unique-violation 23505) returns 200 + duplicate=true', async () => {
    const intLookup = integrationLookup({ id: INTEGRATION_ID, org_id: ORG_ID, webhook_id: WEBHOOK_ID });
    dbFromMock.mockImplementation((table: string) => {
      if (table === 'org_integrations') return intLookup;
      if (table === 'adobe_sign_webhook_nonces') return nonceInsertMock({ code: '23505' });
      throw new Error(`unexpected: ${table}`);
    });
    const body = validBody();
    const res = await request(createApp())
      .post('/webhooks/adobe-sign')
      .set('Content-Type', 'application/json')
      .set('X-AdobeSign-ClientId-Authentication-Sha256', sign(body))
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, duplicate: true });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('500 + DLQ insert when enqueue_rule_event RPC fails', async () => {
    const dlq = dlqInsertMock();
    dbFromMock.mockImplementation((table: string) => {
      if (table === 'org_integrations') {
        return integrationLookup({ id: INTEGRATION_ID, org_id: ORG_ID, webhook_id: WEBHOOK_ID });
      }
      if (table === 'adobe_sign_webhook_nonces') return nonceInsertMock(null);
      if (table === 'webhook_dlq') return dlq;
      throw new Error(`unexpected: ${table}`);
    });
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'rpc boom' } });
    const body = validBody();
    const res = await request(createApp())
      .post('/webhooks/adobe-sign')
      .set('Content-Type', 'application/json')
      .set('X-AdobeSign-ClientId-Authentication-Sha256', sign(body))
      .send(body);
    expect(res.status).toBe(500);
    expect(dlq.insert).toHaveBeenCalledTimes(1);
    const dlqRow = (dlq.insert as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      provider: string;
      external_id: string;
    };
    expect(dlqRow.provider).toBe('adobe_sign');
    expect(dlqRow.external_id).toBe(AGREEMENT_ID);
  });

  it('400 + DLQ insert on malformed JSON', async () => {
    const dlq = dlqInsertMock();
    dbFromMock.mockImplementation((table: string) => {
      if (table === 'webhook_dlq') return dlq;
      throw new Error(`unexpected: ${table}`);
    });
    const body = '{ malformed';
    const res = await request(createApp())
      .post('/webhooks/adobe-sign')
      .set('Content-Type', 'application/json')
      .set('X-AdobeSign-ClientId-Authentication-Sha256', sign(body))
      .send(body);
    expect(res.status).toBe(400);
    expect(dlq.insert).toHaveBeenCalledTimes(1);
  });
});
