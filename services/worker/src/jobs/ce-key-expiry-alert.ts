/**
 * SCRUM-2902 — Credential Engine (CE) API key expiry alarm (fail-LOUD).
 *
 * The CE partnership API key / CTID publishing credential has a hard expiry
 * (the trial window is an R-1 FATAL launch dependency). If it lapses silently,
 * CTDL publishing and registry verification break with no warning. This alarm
 * fires escalating Sentry events at **T-30 / T-14 / T-7 days** before expiry and
 * continuously **after** expiry, so on-call and the founder are paged while there
 * is still time to renew.
 *
 * ── Fail-LOUD / fail-closed semantics ──────────────────────────────────────
 * The expiry date is operator-supplied via `CE_API_KEY_EXPIRES_AT`. If it is
 * **unset, blank, a known sentinel placeholder, or unparseable**, the alarm does
 * NOT go quiet — it treats that as the worst case and fires an ERROR event on
 * **every run** (window = `SENTINEL`) until a real date is configured. A missing
 * config is indistinguishable from "already lapsed" from the outside, so we fail
 * closed to FIRING. This is the opposite of the common "no date → skip" bug that
 * makes an expiry monitor useless exactly when it matters.
 *
 * ── event ≠ alert ──────────────────────────────────────────────────────────
 * Emitting a Sentry event here is necessary but NOT sufficient to reach a human.
 * A captured event only pages someone if a Sentry **issue alert rule** matches
 * its tags and routes to a human channel. That rule is declared 1:1 in
 * `infra/sentry/alert-rules.json` ("SCRUM-2902 — Credential Engine API key
 * expiry", → Slack `#ops`) and enforced against these tags by
 * `scripts/ci/check-ce-key-expiry-alert-contract.test.ts`. Delivery must be
 * proven live (a real Slack page), never assumed from the event alone — see the
 * SCRUM-2902 runbook.
 *
 * Design is intentionally DB-stateless: no dedup table. Firing every daily cron
 * run inside a window is the desired loudness; Sentry groups the events into one
 * issue and the alert rule's `frequency` throttles the Slack pages.
 *
 * Gated by `ENABLE_CE_KEY_EXPIRY_ALERTS` (default true).
 */

import { Sentry } from '../utils/sentry.js';
import { logger } from '../utils/logger.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Escalation thresholds in days-before-expiry. Ordered widest → narrowest. */
export const CE_KEY_EXPIRY_WINDOWS_DAYS = { T30: 30, T14: 14, T7: 7 } as const;

/** Stable Sentry tag values the alert rule + contract test key on. */
export const CE_KEY_EXPIRY_ALERT_SOURCE = 'ce-key-expiry';
export const CE_KEY_EXPIRY_ALERT_STORY = 'SCRUM-2902';
export const CE_KEY_EXPIRY_ALERT_TYPE = 'ce_api_key_expiry';
/** Tags the Slack notification must carry so the page is actionable at a glance. */
export const CE_KEY_EXPIRY_SLACK_TAGS = ['story', 'expiry_window', 'days_until_expiry'] as const;

/**
 * Values of `CE_API_KEY_EXPIRES_AT` that mean "not configured for real". Any of
 * these (or an unparseable / blank value, or `undefined`) trips the fail-loud
 * SENTINEL path. Case-insensitive.
 */
export const CE_KEY_EXPIRY_SENTINEL_VALUES = new Set([
  'replace_me',
  'sentinel',
  'unset',
  'tbd',
  'todo',
  'changeme',
  'placeholder',
]);

export type CeKeyExpiryWindow = 'SENTINEL' | 'EXPIRED' | 'T-7' | 'T-14' | 'T-30' | 'OK';
export type CeKeyExpirySeverity = 'warning' | 'error' | 'info';

export interface CeKeyExpiryDecision {
  should_fire: boolean;
  window: CeKeyExpiryWindow;
  severity: CeKeyExpirySeverity;
  /** Whole days until expiry; null when the date is a sentinel/unparseable. */
  days_until_expiry: number | null;
  reason: string;
}

export interface CeKeyExpiryInput {
  /** Raw `CE_API_KEY_EXPIRES_AT` value (may be undefined). */
  expires_at_raw: string | undefined;
  /** Clock override for tests. */
  now?: Date;
}

function isSentinel(raw: string | undefined): boolean {
  if (raw == null) return true;
  const trimmed = raw.trim();
  if (trimmed === '') return true;
  return CE_KEY_EXPIRY_SENTINEL_VALUES.has(trimmed.toLowerCase());
}

/**
 * Pure decision function — no I/O, clock-injectable, deterministic.
 * Never throws: an unparseable date fails LOUD (SENTINEL), it does not crash the
 * cron or silently pass.
 */
export function decideCeKeyExpiryAlert(input: CeKeyExpiryInput): CeKeyExpiryDecision {
  const now = input.now ?? new Date();

  if (isSentinel(input.expires_at_raw)) {
    return {
      should_fire: true,
      window: 'SENTINEL',
      severity: 'error',
      days_until_expiry: null,
      reason:
        'CE_API_KEY_EXPIRES_AT is unset or a sentinel placeholder — cannot verify ' +
        'the Credential Engine key expiry. Failing LOUD until a real ISO date is set.',
    };
  }

  const parsedMs = Date.parse((input.expires_at_raw as string).trim());
  if (Number.isNaN(parsedMs)) {
    return {
      should_fire: true,
      window: 'SENTINEL',
      severity: 'error',
      days_until_expiry: null,
      reason:
        `CE_API_KEY_EXPIRES_AT="${input.expires_at_raw}" is not a parseable date — ` +
        'failing LOUD (treat as unknown/expired) until corrected.',
    };
  }

  // Floor toward the operator's worst case: a key that expires partway through
  // "today" is already in the T-0 danger zone, so round DOWN the day count.
  const daysUntil = Math.floor((parsedMs - now.getTime()) / DAY_MS);

  if (daysUntil <= 0) {
    return {
      should_fire: true,
      window: 'EXPIRED',
      severity: 'error',
      days_until_expiry: daysUntil,
      reason: `Credential Engine API key EXPIRED ${Math.abs(daysUntil)} day(s) ago — CTDL publishing/verification is broken.`,
    };
  }
  if (daysUntil <= CE_KEY_EXPIRY_WINDOWS_DAYS.T7) {
    return {
      should_fire: true,
      window: 'T-7',
      severity: 'error',
      days_until_expiry: daysUntil,
      reason: `Credential Engine API key expires in ${daysUntil} day(s) (≤7) — renew NOW.`,
    };
  }
  if (daysUntil <= CE_KEY_EXPIRY_WINDOWS_DAYS.T14) {
    return {
      should_fire: true,
      window: 'T-14',
      severity: 'warning',
      days_until_expiry: daysUntil,
      reason: `Credential Engine API key expires in ${daysUntil} day(s) (≤14) — schedule renewal.`,
    };
  }
  if (daysUntil <= CE_KEY_EXPIRY_WINDOWS_DAYS.T30) {
    return {
      should_fire: true,
      window: 'T-30',
      severity: 'warning',
      days_until_expiry: daysUntil,
      reason: `Credential Engine API key expires in ${daysUntil} day(s) (≤30) — begin renewal.`,
    };
  }

  return {
    should_fire: false,
    window: 'OK',
    severity: 'info',
    days_until_expiry: daysUntil,
    reason: `Credential Engine API key valid for ${daysUntil} more day(s).`,
  };
}

export interface CeKeyExpiryDispatcher {
  captureAlert(decision: CeKeyExpiryDecision): void;
}

/**
 * Emits the decision as a tagged Sentry event. The tags here MUST stay in sync
 * with the alert rule in `infra/sentry/alert-rules.json` — the contract test
 * fails the build on drift.
 */
export function createSentryCeKeyExpiryDispatcher(): CeKeyExpiryDispatcher {
  return {
    captureAlert(decision: CeKeyExpiryDecision) {
      try {
        Sentry.captureMessage(decision.reason, {
          level: decision.severity,
          tags: {
            source: CE_KEY_EXPIRY_ALERT_SOURCE,
            story: CE_KEY_EXPIRY_ALERT_STORY,
            alert_type: CE_KEY_EXPIRY_ALERT_TYPE,
            expiry_window: decision.window,
            days_until_expiry: String(decision.days_until_expiry ?? 'unknown'),
          },
        });
      } catch (err) {
        logger.error(
          { error: err, window: decision.window },
          'Failed to dispatch CE key expiry alert to Sentry',
        );
      }
    },
  };
}

export interface CeKeyExpiryCheckResult {
  ok: boolean;
  fired: boolean;
  window: CeKeyExpiryWindow;
  days_until_expiry: number | null;
}

/**
 * Cron entry point. Reads `CE_API_KEY_EXPIRES_AT` from the environment, runs the
 * decision, and dispatches a Sentry event when in an alert window (or on the
 * fail-loud SENTINEL path). The dispatcher is injectable so tests never touch
 * the network.
 */
export function runCeKeyExpiryCheck(
  dispatcher: CeKeyExpiryDispatcher = createSentryCeKeyExpiryDispatcher(),
  overrides: { expiresAtRaw?: string; now?: Date; enabled?: boolean } = {},
): CeKeyExpiryCheckResult {
  const enabled =
    overrides.enabled ?? process.env.ENABLE_CE_KEY_EXPIRY_ALERTS !== 'false'; // default true

  if (!enabled) {
    logger.info('CE key expiry alerts disabled via flag — skipping check');
    return { ok: true, fired: false, window: 'OK', days_until_expiry: null };
  }

  const decision = decideCeKeyExpiryAlert({
    expires_at_raw: overrides.expiresAtRaw ?? process.env.CE_API_KEY_EXPIRES_AT,
    now: overrides.now,
  });

  if (decision.should_fire) {
    dispatcher.captureAlert(decision);
    // Also log loudly so the signal survives even if Sentry is down / the alert
    // rule is misconfigured — belt-and-braces for an R-1 FATAL dependency.
    const logContext = {
      window: decision.window,
      days_until_expiry: decision.days_until_expiry,
    };
    const logMessage = `CE key expiry alarm fired: ${decision.reason}`;
    if (decision.severity === 'error') {
      logger.error(logContext, logMessage);
    } else {
      logger.warn(logContext, logMessage);
    }
  }

  return {
    ok: true,
    fired: decision.should_fire,
    window: decision.window,
    days_until_expiry: decision.days_until_expiry,
  };
}
