/**
 * Unit tests for scripts/ops/prune-docusign-refresh-token-versions.ts.
 *
 * Secret Manager is a hand-rolled in-memory fake behind `fetchImpl`; no gcloud,
 * no network. The fake never serves a payload — the script must never ask for
 * one (`:access` is not implemented and would 500).
 */
import { describe, expect, it } from 'vitest';
import {
  DOCUSIGN_REFRESH_TOKEN_SECRET_ID_RE,
  EXIT_API_FAILURE,
  EXIT_SUCCESS,
  EXIT_VALIDATION,
  isDocusignRefreshTokenSecretId,
  parseCliArgs,
  planPrune,
  runPrune,
  type PruneCliArgs,
} from './prune-docusign-refresh-token-versions.js';

const ORG = '40383eb2-f1cd-4a85-8099-afafff95e5cf';
const HASH = 'd0d00bc8385334315b9b2871f9df627b';
const ORG_SECRET = `arkova-docusign-${ORG}-${HASH}-refresh-token`;
const MEMBER_SECRET = `arkova-docusign-member-2f1b4c9a-0000-4000-8000-000000000001-${HASH}-refresh-token`;

type State = 'ENABLED' | 'DISABLED' | 'DESTROYED';

function makeFake(secrets: Record<string, Record<number, State>>, opts: { pageSize?: number; destroyStatus?: number; listStatus?: number } = {}) {
  const store = new Map<string, Map<number, State>>();
  for (const [id, versions] of Object.entries(secrets)) {
    store.set(id, new Map(Object.entries(versions).map(([k, v]) => [Number(k), v])));
  }
  const calls: string[] = [];
  const pageSize = opts.pageSize ?? 1000;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    const u = new URL(url);

    const secretsList = /\/v1\/projects\/([^/]+)\/secrets$/.exec(u.pathname);
    if (secretsList && method === 'GET') {
      const ids = [...store.keys()].sort();
      const from = Number(u.searchParams.get('pageToken') ?? '0');
      const page = ids.slice(from, from + pageSize);
      const next = from + pageSize < ids.length ? String(from + pageSize) : undefined;
      return new Response(JSON.stringify({
        secrets: page.map((id) => ({ name: `projects/123/secrets/${id}` })),
        ...(next ? { nextPageToken: next } : {}),
      }), { status: 200 });
    }

    const versionsList = /\/v1\/projects\/[^/]+\/secrets\/([^/]+)\/versions$/.exec(u.pathname);
    if (versionsList && method === 'GET') {
      if (opts.listStatus) return new Response('{}', { status: opts.listStatus });
      const versions = store.get(versionsList[1]);
      if (!versions) return new Response('{}', { status: 404 });
      let ids = [...versions.keys()].sort((a, b) => b - a);
      if (u.searchParams.get('filter') === 'state:ENABLED') ids = ids.filter((id) => versions.get(id) === 'ENABLED');
      const from = Number(u.searchParams.get('pageToken') ?? '0');
      const page = ids.slice(from, from + pageSize);
      const next = from + pageSize < ids.length ? String(from + pageSize) : undefined;
      return new Response(JSON.stringify({
        versions: page.map((id) => ({ name: `projects/123/secrets/${versionsList[1]}/versions/${id}`, state: versions.get(id), createTime: `2026-08-${String((id % 28) + 1).padStart(2, '0')}T00:00:00Z` })),
        ...(next ? { nextPageToken: next } : {}),
      }), { status: 200 });
    }

    const destroy = /\/v1\/projects\/[^/]+\/secrets\/([^/]+)\/versions\/(\d+):destroy$/.exec(u.pathname);
    if (destroy && method === 'POST') {
      if (opts.destroyStatus) return new Response('{}', { status: opts.destroyStatus });
      const versions = store.get(destroy[1]);
      const id = Number(destroy[2]);
      if (!versions?.has(id)) return new Response('{}', { status: 404 });
      versions.set(id, 'DESTROYED');
      return new Response(JSON.stringify({ name: `projects/123/secrets/${destroy[1]}/versions/${id}`, state: 'DESTROYED' }), { status: 200 });
    }

    return new Response('{}', { status: 500 });
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    calls,
    enabled: (id: string) => [...(store.get(id)?.entries() ?? [])].filter(([, s]) => s === 'ENABLED').map(([v]) => v).sort((a, b) => a - b),
    destroyCalls: () => calls.filter((c) => c.endsWith(':destroy')),
  };
}

function args(overrides: Partial<PruneCliArgs> = {}): PruneCliArgs {
  return { project: 'arkova1', all: false, keep: 2, batchSize: 50, apply: false, ...overrides };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, deps: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), getAccessToken: async () => 'tok' } };
}

describe('secret id pattern', () => {
  it('accepts org-level and member-level DocuSign refresh-token ids and nothing else', () => {
    expect(isDocusignRefreshTokenSecretId(ORG_SECRET)).toBe(true);
    expect(isDocusignRefreshTokenSecretId(MEMBER_SECRET)).toBe(true);
    for (const bad of [
      'BITCOIN_TREASURY_WIF',
      'docusign_client_secret',
      'arkova-docusign-refresh-token',
      `arkova-docusign-${ORG}-${HASH}`,
      `arkova-docusign-${ORG}-${HASH.slice(0, 31)}-refresh-token`,
      `arkova-docusign-${ORG}-${HASH.toUpperCase()}-refresh-token`,
      `arkova-docusign-${ORG}-${HASH}-refresh-token-old`,
      ` ${ORG_SECRET}`,
      `${ORG_SECRET}\n`,
      `projects/arkova1/secrets/${ORG_SECRET}`,
    ]) {
      expect(isDocusignRefreshTokenSecretId(bad), bad).toBe(false);
    }
    expect(DOCUSIGN_REFRESH_TOKEN_SECRET_ID_RE.flags).toBe('');
  });
});

describe('parseCliArgs', () => {
  it('defaults to dry run, keep 2, batch 50, project arkova1', () => {
    expect(parseCliArgs(['--secret', ORG_SECRET])).toEqual({
      project: 'arkova1', secret: ORG_SECRET, all: false, keep: 2, batchSize: 50, maxDestroy: undefined, apply: false,
    });
  });

  it('refuses a secret that does not match the pattern before anything else', () => {
    expect(() => parseCliArgs(['--secret', 'docusign_client_secret'])).toThrow(/refusing/);
  });

  it('refuses --all --apply', () => {
    expect(() => parseCliArgs(['--all', '--apply'])).toThrow(/one --secret at a time/);
  });

  it('refuses --keep 0, non-integer numbers, repeated flags, unknown flags, and missing target', () => {
    expect(() => parseCliArgs(['--secret', ORG_SECRET, '--keep', '0'])).toThrow(/--keep must be at least 1/);
    expect(() => parseCliArgs(['--secret', ORG_SECRET, '--batch-size', 'ten'])).toThrow(/non-negative integer/);
    expect(() => parseCliArgs(['--secret', ORG_SECRET, '--secret', ORG_SECRET])).toThrow(/more than once/);
    expect(() => parseCliArgs(['--secret', ORG_SECRET, '--force'])).toThrow();
    expect(() => parseCliArgs([])).toThrow(/--secret <id> or --all/);
    expect(() => parseCliArgs(['--secret', ORG_SECRET, '--all'])).toThrow(/mutually exclusive/);
    expect(() => parseCliArgs(['--all', '--project', 'Bad Project'])).toThrow(/not a valid GCP project id/);
  });

  it('parses --max-destroy and --apply', () => {
    expect(parseCliArgs(['--secret', ORG_SECRET, '--max-destroy', '100', '--apply'])).toMatchObject({ maxDestroy: 100, apply: true });
  });
});

describe('planPrune', () => {
  const rows = (ids: number[], state: State = 'ENABLED') => ids.map((id) => ({ name: `projects/123/secrets/s/versions/${id}`, state }));

  it('keeps the newest N numerically and lists the rest oldest-first', () => {
    const plan = planPrune('s', [...rows([9, 10, 11, 1, 2]), ...rows([12], 'DISABLED'), ...rows([13], 'DESTROYED')], { keep: 2 });
    expect(plan.kept).toEqual([11, 10]);
    expect(plan.destroy).toEqual([1, 2, 9]);
    expect(plan.enabledCount).toBe(5);
    expect(plan.oldestEnabled?.version).toBe(1);
    expect(plan.newestEnabled?.version).toBe(11);
  });

  it('caps at maxDestroy, oldest first', () => {
    expect(planPrune('s', rows([1, 2, 3, 4, 5, 6]), { keep: 2, maxDestroy: 3 }).destroy).toEqual([1, 2, 3]);
  });

  it('destroys nothing at or below keep', () => {
    expect(planPrune('s', rows([1, 2]), { keep: 2 }).destroy).toEqual([]);
    expect(planPrune('s', [], { keep: 2 }).destroy).toEqual([]);
  });
});

describe('runPrune', () => {
  it('dry run lists, plans, prints counts, and calls no destroy endpoint', async () => {
    const versions: Record<number, State> = {};
    for (let i = 1; i <= 25; i++) versions[i] = 'ENABLED';
    versions[26] = 'DISABLED';
    const fake = makeFake({ [ORG_SECRET]: versions, [MEMBER_SECRET]: { 1: 'ENABLED', 2: 'ENABLED', 3: 'ENABLED' }, docusign_client_secret: { 1: 'ENABLED' } });
    const c = capture();

    const result = await runPrune(args({ all: true }), { fetchImpl: fake.fetchImpl, ...c.deps });

    expect(result.exitCode).toBe(EXIT_SUCCESS);
    expect(result.secrets.map((s) => [s.secretId, s.enabledCount, s.destroy.length, s.applied])).toEqual([
      [ORG_SECRET, 25, 23, false],
      [MEMBER_SECRET, 3, 1, false],
    ]);
    expect(fake.destroyCalls()).toEqual([]);
    expect(fake.calls.some((l) => l.includes('docusign_client_secret'))).toBe(false);
    expect(fake.calls.some((l) => l.includes(':access'))).toBe(false);
    expect(c.out[0]).toMatch(/^DRY RUN/);
    expect(c.out.join('\n')).toContain(`enabled=25 keep=25,24 would_destroy=23`);
    const summary = JSON.parse(c.out[c.out.length - 1]) as { mode: string; secrets: Array<{ destroyCount: number }> };
    expect(summary.mode).toBe('dry-run');
    expect(summary.secrets[0].destroyCount).toBe(23);
  });

  it('pages both the secret list and the version list', async () => {
    const versions: Record<number, State> = {};
    for (let i = 1; i <= 7; i++) versions[i] = 'ENABLED';
    const fake = makeFake({ [ORG_SECRET]: versions, [MEMBER_SECRET]: { 1: 'ENABLED' } }, { pageSize: 3 });
    const c = capture();

    const result = await runPrune(args({ all: true }), { fetchImpl: fake.fetchImpl, ...c.deps });

    expect(result.secrets[0].enabledCount).toBe(7);
    expect(result.secrets[0].destroy).toEqual([1, 2, 3, 4, 5]);
    expect(fake.calls.filter((l) => l.includes('pageToken=')).length).toBeGreaterThanOrEqual(2);
  });

  it('refuses --apply without a matching CONFIRM env var and destroys nothing', async () => {
    const fake = makeFake({ [ORG_SECRET]: { 1: 'ENABLED', 2: 'ENABLED', 3: 'ENABLED' } });
    for (const env of [{}, { CONFIRM_DESTROY_SECRET_VERSIONS: MEMBER_SECRET }, { CONFIRM_DESTROY_SECRET_VERSIONS: 'yes' }]) {
      const c = capture();
      const result = await runPrune(args({ secret: ORG_SECRET, apply: true }), { fetchImpl: fake.fetchImpl, env, ...c.deps });
      expect(result.exitCode).toBe(EXIT_VALIDATION);
      expect(c.err.join('\n')).toMatch(/CONFIRM_DESTROY_SECRET_VERSIONS/);
    }
    expect(fake.destroyCalls()).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it('refuses --all --apply even when handed pre-built args', async () => {
    const fake = makeFake({ [ORG_SECRET]: { 1: 'ENABLED', 2: 'ENABLED', 3: 'ENABLED' } });
    const c = capture();
    const result = await runPrune(args({ all: true, apply: true }), { fetchImpl: fake.fetchImpl, env: { CONFIRM_DESTROY_SECRET_VERSIONS: ORG_SECRET }, ...c.deps });
    expect(result.exitCode).toBe(EXIT_VALIDATION);
    expect(fake.calls).toEqual([]);
  });

  it('refuses a non-matching secret id handed as pre-built args, before any API call', async () => {
    const fake = makeFake({ BITCOIN_TREASURY_WIF: { 1: 'ENABLED', 2: 'ENABLED', 3: 'ENABLED' } });
    const c = capture();
    const result = await runPrune(args({ secret: 'BITCOIN_TREASURY_WIF', apply: true }), { fetchImpl: fake.fetchImpl, env: { CONFIRM_DESTROY_SECRET_VERSIONS: 'BITCOIN_TREASURY_WIF' }, ...c.deps });
    expect(result.exitCode).toBe(EXIT_VALIDATION);
    expect(fake.calls).toEqual([]);
  });

  it('apply with the matching confirm destroys the superseded versions in batches, keeps the newest 2, never fetches a payload', async () => {
    const versions: Record<number, State> = {};
    for (let i = 1; i <= 120; i++) versions[i] = 'ENABLED';
    const fake = makeFake({ [ORG_SECRET]: versions });
    const c = capture();

    const result = await runPrune(
      args({ secret: ORG_SECRET, apply: true, batchSize: 50 }),
      { fetchImpl: fake.fetchImpl, env: { CONFIRM_DESTROY_SECRET_VERSIONS: ORG_SECRET }, ...c.deps },
    );

    expect(result.exitCode).toBe(EXIT_SUCCESS);
    expect(result.secrets[0]).toMatchObject({ applied: true, destroyed: 118, failed: 0, kept: [120, 119] });
    expect(fake.enabled(ORG_SECRET)).toEqual([119, 120]);
    expect(fake.destroyCalls()).toHaveLength(118);
    expect(fake.calls.some((l) => l.includes(':access'))).toBe(false);
    expect(c.out.filter((l) => l.includes('batch '))).toHaveLength(3); // 50 + 50 + 18
    const summary = JSON.parse(c.out[c.out.length - 1]) as { mode: string; secrets: Array<{ destroyed: number; kept: number[] }> };
    expect(summary.mode).toBe('apply');
    expect(summary.secrets[0]).toMatchObject({ destroyed: 118, kept: [120, 119] });
  });

  it('apply honours --max-destroy so a backlog can be drained in verified steps', async () => {
    const versions: Record<number, State> = {};
    for (let i = 1; i <= 10; i++) versions[i] = 'ENABLED';
    const fake = makeFake({ [ORG_SECRET]: versions });
    const c = capture();

    await runPrune(
      args({ secret: ORG_SECRET, apply: true, maxDestroy: 3 }),
      { fetchImpl: fake.fetchImpl, env: { CONFIRM_DESTROY_SECRET_VERSIONS: ORG_SECRET }, ...c.deps },
    );

    expect(fake.enabled(ORG_SECRET)).toEqual([4, 5, 6, 7, 8, 9, 10]);
  });

  it('reports destroy failures with a non-zero exit and leaves the newest versions untouched', async () => {
    const fake = makeFake({ [ORG_SECRET]: { 1: 'ENABLED', 2: 'ENABLED', 3: 'ENABLED', 4: 'ENABLED' } }, { destroyStatus: 403 });
    const c = capture();

    const result = await runPrune(
      args({ secret: ORG_SECRET, apply: true }),
      { fetchImpl: fake.fetchImpl, env: { CONFIRM_DESTROY_SECRET_VERSIONS: ORG_SECRET }, ...c.deps },
    );

    expect(result.exitCode).toBe(EXIT_API_FAILURE);
    expect(result.secrets[0]).toMatchObject({ destroyed: 0, failed: 2 });
    expect(fake.enabled(ORG_SECRET)).toEqual([1, 2, 3, 4]);
  });

  it('a failed list is an API failure with nothing destroyed', async () => {
    const fake = makeFake({ [ORG_SECRET]: { 1: 'ENABLED', 2: 'ENABLED', 3: 'ENABLED' } }, { listStatus: 500 });
    const c = capture();
    const result = await runPrune(args({ secret: ORG_SECRET }), { fetchImpl: fake.fetchImpl, ...c.deps });
    expect(result.exitCode).toBe(EXIT_API_FAILURE);
    expect(fake.destroyCalls()).toEqual([]);
    expect(c.err.join('\n')).toMatch(/list versions failed/);
  });
});
