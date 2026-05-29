import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/db.js', () => ({
  db: { from: vi.fn(), rpc: vi.fn() },
}));
vi.mock('../integrations/oauth/docusign.js', () => ({
  refreshDocusignAccessToken: vi.fn(),
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

import { makeConnectFailuresDeps } from './docusign-connect-failures-deps.js';

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function makeDeps(mockFetch: ReturnType<typeof vi.fn>) {
  return makeConnectFailuresDeps({
    db: { from: vi.fn() },
    fetchImpl: mockFetch as unknown as typeof fetch,
    refreshTokenStore: { get: vi.fn(), put: vi.fn(), delete: vi.fn() },
  });
}

const POLL_ARGS = {
  baseUri: 'https://demo.docusign.net',
  accountId: 'acct-1',
  accessToken: 'tok',
  fromDate: '2026-05-29T10:00:00Z',
};

describe('makeConnectFailuresDeps — listConnectFailures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls the Connect Failures endpoint with from_date and bearer auth', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(jsonResponse({ failures: [] }));
    const deps = makeDeps(mockFetch);

    await deps.listConnectFailures(POLL_ARGS);

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(
      'https://demo.docusign.net/restapi/v2.1/accounts/acct-1/connect/failures?from_date=2026-05-29T10%3A00%3A00Z',
    );
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' });
  });

  it('maps ConnectLog failures to gap rows (envelopeId/status/created)', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        failures: [
          { envelopeId: 'env-1', status: 'completed', created: '2026-05-29T11:00:00Z' },
          { envelopeId: 'env-2', status: 'sent', created: '2026-05-29T11:30:00Z' },
        ],
        totalRecords: '2',
      }),
    );
    const deps = makeDeps(mockFetch);

    const gaps = await deps.listConnectFailures(POLL_ARGS);

    expect(gaps).toEqual([
      { envelope_id: 'env-1', envelope_status: 'completed', completed_at: '2026-05-29T11:00:00Z' },
      { envelope_id: 'env-2', envelope_status: 'sent', completed_at: '2026-05-29T11:30:00Z' },
    ]);
  });

  it('skips failures without an envelopeId', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        failures: [
          { status: 'completed', created: '2026-05-29T11:00:00Z' },
          { envelopeId: 'env-2', status: 'completed', created: '2026-05-29T11:30:00Z' },
        ],
      }),
    );
    const deps = makeDeps(mockFetch);

    const gaps = await deps.listConnectFailures(POLL_ARGS);

    expect(gaps).toHaveLength(1);
    expect(gaps[0].envelope_id).toBe('env-2');
  });

  it('falls back to lastTry then now() when created is absent', async () => {
    const before = Date.now();
    const mockFetch = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        failures: [
          { envelopeId: 'env-1', status: 'completed', lastTry: '2026-05-29T09:00:00Z' },
          { envelopeId: 'env-2', status: 'completed' },
        ],
      }),
    );
    const deps = makeDeps(mockFetch);

    const gaps = await deps.listConnectFailures(POLL_ARGS);

    expect(gaps[0].completed_at).toBe('2026-05-29T09:00:00Z');
    // env-2 has neither created nor lastTry → now() fallback (valid ISO, recent).
    const fallback = new Date(gaps[1].completed_at).getTime();
    expect(fallback).toBeGreaterThanOrEqual(before);
    expect(fallback).toBeLessThanOrEqual(Date.now());
  });

  it('defaults envelope_status to "completed" when status is absent', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      jsonResponse({ failures: [{ envelopeId: 'env-1', created: '2026-05-29T11:00:00Z' }] }),
    );
    const deps = makeDeps(mockFetch);

    const gaps = await deps.listConnectFailures(POLL_ARGS);

    expect(gaps[0].envelope_status).toBe('completed');
  });

  it('returns an empty array when the API returns no failures property', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(jsonResponse({ totalRecords: '0' }));
    const deps = makeDeps(mockFetch);

    const gaps = await deps.listConnectFailures(POLL_ARGS);

    expect(gaps).toEqual([]);
  });

  it('tolerates extra ConnectLog fields without leaking them (passthrough)', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        failures: [
          {
            envelopeId: 'env-1',
            status: 'completed',
            created: '2026-05-29T11:00:00Z',
            email: 'signer@example.com',
            subject: 'Please sign',
            userName: 'Jane Signer',
            connectDebugLog: [{ eventDescription: 'x' }],
          },
        ],
      }),
    );
    const deps = makeDeps(mockFetch);

    const gaps = await deps.listConnectFailures(POLL_ARGS);

    // Only the three safe fields are propagated — no PII keys.
    expect(Object.keys(gaps[0]).sort((a, b) => a.localeCompare(b))).toEqual(
      ['completed_at', 'envelope_id', 'envelope_status'],
    );
  });

  it('throws a tagged error on a non-2xx response', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse('Unauthorized', false, 401));
    const deps = makeDeps(mockFetch);

    await expect(deps.listConnectFailures(POLL_ARGS)).rejects.toThrow(
      /connect_failures_api_401/,
    );
  });

  it('strips trailing slashes from baseUri', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(jsonResponse({ failures: [] }));
    const deps = makeDeps(mockFetch);

    await deps.listConnectFailures({ ...POLL_ARGS, baseUri: 'https://demo.docusign.net///' });

    expect(mockFetch.mock.calls[0][0]).toBe(
      'https://demo.docusign.net/restapi/v2.1/accounts/acct-1/connect/failures?from_date=2026-05-29T10%3A00%3A00Z',
    );
  });

  it('exposes the shared reconciliation methods (listActiveIntegrations/getAccessToken/insertGap)', async () => {
    const deps = makeDeps(vi.fn());
    expect(typeof deps.listActiveIntegrations).toBe('function');
    expect(typeof deps.getAccessToken).toBe('function');
    expect(typeof deps.insertGap).toBe('function');
  });
});
