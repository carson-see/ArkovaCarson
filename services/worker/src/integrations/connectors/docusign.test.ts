/**
 * DocuSign connector service tests (SCRUM-1101).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  completeDocusignOAuthConnection,
  parseDocusignEnvelopeCompletedJobPayload,
  processDocusignEnvelopeCompletedJob,
} from './docusign.js';

const PAYLOAD = {
  org_id: '11111111-1111-4111-8111-111111111111',
  integration_id: 'int-1',
  account_id: 'acct-1',
  envelope_id: 'env-1',
  rule_event_id: 'evt-1',
  document_ids: ['combined'],
};

// R6 (PR #2474 review, HIGH): DocusignCapturedSigner pins recipient_id_guid /
// user_id to a GUID shape. `n` must be an integer — its decimal digits are
// also valid hex, so distinct integers give distinct, valid GUID fixtures.
function testGuid(n: number): string {
  const suffix = String(Math.trunc(n)).padStart(12, '0').slice(-12);
  return `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`;
}

describe('parseDocusignEnvelopeCompletedJobPayload', () => {
  it('accepts the webhook-created retry payload', () => {
    expect(parseDocusignEnvelopeCompletedJobPayload(PAYLOAD)).toMatchObject(PAYLOAD);
  });

  it('rejects missing org_id', () => {
    expect(() =>
      parseDocusignEnvelopeCompletedJobPayload({ ...PAYLOAD, org_id: undefined }),
    ).toThrow();
  });

  // CTO Decision Record (docusign-bilateral-2026-08, ruling R6).
  it('accepts an optional _signers array of pseudonymous GUIDs', () => {
    const withSigners = {
      ...PAYLOAD,
      _signers: [
        { recipient_id_guid: testGuid(1), user_id: testGuid(101), status: 'completed', signed_at: '2026-08-20T10:00:00Z' },
        { recipient_id_guid: testGuid(2), status: 'completed' },
      ],
    };
    expect(parseDocusignEnvelopeCompletedJobPayload(withSigners)).toMatchObject(withSigners);
  });

  it('omits _signers when absent (backward compat — pre-R6 payloads)', () => {
    const result = parseDocusignEnvelopeCompletedJobPayload(PAYLOAD);
    expect(result._signers).toBeUndefined();
  });

  it('rejects more than 20 _signers entries', () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => ({
      recipient_id_guid: testGuid(i),
      status: 'completed',
    }));
    expect(() =>
      parseDocusignEnvelopeCompletedJobPayload({ ...PAYLOAD, _signers: tooMany }),
    ).toThrow();
  });

  it('strips a name/email that somehow rides along on a _signers entry', () => {
    const result = parseDocusignEnvelopeCompletedJobPayload({
      ...PAYLOAD,
      _signers: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately malformed input under test
        { recipient_id_guid: testGuid(3), status: 'completed', name: 'Should Strip', email: 'strip@example.com' } as any,
      ],
    });
    expect(result._signers?.[0]).not.toHaveProperty('name');
    expect(result._signers?.[0]).not.toHaveProperty('email');
  });

  // PR #2474 review, HIGH: a mis-slotted email/name in the GUID field must be
  // rejected by the schema (whole-array .parse() throws — this is the
  // job-payload re-validation gate, stricter than extractSigners' per-entry
  // safeParse skip, since this schema validates the FULL array at once).
  it('rejects a _signers entry whose recipient_id_guid is email-shaped', () => {
    expect(() =>
      parseDocusignEnvelopeCompletedJobPayload({
        ...PAYLOAD,
        _signers: [{ recipient_id_guid: 'jane.doe@example.com', status: 'completed' }],
      }),
    ).toThrow();
  });

  it('rejects a _signers entry whose user_id is email-shaped', () => {
    expect(() =>
      parseDocusignEnvelopeCompletedJobPayload({
        ...PAYLOAD,
        _signers: [{ recipient_id_guid: testGuid(4), user_id: 'jane.doe@example.com', status: 'completed' }],
      }),
    ).toThrow();
  });
});

describe('processDocusignEnvelopeCompletedJob', () => {
  it('fetches the signed envelope PDF and passes bytes to the injected sink', async () => {
    const resolveConnection = vi.fn().mockResolvedValue({
      accessToken: 'at',
      baseUri: 'https://demo.docusign.net',
    });
    const enqueueSignedDocument = vi.fn().mockResolvedValue({ queuedId: 'queue-1' });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([37, 80, 68, 70]), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      }),
    );

    const result = await processDocusignEnvelopeCompletedJob(PAYLOAD, {
      resolveConnection,
      enqueueSignedDocument,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.queuedId).toBe('queue-1');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://demo.docusign.net/restapi/v2.1/accounts/acct-1/envelopes/env-1/documents/combined',
      expect.objectContaining({
        headers: { Authorization: 'Bearer at' },
      }),
    );
    expect(enqueueSignedDocument).toHaveBeenCalledWith(expect.objectContaining({
      orgId: PAYLOAD.org_id,
      integrationId: 'int-1',
      envelopeId: 'env-1',
      documentBytes: Buffer.from('%PDF'),
      contentType: 'application/pdf',
      docusignEnv: 'demo',
    }));
  });

  // CTO Decision Record R6/R7.
  it('derives docusignEnv=prod from a production regional base_uri', async () => {
    const enqueueSignedDocument = vi.fn().mockResolvedValue({ queuedId: 'queue-prod' });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([37, 80, 68, 70]), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      }),
    );

    await processDocusignEnvelopeCompletedJob(PAYLOAD, {
      resolveConnection: vi.fn().mockResolvedValue({ accessToken: 'at', baseUri: 'https://na2.docusign.net' }),
      enqueueSignedDocument,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(enqueueSignedDocument).toHaveBeenCalledWith(
      expect.objectContaining({ docusignEnv: 'prod' }),
    );
  });

  it('threads the job payload _signers through to enqueueSignedDocument as signers', async () => {
    const enqueueSignedDocument = vi.fn().mockResolvedValue({ queuedId: 'queue-signers' });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([37, 80, 68, 70]), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      }),
    );
    const signers = [{ recipient_id_guid: testGuid(1), status: 'completed' }];

    await processDocusignEnvelopeCompletedJob(
      { ...PAYLOAD, _signers: signers },
      {
        resolveConnection: vi.fn().mockResolvedValue({ accessToken: 'at', baseUri: 'https://demo.docusign.net' }),
        enqueueSignedDocument,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );

    expect(enqueueSignedDocument).toHaveBeenCalledWith(
      expect.objectContaining({ signers }),
    );
  });

  it('passes signers as undefined (not []) when the job payload has no _signers (backward compat)', async () => {
    const enqueueSignedDocument = vi.fn().mockResolvedValue({ queuedId: 'queue-no-signers' });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([37, 80, 68, 70]), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      }),
    );

    await processDocusignEnvelopeCompletedJob(PAYLOAD, {
      resolveConnection: vi.fn().mockResolvedValue({ accessToken: 'at', baseUri: 'https://demo.docusign.net' }),
      enqueueSignedDocument,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const call = enqueueSignedDocument.mock.calls[0][0] as Record<string, unknown>;
    expect(call.signers).toBeUndefined();
  });

  it('lets fetch failures reject so job_queue applies backoff and DLQ policy', async () => {
    await expect(
      processDocusignEnvelopeCompletedJob(PAYLOAD, {
        resolveConnection: vi.fn().mockResolvedValue({
          accessToken: 'at',
          baseUri: 'https://demo.docusign.net',
        }),
        enqueueSignedDocument: vi.fn(),
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ error: 'temporarily_unavailable' }), { status: 503 }),
        ) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/document fetch/i);
  });
});

describe('completeDocusignOAuthConnection', () => {
  it('exchanges code, discovers the default account, and delegates encrypted storage', async () => {
    const storeConnection = vi.fn().mockResolvedValue({
      integrationId: 'int-1',
      accountId: 'acct-2',
      accountLabel: 'Default Legal',
    });
    let call = 0;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) {
        return new Response(
          JSON.stringify({
            access_token: 'at',
            refresh_token: 'rt',
            expires_in: 3600,
            token_type: 'Bearer',
            scope: 'signature extended',
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          accounts: [
            {
              account_id: 'acct-1',
              account_name: 'Other',
              base_uri: 'https://demo.docusign.net',
            },
            {
              account_id: 'acct-2',
              account_name: 'Default Legal',
              base_uri: 'https://na3.docusign.net',
              is_default: true,
            },
          ],
        }),
        { status: 200 },
      );
    });

    const result = await completeDocusignOAuthConnection({
      orgId: PAYLOAD.org_id,
      code: 'code-1',
      redirectUri: 'https://arkova.ai/callback',
      deps: {
        env: {
          DOCUSIGN_INTEGRATION_KEY: 'ik',
          DOCUSIGN_CLIENT_SECRET: 'secret',
        },
        fetchImpl: fetchImpl as unknown as typeof fetch,
        storeConnection,
      },
    });

    expect(result.integrationId).toBe('int-1');
    expect(storeConnection).toHaveBeenCalledWith(expect.objectContaining({
      orgId: PAYLOAD.org_id,
      accountId: 'acct-2',
      accountLabel: 'Default Legal',
      baseUri: 'https://na3.docusign.net',
      tokens: expect.objectContaining({
        access_token: 'at',
        refresh_token: 'rt',
        scope: 'signature extended',
        expires_at: expect.any(String),
      }),
    }));
  });
});
