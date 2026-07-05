/**
 * Money-conservation reconciler — daily-sweep CALLER (S1-9, parent SCRUM-2349 /
 * PM-25).
 *
 * What this is (and is NOT)
 * -------------------------
 * The reconciler LOGIC already lives in prod as the SQL function
 * `org_credit_ledger_divergence(p_org_id uuid DEFAULT NULL)` (added by migration
 * 0341, CORRECTED by migration 0347). For every org it computes:
 *   balance == purchased + monthly_allocation
 *              + net(org_credit_allocations)            -- parent→child sub-org transfers
 *              + SUM(org_credit_deductions.amount)      -- append-only signed ledger
 * and returns one row per org with `diverged = true` on any mismatch. It is
 * service_role EXECUTE only, STABLE SECURITY DEFINER — a pure read.
 *
 * Why 0347 was needed: the original 0341 body compared `balance` against a
 * `p_initial_grant` scalar (SQL DEFAULT 0). But credit GRANTS are NOT in the
 * deduction ledger — they live in the `org_credits` columns (purchased,
 * monthly_allocation) plus net parent→child allocations. With p_initial_grant=0
 * every funded org false-flagged a "violation" on the first tick. 0347 drops the
 * scalar arg and sources the grant from the real columns. The `granted` column
 * on each row surfaces that grant total.
 *
 * This module is the NET-NEW piece: the daily CALLER that fires that function
 * over ALL orgs (p_org_id = NULL), collects the rows `WHERE diverged = true`,
 * emits a structured conservation report, and ALERTS on any drift (Sentry) so
 * the gate #11 SLO/alerting surface has a signal. The parent failure mode this
 * guards against is exactly: "the caller never gets wired / drift goes
 * unobserved."
 *
 * Idempotent / safe to re-run
 * ---------------------------
 * This is read-only reconciliation — it issues a single RPC read and writes
 * NOTHING. A missed tick or a retried tick cannot corrupt anything; two ticks
 * just produce two identical reads. There is no cooldown/state table to keep
 * consistent.
 *
 * PII (§1.1 / §1.4)
 * -----------------
 * Raw credit amounts are PII. We log + alert on `org_id` + a COARSE divergence
 * BUCKET only — never the raw `balance` / `granted` / `ledger_sum` / `expected`
 * / `divergence` numbers. The bucket matters because when `expected == 0` (a
 * funded org whose grant total is zero), `divergence == balance`, so even the
 * raw divergence value would leak the org's exact balance (C2). The bucket
 * ('0' | '±1-9' | '±10-99' | '±100-999' | '±1000+') preserves the alert signal
 * (is there drift, roughly how big, which direction) without echoing any exact
 * credit amount. The Sentry beforeSend scrubber still runs, but the alert
 * context is built bucket-only by construction so nothing sensitive is ever
 * handed to it.
 *
 * Shape mirrors `stuck-anchor-monitor.ts`: a pure, side-effect-free decision
 * function (`decideCreditConservationAlert`) plus a `runCreditConservationReconciler(db)`
 * cron glue. Service-role DB access only (the function is service_role EXECUTE).
 */

import { logger } from '../utils/logger.js';
import { callRpc } from '../utils/rpc.js';
import { captureCreditConservationAlert } from '../utils/sentry.js';

/** Name of the prod SQL function (live via migration 0341). */
export const CREDIT_LEDGER_DIVERGENCE_RPC = 'org_credit_ledger_divergence' as const;

export type AlertSeverity = 'info' | 'warning' | 'error';

/**
 * Coarse PII-safe divergence bucket: sign + magnitude order. Never echoes a raw
 * credit amount. '0' has no sign; every other band carries '+' or '-'.
 */
export type DivergenceBucket =
  | '0'
  | '+1-9' | '+10-99' | '+100-999' | '+1000+'
  | '-1-9' | '-10-99' | '-100-999' | '-1000+';

/**
 * One row returned by `org_credit_ledger_divergence` (post-0347). Numeric
 * columns are Postgres `integer` / `bigint`; supabase-js returns them as JS
 * numbers (credit counts are bounded well within Number.MAX_SAFE_INTEGER).
 * `granted` = purchased + monthly_allocation + net(org_credit_allocations);
 * `expected` = granted + ledger_sum; `divergence` = balance - expected.
 */
export interface DivergenceRow {
  org_id: string;
  balance: number;
  granted: number;
  ledger_sum: number;
  expected: number;
  divergence: number;
  diverged: boolean;
}

/**
 * PII-safe per-org summary: identity + a COARSE bucket only, never raw amounts.
 * The bucket (not the raw divergence) is carried because when expected==0,
 * divergence==balance — the raw value would leak the org's exact balance.
 */
export interface DivergedOrgSummary {
  org_id: string;
  divergence_bucket: DivergenceBucket;
}

/**
 * Map a raw signed divergence to a coarse PII-safe bucket. Magnitude order
 * (1-9 / 10-99 / 100-999 / 1000+) with the sign preserved; 0 → '0'. This is the
 * ONLY divergence shape allowed into logs / Sentry — raw amounts (which, when
 * expected==0, equal the org balance) never leave the process.
 */
export function bucketDivergence(divergence: number): DivergenceBucket {
  if (divergence === 0) return '0';
  const sign = divergence > 0 ? '+' : '-';
  const mag = Math.abs(divergence);
  let band: '1-9' | '10-99' | '100-999' | '1000+';
  if (mag < 10) band = '1-9';
  else if (mag < 100) band = '10-99';
  else if (mag < 1000) band = '100-999';
  else band = '1000+';
  return `${sign}${band}` as DivergenceBucket;
}

export interface CreditConservationDecision {
  should_fire: boolean;
  severity: AlertSeverity;
  reason: string;
  orgs_checked: number;
  diverged_count: number;
  /** Aggregate-only: {org_id, divergence} per diverged org. No raw balances. */
  diverged_orgs: DivergedOrgSummary[];
}

/**
 * Pure decision function — no I/O. Given the full set of per-org divergence
 * rows, decide whether to page. `should_fire` is true iff at least one org
 * diverged. The returned `diverged_orgs` carries identity + a coarse bucket only
 * so downstream logging/alerting cannot leak raw credit amounts.
 */
export function decideCreditConservationAlert(
  rows: DivergenceRow[],
): CreditConservationDecision {
  const orgsChecked = rows.length;
  const divergedOrgs: DivergedOrgSummary[] = rows
    .filter((r) => r.diverged === true)
    .map((r) => ({ org_id: r.org_id, divergence_bucket: bucketDivergence(r.divergence) }));
  const divergedCount = divergedOrgs.length;

  if (divergedCount === 0) {
    return {
      should_fire: false,
      severity: 'info',
      reason: `Credit conservation holds across ${orgsChecked} org(s)`,
      orgs_checked: orgsChecked,
      diverged_count: 0,
      diverged_orgs: [],
    };
  }

  return {
    should_fire: true,
    severity: 'error',
    reason:
      `Credit conservation VIOLATED: ${divergedCount} of ${orgsChecked} org(s) `
      + 'diverge from balance == granted (purchased + monthly_allocation + '
      + 'net_allocations) + SUM(ledger.amount) '
      + '(credit-ledger integrity is launch-critical)',
    orgs_checked: orgsChecked,
    diverged_count: divergedCount,
    diverged_orgs: divergedOrgs,
  };
}

// ─── Cron entry point ───

export interface CreditConservationResult {
  /** false when a divergence was detected OR the probe itself failed. */
  healthy: boolean;
  /** true only when the divergence Sentry alert actually fired. */
  alertFired: boolean;
  /** Number of orgs that diverged; null when the probe failed (unknown). */
  divergedCount: number | null;
  /** Total orgs evaluated; null when the probe failed. */
  orgsChecked: number | null;
  /** Probe-failure message; null on a successful read (diverged or not). */
  error: string | null;
  checkedAt: string;
}

// Supabase client — typed interface impractical due to deeply generic
// SupabaseClient types. Mirrors stuck-anchor-monitor.ts. We only ever call it
// through `callRpc`, which is the single service-role read path.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseDb = any;

/**
 * Build the PII-safe Sentry alert context. Identity + coarse bucket only.
 * Per-org rows are capped so a pathological all-orgs divergence can't produce
 * an unboundedly large event payload; the aggregate count is always exact.
 */
const MAX_ALERT_ORG_ROWS = 50;

function emitCreditConservationAlert(decision: CreditConservationDecision): void {
  try {
    captureCreditConservationAlert(
      decision.reason,
      {
        source: 'credit-conservation-reconciler',
        story: 'S1-9',
        orgs_checked: decision.orgs_checked,
        diverged_count: decision.diverged_count,
        // Aggregate-only per-org context: {org_id, divergence_bucket}. Capped.
        diverged_orgs: decision.diverged_orgs.slice(0, MAX_ALERT_ORG_ROWS),
        diverged_orgs_truncated: decision.diverged_orgs.length > MAX_ALERT_ORG_ROWS,
      },
      decision.severity === 'error' ? 'error' : 'warning',
    );
  } catch (err) {
    logger.error(
      { error: err },
      'Credit conservation reconciler: failed to emit Sentry alert',
    );
  }
}

/**
 * End-to-end cron entry point. Fires `org_credit_ledger_divergence` over all
 * orgs (p_org_id = NULL → SQL DEFAULT), filters to diverged rows, builds the
 * conservation report, and on any drift logs at error level + fires a Sentry
 * alert carrying org_id + a coarse divergence bucket only.
 *
 * Returns a structured result instead of throwing. A probe failure reports
 * `healthy: false` with `divergedCount: null` so a broken read can NEVER
 * masquerade as a clean conservation report (and the HTTP cron route can
 * decide whether Cloud Scheduler should retry).
 */
export async function runCreditConservationReconciler(
  db: SupabaseDb,
  overrides: { now?: Date } = {},
): Promise<CreditConservationResult> {
  const now = overrides.now ?? new Date();
  const checkedAt = now.toISOString();

  let data: unknown;
  let error: { message: string; code?: string } | null;
  try {
    // All-orgs sweep: arg-less call so p_org_id keeps its SQL DEFAULT NULL.
    // Post-0347 the function is (uuid DEFAULT NULL) — there is no p_initial_grant
    // arg to pass (its presence was the bug: it false-flagged every funded org).
    const res = await callRpc<DivergenceRow[]>(db, CREDIT_LEDGER_DIVERGENCE_RPC);
    data = res.data;
    error = res.error;
  } catch (err) {
    // callRpc itself already shields against most throws, but keep a belt here.
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { error: err },
      'Credit conservation reconciler: RPC threw',
    );
    return {
      healthy: false,
      alertFired: false,
      divergedCount: null,
      orgsChecked: null,
      error: message,
      checkedAt,
    };
  }

  if (error) {
    logger.error(
      { error },
      'Credit conservation reconciler: org_credit_ledger_divergence failed',
    );
    return {
      healthy: false,
      alertFired: false,
      divergedCount: null,
      orgsChecked: null,
      error: error.message,
      checkedAt,
    };
  }

  if (!Array.isArray(data)) {
    const message = `org_credit_ledger_divergence returned a non-array payload (type ${typeof data})`;
    logger.error({ payloadType: typeof data }, `Credit conservation reconciler: ${message}`);
    return {
      healthy: false,
      alertFired: false,
      divergedCount: null,
      orgsChecked: null,
      error: message,
      checkedAt,
    };
  }

  const decision = decideCreditConservationAlert(data as DivergenceRow[]);

  const result: CreditConservationResult = {
    healthy: !decision.should_fire,
    alertFired: false,
    divergedCount: decision.diverged_count,
    orgsChecked: decision.orgs_checked,
    error: null,
    checkedAt,
  };

  if (decision.should_fire) {
    // PII-safe: org_id + coarse bucket only, never raw balances/divergence.
    logger.error(
      {
        orgsChecked: decision.orgs_checked,
        divergedCount: decision.diverged_count,
        divergedOrgs: decision.diverged_orgs.slice(0, MAX_ALERT_ORG_ROWS),
      },
      `Credit conservation reconciler: ${decision.reason}`,
    );
    emitCreditConservationAlert(decision);
    result.alertFired = true;
  } else {
    logger.info(
      { orgsChecked: decision.orgs_checked },
      'Credit conservation reconciler: conservation holds — no drift',
    );
  }

  return result;
}
