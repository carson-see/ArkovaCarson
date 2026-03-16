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
    // New RPCs not yet in generated types — use any bypass
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db.rpc as any)('check_ai_credits', {
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db.rpc as any)('deduct_ai_credits', {
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
    });

    if (error) {
      logger.warn({ error }, 'Failed to log AI usage event');
    }
  } catch (err) {
    logger.warn({ error: err }, 'Failed to log AI usage event');
  }
}
