/**
 * Middesk webhook handler tests (SCRUM-1162)
 *
 * Covers signature verification, replay protection, and status-transition
 * logic without any live network calls. DB is mocked via vi.mock.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'node:crypto';

vi.mock('../../../utils/db.js', () => ({
  db: {
    from: vi.fn(),
  },
}));

vi.mock('../../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { db } from '../../../utils/db.js';
import { middeskWebhookRouter } from './middesk.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockDb = db as any;

const WEBHOOK_SECRET = 'whsec_test_arkova';

function createApp() {
  const app = express();
  app.use(
    '/webhooks/middesk',
    express.raw({ type: 'application/json' }),
    (req, _res, next) => {
      (req as unknown as { rawBody: Buffer }).rawBody = req.body as Buffer;
      next();
    },
    middeskWebhookRouter,
  );
  return app;
}

function signBody(body: string | Buffer, secret = WEBHOOK_SECRET): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

const VALID_EVENT = {
  object: 'event',
  id: 'evt_abc',
  type: 'business.updated',
  data: {
    object: {
      id: 'biz_999',
      external_id: '00000000-0000-0000-0000-000000000001',
      status: 'pending',
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MIDDESK_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

describe('POST /webhooks/middesk', () => {
  it('returns 503 when MIDDESK_WEBHOOK_SECRET is not set', async () => {
    delete process.env.MIDDESK_WEBHOOK_SECRET;
    const app = createApp();
    const body = JSON.stringify(VALID_EVENT);
    const res = await request(app)
      .post('/webhooks/middesk')
      .set('Content-Type', 'application/json')
      .set('x-middesk-signature', signBody(body, 'any'))
      .send(body);
    expect(res.status).toBe(503);
  });

  it('returns 401 on missing signature header', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/webhooks/middesk')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(VALID_EVENT));
    expect(res.status).toBe(401);
  });

  it('returns 401 on invalid signature', async () => {
    const app = createApp();
    const body = JSON.stringify(VALID_EVENT);
    const res = await request(app)
      .post('/webhooks/middesk')
      .set('Content-Type', 'application/json')
      .set('x-middesk-signature', 'a'.repeat(64))
      .send(body);
    expect(res.status).toBe(401);
  });

  it('returns 200 on duplicate (nonce unique-violation)', async () => {
    mockDb.from.mockImplementationOnce(() => ({
      insert: vi.fn().mockResolvedValueOnce({ error: { code: '23505' } }),
    }));

    const app = createApp();
    const body = JSON.stringify(VALID_EVENT);
    const res = await request(app)
      .post('/webhooks/middesk')
      .set('Content-Type', 'application/json')
      .set('x-middesk-signature', signBody(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(true);
  });

  it('returns 200 orphaned when org not found', async () => {
    // First call: nonce insert succeeds.
    // Second & third calls: organizations lookups (by id, then kyb_reference_id) return null.
    let call = 0;
    mockDb.from.mockImplementation(() => {
      call++;
      if (call === 1) {
        return { insert: vi.fn().mockResolvedValueOnce({ error: null }) };
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValueOnce({ data: null, error: null }),
      };
    });

    const app = createApp();
    const body = JSON.stringify(VALID_EVENT);
    const res = await request(app)
      .post('/webhooks/middesk')
      .set('Content-Type', 'application/json')
      .set('x-middesk-signature', signBody(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.orphaned).toBe(true);
  });

  it('SCRUM-1217: PostgREST filter syntax in external_id cannot inject into the org lookup', async () => {
    // Hostile external_id value attempts to inject a second clause via
    // PostgREST `.or()` syntax. With the new `.eq()` lookup this just
    // becomes a literal value that the DB compares character-for-character
    // (and never matches anything), so the call falls through to the
    // kyb_reference_id lookup with the trusted vendor id.
    const HOSTILE = ').or(verification_status.eq.VERIFIED';
    const hostileEvent = {
      ...VALID_EVENT,
      id: 'evt_hostile',
      data: {
        object: {
          id: 'biz_attack',
          external_id: HOSTILE,
          status: 'pending',
        },
      },
    };

    const eqCalls: Array<{ field: string; value: unknown }> = [];
    let call = 0;
    mockDb.from.mockImplementation(() => {
      call++;
      if (call === 1) {
        return { insert: vi.fn().mockResolvedValueOnce({ error: null }) };
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn((field: string, value: unknown) => {
          eqCalls.push({ field, value });
          return {
            maybeSingle: vi.fn().mockResolvedValueOnce({ data: null, error: null }),
          };
        }),
      };
    });

    const app = createApp();
    const body = JSON.stringify(hostileEvent);
    const res = await request(app)
      .post('/webhooks/middesk')
      .set('Content-Type', 'application/json')
      .set('x-middesk-signature', signBody(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.orphaned).toBe(true);
    // Exactly two lookups, each with a fixed column name (no payload-derived
    // column names) and the payload value as a literal value, never a filter.
    expect(eqCalls).toHaveLength(2);
    expect(eqCalls[0]).toEqual({ field: 'id', value: HOSTILE });
    expect(eqCalls[1]).toEqual({ field: 'kyb_reference_id', value: 'biz_attack' });
    // Field names are hardcoded column names — none derived from the payload.
    expect(eqCalls.every((c) => c.field === 'id' || c.field === 'kyb_reference_id')).toBe(true);
  });

  it('inserts event + flips verification_status on verified event', async () => {
    const verifiedEvent = { ...VALID_EVENT, id: 'evt_verified', type: 'business.verified' };
    const orgId = verifiedEvent.data.object.external_id;
    const body = JSON.stringify(verifiedEvent);

    let call = 0;
    let capturedEventInsert: Record<string, unknown> | null = null;
    let capturedOrgUpdate: Record<string, unknown> | null = null;

    mockDb.from.mockImplementation(() => {
      call++;
      if (call === 1) {
        // kyb_webhook_nonces insert
        return { insert: vi.fn().mockResolvedValueOnce({ error: null }) };
      }
      if (call === 2) {
        // organizations lookup by id (external_id present → first lookup hits this branch)
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValueOnce({
            data: { id: orgId },
            error: null,
          }),
        };
      }
      if (call === 3) {
        // kyb_events insert
        return {
          insert: vi.fn().mockImplementationOnce((row: Record<string, unknown>) => {
            capturedEventInsert = row;
            return Promise.resolve({ error: null });
          }),
        };
      }
      // organizations.update
      return {
        update: vi.fn().mockImplementationOnce((row: Record<string, unknown>) => {
          capturedOrgUpdate = row;
          return { eq: vi.fn().mockResolvedValueOnce({ error: null }) };
        }),
      };
    });

    const app = createApp();
    const res = await request(app)
      .post('/webhooks/middesk')
      .set('Content-Type', 'application/json')
      .set('x-middesk-signature', signBody(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(capturedEventInsert).toMatchObject({
      org_id: orgId,
      provider: 'middesk',
      event_type: 'business.verified',
      status: 'verified',
      provider_event_id: 'evt_verified',
    });
    expect(capturedOrgUpdate).toMatchObject({ verification_status: 'VERIFIED' });
  });

  it('returns 400 on malformed body', async () => {
    mockDb.from.mockImplementationOnce(() => ({
      insert: vi.fn().mockResolvedValueOnce({ error: null }),
    }));

    const app = createApp();
    const body = 'not valid json at all';
    const res = await request(app)
      .post('/webhooks/middesk')
      .set('Content-Type', 'application/json')
      .set('x-middesk-signature', signBody(body))
      .send(body);
    // Signature verifies (body is bytes), then JSON parse fails → 400
    expect(res.status).toBe(400);
  });
});
