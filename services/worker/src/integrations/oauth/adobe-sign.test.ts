/**
 * Adobe Sign OAuth + webhook-provisioning client tests (SCRUM-1148 follow-up).
 *
 * Written before the implementation (TDD). The webhook-creation assertions are
 * the load-bearing ones: the whole reason this connector never worked is that
 * nothing ever obtained an Adobe `webhookId`, so "the create call returns an id
 * and we surface it" is the behaviour under test, not an incidental detail.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ADOBE_SIGN_DEFAULT_SCOPES,
  AdobeSignApiError,
  AdobeSignConfigError,
  buildAdobeSignAuthorizationUrl,
  createAdobeSignWebhook,
  deleteAdobeSignWebhook,
  exchangeAdobeSignCode,
  fetchAdobeSignUserInfo,
  refreshAdobeSignAccessToken,
  revokeAdobeSignToken,
  buildAdobeSignWebhookConfig,
} from './adobe-sign.js';

const ENV = {
  ADOBE_SIGN_CLIENT_ID: 'adobe-client-id',
  ADOBE_SIGN_CLIENT_SECRET: 'adobe-client-secret',
  ADOBE_SIGN_OAUTH_BASE_URL: 'https://secure.na1.adobesign.com',
  WORKER_PUBLIC_URL: 'https://worker.arkova.test',
} satisfies NodeJS.ProcessEnv;

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

describe('buildAdobeSignAuthorizationUrl', () => {
  it('targets /public/oauth/v2 with the documented query parameters', () => {
    const url = new URL(
      buildAdobeSignAuthorizationUrl({
        redirectUri: 'https://worker.arkova.test/api/v1/integrations/adobe-sign/oauth/callback',
        state: 'signed-state',
        env: ENV,
      }),
    );

    expect(url.origin).toBe('https://secure.na1.adobesign.com');
    expect(url.pathname).toBe('/public/oauth/v2');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('adobe-client-id');
    expect(url.searchParams.get('state')).toBe('signed-state');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://worker.arkova.test/api/v1/integrations/adobe-sign/oauth/callback',
    );
  });

  it('requests the three webhook scopes the connector cannot function without', () => {
    // webhook_write creates the webhook, webhook_read lists/reads it, and
    // webhook_retention is what DELETE requires — disconnect is broken without
    // it, and Adobe only grants scopes asked for at authorization time.
    expect(ADOBE_SIGN_DEFAULT_SCOPES).toEqual(
      expect.arrayContaining(['webhook_read:account', 'webhook_write:account', 'webhook_retention:account']),
    );

    const scope = new URL(
      buildAdobeSignAuthorizationUrl({ redirectUri: 'https://x.test/cb', state: 's', env: ENV }),
    ).searchParams.get('scope');
    expect(scope).toContain('webhook_write:account');
    expect(scope).toContain('webhook_retention:account');
    expect(scope).toContain('agreement_read:account');
  });

  it('throws AdobeSignConfigError — not a generic Error — when the client id is unset', () => {
    expect(() =>
      buildAdobeSignAuthorizationUrl({ redirectUri: 'https://x.test/cb', state: 's', env: {} }),
    ).toThrow(AdobeSignConfigError);
  });

  it('never leaks the client secret into the authorization URL', () => {
    const url = buildAdobeSignAuthorizationUrl({ redirectUri: 'https://x.test/cb', state: 's', env: ENV });
    expect(url).not.toContain('adobe-client-secret');
  });
});

describe('exchangeAdobeSignCode', () => {
  it('posts form-encoded credentials to /oauth/v2/token and returns the shard access point', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        access_token: 'at',
        refresh_token: 'rt',
        token_type: 'Bearer',
        expires_in: 3600,
        api_access_point: 'https://api.na2.adobesign.com/',
        web_access_point: 'https://secure.na2.adobesign.com/',
      }),
    );

    const tokens = await exchangeAdobeSignCode({
      code: 'auth-code',
      redirectUri: 'https://worker.arkova.test/cb',
      deps: { env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch },
    });

    expect(tokens.access_token).toBe('at');
    expect(tokens.refresh_token).toBe('rt');
    // The shard is discovered here, not assumed: every later REST call must go
    // to the account's own api_access_point or Adobe answers 404/401.
    expect(tokens.api_access_point).toBe('https://api.na2.adobesign.com/');

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://secure.na1.adobesign.com/oauth/v2/token');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');
    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('auth-code');
    expect(body.get('client_id')).toBe('adobe-client-id');
    expect(body.get('client_secret')).toBe('adobe-client-secret');
    expect(body.get('redirect_uri')).toBe('https://worker.arkova.test/cb');
  });

  it('throws AdobeSignApiError with a bounded, scrubbed detail on a non-2xx', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'invalid_grant' }, { status: 400 }));
    await expect(
      exchangeAdobeSignCode({
        code: 'bad',
        redirectUri: 'https://x.test/cb',
        deps: { env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch },
      }),
    ).rejects.toMatchObject({ name: 'AdobeSignApiError', status: 400 });
  });

  it('never puts the client secret on the thrown error', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'invalid_client' }, { status: 401 }));
    const err = await exchangeAdobeSignCode({
      code: 'bad',
      redirectUri: 'https://x.test/cb',
      deps: { env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch },
    }).catch((e: unknown) => e);

    expect(JSON.stringify({ m: (err as Error).message, d: (err as AdobeSignApiError).detail })).not.toContain(
      'adobe-client-secret',
    );
  });
});

describe('refreshAdobeSignAccessToken', () => {
  it('posts grant_type=refresh_token to /oauth/v2/refresh', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ access_token: 'at2', token_type: 'Bearer', expires_in: 3600 }),
    );
    const tokens = await refreshAdobeSignAccessToken({
      refreshToken: 'rt',
      deps: { env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch },
    });

    expect(tokens.access_token).toBe('at2');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://secure.na1.adobesign.com/oauth/v2/refresh');
    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('rt');
  });
});

describe('revokeAdobeSignToken', () => {
  it('posts the token to /oauth/v2/revoke', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await revokeAdobeSignToken({
      token: 'rt',
      deps: { env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch },
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://secure.na1.adobesign.com/oauth/v2/revoke');
    expect(new URLSearchParams(init.body as string).get('token')).toBe('rt');
  });

  it('treats an already-invalid token as success — revoke must be idempotent', async () => {
    // Disconnect calls revoke; a 400 "token already revoked" must not strand
    // the user connected. Anything else still throws.
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'invalid_token' }, { status: 400 }));
    await expect(
      revokeAdobeSignToken({ token: 'rt', deps: { env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch } }),
    ).resolves.toBeUndefined();
  });
});

describe('fetchAdobeSignUserInfo', () => {
  it('reads /api/rest/v6/users/me from the account shard, not a hardcoded host', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ id: 'user-123', email: 'admin@example.test', company: 'Example Co' }),
    );
    const info = await fetchAdobeSignUserInfo({
      apiAccessPoint: 'https://api.na2.adobesign.com/',
      accessToken: 'at',
      deps: { env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch },
    });

    expect(info.id).toBe('user-123');
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://api.na2.adobesign.com/api/rest/v6/users/me');
  });
});

describe('buildAdobeSignWebhookConfig', () => {
  it('subscribes to AGREEMENT_WORKFLOW_COMPLETED at ACCOUNT scope, pointed at our webhook route', () => {
    const cfg = buildAdobeSignWebhookConfig(ENV);
    expect(cfg.webhookUrlInfo.url).toBe('https://worker.arkova.test/webhooks/adobe-sign');
    expect(cfg.webhookSubscriptionEvents).toEqual(['AGREEMENT_WORKFLOW_COMPLETED']);
    expect(cfg.scope).toBe('ACCOUNT');
    expect(cfg.state).toBe('ACTIVE');
  });

  it('does NOT ask Adobe to include signed documents in the notification', () => {
    // §1.6 / §1.6A: document bytes must never arrive on the webhook body. The
    // worker fetches and hashes deliberately; an accidental `true` here would
    // push raw documents through the notification path and into any error/log
    // surface that touches the body.
    const cfg = buildAdobeSignWebhookConfig(ENV);
    const agreementEvents = cfg.webhookConditionalParams.webhookAgreementEvents;
    expect(agreementEvents.includeSignedDocuments).toBe(false);
    expect(agreementEvents.includeDocumentsInfo).toBe(false);
  });

  it('throws AdobeSignConfigError when WORKER_PUBLIC_URL is unset', () => {
    expect(() => buildAdobeSignWebhookConfig({ ...ENV, WORKER_PUBLIC_URL: undefined })).toThrow(
      AdobeSignConfigError,
    );
  });

  it('does not double a slash when WORKER_PUBLIC_URL has a trailing slash', () => {
    const cfg = buildAdobeSignWebhookConfig({ ...ENV, WORKER_PUBLIC_URL: 'https://worker.arkova.test///' });
    expect(cfg.webhookUrlInfo.url).toBe('https://worker.arkova.test/webhooks/adobe-sign');
  });
});

describe('createAdobeSignWebhook', () => {
  it('POSTs to /api/rest/v6/webhooks and returns the minted webhook id', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 'WH-ABC123' }, { status: 201 }));

    const result = await createAdobeSignWebhook({
      apiAccessPoint: 'https://api.na2.adobesign.com/',
      accessToken: 'at',
      deps: { env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch },
    });

    expect(result.webhookId).toBe('WH-ABC123');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.na2.adobesign.com/api/rest/v6/webhooks');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.webhookSubscriptionEvents).toEqual(['AGREEMENT_WORKFLOW_COMPLETED']);
    expect((body.webhookUrlInfo as { url: string }).url).toBe('https://worker.arkova.test/webhooks/adobe-sign');
  });

  it('falls back to the Location header when the body omits the id', async () => {
    // Adobe documents BOTH: a body carrying the identifier and a Location
    // header pointing at the created resource. Reading only the body would
    // silently produce a null webhook_id — the exact failure this whole change
    // exists to end.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({}, { status: 201, headers: { location: '/api/rest/v6/webhooks/WH-FROM-HEADER' } }),
    );

    const result = await createAdobeSignWebhook({
      apiAccessPoint: 'https://api.na2.adobesign.com/',
      accessToken: 'at',
      deps: { env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    expect(result.webhookId).toBe('WH-FROM-HEADER');
  });

  it('throws rather than returning an empty id when Adobe returns neither', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, { status: 201 }));
    await expect(
      createAdobeSignWebhook({
        apiAccessPoint: 'https://api.na2.adobesign.com/',
        accessToken: 'at',
        deps: { env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch },
      }),
    ).rejects.toThrow(AdobeSignApiError);
  });

  it('surfaces the Adobe status on failure so a missing webhook_write scope is diagnosable', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ code: 'PERMISSION_DENIED', message: 'missing webhook_write' }, { status: 403 }),
    );
    const err = await createAdobeSignWebhook({
      apiAccessPoint: 'https://api.na2.adobesign.com/',
      accessToken: 'at',
      deps: { env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AdobeSignApiError);
    expect((err as AdobeSignApiError).status).toBe(403);
    expect((err as AdobeSignApiError).detail).toContain('PERMISSION_DENIED');
  });
});

describe('deleteAdobeSignWebhook', () => {
  it('DELETEs /api/rest/v6/webhooks/{id} with the id percent-encoded', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await deleteAdobeSignWebhook({
      apiAccessPoint: 'https://api.na2.adobesign.com/',
      accessToken: 'at',
      webhookId: 'WH/ABC 123',
      deps: { env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch },
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.na2.adobesign.com/api/rest/v6/webhooks/WH%2FABC%20123');
    expect(init.method).toBe('DELETE');
  });

  it('treats 404 as success — a webhook already gone is the desired end state', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 'NOT_FOUND' }, { status: 404 }));
    await expect(
      deleteAdobeSignWebhook({
        apiAccessPoint: 'https://api.na2.adobesign.com/',
        accessToken: 'at',
        webhookId: 'WH-ABC',
        deps: { env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch },
      }),
    ).resolves.toBeUndefined();
  });

  it('throws on any other failure so disconnect can report it', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 'PERMISSION_DENIED' }, { status: 403 }));
    await expect(
      deleteAdobeSignWebhook({
        apiAccessPoint: 'https://api.na2.adobesign.com/',
        accessToken: 'at',
        webhookId: 'WH-ABC',
        deps: { env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch },
      }),
    ).rejects.toThrow(AdobeSignApiError);
  });
});
