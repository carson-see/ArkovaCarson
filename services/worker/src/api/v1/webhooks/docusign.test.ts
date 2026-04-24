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

const SECRET = 'docusign_fixture_secret';
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
  return crypto.createHmac('sha256', SECRET).update(body).digest('base64');
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
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DOCUSIGN_CONNECT_HMAC_SECRET = SECRET;
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
    rpcMock.mockResolvedValueOnce({ data: '22222222-2222-2222-2222-222222222222', error: null });
    submitJobMock.mockResolvedValueOnce('job-1');
    const body = validBody();

    const res = await request(createApp())
      .post('/webhooks/docusign')
      .set('Content-Type', 'application/json')
      .set('X-DocuSign-Signature-1', sign(body))
      .send(body);

    expect(res.status).toBe(202);
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

  it('returns 500 when the retryable job cannot be queued', async () => {
    dbFromMock.mockReturnValueOnce(
      integrationLookup({ id: 'int-1', org_id: ORG_ID, account_id: 'acct-1' }),
    );
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
});
