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
  })),
}));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { makeReconciliationDeps } from './docusign-reconciliation-deps.js';

describe('makeReconciliationDeps — listCompletedEnvelopes pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function envelope(id: string) {
    return { envelopeId: id, status: 'completed', completedDateTime: '2026-05-27T10:00:00Z' };
  }

  it('follows nextUri across multiple pages', async () => {
    const page1 = {
      ok: true,
      json: () => Promise.resolve({
        envelopes: [envelope('env-1'), envelope('env-2')],
        nextUri: '/restapi/v2.1/accounts/acct-1/envelopes?start_position=2',
      }),
      text: () => Promise.resolve(''),
    };
    const page2 = {
      ok: true,
      json: () => Promise.resolve({
        envelopes: [envelope('env-3')],
      }),
      text: () => Promise.resolve(''),
    };

    const mockFetch = vi.fn()
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2);

    const deps = makeReconciliationDeps({
      db: { from: vi.fn() },
      fetchImpl: mockFetch as unknown as typeof fetch,
      refreshTokenStore: { get: vi.fn(), put: vi.fn(), delete: vi.fn() },
    });

    const result = await deps.listCompletedEnvelopes({
      baseUri: 'https://demo.docusign.net',
      accountId: 'acct-1',
      accessToken: 'tok',
      fromDate: '2026-05-26T10:00:00Z',
    });

    expect(result).toHaveLength(3);
    expect(result.map((e) => e.envelopeId)).toEqual(['env-1', 'env-2', 'env-3']);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1][0]).toBe(
      'https://demo.docusign.net/restapi/v2.1/accounts/acct-1/envelopes?start_position=2',
    );
  });

  it('stops after MAX_PAGES (10) to prevent runaway pagination', async () => {
    const makePage = (i: number) => ({
      ok: true,
      json: () => Promise.resolve({
        envelopes: [envelope(`env-${i}`)],
        nextUri: `/restapi/v2.1/accounts/acct-1/envelopes?start_position=${(i + 1) * 100}`,
      }),
      text: () => Promise.resolve(''),
    });

    const mockFetch = vi.fn();
    for (let i = 0; i < 15; i++) {
      mockFetch.mockResolvedValueOnce(makePage(i));
    }

    const deps = makeReconciliationDeps({
      db: { from: vi.fn() },
      fetchImpl: mockFetch as unknown as typeof fetch,
      refreshTokenStore: { get: vi.fn(), put: vi.fn(), delete: vi.fn() },
    });

    const result = await deps.listCompletedEnvelopes({
      baseUri: 'https://demo.docusign.net',
      accountId: 'acct-1',
      accessToken: 'tok',
      fromDate: '2026-05-26T10:00:00Z',
    });

    expect(mockFetch).toHaveBeenCalledTimes(10);
    expect(result).toHaveLength(10);
  });

  it('handles absolute nextUri URLs', async () => {
    const page1 = {
      ok: true,
      json: () => Promise.resolve({
        envelopes: [envelope('env-1')],
        nextUri: 'https://demo.docusign.net/restapi/v2.1/accounts/acct-1/envelopes?start_position=100',
      }),
      text: () => Promise.resolve(''),
    };
    const page2 = {
      ok: true,
      json: () => Promise.resolve({ envelopes: [envelope('env-2')] }),
      text: () => Promise.resolve(''),
    };

    const mockFetch = vi.fn()
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2);

    const deps = makeReconciliationDeps({
      db: { from: vi.fn() },
      fetchImpl: mockFetch as unknown as typeof fetch,
      refreshTokenStore: { get: vi.fn(), put: vi.fn(), delete: vi.fn() },
    });

    const result = await deps.listCompletedEnvelopes({
      baseUri: 'https://demo.docusign.net',
      accountId: 'acct-1',
      accessToken: 'tok',
      fromDate: '2026-05-26T10:00:00Z',
    });

    expect(result).toHaveLength(2);
    expect(mockFetch.mock.calls[1][0]).toBe(
      'https://demo.docusign.net/restapi/v2.1/accounts/acct-1/envelopes?start_position=100',
    );
  });

  it('returns single page when no nextUri', async () => {
    const page1 = {
      ok: true,
      json: () => Promise.resolve({
        envelopes: [envelope('env-1')],
      }),
      text: () => Promise.resolve(''),
    };

    const mockFetch = vi.fn().mockResolvedValueOnce(page1);

    const deps = makeReconciliationDeps({
      db: { from: vi.fn() },
      fetchImpl: mockFetch as unknown as typeof fetch,
      refreshTokenStore: { get: vi.fn(), put: vi.fn(), delete: vi.fn() },
    });

    const result = await deps.listCompletedEnvelopes({
      baseUri: 'https://demo.docusign.net',
      accountId: 'acct-1',
      accessToken: 'tok',
      fromDate: '2026-05-26T10:00:00Z',
    });

    expect(result).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
