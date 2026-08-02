#!/usr/bin/env -S npx tsx
/**
 * SCRUM-2984 (SCRUM-2917 prod-EXECUTE prereq) — materializer autovacuum /
 * bloat readiness preflight.
 *
 * READ-ONLY. Reports whether prod is ready for the SCRUM-2917 proof
 * materializer's ~2.96M-row `anchor_proofs` backfill campaign — it never
 * writes, never applies a migration, and never invokes the materializer
 * job itself. See docs/runbooks/ops/proof-materializer-execute.md for the
 * full operational runbook this script's verdict gates (§1 precondition c).
 *
 * Usage:
 *   npx tsx scripts/ops/materializer-preflight.ts \
 *     --project-ref vzwyaatejekddvltxyye \
 *     --format json
 *
 * Connection (env, never a hardcoded credential):
 *   --project-ref            Supabase project ref (or PROD_PROJECT_REF /
 *                             MATERIALIZER_PREFLIGHT_PROJECT_REF env var).
 *   --management-api-token   Supabase Management API token (or
 *                             SUPABASE_ACCESS_TOKEN /
 *                             SUPABASE_MANAGEMENT_API_TOKEN env var).
 *
 * Why the Management API instead of a raw Postgres connection string: the
 * checks this script needs (pg_locks, pg_stat_activity, pgstattuple_approx,
 * pg_class.reloptions) are not exposed through PostgREST tables/RPCs, but
 * adding a `pg` driver dependency would step outside the locked
 * Supabase-only DB access stack (CLAUDE.md §1.1) for a one-off ops script.
 * `scripts/ci/staging-honesty-preflight.ts` already established the
 * pattern of reaching raw SQL through the Management API's
 * `/database/query/read-only` endpoint (note the `read-only` in the path —
 * the API itself rejects non-SELECT statements, which is a second,
 * server-side backstop on top of this script only ever issuing SELECTs).
 * This script follows the same pattern rather than inventing a new one.
 *
 * Checks (see docs/runbooks/ops/proof-materializer-execute.md §2 for the
 * full rationale behind each threshold):
 *   1. gap_sanity        — anchors (planner estimate) vs anchor_proofs (exact)
 *   2. bloat_headroom     — dead-tuple ratio on anchors / anchor_proofs
 *   3. autovacuum_staleness — last_autovacuum/last_autoanalyze age + dead tuples
 *   4. lock_contention    — long-held locks on anchors / anchor_proofs,
 *                           flagging the known SCRUM-3031 batch_insert_anchors
 *                           wedge signature by name (a signature match still
 *                           needs WEDGE_SIGNATURE_DURATION_FLOOR_SECONDS of
 *                           runtime to count — a bare name match is not
 *                           enough, since #1730 reuses that RPC name for a
 *                           fixed, fast implementation)
 *
 * Exit 0 = verdict PASS. Exit 1 = verdict WARN, or a connectivity/query
 * failure (fail-closed either way — never let a broken preflight look like
 * a green light).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GapEstimate {
  /** `pg_class.reltuples` planner estimate — never an exact count(*) on the
   *  hot `anchors` table (R0-8 / SCRUM-1254 convention). */
  anchorsEstimate: number;
  /** Exact count(*) — anchor_proofs is small (~6k rows at DoR baseline). */
  proofRowsExact: number;
  gap: number;
}

export type BloatSource = 'pgstattuple_approx' | 'pg_stat_user_tables';

export interface BloatStatsRow {
  table: 'anchors' | 'anchor_proofs';
  liveTuples: number;
  deadTuples: number;
  /** 0 when liveTuples + deadTuples is 0 (avoids a NaN/divide-by-zero). */
  deadTupleRatio: number;
  source: BloatSource;
}

export interface AutovacuumStatsRow {
  table: 'anchors' | 'anchor_proofs';
  lastAutovacuum: string | null;
  lastAutoanalyze: string | null;
  autovacuumCount: number;
  deadTuples: number;
  /** Age of the more recent of lastAutovacuum/lastAutoanalyze, in hours.
   *  null when neither has ever run. */
  vacuumAgeHours: number | null;
}

export interface LockContentionRow {
  pid: number;
  relation: 'anchors' | 'anchor_proofs' | string;
  lockMode: string;
  granted: boolean;
  runningSeconds: number;
  queryText: string;
  /** True when queryText matches the known SCRUM-3031 batch_insert_anchors
   *  wedge signature (case-insensitive substring match). */
  isKnownWedgeSignature: boolean;
}

export type CheckName = 'gap_sanity' | 'bloat_headroom' | 'autovacuum_staleness' | 'lock_contention';
export type Severity = 'pass' | 'warn';

export interface PreflightFinding {
  check: CheckName;
  severity: Severity;
  message: string;
}

export interface PreflightReport {
  verdict: 'PASS' | 'WARN';
  timestamp: string;
  projectRef: string;
  findings: PreflightFinding[];
  gap: GapEstimate;
  bloat: BloatStatsRow[];
  autovacuum: AutovacuumStatsRow[];
  lockContention: LockContentionRow[];
}

// ---------------------------------------------------------------------------
// Constants (thresholds — see docs/runbooks/ops/proof-materializer-execute.md
// §2 "Verdict criteria" for the rationale behind each of these; the
// autovacuum-staleness pair is intentionally identical to the values already
// live in services/worker/src/jobs/db-health-monitor.ts, not a new bar).
// ---------------------------------------------------------------------------

export const BLOAT_RATIO_WARN_THRESHOLD = 0.2;
export const VACUUM_AGE_WARN_THRESHOLD_HOURS = 24;
export const VACUUM_DEAD_TUPLE_WARN_THRESHOLD = 100_000;
export const LOCK_CONTENTION_WARN_SECONDS = 60;
/** `classifyWedgeSignature` is a bare substring match on query text, so it
 *  fires for ANY call naming `batch_insert_anchors` — including a healthy,
 *  fast one. PR #1730 replaces the SCRUM-3031 wedge RPC with `CREATE OR
 *  REPLACE FUNCTION batch_insert_anchors` — same name, ~11ms healthy calls —
 *  so once that lands, a signature-alone WARN (no duration floor) would fire
 *  spuriously on every routine call during the very run this preflight
 *  gates. A signature match must therefore also clear a duration floor
 *  before it counts as an offender. 5s gives >400x headroom above the ~11ms
 *  healthy call while still catching genuine wedge behavior (which has
 *  historically held locks for tens of seconds to minutes) well before the
 *  general LOCK_CONTENTION_WARN_SECONDS bar. */
export const WEDGE_SIGNATURE_DURATION_FLOOR_SECONDS = 5;

/** Lock modes at or above RowExclusive conflict with a concurrent writer;
 *  weaker modes (AccessShare, RowShare) are not contention risks here. */
const CONFLICTING_LOCK_MODES = new Set([
  'RowExclusiveLock',
  'ShareUpdateExclusiveLock',
  'ShareLock',
  'ShareRowExclusiveLock',
  'ExclusiveLock',
  'AccessExclusiveLock',
]);

const WEDGE_SIGNATURE = 'batch_insert_anchors';

const TARGET_TABLES = ['anchors', 'anchor_proofs'] as const;
type TargetTable = (typeof TARGET_TABLES)[number];

// ---------------------------------------------------------------------------
// SQL (read-only; every statement here is a SELECT — the Management API's
// read-only endpoint rejects anything else as a second backstop)
// ---------------------------------------------------------------------------

export const GAP_QUERY = `
  SELECT
    (SELECT reltuples::bigint FROM pg_class WHERE oid = 'public.anchors'::regclass) AS anchors_estimate,
    (SELECT count(*)::bigint FROM public.anchor_proofs) AS proof_rows_exact
`;

export const PGSTATTUPLE_EXTENSION_QUERY = `
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgstattuple') AS pgstattuple_available
`;

export const PGSTATTUPLE_APPROX_QUERY = `
  SELECT 'anchors' AS relname, dead_tuple_count, approx_tuple_count
  FROM pgstattuple_approx('public.anchors')
  UNION ALL
  SELECT 'anchor_proofs' AS relname, dead_tuple_count, approx_tuple_count
  FROM pgstattuple_approx('public.anchor_proofs')
`;

export const PG_STAT_USER_TABLES_QUERY = `
  SELECT relname, n_live_tup, n_dead_tup, last_autovacuum, last_autoanalyze, autovacuum_count
  FROM pg_stat_user_tables
  WHERE schemaname = 'public' AND relname IN ('anchors', 'anchor_proofs')
`;

export const LOCK_CONTENTION_QUERY = `
  SELECT
    a.pid,
    l.relation::regclass::text AS relation,
    l.mode AS lock_mode,
    l.granted,
    extract(epoch FROM (now() - a.query_start))::bigint AS running_seconds,
    a.query
  FROM pg_locks l
  JOIN pg_stat_activity a ON a.pid = l.pid
  WHERE l.locktype = 'relation'
    AND l.relation IN ('public.anchors'::regclass, 'public.anchor_proofs'::regclass)
    AND a.pid <> pg_backend_pid()
  ORDER BY running_seconds DESC
`;

// ---------------------------------------------------------------------------
// Row mappers (Management API returns Record<string, unknown> rows with
// possibly-stringified bigints/timestamps — these normalize that shape).
// ---------------------------------------------------------------------------

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return 0;
}

function toStringOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}

function toBool(v: unknown): boolean {
  return v === true || v === 'true' || v === 't';
}

export function mapGapRow(rows: Record<string, unknown>[]): GapEstimate {
  const row = rows[0] ?? {};
  const anchorsEstimate = toNumber(row.anchors_estimate);
  const proofRowsExact = toNumber(row.proof_rows_exact);
  return { anchorsEstimate, proofRowsExact, gap: anchorsEstimate - proofRowsExact };
}

function isTargetTable(v: unknown): v is TargetTable {
  return v === 'anchors' || v === 'anchor_proofs';
}

export function mapPgstattupleApproxRows(rows: Record<string, unknown>[]): BloatStatsRow[] {
  return rows
    .filter((r) => isTargetTable(r.relname))
    .map((r) => {
      const dead = toNumber(r.dead_tuple_count);
      // pgstattuple_approx()'s approx_tuple_count is documented (Postgres
      // docs, pgstattuple appendix, "pgstattuple_approx" section, checked
      // 2026-07-28 against docs/current — column list: "approx_tuple_count
      // bigint — Number of live tuples (estimated)") as ALREADY the live-
      // tuple estimate, not live+dead combined. dead_tuple_count is a
      // separate exact count. Do NOT subtract dead from it again — that
      // previously double-counted dead tuples out of the live estimate,
      // inflating deadTupleRatio (and collapsing it to 100% whenever
      // dead_tuple_count >= approx_tuple_count), which corrupted this
      // script's primary bloat gate for the SCRUM-2984 go/no-go call.
      const live = toNumber(r.approx_tuple_count);
      const denom = live + dead;
      return {
        table: r.relname as TargetTable,
        liveTuples: live,
        deadTuples: dead,
        deadTupleRatio: denom > 0 ? dead / denom : 0,
        source: 'pgstattuple_approx' as const,
      };
    });
}

export function mapPgStatUserTablesToBloatRows(rows: Record<string, unknown>[]): BloatStatsRow[] {
  return rows
    .filter((r) => isTargetTable(r.relname))
    .map((r) => {
      const live = toNumber(r.n_live_tup);
      const dead = toNumber(r.n_dead_tup);
      const denom = live + dead;
      return {
        table: r.relname as TargetTable,
        liveTuples: live,
        deadTuples: dead,
        deadTupleRatio: denom > 0 ? dead / denom : 0,
        source: 'pg_stat_user_tables' as const,
      };
    });
}

/** Age in hours (to 1 decimal place) of the more recent of two ISO
 *  timestamps (or null if both are null). `now` is injectable for
 *  deterministic tests.
 *
 *  Rounds rather than floors: `Math.floor` under-reported age by up to 59
 *  minutes (e.g. a vacuum 24h59m ago floored to "24h", sitting exactly at
 *  the WARN threshold instead of over it), silently delaying the
 *  autovacuum_staleness WARN past the intended 24h boundary. Rounding to 1
 *  decimal keeps the comparison accurate to within ~3 minutes while still
 *  reading cleanly in operator-facing messages. */
function mostRecentAgeHours(a: string | null, b: string | null, now: Date): number | null {
  const times = [a, b].filter((v): v is string => v !== null).map((v) => new Date(v).getTime());
  if (times.length === 0) return null;
  const mostRecent = Math.max(...times);
  const exactHours = (now.getTime() - mostRecent) / 3_600_000;
  return Math.round(exactHours * 10) / 10;
}

export function mapAutovacuumRows(
  rows: Record<string, unknown>[],
  now: Date = new Date(),
): AutovacuumStatsRow[] {
  return rows
    .filter((r) => isTargetTable(r.relname))
    .map((r) => {
      const lastAutovacuum = toStringOrNull(r.last_autovacuum);
      const lastAutoanalyze = toStringOrNull(r.last_autoanalyze);
      return {
        table: r.relname as TargetTable,
        lastAutovacuum,
        lastAutoanalyze,
        autovacuumCount: toNumber(r.autovacuum_count),
        deadTuples: toNumber(r.n_dead_tup),
        vacuumAgeHours: mostRecentAgeHours(lastAutovacuum, lastAutoanalyze, now),
      };
    });
}

export function classifyWedgeSignature(queryText: string): boolean {
  return queryText.toLowerCase().includes(WEDGE_SIGNATURE);
}

export function mapLockContentionRows(rows: Record<string, unknown>[]): LockContentionRow[] {
  return rows.map((r) => {
    const queryText = toStringOrNull(r.query) ?? '';
    return {
      pid: toNumber(r.pid),
      relation: String(r.relation ?? '').replace(/^public\./, ''),
      lockMode: String(r.lock_mode ?? ''),
      granted: toBool(r.granted),
      runningSeconds: toNumber(r.running_seconds),
      queryText,
      isKnownWedgeSignature: classifyWedgeSignature(queryText),
    };
  });
}

// ---------------------------------------------------------------------------
// Pure verdict logic (exported for testing with mocked query results — no
// DB connection required to exercise any of this).
// ---------------------------------------------------------------------------

export function evaluateGapSanity(gap: GapEstimate): PreflightFinding[] {
  if (gap.gap <= 0) {
    return [
      {
        check: 'gap_sanity',
        severity: 'warn',
        message: `gap is ${gap.gap} (anchors_estimate=${gap.anchorsEstimate}, proof_rows_exact=${gap.proofRowsExact}) — backlog already drained or the estimate inputs are stale; confirm expectations before scheduling a run`,
      },
    ];
  }
  return [
    {
      check: 'gap_sanity',
      severity: 'pass',
      message: `gap is ${gap.gap} rows (anchors_estimate=${gap.anchorsEstimate}, proof_rows_exact=${gap.proofRowsExact})`,
    },
  ];
}

export function evaluateBloatHeadroom(rows: BloatStatsRow[]): PreflightFinding[] {
  return rows.map((r) => {
    const pct = (r.deadTupleRatio * 100).toFixed(1);
    if (r.deadTupleRatio >= BLOAT_RATIO_WARN_THRESHOLD) {
      return {
        check: 'bloat_headroom' as const,
        severity: 'warn' as const,
        message: `${r.table}: dead-tuple ratio ${pct}% >= ${BLOAT_RATIO_WARN_THRESHOLD * 100}% (source: ${r.source})`,
      };
    }
    return {
      check: 'bloat_headroom' as const,
      severity: 'pass' as const,
      message: `${r.table}: dead-tuple ratio ${pct}% (source: ${r.source})`,
    };
  });
}

export function evaluateAutovacuumStaleness(rows: AutovacuumStatsRow[]): PreflightFinding[] {
  return rows.map((r) => {
    const stale =
      r.vacuumAgeHours !== null &&
      r.vacuumAgeHours > VACUUM_AGE_WARN_THRESHOLD_HOURS &&
      r.deadTuples > VACUUM_DEAD_TUPLE_WARN_THRESHOLD;
    if (stale) {
      return {
        check: 'autovacuum_staleness' as const,
        severity: 'warn' as const,
        message: `${r.table}: last autovacuum/autoanalyze ${r.vacuumAgeHours}h ago with ${r.deadTuples.toLocaleString()} dead tuples (> ${VACUUM_DEAD_TUPLE_WARN_THRESHOLD.toLocaleString()})`,
      };
    }
    return {
      check: 'autovacuum_staleness' as const,
      severity: 'pass' as const,
      message: `${r.table}: vacuum age ${r.vacuumAgeHours ?? 'never'}h, ${r.deadTuples.toLocaleString()} dead tuples`,
    };
  });
}

export function evaluateLockContention(rows: LockContentionRow[]): PreflightFinding[] {
  const offenders = rows.filter(
    (r) =>
      r.granted &&
      CONFLICTING_LOCK_MODES.has(r.lockMode) &&
      (r.runningSeconds > LOCK_CONTENTION_WARN_SECONDS ||
        (r.isKnownWedgeSignature && r.runningSeconds > WEDGE_SIGNATURE_DURATION_FLOOR_SECONDS)),
  );
  if (offenders.length === 0) {
    return [
      {
        check: 'lock_contention',
        severity: 'pass',
        message: 'no long-held conflicting locks on anchors or anchor_proofs',
      },
    ];
  }
  return offenders.map((o) => ({
    check: 'lock_contention' as const,
    severity: 'warn' as const,
    message: o.isKnownWedgeSignature
      ? `pid=${o.pid} on ${o.relation} holding ${o.lockMode} for ${o.runningSeconds}s — matches the known SCRUM-3031 batch_insert_anchors wedge signature`
      : `pid=${o.pid} on ${o.relation} holding ${o.lockMode} for ${o.runningSeconds}s (> ${LOCK_CONTENTION_WARN_SECONDS}s)`,
  }));
}

export interface BuildReportInput {
  projectRef: string;
  gap: GapEstimate;
  bloat: BloatStatsRow[];
  autovacuum: AutovacuumStatsRow[];
  lockContention: LockContentionRow[];
  now?: Date;
}

export function buildReport(input: BuildReportInput): PreflightReport {
  const findings: PreflightFinding[] = [
    ...evaluateGapSanity(input.gap),
    ...evaluateBloatHeadroom(input.bloat),
    ...evaluateAutovacuumStaleness(input.autovacuum),
    ...evaluateLockContention(input.lockContention),
  ];
  const verdict = findings.every((f) => f.severity === 'pass') ? 'PASS' : 'WARN';
  return {
    verdict,
    timestamp: (input.now ?? new Date()).toISOString(),
    projectRef: input.projectRef,
    findings,
    gap: input.gap,
    bloat: input.bloat,
    autovacuum: input.autovacuum,
    lockContention: input.lockContention,
  };
}

// ---------------------------------------------------------------------------
// Text formatter
// ---------------------------------------------------------------------------

export function formatText(report: PreflightReport): string {
  const lines: string[] = [];
  lines.push('='.repeat(60));
  lines.push(`Materializer preflight — ${report.projectRef}`);
  lines.push(`Verdict: ${report.verdict}`);
  lines.push(`Timestamp: ${report.timestamp}`);
  lines.push('='.repeat(60));
  for (const f of report.findings) {
    lines.push(`[${f.severity.toUpperCase()}] ${f.check}: ${f.message}`);
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main (DB-connected — Management API read-only query endpoint)
// ---------------------------------------------------------------------------

const MANAGEMENT_API_BASE_URL = 'https://api.supabase.com/v1';
const MANAGEMENT_API_TIMEOUT_MS = 30_000;

export async function queryReadOnly(
  projectRef: string,
  managementApiToken: string,
  query: string,
): Promise<Record<string, unknown>[]> {
  const response = await fetch(
    `${MANAGEMENT_API_BASE_URL}/projects/${encodeURIComponent(projectRef)}/database/query/read-only`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${managementApiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(MANAGEMENT_API_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    throw new Error(`Supabase Management API query failed (${response.status})`);
  }

  const payload = (await response.json()) as unknown;
  if (!Array.isArray(payload)) {
    throw new Error('Supabase Management API query returned a non-array payload.');
  }
  return payload.filter(
    (row): row is Record<string, unknown> => row !== null && typeof row === 'object' && !Array.isArray(row),
  );
}

interface ParsedArgs {
  projectRef: string | undefined;
  managementApiToken: string | undefined;
  format: 'json' | 'text';
}

export function parseArgs(argv: string[]): ParsedArgs {
  let projectRef: string | undefined;
  let managementApiToken: string | undefined;
  let format: 'json' | 'text' = 'json';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case '--project-ref':
        projectRef = next;
        i++;
        break;
      case '--management-api-token':
        managementApiToken = next;
        i++;
        break;
      case '--format':
        format = next === 'text' ? 'text' : 'json';
        i++;
        break;
    }
  }

  return { projectRef, managementApiToken, format };
}

async function fetchBloat(projectRef: string, token: string): Promise<BloatStatsRow[]> {
  const extRows = await queryReadOnly(projectRef, token, PGSTATTUPLE_EXTENSION_QUERY);
  const available = toBool(extRows[0]?.pgstattuple_available);
  if (available) {
    const rows = await queryReadOnly(projectRef, token, PGSTATTUPLE_APPROX_QUERY);
    return mapPgstattupleApproxRows(rows);
  }
  const rows = await queryReadOnly(projectRef, token, PG_STAT_USER_TABLES_QUERY);
  return mapPgStatUserTablesToBloatRows(rows);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const projectRef = args.projectRef ?? process.env.PROD_PROJECT_REF ?? process.env.MATERIALIZER_PREFLIGHT_PROJECT_REF;
  const managementApiToken =
    args.managementApiToken ?? process.env.SUPABASE_ACCESS_TOKEN ?? process.env.SUPABASE_MANAGEMENT_API_TOKEN;

  if (!projectRef) {
    console.error('::error::Missing --project-ref / PROD_PROJECT_REF / MATERIALIZER_PREFLIGHT_PROJECT_REF.');
    process.exit(1);
  }
  if (!managementApiToken) {
    console.error('::error::Missing --management-api-token / SUPABASE_ACCESS_TOKEN / SUPABASE_MANAGEMENT_API_TOKEN.');
    process.exit(1);
  }

  try {
    const [gapRows, bloat, autovacuumRows, lockRows] = await Promise.all([
      queryReadOnly(projectRef, managementApiToken, GAP_QUERY),
      fetchBloat(projectRef, managementApiToken),
      queryReadOnly(projectRef, managementApiToken, PG_STAT_USER_TABLES_QUERY),
      queryReadOnly(projectRef, managementApiToken, LOCK_CONTENTION_QUERY),
    ]);

    const report = buildReport({
      projectRef,
      gap: mapGapRow(gapRows),
      bloat,
      autovacuum: mapAutovacuumRows(autovacuumRows),
      lockContention: mapLockContentionRows(lockRows),
    });

    if (args.format === 'text') {
      process.stdout.write(formatText(report));
    } else {
      console.log(JSON.stringify(report, null, 2));
    }

    if (report.verdict !== 'PASS') {
      process.exit(1);
    }
  } catch (err) {
    console.error(`::error::materializer-preflight failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Entry-point guard
// ---------------------------------------------------------------------------

function isMainModule(metaUrl: string, argvPath: string | undefined): boolean {
  if (argvPath === undefined) return false;
  try {
    return new URL(metaUrl).pathname === new URL(`file://${argvPath}`).pathname;
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((err) => {
    console.error(`::error::Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
