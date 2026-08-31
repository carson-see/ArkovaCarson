#!/usr/bin/env tsx
/**
 * PR #2335 — T3 soak driver for migration
 * `0417_cleanup_expired_data_singleton_advisory_lock.sql`.
 *
 * WHAT 0417 CHANGED, AND THEREFORE WHAT THIS DRIVES
 *
 * `cleanup_expired_data()` deadlocked in production every night (SQLSTATE
 * 40P01, BUG-2026-08-22-001) because `arkova-worker` runs `minScale = 2` and
 * `routes/scheduled.ts` registers `cleanup-expired-data` on `0 2 * * *` inside
 * every instance. Two callers entered the `DROP TRIGGER` / `DELETE` /
 * `CREATE TRIGGER` section on `audit_events` together and took the relation
 * lock and the `pg_trigger` catalog-object lock in opposite orders.
 *
 * 0417 adds `pg_try_advisory_xact_lock(8675309, 2)` at the top of the body. The
 * first caller does the work; every concurrent caller returns immediately with
 * `skipped_concurrent_run: true`, `-1` "not measured" sentinels on all four
 * counts, `audit_events_purge_skipped: true`, `success: true`, and — load
 * bearing — writes NO `DATA_RETENTION_CLEANUP` audit row.
 *
 * 0417 carries 0411's body verbatim below the guard, so this driver also has to
 * prove 0411 did not silently regress underneath it: the audit purge still runs
 * in a subtransaction whose `lock_not_available` (55P03) handler leaves
 * `reject_audit_delete` INSTALLED and resets `audit_events_deleted` to the `-1`
 * sentinel rather than reporting a DELETE that rolled back.
 *
 * THE FOUR T3 EVIDENCE REQUIREMENTS (CLAUDE.md §1.12), and the counter prefix
 * each one emits under `counts`:
 *
 *   Trigger A  — concurrency singleton .............. `triggerA*`
 *   Trigger B  — audit_events purge path ............ `triggerB*`
 *   Daily flush observation ......................... `dailyFlush*`
 *   Per-org isolation ............................... `perOrg*`
 *
 * MODES
 *
 *   `--mode self-test` (default) exercises the pure classification /
 *   aggregation / verdict helpers against synthetic fixtures. It touches no
 *   database and no network, and every row it emits is stamped
 *   `evidenceForSoak: false`. It is local validation, NOT soak evidence.
 *
 *   `--mode live` runs the real thing against an isolated staging rig: seeds
 *   rows on both sides of every retention boundary for two organizations, fires
 *   N genuinely simultaneous `cleanup_expired_data()` RPCs, and measures what
 *   actually disappeared against what the function reported. It appends one
 *   JSONL row per cycle and loops for `--duration-min` so the 48h T3 clock can
 *   run against a single long-lived process.
 *
 * SAFETY (§1.4, §1.11A)
 *
 *   - Refuses the production project ref outright. This driver WRITES and
 *     DELETES; a mistargeted run is not recoverable by apology.
 *   - Refuses a `--target-url` that is not a staging/localhost host.
 *   - Emits the Supabase project REF (required §1.11A evidence) and never the
 *     URL, the service-role key, or any header. No row payload, no PII, and no
 *     organization UUID is ever written to the JSONL — organizations appear as
 *     a 12-hex SHA-256 label.
 *   - Every row it seeds is marker-tagged and, on the retained side, dated to
 *     self-expire one `--keep-margin-days` window after the soak, so the rig is
 *     not left with permanent litter.
 *
 * USAGE
 *
 *   # local, no rig
 *   npx tsx scripts/pr2335-cleanup-singleton-driver.ts --mode self-test
 *
 *   # 48h T3 soak against an isolated rig
 *   SUPABASE_URL=https://<isolated-ref>.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=<isolated-service-role> \
 *   npx tsx scripts/pr2335-cleanup-singleton-driver.ts \
 *     --mode live \
 *     --target-url https://arkova-worker-<rig>-staging-....run.app \
 *     --admission-json docs/staging/<rig>/admission.json \
 *     --evidence-jsonl docs/staging/<rig>/pr2335-driver.jsonl \
 *     --duration-min 2880 --interval-min 30 --concurrency 8
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PR_NUMBER = 2335 as const;
export const SOAK_TIER = 'T3' as const;

/** Prod project ref. Hard-denied — this driver writes and deletes. */
export const PROD_PROJECT_REF = 'vzwyaatejekddvltxyye';

export const CHANGED_BEHAVIOR =
  'PR #2335 / migration 0417: cleanup_expired_data() takes pg_try_advisory_xact_lock(8675309, 2) as a singleton guard, so concurrent callers return skipped_concurrent_run=true with -1 sentinels and write no DATA_RETENTION_CLEANUP audit row instead of deadlocking on audit_events (40P01); 0411 composed underneath it still bounds every table lock and its lock_not_available (55P03) subtransaction handler leaves reject_audit_delete installed';

/** Marker written into every driver-seeded row so cleanup and counting can find
 *  exactly its own rows and nothing else. */
export const SEED_MARKER = 'soak-pr2335';

/** `audit_events.event_type` used for driver probe rows. */
export const AUDIT_PROBE_EVENT_TYPE = 'SOAK_PR2335_PROBE';

/** `event_type` of the ONE audit row the driver DELETES on purpose each cycle
 *  to prove `reject_audit_delete` is installed.
 *
 *  Deliberately NOT `AUDIT_PROBE_EVENT_TYPE`. Every seeded-row count selects on
 *  `event_type = AUDIT_PROBE_EVENT_TYPE` inside a created_at window, and this
 *  sentinel is written into the RETAINED side of that window for org A. While
 *  it shared the marker, org A's retained audit count came back `seedRows + 1`,
 *  so `keepSeeded - keepRemaining` evaluated to -1, `perOrgCrossOrgKeepRowsRemoved`
 *  was -1 and `perOrgIsolationHeld` was false on every cycle — for a reason that
 *  has nothing to do with 0417. A distinct event_type keeps the guard probe out
 *  of a population it was never part of. */
export const AUDIT_SENTINEL_EVENT_TYPE = 'SOAK_PR2335_SENTINEL';

/** The audit row `cleanup_expired_data()` writes on a run that did work. */
export const CLEANUP_AUDIT_EVENT_TYPE = 'DATA_RETENTION_CLEANUP';

/** `-1` is 0411's "not measured" sentinel. It is NOT a count. */
export const NOT_MEASURED = -1;

/** SQLSTATEs that matter to this change. */
export const SQLSTATE_DEADLOCK = '40P01';
export const SQLSTATE_LOCK_NOT_AVAILABLE = '55P03';
export const SQLSTATE_CHECK_VIOLATION = '23514';

/** Retention boundaries the function actually uses, in days.
 *
 *  The function writes calendar intervals (`90 days`, `1 year`, `2 years`).
 *  These day counts are approximations of those, which is safe only because
 *  every seeded row sits a `--keep-margin-days` window (default 30d) clear of
 *  its boundary on one side or the other. Calendar drift is at most a day or
 *  two; the margin is thirty. */
export const RETENTION_BOUNDARY_DAYS: Readonly<Record<string, number>> = {
  webhook_delivery_logs: 90,
  verification_events: 365,
  ai_usage_events: 365,
  audit_events: 730,
};

// ---------------------------------------------------------------------------
// Row + argument shapes
// ---------------------------------------------------------------------------

export type DriverMode = 'self-test' | 'live';

export interface DriverArgs {
  mode: DriverMode;
  targetUrl?: string;
  admissionJson?: string;
  evidenceJsonl?: string;
  /** Total wall-clock minutes to keep cycling. 0 = one cycle and exit. */
  durationMin: number;
  /** Minutes between the START of one cycle and the start of the next. */
  intervalMin: number;
  /** Simultaneous `cleanup_expired_data()` calls per volley. Floor of 6. */
  concurrency: number;
  /** Rows seeded per table, per org, per side of the boundary. */
  seedRows: number;
  /** How far clear of each retention boundary the seeded rows sit, in days. */
  keepMarginDays: number;
  orgA?: string;
  orgB?: string;
  webhookEndpointId?: string;
}

export interface DriverRow {
  utc: string;
  pr: typeof PR_NUMBER;
  tier: typeof SOAK_TIER;
  mode: DriverMode;
  evidenceForSoak: boolean;
  changedBehavior: string;
  status: 'pass' | 'fail';
  counts: Record<string, number | boolean>;
  cycle?: number;
  summary?: boolean;
  projectRef?: string;
  targetUrl?: string;
  admission?: Record<string, unknown>;
  observations?: string[];
  blockers?: string[];
}

/** The jsonb `cleanup_expired_data()` returns under 0417. */
export interface CleanupRpcResult {
  success: boolean;
  skipped_concurrent_run: boolean;
  webhook_delivery_logs_deleted: number;
  verification_events_deleted: number;
  ai_usage_events_deleted: number;
  audit_events_deleted: number;
  audit_events_purge_skipped: boolean;
}

/** The subset of a PostgREST error this driver classifies on. */
export interface RpcErrorLike {
  code?: string | null;
  message?: string | null;
  details?: string | null;
}

export type CallOutcome =
  /** Took the advisory lock and ran the retention purge. */
  | 'worked'
  /** Lost the advisory lock race and returned the 0417 skip result. */
  | 'skipped'
  /** SQLSTATE 40P01. The defect under test. Never acceptable. */
  | 'deadlock'
  /** SQLSTATE 55P03 escaped the function rather than being handled. */
  | 'lock_not_available'
  /** Any other RPC error. */
  | 'error'
  /** Returned 200 with a body that is not 0417's documented shape. */
  | 'contract_violation';

export interface CallRecord {
  outcome: CallOutcome;
  dispatchedAtMs: number;
  settledAtMs: number;
  result?: CleanupRpcResult;
  errorCode?: string;
}

export interface EvaluatedRequirement {
  held: boolean;
  counts: Record<string, number | boolean>;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export const DEFAULT_ARGS: DriverArgs = {
  mode: 'self-test',
  durationMin: 0,
  intervalMin: 30,
  concurrency: 8,
  seedRows: 200,
  keepMarginDays: 30,
};

/** Minimum simultaneous callers a volley may use. Below this the volley is not
 *  a credible reproduction of the prod shape (minScale=2 plus the Cloud
 *  Scheduler path plus operator smoke calls). */
export const MIN_CONCURRENCY = 6;

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function positiveInt(raw: string, flag: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid value for ${flag}: expected a non-negative integer`);
  }
  return parsed;
}

export function parseArgs(argv: string[]): DriverArgs {
  const args: DriverArgs = { ...DEFAULT_ARGS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--mode': {
        const value = requireValue(argv, ++i, '--mode');
        if (value !== 'self-test' && value !== 'live') {
          throw new Error(`Invalid --mode: ${value} (expected self-test or live)`);
        }
        args.mode = value;
        break;
      }
      case '--self-test':
        args.mode = 'self-test';
        break;
      case '--live':
        args.mode = 'live';
        break;
      case '--target-url':
        args.targetUrl = requireValue(argv, ++i, '--target-url');
        break;
      case '--admission-json':
        args.admissionJson = requireValue(argv, ++i, '--admission-json');
        break;
      case '--evidence-jsonl':
        args.evidenceJsonl = requireValue(argv, ++i, '--evidence-jsonl');
        break;
      case '--duration-min':
        args.durationMin = positiveInt(requireValue(argv, ++i, '--duration-min'), '--duration-min');
        break;
      case '--interval-min':
        args.intervalMin = positiveInt(requireValue(argv, ++i, '--interval-min'), '--interval-min');
        break;
      case '--concurrency':
        args.concurrency = positiveInt(requireValue(argv, ++i, '--concurrency'), '--concurrency');
        break;
      case '--seed-rows':
        args.seedRows = positiveInt(requireValue(argv, ++i, '--seed-rows'), '--seed-rows');
        break;
      case '--keep-margin-days':
        args.keepMarginDays = positiveInt(
          requireValue(argv, ++i, '--keep-margin-days'),
          '--keep-margin-days',
        );
        break;
      case '--org-a':
        args.orgA = requireValue(argv, ++i, '--org-a');
        break;
      case '--org-b':
        args.orgB = requireValue(argv, ++i, '--org-b');
        break;
      case '--webhook-endpoint-id':
        args.webhookEndpointId = requireValue(argv, ++i, '--webhook-endpoint-id');
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

/**
 * Everything that must be true before a live run may start, as a list of
 * blockers rather than a throw — a blocked live run still emits a JSONL row
 * saying why, which is the artifact a reviewer needs.
 */
export function validateLiveArgs(args: DriverArgs, env: { supabaseUrl?: string; serviceRoleKey?: string }): string[] {
  const blockers: string[] = [];
  if (!env.supabaseUrl) blockers.push('missing SUPABASE_URL');
  if (!env.serviceRoleKey) blockers.push('missing SUPABASE_SERVICE_ROLE_KEY');
  if (!args.targetUrl) blockers.push('missing --target-url');
  if (!args.admissionJson) blockers.push('missing --admission-json');
  if (!args.evidenceJsonl) blockers.push('missing --evidence-jsonl');

  const ref = env.supabaseUrl ? projectRefFromUrl(env.supabaseUrl) : undefined;
  if (ref === PROD_PROJECT_REF) {
    blockers.push('refusing to run against the PRODUCTION Supabase project ref');
  }
  if (args.targetUrl && !isStagingLikeUrl(args.targetUrl)) {
    blockers.push('--target-url is not a staging or localhost host (§1.11A isolated rigs only)');
  }
  if (args.concurrency < MIN_CONCURRENCY) {
    blockers.push(`--concurrency must be at least ${MIN_CONCURRENCY} for Trigger A`);
  }
  if (args.seedRows < 1) {
    blockers.push('--seed-rows must be at least 1');
  }
  // A retained row seeded `keepMarginDays` inside its boundary must still be
  // inside that boundary when the soak ends, or the driver would fail itself
  // for a purge that was correct.
  const soakDays = args.durationMin / (60 * 24);
  if (args.keepMarginDays <= soakDays + 1) {
    blockers.push(
      `--keep-margin-days (${args.keepMarginDays}) must exceed the soak length in days plus one; retained rows would cross their boundary mid-soak`,
    );
  }
  return blockers;
}

/** `https://abcdefgh.supabase.co` -> `abcdefgh`. Returns undefined on garbage. */
export function projectRefFromUrl(url: string): string | undefined {
  try {
    const host = new URL(url).hostname;
    const [first] = host.split('.');
    return first && first.length > 0 ? first : undefined;
  } catch {
    return undefined;
  }
}

/** §1.11A: this driver may only ever point at an isolated rig or a local stack. */
export function isStagingLikeUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost')) return true;
    return host.includes('staging');
  } catch {
    return false;
  }
}

/** Stable, non-reversible label for an organization. §1.4 / §6: an org UUID is
 *  an internal identifier and never belongs in an artifact. */
export function orgLabel(orgId: string): string {
  return createHash('sha256').update(orgId).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------
// Pure classification helpers
// ---------------------------------------------------------------------------

function errorText(error: RpcErrorLike): string {
  return `${error.code ?? ''} ${error.message ?? ''} ${error.details ?? ''}`;
}

/** SQLSTATE 40P01. The defect 0417 exists to remove. Never a retry — a single
 *  occurrence during the soak is a FAIL. */
export function isDeadlockError(error: RpcErrorLike): boolean {
  if (error.code === SQLSTATE_DEADLOCK) return true;
  return /deadlock detected/i.test(errorText(error));
}

/** SQLSTATE 55P03 escaping the function. 0411's handler is supposed to swallow
 *  it and report `audit_events_purge_skipped`, so seeing it at the RPC boundary
 *  means the handler did not cover the statement that raised. */
export function isLockNotAvailableError(error: RpcErrorLike): boolean {
  if (error.code === SQLSTATE_LOCK_NOT_AVAILABLE) return true;
  return /lock_not_available|canceling statement due to lock timeout/i.test(errorText(error));
}

/** The append-only guard firing. Proves `reject_audit_delete` is installed. */
export function isAppendOnlyGuardError(error: RpcErrorLike): boolean {
  if (error.code === SQLSTATE_CHECK_VIOLATION) return true;
  return /audit events are immutable/i.test(errorText(error));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Validate the RPC body against 0417's documented return shape.
 *
 * Returns null on anything that is not that shape. A null here is a
 * `contract_violation`, not a soft warning: the most likely cause is that 0417
 * is not applied to the rig at all (0411 returns the same object MINUS
 * `skipped_concurrent_run`), and a soak run against the wrong function
 * definition is worse than no soak.
 */
export function parseCleanupResult(data: unknown): CleanupRpcResult | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const raw = data as Record<string, unknown>;
  if (typeof raw.success !== 'boolean') return null;
  if (typeof raw.skipped_concurrent_run !== 'boolean') return null;
  if (typeof raw.audit_events_purge_skipped !== 'boolean') return null;
  if (!isFiniteNumber(raw.webhook_delivery_logs_deleted)) return null;
  if (!isFiniteNumber(raw.verification_events_deleted)) return null;
  if (!isFiniteNumber(raw.ai_usage_events_deleted)) return null;
  if (!isFiniteNumber(raw.audit_events_deleted)) return null;
  return {
    success: raw.success,
    skipped_concurrent_run: raw.skipped_concurrent_run,
    webhook_delivery_logs_deleted: raw.webhook_delivery_logs_deleted,
    verification_events_deleted: raw.verification_events_deleted,
    ai_usage_events_deleted: raw.ai_usage_events_deleted,
    audit_events_deleted: raw.audit_events_deleted,
    audit_events_purge_skipped: raw.audit_events_purge_skipped,
  };
}

export function classifyCall(data: unknown, error: RpcErrorLike | null): CallOutcome {
  if (error) {
    if (isDeadlockError(error)) return 'deadlock';
    if (isLockNotAvailableError(error)) return 'lock_not_available';
    return 'error';
  }
  const parsed = parseCleanupResult(data);
  if (!parsed) return 'contract_violation';
  return parsed.skipped_concurrent_run ? 'skipped' : 'worked';
}

/** The one call in a volley that actually performed retention work. */
export function workPerformingResult(records: CallRecord[]): CleanupRpcResult | null {
  const worked = records.filter((record) => record.outcome === 'worked');
  return worked.length === 1 && worked[0].result ? worked[0].result : null;
}

// ---------------------------------------------------------------------------
// Volley aggregation
// ---------------------------------------------------------------------------

export interface VolleySummary {
  calls: number;
  worked: number;
  skipped: number;
  deadlocks: number;
  lockNotAvailable: number;
  errors: number;
  contractViolations: number;
  dispatchSpreadMs: number;
  /**
   * Proof the calls were genuinely simultaneous: the LAST call was dispatched
   * before the FIRST call settled, so there was an instant at which every call
   * was in flight. Without this, "exactly one worked" is satisfiable by calls
   * that merely ran back to back — which would be a green result proving
   * nothing about a singleton.
   */
  overlapConfirmed: boolean;
}

export function summarizeVolley(records: CallRecord[]): VolleySummary {
  const dispatched = records.map((record) => record.dispatchedAtMs);
  const settled = records.map((record) => record.settledAtMs);
  const lastDispatch = dispatched.length > 0 ? Math.max(...dispatched) : 0;
  const firstSettle = settled.length > 0 ? Math.min(...settled) : 0;
  const firstDispatch = dispatched.length > 0 ? Math.min(...dispatched) : 0;
  const count = (outcome: CallOutcome): number =>
    records.filter((record) => record.outcome === outcome).length;

  return {
    calls: records.length,
    worked: count('worked'),
    skipped: count('skipped'),
    deadlocks: count('deadlock'),
    lockNotAvailable: count('lock_not_available'),
    errors: count('error'),
    contractViolations: count('contract_violation'),
    dispatchSpreadMs: lastDispatch - firstDispatch,
    overlapConfirmed: records.length >= 2 && lastDispatch < firstSettle,
  };
}

// ---------------------------------------------------------------------------
// Trigger A — concurrency singleton
// ---------------------------------------------------------------------------

export interface TriggerAInput {
  summary: VolleySummary;
  expectedCalls: number;
  /**
   * `DATA_RETENTION_CLEANUP` audit rows that appeared across the volley,
   * measured as an after-minus-before row count so it carries no dependency on
   * agreement between the driver's clock and the database's. Duplicate rows are
   * the other half of BUG-2026-08-22-001; exactly one tick must leave exactly
   * one row.
   */
  cleanupAuditRowsWritten: number;
}

export function evaluateTriggerA(input: TriggerAInput): EvaluatedRequirement {
  const { summary, expectedCalls, cleanupAuditRowsWritten } = input;
  const singleWorker = summary.worked === 1;
  const everyOtherSkipped = summary.skipped === Math.max(expectedCalls - 1, 0);
  const noDeadlocks = summary.deadlocks === 0;
  const clean =
    summary.errors === 0 && summary.contractViolations === 0 && summary.lockNotAvailable === 0;
  const exactlyOneAuditRow = cleanupAuditRowsWritten === 1;

  const held =
    summary.calls === expectedCalls &&
    summary.overlapConfirmed &&
    singleWorker &&
    everyOtherSkipped &&
    noDeadlocks &&
    clean &&
    exactlyOneAuditRow;

  return {
    held,
    counts: {
      triggerAConcurrentCalls: summary.calls,
      triggerAWorkPerformingRuns: summary.worked,
      triggerASkippedConcurrentRuns: summary.skipped,
      triggerADeadlock40P01: summary.deadlocks,
      triggerALockNotAvailable55P03Escaped: summary.lockNotAvailable,
      triggerARpcErrors: summary.errors,
      triggerAResultContractViolations: summary.contractViolations,
      triggerADispatchSpreadMs: summary.dispatchSpreadMs,
      triggerAOverlapConfirmed: summary.overlapConfirmed,
      triggerACleanupAuditRowsWritten: cleanupAuditRowsWritten,
      triggerASingletonHeld: held,
    },
  };
}

// ---------------------------------------------------------------------------
// Trigger B — the audit_events purge path
// ---------------------------------------------------------------------------

export interface TriggerBInput {
  /** `reject_audit_delete` fired on a probe DELETE before the volley. */
  appendOnlyGuardInstalledBefore: boolean;
  /** ...and after it. 0411's 55P03 handler must never leave the guard off. */
  appendOnlyGuardInstalledAfter: boolean;
  /** The work-performing call's result, or null if there wasn't exactly one. */
  result: CleanupRpcResult | null;
  /** `auditBefore - auditAfter + cleanupAuditRowsWritten`. */
  auditRowsRemovedObserved: number;
  seededPastAuditRows: number;
  seededPastAuditRowsRemaining: number;
  /** 55P03 occurrences seen at the RPC boundary this cycle. */
  lockNotAvailableEscaped: number;
}

export function evaluateTriggerB(input: TriggerBInput): EvaluatedRequirement {
  const {
    appendOnlyGuardInstalledBefore,
    appendOnlyGuardInstalledAfter,
    result,
    auditRowsRemovedObserved,
    seededPastAuditRows,
    seededPastAuditRowsRemaining,
    lockNotAvailableEscaped,
  } = input;

  const purgeSkipped = result?.audit_events_purge_skipped ?? true;
  const reported = result?.audit_events_deleted ?? NOT_MEASURED;

  // 0411's contract, still owed under 0417.
  //   skipped  => the count is the -1 sentinel, never 0 (0 would falsely assert
  //               "we looked and there was nothing to purge"), the guard is
  //               still installed, and the seeded old rows are still there.
  //   not skipped => a real count that matches what actually left the table,
  //               and every seeded past-boundary row is gone.
  const sentinelContract = purgeSkipped ? reported === NOT_MEASURED : reported >= 0;
  const countMatchesObserved = purgeSkipped ? true : reported === auditRowsRemovedObserved;
  const pastRowsCleared = purgeSkipped
    ? seededPastAuditRowsRemaining === seededPastAuditRows
    : seededPastAuditRowsRemaining === 0;

  const held =
    result !== null &&
    appendOnlyGuardInstalledBefore &&
    appendOnlyGuardInstalledAfter &&
    lockNotAvailableEscaped === 0 &&
    sentinelContract &&
    countMatchesObserved &&
    pastRowsCleared;

  return {
    held,
    counts: {
      triggerBAppendOnlyGuardInstalledBefore: appendOnlyGuardInstalledBefore,
      triggerBAppendOnlyGuardInstalledAfter: appendOnlyGuardInstalledAfter,
      triggerBAuditPurgeSkipped: purgeSkipped,
      triggerBAuditDeletedReported: reported,
      triggerBAuditRowsRemovedObserved: auditRowsRemovedObserved,
      triggerBAuditSeededPastRows: seededPastAuditRows,
      triggerBAuditSeededPastRowsRemaining: seededPastAuditRowsRemaining,
      triggerBSentinelContractHeld: sentinelContract,
      triggerBReportedMatchesObserved: countMatchesObserved,
      triggerBLockNotAvailable55P03Escaped: lockNotAvailableEscaped,
      triggerBAuditPurgeContractHeld: held,
    },
  };
}

// ---------------------------------------------------------------------------
// Daily flush observation
// ---------------------------------------------------------------------------

export interface RetentionTableObservation {
  table: string;
  /** What the function said it deleted from this table. */
  reportedDeleted: number;
  /** `before - after` for the whole table, measured by exact row count. */
  observedRemoved: number;
  seededPast: number;
  seededPastRemaining: number;
  seededKeep: number;
  seededKeepRemaining: number;
}

export interface DailyFlushInput {
  tables: RetentionTableObservation[];
  /** Wall-clock hours since the driver started this soak. */
  elapsedHours: number;
  cyclesCompleted: number;
  /** Cycles whose volley produced exactly one work-performing run. */
  retentionRunsObserved: number;
  /** Whether the audit purge was skipped this run — its counts are sentinels. */
  auditPurgeSkipped: boolean;
  requiredWindowHours: number;
}

/** Table names as they appear in a counter key: `ai_usage_events` -> `AiUsageEvents`. */
export function counterSegment(table: string): string {
  return table
    .split('_')
    .map((part) => (part.length === 0 ? part : part[0].toUpperCase() + part.slice(1)))
    .join('');
}

export function evaluateDailyFlush(input: DailyFlushInput): EvaluatedRequirement {
  const counts: Record<string, number | boolean> = {};
  let pastRemaining = 0;
  let insideBoundaryRemoved = 0;
  let mismatches = 0;

  for (const table of input.tables) {
    const segment = counterSegment(table.table);
    // The audit purge running under a 55P03 skip reports sentinels for
    // audit_events only; comparing a sentinel to an observed count would
    // manufacture a failure out of 0411 behaving correctly.
    const sentinelised = table.table === 'audit_events' && input.auditPurgeSkipped;
    const matches = sentinelised ? true : table.reportedDeleted === table.observedRemoved;
    if (!matches) mismatches += 1;

    const keepRemoved = table.seededKeep - table.seededKeepRemaining;
    const stillPast = sentinelised ? 0 : table.seededPastRemaining;
    pastRemaining += stillPast;
    insideBoundaryRemoved += keepRemoved;

    counts[`dailyFlush${segment}DeletedReported`] = table.reportedDeleted;
    counts[`dailyFlush${segment}RowsRemovedObserved`] = table.observedRemoved;
    counts[`dailyFlush${segment}PastBoundaryRemaining`] = table.seededPastRemaining;
    counts[`dailyFlush${segment}InsideBoundaryRemoved`] = keepRemoved;
  }

  const windowSatisfied = input.elapsedHours >= input.requiredWindowHours;
  const held =
    input.tables.length > 0 &&
    pastRemaining === 0 &&
    insideBoundaryRemoved === 0 &&
    mismatches === 0;

  counts.dailyFlushTablesObserved = input.tables.length;
  counts.dailyFlushElapsedHours = Number(input.elapsedHours.toFixed(3));
  counts.dailyFlushCyclesCompleted = input.cyclesCompleted;
  counts.dailyFlushRetentionRunsObserved = input.retentionRunsObserved;
  counts.dailyFlushPastBoundaryRowsRemaining = pastRemaining;
  counts.dailyFlushInsideBoundaryRowsRemoved = insideBoundaryRemoved;
  counts.dailyFlushReportedVsObservedMismatches = mismatches;
  // Reported, deliberately NOT part of `held`: the 24h window is a property of
  // the whole soak, not of a single cycle. The summary row is where it is
  // required — see `evaluateSoakSummary`.
  counts.dailyFlushWindowHoursRequired = input.requiredWindowHours;
  counts.dailyFlushWindowSatisfied = windowSatisfied;
  counts.dailyFlushObservationHeld = held;

  return { held, counts };
}

// ---------------------------------------------------------------------------
// Per-org isolation
// ---------------------------------------------------------------------------

export interface PerOrgTableObservation {
  table: string;
  pastSeeded: number;
  pastRemaining: number;
  keepSeeded: number;
  keepRemaining: number;
}

export interface PerOrgInput {
  /** Both orgs are seeded on both sides of every boundary of every org-scoped
   *  table, so the assertion is symmetric: whichever org's rows aged out, the
   *  OTHER org's retained rows must be untouched. */
  orgA: PerOrgTableObservation[];
  orgB: PerOrgTableObservation[];
  /** `table -> reportedDeleted` from the work-performing run. */
  reportedDeletedByTable: Readonly<Record<string, number>>;
  /** Tables whose reported count is a sentinel this cycle (audit purge skipped). */
  sentinelTables: readonly string[];
}

function removedByOrg(rows: PerOrgTableObservation[], table: string): number {
  const row = rows.find((entry) => entry.table === table);
  return row ? row.pastSeeded - row.pastRemaining : 0;
}

function keepRemovedByOrg(rows: PerOrgTableObservation[], table: string): number {
  const row = rows.find((entry) => entry.table === table);
  return row ? row.keepSeeded - row.keepRemaining : 0;
}

export function evaluatePerOrgIsolation(input: PerOrgInput): EvaluatedRequirement {
  const tables = Array.from(new Set([...input.orgA, ...input.orgB].map((row) => row.table)));
  let orgAPastRemoved = 0;
  let orgBPastRemoved = 0;
  let orgAKeepRemoved = 0;
  let orgBKeepRemoved = 0;
  let unattributed = 0;

  const counts: Record<string, number | boolean> = {};

  for (const table of tables) {
    const aPast = removedByOrg(input.orgA, table);
    const bPast = removedByOrg(input.orgB, table);
    const aKeep = keepRemovedByOrg(input.orgA, table);
    const bKeep = keepRemovedByOrg(input.orgB, table);
    orgAPastRemoved += aPast;
    orgBPastRemoved += bPast;
    orgAKeepRemoved += aKeep;
    orgBKeepRemoved += bKeep;

    // Attributability: on a clean-mirror rig where the driver is the only
    // writer, the count the function reported for a table must decompose
    // exactly into the two orgs' removals. Anything left over is a row this
    // driver cannot account for, which is precisely what "attributable per
    // org" has to mean if it is to mean anything.
    if (!input.sentinelTables.includes(table)) {
      const reported = input.reportedDeletedByTable[table] ?? 0;
      unattributed += Math.abs(reported - (aPast + bPast));
    }

    const segment = counterSegment(table);
    counts[`perOrg${segment}OrgAPastRemoved`] = aPast;
    counts[`perOrg${segment}OrgBPastRemoved`] = bPast;
    counts[`perOrg${segment}OrgAKeepRemoved`] = aKeep;
    counts[`perOrg${segment}OrgBKeepRemoved`] = bKeep;
  }

  const crossOrgKeepRemoved = orgAKeepRemoved + orgBKeepRemoved;
  const held = tables.length > 0 && crossOrgKeepRemoved === 0 && unattributed === 0;

  counts.perOrgOrgsSeeded = 2;
  counts.perOrgTablesObserved = tables.length;
  counts.perOrgOrgAPastRowsRemoved = orgAPastRemoved;
  counts.perOrgOrgBPastRowsRemoved = orgBPastRemoved;
  counts.perOrgOrgAKeepRowsRemoved = orgAKeepRemoved;
  counts.perOrgOrgBKeepRowsRemoved = orgBKeepRemoved;
  counts.perOrgCrossOrgKeepRowsRemoved = crossOrgKeepRemoved;
  counts.perOrgUnattributedDeletedRows = unattributed;
  counts.perOrgIsolationHeld = held;

  return { held, counts };
}

// ---------------------------------------------------------------------------
// Verdict + row construction
// ---------------------------------------------------------------------------

export interface CycleVerdictInput {
  triggerA: EvaluatedRequirement;
  triggerB: EvaluatedRequirement;
  dailyFlush: EvaluatedRequirement;
  perOrg: EvaluatedRequirement;
  /** Live-only: the rig worker answered `/health`. The soak clock is worker
   *  uptime, so a cycle observed while the worker is down is not evidence. */
  rigWorkerHealthy: boolean;
}

export function computeCycleVerdict(input: CycleVerdictInput): 'pass' | 'fail' {
  return input.triggerA.held &&
    input.triggerB.held &&
    input.dailyFlush.held &&
    input.perOrg.held &&
    input.rigWorkerHealthy
    ? 'pass'
    : 'fail';
}

export function mergeCounts(...parts: ReadonlyArray<Record<string, number | boolean>>): Record<string, number | boolean> {
  return Object.assign({}, ...parts) as Record<string, number | boolean>;
}

export interface SoakSummaryInput {
  cyclesCompleted: number;
  cyclesPassed: number;
  elapsedHours: number;
  requiredWindowHours: number;
  totalDeadlocks: number;
  totalConcurrentCalls: number;
  totalSkippedConcurrentRuns: number;
  totalWorkPerformingRuns: number;
  totalContractViolations: number;
  appendOnlyGuardEverMissing: boolean;
}

export function evaluateSoakSummary(input: SoakSummaryInput): EvaluatedRequirement {
  const windowSatisfied = input.elapsedHours >= input.requiredWindowHours;
  const held =
    input.cyclesCompleted > 0 &&
    input.cyclesPassed === input.cyclesCompleted &&
    input.totalDeadlocks === 0 &&
    input.totalContractViolations === 0 &&
    !input.appendOnlyGuardEverMissing &&
    windowSatisfied;

  return {
    held,
    counts: {
      soakCyclesCompleted: input.cyclesCompleted,
      soakCyclesPassed: input.cyclesPassed,
      soakElapsedHours: Number(input.elapsedHours.toFixed(3)),
      soakWindowHoursRequired: input.requiredWindowHours,
      dailyFlushWindowSatisfied: windowSatisfied,
      triggerAConcurrentCalls: input.totalConcurrentCalls,
      triggerAWorkPerformingRuns: input.totalWorkPerformingRuns,
      triggerASkippedConcurrentRuns: input.totalSkippedConcurrentRuns,
      triggerADeadlock40P01: input.totalDeadlocks,
      triggerAResultContractViolations: input.totalContractViolations,
      triggerBAppendOnlyGuardEverMissing: input.appendOnlyGuardEverMissing,
      soakVerdictHeld: held,
    },
  };
}

// ---------------------------------------------------------------------------
// Seed timing
// ---------------------------------------------------------------------------

export interface SeedTimestamps {
  /** Comfortably OLDER than the boundary: must be purged. */
  pastIso: string;
  /** Comfortably YOUNGER than the boundary: must survive, and self-expires one
   *  margin window later so the rig is not left with permanent litter. */
  keepIso: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function seedTimestamps(nowMs: number, boundaryDays: number, marginDays: number): SeedTimestamps {
  return {
    pastIso: new Date(nowMs - (boundaryDays + marginDays) * MS_PER_DAY).toISOString(),
    keepIso: new Date(nowMs - (boundaryDays - marginDays) * MS_PER_DAY).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Self-test mode — pure, no DB, no network, never soak evidence
// ---------------------------------------------------------------------------

function syntheticVolley(): CallRecord[] {
  const winner: CleanupRpcResult = {
    success: true,
    skipped_concurrent_run: false,
    webhook_delivery_logs_deleted: 400,
    verification_events_deleted: 400,
    ai_usage_events_deleted: 400,
    audit_events_deleted: 400,
    audit_events_purge_skipped: false,
  };
  const loser: CleanupRpcResult = {
    success: true,
    skipped_concurrent_run: true,
    webhook_delivery_logs_deleted: NOT_MEASURED,
    verification_events_deleted: NOT_MEASURED,
    ai_usage_events_deleted: NOT_MEASURED,
    audit_events_deleted: NOT_MEASURED,
    audit_events_purge_skipped: true,
  };
  const records: CallRecord[] = [
    { outcome: 'worked', dispatchedAtMs: 1_000, settledAtMs: 3_000, result: winner },
  ];
  for (let i = 1; i < 8; i += 1) {
    records.push({
      outcome: 'skipped',
      dispatchedAtMs: 1_000 + i,
      settledAtMs: 2_000 + i,
      result: loser,
    });
  }
  return records;
}

export function runSelfTest(): DriverRow {
  const records = syntheticVolley();
  const summary = summarizeVolley(records);
  const result = workPerformingResult(records);

  const triggerA = evaluateTriggerA({
    summary,
    expectedCalls: records.length,
    cleanupAuditRowsWritten: 1,
  });

  const triggerB = evaluateTriggerB({
    appendOnlyGuardInstalledBefore: true,
    appendOnlyGuardInstalledAfter: true,
    result,
    auditRowsRemovedObserved: 400,
    seededPastAuditRows: 400,
    seededPastAuditRowsRemaining: 0,
    lockNotAvailableEscaped: 0,
  });

  const dailyFlush = evaluateDailyFlush({
    tables: [
      {
        table: 'webhook_delivery_logs',
        reportedDeleted: 400,
        observedRemoved: 400,
        seededPast: 400,
        seededPastRemaining: 0,
        seededKeep: 400,
        seededKeepRemaining: 400,
      },
      {
        table: 'verification_events',
        reportedDeleted: 400,
        observedRemoved: 400,
        seededPast: 400,
        seededPastRemaining: 0,
        seededKeep: 400,
        seededKeepRemaining: 400,
      },
      {
        table: 'ai_usage_events',
        reportedDeleted: 400,
        observedRemoved: 400,
        seededPast: 400,
        seededPastRemaining: 0,
        seededKeep: 400,
        seededKeepRemaining: 400,
      },
      {
        table: 'audit_events',
        reportedDeleted: 400,
        observedRemoved: 400,
        seededPast: 400,
        seededPastRemaining: 0,
        seededKeep: 400,
        seededKeepRemaining: 400,
      },
    ],
    elapsedHours: 48,
    cyclesCompleted: 96,
    retentionRunsObserved: 96,
    auditPurgeSkipped: false,
    requiredWindowHours: 24,
  });

  const orgRows: PerOrgTableObservation[] = [
    { table: 'verification_events', pastSeeded: 200, pastRemaining: 0, keepSeeded: 200, keepRemaining: 200 },
    { table: 'ai_usage_events', pastSeeded: 200, pastRemaining: 0, keepSeeded: 200, keepRemaining: 200 },
    { table: 'audit_events', pastSeeded: 200, pastRemaining: 0, keepSeeded: 200, keepRemaining: 200 },
  ];
  const perOrg = evaluatePerOrgIsolation({
    orgA: orgRows,
    orgB: orgRows,
    reportedDeletedByTable: {
      verification_events: 400,
      ai_usage_events: 400,
      audit_events: 400,
    },
    sentinelTables: [],
  });

  // Negative controls. A driver whose helpers cannot FAIL is a driver that
  // proves nothing, so the self-test asserts the fail paths too.
  const deadlockVolley = summarizeVolley([
    { outcome: 'worked', dispatchedAtMs: 0, settledAtMs: 100 },
    { outcome: 'deadlock', dispatchedAtMs: 1, settledAtMs: 50, errorCode: SQLSTATE_DEADLOCK },
  ]);
  const deadlockRejected = !evaluateTriggerA({
    summary: deadlockVolley,
    expectedCalls: 2,
    cleanupAuditRowsWritten: 1,
  }).held;

  const sequentialRejected = !evaluateTriggerA({
    summary: summarizeVolley([
      { outcome: 'worked', dispatchedAtMs: 0, settledAtMs: 10 },
      { outcome: 'skipped', dispatchedAtMs: 20, settledAtMs: 30 },
    ]),
    expectedCalls: 2,
    cleanupAuditRowsWritten: 1,
  }).held;

  const duplicateAuditRowRejected = !evaluateTriggerA({
    summary,
    expectedCalls: records.length,
    cleanupAuditRowsWritten: 2,
  }).held;

  const zeroInsteadOfSentinelRejected = !evaluateTriggerB({
    appendOnlyGuardInstalledBefore: true,
    appendOnlyGuardInstalledAfter: true,
    result: {
      success: true,
      skipped_concurrent_run: false,
      webhook_delivery_logs_deleted: 0,
      verification_events_deleted: 0,
      ai_usage_events_deleted: 0,
      audit_events_deleted: 0,
      audit_events_purge_skipped: true,
    },
    auditRowsRemovedObserved: 0,
    seededPastAuditRows: 10,
    seededPastAuditRowsRemaining: 10,
    lockNotAvailableEscaped: 0,
  }).held;

  const droppedGuardRejected = !evaluateTriggerB({
    appendOnlyGuardInstalledBefore: true,
    appendOnlyGuardInstalledAfter: false,
    result,
    auditRowsRemovedObserved: 400,
    seededPastAuditRows: 400,
    seededPastAuditRowsRemaining: 0,
    lockNotAvailableEscaped: 0,
  }).held;

  const crossOrgDeletionRejected = !evaluatePerOrgIsolation({
    orgA: orgRows,
    orgB: [
      { table: 'verification_events', pastSeeded: 200, pastRemaining: 0, keepSeeded: 200, keepRemaining: 199 },
      { table: 'ai_usage_events', pastSeeded: 200, pastRemaining: 0, keepSeeded: 200, keepRemaining: 200 },
      { table: 'audit_events', pastSeeded: 200, pastRemaining: 0, keepSeeded: 200, keepRemaining: 200 },
    ],
    reportedDeletedByTable: {
      verification_events: 400,
      ai_usage_events: 400,
      audit_events: 400,
    },
    sentinelTables: [],
  }).held;

  const counts = mergeCounts(triggerA.counts, triggerB.counts, dailyFlush.counts, perOrg.counts, {
    selfTestDeadlockRejected: deadlockRejected,
    selfTestSequentialVolleyRejected: sequentialRejected,
    selfTestDuplicateAuditRowRejected: duplicateAuditRowRejected,
    selfTestZeroInsteadOfSentinelRejected: zeroInsteadOfSentinelRejected,
    selfTestDroppedGuardRejected: droppedGuardRejected,
    selfTestCrossOrgDeletionRejected: crossOrgDeletionRejected,
    selfTestPre0417ShapeRejected: parseCleanupResult({
      success: true,
      webhook_delivery_logs_deleted: 0,
      verification_events_deleted: 0,
      ai_usage_events_deleted: 0,
      audit_events_deleted: NOT_MEASURED,
      audit_events_purge_skipped: true,
    }) === null,
  });

  const negativeControlsHeld =
    deadlockRejected &&
    sequentialRejected &&
    duplicateAuditRowRejected &&
    zeroInsteadOfSentinelRejected &&
    droppedGuardRejected &&
    crossOrgDeletionRejected &&
    counts.selfTestPre0417ShapeRejected === true;

  const verdict = computeCycleVerdict({
    triggerA,
    triggerB,
    dailyFlush,
    perOrg,
    rigWorkerHealthy: true,
  });

  return {
    utc: new Date().toISOString(),
    pr: PR_NUMBER,
    tier: SOAK_TIER,
    mode: 'self-test',
    // Never soak evidence. Self-test asserts the driver's own logic against
    // fixtures; it says nothing about a rig, 0417, or Postgres.
    evidenceForSoak: false,
    changedBehavior: CHANGED_BEHAVIOR,
    status: verdict === 'pass' && negativeControlsHeld ? 'pass' : 'fail',
    counts,
    observations: [
      'self-test mode: pure helper validation over synthetic fixtures, no database and no network',
    ],
  };
}

// ---------------------------------------------------------------------------
// Live mode
// ---------------------------------------------------------------------------

type Db = SupabaseClient;

type CountFilter =
  | { op: 'eq'; column: string; value: string }
  | { op: 'lt' | 'gte'; column: string; value: string }
  | { op: 'like'; column: string; value: string }
  | { op: 'is-null'; column: string };

/**
 * Generic exact row count.
 *
 * `arkova/missing-org-filter` (SCRUM-1208) does not see this call site because
 * the table name is a parameter, and that is not an evasion: the retention
 * function under test is deliberately GLOBAL — it deletes by age across every
 * tenant and has no org predicate anywhere in its body. Asserting "the reported
 * count matches what actually disappeared" therefore requires an unscoped
 * count, and constraining it to one org would silently make the assertion
 * unfalsifiable. Per-org attribution is layered on top by passing an `org_id`
 * filter from `countSeeded`, which is where tenant scoping belongs here.
 */
async function countRows(db: Db, table: string, filters: readonly CountFilter[]): Promise<number> {
  let query = db.from(table).select('*', { count: 'exact', head: true });
  for (const filter of filters) {
    if (filter.op === 'eq') query = query.eq(filter.column, filter.value);
    else if (filter.op === 'lt') query = query.lt(filter.column, filter.value);
    else if (filter.op === 'gte') query = query.gte(filter.column, filter.value);
    else if (filter.op === 'like') query = query.like(filter.column, filter.value);
    else query = query.is(filter.column, null);
  }
  const { count, error } = await query;
  if (error) throw new Error(`count(${table}) failed: ${error.message}`);
  return count ?? 0;
}

export interface SeedSpec {
  table: string;
  boundaryDays: number;
  /** Column + value that identifies a driver-seeded row. */
  markerColumn: string;
  markerValue: string;
  /** null when the table carries no tenant column (webhook_delivery_logs). */
  orgColumn: string | null;
  /** Whether the driver may DELETE its own rows here during cleanup. */
  deletable: boolean;
  /** Column carrying this cycle's tag, for tables whose rows OUTLIVE the cycle
   *  that seeded them.
   *
   *  `audit_events` is the only one: `reject_audit_delete` means the driver
   *  cannot clean up after itself there, so a cycle's retained rows are still
   *  present on the next cycle — and they sit BELOW the next cycle's retained
   *  boundary (each cycle's boundary walks forward with wall-clock time), so a
   *  created_at-only filter reads them as that cycle's aged rows. They are
   *  inside the real 730d retention window, `cleanup_expired_data()` correctly
   *  leaves them alone, and `seededPastRemaining` therefore never returns to 0
   *  from cycle 2 onward. Counting per cycle is what makes a multi-cycle window
   *  measure the cycle it is actually running. null = every row is deleted at
   *  the end of its own cycle, so no scoping is needed. */
  cycleColumn: string | null;
  /** Value `cycleColumn` carries for a given cycle tag. */
  cycleValue?: (cycleTag: string) => string;
  buildRow(context: SeedRowContext): Record<string, unknown>;
}

interface SeedRowContext {
  createdAtIso: string;
  orgId: string | null;
  index: number;
  cycleTag: string;
  webhookEndpointId: string | null;
}

export const VERIFICATION_SPEC: SeedSpec = {
  table: 'verification_events',
  boundaryDays: RETENTION_BOUNDARY_DAYS.verification_events,
  markerColumn: 'user_agent',
  markerValue: SEED_MARKER,
  orgColumn: 'org_id',
  deletable: true,
  cycleColumn: null,
  buildRow: ({ createdAtIso, orgId, index, cycleTag }) => ({
    public_id: `SOAK-2335-${cycleTag}-${index}`.slice(0, 50),
    method: 'api',
    result: 'verified',
    fingerprint_provided: false,
    user_agent: SEED_MARKER,
    org_id: orgId,
    created_at: createdAtIso,
  }),
};

const AI_USAGE_SPEC: SeedSpec = {
  table: 'ai_usage_events',
  boundaryDays: RETENTION_BOUNDARY_DAYS.ai_usage_events,
  markerColumn: 'provider',
  markerValue: SEED_MARKER,
  orgColumn: 'org_id',
  deletable: true,
  cycleColumn: null,
  buildRow: ({ createdAtIso, orgId }) => ({
    org_id: orgId,
    event_type: 'extraction',
    provider: SEED_MARKER,
    tokens_used: 0,
    credits_consumed: 0,
    success: true,
    created_at: createdAtIso,
  }),
};

export const AUDIT_SPEC: SeedSpec = {
  table: 'audit_events',
  boundaryDays: RETENTION_BOUNDARY_DAYS.audit_events,
  markerColumn: 'event_type',
  markerValue: AUDIT_PROBE_EVENT_TYPE,
  orgColumn: 'org_id',
  // `reject_audit_delete` is the whole point of Trigger B — the driver must not
  // be able to delete these rows, and does not try. The retained side is dated
  // to self-expire one margin window after the soak instead.
  deletable: false,
  cycleColumn: 'target_id',
  cycleValue: (cycleTag: string) => `${SEED_MARKER}:${cycleTag}`,
  buildRow: ({ createdAtIso, orgId, cycleTag }) => ({
    event_type: AUDIT_PROBE_EVENT_TYPE,
    event_category: 'SYSTEM',
    actor_id: null,
    target_type: SEED_MARKER,
    // Deliberately NOT a uuid: `cleanup_expired_data()` exempts rows whose
    // `target_id` matches a legal-hold anchor id by TEXT comparison, so a
    // non-uuid tag can never accidentally land on that exemption.
    target_id: `${SEED_MARKER}:${cycleTag}`,
    org_id: orgId,
    details: JSON.stringify({ marker: SEED_MARKER, pr: PR_NUMBER }),
    created_at: createdAtIso,
  }),
};

const WEBHOOK_SPEC: SeedSpec = {
  table: 'webhook_delivery_logs',
  boundaryDays: RETENTION_BOUNDARY_DAYS.webhook_delivery_logs,
  markerColumn: 'event_type',
  markerValue: `${SEED_MARKER}.probe`,
  // No tenant column on this table; its org lives on webhook_endpoints. It
  // therefore takes part in the daily-flush observation but not in the per-org
  // isolation assertion, and the row says so rather than implying coverage.
  orgColumn: null,
  deletable: true,
  cycleColumn: null,
  buildRow: ({ createdAtIso, webhookEndpointId }) => ({
    endpoint_id: webhookEndpointId,
    event_type: `${SEED_MARKER}.probe`,
    event_id: randomUUID(),
    payload: { marker: SEED_MARKER, pr: PR_NUMBER },
    attempt_number: 1,
    status: 'success',
    created_at: createdAtIso,
  }),
};

const ORG_SCOPED_SPECS: readonly SeedSpec[] = [VERIFICATION_SPEC, AI_USAGE_SPEC, AUDIT_SPEC];

/** Build the guard-probe sentinel: one retained-side `audit_events` row owned by
 *  org A that the driver then asks PostgREST to DELETE. Carries
 *  `AUDIT_SENTINEL_EVENT_TYPE`, so it is invisible to every seeded-row count. */
export function buildGuardSentinelRow(context: {
  nowMs: number;
  marginDays: number;
  orgId: string;
  cycleTag: string;
  targetId: string;
}): Record<string, unknown> {
  const stamps = seedTimestamps(context.nowMs, AUDIT_SPEC.boundaryDays, context.marginDays);
  return {
    ...AUDIT_SPEC.buildRow({
      createdAtIso: stamps.keepIso,
      orgId: context.orgId,
      index: 0,
      cycleTag: context.cycleTag,
      webhookEndpointId: null,
    }),
    target_id: context.targetId,
    event_type: AUDIT_SENTINEL_EVENT_TYPE,
  };
}

interface LiveContext {
  db: Db;
  args: DriverArgs;
  projectRef: string;
  admission: Record<string, unknown>;
  orgA: string;
  orgB: string;
  webhookEndpointId: string | null;
  startedAtMs: number;
}

function readLiveEnv(): { supabaseUrl?: string; serviceRoleKey?: string } {
  return {
    supabaseUrl: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
}

function loadAdmission(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('admission JSON must be an object');
  }
  return parsed as Record<string, unknown>;
}

/** Insert in bounded batches. Request-BODY batching — unrelated to `.in()`
 *  filter width, which is `chunkForInFilter`'s job and is not used here. */
const INSERT_BATCH_ROWS = 250;

async function insertRows(db: Db, table: string, rows: ReadonlyArray<Record<string, unknown>>): Promise<void> {
  for (let start = 0; start < rows.length; start += INSERT_BATCH_ROWS) {
    const batch = rows.slice(start, start + INSERT_BATCH_ROWS);
    const { error } = await db.from(table).insert(batch);
    if (error) throw new Error(`insert(${table}) failed: ${error.message}`);
  }
}

function seedRowsFor(
  spec: SeedSpec,
  side: 'past' | 'keep',
  context: { nowMs: number; marginDays: number; orgId: string | null; count: number; cycleTag: string; webhookEndpointId: string | null },
): Array<Record<string, unknown>> {
  const stamps = seedTimestamps(context.nowMs, spec.boundaryDays, context.marginDays);
  const createdAtIso = side === 'past' ? stamps.pastIso : stamps.keepIso;
  const rows: Array<Record<string, unknown>> = [];
  for (let index = 0; index < context.count; index += 1) {
    rows.push(
      spec.buildRow({
        createdAtIso,
        orgId: context.orgId,
        index,
        cycleTag: `${context.cycleTag}-${side}`,
        webhookEndpointId: context.webhookEndpointId,
      }),
    );
  }
  return rows;
}

export function seededFilters(
  spec: SeedSpec,
  side: 'past' | 'keep',
  nowMs: number,
  marginDays: number,
  orgId: string | null,
  cycleTag?: string,
): CountFilter[] {
  const stamps = seedTimestamps(nowMs, spec.boundaryDays, marginDays);
  const filters: CountFilter[] = [{ op: 'eq', column: spec.markerColumn, value: spec.markerValue }];
  if (orgId && spec.orgColumn) filters.push({ op: 'eq', column: spec.orgColumn, value: orgId });
  if (cycleTag && spec.cycleColumn && spec.cycleValue) {
    filters.push({ op: 'eq', column: spec.cycleColumn, value: spec.cycleValue(cycleTag) });
  }
  if (side === 'past') {
    // Anything at or before the past stamp for this cycle.
    filters.push({ op: 'lt', column: 'created_at', value: stamps.keepIso });
  } else {
    filters.push({ op: 'gte', column: 'created_at', value: stamps.keepIso });
  }
  return filters;
}

/**
 * Probe whether `reject_audit_delete` is installed, by asking it to do its job.
 *
 * This is a behavioural probe rather than a `pg_trigger` lookup on purpose: the
 * catalog can hold a trigger that does not fire, and PostgREST gives no route
 * to the catalog anyway. The probe targets ONE driver-owned sentinel row, so
 * the failure mode — the guard is missing and the DELETE succeeds — destroys a
 * row this driver created for exactly that purpose and nothing else.
 */
async function probeAppendOnlyGuard(db: Db, orgId: string, targetId: string): Promise<boolean> {
  const { error } = await db
    .from('audit_events')
    .delete()
    .eq('org_id', orgId)
    .eq('event_type', AUDIT_SENTINEL_EVENT_TYPE)
    .eq('target_id', targetId);
  if (!error) return false;
  return isAppendOnlyGuardError(error);
}

interface VolleyOutcome {
  records: CallRecord[];
  summary: VolleySummary;
}

/**
 * Fire `concurrency` genuinely simultaneous `cleanup_expired_data()` calls.
 *
 * Each call gets its OWN Supabase client so it opens its own connection and
 * lands on its own PostgREST backend; sharing one client would serialise
 * nothing but would make the independence claim unverifiable. Clients are
 * pre-warmed with a cheap read first so TLS and pool setup are not part of the
 * volley, and the volley itself is dispatched inside a single event-loop turn.
 * `summarizeVolley` then PROVES the overlap from the measured timestamps rather
 * than assuming it.
 */
async function fireVolley(clients: readonly Db[]): Promise<VolleyOutcome> {
  const records = await Promise.all(
    clients.map(async (client): Promise<CallRecord> => {
      const dispatchedAtMs = Date.now();
      const { data, error } = await client.rpc('cleanup_expired_data');
      const settledAtMs = Date.now();
      const outcome = classifyCall(data, error);
      const parsed = parseCleanupResult(data);
      const record: CallRecord = { outcome, dispatchedAtMs, settledAtMs };
      if (parsed) record.result = parsed;
      if (error?.code) record.errorCode = error.code;
      return record;
    }),
  );
  return { records, summary: summarizeVolley(records) };
}

async function prewarm(clients: readonly Db[]): Promise<void> {
  await Promise.all(
    clients.map(async (client) => {
      await client.from('organizations').select('id').limit(1);
    }),
  );
}

async function probeRigWorkerHealth(targetUrl: string): Promise<{ ok: boolean; note: string }> {
  try {
    const response = await fetch(`${targetUrl.replace(/\/+$/, '')}/health`, { method: 'GET' });
    return { ok: response.ok, note: `rig worker /health -> ${response.status}` };
  } catch {
    // Never surface the error object: it can carry the full URL and headers.
    return { ok: false, note: 'rig worker /health -> unreachable' };
  }
}

interface CycleTotals {
  cyclesCompleted: number;
  cyclesPassed: number;
  concurrentCalls: number;
  workPerformingRuns: number;
  skippedConcurrentRuns: number;
  deadlocks: number;
  contractViolations: number;
  retentionRunsObserved: number;
  appendOnlyGuardEverMissing: boolean;
}

async function runCycle(context: LiveContext, cycle: number, totals: CycleTotals): Promise<DriverRow> {
  const { db, args } = context;
  const nowMs = Date.now();
  const cycleTag = `${cycle}-${nowMs}`;
  const observations: string[] = [];
  const marginDays = args.keepMarginDays;

  const health = await probeRigWorkerHealth(args.targetUrl ?? '');
  observations.push(health.note);

  // --- seed ---------------------------------------------------------------
  const activeSpecs: SeedSpec[] = [...ORG_SCOPED_SPECS];
  if (context.webhookEndpointId) {
    activeSpecs.push(WEBHOOK_SPEC);
  } else {
    observations.push(
      'webhook_delivery_logs NOT seeded: no webhook endpoint available on the rig, and this table has no org column to seed against. Its retention branch is unobserved this cycle.',
    );
  }

  for (const spec of activeSpecs) {
    const orgs: Array<string | null> = spec.orgColumn ? [context.orgA, context.orgB] : [null];
    for (const orgId of orgs) {
      for (const side of ['past', 'keep'] as const) {
        await insertRows(
          db,
          spec.table,
          seedRowsFor(spec, side, {
            nowMs,
            marginDays,
            orgId,
            count: args.seedRows,
            cycleTag,
            webhookEndpointId: context.webhookEndpointId,
          }),
        );
      }
    }
  }

  // --- sentinel + guard probe (before) ------------------------------------
  const sentinelTarget = `${SEED_MARKER}:sentinel-${cycleTag}`;
  await insertRows(db, AUDIT_SPEC.table, [
    buildGuardSentinelRow({ nowMs, marginDays, orgId: context.orgA, cycleTag, targetId: sentinelTarget }),
  ]);
  const guardBefore = await probeAppendOnlyGuard(db, context.orgA, sentinelTarget);

  // --- measure (before) ---------------------------------------------------
  const tablesUnderTest = activeSpecs.map((spec) => spec.table);
  const beforeCounts = new Map<string, number>();
  for (const spec of activeSpecs) {
    beforeCounts.set(spec.table, await countRows(db, spec.table, []));
  }
  const cleanupAuditBefore = await countCleanupAuditRows(db);

  // --- Trigger A: the volley ---------------------------------------------
  const { createClient } = await import('@supabase/supabase-js');
  const clients: Db[] = [];
  for (let i = 0; i < args.concurrency; i += 1) {
    clients.push(
      createClient(process.env.SUPABASE_URL as string, process.env.SUPABASE_SERVICE_ROLE_KEY as string, {
        auth: { persistSession: false, autoRefreshToken: false },
      }),
    );
  }
  await prewarm(clients);
  const volley = await fireVolley(clients);
  const result = workPerformingResult(volley.records);

  // --- measure (after) ----------------------------------------------------
  const afterCounts = new Map<string, number>();
  for (const spec of activeSpecs) {
    afterCounts.set(spec.table, await countRows(db, spec.table, []));
  }
  const cleanupAuditAfter = await countCleanupAuditRows(db);
  const cleanupAuditRowsWritten = cleanupAuditAfter - cleanupAuditBefore;

  const guardAfter = await probeAppendOnlyGuard(db, context.orgA, sentinelTarget);

  // --- per-table observations --------------------------------------------
  const reportedByTable: Record<string, number> = {
    webhook_delivery_logs: result?.webhook_delivery_logs_deleted ?? 0,
    verification_events: result?.verification_events_deleted ?? 0,
    ai_usage_events: result?.ai_usage_events_deleted ?? 0,
    audit_events: result?.audit_events_deleted ?? 0,
  };
  const auditPurgeSkipped = result?.audit_events_purge_skipped ?? true;
  const sentinelTables = auditPurgeSkipped ? ['audit_events'] : [];

  const tableObservations: RetentionTableObservation[] = [];
  for (const spec of activeSpecs) {
    const before = beforeCounts.get(spec.table) ?? 0;
    const after = afterCounts.get(spec.table) ?? 0;
    // `cleanup_expired_data()` inserts one DATA_RETENTION_CLEANUP row into
    // audit_events on the run that did work, so that table's removal count is
    // `before - after + inserted`. Every other table is a plain difference.
    const inserted = spec.table === 'audit_events' ? cleanupAuditRowsWritten : 0;
    tableObservations.push({
      table: spec.table,
      reportedDeleted: reportedByTable[spec.table] ?? 0,
      observedRemoved: before - after + inserted,
      seededPast: args.seedRows * (spec.orgColumn ? 2 : 1),
      seededPastRemaining: await countRows(db, spec.table, seededFilters(spec, 'past', nowMs, marginDays, null, cycleTag)),
      seededKeep: args.seedRows * (spec.orgColumn ? 2 : 1),
      seededKeepRemaining: await countRows(db, spec.table, seededFilters(spec, 'keep', nowMs, marginDays, null, cycleTag)),
    });
  }

  const orgAObservations: PerOrgTableObservation[] = [];
  const orgBObservations: PerOrgTableObservation[] = [];
  for (const spec of ORG_SCOPED_SPECS) {
    for (const [orgId, bucket] of [
      [context.orgA, orgAObservations],
      [context.orgB, orgBObservations],
    ] as const) {
      bucket.push({
        table: spec.table,
        pastSeeded: args.seedRows,
        pastRemaining: await countRows(db, spec.table, seededFilters(spec, 'past', nowMs, marginDays, orgId, cycleTag)),
        keepSeeded: args.seedRows,
        keepRemaining: await countRows(db, spec.table, seededFilters(spec, 'keep', nowMs, marginDays, orgId, cycleTag)),
      });
    }
  }

  // --- evaluate -----------------------------------------------------------
  const auditObservation = tableObservations.find((entry) => entry.table === 'audit_events');
  const triggerA = evaluateTriggerA({
    summary: volley.summary,
    expectedCalls: args.concurrency,
    cleanupAuditRowsWritten,
  });
  const triggerB = evaluateTriggerB({
    appendOnlyGuardInstalledBefore: guardBefore,
    appendOnlyGuardInstalledAfter: guardAfter,
    result,
    auditRowsRemovedObserved: auditObservation?.observedRemoved ?? 0,
    seededPastAuditRows: auditObservation?.seededPast ?? 0,
    seededPastAuditRowsRemaining: auditObservation?.seededPastRemaining ?? 0,
    lockNotAvailableEscaped: volley.summary.lockNotAvailable,
  });
  const elapsedHours = (Date.now() - context.startedAtMs) / 3_600_000;
  const dailyFlush = evaluateDailyFlush({
    tables: tableObservations,
    elapsedHours,
    cyclesCompleted: totals.cyclesCompleted + 1,
    retentionRunsObserved: totals.retentionRunsObserved + (result ? 1 : 0),
    auditPurgeSkipped,
    requiredWindowHours: 24,
  });
  const perOrg = evaluatePerOrgIsolation({
    orgA: orgAObservations,
    orgB: orgBObservations,
    reportedDeletedByTable: reportedByTable,
    sentinelTables,
  });

  const status = computeCycleVerdict({
    triggerA,
    triggerB,
    dailyFlush,
    perOrg,
    rigWorkerHealthy: health.ok,
  });

  // --- housekeeping -------------------------------------------------------
  await cleanupDriverRows(db, activeSpecs, observations);

  observations.push(`tables under test: ${tablesUnderTest.join(', ')}`);
  observations.push(`orgs: ${orgLabel(context.orgA)}, ${orgLabel(context.orgB)} (sha256-12 labels, never raw ids)`);

  totals.cyclesCompleted += 1;
  totals.cyclesPassed += status === 'pass' ? 1 : 0;
  totals.concurrentCalls += volley.summary.calls;
  totals.workPerformingRuns += volley.summary.worked;
  totals.skippedConcurrentRuns += volley.summary.skipped;
  totals.deadlocks += volley.summary.deadlocks;
  totals.contractViolations += volley.summary.contractViolations;
  totals.retentionRunsObserved += result ? 1 : 0;
  if (!guardBefore || !guardAfter) totals.appendOnlyGuardEverMissing = true;

  return {
    utc: new Date().toISOString(),
    pr: PR_NUMBER,
    tier: SOAK_TIER,
    mode: 'live',
    evidenceForSoak: status === 'pass',
    changedBehavior: CHANGED_BEHAVIOR,
    status,
    cycle,
    projectRef: context.projectRef,
    targetUrl: context.args.targetUrl,
    admission: context.admission,
    counts: mergeCounts(
      triggerA.counts,
      triggerB.counts,
      dailyFlush.counts,
      perOrg.counts,
      { rigWorkerHealthOk: health.ok },
    ),
    observations,
  };
}

/**
 * Count the audit rows `cleanup_expired_data()` writes for itself.
 *
 * The function inserts with `actor_id NULL` and no `org_id`, so `org_id IS
 * NULL` is both the correct filter and the form `arkova/missing-org-filter`
 * recognises for explicit system-level rows.
 */
async function countCleanupAuditRows(db: Db): Promise<number> {
  const { count, error } = await db
    .from('audit_events')
    .select('*', { count: 'exact', head: true })
    .is('org_id', null)
    .eq('event_type', CLEANUP_AUDIT_EVENT_TYPE);
  if (error) throw new Error(`count(audit_events cleanup rows) failed: ${error.message}`);
  return count ?? 0;
}

/**
 * Remove the driver's own surviving rows from the tables it is allowed to
 * delete from. `audit_events` is deliberately excluded — `reject_audit_delete`
 * is the invariant under test and the driver must not be able to work around
 * it. Those rows are dated to age out one margin window after the soak.
 */
async function cleanupDriverRows(db: Db, specs: readonly SeedSpec[], observations: string[]): Promise<void> {
  for (const spec of specs) {
    if (!spec.deletable) continue;
    const { error } = await db.from(spec.table).delete().eq(spec.markerColumn, spec.markerValue);
    if (error) observations.push(`cleanup(${spec.table}) failed: ${error.message}`);
  }
}

async function resolveOrgs(db: Db, args: DriverArgs): Promise<{ orgA: string; orgB: string }> {
  if (args.orgA && args.orgB) return { orgA: args.orgA, orgB: args.orgB };
  const { data, error } = await db.from('organizations').select('id').limit(2);
  if (error) throw new Error(`organizations lookup failed: ${error.message}`);
  const ids = (data ?? [])
    .map((row) => (row as { id?: unknown }).id)
    .filter((id): id is string => typeof id === 'string');
  if (ids.length < 2) {
    throw new Error('per-org isolation needs at least two organizations on the rig; pass --org-a/--org-b');
  }
  return { orgA: ids[0], orgB: ids[1] };
}

async function resolveWebhookEndpoint(db: Db, args: DriverArgs): Promise<string | null> {
  if (args.webhookEndpointId) return args.webhookEndpointId;
  const { data, error } = await db.from('webhook_endpoints').select('id').limit(1);
  if (error) return null;
  const id = (data ?? []).map((row) => (row as { id?: unknown }).id).find((value) => typeof value === 'string');
  return typeof id === 'string' ? id : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function failRow(mode: DriverMode, blockers: string[]): DriverRow {
  return {
    utc: new Date().toISOString(),
    pr: PR_NUMBER,
    tier: SOAK_TIER,
    mode,
    evidenceForSoak: false,
    changedBehavior: CHANGED_BEHAVIOR,
    status: 'fail',
    counts: {},
    blockers,
  };
}

function emit(row: DriverRow, evidenceJsonl?: string): void {
  const line = `${JSON.stringify(row)}\n`;
  if (evidenceJsonl) appendFileSync(evidenceJsonl, line);
  process.stdout.write(line);
}

export async function runLive(args: DriverArgs): Promise<number> {
  const env = readLiveEnv();
  const blockers = validateLiveArgs(args, env);
  if (blockers.length > 0) {
    emit(failRow('live', blockers), args.evidenceJsonl);
    return 1;
  }

  const supabaseUrl = env.supabaseUrl as string;
  const serviceRoleKey = env.serviceRoleKey as string;
  const projectRef = projectRefFromUrl(supabaseUrl) ?? 'unknown';

  const { createClient } = await import('@supabase/supabase-js');
  const db: Db = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let context: LiveContext;
  try {
    const { orgA, orgB } = await resolveOrgs(db, args);
    context = {
      db,
      args,
      projectRef,
      admission: loadAdmission(args.admissionJson as string),
      orgA,
      orgB,
      webhookEndpointId: await resolveWebhookEndpoint(db, args),
      startedAtMs: Date.now(),
    };
  } catch (error) {
    emit(
      failRow('live', [`setup failed: ${error instanceof Error ? error.message : 'unknown error'}`]),
      args.evidenceJsonl,
    );
    return 1;
  }

  const totals: CycleTotals = {
    cyclesCompleted: 0,
    cyclesPassed: 0,
    concurrentCalls: 0,
    workPerformingRuns: 0,
    skippedConcurrentRuns: 0,
    deadlocks: 0,
    contractViolations: 0,
    retentionRunsObserved: 0,
    appendOnlyGuardEverMissing: false,
  };

  let stopping = false;
  const stop = (): void => {
    stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const deadlineMs = context.startedAtMs + args.durationMin * 60_000;
  let cycle = 0;

  do {
    cycle += 1;
    const cycleStartedMs = Date.now();
    try {
      const row = await runCycle(context, cycle, totals);
      emit(row, args.evidenceJsonl);
    } catch (error) {
      // A transient rig error must not end a 48h soak. It is recorded as a
      // failed cycle — which the summary verdict will hold against the run —
      // and the loop continues.
      totals.cyclesCompleted += 1;
      emit(
        {
          ...failRow('live', [
            `cycle ${cycle} failed: ${error instanceof Error ? error.message : 'unknown error'}`,
          ]),
          cycle,
          projectRef,
          targetUrl: args.targetUrl,
        },
        args.evidenceJsonl,
      );
    }

    if (stopping || Date.now() >= deadlineMs) break;
    const nextStartMs = cycleStartedMs + args.intervalMin * 60_000;
    const waitMs = Math.max(nextStartMs - Date.now(), 0);
    if (waitMs > 0) await sleep(Math.min(waitMs, Math.max(deadlineMs - Date.now(), 0)));
  } while (!stopping && Date.now() < deadlineMs);

  const summary = evaluateSoakSummary({
    cyclesCompleted: totals.cyclesCompleted,
    cyclesPassed: totals.cyclesPassed,
    elapsedHours: (Date.now() - context.startedAtMs) / 3_600_000,
    requiredWindowHours: 24,
    totalDeadlocks: totals.deadlocks,
    totalConcurrentCalls: totals.concurrentCalls,
    totalSkippedConcurrentRuns: totals.skippedConcurrentRuns,
    totalWorkPerformingRuns: totals.workPerformingRuns,
    totalContractViolations: totals.contractViolations,
    appendOnlyGuardEverMissing: totals.appendOnlyGuardEverMissing,
  });

  emit(
    {
      utc: new Date().toISOString(),
      pr: PR_NUMBER,
      tier: SOAK_TIER,
      mode: 'live',
      evidenceForSoak: summary.held,
      changedBehavior: CHANGED_BEHAVIOR,
      status: summary.held ? 'pass' : 'fail',
      summary: true,
      projectRef,
      targetUrl: args.targetUrl,
      admission: context.admission,
      counts: summary.counts,
      observations: [
        'soak summary row: aggregate over every cycle in this process. A single 40P01 anywhere in the run fails it.',
      ],
    },
    args.evidenceJsonl,
  );

  return summary.held ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'self-test') {
    const row = runSelfTest();
    emit(row, args.evidenceJsonl);
    process.exitCode = row.status === 'pass' ? 0 : 1;
    return;
  }
  process.exitCode = await runLive(args);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
