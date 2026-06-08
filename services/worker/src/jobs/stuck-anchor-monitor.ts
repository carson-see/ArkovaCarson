/**
 * Stuck Anchor Monitor — pipeline-stall detector (incident 2026-06-01).
 *
 * Why this exists
 * ---------------
 * The daily 03:00 flush Cloud Scheduler job (`daily-anchor-flush`) silently
 * failed auth (401, OIDC audience bug) for ~6 weeks. Every queue under
 * MIN_BATCH_THRESHOLD (3,000) is routed to that daily flush, so ~2,962
 * PENDING anchors never drained — and nobody noticed, because there was NO
 * alert on the pipeline stalling.
 *
 * This monitor closes that gap: it measures the AGE of the oldest non-deleted
 * PENDING anchor (by `created_at`) and pages when it exceeds a threshold
 * (default 24h, overridable via `STUCK_ANCHOR_ALERT_HOURS`). When tripped it
 * logs at error level AND emits a Sentry event with the age + pending-count
 * context.
 *
 * Why not reuse pipeline-health.ts
 * --------------------------------
 * `pipeline-health.ts` (SCALE-4) keys off `updated_at` with a 30-minute
 * PENDING threshold and alerts over email. A correctly-queued anchor waiting
 * for the daily flush has a *fresh* `updated_at` (its claim/release churn
 * keeps bumping it) but a *stale* `created_at`. So the 2026-06-01 stall would
 * not have tripped pipeline-health, and even if it had, the alert would have
 * gone to email — not the Sentry surface ops actually watches. This monitor
 * targets the exact missed signal: oldest-by-`created_at` age, Sentry-paged.
 *
 * Query efficiency (CLAUDE.md "anchors is ~1.6M rows; no count(*)/scans")
 * ----------------------------------------------------------------------
 * The age probe is a single index-backed read:
 *   select created_at from anchors
 *   where status = 'PENDING' and deleted_at is null
 *   order by created_at asc limit 1
 * `status` is selective + indexed, so this is a cheap index scan + LIMIT 1
 * short-circuit — no full-table count. The pending *count* is best-effort
 * context only and is read from `pipeline_dashboard_cache` (pg_class.reltuples
 * backed, instant; see utils/anchor-stats.ts) — never via count(*).
 *
 * Mirrors the connector-health-alert.ts / treasury-alert.ts shape: a pure,
 * clock-injectable decision function plus a `runStuckAnchorCheck(db)` cron glue.
 */

import { logger } from '../utils/logger.js';
import { captureStuckAnchorAlert } from '../utils/sentry.js';
import { config } from '../config.js';

export const DEFAULT_STUCK_ANCHOR_ALERT_HOURS = 24;

const MS_PER_HOUR = 60 * 60 * 1000;

export type AlertSeverity = 'info' | 'warning' | 'error';

export interface StuckAnchorAlertInput {
  /** `created_at` of the oldest non-deleted PENDING anchor; null when none. */
  oldest_pending_created_at: string | null;
  /** Best-effort PENDING count for context; null when unavailable. */
  pending_count: number | null;
  /** Age threshold in hours above which we page. */
  threshold_hours: number;
  /** Clock injection for deterministic tests. */
  now?: Date;
}

export interface StuckAnchorAlertDecision {
  should_fire: boolean;
  reason: string;
  severity: AlertSeverity;
  /** Age of the oldest PENDING anchor in hours (rounded), or null. */
  oldest_age_hours: number | null;
  pending_count: number | null;
  threshold_hours: number;
}

/**
 * Pure decision function — no I/O. Decides whether the oldest PENDING anchor's
 * age crosses the alert threshold. `should_fire` is true only when the age is
 * strictly greater than the threshold (a fresh queue exactly at the boundary
 * is not yet "stuck").
 */
export function decideStuckAnchorAlert(
  input: StuckAnchorAlertInput,
): StuckAnchorAlertDecision {
  const now = input.now ?? new Date();
  const base = {
    severity: 'error' as const,
    pending_count: input.pending_count,
    threshold_hours: input.threshold_hours,
  };

  // No PENDING anchors at all — pipeline is drained, nothing to alert on.
  if (!input.oldest_pending_created_at) {
    return {
      ...base,
      should_fire: false,
      severity: 'info',
      reason: 'No pending anchors',
      oldest_age_hours: null,
    };
  }

  const createdMs = new Date(input.oldest_pending_created_at).getTime();
  if (Number.isNaN(createdMs)) {
    // Fail safe: an unparseable timestamp must not page (avoid alert storms on
    // a bad row) but is logged loudly by the caller.
    return {
      ...base,
      should_fire: false,
      severity: 'warning',
      reason: `Oldest pending timestamp unparseable (invalid): ${input.oldest_pending_created_at}`,
      oldest_age_hours: null,
    };
  }

  const ageHours = Math.round((now.getTime() - createdMs) / MS_PER_HOUR);

  if (ageHours > input.threshold_hours) {
    const countSuffix =
      input.pending_count != null ? ` (${input.pending_count} PENDING)` : '';
    return {
      ...base,
      should_fire: true,
      reason: `Stuck anchor pipeline: oldest PENDING anchor is ${ageHours}h old, exceeds ${input.threshold_hours}h threshold${countSuffix} — anchoring pipeline may be stalled`,
      oldest_age_hours: ageHours,
    };
  }

  return {
    ...base,
    should_fire: false,
    severity: 'info',
    reason: `Oldest PENDING anchor is ${ageHours}h old, within ${input.threshold_hours}h threshold`,
    oldest_age_hours: ageHours,
  };
}

/**
 * Resolve the alert threshold (hours) from typed worker config. Config schema
 * handles unset/invalid/non-positive env values by falling back to the default.
 */
export function resolveStuckAnchorThresholdHours(
  configuredHours: number | undefined = config.stuckAnchorAlertHours,
): number {
  return Number.isFinite(configuredHours) && configuredHours > 0
    ? configuredHours
    : DEFAULT_STUCK_ANCHOR_ALERT_HOURS;
}

// ─── Cron entry point ───

export interface StuckAnchorCheckResult {
  healthy: boolean;
  alertFired: boolean;
  oldestAgeHours: number | null;
  pendingCount: number | null;
  thresholdHours: number;
  checkedAt: string;
}

// Supabase client — typed interface impractical due to deeply generic
// SupabaseClient types. Mirrors connector-health-alert.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseDb = { from(table: string): any };

/**
 * Read the oldest non-deleted PENDING anchor's `created_at` via an
 * index-backed LIMIT 1 query. Throws on DB error so the cron route returns 500
 * and Cloud Scheduler retries (a failed probe must not masquerade as healthy).
 */
async function fetchOldestPendingCreatedAt(db: SupabaseDb): Promise<string | null> {
  const { data, error } = await db
    .from('anchors')
    .select('created_at')
    .eq('status', 'PENDING')
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(1);

  if (error) {
    logger.error({ error }, 'Stuck anchor monitor: failed to read oldest PENDING anchor');
    throw new Error('Failed to read oldest pending anchor');
  }

  const rows = (data ?? []) as Array<{ created_at: string | null }>;
  return rows.length > 0 ? rows[0].created_at : null;
}

/**
 * Best-effort PENDING count from `pipeline_dashboard_cache` (reltuples-backed,
 * instant). Never counts rows directly. Returns null on any miss/error — the
 * count is alert context only and must not block the page.
 */
async function fetchPendingCount(db: SupabaseDb): Promise<number | null> {
  try {
    const { data, error } = await db
      .from('pipeline_dashboard_cache')
      .select('cache_value')
      .eq('cache_key', 'anchor_status_counts')
      .single();

    if (error || !data) {
      logger.warn({ error }, 'Stuck anchor monitor: pending-count context unavailable');
      return null;
    }

    const cacheValue = (data as { cache_value?: Record<string, unknown> }).cache_value;
    const pending = cacheValue?.PENDING;
    return typeof pending === 'number' && Number.isFinite(pending) ? pending : null;
  } catch (err) {
    logger.warn({ error: err }, 'Stuck anchor monitor: pending-count read threw');
    return null;
  }
}

function emitStuckAnchorAlert(decision: StuckAnchorAlertDecision): void {
  try {
    const alertLevel = decision.severity === 'error' ? 'error' : 'warning';
    captureStuckAnchorAlert(
      decision.reason,
      {
        source: 'stuck-anchor-monitor',
        story: 'SCRUM-2234',
        oldest_age_hours: decision.oldest_age_hours,
        pending_count: decision.pending_count,
        threshold_hours: decision.threshold_hours,
      },
      alertLevel,
    );
  } catch (err) {
    logger.error({ error: err }, 'Stuck anchor monitor: failed to emit Sentry alert');
  }
}

/**
 * End-to-end cron entry point. Reads the oldest PENDING anchor's age + a
 * best-effort pending count, runs the decision, and on a stall logs at error
 * level + fires a Sentry alert carrying the age and count context.
 */
export async function runStuckAnchorCheck(
  db: SupabaseDb,
  overrides: { thresholdHours?: number; now?: Date } = {},
): Promise<StuckAnchorCheckResult> {
  const now = overrides.now ?? new Date();
  const thresholdHours = overrides.thresholdHours ?? resolveStuckAnchorThresholdHours();

  const oldestPendingCreatedAt = await fetchOldestPendingCreatedAt(db);

  // Only spend the count read when there's actually a PENDING backlog.
  const pendingCount = oldestPendingCreatedAt ? await fetchPendingCount(db) : null;

  const decision = decideStuckAnchorAlert({
    oldest_pending_created_at: oldestPendingCreatedAt,
    pending_count: pendingCount,
    threshold_hours: thresholdHours,
    now,
  });

  const result: StuckAnchorCheckResult = {
    healthy: !decision.should_fire,
    alertFired: false,
    oldestAgeHours: decision.oldest_age_hours,
    pendingCount: decision.pending_count,
    thresholdHours,
    checkedAt: now.toISOString(),
  };

  if (decision.should_fire) {
    logger.error(
      {
        oldestAgeHours: decision.oldest_age_hours,
        pendingCount: decision.pending_count,
        thresholdHours,
      },
      `Stuck anchor monitor: ${decision.reason}`,
    );
    emitStuckAnchorAlert(decision);
    result.alertFired = true;
  } else if (decision.severity === 'warning') {
    // Unparseable timestamp etc. — surface loudly without paging.
    logger.warn({ reason: decision.reason }, 'Stuck anchor monitor: non-fatal anomaly');
  } else {
    logger.info(
      { oldestAgeHours: decision.oldest_age_hours, thresholdHours },
      'Stuck anchor monitor: pipeline healthy',
    );
  }

  return result;
}
