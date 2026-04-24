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
  org_id: '11111111-1111-1111-1111-111111111111',
  integration_id: 'int-1',
  account_id: 'acct-1',
  envelope_id: 'env-1',
  rule_event_id: 'evt-1',
  document_ids: ['combined'],
};

describe('parseDocusignEnvelopeCompletedJobPayload', () => {
  it('accepts the webhook-created retry payload', () => {
    expect(parseDocusignEnvelopeCompletedJobPayload(PAYLOAD)).toMatchObject(PAYLOAD);
  });

  it('rejects missing org_id', () => {
    expect(() =>
      parseDocusignEnvelopeCompletedJobPayload({ ...PAYLOAD, org_id: undefined }),
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
    }));
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
