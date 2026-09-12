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

/** Fallback monthly allocation for an auto-provisioned `ai_credits` period
 * row when `AI_CREDITS_MONTHLY_ALLOCATION` is unset or invalid. */
const DEFAULT_AI_CREDITS_MONTHLY_ALLOCATION = 100;

/**
 * Resolve the monthly AI credit allocation to use when auto-provisioning a
 * new `ai_credits` period row, from the `AI_CREDITS_MONTHLY_ALLOCATION` env
 * var. Falls back to `DEFAULT_AI_CREDITS_MONTHLY_ALLOCATION` for anything
 * that isn't a positive integer (unset, blank, non-numeric, zero, negative,
 * fractional, `NaN`/`Infinity`) so a bad env value can never provision a
 * broken or zero-credit period.
 */
export function resolveAICreditsMonthlyAllocation(): number {
  const raw = process.env.AI_CREDITS_MONTHLY_ALLOCATION;
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_AI_CREDITS_MONTHLY_ALLOCATION;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    logger.warn(
      { raw },
      'Invalid AI_CREDITS_MONTHLY_ALLOCATION — falling back to default of ' +
        `${DEFAULT_AI_CREDITS_MONTHLY_ALLOCATION}`,
    );
    return DEFAULT_AI_CREDITS_MONTHLY_ALLOCATION;
  }

  return parsed;
}

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
 * upsert. The lookup mirrors `deduct_ai_credits`'s own window
 * (`period_start <= now < period_end`) rather than an exact match on a
 * calendar-aligned `period_start`, because `deduct_ai_credits`'s UPDATE has
 * no row limit — inserting a second, overlapping-period row for the same org
 * would make a future deduction silently double-increment two rows at once.
 * A race against a concurrent insert (another request provisioning the same
 * org at the same moment) is therefore treated as a non-fatal, logged
 * condition rather than an error: whichever row lands first is the one every
 * caller converges on, and the caller's own `deduct_ai_credits` call is the
 * actual source of truth for whether the operation may proceed.
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

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: existing, error: selectError } = await (db as any)
      .from('ai_credits')
      .select('id')
      .eq('org_id', orgId)
      .lte('period_start', nowIso)
      .gt('period_end', nowIso)
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
    const { error: insertError } = await (db as any).from('ai_credits').insert({
      org_id: orgId,
      monthly_allocation: resolveAICreditsMonthlyAllocation(),
      used_this_month: 0,
      period_start: periodStart.toISOString(),
      period_end: periodEnd.toISOString(),
    });

    if (insertError) {
      // No unique constraint exists to race against, so this is never a
      // Postgres duplicate-key error — but a concurrent request may have
      // inserted its own covering row between our select and insert, or the
      // insert may have failed for an unrelated transient reason. Either way
      // this is non-fatal: the caller's own deduct_ai_credits call is the
      // real gate, and will simply retry the same fail-closed path it always
      // has if no row is actually present.
      logger.warn(
        { error: insertError, orgId },
        'ensureAICreditsPeriod: insert failed (treated as non-fatal)',
      );
      return false;
    }

    return true;
  } catch (err) {
    logger.warn({ error: err, orgId }, 'ensureAICreditsPeriod: unexpected error');
    return false;
  }
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
