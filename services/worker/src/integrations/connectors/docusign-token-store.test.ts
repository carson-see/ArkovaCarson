import { describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/gcp-auth.js', () => ({
  getGcpAccessToken: vi.fn(async () => 'mock-token'),
}));
vi.mock('../../config.js', () => ({ config: {} }));
vi.mock('../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  DEFAULT_DOCUSIGN_REFRESH_TOKEN_RETENTION,
  buildDocusignRefreshTokenSecretName,
  createGcpSecretManagerRefreshTokenStore,
  resolveDocusignSecretManagerProjectId,
  selectSupersededVersions,
  type DocusignRefreshTokenStoreLogger,
} from './docusign-token-store.js';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const SECRET = 'projects/p/secrets/arkova-docusign-test';
const BASE = `https://secretmanager.googleapis.com/v1/${SECRET}`;

type VersionState = 'ENABLED' | 'DISABLED' | 'DESTROYED';

interface FakeSecretManagerOptions {
  /** Pre-existing versions keyed by version number. `value` is the payload. */
  versions?: Record<number, { state: VersionState; value?: string }>;
  /** Server-side page size (a server may return fewer than pageSize; that is legal). */
  serverPageSize?: number;
  /** Force the versions list call to fail with this status. */
  listStatus?: number;
  /** Force every destroy call to fail with this status. */
  destroyStatus?: number;
  /** Force the latest:access comparison read to fail with this status. */
  latestAccessStatus?: number;
}

/**
 * In-memory Secret Manager double. Tracks version state so the retention
 * behaviour (add -> compare -> prune) can be asserted on outcomes, not just on
 * URL sequences. Never returns a payload from the list endpoint, mirroring the
 * real API.
 */
function makeFakeSecretManager(opts: FakeSecretManagerOptions = {}) {
  const versions = new Map<number, { state: VersionState; value?: string }>();
  for (const [k, v] of Object.entries(opts.versions ?? {})) versions.set(Number(k), { ...v });
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const serverPageSize = opts.serverPageSize ?? 1000;

  const latestEnabled = () => {
    const ids = [...versions.entries()].filter(([, v]) => v.state === 'ENABLED').map(([id]) => id);
    return ids.length ? Math.max(...ids) : null;
  };

  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const method = init?.method ?? 'GET';

    if (url === BASE && method === 'GET') return new Response('{}', { status: 200 });
    if (url === BASE && method === 'DELETE') return new Response('{}', { status: 200 });

    if (url === `${BASE}/versions/latest:access`) {
      if (opts.latestAccessStatus) return new Response('{}', { status: opts.latestAccessStatus });
      const id = latestEnabled();
      if (id === null) return new Response('{}', { status: 404 });
      const value = versions.get(id)?.value ?? '';
      return new Response(
        JSON.stringify({ name: `${SECRET}/versions/${id}`, payload: { data: Buffer.from(value, 'utf8').toString('base64') } }),
        { status: 200 },
      );
    }

    if (url === `${BASE}:addVersion` && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { payload: { data: string } };
      const id = (versions.size ? Math.max(...versions.keys()) : 0) + 1;
      versions.set(id, { state: 'ENABLED', value: Buffer.from(body.payload.data, 'base64').toString('utf8') });
      return new Response(JSON.stringify({ name: `projects/123456/secrets/arkova-docusign-test/versions/${id}`, state: 'ENABLED' }), { status: 200 });
    }

    if (url.startsWith(`${BASE}/versions?`) && method === 'GET') {
      if (opts.listStatus) return new Response('{}', { status: opts.listStatus });
      const params = new URL(url).searchParams;
      const filter = params.get('filter');
      const pageToken = Number(params.get('pageToken') ?? '0');
      let ids = [...versions.keys()].sort((a, b) => b - a);
      if (filter === 'state:ENABLED') ids = ids.filter((id) => versions.get(id)?.state === 'ENABLED');
      const page = ids.slice(pageToken, pageToken + serverPageSize);
      const next = pageToken + serverPageSize < ids.length ? String(pageToken + serverPageSize) : undefined;
      return new Response(JSON.stringify({
        // Real API: project NUMBER in the resource name, no payload.
        versions: page.map((id) => ({ name: `projects/123456/secrets/arkova-docusign-test/versions/${id}`, state: versions.get(id)?.state })),
        ...(next ? { nextPageToken: next } : {}),
      }), { status: 200 });
    }

    const destroy = /\/versions\/(\d+):destroy$/.exec(url);
    if (destroy && method === 'POST') {
      if (opts.destroyStatus) return new Response('{}', { status: opts.destroyStatus });
      const id = Number(destroy[1]);
      const v = versions.get(id);
      if (!v) return new Response('{}', { status: 404 });
      v.state = 'DESTROYED';
      delete v.value;
      return new Response(JSON.stringify({ name: `${SECRET}/versions/${id}`, state: 'DESTROYED' }), { status: 200 });
    }

    return new Response('{}', { status: 500 });
  });

  return {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    calls,
    versions,
    stateOf: (id: number) => versions.get(id)?.state,
    enabledIds: () => [...versions.entries()].filter(([, v]) => v.state === 'ENABLED').map(([id]) => id).sort((a, b) => a - b),
    destroyedIds: () => calls
      .filter((c) => c.init?.method === 'POST' && c.url.endsWith(':destroy'))
      .map((c) => Number(/\/versions\/(\d+):destroy$/.exec(c.url)?.[1])),
    addVersionCalls: () => calls.filter((c) => c.url === `${BASE}:addVersion`).length,
    listCalls: () => calls.filter((c) => c.url.startsWith(`${BASE}/versions?`)),
  };
}

function makeLogger() {
  const entries: Array<{ level: string; args: unknown[] }> = [];
  const mk = (level: string) => vi.fn((...args: unknown[]) => { entries.push({ level, args }); });
  const logger: DocusignRefreshTokenStoreLogger = { debug: mk('debug'), info: mk('info'), warn: mk('warn') };
  return { logger, entries, serialized: () => JSON.stringify(entries) };
}

describe('DocuSign refresh token Secret Manager store', () => {
  it('builds a per-org Secret Manager resource name without exposing the DocuSign account id', () => {
    const name = buildDocusignRefreshTokenSecretName({
      projectId: 'arkova-test',
      orgId: ORG_ID,
      accountId: 'account/with unsafe chars',
    });

    expect(name).toMatch(/^projects\/arkova-test\/secrets\/arkova-docusign-11111111-1111-4111-8111-111111111111-[a-f0-9]{32}-refresh-token$/);
    expect(name).not.toContain('account/with unsafe chars');
  });

  it('falls back to the integration KMS key project when no Secret Manager project override is set', () => {
    expect(resolveDocusignSecretManagerProjectId({
      GCP_KMS_INTEGRATION_TOKEN_KEY: 'projects/arkova1/locations/global/keyRings/r/cryptoKeys/k',
    })).toBe('arkova1');
  });

  it('writes, reads, and deletes refresh tokens via Secret Manager REST without logging or returning ciphertext handles', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let written = false;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/secrets/arkova-docusign-test') && !init?.method) {
        return new Response('{}', { status: 404 });
      }
      if (String(url).endsWith('/secrets?secretId=arkova-docusign-test')) {
        return new Response(JSON.stringify({ name: 'projects/p/secrets/arkova-docusign-test' }), { status: 200 });
      }
      if (String(url).endsWith('/secrets/arkova-docusign-test:addVersion')) {
        const body = JSON.parse(String(init?.body)) as { payload: { data: string } };
        expect(Buffer.from(body.payload.data, 'base64').toString('utf8')).toBe('refresh-secret');
        written = true;
        return new Response(JSON.stringify({ name: 'projects/p/secrets/arkova-docusign-test/versions/1' }), { status: 200 });
      }
      if (String(url).endsWith('/versions/latest:access')) {
        if (!written) return new Response('{}', { status: 404 });
        return new Response(
          JSON.stringify({ payload: { data: Buffer.from('refresh-secret', 'utf8').toString('base64') } }),
          { status: 200 },
        );
      }
      if (String(url).includes('/secrets/arkova-docusign-test/versions?')) {
        return new Response(JSON.stringify({ versions: [{ name: 'projects/p/secrets/arkova-docusign-test/versions/1', state: 'ENABLED' }] }), { status: 200 });
      }
      if (String(url).endsWith('/secrets/arkova-docusign-test') && init?.method === 'DELETE') {
        return new Response('{}', { status: 200 });
      }
      return new Response('{}', { status: 500 });
    });

    const store = createGcpSecretManagerRefreshTokenStore({
      env: { GCP_SECRET_MANAGER_PROJECT_ID: 'p' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getAccessToken: async () => 'gcp-token',
    });

    await store.put({ name: 'projects/p/secrets/arkova-docusign-test', value: 'refresh-secret' });
    await expect(store.get({ name: 'projects/p/secrets/arkova-docusign-test' })).resolves.toBe('refresh-secret');
    await store.delete({ name: 'projects/p/secrets/arkova-docusign-test' });

    expect(calls.map((call) => call.url)).toEqual([
      'https://secretmanager.googleapis.com/v1/projects/p/secrets/arkova-docusign-test',
      'https://secretmanager.googleapis.com/v1/projects/p/secrets?secretId=arkova-docusign-test',
      // Compare-before-write: a fresh secret has no version, so the write proceeds.
      'https://secretmanager.googleapis.com/v1/projects/p/secrets/arkova-docusign-test/versions/latest:access',
      'https://secretmanager.googleapis.com/v1/projects/p/secrets/arkova-docusign-test:addVersion',
      // Prune superseded versions (none here: only the version just written exists).
      'https://secretmanager.googleapis.com/v1/projects/p/secrets/arkova-docusign-test/versions?pageSize=500&filter=state%3AENABLED',
      'https://secretmanager.googleapis.com/v1/projects/p/secrets/arkova-docusign-test/versions/latest:access',
      'https://secretmanager.googleapis.com/v1/projects/p/secrets/arkova-docusign-test',
    ]);
    expect(calls.every((call) => call.init?.headers instanceof Headers
      ? call.init.headers.get('authorization') === 'Bearer gcp-token'
      : true)).toBe(true);
    expect(calls.every((call) => call.init?.signal instanceof AbortSignal)).toBe(true);
  });

  it('aborts hung Secret Manager requests with a bounded timeout', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      }));
    const store = createGcpSecretManagerRefreshTokenStore({
      env: { GCP_SECRET_MANAGER_PROJECT_ID: 'p' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getAccessToken: async () => 'gcp-token',
    });

    const request = expect(
      store.get({ name: 'projects/p/secrets/arkova-docusign-test' }),
    ).rejects.toThrow('Secret Manager request timed out after 10000ms');
    await vi.advanceTimersByTimeAsync(10_000);
    await request;
    vi.useRealTimers();
  });
});

/**
 * BUG (found 2026-09-05, GCP project arkova1): the prod org refresh-token secret
 * had 1,645 ENABLED versions and gained one at :00 and :15 every hour — the
 * hourly connect-failures poll and listener-drift jobs each refresh the DocuSign
 * grant, DocuSign rotates the refresh token on every refresh, and `put` only ever
 * appended. Secret Manager bills every ENABLED/DISABLED version, so the backlog
 * cost ~$99/month and grew ~$6/month per day. These tests pin the retention rule:
 * at most the newest 2 versions stay enabled, and identical values are not
 * re-written.
 */
describe('DocuSign refresh token version retention', () => {
  const makeStore = (fake: ReturnType<typeof makeFakeSecretManager>, extra: Record<string, unknown> = {}) =>
    createGcpSecretManagerRefreshTokenStore({
      env: { GCP_SECRET_MANAGER_PROJECT_ID: 'p' },
      fetchImpl: fake.fetchImpl,
      getAccessToken: async () => 'gcp-token',
      ...extra,
    });

  it('defaults to keeping the newest 2 versions and destroying a bounded number per write', () => {
    expect(DEFAULT_DOCUSIGN_REFRESH_TOKEN_RETENTION).toEqual({ keepVersions: 2, maxDestroyPerPut: 10 });
  });

  it('skips the write entirely when the latest enabled version already holds the same value', async () => {
    const fake = makeFakeSecretManager({ versions: { 1: { state: 'ENABLED', value: 'old' }, 2: { state: 'ENABLED', value: 'same' } } });
    const log = makeLogger();
    const store = makeStore(fake, { logger: log.logger });

    await store.put({ name: SECRET, value: 'same' });

    expect(fake.addVersionCalls()).toBe(0);
    expect(fake.destroyedIds()).toEqual([]);
    expect(fake.enabledIds()).toEqual([1, 2]);
    expect(log.serialized()).not.toContain('same');
  });

  it('after a rotation, destroys every enabled version older than the newest 2, oldest first', async () => {
    const fake = makeFakeSecretManager({
      versions: {
        1: { state: 'ENABLED', value: 'v1' },
        2: { state: 'DESTROYED' },
        3: { state: 'DISABLED', value: 'v3' },
        4: { state: 'ENABLED', value: 'v4' },
        5: { state: 'ENABLED', value: 'v5' },
        6: { state: 'ENABLED', value: 'v6' },
      },
    });
    const log = makeLogger();
    const store = makeStore(fake, { logger: log.logger });

    await store.put({ name: SECRET, value: 'v7' });

    expect(fake.addVersionCalls()).toBe(1);
    // The list request asks the server for ENABLED versions only.
    expect(fake.listCalls().every((c) => new URL(c.url).searchParams.get('filter') === 'state:ENABLED')).toBe(true);
    expect(fake.destroyedIds()).toEqual([1, 4, 5]);
    expect(fake.enabledIds()).toEqual([6, 7]);
    expect(fake.stateOf(3)).toBe('DISABLED'); // not ours to touch: already not billed as enabled churn
    expect(fake.stateOf(7)).toBe('ENABLED');
    const info = log.entries.find((e) => e.level === 'info');
    expect(info?.args[0]).toMatchObject({ secretId: 'arkova-docusign-test', destroyed: 3, failed: 0, remainingSuperseded: 0 });
    expect(log.serialized()).not.toMatch(/v[1-7]/);
  });

  it('pages the version list and bounds destruction to maxDestroyPerPut so a backlog drains without a long-running cron', async () => {
    const versions: Record<number, { state: VersionState; value?: string }> = {};
    for (let i = 1; i <= 30; i++) versions[i] = { state: 'ENABLED', value: `t${i}` };
    const fake = makeFakeSecretManager({ versions, serverPageSize: 10 });
    const log = makeLogger();
    const store = makeStore(fake, { logger: log.logger, retention: { keepVersions: 2, maxDestroyPerPut: 5 } });

    await store.put({ name: SECRET, value: 't31' });

    const lists = fake.listCalls();
    expect(lists.length).toBe(4); // 31 enabled versions at 10 per page
    expect(lists.slice(1).every((c) => new URL(c.url).searchParams.get('pageToken'))).toBe(true);
    expect(fake.destroyedIds()).toEqual([1, 2, 3, 4, 5]);
    expect(fake.enabledIds()).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]);
    const info = log.entries.find((e) => e.level === 'info');
    expect(info?.args[0]).toMatchObject({ destroyed: 5, failed: 0, remainingSuperseded: 24 });
  });

  it('a failed version list never fails the write (the token is already stored) and is logged without the token', async () => {
    const fake = makeFakeSecretManager({ versions: { 1: { state: 'ENABLED', value: 'v1' } }, listStatus: 503 });
    const log = makeLogger();
    const store = makeStore(fake, { logger: log.logger });

    await expect(store.put({ name: SECRET, value: 'v2' })).resolves.toBeUndefined();

    expect(fake.enabledIds()).toEqual([1, 2]);
    const warn = log.entries.find((e) => e.level === 'warn');
    expect(warn?.args[0]).toMatchObject({ secretId: 'arkova-docusign-test' });
    expect(log.serialized()).not.toContain('v2');
  });

  it('a failed destroy is counted, not thrown, and the remaining superseded versions are reported', async () => {
    const fake = makeFakeSecretManager({
      versions: { 1: { state: 'ENABLED', value: 'v1' }, 2: { state: 'ENABLED', value: 'v2' }, 3: { state: 'ENABLED', value: 'v3' } },
      destroyStatus: 500,
    });
    const log = makeLogger();
    const store = makeStore(fake, { logger: log.logger });

    await expect(store.put({ name: SECRET, value: 'v4' })).resolves.toBeUndefined();

    expect(fake.destroyedIds()).toEqual([1, 2]); // attempted
    expect(fake.enabledIds()).toEqual([1, 2, 3, 4]); // server refused
    const warn = log.entries.find((e) => e.level === 'warn');
    expect(warn?.args[0]).toMatchObject({ secretId: 'arkova-docusign-test', destroyed: 0, failed: 2, remainingSuperseded: 2 });
  });

  it('still writes when the compare-before-write read fails for a reason other than "no version yet"', async () => {
    const fake = makeFakeSecretManager({ versions: { 1: { state: 'ENABLED', value: 'v1' } }, latestAccessStatus: 500 });
    const store = makeStore(fake, { logger: makeLogger().logger });

    await store.put({ name: SECRET, value: 'v2' });

    expect(fake.addVersionCalls()).toBe(1);
    expect(fake.enabledIds()).toEqual([1, 2]);
  });

  it('never surfaces a payload in the retention log lines even when the secret id is long', async () => {
    const fake = makeFakeSecretManager({ versions: { 1: { state: 'ENABLED', value: 'super-secret-refresh-token' } } });
    const log = makeLogger();
    const store = makeStore(fake, { logger: log.logger });

    await store.put({ name: SECRET, value: 'another-secret-refresh-token' });

    expect(log.entries.length).toBeGreaterThan(0);
    expect(log.serialized()).not.toContain('secret-refresh-token');
  });

  describe('selectSupersededVersions', () => {
    it('sorts numerically (not lexically), keeps the newest N, and returns the rest oldest-first', () => {
      const names = [9, 10, 2, 11, 1].map((n) => ({ name: `projects/123/secrets/s/versions/${n}`, state: 'ENABLED' as const }));
      expect(selectSupersededVersions(names, { keepVersions: 2, maxDestroyPerPut: 10 })).toEqual({
        destroy: [1, 2, 9],
        remaining: 0,
      });
    });

    it('bounds the destroy list and reports how many superseded versions remain', () => {
      const names = [1, 2, 3, 4, 5, 6].map((n) => ({ name: `projects/123/secrets/s/versions/${n}`, state: 'ENABLED' as const }));
      expect(selectSupersededVersions(names, { keepVersions: 2, maxDestroyPerPut: 3 })).toEqual({
        destroy: [1, 2, 3],
        remaining: 1,
      });
    });

    it('ignores non-enabled entries and unparsable names', () => {
      const names = [
        { name: 'projects/123/secrets/s/versions/1', state: 'ENABLED' as const },
        { name: 'projects/123/secrets/s/versions/2', state: 'DISABLED' as const },
        { name: 'projects/123/secrets/s/versions/3', state: 'DESTROYED' as const },
        { name: 'projects/123/secrets/s/versions/latest', state: 'ENABLED' as const },
        { name: 'projects/123/secrets/s/versions/4', state: 'ENABLED' as const },
        { name: 'projects/123/secrets/s/versions/5', state: 'ENABLED' as const },
      ];
      expect(selectSupersededVersions(names, { keepVersions: 2, maxDestroyPerPut: 10 })).toEqual({ destroy: [1], remaining: 0 });
    });

    it('destroys nothing when at or below the keep count', () => {
      const names = [1, 2].map((n) => ({ name: `projects/123/secrets/s/versions/${n}`, state: 'ENABLED' as const }));
      expect(selectSupersededVersions(names, { keepVersions: 2, maxDestroyPerPut: 10 })).toEqual({ destroy: [], remaining: 0 });
    });
  });
});
