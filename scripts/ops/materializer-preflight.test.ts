/**
 * SCRUM-2984 — unit tests for scripts/ops/materializer-preflight.ts.
 *
 * Tests the pure mapping / verdict functions with mocked query result rows.
 * No real Supabase Management API call is made except in the queryReadOnly
 * test, which stubs global fetch (mirrors
 * scripts/ci/staging-honesty-preflight.test.ts's queryManagementApi test).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BLOAT_RATIO_WARN_THRESHOLD,
  LOCK_CONTENTION_WARN_SECONDS,
  VACUUM_AGE_WARN_THRESHOLD_HOURS,
  VACUUM_DEAD_TUPLE_WARN_THRESHOLD,
  WEDGE_SIGNATURE_DURATION_FLOOR_SECONDS,
  buildReport,
  classifyWedgeSignature,
  evaluateAutovacuumStaleness,
  evaluateBloatHeadroom,
  evaluateGapSanity,
  evaluateLockContention,
  formatText,
  mapAutovacuumRows,
  mapGapRow,
  mapLockContentionRows,
  mapPgStatUserTablesToBloatRows,
  mapPgstattupleApproxRows,
  parseArgs,
  queryReadOnly,
  type AutovacuumStatsRow,
  type BloatStatsRow,
  type GapEstimate,
  type LockContentionRow,
} from './materializer-preflight.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// mapGapRow
// ---------------------------------------------------------------------------

describe('mapGapRow', () => {
  it('computes gap from anchors estimate minus exact proof count', () => {
    const result = mapGapRow([{ anchors_estimate: 2_962_154, proof_rows_exact: 6_110 }]);
    expect(result).toEqual({ anchorsEstimate: 2_962_154, proofRowsExact: 6_110, gap: 2_956_044 });
  });

  it('coerces stringified bigints from the Management API', () => {
    const result = mapGapRow([{ anchors_estimate: '2962154', proof_rows_exact: '6110' }]);
    expect(result.anchorsEstimate).toBe(2_962_154);
    expect(result.proofRowsExact).toBe(6_110);
  });

  it('defaults to zeros on an empty result set', () => {
    expect(mapGapRow([])).toEqual({ anchorsEstimate: 0, proofRowsExact: 0, gap: 0 });
  });
});

// ---------------------------------------------------------------------------
// mapPgstattupleApproxRows / mapPgStatUserTablesToBloatRows
// ---------------------------------------------------------------------------

describe('mapPgstattupleApproxRows', () => {
  // approx_tuple_count from pgstattuple_approx() is documented (Postgres
  // docs, pgstattuple appendix) as ALREADY the estimated live-tuple count —
  // NOT live+dead combined. dead_tuple_count is a separate, exact count.
  // liveTuples must equal approx_tuple_count as-is; subtracting dead again
  // double-counts it out of the live estimate.
  it('maps dead/live tuples and computes ratio', () => {
    const rows = mapPgstattupleApproxRows([
      { relname: 'anchors', dead_tuple_count: 100, approx_tuple_count: 1000 },
      { relname: 'anchor_proofs', dead_tuple_count: 0, approx_tuple_count: 6110 },
    ]);
    expect(rows).toEqual([
      { table: 'anchors', liveTuples: 1000, deadTuples: 100, deadTupleRatio: 100 / 1100, source: 'pgstattuple_approx' },
      { table: 'anchor_proofs', liveTuples: 6110, deadTuples: 0, deadTupleRatio: 0, source: 'pgstattuple_approx' },
    ]);
  });

  // Regression case for the double-subtraction bug: under the buggy
  // `live = max(approxTotal - dead, 0)` formula, dead >= approx collapses
  // liveTuples to 0 and deadTupleRatio to a nonsensical 100%, even though
  // approx_tuple_count is already the live estimate and dead_tuple_count is
  // an independent exact count — the two are not mutually exclusive splits
  // of the same total, so dead can legitimately meet or exceed approx
  // without the table being 100% dead.
  it('does not collapse to 100% dead when dead_tuple_count >= approx_tuple_count (regression: double-subtraction)', () => {
    const rows = mapPgstattupleApproxRows([
      { relname: 'anchors', dead_tuple_count: 1200, approx_tuple_count: 1000 },
    ]);
    expect(rows[0].liveTuples).toBe(1000);
    expect(rows[0].deadTuples).toBe(1200);
    expect(rows[0].deadTupleRatio).toBeCloseTo(1200 / 2200, 6);
    expect(rows[0].deadTupleRatio).not.toBe(1);
  });

  it('ignores rows for tables outside the target set', () => {
    const rows = mapPgstattupleApproxRows([
      { relname: 'organizations', dead_tuple_count: 5, approx_tuple_count: 50 },
    ]);
    expect(rows).toEqual([]);
  });

  it('handles zero total tuples without dividing by zero', () => {
    const rows = mapPgstattupleApproxRows([{ relname: 'anchors', dead_tuple_count: 0, approx_tuple_count: 0 }]);
    expect(rows[0].deadTupleRatio).toBe(0);
  });
});

describe('mapPgStatUserTablesToBloatRows', () => {
  it('maps n_live_tup/n_dead_tup and computes ratio', () => {
    const rows = mapPgStatUserTablesToBloatRows([
      { relname: 'anchors', n_live_tup: 2_900_000, n_dead_tup: 62_154 },
    ]);
    expect(rows[0].source).toBe('pg_stat_user_tables');
    expect(rows[0].deadTupleRatio).toBeCloseTo(62_154 / (2_900_000 + 62_154), 6);
  });
});

// ---------------------------------------------------------------------------
// mapAutovacuumRows
// ---------------------------------------------------------------------------

describe('mapAutovacuumRows', () => {
  const NOW = new Date('2026-07-28T12:00:00Z');

  it('computes vacuum age in hours from the more recent of vacuum/analyze', () => {
    const rows = mapAutovacuumRows(
      [
        {
          relname: 'anchors',
          last_autovacuum: '2026-07-28T06:00:00Z',
          last_autoanalyze: '2026-07-27T00:00:00Z',
          autovacuum_count: 12,
          n_dead_tup: 50_000,
        },
      ],
      NOW,
    );
    expect(rows[0].vacuumAgeHours).toBe(6);
    expect(rows[0].deadTuples).toBe(50_000);
  });

  it('prefers autoanalyze when it is more recent than autovacuum', () => {
    const rows = mapAutovacuumRows(
      [
        {
          relname: 'anchor_proofs',
          last_autovacuum: '2026-07-20T00:00:00Z',
          last_autoanalyze: '2026-07-28T10:00:00Z',
          autovacuum_count: 3,
          n_dead_tup: 10,
        },
      ],
      NOW,
    );
    expect(rows[0].vacuumAgeHours).toBe(2);
  });

  it('returns null age when neither has ever run', () => {
    const rows = mapAutovacuumRows(
      [{ relname: 'anchors', last_autovacuum: null, last_autoanalyze: null, autovacuum_count: 0, n_dead_tup: 0 }],
      NOW,
    );
    expect(rows[0].vacuumAgeHours).toBeNull();
  });

  // Regression case for the Math.floor under-report: a vacuum 24h59m ago is
  // truly past the 24h WARN boundary. Math.floor((24h59m)) === 24, which is
  // NOT > VACUUM_AGE_WARN_THRESHOLD_HOURS (24) and would wrongly stay under
  // the boundary for nearly a full hour. Rounding to 1 decimal reports ~25h
  // instead, correctly past the boundary.
  it('does not under-report age at the 24h boundary (regression: Math.floor)', () => {
    const rows = mapAutovacuumRows(
      [
        {
          relname: 'anchors',
          last_autovacuum: '2026-07-27T11:01:00Z', // exactly 24h59m before NOW
          last_autoanalyze: null,
          autovacuum_count: 5,
          n_dead_tup: VACUUM_DEAD_TUPLE_WARN_THRESHOLD + 1,
        },
      ],
      NOW,
    );
    expect(rows[0].vacuumAgeHours).toBeGreaterThan(VACUUM_AGE_WARN_THRESHOLD_HOURS);
    expect(evaluateAutovacuumStaleness(rows)[0].severity).toBe('warn');
  });
});

// ---------------------------------------------------------------------------
// classifyWedgeSignature / mapLockContentionRows
// ---------------------------------------------------------------------------

describe('classifyWedgeSignature', () => {
  it('flags a query containing batch_insert_anchors', () => {
    expect(classifyWedgeSignature('SELECT batch_insert_anchors($1, $2)')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(classifyWedgeSignature('select BATCH_INSERT_ANCHORS(...)')).toBe(true);
  });

  it('does not flag an unrelated query', () => {
    expect(classifyWedgeSignature('SELECT * FROM anchors WHERE status = $1')).toBe(false);
  });
});

describe('mapLockContentionRows', () => {
  it('maps rows and strips the public. schema prefix from relation', () => {
    const rows = mapLockContentionRows([
      {
        pid: 4242,
        relation: 'public.anchors',
        lock_mode: 'RowExclusiveLock',
        granted: true,
        running_seconds: 106,
        query: 'SELECT public.batch_insert_anchors($1)',
      },
    ]);
    expect(rows).toEqual([
      {
        pid: 4242,
        relation: 'anchors',
        lockMode: 'RowExclusiveLock',
        granted: true,
        runningSeconds: 106,
        queryText: 'SELECT public.batch_insert_anchors($1)',
        isKnownWedgeSignature: true,
      },
    ]);
  });

  it('defaults to an empty query string when query is null', () => {
    const rows = mapLockContentionRows([
      { pid: 1, relation: 'public.anchor_proofs', lock_mode: 'RowExclusiveLock', granted: true, running_seconds: 1, query: null },
    ]);
    expect(rows[0].queryText).toBe('');
    expect(rows[0].isKnownWedgeSignature).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluateGapSanity
// ---------------------------------------------------------------------------

describe('evaluateGapSanity', () => {
  it('passes for a healthy positive gap', () => {
    const gap: GapEstimate = { anchorsEstimate: 2_962_154, proofRowsExact: 6_110, gap: 2_956_044 };
    const findings = evaluateGapSanity(gap);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('pass');
  });

  it('warns when the gap is zero', () => {
    const gap: GapEstimate = { anchorsEstimate: 6_110, proofRowsExact: 6_110, gap: 0 };
    expect(evaluateGapSanity(gap)[0].severity).toBe('warn');
  });

  it('warns when the gap is negative', () => {
    const gap: GapEstimate = { anchorsEstimate: 100, proofRowsExact: 200, gap: -100 };
    expect(evaluateGapSanity(gap)[0].severity).toBe('warn');
  });
});

// ---------------------------------------------------------------------------
// evaluateBloatHeadroom
// ---------------------------------------------------------------------------

describe('evaluateBloatHeadroom', () => {
  it('passes below the threshold', () => {
    const rows: BloatStatsRow[] = [
      { table: 'anchors', liveTuples: 990_000, deadTuples: 10_000, deadTupleRatio: 0.01, source: 'pgstattuple_approx' },
    ];
    expect(evaluateBloatHeadroom(rows)[0].severity).toBe('pass');
  });

  it('warns at or above the threshold', () => {
    const rows: BloatStatsRow[] = [
      {
        table: 'anchors',
        liveTuples: 800_000,
        deadTuples: 200_000,
        deadTupleRatio: BLOAT_RATIO_WARN_THRESHOLD,
        source: 'pg_stat_user_tables',
      },
    ];
    expect(evaluateBloatHeadroom(rows)[0].severity).toBe('warn');
  });

  it('evaluates each table independently', () => {
    const rows: BloatStatsRow[] = [
      { table: 'anchors', liveTuples: 100, deadTuples: 0, deadTupleRatio: 0, source: 'pgstattuple_approx' },
      { table: 'anchor_proofs', liveTuples: 100, deadTuples: 900, deadTupleRatio: 0.9, source: 'pgstattuple_approx' },
    ];
    const findings = evaluateBloatHeadroom(rows);
    expect(findings[0].severity).toBe('pass');
    expect(findings[1].severity).toBe('warn');
  });
});

// ---------------------------------------------------------------------------
// evaluateAutovacuumStaleness
// ---------------------------------------------------------------------------

describe('evaluateAutovacuumStaleness', () => {
  it('passes when vacuum is recent', () => {
    const rows: AutovacuumStatsRow[] = [
      { table: 'anchors', lastAutovacuum: 'x', lastAutoanalyze: null, autovacuumCount: 1, deadTuples: 500_000, vacuumAgeHours: 1 },
    ];
    expect(evaluateAutovacuumStaleness(rows)[0].severity).toBe('pass');
  });

  it('passes when vacuum is stale but dead tuples are below the threshold', () => {
    const rows: AutovacuumStatsRow[] = [
      {
        table: 'anchors',
        lastAutovacuum: 'x',
        lastAutoanalyze: null,
        autovacuumCount: 1,
        deadTuples: VACUUM_DEAD_TUPLE_WARN_THRESHOLD - 1,
        vacuumAgeHours: VACUUM_AGE_WARN_THRESHOLD_HOURS + 1,
      },
    ];
    expect(evaluateAutovacuumStaleness(rows)[0].severity).toBe('pass');
  });

  it('warns when vacuum is stale AND dead tuples exceed the threshold', () => {
    const rows: AutovacuumStatsRow[] = [
      {
        table: 'anchors',
        lastAutovacuum: 'x',
        lastAutoanalyze: null,
        autovacuumCount: 1,
        deadTuples: VACUUM_DEAD_TUPLE_WARN_THRESHOLD + 1,
        vacuumAgeHours: VACUUM_AGE_WARN_THRESHOLD_HOURS + 1,
      },
    ];
    expect(evaluateAutovacuumStaleness(rows)[0].severity).toBe('warn');
  });

  it('passes (does not crash) when vacuum has never run', () => {
    const rows: AutovacuumStatsRow[] = [
      { table: 'anchors', lastAutovacuum: null, lastAutoanalyze: null, autovacuumCount: 0, deadTuples: 1_000_000, vacuumAgeHours: null },
    ];
    expect(evaluateAutovacuumStaleness(rows)[0].severity).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// evaluateLockContention
// ---------------------------------------------------------------------------

describe('evaluateLockContention', () => {
  it('passes when there is no contention', () => {
    const findings = evaluateLockContention([]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('pass');
  });

  it('passes for a short-held conflicting lock', () => {
    const rows: LockContentionRow[] = [
      {
        pid: 1,
        relation: 'anchors',
        lockMode: 'RowExclusiveLock',
        granted: true,
        runningSeconds: LOCK_CONTENTION_WARN_SECONDS - 1,
        queryText: 'INSERT INTO anchors ...',
        isKnownWedgeSignature: false,
      },
    ];
    expect(evaluateLockContention(rows)[0].severity).toBe('pass');
  });

  it('warns for a long-held conflicting lock', () => {
    const rows: LockContentionRow[] = [
      {
        pid: 1,
        relation: 'anchors',
        lockMode: 'RowExclusiveLock',
        granted: true,
        runningSeconds: LOCK_CONTENTION_WARN_SECONDS + 1,
        queryText: 'INSERT INTO anchors ...',
        isKnownWedgeSignature: false,
      },
    ];
    const findings = evaluateLockContention(rows);
    expect(findings[0].severity).toBe('warn');
  });

  it('warns on the known SCRUM-3031 wedge signature once past the (lower) wedge duration floor, well under the general threshold', () => {
    const rows: LockContentionRow[] = [
      {
        pid: 99,
        relation: 'anchors',
        lockMode: 'RowExclusiveLock',
        granted: true,
        runningSeconds: WEDGE_SIGNATURE_DURATION_FLOOR_SECONDS + 1,
        queryText: 'SELECT batch_insert_anchors($1)',
        isKnownWedgeSignature: true,
      },
    ];
    const findings = evaluateLockContention(rows);
    expect(findings[0].severity).toBe('warn');
    expect(findings[0].message).toMatch(/SCRUM-3031/);
  });

  // Regression case: PR #1730 reuses the batch_insert_anchors name for a
  // fixed, ~11ms-healthy RPC. A bare substring match on query text with no
  // duration floor would fire a spurious WARN on every routine call once
  // that lands. A signature match must also clear
  // WEDGE_SIGNATURE_DURATION_FLOOR_SECONDS before it counts as an offender.
  it('does not warn on a fast healthy call that merely matches the wedge signature by name', () => {
    const rows: LockContentionRow[] = [
      {
        pid: 100,
        relation: 'anchors',
        lockMode: 'RowExclusiveLock',
        granted: true,
        runningSeconds: 0,
        queryText: 'SELECT batch_insert_anchors($1, $2)',
        isKnownWedgeSignature: true,
      },
    ];
    const findings = evaluateLockContention(rows);
    expect(findings[0].severity).toBe('pass');
  });

  it('ignores a granted AccessShareLock regardless of duration', () => {
    const rows: LockContentionRow[] = [
      {
        pid: 2,
        relation: 'anchors',
        lockMode: 'AccessShareLock',
        granted: true,
        runningSeconds: 999,
        queryText: 'SELECT * FROM anchors',
        isKnownWedgeSignature: false,
      },
    ];
    expect(evaluateLockContention(rows)[0].severity).toBe('pass');
  });

  it('ignores an ungranted (waiting) lock row', () => {
    const rows: LockContentionRow[] = [
      {
        pid: 3,
        relation: 'anchors',
        lockMode: 'RowExclusiveLock',
        granted: false,
        runningSeconds: 999,
        queryText: 'INSERT INTO anchors ...',
        isKnownWedgeSignature: false,
      },
    ];
    expect(evaluateLockContention(rows)[0].severity).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// buildReport
// ---------------------------------------------------------------------------

describe('buildReport', () => {
  const HEALTHY_GAP: GapEstimate = { anchorsEstimate: 2_962_154, proofRowsExact: 6_110, gap: 2_956_044 };
  const HEALTHY_BLOAT: BloatStatsRow[] = [
    { table: 'anchors', liveTuples: 2_900_000, deadTuples: 1_000, deadTupleRatio: 0.0003, source: 'pgstattuple_approx' },
    { table: 'anchor_proofs', liveTuples: 6_110, deadTuples: 0, deadTupleRatio: 0, source: 'pgstattuple_approx' },
  ];
  const HEALTHY_AUTOVACUUM: AutovacuumStatsRow[] = [
    { table: 'anchors', lastAutovacuum: 'x', lastAutoanalyze: null, autovacuumCount: 10, deadTuples: 1_000, vacuumAgeHours: 1 },
    { table: 'anchor_proofs', lastAutovacuum: 'x', lastAutoanalyze: null, autovacuumCount: 10, deadTuples: 0, vacuumAgeHours: 1 },
  ];

  it('returns PASS when every check passes', () => {
    const report = buildReport({
      projectRef: 'vzwyaatejekddvltxyye',
      gap: HEALTHY_GAP,
      bloat: HEALTHY_BLOAT,
      autovacuum: HEALTHY_AUTOVACUUM,
      lockContention: [],
      now: new Date('2026-07-28T12:00:00Z'),
    });
    expect(report.verdict).toBe('PASS');
    expect(report.findings.every((f) => f.severity === 'pass')).toBe(true);
    expect(report.projectRef).toBe('vzwyaatejekddvltxyye');
    expect(report.timestamp).toBe('2026-07-28T12:00:00.000Z');
  });

  it('returns WARN when any single check warns (bloat)', () => {
    const report = buildReport({
      projectRef: 'ref',
      gap: HEALTHY_GAP,
      bloat: [{ table: 'anchors', liveTuples: 1, deadTuples: 99, deadTupleRatio: 0.99, source: 'pgstattuple_approx' }],
      autovacuum: HEALTHY_AUTOVACUUM,
      lockContention: [],
    });
    expect(report.verdict).toBe('WARN');
  });

  it('returns WARN when the lock-contention check warns, independent of every other check passing', () => {
    const report = buildReport({
      projectRef: 'ref',
      gap: HEALTHY_GAP,
      bloat: HEALTHY_BLOAT,
      autovacuum: HEALTHY_AUTOVACUUM,
      lockContention: [
        {
          pid: 1,
          relation: 'anchors',
          lockMode: 'RowExclusiveLock',
          granted: true,
          runningSeconds: 200,
          queryText: 'SELECT batch_insert_anchors()',
          isKnownWedgeSignature: true,
        },
      ],
    });
    expect(report.verdict).toBe('WARN');
    expect(report.findings.some((f) => f.check === 'lock_contention' && f.severity === 'warn')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatText
// ---------------------------------------------------------------------------

describe('formatText', () => {
  it('renders the verdict and every finding', () => {
    const text = formatText(
      buildReport({
        projectRef: 'ref',
        gap: { anchorsEstimate: 10, proofRowsExact: 1, gap: 9 },
        bloat: [],
        autovacuum: [],
        lockContention: [],
        now: new Date('2026-07-28T12:00:00Z'),
      }),
    );
    expect(text).toMatch(/Verdict: PASS/);
    expect(text).toMatch(/\[PASS\] gap_sanity/);
  });
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('parses project-ref, management-api-token, and format', () => {
    const args = parseArgs(['--project-ref', 'ref123', '--management-api-token', 'sbp_test', '--format', 'text']);
    expect(args).toEqual({ projectRef: 'ref123', managementApiToken: 'sbp_test', format: 'text' });
  });

  it('defaults format to json when omitted', () => {
    const args = parseArgs([]);
    expect(args.format).toBe('json');
  });

  it('falls back to json for an unrecognized format value', () => {
    const args = parseArgs(['--format', 'yaml']);
    expect(args.format).toBe('json');
  });
});

// ---------------------------------------------------------------------------
// queryReadOnly
// ---------------------------------------------------------------------------

describe('queryReadOnly', () => {
  it('hits the read-only Management API endpoint, uses a timeout, and filters to object rows', async () => {
    const timeoutSpy = vi.spyOn(globalThis.AbortSignal, 'timeout');
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify([{ anchors_estimate: 100 }, null, ['ignored']]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(queryReadOnly('prod-ref', 'sbp_test', 'select 1')).resolves.toEqual([{ anchors_estimate: 100 }]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.supabase.com/v1/projects/prod-ref/database/query/read-only');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer sbp_test' });
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
  });

  it('throws on a non-OK response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );
    await expect(queryReadOnly('ref', 'token', 'select 1')).rejects.toThrow(/500/);
  });

  it('throws when the payload is not an array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ not: 'an array' }), { status: 200 })),
    );
    await expect(queryReadOnly('ref', 'token', 'select 1')).rejects.toThrow(/non-array/);
  });
});
