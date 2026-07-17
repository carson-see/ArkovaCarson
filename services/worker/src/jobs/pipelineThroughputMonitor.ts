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
 * alert anywhere. This monitor measures THROUGHPUT: feeders producing vs the
 * pipeline securing, inside one bounded window.
 *
 * Why not reuse stuck-anchor-monitor / pipeline-health
 * ----------------------------------------------------
 * `stuck-anchor-monitor.ts` (SCRUM-2234) pages on the AGE of the oldest
 * PENDING *anchor* — it is blind to records that never become anchors at all
 * (the unlinked `public_records` backlog has no anchor row to age).
 * `pipeline-health.ts` keys off `updated_at` with a 30-min threshold and
 * emails. Neither answers "are records currently converting to SECURED?".
 *
 * How it measures without a snapshot table (NO migration)
 * -------------------------------------------------------
 * There is deliberately no persisted previous-run snapshot. All deltas come
 * from timestamps already in existing tables, each probe bounded by an index:
 *   - new_unlinked_in_window:  public_records created in the window and STILL
 *     unlinked (`anchor_id IS NULL`) — exact partial-index match on
 *     `idx_public_records_unanchored (created_at) WHERE anchor_id IS NULL`.
 *     Growth proxy: feeders produced records the linker has not converted.
 *   - records_created_in_window: public_records created in the window
 *     (`idx_public_records_created_at`) — feeder-activity context.
 *   - anchors_created_in_window / anchors_secured_in_window: anchors created
 *     in the window (`idx_anchors_active_created`), the secured variant
 *     additionally requiring `chain_timestamp IS NOT NULL` — the fresh-cohort
 *     conversion signal. The window bound keeps the probe off the 2.9M-row
 *     full table (CLAUDE.md: no count(*) scans over `anchors`).
 *   - unlinked_total + batch_progress come from `pipeline_dashboard_cache`
 *     (`pipeline_stats.pending_record_links`, `anchor_status_counts`) —
 *     best-effort context, never a 255k-row count on the hot path. The
 *     refresh function writes -1 sentinels on statement timeout; those are
 *     mapped to null (unavailable), never treated as a real count.
 *
 * Alert semantics (dead-man)
 * --------------------------
 * Fire ⟺ new_unlinked_in_window > 0 AND anchors_secured_in_window == 0:
 * feeders demonstrably active (fresh unlinked rows exist) while NOTHING
 * secured all window — the exact "Scheduler fires 200 but records don't
 * convert" failure. Feeders paused (no new unlinked rows) → no page, by
 * design: with no production there is no throughput to assert. Any securing
 * at all (≥1) proves the conversion path alive → no page. The default window
 * is 24h so a healthy pipeline that only secures at the nightly 3am batch
 * flush always shows ≥1 flush cycle inside the window (a 6h window would
 * false-page every afternoon).
 *
 * On fire: error-level structured log + Sentry capture through
 * `capturePipelineThroughputAlert` (stable fingerprint — hourly re-fires
 * collapse into ONE Sentry issue, mirroring captureStuckAnchorAlert /
 * SCRUM-2255). Context is aggregate counts only — never emails, document
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
 * Default lookback window. Must stay ≥ 24h: small org queues route to the
 * nightly 3am batch flush, so a shorter window would report "zero secured"
 * for most of a perfectly healthy day.
 */
export const DEFAULT_THROUGHPUT_WINDOW_HOURS = 24;

const MS_PER_HOUR = 60 * 60 * 1000;

export type AlertSeverity = 'info' | 'error';

export interface ThroughputAlertInput {
  /** public_records created inside the window that are still unlinked. */
  new_unlinked_in_window: number;
  /** Anchors created inside the window that reached the chain (chain_timestamp set). */
  anchors_secured_in_window: number;
  /** All public_records created inside the window (feeder-activity context). */
  records_created_in_window: number;
  /** All anchors created inside the window (linker-activity context). */
  anchors_created_in_window: number;
  /** Total unlinked backlog from pipeline_dashboard_cache; null when unavailable. */
  unlinked_total: number | null;
  window_hours: number;
}

export interface ThroughputAlertDecision {
  should_fire: boolean;
  severity: AlertSeverity;
  reason: string;
}

/**
 * Pure decision function — no I/O. Fires only when the window shows feeders
 * producing unconverted records while zero anchors secured (dead-man
 * condition). Counts-only reason string (PII-safe by construction).
 */
export function decidePipelineThroughputAlert(
  input: ThroughputAlertInput,
): ThroughputAlertDecision {
  if (input.new_unlinked_in_window <= 0) {
    return {
      should_fire: false,
      severity: 'info',
      reason:
        `No new unlinked public records in the last ${input.window_hours}h ` +
        '(feeders idle or fully converted) — no throughput signal to assert',
    };
  }

  if (input.anchors_secured_in_window > 0) {
    return {
      should_fire: false,
      severity: 'info',
      reason:
        `Pipeline converting: ${input.anchors_secured_in_window} anchor(s) secured and ` +
        `${input.new_unlinked_in_window} new unlinked record(s) in the last ${input.window_hours}h`,
    };
  }

  const totalSuffix =
    input.unlinked_total != null
      ? ` (total unlinked backlog ${input.unlinked_total})`
      : '';
  return {
    should_fire: true,
    severity: 'error',
    reason:
      `Pipeline throughput dead-man: ${input.new_unlinked_in_window} new unlinked public ` +
      `record(s) arrived in the last ${input.window_hours}h while 0 anchors secured` +
      `${totalSuffix} — records are not converting although feeders are active`,
  };
}

// ─── Cron entry point ───

export interface PipelineThroughputResult {
  healthy: boolean;
  alertFired: boolean;
  windowHours: number;
  newUnlinkedInWindow: number;
  recordsCreatedInWindow: number;
  anchorsCreatedInWindow: number;
  anchorsSecuredInWindow: number;
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

interface CountResponse {
  count: number | null;
  error: { message?: string } | null;
}

/**
 * Resolve a head/count query to a definite number. A probe error OR an absent
 * count throws — a broken probe must 500 (Cloud Scheduler retries) rather
 * than silently reading 0 and masquerading as "healthy but idle".
 */
function requireCount(label: string, response: CountResponse): number {
  if (response.error || typeof response.count !== 'number') {
    logger.error(
      { probe: label, error: response.error ?? null },
      'Pipeline throughput monitor: probe failed',
    );
    throw new Error(`Pipeline throughput probe failed: ${label}`);
  }
  return response.count;
}

/** public_records created in the window, still unlinked (idx_public_records_unanchored). */
async function fetchNewUnlinkedInWindow(db: SupabaseDb, sinceIso: string): Promise<number> {
  const response = (await db
    .from('public_records')
    .select('id', { count: 'exact', head: true })
    .is('anchor_id', null)
    .gte('created_at', sinceIso)) as CountResponse;
  return requireCount('new_unlinked_in_window', response);
}

/** All public_records created in the window (idx_public_records_created_at). */
async function fetchRecordsCreatedInWindow(db: SupabaseDb, sinceIso: string): Promise<number> {
  const response = (await db
    .from('public_records')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', sinceIso)) as CountResponse;
  return requireCount('records_created_in_window', response);
}

/** Non-deleted anchors created in the window (idx_anchors_active_created). */
async function fetchAnchorsCreatedInWindow(db: SupabaseDb, sinceIso: string): Promise<number> {
  const response = (await db
    .from('anchors')
    .select('id', { count: 'exact', head: true })
    .is('deleted_at', null)
    .gte('created_at', sinceIso)) as CountResponse;
  return requireCount('anchors_created_in_window', response);
}

/**
 * Window-created anchors that reached the chain. The `created_at` bound keeps
 * the probe on the window's index range (never a chain_timestamp scan over
 * 2.9M rows); `chain_timestamp IS NOT NULL` marks on-chain confirmation.
 */
async function fetchAnchorsSecuredInWindow(db: SupabaseDb, sinceIso: string): Promise<number> {
  const response = (await db
    .from('anchors')
    .select('id', { count: 'exact', head: true })
    .is('deleted_at', null)
    .gte('created_at', sinceIso)
    .not('chain_timestamp', 'is', null)) as CountResponse;
  return requireCount('anchors_secured_in_window', response);
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

function emitThroughputAlert(
  decision: ThroughputAlertDecision,
  input: ThroughputAlertInput,
): void {
  try {
    // Aggregate metrics only (§1.4) — never per-document/user data.
    capturePipelineThroughputAlert(
      decision.reason,
      {
        source: 'pipeline-throughput-monitor',
        story: 'SCRUM-2901',
        new_unlinked_in_window: input.new_unlinked_in_window,
        records_created_in_window: input.records_created_in_window,
        anchors_created_in_window: input.anchors_created_in_window,
        anchors_secured_in_window: input.anchors_secured_in_window,
        unlinked_total: input.unlinked_total,
        window_hours: input.window_hours,
      },
      'error',
    );
  } catch (err) {
    logger.error({ error: err }, 'Pipeline throughput monitor: failed to emit Sentry alert');
  }
}

/**
 * End-to-end cron entry point. Runs the four bounded window probes plus the
 * best-effort cache context, evaluates the dead-man decision, and on a stall
 * logs at error level + fires the stable-fingerprint Sentry alert. Throws on
 * a broken core probe (route → 500 → Scheduler retry).
 */
export async function runPipelineThroughputMonitor(
  db: SupabaseDb,
  overrides: { windowHours?: number; now?: Date } = {},
): Promise<PipelineThroughputResult> {
  const now = overrides.now ?? new Date();
  const windowHours = overrides.windowHours ?? DEFAULT_THROUGHPUT_WINDOW_HOURS;
  const sinceIso = new Date(now.getTime() - windowHours * MS_PER_HOUR).toISOString();

  // Core probes: fail loud (throw → 500). Cache context: best-effort (null).
  const [
    newUnlinkedInWindow,
    recordsCreatedInWindow,
    anchorsCreatedInWindow,
    anchorsSecuredInWindow,
    pipelineStatsCache,
    statusCountsCache,
  ] = await Promise.all([
    fetchNewUnlinkedInWindow(db, sinceIso),
    fetchRecordsCreatedInWindow(db, sinceIso),
    fetchAnchorsCreatedInWindow(db, sinceIso),
    fetchAnchorsSecuredInWindow(db, sinceIso),
    fetchCacheValue(db, 'pipeline_stats'),
    fetchCacheValue(db, 'anchor_status_counts'),
  ]);

  const unlinkedTotal = parseUnlinkedTotal(pipelineStatsCache);
  const batchProgress = parseBatchProgress(statusCountsCache);

  const input: ThroughputAlertInput = {
    new_unlinked_in_window: newUnlinkedInWindow,
    anchors_secured_in_window: anchorsSecuredInWindow,
    records_created_in_window: recordsCreatedInWindow,
    anchors_created_in_window: anchorsCreatedInWindow,
    unlinked_total: unlinkedTotal,
    window_hours: windowHours,
  };
  const decision = decidePipelineThroughputAlert(input);

  const result: PipelineThroughputResult = {
    healthy: !decision.should_fire,
    alertFired: false,
    windowHours,
    newUnlinkedInWindow,
    recordsCreatedInWindow,
    anchorsCreatedInWindow,
    anchorsSecuredInWindow,
    unlinkedTotal,
    batchProgress,
    reason: decision.reason,
    checkedAt: now.toISOString(),
  };

  if (decision.should_fire) {
    logger.error(
      {
        newUnlinkedInWindow,
        recordsCreatedInWindow,
        anchorsCreatedInWindow,
        anchorsSecuredInWindow,
        unlinkedTotal,
        windowHours,
      },
      `Pipeline throughput monitor: ${decision.reason}`,
    );
    emitThroughputAlert(decision, input);
    result.alertFired = true;
  } else {
    logger.info(
      { newUnlinkedInWindow, anchorsSecuredInWindow, unlinkedTotal, windowHours },
      `Pipeline throughput monitor: ${decision.reason}`,
    );
  }

  return result;
}
