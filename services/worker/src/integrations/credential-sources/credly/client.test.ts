/**
 * Credly HTTP client tests — SCRUM-1612 CSI-04B.
 *
 * No real HTTP traffic — every test injects a `fetch`-shaped fake and a
 * deterministic clock.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

import {
  createCredlyClient,
  DEFAULT_CREDLY_API_BASE,
  type CredlyClientDeps,
  type FetchLike,
} from './client.js';

const FIXED_NOW_MS = 1_750_000_000_000;
const ONE_HOUR_MS = 60 * 60 * 1000;

function makeOkResponse(body: unknown, status = 200): ReturnType<FetchLike> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

function makeErrResponse(status: number): ReturnType<FetchLike> {
  return Promise.resolve({
    ok: false,
    status,
    json: async () => ({}),
    text: async () => '',
  });
}

type FetchInit = NonNullable<Parameters<FetchLike>[1]> & {
  headers: Record<string, string>;
};

function getFetchInit(call: Parameters<FetchLike>): FetchInit {
  const init = call[1];
  expect(init).toBeDefined();
  expect(init?.headers).toBeDefined();
  return init as FetchInit;
}

describe('SCRUM-1612 — Credly OAuth client_credentials', () => {
  let fetchMock: Mock<FetchLike>;
  let nowValue: number;
  let deps: CredlyClientDeps;

  beforeEach(() => {
    nowValue = FIXED_NOW_MS;
    fetchMock = vi.fn<FetchLike>();
    deps = {
      fetch: fetchMock,
      now: () => nowValue,
    };
  });

  describe('getAccessToken', () => {
    it('exchanges client_id+client_secret for an access token via POST /oauth/token', async () => {
      fetchMock.mockReturnValueOnce(
        makeOkResponse({
          access_token: 'tok-abc',
          expires_in: 7200,
          token_type: 'Bearer',
          scope: 'issued_badges',
        }),
      );
      const client = createCredlyClient(deps);

      const token = await client.getAccessToken({
        clientId: 'cid-1',
        clientSecret: 'csec-1',
        scope: 'issued_badges',
      });

      expect(token).toBe('tok-abc');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url] = fetchMock.mock.calls[0];
      const init = getFetchInit(fetchMock.mock.calls[0]);
      expect(url).toBe(`${DEFAULT_CREDLY_API_BASE}/oauth/token`);
      expect(init.method).toBe('POST');
      expect(init.headers['Content-Type']).toBe(
        'application/x-www-form-urlencoded',
      );
      // Basic auth must contain the client_id:client_secret pair, base64'd
      const expectedBasic = Buffer.from('cid-1:csec-1').toString('base64');
      expect(init.headers.Authorization).toBe(`Basic ${expectedBasic}`);
      // Body must be the client_credentials grant
      expect(init.body).toContain('grant_type=client_credentials');
      expect(init.body).toContain('scope=issued_badges');
    });

    it('caches the token until expiry minus skew (no extra HTTP)', async () => {
      fetchMock.mockReturnValueOnce(
        makeOkResponse({ access_token: 'tok-1', expires_in: 7200 }),
      );
      const client = createCredlyClient(deps);

      await client.getAccessToken({ clientId: 'cid-1', clientSecret: 'csec' });
      // Advance time by 1 hour (well before the 2h - 1m skew window)
      nowValue += ONE_HOUR_MS;
      const second = await client.getAccessToken({
        clientId: 'cid-1',
        clientSecret: 'csec',
      });

      expect(second).toBe('tok-1');
      expect(fetchMock).toHaveBeenCalledTimes(1); // cache hit
    });

    it('re-mints when the cached token is past expiry minus skew', async () => {
      fetchMock
        .mockReturnValueOnce(
          makeOkResponse({ access_token: 'tok-1', expires_in: 7200 }),
        )
        .mockReturnValueOnce(
          makeOkResponse({ access_token: 'tok-2', expires_in: 7200 }),
        );
      const client = createCredlyClient(deps);

      await client.getAccessToken({ clientId: 'cid-1', clientSecret: 'csec' });
      // Advance past the 2h - 1m skew window (e.g. 2h)
      nowValue += 2 * ONE_HOUR_MS;
      const refreshed = await client.getAccessToken({
        clientId: 'cid-1',
        clientSecret: 'csec',
      });

      expect(refreshed).toBe('tok-2');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('throws a non-leaky error on token-endpoint failure', async () => {
      fetchMock.mockReturnValueOnce(makeErrResponse(401));
      const client = createCredlyClient(deps);

      await expect(
        client.getAccessToken({ clientId: 'cid-1', clientSecret: 'wrong' }),
      ).rejects.toThrow(/Credly OAuth token request failed: HTTP 401/);
      // Ensure the client_secret is NOT in the error message
      await expect(
        client.getAccessToken({ clientId: 'cid-1', clientSecret: 'wrong' }),
      ).rejects.not.toThrow(/wrong/);
    });
  });

  describe('listIssuedBadges', () => {
    it('GETs /v1/organizations/{org_id}/badges with Bearer auth', async () => {
      fetchMock.mockReturnValueOnce(
        makeOkResponse({
          data: [],
          metadata: { count: 0, current_page: 1, total_pages: 0 },
        }),
      );
      const client = createCredlyClient(deps);

      await client.listIssuedBadges({
        accessToken: 'tok-abc',
        organisationId: 'org-12345',
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url] = fetchMock.mock.calls[0];
      const init = getFetchInit(fetchMock.mock.calls[0]);
      expect(url).toMatch(
        new RegExp(
          `^${DEFAULT_CREDLY_API_BASE.replace(
            /[.\\+*?^$(){}|[\]/]/g,
            String.raw`\$&`,
          )}/v1/organizations/org-12345/badges`,
        ),
      );
      expect(init.method).toBe('GET');
      expect(init.headers.Authorization).toBe('Bearer tok-abc');
    });

    it('passes recipient_email + pagination as query parameters', async () => {
      fetchMock.mockReturnValueOnce(
        makeOkResponse({ data: [], metadata: { count: 0 } }),
      );
      const client = createCredlyClient(deps);

      await client.listIssuedBadges({
        accessToken: 't',
        organisationId: 'org-1',
        recipientEmail: 'alex@example.com',
        page: 2,
        perPage: 25,
      });

      const [url] = fetchMock.mock.calls[0];
      const parsed = new URL(url);
      expect(parsed.searchParams.get('filter[recipient_email]')).toBe(
        'alex@example.com',
      );
      expect(parsed.searchParams.get('page[number]')).toBe('2');
      expect(parsed.searchParams.get('page[size]')).toBe('25');
    });

    it('parses a real-shaped Credly badge page response', async () => {
      fetchMock.mockReturnValueOnce(
        makeOkResponse({
          data: [
            {
              id: 'bdg-1',
              issued_at: '2026-04-15T12:00:00Z',
              public_url: 'https://www.credly.com/badges/bdg-1/public_url',
              badge_template: {
                id: 'tpl-1',
                name: 'Cloud Architecture Fundamentals',
                owner: { name: 'Example Cloud' },
              },
            },
          ],
          metadata: { count: 1, current_page: 1, total_pages: 1 },
        }),
      );
      const client = createCredlyClient(deps);

      const result = await client.listIssuedBadges({
        accessToken: 't',
        organisationId: 'org-1',
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].badge_template?.name).toBe(
        'Cloud Architecture Fundamentals',
      );
    });

    it('throws on HTTP error from badges endpoint', async () => {
      fetchMock.mockReturnValueOnce(makeErrResponse(503));
      const client = createCredlyClient(deps);

      await expect(
        client.listIssuedBadges({
          accessToken: 't',
          organisationId: 'org-1',
        }),
      ).rejects.toThrow(/Credly issued_badges request failed: HTTP 503/);
    });
  });
});
