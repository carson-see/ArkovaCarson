/**
 * Accredible HTTP client tests — SCRUM-1613 CSI-04C.
 * No real HTTP — every test injects a `fetch`-shaped fake.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

import {
  createAccredibleClient,
  DEFAULT_ACCREDIBLE_API_BASE,
  type AccredibleClientDeps,
} from './client.js';
import type { FetchLike } from '../credly/client.js';

function ok(body: unknown, status = 200): ReturnType<FetchLike> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

function err(status: number): ReturnType<FetchLike> {
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

describe('SCRUM-1613 — Accredible API-key client', () => {
  let fetchMock: Mock<FetchLike>;
  let deps: AccredibleClientDeps;

  beforeEach(() => {
    fetchMock = vi.fn<FetchLike>();
    deps = { fetch: fetchMock };
  });

  describe('listIssuedCredentials', () => {
    it('GETs /credentials with the Token-token Authorization header', async () => {
      fetchMock.mockReturnValueOnce(
        ok({
          credentials: [],
          meta: { total_count: 0, current_page: 1, total_pages: 0 },
        }),
      );
      const client = createAccredibleClient(deps);

      await client.listIssuedCredentials({ apiKey: 'ak-12345' });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url] = fetchMock.mock.calls[0];
      const init = getFetchInit(fetchMock.mock.calls[0]);
      expect(url).toMatch(
        new RegExp(
          `^${DEFAULT_ACCREDIBLE_API_BASE.replace(
            /[.\\+*?^$(){}|[\]/]/g,
            String.raw`\$&`,
          )}/credentials`,
        ),
      );
      expect(init.method).toBe('GET');
      // Accredible's documented auth shape: `Token token=<KEY>`
      expect(init.headers.Authorization).toBe('Token token=ak-12345');
      expect(init.headers.Accept).toBe('application/json');
    });

    it('passes recipient.email + pagination as query parameters', async () => {
      fetchMock.mockReturnValueOnce(ok({ credentials: [], meta: {} }));
      const client = createAccredibleClient(deps);

      await client.listIssuedCredentials({
        apiKey: 'ak-12345',
        recipientEmail: 'pat@example.com',
        page: 3,
        perPage: 25,
      });

      const [url] = fetchMock.mock.calls[0];
      const parsed = new URL(url);
      expect(parsed.searchParams.get('recipient.email')).toBe('pat@example.com');
      expect(parsed.searchParams.get('page')).toBe('3');
      expect(parsed.searchParams.get('page_size')).toBe('25');
    });

    it('parses a real-shaped Accredible credentials page response', async () => {
      fetchMock.mockReturnValueOnce(
        ok({
          credentials: [
            {
              id: 987654,
              name: 'Advanced Data Stewardship Certificate',
              issued_on: '2026-04-15',
              public_url: 'https://accredible.example/credential/987654',
              group: {
                id: 'g-1',
                name: 'Data Stewardship Program',
                organization: { name: 'Example University' },
              },
              recipient: { email: 'pat@example.com', name: 'Pat Example' },
            },
          ],
          meta: { total_count: 1, current_page: 1, total_pages: 1 },
        }),
      );
      const client = createAccredibleClient(deps);

      const result = await client.listIssuedCredentials({ apiKey: 'ak-12345' });
      expect(result.credentials).toHaveLength(1);
      expect(result.credentials[0].name).toBe(
        'Advanced Data Stewardship Certificate',
      );
      expect(result.credentials[0].group?.organization?.name).toBe(
        'Example University',
      );
    });

    it('throws a non-leaky error on HTTP failure (api_key NOT in message)', async () => {
      fetchMock.mockReturnValueOnce(err(401));
      const client = createAccredibleClient(deps);

      const secret = 'ak-SUPER-SECRET-xyz';
      try {
        await client.listIssuedCredentials({ apiKey: secret });
        throw new Error('should have thrown');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        expect(msg).toMatch(/Accredible credentials request failed: HTTP 401/);
        expect(msg).not.toContain(secret);
      }
    });

    it('throws on HTTP 5xx (caller responsible for retry)', async () => {
      fetchMock.mockReturnValueOnce(err(503));
      const client = createAccredibleClient(deps);

      await expect(
        client.listIssuedCredentials({ apiKey: 'ak' }),
      ).rejects.toThrow(/HTTP 503/);
    });

    it('respects a custom apiBase override (partnership-time staging)', async () => {
      fetchMock.mockReturnValueOnce(ok({ credentials: [], meta: {} }));
      const client = createAccredibleClient({
        ...deps,
        apiBase: 'https://staging.api.accredible.example/v1/',
      });

      await client.listIssuedCredentials({ apiKey: 'ak' });
      const [url] = fetchMock.mock.calls[0];
      expect(url).toMatch(/^https:\/\/staging\.api\.accredible\.example\/v1\/credentials/);
    });
  });
});
