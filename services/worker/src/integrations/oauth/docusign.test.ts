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

type FetchInput = string | URL | Request;

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
    const fetchImpl = async (_url: FetchInput, init?: RequestInit) => {
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
    const fetchImpl = async (url: FetchInput) => {
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
    expect(event.sender?.email).toBe('legal@acme.com');
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

  // Regression — prod 2026-07-26T18:05:35Z: the FIRST real production
  // envelope-completed delivery (founder live-fire test, envelope completed
  // 18:05:15Z) was 401-rejected because DocuSign REST v2.1 SIM payloads nest
  // the envelope status/documents under data.envelopeSummary — one level
  // deeper than every fallback chain looked.
  it('normalizes REST v2.1 SIM payloads (status under data.envelopeSummary)', () => {
    const event = parseDocusignConnectPayload(
      JSON.stringify({
        event: 'envelope-completed',
        apiVersion: 'v2.1',
        uri: '/restapi/v2.1/accounts/acct-3/envelopes/env-3',
        retryCount: 0,
        configurationId: 12345,
        generatedDateTime: '2026-07-26T18:05:35.123Z',
        data: {
          accountId: 'acct-3',
          userId: 'user-3',
          envelopeId: 'env-3',
          envelopeSummary: {
            status: 'completed',
            sender: { email: 'Founder@arkova.io' },
            envelopeDocuments: [{ documentId: '1', name: 'Docusign Test.pdf' }],
          },
        },
      }),
    );

    expect(event.envelopeId).toBe('env-3');
    expect(event.accountId).toBe('acct-3');
    expect(event.status).toBe('completed');
    expect(event.sender?.email).toBe('founder@arkova.io');
    expect(event.envelopeDocuments?.[0]?.name).toBe('Docusign Test.pdf');
  });

  // Regression — prod 2026-07-27 (founder's Connect Logs, envelope
  // 624c1d84…, retryCount 7): the dashboard-created SIM listener delivers a
  // MINIMAL payload — event name + apiVersion + data.{accountId,userId,
  // envelopeId} — with NO status field at any nesting level. The event name
  // itself asserts completion; requiring a redundant status field rejected
  // every real delivery. Status is now corroborative-only: checked when
  // present, event-name-authoritative when absent.
  it('accepts minimal SIM payloads with no status field (event name authoritative)', () => {
    const event = parseDocusignConnectPayload(
      JSON.stringify({
        event: 'envelope-completed',
        apiVersion: 'v2.1',
        uri: '/restapi/v2.1/accounts/5c350ceb-34ee-4ae9-99f2-768c2f289cc8/envelopes/624c1d84-9989-81d3-8218-bcab4aa705ed',
        retryCount: 7,
        configurationId: 21766068,
        generatedDateTime: '2026-07-26T18:05:15.2042177Z',
        data: {
          accountId: '5c350ceb-34ee-4ae9-99f2-768c2f289cc8',
          userId: '4db2bee6-8850-40dc-bc7b-bda5a9e863a9',
          envelopeId: '624c1d84-9989-81d3-8218-bcab4aa705ed',
        },
      }),
    );

    expect(event.envelopeId).toBe('624c1d84-9989-81d3-8218-bcab4aa705ed');
    expect(event.accountId).toBe('5c350ceb-34ee-4ae9-99f2-768c2f289cc8');
    expect(event.status).toBe('completed');
  });

  it('still rejects completed-named events whose PRESENT status contradicts completion', () => {
    expect(() =>
      parseDocusignConnectPayload(
        JSON.stringify({
          event: 'envelope-completed',
          data: { envelopeId: 'env-9', accountId: 'acct-9', status: 'voided' },
        }),
      ),
    ).toThrow(/completed envelope/i);
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

  it('rejects completed events missing the DocuSign account id', () => {
    expect(() =>
      parseDocusignConnectPayload(
        JSON.stringify({
          event: 'envelope-completed',
          envelopeId: 'env-2',
          status: 'completed',
        }),
      ),
    ).toThrow(/completed envelope/i);
  });

  it('rejects completed events with invalid generatedDateTime', () => {
    expect(() =>
      parseDocusignConnectPayload(
        JSON.stringify({
          event: 'envelope-completed',
          envelopeId: 'env-2',
          accountId: 'acct-2',
          status: 'completed',
          generatedDateTime: 'not-a-date',
        }),
      ),
    ).toThrow(/Invalid ISO datetime/i);
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
    let postAuthHeader = '';
    const requestedUrls: string[] = [];

    const fetchImpl = async (input: FetchInput, init?: RequestInit) => {
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
        postAuthHeader = String(
          init.headers && (init.headers as Record<string, string>).Authorization,
        );
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
    expect(body.configurationType).toBe('custom');
    expect(body.allUsers).toBe('true');
    expect(body.allowEnvelopePublish).toBe('true');
    expect(body.enableLog).toBe('true');
    expect(body.includeHMAC).toBe('true');
    // Regression — `hmacSecret` is NOT a field on DocuSign's
    // ConnectCustomConfiguration resource. DocuSign silently ignored it, so
    // sending it created a false belief that provisioning installed Arkova's
    // signing key. It never did — the key is account-side. Do not put a secret
    // back on this payload.
    expect(body).not.toHaveProperty('hmacSecret');
    // `integratorManaged` is opt-in: it only works once an HMAC key exists on
    // the DocuSign account that owns the integration key, so it stays absent by
    // default rather than silently changing which key signs deliveries.
    expect(body).not.toHaveProperty('integratorManaged');
    // Regression — prod 2026-07-25T17:07:37Z (req_80e749c4635aab853ab710a3):
    // DocuSign 400 INVALID_REQUEST_PARAMETER — the modern `events` field is
    // rejected unless the payload also carries deliveryMode "SIM" alongside
    // eventData restv2.1. Without it, listener creation fails on every org
    // connect and no webhooks ever arrive.
    expect(body.deliveryMode).toBe('SIM');
    expect(body.eventData).toEqual({ format: 'json', version: 'restv2.1' });
    expect(postAuthHeader).toBe('Bearer at-test');
    expect(body.requiresAcknowledgement).toBe('true');
    expect(body.envelopeEvents).toEqual(['Completed']);
    expect(body.events).toEqual(['envelope-completed']);
    expect(body.eventData).toMatchObject({ format: 'json', version: 'restv2.1' });
  });

  it('updates an existing Connect listener when URL matches (idempotent)', async () => {
    let putBody: unknown = null;
    let method: string | undefined;

    const fetchImpl = async (_input: FetchInput, init?: RequestInit) => {
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
    // The update path shares one payload builder with create, so it must carry
    // the same guarantee: no secret on an unsupported DocuSign field.
    expect(body).not.toHaveProperty('hmacSecret');
  });

  it('fails closed when DOCUSIGN_CONNECT_HMAC_SECRET is whitespace-only', async () => {
    // A blank secret would provision a listener that reports success while every
    // delivery 401s at /webhooks/docusign.
    const fetchImpl = async () => new Response('{}', { status: 200 });

    await expect(
      provisionConnectListener({
        accessToken: 'at-test',
        baseUri: 'https://demo.docusign.net',
        accountId: 'acct-1',
        deps: {
          env: { ...PROVISION_ENV, DOCUSIGN_CONNECT_HMAC_SECRET: '   ' },
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
      }),
    ).rejects.toThrow(DocusignConfigError);
  });

  it('throws DocusignApiError when the Connect API returns an error', async () => {
    const fetchImpl = async (_input: FetchInput, init?: RequestInit) => {
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

  it('throws DocusignConfigError when DOCUSIGN_CONNECT_HMAC_SECRET is missing', async () => {
    const fetchImpl = async () => new Response('{}', { status: 200 });

    await expect(
      provisionConnectListener({
        accessToken: 'at-test',
        baseUri: 'https://demo.docusign.net',
        accountId: 'acct-1',
        deps: {
          env: { ...ENV, WORKER_PUBLIC_URL: 'https://arkova-worker.example.com' },
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
      }),
    ).rejects.toThrow(DocusignConfigError);

    // Also verify the error message references the env var name
    await expect(
      provisionConnectListener({
        accessToken: 'at-test',
        baseUri: 'https://demo.docusign.net',
        accountId: 'acct-1',
        deps: {
          env: { ...ENV, WORKER_PUBLIC_URL: 'https://arkova-worker.example.com' },
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
      }),
    ).rejects.toThrow(/DOCUSIGN_CONNECT_HMAC_SECRET/);
  });
});
