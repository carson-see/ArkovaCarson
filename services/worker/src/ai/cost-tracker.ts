/**
 * AI Cost Tracker (P8-S2)
 *
 * Tracks AI credit usage per org/user. Checks credit balance before
 * allowing AI operations and logs usage events for billing.
 *
 * Credit tiers:
 *   Free:       50 credits/month
 *   Pro:        500 credits/month
 *   Enterprise: 5000 credits/month
 *
 * Each extraction = 1 credit, each embedding = 1 credit.
 */

import { config } from '../config.js';
import { db } from '../utils/db.js';
import { callRpc } from '../utils/rpc.js';
import { logger } from '../utils/logger.js';

export interface CreditBalance {
  monthlyAllocation: number;
  usedThisMonth: number;
  remaining: number;
  hasCredits: boolean;
}

export interface UsageEvent {
  orgId?: string;
  userId?: string;
  eventType: 'extraction' | 'embedding' | 'fraud_check';
  provider: string;
  tokensUsed?: number;
  creditsConsumed?: number;
  fingerprint?: string;
  confidence?: number;
  durationMs?: number;
  success: boolean;
  errorMessage?: string;
  /** SHA-256 hash prefix (12 chars) of the extraction prompt used */
  promptVersion?: string;
  /** EFF-1: Cached extraction result fields for fingerprint-based caching */
  resultJson?: Record<string, unknown>;
}

/** Default credit allocations per billing tier */
export const CREDIT_ALLOCATIONS = {
  free: 50,
  individual: 500,
  professional: 500,
  enterprise: 5000,
} as const;

/**
 * Check AI credit balance for an org or user.
 * Returns null if no credit record exists.
 */
export async function checkAICredits(
  orgId?: string,
  userId?: string,
): Promise<CreditBalance | null> {
  try {
    const { data, error } = await callRpc(db, 'check_ai_credits', {
      p_org_id: orgId ?? null,
      p_user_id: userId ?? null,
    });

    if (error || !data || (Array.isArray(data) && data.length === 0)) {
      return null;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row: any = Array.isArray(data) ? data[0] : data;
    return {
      monthlyAllocation: row.monthly_allocation,
      usedThisMonth: row.used_this_month,
      remaining: row.remaining,
      hasCredits: row.has_credits,
    };
  } catch (err) {
    logger.error({ error: err }, 'Failed to check AI credits');
    return null;
  }
}

/**
 * Deduct AI credits after a successful operation.
 * Returns true if deduction succeeded, false if insufficient credits.
 */
export async function deductAICredits(
  orgId?: string,
  userId?: string,
  amount: number = 1,
): Promise<boolean> {
  try {
    const { data, error } = await callRpc<boolean>(db, 'deduct_ai_credits', {
      p_org_id: orgId ?? null,
      p_user_id: userId ?? null,
      p_amount: amount,
    });

    if (error) {
      logger.error({ error }, 'Failed to deduct AI credits');
      return false;
    }

    return data === true;
  } catch (err) {
    logger.error({ error: err }, 'Failed to deduct AI credits');
    return false;
  }
}

/**
 * Ensure an `ai_credits` row covering `now`'s UTC calendar month exists for
 * the given org (SCRUM-4939).
 *
 * Since PR #2442, `deduct_ai_credits` / `check_ai_credits` fail CLOSED when
 * no `ai_credits` row covers the current period — correct in isolation, but
 * nothing ever provisioned that row (no trigger, cron, or code path), so
 * every org without a manually-seeded row got a hard 503 on its very first
 * extraction. This makes the provisioning implicit and idempotent instead of
 * requiring an operator to seed rows by hand.
 *
 * `ai_credits` has NO unique constraint on `(org_id, period_start)` (see
 * `supabase/migrations/00000000000000_baseline_at_main_HEAD.sql` — only a
 * primary key on `id`), so this is a select-then-insert rather than an
 * upsert, and the insert cannot be made atomic with `ON CONFLICT`. Adding
 * that constraint is DDL on a table read by every extraction, which is a
 * migration (and a T3 PR) in its own right — so the TOCTOU window is closed
 * in application code instead, by a **re-read after insert**: if a concurrent
 * request provisioned the same org in the same instant, both requests observe
 * the duplicate, agree on a keeper (lowest `(created_at, id)` — the row that
 * existed first, and therefore the row with the >= usage count), and the
 * loser deletes **only the row it just inserted**. A pre-existing row can
 * never be deleted by this path.
 *
 * Leaving the duplicate in place is what makes this worth closing:
 * `deduct_ai_credits`'s `UPDATE` has no row limit, so two overlapping-period
 * rows for one org make every subsequent deduction increment both — the org
 * silently burns credits at 2x for the rest of the month.
 *
 * The lookup mirrors `deduct_ai_credits`'s own window
 * (`period_start <= now < period_end`) rather than an exact match on a
 * calendar-aligned `period_start`, so an operator-seeded row with
 * non-calendar bounds is still recognised and never duplicated.
 *
 * Never overwrites `used_this_month` on an existing row.
 *
 * @returns true if a row is confirmed present for the current period after
 *   this call, false on any lookup/insert failure (logged, never thrown).
 */
export async function ensureAICreditsPeriod(
  orgId: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (!orgId) {
    return false;
  }

  const periodStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
  );
  const periodEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0),
  );
  const nowIso = now.toISOString();

  // Rows covering `now` for this org, oldest first. `(created_at, id)` is a
  // total order every racer computes identically, so exactly one of them is
  // the keeper.
  const coveringRows = () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any)
      .from('ai_credits')
      .select('id')
      .eq('org_id', orgId)
      .lte('period_start', nowIso)
      .gt('period_end', nowIso)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });

  try {
    // `.limit(1)` so a pre-existing duplicate (seeded before this code shipped)
    // is a no-op rather than a maybeSingle() "multiple rows" error.
    const { data: existing, error: selectError } = await coveringRows()
      .limit(1)
      .maybeSingle();

    if (selectError) {
      logger.warn(
        { error: selectError, orgId },
        'ensureAICreditsPeriod: period lookup failed',
      );
      return false;
    }

    if (existing) {
      // A row already covers `now` for this org — leave used_this_month untouched.
      return true;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: inserted, error: insertError } = await (db as any)
      .from('ai_credits')
      .insert({
        org_id: orgId,
        monthly_allocation: config.aiCreditsMonthlyAllocation,
        used_this_month: 0,
        period_start: periodStart.toISOString(),
        period_end: periodEnd.toISOString(),
      })
      .select('id')
      .maybeSingle();

    if (insertError) {
      // Non-fatal: the caller's own deduct_ai_credits / check_ai_credits call
      // is the real gate and still fails closed if no row is actually present.
      logger.warn(
        { error: insertError, orgId },
        'ensureAICreditsPeriod: insert failed (treated as non-fatal)',
      );
      return false;
    }

    await reconcileConcurrentPeriodInsert(orgId, inserted?.id, coveringRows);

    return true;
  } catch (err) {
    logger.warn({ error: err, orgId }, 'ensureAICreditsPeriod: unexpected error');
    return false;
  }
}

/**
 * TOCTOU compensation for {@link ensureAICreditsPeriod} (SCRUM-4939).
 *
 * Re-reads the covering rows after our insert. If a concurrent request raced
 * us and there is now more than one row for this org/period, the row that
 * existed first wins and we delete **the row we just inserted** — never any
 * other row, and only when we are not the keeper, so at most one racer ever
 * deletes and at least one row always survives. Best-effort: a failure here
 * leaves a duplicate for operator reconciliation and is logged at error level.
 */
async function reconcileConcurrentPeriodInsert(
  orgId: string,
  insertedId: string | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  coveringRows: () => any,
): Promise<void> {
  if (!insertedId) {
    // PostgREST returned no representation (e.g. `Prefer: return=minimal`);
    // without our own row id we cannot safely delete anything.
    return;
  }

  const { data: after, error: afterError } = await coveringRows();
  if (afterError || !Array.isArray(after) || after.length <= 1) {
    return;
  }

  if (after[0]?.id === insertedId) {
    // We are the keeper; the racer removes its own row.
    logger.warn(
      { orgId, rows: after.length },
      'ensureAICreditsPeriod: concurrent provisioning detected — keeping our row',
    );
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: deleteError } = await (db as any)
    .from('ai_credits')
    .delete()
    .eq('id', insertedId);

  if (deleteError) {
    logger.error(
      { error: deleteError, orgId, insertedId },
      'ensureAICreditsPeriod: could not remove duplicate period row — ' +
        'deductions will double-count for this org until it is reconciled',
    );
    return;
  }

  logger.warn(
    { orgId, insertedId },
    'ensureAICreditsPeriod: lost a concurrent provisioning race — removed our duplicate row',
  );
}

/**
 * Log an AI usage event (append-only audit trail).
 * Non-blocking — errors are logged but don't fail the operation.
 */
export async function logAIUsageEvent(event: UsageEvent): Promise<void> {
  try {
    // New table not yet in generated types — use any bypass
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (db as any).from('ai_usage_events').insert({
      org_id: event.orgId ?? null,
      user_id: event.userId ?? null,
      event_type: event.eventType,
      provider: event.provider,
      tokens_used: event.tokensUsed ?? 0,
      credits_consumed: event.creditsConsumed ?? 1,
      fingerprint: event.fingerprint ?? null,
      confidence: event.confidence ?? null,
      duration_ms: event.durationMs ?? null,
      success: event.success,
      error_message: event.errorMessage ?? null,
      prompt_version: event.promptVersion ?? null,
      result_json: event.resultJson ?? null,
    });

    if (error) {
      logger.warn({ error }, 'Failed to log AI usage event');
    }
  } catch (err) {
    logger.warn({ error: err }, 'Failed to log AI usage event');
  }
}
