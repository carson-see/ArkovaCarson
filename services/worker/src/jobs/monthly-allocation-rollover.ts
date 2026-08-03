/**
 * Monthly allocation rollover job (SCRUM-1164)
 *
 * Runs on first-of-month UTC via Cloud Scheduler. For every org with an
 * open period in `org_monthly_allocation`, calls `roll_over_monthly_allocation`
 * which atomically:
 *   - Closes the current period (sets closed_at).
 *   - Opens the next period with carry-over = max(0, base + rolled - used),
 *     capped at 3x base.
 *
 * Idempotent: calling twice for the same period is a no-op because the
 * RPC's INSERT ... ON CONFLICT (org_id, period_start) DO NOTHING bites.
 *
 * Constitution refs:
 *   - 1.7: Tests exercise the math; the DB path is integration-only.
 *   - 1.9: Controlled by ENABLE_ALLOCATION_ROLLOVER (default true).
 */
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { assertJobPostcondition } from '../utils/jobPostcondition.js';
import { captureCreditRpcFailureAlert } from '../utils/sentry.js';

export const MONTHLY_ALLOCATION_ROLLOVER_CRON = '0 0 1 * *' as const;

export interface RolloverRunSummary {
  total_orgs: number;
  rolled: number;
  skipped: number;
  errors: number;
}

export async function runAllocationRollover(): Promise<RolloverRunSummary> {
  const enabled = process.env.ENABLE_ALLOCATION_ROLLOVER !== 'false';
  if (!enabled) {
    logger.info('monthly-allocation-rollover: disabled via ENABLE_ALLOCATION_ROLLOVER');
    return { total_orgs: 0, rolled: 0, skipped: 0, errors: 0 };
  }

  // Cast until database.types.ts is regenerated post-0252.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dbUntyped = db as any;

  const { data: openPeriods, error: listErr } = await dbUntyped
    .from('org_monthly_allocation')
    .select('org_id')
    .is('closed_at', null);

  if (listErr) {
    logger.error({ listErr }, 'monthly-allocation-rollover: list query failed');
    // SCRUM-3050: previously returned a summary with errors:1 — which the route
    // answered with HTTP 200. A rollover that could not even ENUMERATE the open
    // periods has done nothing; on a monthly cadence that silence would persist
    // until customers noticed missing credits. Throw so the route 500s and the
    // failure lands in the Cloud Scheduler log stream the alert policy watches.
    throw new Error(
      'monthly-allocation-rollover: could not enumerate open allocation periods — no org was rolled over',
    );
  }

  const orgIds = Array.from(new Set((openPeriods ?? []).map((r: { org_id: string }) => r.org_id)));
  const summary: RolloverRunSummary = {
    total_orgs: orgIds.length,
    rolled: 0,
    skipped: 0,
    errors: 0,
  };

  for (const orgId of orgIds) {
    try {
      const { data, error } = await dbUntyped.rpc('roll_over_monthly_allocation', {
        p_org_id: orgId,
      });
      if (error) {
        // No fallback: a failure here means this org's rollover silently does
        // not happen this month — undetectable until next month's tick unless
        // alerted now.
        logger.error({ error, orgId }, 'rollover RPC failed');
        captureCreditRpcFailureAlert({
          rpc: 'roll_over_monthly_allocation',
          operation: 'monthly-allocation-rollover.runAllocationRollover',
          failMode: 'closed',
          error: new Error('roll_over_monthly_allocation RPC failed — org rollover skipped this cycle'),
          orgId: orgId as string,
        });
        summary.errors++;
        continue;
      }
      if (data?.ok) {
        summary.rolled++;
      } else {
        summary.skipped++;
      }
    } catch (err) {
      logger.error({ err: (err as Error).message, orgId }, 'rollover threw');
      captureCreditRpcFailureAlert({
        rpc: 'roll_over_monthly_allocation',
        operation: 'monthly-allocation-rollover.runAllocationRollover.thrown',
        failMode: 'closed',
        error: err,
        orgId: orgId as string,
      });
      summary.errors++;
    }
  }

  logger.info(summary, 'monthly-allocation-rollover complete');

  // SCRUM-3050 postcondition. A "skipped" org is a legitimate no-op (there was
  // no open period to roll), so it counts as completed work; only `errors` are
  // failures. If every org errored, this run produced nothing and MUST NOT
  // report success — it throws, the route 500s, Cloud Scheduler records a
  // failed attempt, and the GCP alert policy pages. Partial failure stays a
  // 200 (retrying would redo the orgs that already rolled) but is logged loudly.
  const verdict = assertJobPostcondition({
    jobName: 'monthly-allocation-rollover',
    attempted: summary.total_orgs,
    succeeded: summary.rolled + summary.skipped,
    failed: summary.errors,
  });
  if (verdict.degraded) {
    logger.warn(
      { ...summary, postcondition: verdict.reason },
      'monthly-allocation-rollover DEGRADED — some orgs did not roll over',
    );
  }

  return summary;
}
