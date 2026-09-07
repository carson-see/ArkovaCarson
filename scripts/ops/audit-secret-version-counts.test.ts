/**
 * Unit tests for scripts/ops/audit-secret-version-counts.ts. In-memory Secret
 * Manager fake; no gcloud, no network, no payload endpoint.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THRESHOLD,
  EXIT_API_FAILURE,
  EXIT_CLEAN,
  EXIT_FLAGGED,
  parseCliArgs,
  runAudit,
  summarizeVersionCounts,
} from './audit-secret-version-counts.js';

function makeFake(secrets: Record<string, { enabled: number; disabled?: number }>, opts: { pageSize?: number; failVersionsFor?: string } = {}) {
  const calls: string[] = [];
  const pageSize = opts.pageSize ?? 1000;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const u = new URL(url);
    const secretsList = /\/v1\/projects\/([^/]+)\/secrets$/.exec(u.pathname);
    if (secretsList) {
      const ids = Object.keys(secrets).sort();
      const from = Number(u.searchParams.get('pageToken') ?? '0');
      const page = ids.slice(from, from + pageSize);
      const next = from + pageSize < ids.length ? String(from + pageSize) : undefined;
      return new Response(JSON.stringify({ secrets: page.map((id) => ({ name: `projects/123/secrets/${id}` })), ...(next ? { nextPageToken: next } : {}) }), { status: 200 });
    }
    const versionsList = /\/v1\/projects\/[^/]+\/secrets\/([^/]+)\/versions$/.exec(u.pathname);
    if (versionsList) {
      const id = decodeURIComponent(versionsList[1]);
      if (opts.failVersionsFor === id) return new Response('{}', { status: 403 });
      const spec = secrets[id];
      if (!spec) return new Response('{}', { status: 404 });
      const filtered = u.searchParams.get('filter') === 'state:ENABLED';
      const total = spec.enabled + (filtered ? 0 : (spec.disabled ?? 0));
      const from = Number(u.searchParams.get('pageToken') ?? '0');
      const n = Math.max(0, Math.min(pageSize, total - from));
      const next = from + pageSize < total ? String(from + pageSize) : undefined;
      return new Response(JSON.stringify({ versions: Array.from({ length: n }, (_, i) => ({ name: `projects/123/secrets/${id}/versions/${from + i + 1}`, state: 'ENABLED' })), ...(next ? { nextPageToken: next } : {}) }), { status: 200 });
    }
    return new Response('{}', { status: 500 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, deps: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), getAccessToken: async () => 'tok' } };
}

describe('parseCliArgs', () => {
  it('defaults to arkova1 and threshold 20', () => {
    expect(parseCliArgs([])).toEqual({ project: 'arkova1', threshold: DEFAULT_THRESHOLD, json: false });
    expect(DEFAULT_THRESHOLD).toBe(20);
  });
  it('rejects bad project ids and thresholds', () => {
    expect(() => parseCliArgs(['--project', 'Nope!'])).toThrow(/not a valid GCP project id/);
    expect(() => parseCliArgs(['--threshold', '0'])).toThrow(/positive integer/);
    expect(() => parseCliArgs(['--threshold', 'x'])).toThrow(/positive integer/);
    expect(() => parseCliArgs(['--bogus'])).toThrow();
  });
});

describe('summarizeVersionCounts', () => {
  it('flags strictly-greater-than threshold, sorted by count desc then id', () => {
    const s = summarizeVersionCounts([
      { secretId: 'b', enabledVersions: 21 },
      { secretId: 'a', enabledVersions: 21 },
      { secretId: 'c', enabledVersions: 20 },
      { secretId: 'd', enabledVersions: 1645 },
    ], 20);
    expect(s.flagged.map((f) => f.secretId)).toEqual(['d', 'a', 'b']);
    expect(s.total).toBe(4);
    expect(s.totalEnabledVersions).toBe(1707);
  });
});

describe('runAudit', () => {
  it('counts ENABLED versions only (filtered list), flags over-threshold secrets, exits 1', async () => {
    const fake = makeFake({
      'arkova-docusign-org-hash-refresh-token': { enabled: 1731, disabled: 3 },
      'stripe-webhook-secret': { enabled: 2, disabled: 30 },
      'small-secret': { enabled: 1 },
    });
    const c = capture();
    const result = await runAudit({ project: 'arkova1', threshold: 20, json: false }, { fetchImpl: fake.fetchImpl, ...c.deps });
    expect(result.exitCode).toBe(EXIT_FLAGGED);
    expect(result.flagged).toEqual([{ secretId: 'arkova-docusign-org-hash-refresh-token', enabledVersions: 1731 }]);
    expect(result.counts.find((x) => x.secretId === 'stripe-webhook-secret')?.enabledVersions).toBe(2);
    expect(fake.calls.filter((u) => u.includes('/versions?')).every((u) => new URL(u).searchParams.get('filter') === 'state:ENABLED')).toBe(true);
    expect(fake.calls.some((u) => u.includes(':access'))).toBe(false);
    expect(c.out[0]).toContain('secrets=3');
    expect(c.out[0]).toContain('flagged=1');
    expect(c.out.some((l) => /FLAG\s+1731\s+arkova-docusign-org-hash-refresh-token/.test(l))).toBe(true);
  });

  it('exits 0 and says clean when nothing is over threshold; --json emits the summary', async () => {
    const fake = makeFake({ a: { enabled: 20 }, b: { enabled: 1 } });
    const c = capture();
    const result = await runAudit({ project: 'arkova1', threshold: 20, json: true }, { fetchImpl: fake.fetchImpl, ...c.deps });
    expect(result.exitCode).toBe(EXIT_CLEAN);
    const json = JSON.parse(c.out[0]) as { flagged: unknown[]; total: number; threshold: number };
    expect(json).toMatchObject({ flagged: [], total: 2, threshold: 20 });
  });

  it('pages secrets and versions', async () => {
    const secrets: Record<string, { enabled: number }> = {};
    for (let i = 0; i < 12; i++) secrets[`s${String(i).padStart(2, '0')}`] = { enabled: 2 };
    secrets.big = { enabled: 25 };
    const fake = makeFake(secrets, { pageSize: 5 });
    const c = capture();
    const result = await runAudit({ project: 'arkova1', threshold: 20, json: false }, { fetchImpl: fake.fetchImpl, ...c.deps });
    expect(result.counts.length).toBe(13);
    expect(result.counts.find((x) => x.secretId === 'big')?.enabledVersions).toBe(25);
    expect(result.flagged.map((f) => f.secretId)).toEqual(['big']);
  });

  it('a list failure is an API failure (exit 2), not a false clean', async () => {
    const fake = makeFake({ a: { enabled: 1 }, b: { enabled: 1 } }, { failVersionsFor: 'b' });
    const c = capture();
    const result = await runAudit({ project: 'arkova1', threshold: 20, json: false }, { fetchImpl: fake.fetchImpl, ...c.deps });
    expect(result.exitCode).toBe(EXIT_API_FAILURE);
    expect(c.err.join('\n')).toMatch(/list versions failed for b/);
  });
});
