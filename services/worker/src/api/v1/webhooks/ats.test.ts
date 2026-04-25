import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbFromMock = vi.fn();

vi.mock('../../../utils/db.js', () => ({
  db: {
    from: (...args: unknown[]) => dbFromMock(...args),
  },
}));

vi.mock('../../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { atsWebhookRouter } from './ats.js';

const INTEGRATION_ID = 'int-uuid-1';
const WEBHOOK_SECRET = 'test-secret-not-real';

function createApp() {
  const app = express();
  app.use(
    '/webhooks/ats',
    express.raw({ type: 'application/json' }),
    (req, _res, next) => {
      (req as unknown as { rawBody: Buffer }).rawBody = req.body as Buffer;
      req.body = JSON.parse((req.body as Buffer).toString('utf8'));
      next();
    },
    atsWebhookRouter,
  );
  return app;
}

function signPayload(body: string, secret: string = WEBHOOK_SECRET): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function integrationLookup(data: unknown, error: unknown = null) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error }),
    or: vi.fn().mockResolvedValue({ data: [], error: null }),
  };
}

function attestationLookup(data: unknown = []) {
  return {
    select: vi.fn().mockReturnThis(),
    or: vi.fn().mockResolvedValue({ data, error: null }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /webhooks/ats/:provider/:integrationId', () => {
  it('verifies HMAC against single integration (no multi-secret iteration)', async () => {
    const body = JSON.stringify({
      action: 'candidate.hired',
      payload: {
        candidate: { first_name: 'Jane', last_name: 'Doe', email_addresses: [{ value: 'j@example.com' }] },
        stage: { name: 'Background Check' },
      },
    });

    dbFromMock.mockReturnValueOnce(
      integrationLookup({
        id: INTEGRATION_ID,
        org_id: 'org-1',
        webhook_secret: WEBHOOK_SECRET,
        callback_url: null,
        field_mapping: null,
      }),
    );
    dbFromMock.mockReturnValueOnce(attestationLookup([]));

    const res = await request(createApp())
      .post(`/webhooks/ats/greenhouse/${INTEGRATION_ID}`)
      .set('Content-Type', 'application/json')
      .set('X-Greenhouse-Signature', signPayload(body))
      .send(body);

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('accepted');
  });

  it('rejects when signature does not match the single integration secret', async () => {
    const body = JSON.stringify({ action: 'candidate.hired' });
    dbFromMock.mockReturnValueOnce(
      integrationLookup({
        id: INTEGRATION_ID,
        org_id: 'org-1',
        webhook_secret: 'different-secret',
      }),
    );

    const res = await request(createApp())
      .post(`/webhooks/ats/greenhouse/${INTEGRATION_ID}`)
      .set('Content-Type', 'application/json')
      .set('X-Greenhouse-Signature', signPayload(body))
      .send(body);

    expect(res.status).toBe(401);
  });

  it('returns 404 when integrationId does not exist', async () => {
    dbFromMock.mockReturnValueOnce(integrationLookup(null));
    const body = JSON.stringify({ action: 'test' });

    const res = await request(createApp())
      .post('/webhooks/ats/greenhouse/nonexistent')
      .set('Content-Type', 'application/json')
      .set('X-Greenhouse-Signature', signPayload(body))
      .send(body);

    expect(res.status).toBe(404);
  });

  it('uses raw body bytes for HMAC (not re-stringified JSON)', async () => {
    // Body with specific formatting that JSON.stringify would alter
    const body = '{"action":"candidate.hired","extra":  true}';

    dbFromMock.mockReturnValueOnce(
      integrationLookup({
        id: INTEGRATION_ID,
        org_id: 'org-1',
        webhook_secret: WEBHOOK_SECRET,
      }),
    );
    dbFromMock.mockReturnValueOnce(attestationLookup([]));

    const correctSig = signPayload(body);

    const res = await request(createApp())
      .post(`/webhooks/ats/greenhouse/${INTEGRATION_ID}`)
      .set('Content-Type', 'application/json')
      .set('X-Greenhouse-Signature', correctSig)
      .send(body);

    expect(res.status).toBe(202);
  });

  it('rejects unsupported providers', async () => {
    const res = await request(createApp())
      .post(`/webhooks/ats/unsupported/${INTEGRATION_ID}`)
      .set('Content-Type', 'application/json')
      .send('{}');

    expect(res.status).toBe(400);
  });
});
