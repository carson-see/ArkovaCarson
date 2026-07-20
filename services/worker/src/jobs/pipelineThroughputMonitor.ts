/**
 * Pipeline Throughput Monitor — dead-man switch on pipeline CONVERSION
 * (SCRUM-2901 / epic SCRUM-2895, PI-0.5).
 *
 * Why this exists
 * ---------------
 * Verified 2026-07-17: prod `/health` reports anchoring:"ok" while the
 * pending-anchoring public-records backlog GROWS (~259k unlinked). `/health`
 * is shallow liveness — it proves the worker answers HTTP, not that records
 * convert into secured anchors. The feeder Cloud Scheduler jobs fire 200,
 * records land in `public_records`, and nothing downstream converts — with no
 * alert anywhere.
 *
 * Two independent fire conditions (one stable Sentry fingerprint):
 *
 *   A — TOTAL SECURING DEATH: a new unlinked record arrived inside the
 *       window while NO anchor secured network-wide inside it. Catches a
 *       fully-stalled securing path while feeders are demonstrably active.
 *
 *   B — LINKER STALL: the OLDEST unlinked public record's age exceeds the
 *       stall threshold (default 48h). This is the exact motivating incident
 *       shape: a 255k+ backlog sits unlinked for weeks while OTHER anchor
 *       paths keep securing — condition A alone would never fire because
 *       prod's secured count always advances (independent-review CRITICAL,
 *       2026-07-17).
 *
 * Scope boundary: FEEDER death (Cloud Scheduler drift / paused feeder crons —
 * no new records arriving at all) is owned by SCRUM-2900, not this monitor.
 * With zero production and zero backlog there is no throughput claim to
 * falsify here.
 *
 * Why not reuse stuck-anchor-monitor / pipeline-health
 * ----------------------------------------------------
 * `stuck-anchor-monitor.ts` (SCRUM-2234) pages on the AGE of the oldest
 * PENDING *anchor* — it is blind to records that never become anchors at all
 * (the unlinked `public_records` backlog has no anchor row to age).
 * `pipeline-health.ts` keys off `updated_at` with a 30-min threshold and
 * emails. Neither answers "are records currently converting to SECURED?".
 *
 * How it measures — LIMIT-1 timestamp probes ONLY, no counts, no snapshots
 * ------------------------------------------------------------------------
 * NO migration, no snapshot table, and — deliberately — NO `count` queries:
 * R0-8 / SCRUM-1254 caps exact-count callsites (they caused the 60s
 * PostgREST timeouts on `anchors`), and estimated counts are unreliable at
 * the zero-vs-nonzero granularity a dead-man needs. Every decision input is
 * an index-backed `LIMIT 1` timestamp probe; magnitudes come from the
 * dashboard cache:
 *   - latest_unlinked_age_hours / oldest_unlinked_age_hours: newest/oldest
 *     `created_at` of `anchor_id IS NULL` rows — Index Scan + LIMIT 1 (desc /
 *     asc) on the partial index `idx_public_records_unanchored (created_at)
 *     WHERE anchor_id IS NULL`. "New unlinked record arrived in the window"
 *     ⟺ latest age ≤ window.
 *   - last_secured_age_hours: newest `chain_timestamp` of
 *     `status='SECURED' AND deleted_at IS NULL` rows — the exact query the
 *     partial index `idx_anchors_secured_chain_ts (chain_timestamp DESC
 *     NULLS LAST) WHERE status='SECURED' AND deleted_at IS NULL` (migration
 *     0310) was built for. "Securing alive in the window" ⟺ last-secured age
 *     ≤ window; this observes securing EVENTS regardless of anchor age (a
 *     `created_at`-bounded cohort would miss old-anchor securing during a
 *     backlog drain and false-page — independent-review MAJOR).
 *   - unlinked_total + batch_progress come from `pipeline_dashboard_cache`
 *     (`pipeline_stats.pending_record_links`, `anchor_status_counts`) —
 *     best-effort context, never a 255k-row count on the hot path. The
 *     refresh function writes -1 sentinels on statement timeout; those are
 *     mapped to null (unavailable), never treated as a real count.
 *
 * Alert semantics
 * ---------------
 * Condition A's default window is 24h so a healthy pipeline that only secures
 * at the nightly 3am batch flush always shows ≥1 flush cycle inside the
 * window (a 6h window would false-page every afternoon). Condition B's
 * threshold defaults to 48h — two full daily-flush cycles of slack before an
 * unlinked record's age is called a stall.
 *
 * On fire: error-level structured log + Sentry capture through
 * `capturePipelineThroughputAlert` (stable fingerprint — scheduled re-fires
 * collapse into ONE Sentry issue, mirroring captureStuckAnchorAlert /
 * SCRUM-2255). Context is aggregate metrics only — never emails, document
 * fingerprints, ids, or keys (§1.4).
 *
 * HTTP semantics (route: POST /jobs/pipeline-throughput-monitor) mirror
 * /check-stuck-anchors: a DETECTED stall is a CORRECT result → 200
 * (healthy:false); only a broken probe throws → 500 so Cloud Scheduler
 * retries the probe, not the finding.
 *
 * NOTE: this ships CODE ONLY. The Cloud Scheduler job that triggers the
 * endpoint is a separate, gated ops step (RTE-owned) — nothing here mutates
 * scheduler state, flags, or prod resources.
 */

import { logger } from '../utils/logger.js';
import { capturePipelineThroughputAlert } from '../utils/sentry.js';

/**
 * Default lookback window for condition A. Must stay ≥ 24h: small org queues
 * route to the nightly 3am batch flush, so a shorter window would report
 * "nothing secured" for most of a perfectly healthy day.
 */
export const DEFAULT_THROUGHPUT_WINDOW_HOURS = 24;

/**
 * Default condition-B threshold: how old the OLDEST unlinked public record
 * may get before the linker is declared stalled. Two nightly flush cycles of
 * slack by default.
 */
export const DEFAULT_LINKER_STALL_THRESHOLD_HOURS = 48;

const MS_PER_HOUR = 60 * 60 * 1000;

export type AlertSeverity = 'info' | 'error';

export interface ThroughputAlertInput {
  /** Age in hours of the NEWEST unlinked public record; null when none/unparseable. */
  latest_unlinked_age_hours: number | null;
  /** Age in hours of the OLDEST unlinked public record; null when none/unparseable. */
  oldest_unlinked_age_hours: number | null;
  /** Age in hours of the most recent SECURED chain_timestamp; null when none/unparseable. */
  last_secured_age_hours: number | null;
  /** Total unlinked backlog from pipeline_dashboard_cache; null when unavailable. */
  unlinked_total: number | null;
  window_hours: number;
  linker_stall_threshold_hours: number;
}

export interface ThroughputAlertDecision {
  should_fire: boolean;
  severity: AlertSeverity;
  reason: string;
}

/**
 * Pure decision function — no I/O. Condition A (total securing death) takes
 * precedence over condition B (linker stall) when both hold. Counts-free,
 * aggregate-age reason strings (PII-safe by construction).
 */
export function decidePipelineThroughputAlert(
  input: ThroughputAlertInput,
): ThroughputAlertDecision {
  const totalSuffix =
    input.unlinked_total != null
      ? ` (total unlinked backlog ${input.unlinked_total})`
      : '';

  const newUnlinkedInWindow =
    input.latest_unlinked_age_hours !== null &&
    input.latest_unlinked_age_hours <= input.window_hours;
  const securedInWindow =
    input.last_secured_age_hours !== null &&
    input.last_secured_age_hours <= input.window_hours;

  // Condition A — total securing death: feeders demonstrably produced an
  // unconverted record inside the window while NOTHING secured anywhere in it.
  if (newUnlinkedInWindow && !securedInWindow) {
    const lastSecuredClause =
      input.last_secured_age_hours !== null
        ? `last securing was ${input.last_secured_age_hours}h ago`
        : 'no securing observed at all';
    return {
      should_fire: true,
      severity: 'error',
      reason:
        `Pipeline throughput dead-man: new unlinked public record(s) arrived (latest ` +
        `${input.latest_unlinked_age_hours}h ago) while 0 anchors secured network-wide in the ` +
        `last ${input.window_hours}h — ${lastSecuredClause}${totalSuffix}; the securing path ` +
        'is not converting although feeders are active',
    };
  }

  // Condition B — linker stall: the oldest unlinked record's age exceeds the
  // threshold. Fires even while OTHER anchor paths keep securing — the exact
  // 2026-07 incident (259k backlog aging while secured count still advanced).
  if (
    input.oldest_unlinked_age_hours !== null &&
    input.oldest_unlinked_age_hours > input.linker_stall_threshold_hours
  ) {
    return {
      should_fire: true,
      severity: 'error',
      reason:
        `Pipeline linker stall: oldest unlinked public record is ` +
        `${input.oldest_unlinked_age_hours}h old, exceeds ` +
        `${input.linker_stall_threshold_hours}h threshold${totalSuffix} — records are not being ` +
        'linked to anchors even though securing may continue on other paths',
    };
  }

  if (input.oldest_unlinked_age_hours === null && input.latest_unlinked_age_hours === null) {
    return {
      should_fire: false,
      severity: 'info',
      reason:
        'No unlinked public records — nothing to convert (feeder-death monitoring is ' +
        'SCRUM-2900, not this monitor)',
    };
  }

  return {
    should_fire: false,
    severity: 'info',
    reason:
      `Pipeline converting: last securing ` +
      `${input.last_secured_age_hours !== null ? `${input.last_secured_age_hours}h ago` : 'not observed'}; ` +
      `oldest unlinked record ${input.oldest_unlinked_age_hours ?? 0}h old, within ` +
      `${input.linker_stall_threshold_hours}h threshold`,
  };
}

// ─── Cron entry point ───

export interface PipelineThroughputResult {
  healthy: boolean;
  alertFired: boolean;
  windowHours: number;
  linkerStallThresholdHours: number;
  /** Age in hours of the newest unlinked public record; null when none. */
  latestUnlinkedAgeHours: number | null;
  /** Age in hours of the oldest unlinked public record; null when none. */
  oldestUnlinkedAgeHours: number | null;
  /** Age in hours of the most recent SECURED chain_timestamp; null when none. */
  lastSecuredAgeHours: number | null;
  /** Cache-backed total unlinked backlog (pipeline_stats.pending_record_links); null when unavailable. */
  unlinkedTotal: number | null;
  /** Cache-backed anchors-by-status counts (anchor_status_counts); null when unavailable. */
  batchProgress: Record<string, number> | null;
  reason: string;
  checkedAt: string;
}

// Supabase client — typed interface impractical due to deeply generic
// SupabaseClient types. Mirrors stuck-anchor-monitor.ts / connector-health-alert.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseDb = { from(table: string): any };

/**
 * Newest/oldest `created_at` of unlinked public_records — Index Scan +
 * LIMIT 1 on the partial index `idx_public_records_unanchored (created_at)
 * WHERE anchor_id IS NULL`. Both directions drive fire conditions, so a
 * probe failure throws (500 → Scheduler retry) instead of silently degrading
 * the dead-man.
 */
async function fetchUnlinkedBoundaryCreatedAt(
  db: SupabaseDb,
  direction: 'oldest' | 'newest',
): Promise<string | null> {
  const { data, error } = await db
    .from('public_records')
    .select('created_at')
    .is('anchor_id', null)
    .order('created_at', { ascending: direction === 'oldest' })
    .limit(1);

  if (error) {
    logger.error(
      { direction, error },
      'Pipeline throughput monitor: probe failed (unlinked-record boundary)',
    );
    throw new Error(`Pipeline throughput probe failed: ${direction}_unlinked_record`);
  }
  const rows = (data ?? []) as Array<{ created_at: string | null }>;
  return rows.length > 0 ? rows[0].created_at : null;
}

/**
 * Most recent SECURED `chain_timestamp` — the exact query the partial index
 * `idx_anchors_secured_chain_ts` (migration 0310) exists for. Observes
 * securing EVENTS network-wide regardless of anchor age. `nullsFirst: false`
 * + the not-null filter guard against legacy SECURED rows with a null
 * chain_timestamp sorting first under Postgres DESC-implies-NULLS-FIRST.
 */
async function fetchLastSecuredChainTimestamp(db: SupabaseDb): Promise<string | null> {
  const { data, error } = await db
    .from('anchors')
    .select('chain_timestamp')
    .eq('status', 'SECURED')
    .is('deleted_at', null)
    .not('chain_timestamp', 'is', null)
    .order('chain_timestamp', { ascending: false, nullsFirst: false })
    .limit(1);

  if (error) {
    logger.error({ error }, 'Pipeline throughput monitor: probe failed (last secured)');
    throw new Error('Pipeline throughput probe failed: last_secured_anchor');
  }
  const rows = (data ?? []) as Array<{ chain_timestamp: string | null }>;
  return rows.length > 0 ? rows[0].chain_timestamp : null;
}

/** Best-effort cache_value read from pipeline_dashboard_cache. Null on any miss. */
async function fetchCacheValue(
  db: SupabaseDb,
  cacheKey: string,
): Promise<Record<string, unknown> | null> {
  try {
    const { data, error } = await db
      .from('pipeline_dashboard_cache')
      .select('cache_value')
      .eq('cache_key', cacheKey)
      .single();
    if (error || !data) {
      logger.warn(
        { cacheKey, error: error ?? null },
        'Pipeline throughput monitor: dashboard-cache context unavailable',
      );
      return null;
    }
    const value = (data as { cache_value?: Record<string, unknown> }).cache_value;
    return value && typeof value === 'object' ? value : null;
  } catch (err) {
    logger.warn(
      { cacheKey, error: err },
      'Pipeline throughput monitor: dashboard-cache read threw',
    );
    return null;
  }
}

/**
 * Total unlinked backlog from the `pipeline_stats` cache row. The refresh
 * function writes -1 when its 1s per-count budget times out — a sentinel,
 * never a real count — so anything negative (or non-numeric) maps to null.
 */
function parseUnlinkedTotal(cacheValue: Record<string, unknown> | null): number | null {
  const raw = cacheValue?.pending_record_links;
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null;
}

/** Numeric-only status counts from the `anchor_status_counts` cache row. */
function parseBatchProgress(
  cacheValue: Record<string, unknown> | null,
): Record<string, number> | null {
  if (!cacheValue) return null;
  const progress: Record<string, number> = {};
  for (const [status, count] of Object.entries(cacheValue)) {
    if (typeof count === 'number' && Number.isFinite(count)) progress[status] = count;
  }
  return Object.keys(progress).length > 0 ? progress : null;
}

/**
 * Convert a probe timestamp into an age in whole hours. An unparseable
 * timestamp maps to null with a loud warn — fail safe, no spurious page on a
 * bad row (mirrors stuck-anchor-monitor).
 */
function computeAgeHours(probe: string, timestamp: string | null, now: Date): number | null {
  if (!timestamp) return null;
  const parsedMs = new Date(timestamp).getTime();
  if (Number.isNaN(parsedMs)) {
    logger.warn(
      { probe },
      'Pipeline throughput monitor: probe timestamp unparseable — treating as unavailable',
    );
    return null;
  }
  return Math.round((now.getTime() - parsedMs) / MS_PER_HOUR);
}

function emitThroughputAlert(
  decision: ThroughputAlertDecision,
  input: ThroughputAlertInput,
): void {
  try {
    // Aggregate metrics only (§1.4) — never per-document/user data.
    capturePipelineThroughputAlert(decision.reason, {
      source: 'pipeline-throughput-monitor',
      story: 'SCRUM-2901',
      latest_unlinked_age_hours: input.latest_unlinked_age_hours,
      oldest_unlinked_age_hours: input.oldest_unlinked_age_hours,
      last_secured_age_hours: input.last_secured_age_hours,
      unlinked_total: input.unlinked_total,
      window_hours: input.window_hours,
      linker_stall_threshold_hours: input.linker_stall_threshold_hours,
    });
  } catch (err) {
    logger.error({ error: err }, 'Pipeline throughput monitor: failed to emit Sentry alert');
  }
}

/**
 * End-to-end cron entry point. Runs the three LIMIT-1 timestamp probes plus
 * best-effort cache context, evaluates both dead-man conditions, and on a
 * stall logs at error level + fires the stable-fingerprint Sentry alert.
 * Throws on a broken core probe (route → 500 → Scheduler retry).
 */
export async function runPipelineThroughputMonitor(
  db: SupabaseDb,
  overrides: { windowHours?: number; linkerStallThresholdHours?: number; now?: Date } = {},
): Promise<PipelineThroughputResult> {
  const now = overrides.now ?? new Date();
  const windowHours = overrides.windowHours ?? DEFAULT_THROUGHPUT_WINDOW_HOURS;
  const linkerStallThresholdHours =
    overrides.linkerStallThresholdHours ?? DEFAULT_LINKER_STALL_THRESHOLD_HOURS;

  // Core probes: fail loud (throw → 500). Cache context: best-effort (null).
  const [
    oldestUnlinkedCreatedAt,
    newestUnlinkedCreatedAt,
    lastSecuredChainTimestamp,
    pipelineStatsCache,
    statusCountsCache,
  ] = await Promise.all([
    fetchUnlinkedBoundaryCreatedAt(db, 'oldest'),
    fetchUnlinkedBoundaryCreatedAt(db, 'newest'),
    fetchLastSecuredChainTimestamp(db),
    fetchCacheValue(db, 'pipeline_stats'),
    fetchCacheValue(db, 'anchor_status_counts'),
  ]);

  const oldestUnlinkedAgeHours = computeAgeHours('oldest_unlinked_record', oldestUnlinkedCreatedAt, now);
  const latestUnlinkedAgeHours = computeAgeHours('newest_unlinked_record', newestUnlinkedCreatedAt, now);
  const lastSecuredAgeHours = computeAgeHours('last_secured_anchor', lastSecuredChainTimestamp, now);
  const unlinkedTotal = parseUnlinkedTotal(pipelineStatsCache);
  const batchProgress = parseBatchProgress(statusCountsCache);

  const input: ThroughputAlertInput = {
    latest_unlinked_age_hours: latestUnlinkedAgeHours,
    oldest_unlinked_age_hours: oldestUnlinkedAgeHours,
    last_secured_age_hours: lastSecuredAgeHours,
    unlinked_total: unlinkedTotal,
    window_hours: windowHours,
    linker_stall_threshold_hours: linkerStallThresholdHours,
  };
  const decision = decidePipelineThroughputAlert(input);

  const result: PipelineThroughputResult = {
    healthy: !decision.should_fire,
    alertFired: false,
    windowHours,
    linkerStallThresholdHours,
    latestUnlinkedAgeHours,
    oldestUnlinkedAgeHours,
    lastSecuredAgeHours,
    unlinkedTotal,
    batchProgress,
    reason: decision.reason,
    checkedAt: now.toISOString(),
  };

  const logContext = {
    latestUnlinkedAgeHours,
    oldestUnlinkedAgeHours,
    lastSecuredAgeHours,
    unlinkedTotal,
    windowHours,
    linkerStallThresholdHours,
  };

  if (decision.should_fire) {
    logger.error(logContext, `Pipeline throughput monitor: ${decision.reason}`);
    emitThroughputAlert(decision, input);
    result.alertFired = true;
  } else {
    logger.info(logContext, `Pipeline throughput monitor: ${decision.reason}`);
  }

  return result;
}
