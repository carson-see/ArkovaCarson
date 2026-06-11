import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/db.js', () => ({
  db: { from: vi.fn(), rpc: vi.fn() },
}));

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
  DOCUSIGN_CONNECT_HMAC_SECRET: 'test-hmac-secret',
} as unknown as NodeJS.ProcessEnv;

function makeDeps(mockFetch: ReturnType<typeof vi.fn>) {
  return makeListenerDriftDeps({
    db: { from: vi.fn() },
    env: DRIFT_ENV,
    fetchImpl: mockFetch as unknown as typeof fetch,
    refreshTokenStore: { get: vi.fn(), put: vi.fn(), delete: vi.fn() },
  });
}

describe('makeListenerDriftDeps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GETs the account Connect endpoint and parses configurations', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve(JSON.stringify({
          configurations: [{
            connectId: 99001,
            urlToPublishTo: 'https://arkova-worker.example.com/webhooks/docusign',
            allowEnvelopePublish: 'true',
            includeHMAC: 'true',
            envelopeEvents: ['Completed'],
            events: ['envelope-completed'],
            eventData: { format: 'json', version: 'restv2.1' },
          }],
        })),
    });
    const deps = makeDeps(mockFetch);

    const listeners = await deps.getConnectConfigurations({
      baseUri: 'https://demo.docusign.net/',
      accountId: 'acct-1',
      accessToken: 'tok',
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://demo.docusign.net/restapi/v2.1/accounts/acct-1/connect',
      expect.objectContaining({
        headers: { Authorization: 'Bearer tok' },
      }),
    );
    expect(listeners[0].connectId).toBe('99001');
    expect(listeners[0].eventData?.version).toBe('restv2.1');
  });

  it('returns an empty listener list for an empty DocuSign response body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(''),
    });

    const listeners = await makeDeps(mockFetch).getConnectConfigurations({
      baseUri: 'https://demo.docusign.net',
      accountId: 'acct-1',
      accessToken: 'tok',
    });

    expect(listeners).toEqual([]);
  });

  it('derives expected config from the same payload shape used for provisioning', () => {
    const expected = makeDeps(vi.fn()).getExpectedConfig();

    expect(expected.urlToPublishTo).toBe('https://arkova-worker.example.com/webhooks/docusign');
    expect(expected.requiredEnvelopeEvents).toEqual(['Completed']);
    expect(expected.requiredEvents).toEqual(['envelope-completed']);
    expect(expected.hmacEnabled).toBe(true);
    expect(expected.payloadFormat).toBe('json');
    expect(expected.payloadVersion).toBe('restv2.1');
  });

  it('reports drift to Sentry without including bearer-token material', async () => {
    const Sentry = await import('@sentry/node');
    const deps = makeDeps(vi.fn());

    deps.reportDrift({
      integration_id: 'int-1',
      org_id: 'org-1',
      account_id: 'acct-1',
      reasons: ['HMAC signing is not enabled'],
    });

    expect(Sentry.captureMessage).toHaveBeenCalledOnce();
    const [, options] = (Sentry.captureMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options.tags.integration_id).toBe('int-1');
    expect(options.extra.reasons).toEqual(['HMAC signing is not enabled']);
    expect(JSON.stringify(options)).not.toMatch(/Bearer |access_token|refresh_token/);
  });
});
