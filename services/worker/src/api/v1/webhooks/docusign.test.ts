/**
 * DocuSign Connect webhook handler tests (SCRUM-1101).
 */
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbFromMock = vi.fn();
const rpcMock = vi.fn();
const submitJobMock = vi.fn();

vi.mock('../../../utils/db.js', () => ({
  db: {
    from: (...args: unknown[]) => dbFromMock(...args),
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

vi.mock('../../../utils/jobQueue.js', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...args),
}));

vi.mock('../../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { docusignWebhookRouter, extractNotaryData } from './docusign.js';
import { logger } from '../../../utils/logger.js';

const TEST_HMAC_KEY = 'fixture-key-not-a-secret-aaaa';
const ORG_ID = '11111111-1111-4111-8111-111111111111';
const SUB_ORG_ID = '22222222-2222-4222-8222-222222222222';
const VALID_DOC_SHA256 = 'b'.repeat(64);

function createApp() {
  const app = express();
  app.use(
    '/webhooks/docusign',
    express.raw({ type: 'application/json' }),
    (req, _res, next) => {
      (req as unknown as { rawBody: Buffer }).rawBody = req.body as Buffer;
      next();
    },
    docusignWebhookRouter,
  );
  return app;
}

function sign(body: string | Buffer): string {
  return crypto.createHmac('sha256', TEST_HMAC_KEY).update(body).digest('base64');
}

function validBody(): string {
  return JSON.stringify({
    event: 'envelope-completed',
    envelopeId: 'env-1',
    accountId: 'acct-1',
    status: 'completed',
    sender: { email: 'legal@example.com' },
    envelopeDocuments: [{ documentId: 'combined', name: 'msa.pdf', sha256: VALID_DOC_SHA256 }],
  });
}

function postSignedBody(body: string | Buffer) {
  return request(createApp())
    .post('/webhooks/docusign')
    .set('Content-Type', 'application/json')
    .set('X-DocuSign-Signature-1', sign(body))
    .send(body);
}

function integrationLookup(data: unknown, error: unknown = null) {
  const rows = data === null ? [] : Array.isArray(data) ? data : [data];
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
      Promise.resolve({ data: error ? null : rows, error }).then(resolve, reject),
  };
}

function noInheritedMarkers() {
  return integrationLookup(null);
}

function insertResult(error: { code: string; message?: string } | null = null) {
  return {
    insert: vi.fn().mockResolvedValue({ data: null, error }),
  };
}

const nonceInsert = insertResult;

function nonceDelete(error: { code: string; message?: string } | null = null) {
  return {
    delete: vi.fn().mockReturnThis(),
    match: vi.fn().mockResolvedValue({ data: null, error }),
  };
}

const webhookDlqInsert = insertResult;

beforeEach(() => {
  dbFromMock.mockReset();
  rpcMock.mockReset();
  submitJobMock.mockReset();
  process.env.DOCUSIGN_CONNECT_HMAC_SECRET = TEST_HMAC_KEY;
});

describe('POST /webhooks/docusign', () => {
  it('returns 503 when HMAC secret is not configured and integration has no keys', async () => {
    delete process.env.DOCUSIGN_CONNECT_HMAC_SECRET;
    // SCRUM-2043: lookup-first — integration lookup happens before HMAC check
    dbFromMock.mockReturnValueOnce(
      integrationLookup({ id: 'int-1', org_id: ORG_ID, account_id: 'acct-1', hmac_keys: null }),
    );
    dbFromMock.mockReturnValueOnce(noInheritedMarkers());
    const body = validBody();
    const res = await postSignedBody(body);

    expect(res.status).toBe(503);
  });

  it('rejects tampered payloads after integration lookup', async () => {
    // SCRUM-2043: lookup-first order means DB lookup happens before HMAC check.
    // Integration lookup IS called, but no nonce/rule/job writes happen.
    dbFromMock.mockReturnValueOnce(
      integrationLookup({ id: 'int-1', org_id: ORG_ID, account_id: 'acct-1', hmac_keys: null }),
    );
    dbFromMock.mockReturnValueOnce(noInheritedMarkers());
    const body = validBody();
    const res = await request(createApp())
      .post('/webhooks/docusign')
      .set('Content-Type', 'application/json')
      .set('X-DocuSign-Signature-1', sign(body))
      .send(body.replace('env-1', 'env-2'));

    expect(res.status).toBe(401);
    expect(dbFromMock).toHaveBeenCalledTimes(2); // integration + inherited-marker lookup only
    expect(rpcMock).not.toHaveBeenCalled();
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('returns 401 for malformed HMAC-valid bodies without dispatching', async () => {
    const body = JSON.stringify({
      event: 'envelope-completed',
      envelopeId: 'env-1',
      status: 'completed',
    });

    const res = await postSignedBody(body);

    expect(res.status).toBe(401);
    expect(dbFromMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('returns 401 for unknown account when HMAC signature is invalid', async () => {
    // SCRUM-2044: dual-table lookup — both org and member tables return no match.
    // Even for unknown accounts, HMAC must be verified with the env-var key.
    dbFromMock.mockReturnValueOnce(integrationLookup(null));
    dbFromMock.mockReturnValueOnce(integrationLookup(null));
    const body = validBody();

    const res = await request(createApp())
      .post('/webhooks/docusign')
      .set('Content-Type', 'application/json')
      .set('X-DocuSign-Signature-1', 'bad-signature')
      .send(body);

    expect(res.status).toBe(401);
  });

  it('returns 401 for wrong completed-event field types without dispatching', async () => {
    const body = JSON.stringify({
      event: 'envelope-completed',
      envelopeId: 'env-1',
      accountId: 'acct-1',
      status: { value: 'completed' },
    });

    const res = await postSignedBody(body);

    expect(res.status).toBe(401);
    expect(dbFromMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('returns 200 orphaned for unknown account when HMAC signature is valid', async () => {
    // SCRUM-2044: dual-table lookup — both org and member tables return no match.
    // Valid HMAC with env-var key proves the request came from DocuSign.
    dbFromMock.mockReturnValueOnce(integrationLookup(null));
    dbFromMock.mockReturnValueOnce(integrationLookup(null));
    const body = validBody();

    const res = await postSignedBody(body);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, orphaned: true });
  });

  it('returns 503 for unknown account when no env-var HMAC key is configured', async () => {
    delete process.env.DOCUSIGN_CONNECT_HMAC_SECRET;
    dbFromMock.mockReturnValueOnce(integrationLookup(null));
    dbFromMock.mockReturnValueOnce(integrationLookup(null));
    const body = validBody();

    const res = await request(createApp())
      .post('/webhooks/docusign')
      .set('Content-Type', 'application/json')
      .set('X-DocuSign-Signature-1', sign(body))
      .send(body);

    expect(res.status).toBe(503);
  });

  it('enqueues a sanitized rules event and retryable document-fetch job', async () => {
    dbFromMock.mockReturnValueOnce(
      integrationLookup({ id: 'int-1', org_id: ORG_ID, account_id: 'acct-1', hmac_keys: null }),
    );
    dbFromMock.mockReturnValueOnce(noInheritedMarkers());
    dbFromMock.mockReturnValueOnce(nonceInsert());
    rpcMock.mockResolvedValueOnce({ data: '22222222-2222-4222-8222-222222222222', error: null });
    submitJobMock.mockResolvedValueOnce('job-1');
    const body = validBody();

    const res = await postSignedBody(body);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true });
    expect(rpcMock).toHaveBeenCalledWith('enqueue_rule_event', expect.objectContaining({
      p_org_id: ORG_ID,
      p_trigger_type: 'ESIGN_COMPLETED',
      p_vendor: 'docusign',
      p_external_file_id: 'env-1',
      p_filename: 'msa.pdf',
      p_sender_email: 'legal@example.com',
      p_payload: expect.objectContaining({
        source: 'docusign_connect',
        integration_id: 'int-1',
        envelope_id: 'env-1',
        document_ids: ['combined'],
        document_hashes: [VALID_DOC_SHA256],
        document_sha256: VALID_DOC_SHA256,
        payload_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    }));
    expect(submitJobMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'docusign.envelope_completed',
      max_attempts: 5,
      payload: expect.objectContaining({
        org_id: ORG_ID,
        integration_id: 'int-1',
        envelope_id: 'env-1',
        rule_event_id: '22222222-2222-4222-8222-222222222222',
      }),
    }));
  });

  it('attributes a parent-owned DocuSign account to the single inherited sub-org marker', async () => {
    dbFromMock.mockReturnValueOnce(
      integrationLookup({ id: 'parent-int-1', org_id: ORG_ID, account_id: 'acct-1', hmac_keys: null }),
    );
    dbFromMock.mockReturnValueOnce(
      integrationLookup({
        id: 'marker-int-1',
        org_id: SUB_ORG_ID,
        account_id: null,
        hmac_keys: null,
      }),
    );
    dbFromMock.mockReturnValueOnce(nonceInsert());
    rpcMock.mockResolvedValueOnce({ data: 'evt-suborg-1', error: null });
    submitJobMock.mockResolvedValueOnce('job-suborg-1');
    const body = validBody();

    const res = await postSignedBody(body);

    expect(res.status).toBe(202);
    expect(rpcMock).toHaveBeenCalledWith('enqueue_rule_event', expect.objectContaining({
      p_org_id: SUB_ORG_ID,
      p_payload: expect.objectContaining({
        integration_id: 'marker-int-1',
        account_id: 'acct-1',
        envelope_id: 'env-1',
      }),
    }));
    expect(submitJobMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'docusign.envelope_completed',
      payload: expect.objectContaining({
        org_id: SUB_ORG_ID,
        integration_id: 'marker-int-1',
        account_id: 'acct-1',
        envelope_id: 'env-1',
        rule_event_id: 'evt-suborg-1',
      }),
    }));
  });

  it('rejects parent-owned DocuSign account attribution when multiple sub-org markers inherit it', async () => {
    dbFromMock.mockReturnValueOnce(
      integrationLookup({ id: 'parent-int-1', org_id: ORG_ID, account_id: 'acct-1', hmac_keys: null }),
    );
    dbFromMock.mockReturnValueOnce(
      integrationLookup([
        { id: 'marker-int-1', org_id: SUB_ORG_ID, account_id: null, hmac_keys: null },
        { id: 'marker-int-2', org_id: '33333333-3333-4333-8333-333333333333', account_id: null, hmac_keys: null },
      ]),
    );
    dbFromMock.mockReturnValueOnce(webhookDlqInsert());
    const body = validBody();

    const res = await postSignedBody(body);

    expect(res.status).toBe(500);
    expect(rpcMock).not.toHaveBeenCalled();
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('deduplicates repeated DocuSign document hashes before deriving document_sha256', async () => {
    dbFromMock.mockReturnValueOnce(
      integrationLookup({ id: 'int-1', org_id: ORG_ID, account_id: 'acct-1' }),
    );
    dbFromMock.mockReturnValueOnce(noInheritedMarkers());
    dbFromMock.mockReturnValueOnce(nonceInsert());
    rpcMock.mockResolvedValueOnce({ data: '33333333-3333-4333-8333-333333333333', error: null });
    submitJobMock.mockResolvedValueOnce('job-dup-hash');
    const body = JSON.stringify({
      event: 'envelope-completed',
      envelopeId: 'env-dup-hash',
      accountId: 'acct-1',
      status: 'completed',
      sender: { email: 'legal@example.com' },
      envelopeDocuments: [
        { documentId: '1', name: 'msa.pdf', sha256: VALID_DOC_SHA256.toUpperCase() },
        { documentId: 'combined', name: 'combined.pdf', sha256: VALID_DOC_SHA256 },
      ],
    });

    const res = await request(createApp())
      .post('/webhooks/docusign')
      .set('Content-Type', 'application/json')
      .set('X-DocuSign-Signature-1', sign(body))
      .send(body);

    expect(res.status).toBe(202);
    expect(rpcMock).toHaveBeenCalledWith('enqueue_rule_event', expect.objectContaining({
      p_external_file_id: 'env-dup-hash',
      p_payload: expect.objectContaining({
        document_hashes: [VALID_DOC_SHA256],
        document_sha256: VALID_DOC_SHA256,
      }),
    }));
  });

  it('accepts DocuSign payloads with extra fields after schema validation', async () => {
    dbFromMock.mockReturnValueOnce(
      integrationLookup({ id: 'int-1', org_id: ORG_ID, account_id: 'acct-1', hmac_keys: null }),
    );
    dbFromMock.mockReturnValueOnce(noInheritedMarkers());
    dbFromMock.mockReturnValueOnce(nonceInsert());
    rpcMock.mockResolvedValueOnce({ data: '22222222-2222-4222-8222-222222222222', error: null });
    submitJobMock.mockResolvedValueOnce('job-1');
    const body = JSON.stringify({
      event: 'envelope-completed',
      envelopeId: 'env-extra-1',
      accountId: 'acct-1',
      status: 'completed',
      generatedDateTime: '2026-05-28T14:05:00.000Z',
      sender: { email: 'legal@example.com' },
      envelopeDocuments: [{ documentId: 'combined', name: 'msa.pdf' }],
      unexpectedDocuSignField: { retained: 'for vendor compatibility' },
    });

    const res = await request(createApp())
      .post('/webhooks/docusign')
      .set('Content-Type', 'application/json')
      .set('X-DocuSign-Signature-1', sign(body))
      .send(body);

    expect(res.status).toBe(202);
    expect(rpcMock).toHaveBeenCalledWith('enqueue_rule_event', expect.objectContaining({
      p_external_file_id: 'env-extra-1',
      p_payload: expect.objectContaining({
        generated_at: '2026-05-28T14:05:00.000Z',
      }),
    }));
    expect(submitJobMock).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ envelope_id: 'env-extra-1' }),
    }));
  });

  it('returns 500 when the retryable job cannot be queued', async () => {
    const rollback = nonceDelete();
    dbFromMock.mockReturnValueOnce(
      integrationLookup({ id: 'int-1', org_id: ORG_ID, account_id: 'acct-1', hmac_keys: null }),
    );
    dbFromMock.mockReturnValueOnce(noInheritedMarkers());
    dbFromMock.mockReturnValueOnce(nonceInsert());
    dbFromMock.mockReturnValueOnce(rollback);
    dbFromMock.mockReturnValueOnce(webhookDlqInsert());
    rpcMock.mockResolvedValueOnce({ data: 'evt-1', error: null });
    submitJobMock.mockResolvedValueOnce(null);
    const body = validBody();

    const res = await postSignedBody(body);

    expect(res.status).toBe(500);
    expect(rollback.delete).toHaveBeenCalledTimes(1);
  });

  it('rolls back the nonce when document-fetch enqueue fails after rule-event enqueue', async () => {
    const rollback = nonceDelete();
    const body = JSON.stringify({
      event: 'envelope-completed',
      eventId: 'evt-retry-1',
      envelopeId: 'env-retry-1',
      accountId: 'acct-1',
      status: 'completed',
      generatedDateTime: '2026-05-28T14:05:00.000Z',
      sender: { email: 'legal@example.com' },
      envelopeDocuments: [{ documentId: 'combined', name: 'retry.pdf' }],
    });

    dbFromMock.mockReturnValueOnce(
      integrationLookup({ id: 'int-1', org_id: ORG_ID, account_id: 'acct-1' }),
    );
    dbFromMock.mockReturnValueOnce(noInheritedMarkers());
    dbFromMock.mockReturnValueOnce(nonceInsert());
    rpcMock.mockResolvedValueOnce({ data: 'evt-first', error: null });
    submitJobMock.mockResolvedValueOnce(null);
    dbFromMock.mockReturnValueOnce(rollback);
    dbFromMock.mockReturnValueOnce(webhookDlqInsert());

    const first = await postSignedBody(body);

    expect(first.status).toBe(500);
    expect(rollback.delete).toHaveBeenCalledTimes(1);

    dbFromMock.mockReturnValueOnce(
      integrationLookup({ id: 'int-1', org_id: ORG_ID, account_id: 'acct-1' }),
    );
    dbFromMock.mockReturnValueOnce(noInheritedMarkers());
    dbFromMock.mockReturnValueOnce(nonceInsert());
    rpcMock.mockResolvedValueOnce({ data: 'evt-second', error: null });
    submitJobMock.mockResolvedValueOnce('job-retry');

    const retry = await postSignedBody(body);

    expect(retry.status).toBe(202);
    expect(retry.body).toEqual({ ok: true });
    expect(rpcMock).toHaveBeenCalledTimes(2);
    expect(submitJobMock).toHaveBeenCalledTimes(2);
  });

  it('rolls back the nonce when rule-event enqueue fails before a rule event exists', async () => {
    const rollback = nonceDelete();
    dbFromMock.mockReturnValueOnce(
      integrationLookup({ id: 'int-1', org_id: ORG_ID, account_id: 'acct-1' }),
    );
    dbFromMock.mockReturnValueOnce(noInheritedMarkers());
    dbFromMock.mockReturnValueOnce(nonceInsert());
    dbFromMock.mockReturnValueOnce(rollback);
    dbFromMock.mockReturnValueOnce(webhookDlqInsert());
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'db unavailable' } });
    const body = validBody();

    const res = await postSignedBody(body);

    expect(res.status).toBe(500);
    expect(rollback.delete).toHaveBeenCalledTimes(1);
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('returns 200 duplicate when the same envelope event is delivered twice', async () => {
    // Replay protection: the second delivery hits a unique-violation on the
    // (envelope_id, event_id, generated_at) constraint and is acknowledged
    // without enqueueing another rule event or fetch job.
    dbFromMock.mockReturnValueOnce(
      integrationLookup({ id: 'int-1', org_id: ORG_ID, account_id: 'acct-1', hmac_keys: null }),
    );
    dbFromMock.mockReturnValueOnce(noInheritedMarkers());
    dbFromMock.mockReturnValueOnce(
      nonceInsert({ code: '23505', message: 'duplicate key value violates unique constraint' }),
    );
    const body = validBody();

    const res = await postSignedBody(body);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, duplicate: true });
    expect(rpcMock).not.toHaveBeenCalled();
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('uses the payload hash as the nonce fallback when DocuSign omits event metadata', async () => {
    const firstNonce = nonceInsert();
    const secondNonce = nonceInsert({ code: '23505', message: 'duplicate key value violates unique constraint' });
    dbFromMock.mockReturnValueOnce(
      integrationLookup({ id: 'int-1', org_id: ORG_ID, account_id: 'acct-1', hmac_keys: null }),
    );
    dbFromMock.mockReturnValueOnce(noInheritedMarkers());
    dbFromMock.mockReturnValueOnce(firstNonce);
    rpcMock.mockResolvedValueOnce({ data: 'evt-1', error: null });
    submitJobMock.mockResolvedValueOnce('job-1');

    const body = validBody();
    const expectedPayloadHash = crypto.createHash('sha256').update(body).digest('hex');
    const first = await postSignedBody(body);

    dbFromMock.mockReturnValueOnce(
      integrationLookup({ id: 'int-1', org_id: ORG_ID, account_id: 'acct-1', hmac_keys: null }),
    );
    dbFromMock.mockReturnValueOnce(noInheritedMarkers());
    dbFromMock.mockReturnValueOnce(secondNonce);
    const retry = await postSignedBody(body);

    expect(first.status).toBe(202);
    expect(retry.status).toBe(200);
    expect(firstNonce.insert).toHaveBeenCalledWith({
      envelope_id: 'env-1',
      event_id: 'envelope-completed',
      generated_at: expectedPayloadHash,
    });
    expect(secondNonce.insert).toHaveBeenCalledWith({
      envelope_id: 'env-1',
      event_id: 'envelope-completed',
      generated_at: expectedPayloadHash,
    });
  });

  it('returns 500 when DocuSign accountId is connected to multiple orgs (cross-tenant guard)', async () => {
    dbFromMock.mockReturnValueOnce(
      integrationLookup([
        { id: 'int-1', org_id: ORG_ID, account_id: 'acct-1', hmac_keys: null },
        { id: 'int-2', org_id: '33333333-3333-4333-8333-333333333333', account_id: 'acct-1', hmac_keys: null },
      ]),
    );
    const body = validBody();

    const res = await postSignedBody(body);

    expect(res.status).toBe(500);
    expect(rpcMock).not.toHaveBeenCalled();
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('returns 500 when the nonce insert fails for a non-duplicate reason', async () => {
    dbFromMock.mockReturnValueOnce(
      integrationLookup({ id: 'int-1', org_id: ORG_ID, account_id: 'acct-1', hmac_keys: null }),
    );
    dbFromMock.mockReturnValueOnce(noInheritedMarkers());
    dbFromMock.mockReturnValueOnce(
      nonceInsert({ code: '08006', message: 'connection failure' }),
    );
    const body = validBody();

    const res = await postSignedBody(body);

    expect(res.status).toBe(500);
    expect(rpcMock).not.toHaveBeenCalled();
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  // SCRUM-1648 DS-01 — Organization-wide capture
  // Pins the launch promise: a single Connect webhook configured at the
  // DocuSign organization level captures completed envelopes from any
  // authorized member of that org. Two distinct senders share one accountId
  // (the DocuSign org), one Arkova rule, and both must produce their own
  // sanitized rule event + retryable fetch job carrying the actual sender
  // identity.
  it('captures envelopes from multiple senders sharing one DocuSign accountId (DS-01)', async () => {
    // Sender 1 — Mercy
    dbFromMock.mockReturnValueOnce(
      integrationLookup({ id: 'int-1', org_id: ORG_ID, account_id: 'acct-1', hmac_keys: null }),
    );
    dbFromMock.mockReturnValueOnce(noInheritedMarkers());
    dbFromMock.mockReturnValueOnce(nonceInsert());
    rpcMock.mockResolvedValueOnce({ data: 'evt-mercy', error: null });
    submitJobMock.mockResolvedValueOnce('job-mercy');

    const mercyBody = JSON.stringify({
      event: 'envelope-completed',
      envelopeId: 'env-mercy-1',
      accountId: 'acct-1',
      status: 'completed',
      sender: { email: 'mercy@example.com' },
      envelopeDocuments: [{ documentId: 'combined', name: 'partnership.pdf' }],
    });

    const mercyRes = await request(createApp())
      .post('/webhooks/docusign')
      .set('Content-Type', 'application/json')
      .set('X-DocuSign-Signature-1', sign(mercyBody))
      .send(mercyBody);

    expect(mercyRes.status).toBe(202);
    expect(rpcMock).toHaveBeenLastCalledWith(
      'enqueue_rule_event',
      expect.objectContaining({
        p_org_id: ORG_ID,
        p_vendor: 'docusign',
        p_external_file_id: 'env-mercy-1',
        p_sender_email: 'mercy@example.com',
      }),
    );

    // Sender 2 — Kevin, same DocuSign accountId, same Arkova org/integration
    dbFromMock.mockReturnValueOnce(
      integrationLookup({ id: 'int-1', org_id: ORG_ID, account_id: 'acct-1', hmac_keys: null }),
    );
    dbFromMock.mockReturnValueOnce(noInheritedMarkers());
    dbFromMock.mockReturnValueOnce(nonceInsert());
    rpcMock.mockResolvedValueOnce({ data: 'evt-kevin', error: null });
    submitJobMock.mockResolvedValueOnce('job-kevin');

    const kevinBody = JSON.stringify({
      event: 'envelope-completed',
      envelopeId: 'env-kevin-1',
      accountId: 'acct-1',
      status: 'completed',
      sender: { email: 'kevin@example.com' },
      envelopeDocuments: [{ documentId: 'combined', name: 'msa.pdf' }],
    });

    const kevinRes = await request(createApp())
      .post('/webhooks/docusign')
      .set('Content-Type', 'application/json')
      .set('X-DocuSign-Signature-1', sign(kevinBody))
      .send(kevinBody);

    expect(kevinRes.status).toBe(202);
    expect(rpcMock).toHaveBeenLastCalledWith(
      'enqueue_rule_event',
      expect.objectContaining({
        p_org_id: ORG_ID,
        p_vendor: 'docusign',
        p_external_file_id: 'env-kevin-1',
        p_sender_email: 'kevin@example.com',
      }),
    );

    // Both senders produced independent rule events + retryable fetch jobs.
    expect(rpcMock).toHaveBeenCalledTimes(2);
    expect(submitJobMock).toHaveBeenCalledTimes(2);
    expect(submitJobMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: 'docusign.envelope_completed',
        payload: expect.objectContaining({
          org_id: ORG_ID,
          envelope_id: 'env-mercy-1',
          rule_event_id: 'evt-mercy',
        }),
      }),
    );
    expect(submitJobMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: 'docusign.envelope_completed',
        payload: expect.objectContaining({
          org_id: ORG_ID,
          envelope_id: 'env-kevin-1',
          rule_event_id: 'evt-kevin',
        }),
      }),
    );
  });

  // ─── SCRUM-2044: Dual-table lookup (member_integrations fallback) ───

  it('falls back to member_integrations when org_integrations has no match (SCRUM-2044)', async () => {
    // First call: org_integrations lookup — no match
    dbFromMock.mockReturnValueOnce(integrationLookup(null));
    // Second call: member_integrations lookup — match found
    dbFromMock.mockReturnValueOnce(
      integrationLookup({ id: 'member-int-1', org_id: ORG_ID, account_id: 'acct-1', hmac_keys: null }),
    );
    // Third call: nonce insert
    dbFromMock.mockReturnValueOnce(nonceInsert());
    rpcMock.mockResolvedValueOnce({ data: 'evt-member-1', error: null });
    submitJobMock.mockResolvedValueOnce('job-member-1');
    const body = validBody();

    const res = await request(createApp())
      .post('/webhooks/docusign')
      .set('Content-Type', 'application/json')
      .set('X-DocuSign-Signature-1', sign(body))
      .send(body);

    expect(res.status).toBe(202);
    // Verify two from() calls happened — org_integrations then member_integrations
    expect(dbFromMock).toHaveBeenCalledTimes(3); // org_integrations + member_integrations + nonce
    expect(rpcMock).toHaveBeenCalledWith('enqueue_rule_event', expect.objectContaining({
      p_org_id: ORG_ID,
    }));
  });

  it('uses org_integrations match even when member_integrations also has a match (org wins)', async () => {
    // Org-level match found — member_integrations should never be queried
    dbFromMock.mockReturnValueOnce(
      integrationLookup({ id: 'int-org', org_id: ORG_ID, account_id: 'acct-1', hmac_keys: null }),
    );
    dbFromMock.mockReturnValueOnce(noInheritedMarkers());
    dbFromMock.mockReturnValueOnce(nonceInsert());
    rpcMock.mockResolvedValueOnce({ data: 'evt-org', error: null });
    submitJobMock.mockResolvedValueOnce('job-org');
    const body = validBody();

    const res = await request(createApp())
      .post('/webhooks/docusign')
      .set('Content-Type', 'application/json')
      .set('X-DocuSign-Signature-1', sign(body))
      .send(body);

    expect(res.status).toBe(202);
    // Only 3 from() calls: org_integrations + inherited markers + nonce (no member_integrations)
    expect(dbFromMock).toHaveBeenCalledTimes(3);
    expect(rpcMock).toHaveBeenCalledWith('enqueue_rule_event', expect.objectContaining({
      p_payload: expect.objectContaining({
        integration_id: 'int-org',
      }),
    }));
  });

  it('returns 200 orphaned when neither org nor member integrations match (SCRUM-2044)', async () => {
    // org_integrations — no match
    dbFromMock.mockReturnValueOnce(integrationLookup(null));
    // member_integrations — no match
    dbFromMock.mockReturnValueOnce(integrationLookup(null));
    const body = validBody();

    const res = await request(createApp())
      .post('/webhooks/docusign')
      .set('Content-Type', 'application/json')
      .set('X-DocuSign-Signature-1', sign(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, orphaned: true });
  });

  it('rejects when member_integrations has same accountId in multiple orgs (cross-tenant guard)', async () => {
    // org_integrations — no match
    dbFromMock.mockReturnValueOnce(integrationLookup(null));
    // member_integrations — ambiguous match
    dbFromMock.mockReturnValueOnce(
      integrationLookup([
        { id: 'mi-1', org_id: ORG_ID, account_id: 'acct-1', hmac_keys: null },
        { id: 'mi-2', org_id: '33333333-3333-4333-8333-333333333333', account_id: 'acct-1', hmac_keys: null },
      ]),
    );
    const body = validBody();

    const res = await request(createApp())
      .post('/webhooks/docusign')
      .set('Content-Type', 'application/json')
      .set('X-DocuSign-Signature-1', sign(body))
      .send(body);

    expect(res.status).toBe(500);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  // ─── SCRUM-1872: Notarization detection ──────────────────────────

  it('enqueues notarization job when notary data is present in the payload', async () => {
    dbFromMock.mockReturnValueOnce(
      integrationLookup({ id: 'int-1', org_id: ORG_ID, account_id: 'acct-1', hmac_keys: null }),
    );
    dbFromMock.mockReturnValueOnce(noInheritedMarkers());
    dbFromMock.mockReturnValueOnce(nonceInsert());
    rpcMock.mockResolvedValueOnce({ data: 'evt-notary', error: null });
    // First submitJob for envelope-completed, second for notarization
    submitJobMock
      .mockResolvedValueOnce('job-envelope')
      .mockResolvedValueOnce('job-notarized');

    const notarizedBody = JSON.stringify({
      event: 'envelope-completed',
      envelopeId: 'env-notarized-1',
      accountId: 'acct-1',
      status: 'completed',
      sender: { email: 'signer@example.com' },
      envelopeDocuments: [{ documentId: 'combined', name: 'affidavit.pdf' }],
      envelopeSummary: {
        recipients: {
          notaries: [{
            name: 'Jane Public',
            notaryCommissionState: 'CA',
            notaryCommissionNumber: '2468135',
            completedDateTime: '2026-05-27T12:00:00Z',
          }],
        },
      },
    });

    const res = await request(createApp())
      .post('/webhooks/docusign')
      .set('Content-Type', 'application/json')
      .set('X-DocuSign-Signature-1', sign(notarizedBody))
      .send(notarizedBody);

    expect(res.status).toBe(202);
    expect(res.body.ok).toBe(true);
    expect(res.body.notarization_job_id).toBeUndefined();
    expect(submitJobMock).toHaveBeenCalledTimes(2);
    expect(submitJobMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      type: 'docusign.notarization_completed',
      payload: expect.objectContaining({
        org_id: ORG_ID,
        envelope_id: 'env-notarized-1',
        notary_name: 'Jane Public',
        notary_commission_state: 'CA',
        notary_commission_number: '2468135',
        notarization_completed_at: '2026-05-27T12:00:00Z',
      }),
    }));
  });

  it('does not enqueue notarization job for standard (non-notarized) envelopes', async () => {
    dbFromMock.mockReturnValueOnce(
      integrationLookup({ id: 'int-1', org_id: ORG_ID, account_id: 'acct-1', hmac_keys: null }),
    );
    dbFromMock.mockReturnValueOnce(noInheritedMarkers());
    dbFromMock.mockReturnValueOnce(nonceInsert());
    rpcMock.mockResolvedValueOnce({ data: 'evt-plain', error: null });
    submitJobMock.mockResolvedValueOnce('job-plain');
    const body = validBody();

    const res = await request(createApp())
      .post('/webhooks/docusign')
      .set('Content-Type', 'application/json')
      .set('X-DocuSign-Signature-1', sign(body))
      .send(body);

    expect(res.status).toBe(202);
    expect(res.body.ok).toBe(true);
    // Only one submitJob call — the standard envelope-completed job
    expect(submitJobMock).toHaveBeenCalledTimes(1);
  });

  it('still returns 202 when notarization job enqueue fails (non-fatal)', async () => {
    dbFromMock.mockReturnValueOnce(
      integrationLookup({ id: 'int-1', org_id: ORG_ID, account_id: 'acct-1', hmac_keys: null }),
    );
    dbFromMock.mockReturnValueOnce(noInheritedMarkers());
    dbFromMock.mockReturnValueOnce(nonceInsert());
    rpcMock.mockResolvedValueOnce({ data: 'evt-notary-fail', error: null });
    // First submitJob succeeds, second (notarization) fails
    submitJobMock
      .mockResolvedValueOnce('job-envelope')
      .mockResolvedValueOnce(null);

    const notarizedBody = JSON.stringify({
      event: 'envelope-completed',
      envelopeId: 'env-notarized-2',
      accountId: 'acct-1',
      status: 'completed',
      sender: { email: 'signer@example.com' },
      envelopeDocuments: [{ documentId: 'combined', name: 'affidavit.pdf' }],
      envelopeSummary: {
        recipients: {
          signers: [{
            name: 'Signer Person',
          }],
          notaries: [{
            name: 'Bob Notary',
            completedDateTime: '2026-05-27T14:00:00Z',
          }],
        },
      },
    });

    const res = await request(createApp())
      .post('/webhooks/docusign')
      .set('Content-Type', 'application/json')
      .set('X-DocuSign-Signature-1', sign(notarizedBody))
      .send(notarizedBody);

    expect(res.status).toBe(202);
    expect(res.body.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// SCRUM-2362 (DS-02) — no raw-payload PII in logs / Sentry / Error (§1.6A).
//
// The webhook handles documents fetched from a third party (the §1.6A carve-
// out): the raw Connect payload carries PII (signer/sender emails, notary
// identity, document fingerprints). None of it may reach the logger, an Error
// message, or (by extension) Sentry. These tests drive the failure paths that
// DO log (invalid signature, processing-failure DLQ, ambiguity) and assert the
// PII markers never appear in any captured log argument or thrown error.
// ─────────────────────────────────────────────────────────────────────
describe('POST /webhooks/docusign — no raw-payload PII leak (DS-02, §1.6A)', () => {
  // Distinctive markers planted in the payload. If any surfaces in a log line
  // or an Error, the redaction contract is broken.
  const PII_SENDER_EMAIL = 'pii-sender-fingerprint@secret.example';
  const PII_NOTARY_NAME = 'PII-NotaryFingerprintName';
  const PII_DOC_SHA = 'd'.repeat(64);

  function piiBody(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      event: 'envelope-completed',
      eventId: 'evt-pii-1',
      envelopeId: 'env-pii-1',
      accountId: 'acct-1',
      status: 'completed',
      generatedDateTime: '2026-05-28T14:05:00.000Z',
      sender: { email: PII_SENDER_EMAIL },
      envelopeDocuments: [{ documentId: 'combined', name: 'sensitive.pdf', sha256: PII_DOC_SHA }],
      envelopeSummary: {
        recipients: {
          notaries: [{ name: PII_NOTARY_NAME, completedDateTime: '2026-05-28T14:05:00.000Z' }],
        },
      },
      ...overrides,
    });
  }

  // Every value passed to any logger method, deep-serialized to a single string.
  function allLoggedText(): string {
    const loggerMock = logger as unknown as Record<'info' | 'warn' | 'error' | 'debug', { mock: { calls: unknown[][] } }>;
    const chunks: string[] = [];
    for (const level of ['info', 'warn', 'error', 'debug'] as const) {
      for (const call of loggerMock[level].mock.calls) {
        for (const arg of call) {
          try {
            chunks.push(typeof arg === 'string' ? arg : JSON.stringify(arg));
          } catch {
            chunks.push(String(arg));
          }
          // Also capture an Error's message/stack explicitly — JSON.stringify
          // drops them (non-enumerable), so a leaked Error wouldn't show above.
          if (arg instanceof Error) {
            chunks.push(arg.message);
            chunks.push(arg.stack ?? '');
          }
          if (arg && typeof arg === 'object') {
            const maybeErr = (arg as Record<string, unknown>).error ?? (arg as Record<string, unknown>).err;
            if (maybeErr instanceof Error) {
              chunks.push(maybeErr.message);
              chunks.push(maybeErr.stack ?? '');
            }
          }
        }
      }
    }
    return chunks.join('\n');
  }

  function expectNoPii(text: string): void {
    expect(text).not.toContain(PII_SENDER_EMAIL);
    expect(text).not.toContain(PII_NOTARY_NAME);
    expect(text).not.toContain(PII_DOC_SHA);
  }

  it('invalid signature → 401 and no PII in any log line', async () => {
    dbFromMock.mockReturnValueOnce(
      integrationLookup({ id: 'int-1', org_id: ORG_ID, account_id: 'acct-1', hmac_keys: null }),
    );
    dbFromMock.mockReturnValueOnce(noInheritedMarkers());
    const body = piiBody();

    const res = await request(createApp())
      .post('/webhooks/docusign')
      .set('Content-Type', 'application/json')
      .set('X-DocuSign-Signature-1', 'bad-signature')
      .send(body);

    expect(res.status).toBe(401);
    // Response body must not echo PII either.
    expectNoPii(JSON.stringify(res.body));
    expectNoPii(allLoggedText());
  });

  it('processing-failure DLQ path → 500, DLQ row carries no raw PII, logs carry no raw PII', async () => {
    // Ambiguous inherited markers → throws, hits the catch → logs + DLQ insert.
    let dlqInsertArg: Record<string, unknown> | null = null;
    dbFromMock.mockReturnValueOnce(
      integrationLookup({ id: 'parent-int-1', org_id: ORG_ID, account_id: 'acct-1', hmac_keys: null }),
    );
    dbFromMock.mockReturnValueOnce(
      integrationLookup([
        { id: 'marker-int-1', org_id: SUB_ORG_ID, account_id: null, hmac_keys: null },
        { id: 'marker-int-2', org_id: '33333333-3333-4333-8333-333333333333', account_id: null, hmac_keys: null },
      ]),
    );
    dbFromMock.mockReturnValueOnce({
      insert: vi.fn((value: Record<string, unknown>) => {
        dlqInsertArg = value;
        return Promise.resolve({ data: null, error: null });
      }),
    });
    const body = piiBody();

    const res = await postSignedBody(body);

    expect(res.status).toBe(500);
    // DLQ stores only provider/reason/external_id/payload_hash — never raw bytes.
    expect(dlqInsertArg).not.toBeNull();
    expectNoPii(JSON.stringify(dlqInsertArg));
    // payload_hash is a SHA-256 of the body, not the body itself; external_id is
    // the envelope id (an opaque provider id, not PII content).
    expect((dlqInsertArg as unknown as { payload_hash: string }).payload_hash).toMatch(/^[a-f0-9]{64}$/);
    expectNoPii(allLoggedText());
  });

  it('rule-event enqueue failure → 500, the thrown/logged error carries no raw PII', async () => {
    dbFromMock.mockReturnValueOnce(
      integrationLookup({ id: 'int-1', org_id: ORG_ID, account_id: 'acct-1', hmac_keys: null }),
    );
    dbFromMock.mockReturnValueOnce(noInheritedMarkers());
    dbFromMock.mockReturnValueOnce(nonceInsert());
    dbFromMock.mockReturnValueOnce(nonceDelete());
    dbFromMock.mockReturnValueOnce(webhookDlqInsert());
    // enqueue_rule_event RPC returns a DB error → handler logs + rolls back + DLQs.
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'db unavailable' } });
    const body = piiBody();

    const res = await postSignedBody(body);

    expect(res.status).toBe(500);
    expectNoPii(allLoggedText());
  });

  it('valid orphan (unknown account) → 200 and no PII logged on the orphan warn', async () => {
    dbFromMock.mockReturnValueOnce(integrationLookup(null));
    dbFromMock.mockReturnValueOnce(integrationLookup(null));
    const body = piiBody({ accountId: 'unknown-acct' });

    const res = await request(createApp())
      .post('/webhooks/docusign')
      .set('Content-Type', 'application/json')
      .set('X-DocuSign-Signature-1', sign(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, orphaned: true });
    expectNoPii(allLoggedText());
  });

  it('malformed body → 401 and the parse-error log carries no raw payload PII', async () => {
    // A body that parses as JSON but fails schema (missing accountId) takes the
    // parse-failure branch which logs err.message — must not echo the raw body.
    const body = JSON.stringify({
      event: 'envelope-completed',
      envelopeId: 'env-pii-malformed',
      status: 'completed',
      sender: { email: PII_SENDER_EMAIL },
      secretField: PII_NOTARY_NAME,
    });

    const res = await postSignedBody(body);

    expect(res.status).toBe(401);
    expectNoPii(allLoggedText());
  });
});

// ── extractNotaryData unit tests (SCRUM-1872) ───────────────────────

describe('extractNotaryData', () => {
  it('extracts notary from envelopeSummary.recipients.notaries', () => {
    const body = JSON.stringify({
      event: 'envelope-completed',
      envelopeSummary: {
        recipients: {
          notaries: [{
            name: 'Jane Public',
            notaryCommissionState: 'California',
            notaryCommissionNumber: 'CA-12345',
            completedDateTime: '2026-05-27T10:00:00Z',
          }],
        },
      },
    });
    const result = extractNotaryData(body);
    expect(result).not.toBeNull();
    expect(result!.notary_name).toBe('Jane Public');
    expect(result!.notary_commission_state).toBe('California');
    expect(result!.notary_commission_number).toBe('CA-12345');
    expect(result!.notarization_completed_at).toBe('2026-05-27T10:00:00Z');
  });

  it('extracts notary from signers with recipientType notary', () => {
    const body = JSON.stringify({
      event: 'envelope-completed',
      envelopeSummary: {
        recipients: {
          signers: [
            { name: 'Regular Signer', recipientType: 'signer' },
            {
              name: 'Notary Person',
              recipientType: 'notary',
              jurisdiction: 'Texas',
              commissionNumber: 'TX-67890',
              completedDateTime: '2026-05-27T11:00:00Z',
            },
          ],
        },
      },
    });
    const result = extractNotaryData(body);
    expect(result).not.toBeNull();
    expect(result!.notary_name).toBe('Notary Person');
    expect(result!.notary_commission_state).toBe('Texas');
    expect(result!.notary_commission_number).toBe('TX-67890');
  });

  it('returns null for non-notarized envelopes', () => {
    const body = JSON.stringify({
      event: 'envelope-completed',
      envelopeId: 'env-1',
      accountId: 'acct-1',
      status: 'completed',
      envelopeDocuments: [{ documentId: 'combined' }],
    });
    expect(extractNotaryData(body)).toBeNull();
  });

  it('returns null for empty recipients', () => {
    const body = JSON.stringify({
      event: 'envelope-completed',
      envelopeSummary: {
        recipients: {},
      },
    });
    expect(extractNotaryData(body)).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(extractNotaryData('not json')).toBeNull();
  });

  it('handles Buffer input', () => {
    const body = Buffer.from(JSON.stringify({
      event: 'envelope-completed',
      envelopeSummary: {
        recipients: {
          notaries: [{
            name: 'Buffer Notary',
            completedDateTime: '2026-05-27T15:00:00Z',
          }],
        },
      },
    }));
    const result = extractNotaryData(body);
    expect(result).not.toBeNull();
    expect(result!.notary_name).toBe('Buffer Notary');
  });

  it('returns null notary fields when metadata is missing but notary entry exists', () => {
    const body = JSON.stringify({
      event: 'envelope-completed',
      envelopeSummary: {
        recipients: {
          notaries: [{ completedDateTime: '2026-05-27T16:00:00Z' }],
        },
      },
    });
    const result = extractNotaryData(body);
    expect(result).not.toBeNull();
    expect(result!.notary_name).toBeNull();
    expect(result!.notary_commission_state).toBeNull();
    expect(result!.notary_commission_number).toBeNull();
  });
});
