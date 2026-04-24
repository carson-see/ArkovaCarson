import { describe, it, expect } from 'vitest';
import { runChecks, type Check } from '../../scripts/healthcheck/runner';
import { checks } from '../../scripts/healthcheck/checks';

describe('SCRUM-1056 (SEC-HARDEN-03): healthcheck runner', () => {
  it('returns one result per check, in input order', async () => {
    const fake: Check[] = [
      { name: 'a', run: async () => ({ ok: true, detail: 'one' }) },
      { name: 'b', run: async () => ({ ok: false, detail: 'two' }), remediation: 'fix b' },
    ];
    const results = await runChecks(fake);
    expect(results.map((r) => r.name)).toEqual(['a', 'b']);
  });

  it('records a non-negative durationMs for every check', async () => {
    const fake: Check[] = [{ name: 'a', run: async () => ({ ok: true, detail: 'ok' }) }];
    const [r] = await runChecks(fake);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('captures thrown errors as ok=false with the message in detail', async () => {
    const fake: Check[] = [
      {
        name: 'crash',
        run: async () => {
          throw new Error('boom');
        },
        remediation: 'fix crash',
      },
    ];
    const [r] = await runChecks(fake);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('boom');
    // Failed checks must carry the remediation string for `--fix` mode.
    expect(r.remediation).toBe('fix crash');
  });

  it('omits remediation on passing checks (only failures need it)', async () => {
    const fake: Check[] = [
      { name: 'pass', run: async () => ({ ok: true, detail: 'ok' }), remediation: 'unused' },
    ];
    const [r] = await runChecks(fake);
    expect(r.remediation).toBeUndefined();
  });
});

describe('SCRUM-1056 (SEC-HARDEN-03): checks coverage vs. Jira acceptance criteria', () => {
  const names = checks.map((c) => c.name);

  // Jira AC enumerates these services. Each must have a check.
  // Some appear under different names in the implementation (mapped explicitly).
  const required = [
    'github',
    'jira',
    'confluence',
    'supabase',
    'cloudflare',
    'vercel',
    'figma',
    'gcp-adc', // covers `gcloud auth list` context
    'stripe',
    'together',
    'runpod',
    'gemini-vertex', // covers Gemini / Vertex
    'resend',
    'courtlistener',
    'openstates',
    'sam-gov',
    'upstash',
    'sentry',
  ];

  it.each(required)('has a check for %s', (svc) => {
    expect(names).toContain(svc);
  });

  it('every check carries a non-empty remediation string', () => {
    for (const c of checks) {
      expect(c.remediation, `check "${c.name}" missing remediation`).toBeDefined();
      expect(c.remediation?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('check names are unique (no accidental duplicates)', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const n of names) {
      if (seen.has(n)) dupes.push(n);
      seen.add(n);
    }
    expect(dupes).toEqual([]);
  });
});
