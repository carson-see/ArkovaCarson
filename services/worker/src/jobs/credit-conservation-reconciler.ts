/**
 * Money-conservation reconciler — daily-sweep CALLER (S1-9, parent SCRUM-2349 /
 * PM-25).
 *
 * What this is (and is NOT)
 * -------------------------
 * The reconciler LOGIC already lives in prod as the SQL function
 * `org_credit_ledger_divergence(p_org_id uuid DEFAULT NULL,
 *  p_initial_grant integer DEFAULT 0)` (applied via migration 0341). For every
 * org it computes:
 *   balance == p_initial_grant + SUM(org_credit_deductions.amount)
 * (the ledger is append-only with signed amounts: DEBIT < 0, REFUND > 0) and
 * returns one row per org with `diverged = true` on any mismatch. It is
 * service_role EXECUTE only, STABLE SECURITY DEFINER — a pure read.
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
 * Raw credit amounts are PII. We log + alert on `org_id` + the divergence
 * MAGNITUDE only — never the raw `balance` / `ledger_sum` / `expected` values.
 * The divergence magnitude is the alert signal; the absolute balances are not.
 * The Sentry beforeSend scrubber still runs, but the alert context is built
 * aggregate-only by construction so nothing sensitive is ever handed to it.
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
 * One row returned by `org_credit_ledger_divergence`. Numeric columns are
 * Postgres `integer` / `bigint`; supabase-js returns them as JS numbers (the
 * ledger is bounded well within Number.MAX_SAFE_INTEGER for credit counts).
 */
export interface DivergenceRow {
  org_id: string;
  balance: number;
  ledger_sum: number;
  expected: number;
  divergence: number;
  diverged: boolean;
}

/** PII-safe per-org summary: identity + magnitude only, never raw balances. */
export interface DivergedOrgSummary {
  org_id: string;
  divergence: number;
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
 * diverged. The returned `diverged_orgs` carries identity + magnitude only so
 * downstream logging/alerting cannot leak raw credit amounts.
 */
export function decideCreditConservationAlert(
  rows: DivergenceRow[],
): CreditConservationDecision {
  const orgsChecked = rows.length;
  const divergedOrgs: DivergedOrgSummary[] = rows
    .filter((r) => r.diverged === true)
    .map((r) => ({ org_id: r.org_id, divergence: r.divergence }));
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
      + 'diverge from balance == initial_grant + SUM(ledger.amount) '
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
 * Build the PII-safe Sentry alert context. Identity + magnitude only.
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
        // Aggregate-only per-org context: {org_id, divergence}. Capped.
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
 * alert carrying org_id + divergence magnitude only.
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
    // All-orgs sweep: pass no org filter so p_org_id keeps its SQL DEFAULT
    // NULL. p_initial_grant also defaults (0) in the function definition.
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
    // PII-safe: org_id + magnitude only, never raw balances.
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
