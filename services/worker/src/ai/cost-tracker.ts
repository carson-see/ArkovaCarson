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

/**
 * Upper bound on a single refund, enforced here AND in
 * `public.refund_ai_credits` (migration 0483).
 *
 * It is the same 1000 the reconcile job's Zod schema has always enforced on
 * this operation (`MAX_RECONCILABLE_AMOUNT` in `jobs/ai-credit-reconcile.ts`),
 * for the same reason: every real caller refunds exactly 1 (one row's credit),
 * so anything near this ceiling is already a bug, and the bound exists so a
 * corrupted caller cannot mint an arbitrary balance. Duplicated rather than
 * imported to keep `cost-tracker.ts` free of a job-module dependency; the two
 * are pinned equal by test.
 */
export const MAX_REFUNDABLE_AMOUNT = 1000;

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
 *
 * FALSE MEANS "NOT CHARGED" — never "charged, probably".
 * Migration 0483 gives `deduct_ai_credits` a function-level
 * `SET lock_timeout='5s'`, matching the `ensure_ai_credits_period` sibling 0467
 * already hardened. Its `SELECT … FOR UPDATE` on the org's credit row therefore
 * aborts with SQLSTATE `55P03` (`lock_not_available`) behind a stuck holder
 * instead of blocking until `statement_timeout`. Either way the transaction
 * rolls back and NO debit is recorded, so this returns `false` and every caller
 * must treat that as "do not perform (or do not keep) the paid work".
 *
 * The SQLSTATE is logged because `55P03` ("someone is sitting on this org's
 * credit row") and a generic connection failure need different operator
 * responses and were previously indistinguishable in the log stream.
 */
export async function deductAICredits(
  orgId?: string,
  userId?: string,
  amount: number = 1,
): Promise<boolean> {
  // A NEGATIVE amount used to be how this codebase issued a refund. Migration
  // 0467 closed `deduct_ai_credits` to non-positive amounts — correctly: a
  // negative debit is an unbounded credit grant — but nothing told the three
  // refund call sites, so from 2026-09-19 every refund returned false and
  // refunded nothing while looking like an ordinary failure. Refunds now go
  // through `refundAICredits`. Rejecting it here, before the RPC, means the
  // mistake produces a loud log line instead of silently reappearing behind an
  // RPC that answers `false` for both reasons.
  if (!Number.isInteger(amount) || amount <= 0) {
    logger.error(
      { orgId, userId, amount },
      'deductAICredits called with a non-positive amount — refusing; use refundAICredits to return credit',
    );
    return false;
  }

  try {
    const { data, error } = await callRpc<boolean>(db, 'deduct_ai_credits', {
      p_org_id: orgId ?? null,
      p_user_id: userId ?? null,
      p_amount: amount,
    });

    if (error) {
      logger.error(
        {
          error,
          code: (error as { code?: string }).code,
          orgId,
          userId,
          amount,
        },
        'Failed to deduct AI credits',
      );
      return false;
    }

    return data === true;
  } catch (err) {
    logger.error(
      { error: err, code: (err as { code?: string })?.code, orgId, userId, amount },
      'Failed to deduct AI credits',
    );
    return false;
  }
}

/**
 * Return AI credits to an org/user after work that was charged for did not
 * happen (a failed or timed-out extraction), via `public.refund_ai_credits`
 * (migration 0483).
 *
 * This is the other half of the AI-credit refund regression from 0467. The
 * three refund sites — `api/v1/ai-extract.ts`, `api/v1/ai-extract-batch.ts`
 * and `jobs/ai-credit-reconcile.ts` — all called
 * `deductAICredits(org, user, -amount)`, and 0467's new
 * `p_amount <= 0 -> RETURN false` guard turned every one of them into a silent
 * no-op. `deduct_ai_credits` deliberately stays closed to negative amounts;
 * returning credit is a separate, separately-bounded operation.
 *
 * Returns true only when a row was actually credited. False means NOTHING was
 * refunded — the org is still overcharged — and every caller must log that at
 * `error` level with the org/user ids and, where it has one, fall back to the
 * `ai_credits.reconcile_refund` queue. It must never be turned into a 5xx for
 * the end user: a failed refund is an ops problem, not a request failure.
 *
 * The RPC floors `used_this_month` at zero, so a refund can never mint credit
 * beyond what the period actually consumed.
 */
export async function refundAICredits(
  orgId?: string,
  userId?: string,
  amount: number = 1,
): Promise<boolean> {
  if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_REFUNDABLE_AMOUNT) {
    logger.error(
      { orgId, userId, amount, max: MAX_REFUNDABLE_AMOUNT },
      'refundAICredits called with an out-of-range amount — refusing to move credit',
    );
    return false;
  }
  if (!orgId && !userId) {
    logger.error(
      { orgId, userId, amount },
      'refundAICredits called with neither org nor user — credit would be unattributable',
    );
    return false;
  }

  try {
    const { data, error } = await callRpc<boolean>(db, 'refund_ai_credits', {
      p_org_id: orgId ?? null,
      p_user_id: userId ?? null,
      p_amount: amount,
    });

    if (error) {
      logger.error(
        { error, code: (error as { code?: string }).code, orgId, userId, amount },
        'Failed to refund AI credits',
      );
      return false;
    }

    return data === true;
  } catch (err) {
    logger.error(
      { error: err, code: (err as { code?: string })?.code, orgId, userId, amount },
      'Failed to refund AI credits',
    );
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
 * Migration 0467 owns the concurrency boundary: an advisory transaction lock
 * serializes first-period provisioning and exclusion constraints reject any
 * overlapping org or user period. The debit RPC locks and updates one
 * deterministic row, so legacy duplicates fail closed instead of multiplying
 * a charge across every overlapping row.
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
  if (!orgId) return false;
  try {
    const { data, error } = await callRpc<boolean>(db, 'ensure_ai_credits_period', {
      p_org_id: orgId,
      p_monthly_allocation: config.aiCreditsMonthlyAllocation,
      p_now: now.toISOString(),
    });
    if (error) {
      logger.warn({ error, orgId }, 'ensureAICreditsPeriod: atomic RPC failed');
      return false;
    }
    return data === true;
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
