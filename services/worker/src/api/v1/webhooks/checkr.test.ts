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

/**
 * SCRUM-3479 / AUDIT-0424-10 — the replay nonce must be released before any
 * post-nonce 5xx.
 *
 * `checkr_webhook_nonces` is written BEFORE `enqueue_rule_event` runs, so an
 * un-compensated enqueue failure is unrecoverable rather than retryable:
 * Checkr re-presents the same delivery, the insert hits the
 * `(report_id, payload_hash)` UNIQUE violation, and the handler answers
 * `200 {duplicate:true}` — the `report.completed` event is dropped AND the
 * vendor is told it succeeded. `webhook_dlq` does not save it: nothing under
 * `services/worker/src/jobs/` reads that table, so a DLQ row records the loss,
 * it is not a recovery path.
 *
 * Same compensating-delete shape as `middesk.ts::releaseNonce` and the
 * `webhook_event_claims` release in `stripe/handlers.ts`.
 */
describe('SCRUM-3479: releases the replay nonce on post-nonce failure', () => {
  const PAYLOAD_HASH = crypto.createHash('sha256').update(validBody()).digest('hex');

  /**
   * `checkr_webhook_nonces` is deduped on the composite UNIQUE key
   * `(report_id, payload_hash)`, so the release must filter on BOTH columns.
   * Deleting by `report_id` alone would drop the nonce for a DIFFERENT payload
   * revision of the same report — silently disarming replay protection for a
   * delivery this request never touched. This helper records the ordered filter
   * chain so the tests can assert both.
   */
  function nonceTableMock(insertError: { code: string; message?: string } | null = null) {
    const filters: Array<[string, unknown]> = [];
    // Chainable eq: records each filter and is itself awaitable, so the same
    // mock serves a one-eq or two-eq chain.
    const makeEq = (): ((col: string, val: unknown) => unknown) =>
      vi.fn((col: string, val: unknown) => {
        filters.push([col, val]);
        const thenable = Promise.resolve({ error: null }) as Promise<{ error: unknown }> & {
          eq: unknown;
        };
        thenable.eq = makeEq();
        return thenable;
      });
    const deleteFn = vi.fn(() => ({ eq: makeEq() }));
    return {
      filters,
      deleteFn,
      table: {
        insert: vi.fn().mockResolvedValue({ data: null, error: insertError }),
        delete: deleteFn,
      },
    };
  }

  function post(body: string) {
    return request(createApp())
      .post('/webhooks/checkr')
      .set('Content-Type', 'application/json')
      .set('X-Checkr-Signature', sign(body))
      .set('X-Checkr-Account-Id', 'acct-acme')
      .send(body);
  }

  it('releases the nonce when enqueue_rule_event returns an error', async () => {
    const nonce = nonceTableMock(null);
    dbFromMock.mockImplementation((table: string) => {
      if (table === 'org_integrations') {
        return integrationLookup({ id: INTEGRATION_ID, org_id: ORG_ID, account_id: 'acct-acme' });
      }
      if (table === 'checkr_webhook_nonces') return nonce.table;
      if (table === 'webhook_dlq') return dlqInsertMock();
      throw new Error(`unexpected: ${table}`);
    });
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'rpc boom' } });

    const res = await post(validBody());

    expect(res.status).toBe(500);
    // Without this the Checkr retry short-circuits as a duplicate and the
    // completed background check is lost permanently.
    expect(nonce.filters).toEqual([
      ['report_id', REPORT_ID],
      ['payload_hash', PAYLOAD_HASH],
    ]);
  });

  it('releases the nonce when post-nonce processing throws', async () => {
    const nonce = nonceTableMock(null);
    dbFromMock.mockImplementation((table: string) => {
      if (table === 'org_integrations') {
        return integrationLookup({ id: INTEGRATION_ID, org_id: ORG_ID, account_id: 'acct-acme' });
      }
      if (table === 'checkr_webhook_nonces') return nonce.table;
      if (table === 'webhook_dlq') return dlqInsertMock();
      throw new Error(`unexpected: ${table}`);
    });
    rpcMock.mockImplementationOnce(() => {
      throw new Error('connection terminated unexpectedly');
    });

    const res = await post(validBody());

    expect(res.status).toBe(500);
    expect(nonce.filters).toEqual([
      ['report_id', REPORT_ID],
      ['payload_hash', PAYLOAD_HASH],
    ]);
  });

  it('does NOT release the nonce on success (replay protection intact)', async () => {
    const nonce = nonceTableMock(null);
    dbFromMock.mockImplementation((table: string) => {
      if (table === 'org_integrations') {
        return integrationLookup({ id: INTEGRATION_ID, org_id: ORG_ID, account_id: 'acct-acme' });
      }
      if (table === 'checkr_webhook_nonces') return nonce.table;
      throw new Error(`unexpected: ${table}`);
    });
    rpcMock.mockResolvedValueOnce({ data: 'rule-event-uuid', error: null });

    const res = await post(validBody());

    expect(res.status).toBe(202);
    expect(nonce.deleteFn).not.toHaveBeenCalled();
  });

  it('does NOT delete a nonce this delivery never committed (pre-nonce failure)', async () => {
    const nonce = nonceTableMock(null);
    dbFromMock.mockImplementation((table: string) => {
      // The integration lookup fails BEFORE the nonce insert, so any row
      // matching (report_id, payload_hash) could only be an EARLIER delivery's.
      // Deleting it here would re-open that delivery to replay.
      if (table === 'org_integrations') return integrationLookup(null, { message: 'lookup boom' });
      if (table === 'checkr_webhook_nonces') return nonce.table;
      if (table === 'webhook_dlq') return dlqInsertMock();
      throw new Error(`unexpected: ${table}`);
    });

    const res = await post(validBody());

    expect(res.status).toBe(500);
    expect(nonce.deleteFn).not.toHaveBeenCalled();
  });

  it('does NOT delete when the nonce insert failed open (non-23505)', async () => {
    // The handler deliberately continues when the nonce write fails for a
    // non-duplicate reason. No row was committed, so there is nothing to
    // compensate — and any matching row belongs to an earlier delivery.
    const nonce = nonceTableMock({ code: '42501', message: 'permission denied' });
    dbFromMock.mockImplementation((table: string) => {
      if (table === 'org_integrations') {
        return integrationLookup({ id: INTEGRATION_ID, org_id: ORG_ID, account_id: 'acct-acme' });
      }
      if (table === 'checkr_webhook_nonces') return nonce.table;
      if (table === 'webhook_dlq') return dlqInsertMock();
      throw new Error(`unexpected: ${table}`);
    });
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'rpc boom' } });

    const res = await post(validBody());

    expect(res.status).toBe(500);
    expect(nonce.deleteFn).not.toHaveBeenCalled();
  });
});
