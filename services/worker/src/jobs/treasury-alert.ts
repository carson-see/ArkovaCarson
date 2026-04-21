/**
 * Treasury Low-Balance Alerting (ARK-103 — SCRUM-1013)
 *
 * Runs on a 5-minute cron. Reads the cached treasury balance + BTC/USD
 * price, converts to USD, and fires a Slack + email alert when the
 * balance drops below `TREASURY_LOW_BALANCE_USD` (default 50).
 *
 * De-duplication: re-fires only when the threshold is freshly crossed
 * OR once per hour while sub-threshold (so on-call gets reminded, but
 * the channel isn't spammed every 5 minutes).
 *
 * Fail-closed: if the BTC/USD oracle is unavailable, emit an alert with
 * "price unknown" rather than silently passing — an unknown price could
 * be masking a genuine low-balance condition.
 *
 * Gated by `ENABLE_TREASURY_ALERTS` (default true).
 */

import { logger } from '../utils/logger.js';
import { db } from '../utils/db.js';

export const DEFAULT_THRESHOLD_USD = 50;
export const RE_FIRE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const SATS_PER_BTC = 100_000_000;

export interface TreasuryAlertInput {
  balance_confirmed_sats: number | null;
  btc_price_usd: number | null;
  threshold_usd?: number;
  /** Previous alert timestamp (null = never fired) */
  last_alert_at?: string | null;
  /** Previous alert was below-threshold (so we track crossings) */
  last_alert_below_threshold?: boolean;
  /** Current time override — lets tests advance the clock */
  now?: Date;
}

export interface TreasuryAlertDecision {
  should_fire: boolean;
  reason: string;
  balance_usd: number | null;
  below_threshold: boolean;
  /** null when below_threshold is false or price unknown */
  price_unknown: boolean;
}

/**
 * Pure decision function — no I/O. Easily testable, deterministic, clock-
 * injectable. The worker glue code in `runTreasuryAlertCheck` wraps this
 * with DB reads/writes and Slack/email dispatch.
 */
export function decideTreasuryAlert(input: TreasuryAlertInput): TreasuryAlertDecision {
  const threshold = input.threshold_usd ?? DEFAULT_THRESHOLD_USD;
  const now = input.now ?? new Date();

  // Oracle outage: no BTC/USD price → fail closed. Always alert with
  // "price unknown" unless we already alerted in the last window.
  if (input.btc_price_usd == null || input.balance_confirmed_sats == null) {
    const lastAlertAgo = input.last_alert_at
      ? now.getTime() - new Date(input.last_alert_at).getTime()
      : Infinity;
    return {
      should_fire: lastAlertAgo > RE_FIRE_WINDOW_MS,
      reason: 'Price or balance oracle unavailable',
      balance_usd: null,
      below_threshold: true, // fail closed
      price_unknown: true,
    };
  }

  const balanceUsd =
    (input.balance_confirmed_sats / SATS_PER_BTC) * input.btc_price_usd;
  const belowThreshold = balanceUsd < threshold;

  if (!belowThreshold) {
    return {
      should_fire: false,
      reason: 'Balance above threshold',
      balance_usd: balanceUsd,
      below_threshold: false,
      price_unknown: false,
    };
  }

  // Fire if the last alert was NOT below-threshold (either never alerted,
  // or the previous alert was a recovery / oracle-clear event).
  if (!input.last_alert_below_threshold) {
    return {
      should_fire: true,
      reason: 'Freshly crossed below threshold',
      balance_usd: balanceUsd,
      below_threshold: true,
      price_unknown: false,
    };
  }

  // 2. We last alerted below-threshold, but > 1 hour ago.
  const lastAlertAgo =
    now.getTime() - new Date(input.last_alert_at as string).getTime();
  if (lastAlertAgo > RE_FIRE_WINDOW_MS) {
    return {
      should_fire: true,
      reason: 'Hourly re-fire while below threshold',
      balance_usd: balanceUsd,
      below_threshold: true,
      price_unknown: false,
    };
  }

  return {
    should_fire: false,
    reason: 'Alert suppressed — recent re-fire within 1h',
    balance_usd: balanceUsd,
    below_threshold: true,
    price_unknown: false,
  };
}

/**
 * Format the Slack alert payload. Kept pure for testing.
 */
export function buildSlackAlertPayload(decision: TreasuryAlertDecision): {
  text: string;
  // Block Kit for rich rendering when the webhook supports it.
  blocks: Array<{ type: string; text?: { type: string; text: string } }>;
} {
  const balance =
    decision.balance_usd != null
      ? `$${decision.balance_usd.toFixed(2)}`
      : 'unknown';
  const header = decision.price_unknown
    ? ':warning: Arkova treasury — BTC/USD oracle unavailable'
    : `:rotating_light: Arkova treasury LOW — ${balance} USD`;

  return {
    text: header,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${header}*` } },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Reason: ${decision.reason}. Fast-track anchors are now blocked until the treasury is topped up. See docs/runbooks/treasury-low-balance.md.`,
        },
      },
    ],
  };
}

/**
 * End-to-end cron entry point. Reads the latest treasury_cache row +
 * the last alert record, runs the decision function, dispatches Slack
 * + email if `should_fire`, and records the alert.
 *
 * Designed so the unit tests stub the dispatcher — no network calls.
 */
export interface TreasuryAlertDispatcher {
  sendSlack(payload: ReturnType<typeof buildSlackAlertPayload>): Promise<void>;
  sendEmail(subject: string, body: string): Promise<void>;
}

export async function runTreasuryAlertCheck(
  dispatcher: TreasuryAlertDispatcher,
  overrides: {
    thresholdUsd?: number;
    now?: Date;
    enabled?: boolean;
  } = {},
): Promise<TreasuryAlertDecision> {
  const enabled =
    overrides.enabled ??
    (process.env.ENABLE_TREASURY_ALERTS !== 'false'); // default true

  const NOOP: TreasuryAlertDecision = {
    should_fire: false,
    reason: 'Alerts disabled via flag',
    balance_usd: null,
    below_threshold: false,
    price_unknown: false,
  };

  if (!enabled) {
    logger.info('Treasury alerts disabled — skipping check');
    return NOOP;
  }

  // Parallel reads: cached treasury snapshot + dedup state.
  const [cacheResult, alertStateResult] = await Promise.all([
    db
      .from('treasury_cache')
      .select('balance_confirmed_sats, btc_price_usd, updated_at')
      .limit(1)
      .maybeSingle(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any)
      .from('treasury_alert_state')
      .select('below_threshold, updated_at')
      .eq('key', 'low_balance')
      .maybeSingle(),
  ]);

  const { data: cache, error: cacheErr } = cacheResult;
  if (cacheErr) {
    logger.error({ error: cacheErr }, 'Treasury alert: failed to read cache');
  }

  const lastAlert = alertStateResult.data as
    | { below_threshold: boolean; updated_at: string }
    | null;

  const decision = decideTreasuryAlert({
    balance_confirmed_sats: cache?.balance_confirmed_sats ?? null,
    btc_price_usd: cache?.btc_price_usd ?? null,
    threshold_usd: overrides.thresholdUsd ?? DEFAULT_THRESHOLD_USD,
    last_alert_at: lastAlert?.updated_at ?? null,
    last_alert_below_threshold: lastAlert?.below_threshold ?? false,
    now: overrides.now,
  });

  if (!decision.should_fire) {
    return decision;
  }

  // Dispatch.
  const slackPayload = buildSlackAlertPayload(decision);
  try {
    await dispatcher.sendSlack(slackPayload);
  } catch (err) {
    logger.error({ error: err }, 'Treasury alert: Slack dispatch failed');
  }

  try {
    await dispatcher.sendEmail(
      slackPayload.text,
      `${slackPayload.text}\n\nReason: ${decision.reason}`,
    );
  } catch (err) {
    logger.error({ error: err }, 'Treasury alert: email dispatch failed');
  }

  // Record the alert so the re-fire dedup works next run. Failing to persist
  // this leaves stale state → next tick may re-fire (spam) or fail to re-fire
  // after the hourly window expires. Log loudly so ops can investigate; still
  // return the decision so the cron sees the alert fired.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: stateErr } = await (db as any)
    .from('treasury_alert_state')
    .upsert(
      {
        key: 'low_balance',
        below_threshold: decision.below_threshold,
        last_balance_usd: decision.balance_usd,
        last_reason: decision.reason,
        updated_at: (overrides.now ?? new Date()).toISOString(),
      },
      { onConflict: 'key' },
    );
  if (stateErr) {
    logger.error(
      { error: stateErr },
      'Treasury alert: failed to persist dedup state — next tick may re-alert',
    );
  }

  return decision;
}
