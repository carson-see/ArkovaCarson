import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  buildDocusignConnectPayload,
  parseArgs,
  runDocusignConnectSmoke,
  signDocusignPayload,
} from './docusign-connect-smoke.js';

const SECRET = 'fixture-docusign-hmac-secret';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('docusign-connect-smoke', () => {
  it('builds a completed-envelope payload without exposing the HMAC secret', () => {
    const payload = buildDocusignConnectPayload({
      accountId: 'acct-1',
      envelopeId: 'env-1',
      eventId: 'evt-1',
      generatedDateTime: '2026-05-14T20:00:00.000Z',
      senderEmail: 'sender@example.com',
    });

    expect(payload).toMatchObject({
      event: 'envelope-completed',
      eventId: 'evt-1',
      envelopeId: 'env-1',
      accountId: 'acct-1',
      status: 'completed',
      sender: { email: 'sender@example.com' },
    });
    expect(payload.envelopeDocuments).toEqual([
      expect.objectContaining({
        documentId: 'combined',
        name: 'arkova-smoke-env-1.pdf',
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(JSON.stringify(payload)).not.toContain(SECRET);
  });

  it('signs the exact raw JSON body with DocuSign base64 HMAC-SHA256', () => {
    const rawBody = '{"event":"envelope-completed"}';
    const signature = signDocusignPayload(rawBody, SECRET);
    const expected = crypto.createHmac('sha256', SECRET).update(rawBody).digest('base64');

    expect(signature).toBe(expected);
  });

  it('defaults to an orphan-only smoke and requires a secret', () => {
    expect(parseArgs([], {
      WORKER_URL: 'https://worker.example.test/',
      DOCUSIGN_CONNECT_HMAC_SECRET: SECRET,
    })).toMatchObject({
      workerUrl: 'https://worker.example.test',
      mode: 'orphan',
      hmacSecret: SECRET,
      allowProcessing: false,
    });

    expect(() => parseArgs([], { WORKER_URL: 'https://worker.example.test' })).toThrow(
      'DOCUSIGN_CONNECT_HMAC_SECRET is required',
    );
  });

  it('requires an explicit account id and allow-processing flag for accepted duplicate smoke', () => {
    const env = {
      WORKER_URL: 'https://worker.example.test',
      DOCUSIGN_CONNECT_HMAC_SECRET: SECRET,
    };

    expect(() => parseArgs(['--mode=accepted-duplicate', '--account-id=acct-1'], env)).toThrow(
      '--allow-processing',
    );
    expect(() => parseArgs(['--mode=accepted-duplicate', '--allow-processing'], env)).toThrow(
      '--account-id',
    );

    expect(parseArgs([
      '--mode=accepted-duplicate',
      '--account-id=acct-1',
      '--allow-processing',
    ], env)).toMatchObject({
      mode: 'accepted-duplicate',
      accountId: 'acct-1',
      allowProcessing: true,
    });
  });

  it('runs the safe orphan smoke: invalid HMAC is rejected and signed unknown account is orphaned', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'invalid_signature' } }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, orphaned: true }));

    const result = await runDocusignConnectSmoke({
      workerUrl: 'https://worker.example.test',
      hmacSecret: SECRET,
      mode: 'orphan',
      accountId: 'arkova-smoke-unknown',
      envelopeId: 'env-smoke',
      eventId: 'evt-smoke',
      generatedDateTime: '2026-05-14T20:00:00.000Z',
      senderEmail: 'smoke.sender@example.com',
      timeoutMs: 1000,
      allowProcessing: false,
    }, { fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.mode).toBe('orphan');
    expect(result.account_id_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.checks).toEqual([
      expect.objectContaining({ name: 'invalid_hmac_rejected', status: 'pass', http_status: 401 }),
      expect.objectContaining({ name: 'signed_unknown_account_orphaned', status: 'pass', http_status: 200 }),
      expect.objectContaining({ name: 'duplicate_delivery_deduped', status: 'skip' }),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://worker.example.test/webhooks/docusign');
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-DocuSign-Signature-1': expect.any(String),
    });
    expect(fetchImpl.mock.calls[0][1]?.headers['X-DocuSign-Signature-1']).not.toBe(
      fetchImpl.mock.calls[1][1]?.headers['X-DocuSign-Signature-1'],
    );
  });

  it('runs accepted duplicate smoke only after explicit processing opt-in', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'invalid_signature' } }))
      .mockResolvedValueOnce(jsonResponse(202, { ok: true, rule_event_id: 'rule-event-1', job_id: 'job-1' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, duplicate: true }));

    const result = await runDocusignConnectSmoke({
      workerUrl: 'https://worker.example.test/',
      hmacSecret: SECRET,
      mode: 'accepted-duplicate',
      accountId: 'acct-1',
      envelopeId: 'env-smoke',
      eventId: 'evt-smoke',
      generatedDateTime: '2026-05-14T20:00:00.000Z',
      senderEmail: 'smoke.sender@example.com',
      timeoutMs: 1000,
      allowProcessing: true,
    }, { fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.mode).toBe('accepted-duplicate');
    expect(result.checks).toEqual([
      expect.objectContaining({ name: 'invalid_hmac_rejected', status: 'pass', http_status: 401 }),
      expect.objectContaining({ name: 'signed_known_account_accepted', status: 'pass', http_status: 202 }),
      expect.objectContaining({ name: 'duplicate_delivery_deduped', status: 'pass', http_status: 200 }),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
