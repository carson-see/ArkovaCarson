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

import { docusignWebhookRouter } from './docusign.js';

const TEST_HMAC_KEY = 'fixture-key-not-a-secret-aaaa';
const ORG_ID = '11111111-1111-1111-1111-111111111111';

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
    envelopeDocuments: [{ documentId: 'combined', name: 'msa.pdf' }],
  });
}

function integrationLookup(data: unknown, error: unknown = null) {
  // SCRUM-1213: lookup now returns *all* matching org_integrations rows.
  // The chain ends in `.is('revoked_at', null)` (no .maybeSingle()) and
  // resolves to an array. Accept either an array or a single object/null
  // for ergonomic test fixtures.
  const rows = data === null ? [] : Array.isArray(data) ? data : [data];
  const chain: Record<string, unknown> = {};
  const terminal = () => Promise.resolve({ data: rows, error });
  chain.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
    terminal().then(resolve, reject);
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.is = vi.fn(() => chain);
  return chain;
}

function nonceInsert(error: { code: string; message?: string } | null = null) {
  return {
    insert: vi.fn().mockResolvedValue({ data: null, error }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DOCUSIGN_CONNECT_HMAC_SECRET = TEST_HMAC_KEY;
});

describe('POST /webhooks/docusign', () => {
  it('returns 503 when HMAC secret is not configured', async () => {
    delete process.env.DOCUSIGN_CONNECT_HMAC_SECRET;
    const body = validBody();
    const res = await request(createApp())
      .post('/webhooks/docusign')
      .set('Content-Type', 'application/json')
      .set('X-DocuSign-Signature-1', sign(body))
      .send(body);

    expect(res.status).toBe(503);
  });

  it('rejects tampered payloads before any DB write', async () => {
    const body = validBody();
    const res = await request(createApp())
      .post('/webhooks/docusign')
      .set('Content-Type', 'application/json')
      .set('X-DocuSign-Signature-1', sign(body))
      .send(body.replace('env-1', 'env-2'));

    expect(res.status).toBe(401);
    expect(dbFromMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('returns 200 orphaned for a valid event from an unknown connected account', async () => {
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

  it('enqueues a sanitized rules event and retryable document-fetch job', async () => {
    dbFromMock.mockReturnValueOnce(
      integrationLookup({ id: 'int-1', org_id: ORG_ID, account_id: 'acct-1' }),
    );
    dbFromMock.mockReturnValueOnce(nonceInsert());
    rpcMock.mockResolvedValueOnce({ data: '22222222-2222-2222-2222-222222222222', error: null });
    submitJobMock.mockResolvedValueOnce('job-1');
    const body = validBody();

    const res = await request(createApp())
      .post('/webhooks/docusign')
      .set('Content-Type', 'application/json')
      .set('X-DocuSign-Signature-1', sign(body))
      .send(body);

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      ok: true,
      results: [
        { org_id: ORG_ID, rule_event_id: '22222222-2222-2222-2222-222222222222', job_id: 'job-1' },
      ],
    });
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
        rule_event_id: '22222222-2222-2222-2222-222222222222',
      }),
    }));
  });

  it('SCRUM-1213: fans out to every org integration with the same DocuSign account', async () => {
    const ORG_A = '11111111-1111-1111-1111-111111111111';
    const ORG_B = '22222222-2222-2222-2222-222222222222';
    dbFromMock.mockReturnValueOnce(
      integrationLookup([
        { id: 'int-a', org_id: ORG_A, account_id: 'acct-1' },
        { id: 'int-b', org_id: ORG_B, account_id: 'acct-1' },
      ]),
    );
    dbFromMock.mockReturnValueOnce(nonceInsert());
    rpcMock.mockResolvedValueOnce({ data: 'rule-a', error: null });
    rpcMock.mockResolvedValueOnce({ data: 'rule-b', error: null });
    submitJobMock.mockResolvedValueOnce('job-a');
    submitJobMock.mockResolvedValueOnce('job-b');

    const body = validBody();
    const res = await request(createApp())
      .post('/webhooks/docusign')
      .set('Content-Type', 'application/json')
      .set('X-DocuSign-Signature-1', sign(body))
      .send(body);

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      ok: true,
      results: [
        { org_id: ORG_A, rule_event_id: 'rule-a', job_id: 'job-a' },
        { org_id: ORG_B, rule_event_id: 'rule-b', job_id: 'job-b' },
      ],
    });
    // Each org sees their own enqueue with their own org_id + integration_id.
    expect(rpcMock).toHaveBeenCalledWith('enqueue_rule_event', expect.objectContaining({
      p_org_id: ORG_A,
      p_payload: expect.objectContaining({ integration_id: 'int-a' }),
    }));
    expect(rpcMock).toHaveBeenCalledWith('enqueue_rule_event', expect.objectContaining({
      p_org_id: ORG_B,
      p_payload: expect.objectContaining({ integration_id: 'int-b' }),
    }));
  });

  it('returns 500 when the retryable job cannot be queued', async () => {
    dbFromMock.mockReturnValueOnce(
      integrationLookup({ id: 'int-1', org_id: ORG_ID, account_id: 'acct-1' }),
    );
    dbFromMock.mockReturnValueOnce(nonceInsert());
    rpcMock.mockResolvedValueOnce({ data: 'evt-1', error: null });
    submitJobMock.mockResolvedValueOnce(null);
    const body = validBody();

    const res = await request(createApp())
      .post('/webhooks/docusign')
      .set('Content-Type', 'application/json')
      .set('X-DocuSign-Signature-1', sign(body))
      .send(body);

    expect(res.status).toBe(500);
  });

  it('returns 200 duplicate when the same envelope event is delivered twice', async () => {
    // Replay protection: the second delivery hits a unique-violation on the
    // (envelope_id, event_id, generated_at) constraint and is acknowledged
    // without enqueueing another rule event or fetch job.
    dbFromMock.mockReturnValueOnce(
      integrationLookup({ id: 'int-1', org_id: ORG_ID, account_id: 'acct-1' }),
    );
    dbFromMock.mockReturnValueOnce(
      nonceInsert({ code: '23505', message: 'duplicate key value violates unique constraint' }),
    );
    const body = validBody();

    const res = await request(createApp())
      .post('/webhooks/docusign')
      .set('Content-Type', 'application/json')
      .set('X-DocuSign-Signature-1', sign(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, duplicate: true });
    expect(rpcMock).not.toHaveBeenCalled();
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('returns 500 when the nonce insert fails for a non-duplicate reason', async () => {
    dbFromMock.mockReturnValueOnce(
      integrationLookup({ id: 'int-1', org_id: ORG_ID, account_id: 'acct-1' }),
    );
    dbFromMock.mockReturnValueOnce(
      nonceInsert({ code: '08006', message: 'connection failure' }),
    );
    const body = validBody();

    const res = await request(createApp())
      .post('/webhooks/docusign')
      .set('Content-Type', 'application/json')
      .set('X-DocuSign-Signature-1', sign(body))
      .send(body);

    expect(res.status).toBe(500);
    expect(rpcMock).not.toHaveBeenCalled();
    expect(submitJobMock).not.toHaveBeenCalled();
  });
});
