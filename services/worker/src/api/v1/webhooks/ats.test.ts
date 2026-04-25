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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {};
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain); // SCRUM-1240: org_id scoping
  chain.or = vi.fn().mockResolvedValue({ data, error: null });
  return chain;
}

// SCRUM-1242: per-vendor nonce table for replay protection.
function nonceInsert(error: { code?: string } | null = null) {
  return {
    insert: vi.fn().mockResolvedValue({ error }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // SCRUM-1240: clearAllMocks does not clear the .mockReturnValueOnce
  // queue. mockReset() does. Without this, queued returns from previous
  // tests leak into subsequent tests and the .from() chain misroutes.
  dbFromMock.mockReset();
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
    dbFromMock.mockReturnValueOnce(nonceInsert(null)); // SCRUM-1242
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
    dbFromMock.mockReturnValueOnce(nonceInsert(null)); // SCRUM-1242
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

  // SCRUM-1240 (AUDIT-0424-16): the attestations select MUST be scoped by
  // the integration's org_id. Previously two orgs that both connected
  // Greenhouse with overlapping candidate names would leak each other's
  // attestation rows in the response.
  it('SCRUM-1240: attestations select is scoped by integration.org_id', async () => {
    const eqCalls: Array<[string, unknown]> = [];

    dbFromMock.mockReturnValueOnce(
      integrationLookup({
        id: INTEGRATION_ID,
        org_id: 'org-A',
        webhook_secret: WEBHOOK_SECRET,
      }),
    );
    dbFromMock.mockReturnValueOnce(nonceInsert(null)); // SCRUM-1242

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const attestationChain: any = {};
    attestationChain.select = vi.fn(() => attestationChain);
    attestationChain.eq = vi.fn((field: string, value: unknown) => {
      eqCalls.push([field, value]);
      return attestationChain;
    });
    attestationChain.or = vi.fn().mockResolvedValue({ data: [], error: null });
    dbFromMock.mockReturnValueOnce(attestationChain);

    const body = JSON.stringify({
      action: 'candidate.hired',
      payload: {
        candidate: {
          first_name: 'Jane', last_name: 'Doe',
          email_addresses: [{ value: 'jane@example.com' }],
        },
        stage: { name: 'Background Check' },
      },
    });

    const res = await request(createApp())
      .post(`/webhooks/ats/greenhouse/${INTEGRATION_ID}`)
      .set('Content-Type', 'application/json')
      .set('X-Greenhouse-Signature', signPayload(body))
      .send(body);

    expect(res.status).toBe(202);
    expect(eqCalls).toContainEqual(['org_id', 'org-A']);
    expect(attestationChain.or).toHaveBeenCalled();
  });

  // SCRUM-1242 (AUDIT-0424-26): replay protection. A captured webhook must
  // not be re-processed. We dedupe on (provider, integration_id, signature)
  // — the same signature for the same integration is always a replay (HMAC
  // is deterministic on body + secret).
  it('SCRUM-1242: returns 200 + duplicate=true on replay (nonce already inserted)', async () => {
    const body = JSON.stringify({
      action: 'candidate.hired',
      payload: {
        candidate: { first_name: 'Jane', last_name: 'Doe', email_addresses: [{ value: 'j@x' }] },
        stage: { name: 'BG Check' },
      },
    });

    dbFromMock.mockReturnValueOnce(
      integrationLookup({
        id: INTEGRATION_ID,
        org_id: 'org-1',
        webhook_secret: WEBHOOK_SECRET,
      }),
    );
    // Postgres unique_violation — the nonce was previously inserted.
    dbFromMock.mockReturnValueOnce(nonceInsert({ code: '23505' }));

    const res = await request(createApp())
      .post(`/webhooks/ats/greenhouse/${INTEGRATION_ID}`)
      .set('Content-Type', 'application/json')
      .set('X-Greenhouse-Signature', signPayload(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(true);
  });

  it('SCRUM-1242: writes nonce row keyed on (provider, integration_id, signature)', async () => {
    const body = JSON.stringify({
      action: 'candidate.hired',
      payload: {
        candidate: { first_name: 'A', last_name: 'B', email_addresses: [{ value: 'a@b' }] },
        stage: { name: 'X' },
      },
    });
    const sig = signPayload(body);

    dbFromMock.mockReturnValueOnce(
      integrationLookup({
        id: INTEGRATION_ID,
        org_id: 'org-1',
        webhook_secret: WEBHOOK_SECRET,
      }),
    );
    const nonceMock = nonceInsert(null);
    dbFromMock.mockReturnValueOnce(nonceMock);
    dbFromMock.mockReturnValueOnce(attestationLookup([]));

    const res = await request(createApp())
      .post(`/webhooks/ats/greenhouse/${INTEGRATION_ID}`)
      .set('Content-Type', 'application/json')
      .set('X-Greenhouse-Signature', sig)
      .send(body);

    expect(res.status).toBe(202);
    expect(nonceMock.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'greenhouse',
        integration_id: INTEGRATION_ID,
        signature: sig,
      }),
    );
  });
});
