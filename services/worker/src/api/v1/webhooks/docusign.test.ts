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

// docusign-bilateral-2026-08: docusign.ts now reads config.enableDocusignInbound.
// Mock directly (same pattern as drive.test.ts's mockConfig) so these tests
// don't need real SUPABASE_URL/etc env vars, and so the inbound tests below
// can flip the flag per-test.
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: { enableDocusignInbound: false },
}));
vi.mock('../../../config.js', () => ({ config: mockConfig }));

// Union of both merged PRs' needs: extractSigners (R6 signer-capture tests,
// below) plus the config mock above (inbound-classification tests, below).
import { docusignWebhookRouter, extractNotaryData, extractSigners } from './docusign.js';
import { logger } from '../../../utils/logger.js';

const TEST_HMAC_KEY = 'fixture-key-not-a-secret-aaaa';
const ORG_ID = '11111111-1111-4111-8111-111111111111';
const SUB_ORG_ID = '22222222-2222-4222-8222-222222222222';
const VALID_DOC_SHA256 = 'b'.repeat(64);

// R6 (PR #2474 review, HIGH): DocusignCapturedSigner now pins recipient_id_guid
// / user_id to a GUID shape, not just the key name. Test fixtures for those two
// fields must be real GUID-shaped strings. `n` MUST be an integer (never an
// arbitrary word) — its decimal digits are also valid hex characters, so
// distinct integers give distinct, deterministic, valid GUIDs; an arbitrary
// string could contain non-hex letters and silently break the fixture.
function testGuid(n: number): string {
  const suffix = String(Math.trunc(n)).padStart(12, '0').slice(-12);
  return `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`;
}

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
  mockConfig.enableDocusignInbound = false;
});

/** docusign-bilateral-2026-08: a valid body declaring a distinct owning/sending account. */
function bodyWithSenderAccount(args: { senderAccountId?: string; envelopeId?: string; sha256s?: string[] }): string {
  return JSON.stringify({
    event: 'envelope-completed',
    envelopeId: args.envelopeId ?? 'env-1',
    accountId: 'acct-1',
    status: 'completed',
    sender: {
      email: 'legal@example.com',
      ...(args.senderAccountId ? { accountId: args.senderAccountId } : {}),
    },
    envelopeDocuments: (args.sha256s ?? [VALID_DOC_SHA256]).map((sha256, i) => ({
      documentId: `doc-${i}`,
      name: `doc-${i}.pdf`,
      sha256,
    })),
  });
}

/** True when `mock` was ever called with `table` as its first argument. */
function calledWithTable(mock: ReturnType<typeof vi.fn>, table: string): boolean {
  return mock.mock.calls.some((call) => call[0] === table);
}

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
    // Backward compat (R6): validBody() carries no `recipients` at all — the
    // envelope must still process cleanly, and `_signers` must be omitted
    // entirely (never an empty array) from both the rule-event payload and
    // the job payload.
    const jobPayload = submitJobMock.mock.calls[0][0].payload as Record<string, unknown>;
    expect(jobPayload).not.toHaveProperty('_signers');
    const ruleEventPayload = rpcMock.mock.calls[0][1].p_payload as Record<string, unknown>;
    expect(ruleEventPayload).not.toHaveProperty('_signers');
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
    // docusign-bilateral-2026-08 / migration 0424: nonce writes are now
    // tenant-scoped by account_id — see the dedicated "tenant-scopes the
    // nonce write" test above for the focused assertion on that field alone.
    expect(firstNonce.insert).toHaveBeenCalledWith({
      account_id: 'acct-1',
      envelope_id: 'env-1',
      event_id: 'envelope-completed',
      generated_at: expectedPayloadHash,
    });
    expect(secondNonce.insert).toHaveBeenCalledWith({
      account_id: 'acct-1',
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

  // CTO Decision Record (docusign-bilateral-2026-08, ruling R6) — signer
  // capture on the outbound (own-account) envelope-completed path.
  describe('signer capture (R6)', () => {
    function bodyWithSigners(signers: unknown[]): string {
      return JSON.stringify({
        event: 'envelope-completed',
        envelopeId: 'env-signers-1',
        accountId: 'acct-1',
        status: 'completed',
        sender: { email: 'legal@example.com' },
        envelopeDocuments: [{ documentId: 'combined', name: 'msa.pdf' }],
        envelopeSummary: {
          recipients: { signers },
        },
      });
    }

    it('captures pseudonymous signer GUIDs into the job payload as _signers', async () => {
      dbFromMock.mockReturnValueOnce(
        integrationLookup({ id: 'int-1', org_id: ORG_ID, account_id: 'acct-1', hmac_keys: null }),
      );
      dbFromMock.mockReturnValueOnce(noInheritedMarkers());
      dbFromMock.mockReturnValueOnce(nonceInsert());
      rpcMock.mockResolvedValueOnce({ data: 'evt-signers-1', error: null });
      submitJobMock.mockResolvedValueOnce('job-signers-1');

      const body = bodyWithSigners([
        {
          recipientIdGuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          userId: testGuid(101),
          status: 'completed',
          signedDateTime: '2026-08-20T10:00:00Z',
          name: 'Jane Doe',
          email: 'jane@example.com',
        },
        {
          // Pure email-link signer — no DocuSign platform userId.
          recipientIdGuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          status: 'completed',
          signedDateTime: '2026-08-20T10:05:00Z',
          name: 'John Roe',
          email: 'john@example.com',
        },
      ]);

      const res = await request(createApp())
        .post('/webhooks/docusign')
        .set('Content-Type', 'application/json')
        .set('X-DocuSign-Signature-1', sign(body))
        .send(body);

      expect(res.status).toBe(202);
      const jobPayload = submitJobMock.mock.calls[0][0].payload as Record<string, unknown>;
      expect(jobPayload._signers).toEqual([
        {
          recipient_id_guid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          user_id: testGuid(101),
          status: 'completed',
          signed_at: '2026-08-20T10:00:00Z',
        },
        {
          recipient_id_guid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          status: 'completed',
          signed_at: '2026-08-20T10:05:00Z',
        },
      ]);

      // R6: assert absence explicitly — no name/email anywhere in the captured
      // signers, and neither PII marker appears even serialized.
      const serializedSigners = JSON.stringify(jobPayload._signers);
      expect(serializedSigners).not.toContain('Jane Doe');
      expect(serializedSigners).not.toContain('jane@example.com');
      expect(serializedSigners).not.toContain('John Roe');
      expect(serializedSigners).not.toContain('john@example.com');
      for (const signer of jobPayload._signers as Record<string, unknown>[]) {
        expect(Object.keys(signer).sort()).toEqual(
          [...new Set(['recipient_id_guid', 'user_id', 'status', 'signed_at'])]
            .filter((key) => key in signer)
            .sort(),
        );
        expect(signer).not.toHaveProperty('name');
        expect(signer).not.toHaveProperty('email');
      }

      // Finding 7 / R6: _signers must never ride on the size-capped rule-event
      // payload — only on the job → connector_artifact.metadata path.
      const ruleEventPayload = rpcMock.mock.calls[0][1].p_payload as Record<string, unknown>;
      expect(ruleEventPayload).not.toHaveProperty('_signers');
    });

    it('caps captured signers at 20 entries (truncates rather than rejecting the envelope)', async () => {
      dbFromMock.mockReturnValueOnce(
        integrationLookup({ id: 'int-1', org_id: ORG_ID, account_id: 'acct-1', hmac_keys: null }),
      );
      dbFromMock.mockReturnValueOnce(noInheritedMarkers());
      dbFromMock.mockReturnValueOnce(nonceInsert());
      rpcMock.mockResolvedValueOnce({ data: 'evt-signers-cap', error: null });
      submitJobMock.mockResolvedValueOnce('job-signers-cap');

      const signers = Array.from({ length: 25 }, (_, i) => ({
        recipientIdGuid: testGuid(i),
        status: 'completed',
      }));
      const body = bodyWithSigners(signers);

      const res = await request(createApp())
        .post('/webhooks/docusign')
        .set('Content-Type', 'application/json')
        .set('X-DocuSign-Signature-1', sign(body))
        .send(body);

      expect(res.status).toBe(202);
      const jobPayload = submitJobMock.mock.calls[0][0].payload as Record<string, unknown>;
      const captured = jobPayload._signers as Record<string, unknown>[];
      expect(captured).toHaveLength(20);
      expect(captured[0]).toMatchObject({ recipient_id_guid: testGuid(0) });
      expect(captured[19]).toMatchObject({ recipient_id_guid: testGuid(19) });
    });

    it('skips recipient entries missing the required recipientIdGuid or status', async () => {
      dbFromMock.mockReturnValueOnce(
        integrationLookup({ id: 'int-1', org_id: ORG_ID, account_id: 'acct-1', hmac_keys: null }),
      );
      dbFromMock.mockReturnValueOnce(noInheritedMarkers());
      dbFromMock.mockReturnValueOnce(nonceInsert());
      rpcMock.mockResolvedValueOnce({ data: 'evt-signers-partial', error: null });
      submitJobMock.mockResolvedValueOnce('job-signers-partial');

      const body = bodyWithSigners([
        { recipientIdGuid: testGuid(201) },
        { status: 'completed' }, // no recipientIdGuid
        { recipientIdGuid: testGuid(202), status: 'completed' },
      ]);

      const res = await request(createApp())
        .post('/webhooks/docusign')
        .set('Content-Type', 'application/json')
        .set('X-DocuSign-Signature-1', sign(body))
        .send(body);

      expect(res.status).toBe(202);
      const jobPayload = submitJobMock.mock.calls[0][0].payload as Record<string, unknown>;
      expect(jobPayload._signers).toEqual([
        { recipient_id_guid: testGuid(202), status: 'completed' },
      ]);
    });

    it('omits _signers entirely for an envelope with an empty signers array', async () => {
      dbFromMock.mockReturnValueOnce(
        integrationLookup({ id: 'int-1', org_id: ORG_ID, account_id: 'acct-1', hmac_keys: null }),
      );
      dbFromMock.mockReturnValueOnce(noInheritedMarkers());
      dbFromMock.mockReturnValueOnce(nonceInsert());
      rpcMock.mockResolvedValueOnce({ data: 'evt-signers-empty', error: null });
      submitJobMock.mockResolvedValueOnce('job-signers-empty');

      const body = bodyWithSigners([]);
      const res = await request(createApp())
        .post('/webhooks/docusign')
        .set('Content-Type', 'application/json')
        .set('X-DocuSign-Signature-1', sign(body))
        .send(body);

      expect(res.status).toBe(202);
      const jobPayload = submitJobMock.mock.calls[0][0].payload as Record<string, unknown>;
      expect(jobPayload).not.toHaveProperty('_signers');
    });

    it('processes cleanly (still 202) for an envelope with no recipients block at all', async () => {
      dbFromMock.mockReturnValueOnce(
        integrationLookup({ id: 'int-1', org_id: ORG_ID, account_id: 'acct-1', hmac_keys: null }),
      );
      dbFromMock.mockReturnValueOnce(noInheritedMarkers());
      dbFromMock.mockReturnValueOnce(nonceInsert());
      rpcMock.mockResolvedValueOnce({ data: 'evt-no-recipients', error: null });
      submitJobMock.mockResolvedValueOnce('job-no-recipients');

      const body = validBody(); // no envelopeSummary/recipients at all
      const res = await postSignedBody(body);

      expect(res.status).toBe(202);
      expect(res.body).toEqual({ ok: true });
      const jobPayload = submitJobMock.mock.calls[0][0].payload as Record<string, unknown>;
      expect(jobPayload).not.toHaveProperty('_signers');
    });

    // Finding 7 / R6: organization_rule_events.payload has a DB CHECK
    // pg_column_size(payload) <= 16384. At the schema's max cardinality (100
    // envelopeDocuments, the .max(100) cap in DocusignEnvelopeCompleted) the
    // document_ids/document_hashes arrays alone approach that ceiling, so
    // _signers (up to 20 entries) must never ride on this payload — only on
    // the job -> connector_artifact.metadata path, which has no size cap.
    it('MAX CARDINALITY (100 envelopeDocuments + 20 _signers): rule-event payload stays <= 16KB and never carries _signers', async () => {
      dbFromMock.mockReturnValueOnce(
        integrationLookup({ id: 'int-1', org_id: ORG_ID, account_id: 'acct-1', hmac_keys: null }),
      );
      dbFromMock.mockReturnValueOnce(noInheritedMarkers());
      dbFromMock.mockReturnValueOnce(nonceInsert());
      rpcMock.mockResolvedValueOnce({ data: 'evt-max-cardinality', error: null });
      submitJobMock.mockResolvedValueOnce('job-max-cardinality');

      // 100 documents at the envelopeDocuments schema cap, each with a unique
      // valid vendor-supplied sha256 (worst case for document_hashes dedup —
      // no collisions to shrink the array).
      const envelopeDocuments = Array.from({ length: 100 }, (_, i) => ({
        documentId: String(i + 1),
        name: `Document ${i + 1}.pdf`,
        sha256: crypto.createHash('sha256').update(`document-${i}`).digest('hex'),
      }));
      // 20 signers at the _signers cap.
      const signers = Array.from({ length: 20 }, (_, i) => ({
        recipientIdGuid: testGuid(i),
        userId: testGuid(i + 500),
        status: 'completed',
        signedDateTime: '2026-08-20T10:00:00Z',
      }));

      const body = JSON.stringify({
        event: 'envelope-completed',
        envelopeId: 'env-max-cardinality',
        accountId: 'acct-1',
        status: 'completed',
        generatedDateTime: '2026-08-20T10:00:00.000Z',
        sender: { email: 'legal@example.com' },
        envelopeDocuments,
        envelopeSummary: {
          recipients: { signers },
        },
      });

      const res = await request(createApp())
        .post('/webhooks/docusign')
        .set('Content-Type', 'application/json')
        .set('X-DocuSign-Signature-1', sign(body))
        .send(body);

      expect(res.status).toBe(202);

      // The rule-event payload (organization_rule_events.payload, DB CHECK
      // pg_column_size <= 16384) must stay under that ceiling AND never carry
      // _signers.
      const ruleEventPayload = rpcMock.mock.calls[0][1].p_payload as Record<string, unknown>;
      expect(ruleEventPayload).not.toHaveProperty('_signers');
      const ruleEventBytes = Buffer.byteLength(JSON.stringify(ruleEventPayload), 'utf8');
      expect(ruleEventBytes).toBeLessThanOrEqual(16384);
      // document_ids/document_hashes are the size-dominant fields at this
      // cardinality — confirm they're actually present at full cardinality
      // (proves this is a real max-cardinality measurement, not a vacuous one).
      expect((ruleEventPayload.document_ids as unknown[]).length).toBe(100);
      expect((ruleEventPayload.document_hashes as unknown[]).length).toBe(100);

      // _signers rides ONLY the job -> connector_artifact.metadata path (no
      // size cap there), at full cardinality.
      const jobPayload = submitJobMock.mock.calls[0][0].payload as Record<string, unknown>;
      expect((jobPayload._signers as unknown[]).length).toBe(20);
    });
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
// CTO Decision Record (docusign-bilateral-2026-08) — R4 classification, R3
// flag-gated inbound declared-hash anchoring, R5 orphan observability, and
// the migration-0424 nonce tenant-scoping. This whole feature ships behind
// ENABLE_DOCUSIGN_INBOUND (default false, mockConfig reset to false in
// beforeEach above) and is not going live this cycle.
describe('POST /webhooks/docusign — inbound classification (docusign-bilateral-2026-08)', () => {
  it('classifies an envelope owned by the org\'s own connected account as outbound, even when the customrecipient marker claims inbound — and reaches the DB exactly as many times as before this feature (backward-compat)', async () => {
    dbFromMock.mockReturnValueOnce(
      integrationLookup({ id: 'int-1', org_id: ORG_ID, account_id: 'acct-1', hmac_keys: null }),
    );
    dbFromMock.mockReturnValueOnce(noInheritedMarkers());
    dbFromMock.mockReturnValueOnce(nonceInsert());
    rpcMock.mockResolvedValueOnce({ data: 'evt-outbound-marker', error: null });
    submitJobMock.mockResolvedValueOnce('job-outbound-marker');

    // No senderAccountId declared — the common case, and also the fast path:
    // sendingAccountId falls back to accountId, which IS this integration's
    // own account by construction (findIntegration matched on it), so
    // classification never queries org_integrations/member_integrations
    // again. The `?customrecipient` marker is present but must NOT change
    // the outcome (marker cannot upgrade trust).
    const body = validBody();
    const res = await request(createApp())
      .post('/webhooks/docusign?customrecipient=1')
      .set('Content-Type', 'application/json')
      .set('X-DocuSign-Signature-1', sign(body))
      .send(body);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true }); // no `inbound` key — identical shape to the pre-existing outbound response
    // Exactly the pre-existing outbound call count: integration lookup,
    // inherited-marker lookup, nonce insert. Zero extra classification
    // queries for the fast path.
    expect(dbFromMock).toHaveBeenCalledTimes(3);
    expect(rpcMock).toHaveBeenCalledWith('enqueue_rule_event', expect.anything());
    expect(submitJobMock).toHaveBeenCalled();
    // The marker/classification disagreement is logged, never acted on.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ envelopeId: 'env-1' }),
      expect.stringContaining('classifying outbound'),
    );
  });

  it('classifies an envelope owned by a DIFFERENT DocuSign account as inbound, and — flag OFF — acknowledges 200 with NO nonce consumed and NO durable write', async () => {
    dbFromMock.mockReturnValueOnce(
      integrationLookup({ id: 'int-1', org_id: ORG_ID, account_id: 'acct-1', hmac_keys: null }),
    );
    dbFromMock.mockReturnValueOnce(noInheritedMarkers());
    // classifyDirection's own-account cross-check: neither table lists the
    // foreign sending account among this org's connected accounts.
    dbFromMock.mockReturnValueOnce(integrationLookup([{ account_id: 'acct-1' }])); // org_integrations
    dbFromMock.mockReturnValueOnce(integrationLookup(null)); // member_integrations

    const body = bodyWithSenderAccount({ senderAccountId: 'acct-FOREIGN' });
    const res = await postSignedBody(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, inbound: true, skipped: 'flag_disabled' });
    // Exactly 4 DB calls — integration lookup, inherited-marker lookup, and
    // the two own-account cross-check queries. Critically, NO 5th call: the
    // nonce table is never touched.
    expect(dbFromMock).toHaveBeenCalledTimes(4);
    expect(calledWithTable(dbFromMock, 'docusign_webhook_nonces')).toBe(false);
    expect(rpcMock).not.toHaveBeenCalled();
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('anchors via the declared-hash path when flag is ON: sets fingerprint_source=issuer_record_attestation via _direction metadata, and never engages the document-fetch job pathway', async () => {
    mockConfig.enableDocusignInbound = true;
    dbFromMock.mockReturnValueOnce(
      integrationLookup({ id: 'int-1', org_id: ORG_ID, account_id: 'acct-1', hmac_keys: null }),
    );
    dbFromMock.mockReturnValueOnce(noInheritedMarkers());
    dbFromMock.mockReturnValueOnce(integrationLookup([{ account_id: 'acct-1' }])); // org_integrations (own)
    dbFromMock.mockReturnValueOnce(integrationLookup(null)); // member_integrations (own)
    dbFromMock.mockReturnValueOnce(nonceInsert());
    rpcMock.mockResolvedValueOnce({ data: 'artifact-inbound-1', error: null });

    const body = bodyWithSenderAccount({ senderAccountId: 'acct-FOREIGN', envelopeId: 'env-inbound-1' });
    const res = await postSignedBody(body);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true, inbound: true });
    expect(rpcMock).toHaveBeenCalledWith('enqueue_connector_artifact', expect.objectContaining({
      p_org_id: ORG_ID,
      p_source: 'docusign',
      p_external_ref: 'env-inbound-1',
      p_external_revision: null,
      p_fingerprint_sha256: VALID_DOC_SHA256, // the DECLARED hash — never a server-fetched one
      p_metadata: expect.objectContaining({
        _direction: 'inbound',
        _sending_account_id: 'acct-FOREIGN',
      }),
    }));
    // R3: the ONLY caller of the DocuSign document-fetch API is the
    // `docusign.envelope_completed` job (docusign-envelope-completed.ts ->
    // integrations/connectors/docusign.ts -> fetchDocusignCombinedDocument).
    // This webhook module has no other path to that function, so proving the
    // job was never submitted IS the proof the fetch API was never engaged.
    expect(submitJobMock).not.toHaveBeenCalled();
    // fingerprint_source is NOT set by this handler directly — it's set by
    // connector-artifact-drain.ts's defaultMaterializeAnchor, keyed off the
    // SAME `_direction: 'inbound'` marker asserted above (see that file's
    // own dedicated test coverage for the anchor-insert assertion).
  });

  // F1-heal (SCRUM-3818 go-live gate): "outbound-then-inbound ordering ->
  // inbound does not downgrade a verified row." The real outbound job
  // (docusign-envelope-completed.ts) already won the `(org_id, source,
  // external_ref, revision)` slot for this envelope with its real,
  // server-measured fingerprint BEFORE this (forged or otherwise
  // non-owning) inbound delivery arrives. `enqueue_connector_artifact`'s
  // `ON CONFLICT DO NOTHING` means the RPC call below returns the EXISTING
  // (real) row's id, unchanged — and this handler does nothing further with
  // that id (see enqueueInboundDeclaredHashArtifact's call site: the
  // returned value is awaited and discarded, never read back or written).
  // This test pins that structurally, not just by inspection: the same
  // `dbFromMock` call count as the "wins the race" test above (5 — no 6th
  // call attempting to read back or update `connector_artifact`) proves this
  // path CANNOT rewrite/downgrade whatever row already exists at that key.
  it('outbound-then-inbound ordering: when enqueue_connector_artifact returns a PRE-EXISTING (real, outbound-owned) row id via ON CONFLICT DO NOTHING, this handler makes no further write and cannot downgrade it', async () => {
    mockConfig.enableDocusignInbound = true;
    dbFromMock.mockReturnValueOnce(
      integrationLookup({ id: 'int-1', org_id: ORG_ID, account_id: 'acct-1', hmac_keys: null }),
    );
    dbFromMock.mockReturnValueOnce(noInheritedMarkers());
    dbFromMock.mockReturnValueOnce(integrationLookup([{ account_id: 'acct-1' }])); // org_integrations (own)
    dbFromMock.mockReturnValueOnce(integrationLookup(null)); // member_integrations (own)
    dbFromMock.mockReturnValueOnce(nonceInsert());
    // ON CONFLICT DO NOTHING: the RPC returns the id of the row that ACTUALLY
    // won the INSERT — the real outbound job's prior write — not a new row
    // for this (later, non-owning) inbound delivery.
    rpcMock.mockResolvedValueOnce({ data: 'existing-outbound-artifact', error: null });

    const body = bodyWithSenderAccount({ senderAccountId: 'acct-FOREIGN', envelopeId: 'env-already-outbound-1' });
    const res = await postSignedBody(body);

    // Structurally unaware it lost the race — the handler's own success
    // response is identical either way, which is exactly the point: it never
    // branches on "did my write actually win," so it has no path to act on a
    // returned id that isn't its own.
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true, inbound: true });
    // Exactly the same 5 calls as the "wins the race" test above — no read-
    // back, no update, no 6th connector_artifact call of any kind.
    expect(dbFromMock).toHaveBeenCalledTimes(5);
    expect(calledWithTable(dbFromMock, 'connector_artifact')).toBe(false);
  });

  it('ambiguous/unresolvable (own-account lookup DB error) classifies inbound (fail-safe) — and orphan-drops with a DISTINCT signal, not a crash, when it also cannot resolve a usable declared hash', async () => {
    mockConfig.enableDocusignInbound = true;
    dbFromMock.mockReturnValueOnce(
      integrationLookup({ id: 'int-1', org_id: ORG_ID, account_id: 'acct-1', hmac_keys: null }),
    );
    dbFromMock.mockReturnValueOnce(noInheritedMarkers());
    // Own-account cross-check itself fails (DB error) — classification must
    // fail SAFE to inbound rather than throw or silently trust outbound.
    dbFromMock.mockReturnValueOnce(integrationLookup(null, { message: 'db unavailable' }));
    dbFromMock.mockReturnValueOnce(integrationLookup(null));

    // Two distinct declared hashes -> extractSingleDeclaredHash finds no
    // SINGLE usable value -> compound-ambiguous case: orphan-drop, not a crash.
    const body = bodyWithSenderAccount({
      senderAccountId: 'acct-FOREIGN',
      envelopeId: 'env-ambiguous-1',
      sha256s: [VALID_DOC_SHA256, 'c'.repeat(64)],
    });

    const res = await postSignedBody(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, inbound: true, skipped: 'no_usable_declared_hash' });
    expect(rpcMock).not.toHaveBeenCalled();
    expect(submitJobMock).not.toHaveBeenCalled();
    expect(calledWithTable(dbFromMock, 'docusign_webhook_nonces')).toBe(false);
    // R5: the distinct inbound-orphan-drop signal fired, carrying the
    // classification's own failure reason through — not the generic
    // "no_usable_declared_hash" default, proving the ambiguous-lookup reason
    // actually propagates.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        docusign_inbound_orphan_drop: true,
        envelopeId: 'env-ambiguous-1',
        reason: 'own_account_lookup_failed',
      }),
      expect.any(String),
    );
  });

  it('orphan-drops a foreign-account envelope with zero declared hashes (flag ON) without consuming a nonce', async () => {
    mockConfig.enableDocusignInbound = true;
    dbFromMock.mockReturnValueOnce(
      integrationLookup({ id: 'int-1', org_id: ORG_ID, account_id: 'acct-1', hmac_keys: null }),
    );
    dbFromMock.mockReturnValueOnce(noInheritedMarkers());
    dbFromMock.mockReturnValueOnce(integrationLookup([{ account_id: 'acct-1' }]));
    dbFromMock.mockReturnValueOnce(integrationLookup(null));

    const body = JSON.stringify({
      event: 'envelope-completed',
      envelopeId: 'env-no-hash',
      accountId: 'acct-1',
      status: 'completed',
      sender: { email: 'legal@example.com', accountId: 'acct-FOREIGN' },
      envelopeDocuments: [{ documentId: 'doc-1', name: 'doc.pdf' }], // no sha256
    });
    const res = await postSignedBody(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, inbound: true, skipped: 'no_usable_declared_hash' });
    expect(calledWithTable(dbFromMock, 'docusign_webhook_nonces')).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ docusign_inbound_orphan_drop: true, reason: 'no_usable_declared_hash' }),
      expect.any(String),
    );
  });

  it('tenant-scopes the nonce write (migration 0424): the inserted row carries account_id alongside envelope_id/event_id/generated_at', async () => {
    dbFromMock.mockReturnValueOnce(
      integrationLookup({ id: 'int-1', org_id: ORG_ID, account_id: 'acct-1', hmac_keys: null }),
    );
    dbFromMock.mockReturnValueOnce(noInheritedMarkers());
    const nonceInsertFn = vi.fn().mockResolvedValue({ data: null, error: null });
    dbFromMock.mockReturnValueOnce({ insert: nonceInsertFn });
    rpcMock.mockResolvedValueOnce({ data: 'evt-nonce-scope', error: null });
    submitJobMock.mockResolvedValueOnce('job-nonce-scope');

    const body = validBody();
    const res = await postSignedBody(body);

    expect(res.status).toBe(202);
    expect(nonceInsertFn).toHaveBeenCalledWith({
      account_id: 'acct-1',
      envelope_id: 'env-1',
      event_id: 'envelope-completed',
      generated_at: expect.stringMatching(/^[a-f0-9]{64}$/), // payloadHash fallback — no generatedDateTime in validBody()
    });
  });

  it('duplicate inbound delivery (nonce 23505) returns 200 without re-anchoring', async () => {
    mockConfig.enableDocusignInbound = true;
    dbFromMock.mockReturnValueOnce(
      integrationLookup({ id: 'int-1', org_id: ORG_ID, account_id: 'acct-1', hmac_keys: null }),
    );
    dbFromMock.mockReturnValueOnce(noInheritedMarkers());
    dbFromMock.mockReturnValueOnce(integrationLookup([{ account_id: 'acct-1' }]));
    dbFromMock.mockReturnValueOnce(integrationLookup(null));
    dbFromMock.mockReturnValueOnce(nonceInsert({ code: '23505' }));

    const body = bodyWithSenderAccount({ senderAccountId: 'acct-FOREIGN', envelopeId: 'env-dup-inbound' });
    const res = await postSignedBody(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, duplicate: true, inbound: true });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  // F1 (security review, docusign-bilateral-2026-08) — cross-tenant regression
  // pin. HMAC verification proves this request is signed by the CALLER's own
  // org's key (here, ORG_ID's — resolved via findIntegration('acct-1')); it
  // proves nothing about the payload's claimed `senderAccountId`, which is
  // attacker-authored body content. An attacker at ORG_ID could set
  // `senderAccountId` to SUB_ORG_ID's REAL connected account, impersonating
  // that org as the envelope's owner. This must NEVER cause the enqueued
  // artifact to land in SUB_ORG_ID's namespace — `p_org_id` is always
  // `integration.org_id` (the HMAC-verified caller's own org), never anything
  // derived from the spoofable `senderAccountId` value. True by construction
  // (enqueueInboundDeclaredHashArtifact hardcodes `p_org_id: args.integration.org_id`
  // and never threads `sendingAccountId` into that field) — pinned here so a
  // future refactor that accidentally wires org_id from classification output
  // fails this test immediately.
  it('a senderAccountId spoofing another real org\'s connected account still lands the artifact in the CALLER\'s own org_id, never the impersonated org', async () => {
    mockConfig.enableDocusignInbound = true;
    dbFromMock.mockReturnValueOnce(
      integrationLookup({ id: 'int-1', org_id: ORG_ID, account_id: 'acct-1', hmac_keys: null }),
    );
    dbFromMock.mockReturnValueOnce(noInheritedMarkers());
    dbFromMock.mockReturnValueOnce(integrationLookup([{ account_id: 'acct-1' }]));
    dbFromMock.mockReturnValueOnce(integrationLookup(null));
    dbFromMock.mockReturnValueOnce(nonceInsert());
    rpcMock.mockResolvedValueOnce({ data: 'artifact-cross-tenant-1', error: null });

    // acct-SUB-ORG-REAL stands in for a real DocuSign account genuinely
    // connected to SUB_ORG_ID — the attacker (posting as ORG_ID, HMAC-signed
    // with ORG_ID's own key) claims IT as the envelope's sender.
    const body = bodyWithSenderAccount({
      senderAccountId: 'acct-SUB-ORG-REAL',
      envelopeId: 'env-cross-tenant-spoof',
    });
    const res = await postSignedBody(body);

    expect(res.status).toBe(202);
    expect(rpcMock).toHaveBeenCalledWith('enqueue_connector_artifact', expect.objectContaining({
      // The load-bearing assertion: org_id is the HMAC-verified caller's own
      // org (ORG_ID), NEVER SUB_ORG_ID or the spoofed account's org.
      p_org_id: ORG_ID,
      p_metadata: expect.objectContaining({
        _sending_account_id: 'acct-SUB-ORG-REAL', // the CLAIM is recorded...
      }),
    }));
    // ...but never leaks into the write's tenant scope.
    const call = rpcMock.mock.calls.find((c) => c[0] === 'enqueue_connector_artifact');
    expect((call?.[1] as Record<string, unknown>)?.p_org_id).not.toBe(SUB_ORG_ID);
  });
});

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

// ── extractSigners unit tests (CTO Decision Record R6) ──────────────

describe('extractSigners', () => {
  it('extracts recipient_id_guid/user_id/status/signed_at from recipients.signers', () => {
    const body = JSON.stringify({
      event: 'envelope-completed',
      envelopeSummary: {
        recipients: {
          signers: [{
            recipientIdGuid: testGuid(1),
            userId: testGuid(101),
            status: 'completed',
            signedDateTime: '2026-05-27T10:00:00Z',
            name: 'Should Not Appear',
            email: 'should-not-appear@example.com',
          }],
        },
      },
    });
    const result = extractSigners(body);
    expect(result).toEqual([{
      recipient_id_guid: testGuid(1),
      user_id: testGuid(101),
      status: 'completed',
      signed_at: '2026-05-27T10:00:00Z',
    }]);
  });

  it('never includes name or email even when present on the raw recipient', () => {
    const body = JSON.stringify({
      event: 'envelope-completed',
      envelopeSummary: {
        recipients: {
          signers: [{
            recipientIdGuid: testGuid(2),
            status: 'completed',
            name: 'PII Name Marker',
            email: 'pii-marker@example.com',
          }],
        },
      },
    });
    const result = extractSigners(body);
    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty('name');
    expect(result[0]).not.toHaveProperty('email');
    expect(JSON.stringify(result)).not.toContain('PII Name Marker');
    expect(JSON.stringify(result)).not.toContain('pii-marker@example.com');
  });

  it('omits user_id for a pure email-link signer (no DocuSign platform account)', () => {
    const body = JSON.stringify({
      event: 'envelope-completed',
      envelopeSummary: {
        recipients: {
          signers: [{ recipientIdGuid: testGuid(3), status: 'sent' }],
        },
      },
    });
    const result = extractSigners(body);
    expect(result).toEqual([{ recipient_id_guid: testGuid(3), status: 'sent' }]);
    expect(result[0]).not.toHaveProperty('user_id');
    expect(result[0]).not.toHaveProperty('signed_at');
  });

  it('skips entries missing recipientIdGuid or status', () => {
    const body = JSON.stringify({
      event: 'envelope-completed',
      envelopeSummary: {
        recipients: {
          signers: [
            { status: 'completed' },
            { recipientIdGuid: testGuid(4) },
            { recipientIdGuid: testGuid(5), status: 'completed' },
          ],
        },
      },
    });
    expect(extractSigners(body)).toEqual([{ recipient_id_guid: testGuid(5), status: 'completed' }]);
  });

  // PR #2474 review, HIGH: the entire "no name/email ever persisted" guarantee
  // rests on recipient_id_guid/user_id being structurally GUID-shaped, not
  // merely present under the right key. A mis-slotted email/name-shaped value
  // must be SKIPPED (fail-soft — identical treatment to a missing required
  // field), never persisted, at the actual DB-write boundary (_signers on the
  // job payload — see the "signer capture (R6)" describe block above for the
  // full webhook->job assertion). This unit test covers extractSigners itself.
  it('skips an entry whose recipientIdGuid is email/name-shaped instead of a GUID', () => {
    const body = JSON.stringify({
      event: 'envelope-completed',
      envelopeSummary: {
        recipients: {
          signers: [
            { recipientIdGuid: 'jane.doe@example.com', status: 'completed' },
            { recipientIdGuid: 'Jane Doe', status: 'completed' },
            { recipientIdGuid: testGuid(6), status: 'completed' },
          ],
        },
      },
    });
    const result = extractSigners(body);
    expect(result).toEqual([{ recipient_id_guid: testGuid(6), status: 'completed' }]);
    expect(JSON.stringify(result)).not.toContain('jane.doe@example.com');
    expect(JSON.stringify(result)).not.toContain('Jane Doe');
  });

  it('drops an entry whose user_id is email-shaped, even when recipientIdGuid is a valid GUID', () => {
    const body = JSON.stringify({
      event: 'envelope-completed',
      envelopeSummary: {
        recipients: {
          signers: [{
            recipientIdGuid: testGuid(7),
            userId: 'mistakenly-an-email@example.com',
            status: 'completed',
          }],
        },
      },
    });
    // user_id fails the GUID regex, so the whole candidate fails safeParse —
    // the entry is skipped entirely (fail-soft), never persisted with a
    // dropped-user_id partial row.
    expect(extractSigners(body)).toEqual([]);
  });

  it('dedupes repeated recipientIdGuid values within one delivery (resend/bounce)', () => {
    const body = JSON.stringify({
      event: 'envelope-completed',
      envelopeSummary: {
        recipients: {
          signers: [
            { recipientIdGuid: testGuid(9), status: 'sent' },
            { recipientIdGuid: testGuid(9), status: 'completed' },
            { recipientIdGuid: testGuid(10), status: 'completed' },
          ],
        },
      },
    });
    const result = extractSigners(body);
    expect(result).toHaveLength(2);
    // First occurrence wins.
    expect(result[0]).toEqual({ recipient_id_guid: testGuid(9), status: 'sent' });
    expect(result[1]).toEqual({ recipient_id_guid: testGuid(10), status: 'completed' });
  });

  it('caps at 20 entries', () => {
    const signers = Array.from({ length: 30 }, (_, i) => ({
      recipientIdGuid: testGuid(i),
      status: 'completed',
    }));
    const body = JSON.stringify({
      event: 'envelope-completed',
      envelopeSummary: { recipients: { signers } },
    });
    const result = extractSigners(body);
    expect(result).toHaveLength(20);
    expect(result.map((s) => s.recipient_id_guid)).toEqual(
      Array.from({ length: 20 }, (_, i) => testGuid(i)),
    );
  });

  it('returns [] for non-signed envelopes (no recipients block)', () => {
    const body = JSON.stringify({
      event: 'envelope-completed',
      envelopeId: 'env-1',
      accountId: 'acct-1',
      status: 'completed',
      envelopeDocuments: [{ documentId: 'combined' }],
    });
    expect(extractSigners(body)).toEqual([]);
  });

  it('returns [] for an empty signers array', () => {
    const body = JSON.stringify({
      event: 'envelope-completed',
      envelopeSummary: { recipients: { signers: [] } },
    });
    expect(extractSigners(body)).toEqual([]);
  });

  it('returns [] for empty recipients', () => {
    const body = JSON.stringify({
      event: 'envelope-completed',
      envelopeSummary: { recipients: {} },
    });
    expect(extractSigners(body)).toEqual([]);
  });

  it('returns [] for invalid JSON', () => {
    expect(extractSigners('not json')).toEqual([]);
  });

  it('handles Buffer input', () => {
    const body = Buffer.from(JSON.stringify({
      event: 'envelope-completed',
      envelopeSummary: {
        recipients: {
          signers: [{ recipientIdGuid: testGuid(8), status: 'completed' }],
        },
      },
    }));
    expect(extractSigners(body)).toEqual([{ recipient_id_guid: testGuid(8), status: 'completed' }]);
  });

  it('does not read recipients.carbonCopies (mirrors extractNotaryData, which does not either)', () => {
    const body = JSON.stringify({
      event: 'envelope-completed',
      envelopeSummary: {
        recipients: {
          carbonCopies: [{ recipientIdGuid: 'guid-cc', status: 'sent' }],
        },
      },
    });
    expect(extractSigners(body)).toEqual([]);
  });
});
