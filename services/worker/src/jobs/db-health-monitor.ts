/**
 * SCRUM-1254 (R0-8) — DB health monitor.
 *
 * Runs every 5 minutes from cron.ts /cron/db-health endpoint. Queries:
 *   1. cron.job_run_details for failures in the last 5 min
 *      → emit Sentry event severity=error per failed job, page on 3-fail streak.
 *   2. pg_stat_user_tables for n_dead_tup, n_live_tup, last_autovacuum
 *      → emit metric db.dead_tuple_ratio.<table> + page if > 0.5 for >1h
 *        on hot tables, OR if last_autovacuum > 24h with dead > 100k.
 *   3. audit_events 'smoke_test.completed' last 5 rows
 *      → page if 3+ failed in a row OR run-time > 60s.
 *
 * Why: the 6-day pg_cron failure loop on jobid 3, 7M dead tuples on
 * `anchors`, and 4 silent smoke fails in 3 days all happened with no
 * paging telemetry. CLAUDE.md §1.4 requires observability on these signals.
 */

import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { Sentry } from '../utils/sentry.js';
import { callRpc } from '../utils/rpc.js';

const HOT_TABLES = ['anchors', 'public_records', 'audit_events', 'job_queue'] as const;
const DEAD_RATIO_THRESHOLD = 0.5;
const VACUUM_AGE_THRESHOLD_HOURS = 24;
const VACUUM_DEAD_TUPLE_THRESHOLD = 100_000;
const SMOKE_FAIL_STREAK_THRESHOLD = 3;
const SMOKE_RUNTIME_THRESHOLD_MS = 60_000;

interface CronFailure {
  jobid: number;
  jobname?: string;
  return_message?: string;
  start_time: string;
  end_time?: string | null;
}

interface DeadTupleRow {
  schemaname: string;
  relname: string;
  n_live_tup: number;
  n_dead_tup: number;
  last_autovacuum: string | null;
}

interface SmokeRow {
  created_at: string;
  details: string;
}

export interface DbHealthSnapshot {
  cronFailures: CronFailure[];
  deadTuples: Array<{ table: string; ratio: number; deadTuples: number; vacuumAgeHours: number | null }>;
  smokeFailStreak: number;
  smokeMaxRuntimeMs: number;
  alerts: string[];
}

async function fetchCronFailures(): Promise<CronFailure[]> {
  // Code-review issue #J: use callRpc<T> from utils/rpc.ts per
  // services/worker/agents.md "DO use callRpc<T>(db, ...) instead of
  // (db.rpc as any)(...)" — single typed wrapper, no per-callsite casts.
  const { data, error } = await callRpc<CronFailure[]>(db, 'get_recent_cron_failures', { since_minutes: 5 });
  if (error) {
    logger.warn({ error }, 'get_recent_cron_failures RPC failed (likely missing)');
    return [];
  }
  return data ?? [];
}

async function fetchDeadTuples(): Promise<DeadTupleRow[]> {
  const { data, error } = await callRpc<DeadTupleRow[]>(db, 'get_table_bloat_stats', { table_names: [...HOT_TABLES] });
  if (error) {
    logger.warn({ error }, 'get_table_bloat_stats RPC failed (likely missing)');
    return [];
  }
  return data ?? [];
}

async function fetchSmokeHistory(): Promise<SmokeRow[]> {
  const { data, error } = await db
    .from('audit_events')
    .select('created_at, details')
    .eq('event_type', 'smoke_test.completed')
    .order('created_at', { ascending: false })
    .limit(5);
  if (error) {
    logger.warn({ error: error.message }, 'smoke_test history fetch failed');
    return [];
  }
  return (data ?? []) as SmokeRow[];
}

function computeAlerts(snapshot: Omit<DbHealthSnapshot, 'alerts'>): string[] {
  const alerts: string[] = [];

  // Cron failures: page on any failure (Sentry rule downstream throttles).
  for (const f of snapshot.cronFailures) {
    alerts.push(`pg_cron jobid=${f.jobid} failed: ${f.return_message ?? '(no message)'}`);
  }

  for (const t of snapshot.deadTuples) {
    if (t.ratio > DEAD_RATIO_THRESHOLD) {
      alerts.push(`Dead-tuple ratio on ${t.table}: ${t.ratio.toFixed(2)} (> ${DEAD_RATIO_THRESHOLD})`);
    }
    if (
      t.vacuumAgeHours !== null &&
      t.vacuumAgeHours > VACUUM_AGE_THRESHOLD_HOURS &&
      t.deadTuples > VACUUM_DEAD_TUPLE_THRESHOLD
    ) {
      alerts.push(
        `${t.table}: ${t.deadTuples.toLocaleString()} dead tuples + autovacuum ${t.vacuumAgeHours}h ago (snapshot held?)`,
      );
    }
  }

  if (snapshot.smokeFailStreak >= SMOKE_FAIL_STREAK_THRESHOLD) {
    alerts.push(`Smoke test fail-streak: ${snapshot.smokeFailStreak} consecutive failures`);
  }
  if (snapshot.smokeMaxRuntimeMs > SMOKE_RUNTIME_THRESHOLD_MS) {
    alerts.push(`Smoke test runtime ${snapshot.smokeMaxRuntimeMs}ms exceeds ${SMOKE_RUNTIME_THRESHOLD_MS}ms (PostgREST timeout risk)`);
  }

  return alerts;
}

// SCRUM-1308: Sentry alert rules in `infra/sentry/alert-rules.json` route on
// `alert_type` so each signal class can have distinct fan-out (dead-tuple
// needs continuous>1h, smoke-streak pages immediately). The classifier runs
// on the alert string we already build in computeAlerts(); drift between
// the strings and the table below silently miscategorizes, so the test
// suite pins both ends.
//
// Codex P1 (PR #690): autovacuum-age and dead-tuple-ratio are emitted
// independently by computeAlerts() and a single hot table can fire both in
// the same 5-minute pass. Routing both to `dead_tuple_ratio` would let the
// 12-events-in-1h Sentry rule trip in ~30 minutes (well below the >1h
// continuous threshold the rule is meant to enforce). Give the autovacuum
// signal its own type so each rule's frequency budget is honored.
export type DbHealthAlertType =
  | 'pg_cron_failure'
  | 'dead_tuple_ratio'
  | 'dead_tuple_autovacuum_age'
  | 'smoke_fail_streak'
  | 'smoke_runtime'
  | 'unclassified';

const ALERT_PREFIX_TABLE: ReadonlyArray<readonly [string, DbHealthAlertType]> = [
  ['pg_cron jobid=', 'pg_cron_failure'],
  ['Dead-tuple ratio on ', 'dead_tuple_ratio'],
  ['Smoke test fail-streak:', 'smoke_fail_streak'],
  ['Smoke test runtime ', 'smoke_runtime'],
];

export function classifyAlert(alert: string): DbHealthAlertType {
  for (const [prefix, type] of ALERT_PREFIX_TABLE) {
    if (alert.startsWith(prefix)) return type;
  }
  // The autovacuum-age branch isn't a clean prefix — `<table>: …` varies.
  if (alert.includes('dead tuples + autovacuum')) return 'dead_tuple_autovacuum_age';
  return 'unclassified';
}

function emitSentry(alerts: string[]): void {
  for (const a of alerts) {
    try {
      Sentry.captureMessage(a, {
        level: 'error',
        tags: {
          source: 'db-health-monitor',
          story: 'SCRUM-1254',
          alert_type: classifyAlert(a),
        },
      });
    } catch (err) {
      logger.warn({ err }, 'Failed to emit Sentry event');
    }
  }
}

type SmokeDetails = { failed?: number; durationMs?: number; results?: Array<{ durationMs?: number }> };

function parseSmokeDetails(raw: string | null | undefined): SmokeDetails | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SmokeDetails;
  } catch {
    // Code-review issue #G: don't let one malformed audit_events row blind
    // the monitor. Skip + log; the monitor still surfaces other rows.
    return null;
  }
}

export async function runDbHealthMonitor(): Promise<DbHealthSnapshot> {
  // Code-review issue #I: Promise.all rejects on any throw. Use allSettled
  // so a transport-level failure on one fetch doesn't blank the other two.
  const [cronResult, deadTuplesResult, smokeResult] = await Promise.allSettled([
    fetchCronFailures(),
    fetchDeadTuples(),
    fetchSmokeHistory(),
  ]);
  const cronFailures = cronResult.status === 'fulfilled' ? cronResult.value : [];
  const deadTuples = deadTuplesResult.status === 'fulfilled' ? deadTuplesResult.value : [];
  const smokeRows = smokeResult.status === 'fulfilled' ? smokeResult.value : [];
  for (const r of [cronResult, deadTuplesResult, smokeResult]) {
    if (r.status === 'rejected') logger.warn({ reason: r.reason }, 'db-health-monitor sub-fetch threw');
  }

  const dt = deadTuples.map((row) => {
    const ratio = row.n_live_tup > 0 ? row.n_dead_tup / row.n_live_tup : 0;
    const vacuumAgeHours = row.last_autovacuum
      ? Math.floor((Date.now() - new Date(row.last_autovacuum).getTime()) / 3_600_000)
      : null;
    return { table: row.relname, ratio, deadTuples: row.n_dead_tup, vacuumAgeHours };
  });

  // Smoke fail-streak: count consecutive top-of-stack rows with failed > 0.
  // Code-review issue #H: maxRuntime must update on EVERY row (including
  // passing-but-slow recent runs) so the 60s PostgREST-timeout-risk alert
  // fires when a slow run is the most recent. Previously the assignment
  // lived after `else break`, so passing runs were never tracked.
  let streak = 0;
  let maxRuntime = 0;
  let countingStreak = true;
  for (const row of smokeRows) {
    const parsed = parseSmokeDetails(row.details);
    if (parsed === null) continue;
    const failed = Number(parsed.failed ?? 0);
    const runtime = parsed.results?.reduce((acc, r) => acc + (r.durationMs ?? 0), 0) ?? parsed.durationMs ?? 0;
    maxRuntime = Math.max(maxRuntime, runtime);
    if (countingStreak) {
      if (failed > 0) streak++;
      else countingStreak = false;
    }
  }

  const snapshot: Omit<DbHealthSnapshot, 'alerts'> = {
    cronFailures,
    deadTuples: dt,
    smokeFailStreak: streak,
    smokeMaxRuntimeMs: maxRuntime,
  };
  const alerts = computeAlerts(snapshot);

  if (alerts.length > 0) {
    logger.warn({ alerts }, 'db-health-monitor alerts');
    emitSentry(alerts);
  } else {
    logger.info({ deadTuples: dt }, 'db-health-monitor green');
  }

  return { ...snapshot, alerts };
}
