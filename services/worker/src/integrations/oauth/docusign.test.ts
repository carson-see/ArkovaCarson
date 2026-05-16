/**
 * DocuSign OAuth + Connect helper tests (SCRUM-1101).
 */
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildDocusignAuthorizationUrl,
  exchangeDocusignCode,
  refreshDocusignAccessToken,
  getDocusignUserInfo,
  fetchDocusignCombinedDocument,
  verifyDocusignConnectHmac,
  parseDocusignConnectPayload,
  provisionConnectListener,
  DocusignApiError,
  DocusignConfigError,
} from './docusign.js';

const ENV = {
  DOCUSIGN_INTEGRATION_KEY: 'ik_test',
  DOCUSIGN_CLIENT_SECRET: 'client_secret',
};

function sign(body: string | Buffer, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('base64');
}

describe('buildDocusignAuthorizationUrl', () => {
  it('throws when OAuth client env is missing', () => {
    expect(() =>
      buildDocusignAuthorizationUrl({
        redirectUri: 'https://arkova.ai/cb',
        state: 'nonce',
        env: {},
      }),
    ).toThrow(DocusignConfigError);
  });

  it('uses demo auth host by default and includes offline refresh scope', () => {
    const url = buildDocusignAuthorizationUrl({
      redirectUri: 'https://arkova.ai/cb',
      state: 'nonce-1',
      env: ENV,
    });
    expect(url).toContain('https://account-d.docusign.com/oauth/auth');
    expect(url).toContain('client_id=ik_test');
    expect(url).toContain('state=nonce-1');
    expect(new URL(url).searchParams.get('scope')).toBe('signature extended openid email');
  });
});

describe('DocuSign token flows', () => {
  it('exchanges authorization codes with Basic auth', async () => {
    let authHeader = '';
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      authHeader = String(init?.headers && (init.headers as Record<string, string>).Authorization);
      return new Response(
        JSON.stringify({
          access_token: 'at',
          refresh_token: 'rt',
          expires_in: 28800,
          token_type: 'Bearer',
        }),
        { status: 200 },
      );
    };

    const tokens = await exchangeDocusignCode({
      code: 'code-1',
      redirectUri: 'https://arkova.ai/cb',
      deps: { env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch },
    });

    expect(authHeader).toMatch(/^Basic /);
    expect(tokens.refresh_token).toBe('rt');
  });

  it('throws DocusignApiError on token refresh failure', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });

    await expect(
      refreshDocusignAccessToken({
        refreshToken: 'bad',
        deps: { env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch },
      }),
    ).rejects.toBeInstanceOf(DocusignApiError);
  });
});

describe('getDocusignUserInfo', () => {
  it('parses account base_uri discovery', async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          sub: 'user-1',
          email: 'admin@example.com',
          accounts: [
            {
              account_id: 'acct-1',
              account_name: 'Acme Legal',
              base_uri: 'https://demo.docusign.net',
              is_default: true,
            },
          ],
        }),
        { status: 200 },
      );

    const info = await getDocusignUserInfo({
      accessToken: 'at',
      deps: { env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch },
    });

    expect(info.accounts[0]?.base_uri).toBe('https://demo.docusign.net');
  });
});

describe('fetchDocusignCombinedDocument', () => {
  it('downloads the combined PDF bytes from the eSignature REST API', async () => {
    let requestedUrl = '';
    const fetchImpl = async (url: string | URL | Request) => {
      requestedUrl = String(url);
      return new Response(new Uint8Array([37, 80, 68, 70]), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      });
    };

    const doc = await fetchDocusignCombinedDocument({
      baseUri: 'https://demo.docusign.net/',
      accountId: 'acct-1',
      envelopeId: 'env-1',
      accessToken: 'at',
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });

    expect(requestedUrl).toBe(
      'https://demo.docusign.net/restapi/v2.1/accounts/acct-1/envelopes/env-1/documents/combined',
    );
    expect(doc.contentType).toBe('application/pdf');
    expect(doc.bytes.toString('utf8')).toBe('%PDF');
  });
});

describe('verifyDocusignConnectHmac', () => {
  it('accepts the DocuSign base64 HMAC over the raw body', () => {
    const body = JSON.stringify({ event: 'envelope-completed', envelopeId: 'env-1' });
    expect(
      verifyDocusignConnectHmac({
        rawBody: body,
        signature: sign(body, 'whsec'),
        secret: 'whsec',
      }),
    ).toBe(true);
  });

  it('rejects tampered payloads', () => {
    const body = JSON.stringify({ event: 'envelope-completed', envelopeId: 'env-1' });
    const signature = sign(body, 'whsec');
    expect(
      verifyDocusignConnectHmac({
        rawBody: body.replace('env-1', 'env-2'),
        signature,
        secret: 'whsec',
      }),
    ).toBe(false);
  });
});

describe('parseDocusignConnectPayload', () => {
  it('normalizes classic completed-envelope JSON', () => {
    const event = parseDocusignConnectPayload(
      JSON.stringify({
        event: 'envelope-completed',
        envelopeId: 'env-1',
        accountId: 'acct-1',
        status: 'completed',
        sender: { email: 'LEGAL@acme.com' },
        envelopeDocuments: [{ documentId: 'combined', name: 'msa.pdf' }],
      }),
    );

    expect(event.envelopeId).toBe('env-1');
    expect(event.accountId).toBe('acct-1');
    expect(event.sender?.email).toBe('LEGAL@acme.com');
  });

  it('normalizes Connect 2.0 data envelopes', () => {
    const event = parseDocusignConnectPayload(
      JSON.stringify({
        event: 'envelope-completed',
        data: { envelopeId: 'env-2', accountId: 'acct-2', status: 'completed' },
      }),
    );

    expect(event).toMatchObject({ envelopeId: 'env-2', accountId: 'acct-2' });
  });

  it('rejects non-completed events', () => {
    expect(() =>
      parseDocusignConnectPayload(
        JSON.stringify({
          event: 'envelope-sent',
          data: { envelopeId: 'env-2', accountId: 'acct-2', status: 'sent' },
        }),
      ),
    ).toThrow(/completed envelope/i);
  });
});

describe('provisionConnectListener', () => {
  const PROVISION_ENV = {
    ...ENV,
    DOCUSIGN_CONNECT_HMAC_SECRET: 'hmac-secret-123',
    WORKER_PUBLIC_URL: 'https://arkova-worker.example.com',
  };

  it('creates a new Connect listener when none exist', async () => {
    let postBody: unknown = null;
    const requestedUrls: string[] = [];

    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requestedUrls.push(url);

      // GET list — no existing listeners
      if (init?.method !== 'POST' && init?.method !== 'PUT') {
        return new Response(
          JSON.stringify({ configurations: [] }),
          { status: 200 },
        );
      }

      // POST create
      if (init?.method === 'POST') {
        postBody = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({ connectId: '99001', name: 'Arkova Connect' }),
          { status: 201 },
        );
      }

      return new Response('{}', { status: 404 });
    };

    const result = await provisionConnectListener({
      accessToken: 'at-test',
      baseUri: 'https://demo.docusign.net',
      accountId: 'acct-1',
      deps: { env: PROVISION_ENV, fetchImpl: fetchImpl as unknown as typeof fetch },
    });

    expect(result.connectId).toBe('99001');
    expect(result.action).toBe('created');
    // Verify the POST URL is correct
    expect(requestedUrls).toContain(
      'https://demo.docusign.net/restapi/v2.1/accounts/acct-1/connect',
    );
    // Verify payload shape
    const body = postBody as Record<string, unknown>;
    expect(body.urlToPublishTo).toBe('https://arkova-worker.example.com/webhooks/docusign');
    expect(body.allUsers).toBe('true');
    expect(body.allowEnvelopePublish).toBe('true');
    expect(body.requiresAcknowledgement).toBe('true');
    expect(body.events).toEqual(['envelope-completed']);
    expect(body.eventData).toMatchObject({ format: 'json', version: 'restv2.1' });
  });

  it('updates an existing Connect listener when URL matches (idempotent)', async () => {
    let putBody: unknown = null;
    let method: string | undefined;

    const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
      // GET list — one existing listener with matching URL
      if (!init?.method || init.method === 'GET') {
        return new Response(
          JSON.stringify({
            configurations: [
              {
                connectId: '22152148',
                urlToPublishTo: 'https://arkova-worker.example.com/webhooks/docusign',
                name: 'Old Config',
              },
            ],
          }),
          { status: 200 },
        );
      }

      // PUT update
      if (init?.method === 'PUT') {
        method = 'PUT';
        putBody = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({ connectId: '22152148', name: 'Arkova Connect' }),
          { status: 200 },
        );
      }

      return new Response('{}', { status: 404 });
    };

    const result = await provisionConnectListener({
      accessToken: 'at-test',
      baseUri: 'https://demo.docusign.net',
      accountId: 'acct-1',
      deps: { env: PROVISION_ENV, fetchImpl: fetchImpl as unknown as typeof fetch },
    });

    expect(result.connectId).toBe('22152148');
    expect(result.action).toBe('updated');
    expect(method).toBe('PUT');
    // Must include connectId in the PUT body for update
    const body = putBody as Record<string, unknown>;
    expect(body.connectId).toBe('22152148');
    expect(body.urlToPublishTo).toBe('https://arkova-worker.example.com/webhooks/docusign');
  });

  it('throws DocusignApiError when the Connect API returns an error', async () => {
    const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
      // GET list succeeds (no existing)
      if (!init?.method || init.method === 'GET') {
        return new Response(JSON.stringify({ configurations: [] }), { status: 200 });
      }
      // POST fails
      return new Response(
        JSON.stringify({ errorCode: 'CONNECT_CONFIG_ERROR', message: 'Invalid config' }),
        { status: 400 },
      );
    };

    await expect(
      provisionConnectListener({
        accessToken: 'at-test',
        baseUri: 'https://demo.docusign.net',
        accountId: 'acct-1',
        deps: { env: PROVISION_ENV, fetchImpl: fetchImpl as unknown as typeof fetch },
      }),
    ).rejects.toBeInstanceOf(DocusignApiError);
  });

  it('throws DocusignConfigError when WORKER_PUBLIC_URL is not set', async () => {
    const fetchImpl = async () => new Response('{}', { status: 200 });

    await expect(
      provisionConnectListener({
        accessToken: 'at-test',
        baseUri: 'https://demo.docusign.net',
        accountId: 'acct-1',
        deps: {
          env: { ...ENV, DOCUSIGN_CONNECT_HMAC_SECRET: 'secret' },
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
      }),
    ).rejects.toBeInstanceOf(DocusignConfigError);
  });
});
