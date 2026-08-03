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
import { captureStuckAnchorAlert, captureStuckSubmittedAlert } from '../utils/sentry.js';
import { config } from '../config.js';

export const DEFAULT_STUCK_ANCHOR_ALERT_HOURS = 24;

/**
 * SCRUM-3017 / BUG-2026-07-26-004: default threshold for the SUBMITTED-stage
 * watchdog added below. Deliberately much shorter than
 * DEFAULT_STUCK_ANCHOR_ALERT_HOURS (24h) — a PENDING anchor can legitimately
 * wait up to ~24h for the daily batch flush (see the module docstring), but a
 * SUBMITTED anchor already has a broadcast Bitcoin tx and should resolve
 * within confirmation windows of hours. Every historical SUBMITTED-stage
 * freeze (the April 1.18M-anchor incident, the ~6-week silent June freeze,
 * and the July MEMPOOL_API_URL isolated-rig freeze) was invisible to on-call
 * because nothing watched this age at all.
 */
export const DEFAULT_STUCK_SUBMITTED_ALERT_HOURS = 6;

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
  /** Age of the oldest anchor at this stage in hours (rounded), or null. */
  oldest_age_hours: number | null;
  pending_count: number | null;
  threshold_hours: number;
}

/**
 * SCRUM-3017: shared core for both `decideStuckAnchorAlert` (PENDING) and
 * `decideStuckSubmittedAlert` (SUBMITTED) below — same age-vs-threshold
 * decision, only the stage label in the wording differs. Extracted so the
 * NaN-guard + rounding + comparison logic exists in exactly one place; a
 * fix to one stage's edge cases (e.g. the boundary/unparseable handling)
 * cannot silently diverge from the other's.
 */
function computeStuckStageDecision(
  stageLabel: 'PENDING' | 'SUBMITTED',
  oldestCreatedAt: string | null,
  count: number | null,
  thresholdHours: number,
  now: Date,
): StuckAnchorAlertDecision {
  const base = {
    severity: 'error' as const,
    pending_count: count,
    threshold_hours: thresholdHours,
  };
  const lower = stageLabel.toLowerCase();

  // No anchors at this stage at all — nothing to alert on.
  if (!oldestCreatedAt) {
    return {
      ...base,
      should_fire: false,
      severity: 'info',
      reason: `No ${lower} anchors`,
      oldest_age_hours: null,
    };
  }

  const createdMs = new Date(oldestCreatedAt).getTime();
  if (Number.isNaN(createdMs)) {
    // Fail safe: an unparseable timestamp must not page (avoid alert storms on
    // a bad row) but is logged loudly by the caller.
    return {
      ...base,
      should_fire: false,
      severity: 'warning',
      reason: `Oldest ${lower} timestamp unparseable (invalid): ${oldestCreatedAt}`,
      oldest_age_hours: null,
    };
  }

  const ageHours = Math.round((now.getTime() - createdMs) / MS_PER_HOUR);

  // should_fire is true only when the age is STRICTLY greater than the
  // threshold (a fresh queue exactly at the boundary is not yet "stuck").
  if (ageHours > thresholdHours) {
    const countSuffix = count != null ? ` (${count} ${stageLabel})` : '';
    return {
      ...base,
      should_fire: true,
      reason: `Stuck anchor pipeline: oldest ${stageLabel} anchor is ${ageHours}h old, exceeds ${thresholdHours}h threshold${countSuffix} — anchoring pipeline may be stalled`,
      oldest_age_hours: ageHours,
    };
  }

  return {
    ...base,
    should_fire: false,
    severity: 'info',
    reason: `Oldest ${stageLabel} anchor is ${ageHours}h old, within ${thresholdHours}h threshold`,
    oldest_age_hours: ageHours,
  };
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
  return computeStuckStageDecision(
    'PENDING',
    input.oldest_pending_created_at,
    input.pending_count,
    input.threshold_hours,
    input.now ?? new Date(),
  );
}

export interface StuckSubmittedAlertInput {
  /** `created_at` of the oldest non-deleted SUBMITTED anchor; null when none. */
  oldest_submitted_created_at: string | null;
  /** Best-effort SUBMITTED count for context; null when unavailable. */
  submitted_count: number | null;
  /** Age threshold in hours above which we page. */
  threshold_hours: number;
  /** Clock injection for deterministic tests. */
  now?: Date;
}

/**
 * SCRUM-3017 / BUG-2026-07-26-004: pure decision function for the
 * SUBMITTED-stage watchdog. An anchor that has been SUBMITTED (broadcast to
 * the chain, awaiting confirmation) for longer than the threshold indicates
 * the confirmation-check pipeline itself is stalled (tip-height fetch
 * failures, RPC outages, etc. — see SCRUM-3021) — a DIFFERENT failure mode
 * than a PENDING backlog waiting on the batch flush, so it gets its own
 * decision, threshold, and Sentry fingerprint rather than being folded into
 * `decideStuckAnchorAlert`.
 */
export function decideStuckSubmittedAlert(
  input: StuckSubmittedAlertInput,
): StuckAnchorAlertDecision {
  return computeStuckStageDecision(
    'SUBMITTED',
    input.oldest_submitted_created_at,
    input.submitted_count,
    input.threshold_hours,
    input.now ?? new Date(),
  );
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

/** SCRUM-3017: same fallback semantics as `resolveStuckAnchorThresholdHours`, for the SUBMITTED stage. */
export function resolveStuckSubmittedThresholdHours(
  configuredHours: number | undefined = config.stuckSubmittedAlertHours,
): number {
  return Number.isFinite(configuredHours) && configuredHours > 0
    ? configuredHours
    : DEFAULT_STUCK_SUBMITTED_ALERT_HOURS;
}

// ─── Cron entry point ───

export interface StuckAnchorCheckResult {
  healthy: boolean;
  alertFired: boolean;
  oldestAgeHours: number | null;
  pendingCount: number | null;
  thresholdHours: number;
  checkedAt: string;
  // SCRUM-3017 / BUG-2026-07-26-004: SUBMITTED-stage watchdog, additive
  // fields (§1.8 style) alongside the pre-existing PENDING fields above.
  submittedHealthy: boolean;
  submittedAlertFired: boolean;
  oldestSubmittedAgeHours: number | null;
  submittedCount: number | null;
  submittedThresholdHours: number;
}

// Supabase client — typed interface impractical due to deeply generic
// SupabaseClient types. Mirrors connector-health-alert.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseDb = { from(table: string): any };

/**
 * Read the oldest non-deleted anchor's `created_at` for a given status via an
 * index-backed LIMIT 1 query. Throws on DB error so the cron route returns
 * 500 and Cloud Scheduler retries (a failed probe must not masquerade as
 * healthy). Shared by the PENDING and SUBMITTED (SCRUM-3017) watchdogs.
 */
async function fetchOldestCreatedAtForStatus(
  db: SupabaseDb,
  status: 'PENDING' | 'SUBMITTED',
): Promise<string | null> {
  const { data, error } = await db
    .from('anchors')
    .select('created_at')
    .eq('status', status)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(1);

  if (error) {
    logger.error({ error, status }, `Stuck anchor monitor: failed to read oldest ${status} anchor`);
    throw new Error(`Failed to read oldest ${status.toLowerCase()} anchor`);
  }

  const rows = (data ?? []) as Array<{ created_at: string | null }>;
  return rows.length > 0 ? rows[0].created_at : null;
}

async function fetchOldestPendingCreatedAt(db: SupabaseDb): Promise<string | null> {
  return fetchOldestCreatedAtForStatus(db, 'PENDING');
}

/** SCRUM-3017: oldest non-deleted SUBMITTED anchor's `created_at`. */
async function fetchOldestSubmittedCreatedAt(db: SupabaseDb): Promise<string | null> {
  return fetchOldestCreatedAtForStatus(db, 'SUBMITTED');
}

/**
 * Best-effort count for a given status from `pipeline_dashboard_cache`
 * (reltuples-backed, instant). Never counts rows directly. Returns null on
 * any miss/error — the count is alert context only and must not block the
 * page. Shared by the PENDING and SUBMITTED (SCRUM-3017) watchdogs.
 */
async function fetchStatusCount(db: SupabaseDb, status: 'PENDING' | 'SUBMITTED'): Promise<number | null> {
  try {
    const { data, error } = await db
      .from('pipeline_dashboard_cache')
      .select('cache_value')
      .eq('cache_key', 'anchor_status_counts')
      .single();

    if (error || !data) {
      logger.warn({ error, status }, 'Stuck anchor monitor: count context unavailable');
      return null;
    }

    const cacheValue = (data as { cache_value?: Record<string, unknown> }).cache_value;
    const count = cacheValue?.[status];
    return typeof count === 'number' && Number.isFinite(count) ? count : null;
  } catch (err) {
    logger.warn({ error: err, status }, 'Stuck anchor monitor: count read threw');
    return null;
  }
}

async function fetchPendingCount(db: SupabaseDb): Promise<number | null> {
  return fetchStatusCount(db, 'PENDING');
}

/** SCRUM-3017: best-effort SUBMITTED count from the same status-counts cache. */
async function fetchSubmittedCount(db: SupabaseDb): Promise<number | null> {
  return fetchStatusCount(db, 'SUBMITTED');
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
 * SCRUM-3017: SUBMITTED-stage counterpart to `emitStuckAnchorAlert`. A
 * SEPARATE Sentry fingerprint (`captureStuckSubmittedAlert`, not
 * `captureStuckAnchorAlert`) so a SUBMITTED stall and a PENDING stall never
 * collapse into the same issue — they are different root causes with
 * different runbooks.
 */
function emitStuckSubmittedAlert(decision: StuckAnchorAlertDecision): void {
  try {
    const alertLevel = decision.severity === 'error' ? 'error' : 'warning';
    captureStuckSubmittedAlert(
      decision.reason,
      {
        source: 'stuck-anchor-monitor',
        story: 'SCRUM-3017',
        oldest_age_hours: decision.oldest_age_hours,
        submitted_count: decision.pending_count,
        threshold_hours: decision.threshold_hours,
      },
      alertLevel,
    );
  } catch (err) {
    logger.error({ error: err }, 'Stuck anchor monitor: failed to emit SUBMITTED Sentry alert');
  }
}

/**
 * End-to-end cron entry point. Reads the oldest PENDING anchor's age + a
 * best-effort pending count, runs the decision, and on a stall logs at error
 * level + fires a Sentry alert carrying the age and count context.
 *
 * SCRUM-3017 / BUG-2026-07-26-004: in the SAME invocation (deliberately —
 * see the PR body's "operator dependencies" note on why this does NOT
 * require provisioning a new Cloud Scheduler job), also checks the oldest
 * SUBMITTED anchor's age. Every historical SUBMITTED-stage freeze was
 * invisible to on-call because nothing watched this signal at all.
 */
export async function runStuckAnchorCheck(
  db: SupabaseDb,
  overrides: { thresholdHours?: number; submittedThresholdHours?: number; now?: Date } = {},
): Promise<StuckAnchorCheckResult> {
  const now = overrides.now ?? new Date();
  const thresholdHours = overrides.thresholdHours ?? resolveStuckAnchorThresholdHours();
  const submittedThresholdHours =
    overrides.submittedThresholdHours ?? resolveStuckSubmittedThresholdHours();

  // ── PENDING ──
  const oldestPendingCreatedAt = await fetchOldestPendingCreatedAt(db);
  // Only spend the count read when there's actually a PENDING backlog.
  const pendingCount = oldestPendingCreatedAt ? await fetchPendingCount(db) : null;
  const decision = decideStuckAnchorAlert({
    oldest_pending_created_at: oldestPendingCreatedAt,
    pending_count: pendingCount,
    threshold_hours: thresholdHours,
    now,
  });

  // ── SUBMITTED (SCRUM-3017) ──
  const oldestSubmittedCreatedAt = await fetchOldestSubmittedCreatedAt(db);
  const submittedCount = oldestSubmittedCreatedAt ? await fetchSubmittedCount(db) : null;
  const submittedDecision = decideStuckSubmittedAlert({
    oldest_submitted_created_at: oldestSubmittedCreatedAt,
    submitted_count: submittedCount,
    threshold_hours: submittedThresholdHours,
    now,
  });

  const result: StuckAnchorCheckResult = {
    healthy: !decision.should_fire,
    alertFired: false,
    oldestAgeHours: decision.oldest_age_hours,
    pendingCount: decision.pending_count,
    thresholdHours,
    checkedAt: now.toISOString(),
    submittedHealthy: !submittedDecision.should_fire,
    submittedAlertFired: false,
    oldestSubmittedAgeHours: submittedDecision.oldest_age_hours,
    submittedCount: submittedDecision.pending_count,
    submittedThresholdHours,
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

  if (submittedDecision.should_fire) {
    logger.error(
      {
        oldestSubmittedAgeHours: submittedDecision.oldest_age_hours,
        submittedCount: submittedDecision.pending_count,
        submittedThresholdHours,
      },
      `Stuck anchor monitor: ${submittedDecision.reason}`,
    );
    emitStuckSubmittedAlert(submittedDecision);
    result.submittedAlertFired = true;
  } else if (submittedDecision.severity === 'warning') {
    logger.warn({ reason: submittedDecision.reason }, 'Stuck anchor monitor: non-fatal SUBMITTED anomaly');
  } else {
    logger.info(
      { oldestSubmittedAgeHours: submittedDecision.oldest_age_hours, submittedThresholdHours },
      'Stuck anchor monitor: SUBMITTED pipeline healthy',
    );
  }

  return result;
}
