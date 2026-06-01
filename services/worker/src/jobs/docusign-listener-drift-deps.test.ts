import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/db.js', () => ({
  db: { from: vi.fn(), rpc: vi.fn() },
}));
vi.mock('../integrations/oauth/docusign.js', async () => {
  const actual = await vi.importActual<typeof import('../integrations/oauth/docusign.js')>(
    '../integrations/oauth/docusign.js',
  );
  return {
    // Keep the real buildArkovaConnectConfig (pure, env-derived) so getExpectedConfig
    // reflects production behavior; only stub the network call.
    buildArkovaConnectConfig: actual.buildArkovaConnectConfig,
    refreshDocusignAccessToken: vi.fn(),
  };
});
vi.mock('../integrations/connectors/docusign-token-store.js', () => ({
  createGcpSecretManagerRefreshTokenStore: vi.fn(() => ({
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  })),
}));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@sentry/node', () => ({
  captureMessage: vi.fn(),
}));

import { makeListenerDriftDeps } from './docusign-listener-drift-deps.js';

const DRIFT_ENV = {
  WORKER_PUBLIC_URL: 'https://arkova-worker.example.com',
} as unknown as NodeJS.ProcessEnv;

function makeDeps(mockFetch: ReturnType<typeof vi.fn>) {
  return makeListenerDriftDeps({
    db: { from: vi.fn() },
    env: DRIFT_ENV,
    fetchImpl: mockFetch as unknown as typeof fetch,
    refreshTokenStore: { get: vi.fn(), put: vi.fn(), delete: vi.fn() },
  });
}

describe('makeListenerDriftDeps — getConnectConfigurations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GETs the /connect endpoint and Zod-parses the configurations array', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            configurations: [
              {
                connectId: 99001,
                urlToPublishTo: 'https://arkova-worker.example.com/webhooks/docusign',
                allowEnvelopePublish: 'true',
                includeHMAC: 'true',
                envelopeEvents: ['Completed'],
                events: ['envelope-completed'],
                eventData: { format: 'json', version: 'restv2.1' },
              },
            ],
          }),
        ),
    });

    const deps = makeDeps(mockFetch);
    const listeners = await deps.getConnectConfigurations({
      baseUri: 'https://demo.docusign.net',
      accountId: 'acct-1',
      accessToken: 'tok',
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe(
      'https://demo.docusign.net/restapi/v2.1/accounts/acct-1/connect',
    );
    // Authorization header carries the bearer token.
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
    expect(listeners).toHaveLength(1);
    expect(listeners[0].connectId).toBe('99001'); // numeric coerced to string
    expect(listeners[0].includeHMAC).toBe('true');
  });

  it('returns an empty array on an empty body (no listeners configured)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(''),
    });
    const deps = makeDeps(mockFetch);
    const listeners = await deps.getConnectConfigurations({
      baseUri: 'https://demo.docusign.net',
      accountId: 'acct-1',
      accessToken: 'tok',
    });
    expect(listeners).toEqual([]);
  });

  it('strips trailing slashes from baseUri before building the URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ configurations: [] })),
    });
    const deps = makeDeps(mockFetch);
    await deps.getConnectConfigurations({
      baseUri: 'https://demo.docusign.net/',
      accountId: 'acct-1',
      accessToken: 'tok',
    });
    expect(mockFetch.mock.calls[0][0]).toBe(
      'https://demo.docusign.net/restapi/v2.1/accounts/acct-1/connect',
    );
  });

  it('throws a status-tagged error on a non-OK Connect response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('unauthorized'),
    });
    const deps = makeDeps(mockFetch);
    await expect(
      deps.getConnectConfigurations({
        baseUri: 'https://demo.docusign.net',
        accountId: 'acct-1',
        accessToken: 'tok',
      }),
    ).rejects.toThrow(/connect_api_401/);
  });

  it('throws connect_api_invalid_json on a non-JSON body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('<html>not json</html>'),
    });
    const deps = makeDeps(mockFetch);
    await expect(
      deps.getConnectConfigurations({
        baseUri: 'https://demo.docusign.net',
        accountId: 'acct-1',
        accessToken: 'tok',
      }),
    ).rejects.toThrow(/invalid_json/);
  });

  it('maps an AbortError to connect_api_timeout', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    const mockFetch = vi.fn().mockRejectedValue(abortErr);
    const deps = makeDeps(mockFetch);
    await expect(
      deps.getConnectConfigurations({
        baseUri: 'https://demo.docusign.net',
        accountId: 'acct-1',
        accessToken: 'tok',
      }),
    ).rejects.toThrow(/timeout/);
  });
});

describe('makeListenerDriftDeps — getExpectedConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('derives the expected config from WORKER_PUBLIC_URL (shared provisioning source)', () => {
    const deps = makeDeps(vi.fn());
    const expected = deps.getExpectedConfig();
    expect(expected.urlToPublishTo).toBe('https://arkova-worker.example.com/webhooks/docusign');
    expect(expected.requiredEnvelopeEvents).toEqual(['Completed']);
    expect(expected.requiredEvents).toEqual(['envelope-completed']);
    expect(expected.hmacEnabled).toBe(true);
    expect(expected.payloadFormat).toBe('json');
    expect(expected.payloadVersion).toBe('restv2.1');
  });
});

describe('makeListenerDriftDeps — reportDrift', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fires a Sentry warning with ids + reasons but never secrets/tokens', async () => {
    const Sentry = await import('@sentry/node');
    const deps = makeDeps(vi.fn());
    deps.reportDrift({
      integration_id: 'int-1',
      org_id: 'org-1',
      account_id: 'acct-1',
      reasons: ['HMAC signing is not enabled'],
    });

    expect(Sentry.captureMessage).toHaveBeenCalledOnce();
    const [message, opts] = (Sentry.captureMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(message).toContain('int-1');
    expect(opts.level).toBe('warning');
    expect(opts.tags.integration_id).toBe('int-1');
    expect(opts.extra.reasons).toEqual(['HMAC signing is not enabled']);
    // Sanity: serialized event carries no bearer-token-looking material.
    expect(JSON.stringify(opts)).not.toMatch(/Bearer |access_token|refresh_token/);
  });
});
