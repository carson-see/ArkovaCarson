import { describe, expect, it } from 'vitest';

import {
  isDbMutatingFile,
  dbMutatingPrs,
  parseGhPrListJson,
  resolveProdGreen,
  evaluateSequencingGate,
  type OpenPrSummary,
} from './check-s33-sequencing-gate';

/**
 * L2-S1 (Sprint 3.3) — red-first tests for the rig-day sequencing gate.
 *
 * The S3.3 window may not start while any DB-mutating PR is still open
 * (an unmerged migration means the schema a freshly provisioned isolated rig
 * replays is about to change → the soak's clean_mirror claim is stale on
 * arrival), or while prod cannot be shown green. All `gh` output is MOCKED —
 * these tests never call GitHub, prod, or any rig.
 */

// ── Mocked `gh pr list --json number,title,isDraft,files` output ────────────
const GH_JSON = JSON.stringify([
  {
    number: 1481,
    title: 'feat(db): migration 0362 org drain checkpoints [T3]',
    isDraft: true,
    files: [
      { path: 'supabase/migrations/0362_org_drain_checkpoints.sql', additions: 40, deletions: 0 },
      { path: 'src/types/database.types.ts', additions: 12, deletions: 2 },
    ],
  },
  {
    number: 1490,
    title: 'docs: HANDOFF refresh',
    isDraft: false,
    files: [{ path: 'HANDOFF.md', additions: 5, deletions: 1 }],
  },
  {
    number: 1492,
    title: 'L2-S2a-FIX: provision Step-4 Scheduler repair [T0]',
    isDraft: true,
    files: [
      { path: 'scripts/staging/provision-isolated-rig.sh', additions: 30, deletions: 10 },
      { path: 'scripts/staging/provision-isolated-rig.test.ts', additions: 200, deletions: 1 },
    ],
  },
]);

describe('parseGhPrListJson — mocked gh output', () => {
  it('parses number/title/isDraft and flattens file paths', () => {
    const prs = parseGhPrListJson(GH_JSON);
    expect(prs).toHaveLength(3);
    expect(prs[0]).toMatchObject({ number: 1481, isDraft: true });
    expect(prs[0].files).toEqual([
      'supabase/migrations/0362_org_drain_checkpoints.sql',
      'src/types/database.types.ts',
    ]);
  });

  it('throws on malformed gh output instead of silently passing the gate', () => {
    expect(() => parseGhPrListJson('not json')).toThrow();
    expect(() => parseGhPrListJson('{"oops":1}')).toThrow();
  });
});

describe('isDbMutatingFile — reuses the staging-evidence DB surface', () => {
  it('classifies migrations as DB-mutating (the PATH_RULES T3 migration rule)', () => {
    expect(isDbMutatingFile('supabase/migrations/0362_org_drain_checkpoints.sql')).toBe(true);
  });

  it('classifies schema artifacts that ride a migration as DB-mutating', () => {
    expect(isDbMutatingFile('supabase/seed.sql')).toBe(true);
    expect(isDbMutatingFile('src/types/database.types.ts')).toBe(true);
    expect(isDbMutatingFile('services/worker/src/types/database.types.ts')).toBe(true);
    expect(isDbMutatingFile('scripts/staging/migrations/staging_only_x.sql')).toBe(true);
  });

  it('does NOT classify tooling / docs / worker code as DB-mutating', () => {
    expect(isDbMutatingFile('scripts/staging/provision-isolated-rig.sh')).toBe(false);
    expect(isDbMutatingFile('HANDOFF.md')).toBe(false);
    expect(isDbMutatingFile('services/worker/src/api/v1/router.ts')).toBe(false);
    expect(isDbMutatingFile('docs/staging/429-limiter-map-s33.md')).toBe(false);
  });
});

describe('dbMutatingPrs — enumerates only the DB-mutating subset', () => {
  it('flags the migration PR (draft or not) and lists its DB files', () => {
    const prs = parseGhPrListJson(GH_JSON);
    const flagged = dbMutatingPrs(prs);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].number).toBe(1481);
    expect(flagged[0].dbFiles).toContain('supabase/migrations/0362_org_drain_checkpoints.sql');
  });

  it('returns empty when no open PR touches a DB surface', () => {
    const prs: OpenPrSummary[] = [
      { number: 7, title: 'docs', isDraft: false, files: ['README.md'] },
    ];
    expect(dbMutatingPrs(prs)).toEqual([]);
  });
});

describe('resolveProdGreen — stub, fail-closed on unknown', () => {
  it('reads the explicit override env', () => {
    expect(resolveProdGreen({ S33_PROD_GREEN: 'true' })).toBe('green');
    expect(resolveProdGreen({ S33_PROD_GREEN: 'false' })).toBe('red');
  });

  it('reports unknown when unset (the stub never guesses green)', () => {
    expect(resolveProdGreen({})).toBe('unknown');
    expect(resolveProdGreen({ S33_PROD_GREEN: 'yes-ish' })).toBe('unknown');
  });
});

describe('evaluateSequencingGate — the rig-day refusal', () => {
  const noPrs: OpenPrSummary[] = [];
  const dbPr: OpenPrSummary = {
    number: 1481,
    title: 'feat(db): migration 0362 [T3]',
    isDraft: true,
    files: ['supabase/migrations/0362_org_drain_checkpoints.sql'],
  };
  const toolingPr: OpenPrSummary = {
    number: 1492,
    title: 'L2-S2a-FIX [T0]',
    isDraft: true,
    files: ['scripts/staging/provision-isolated-rig.sh'],
  };

  it('passes when no DB-mutating PR is open and prod is green', () => {
    const result = evaluateSequencingGate({ openPrs: [toolingPr], prodGreen: 'green' });
    expect(result.ok).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it('fails while ANY DB-mutating PR is still open (unmerged migration = stale rig schema)', () => {
    const result = evaluateSequencingGate({ openPrs: [dbPr, toolingPr], prodGreen: 'green' });
    expect(result.ok).toBe(false);
    expect(result.blockers.some((b) => b.includes('#1481'))).toBe(true);
    expect(result.blockers.some((b) => b.includes('0362_org_drain_checkpoints.sql'))).toBe(true);
  });

  it('a DRAFT DB-mutating PR still blocks (draft state is not merged state)', () => {
    const result = evaluateSequencingGate({ openPrs: [dbPr], prodGreen: 'green' });
    expect(result.ok).toBe(false);
  });

  it('fails closed when prod state is unknown', () => {
    const result = evaluateSequencingGate({ openPrs: noPrs, prodGreen: 'unknown' });
    expect(result.ok).toBe(false);
    expect(result.blockers.some((b) => /prod/i.test(b))).toBe(true);
  });

  it('fails when prod is red', () => {
    const result = evaluateSequencingGate({ openPrs: noPrs, prodGreen: 'red' });
    expect(result.ok).toBe(false);
  });

  it('reports every blocker, not just the first', () => {
    const result = evaluateSequencingGate({ openPrs: [dbPr], prodGreen: 'unknown' });
    expect(result.blockers.length).toBeGreaterThanOrEqual(2);
  });
});
