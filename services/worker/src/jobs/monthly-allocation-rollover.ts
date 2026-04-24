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
    return { total_orgs: 0, rolled: 0, skipped: 0, errors: 1 };
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
        logger.error({ error, orgId }, 'rollover RPC failed');
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
      summary.errors++;
    }
  }

  logger.info(summary, 'monthly-allocation-rollover complete');
  return summary;
}
