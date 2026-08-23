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
 *       stall threshold (default 48h) AND the backlog clears a minimum-count
 *       floor (default 500 — see DEFAULT_LINKER_STALL_MIN_BACKLOG). This is
 *       the exact motivating incident shape: a 255k+ backlog sits unlinked for
 *       weeks while OTHER anchor paths keep securing — condition A alone would
 *       never fire because prod's secured count always advances
 *       (independent-review CRITICAL, 2026-07-17). The count floor was added
 *       2026-08-17 after ONE stuck row aged to 388h and paged fatal every 30
 *       minutes for 16 days; below the floor the finding degrades to a
 *       warn-level log instead of a Sentry page.
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
 *     **unlinked_total is an ESTIMATE, not a count.** The deployed
 *     `refresh_cache_pipeline_stats()` derives it from
 *     `round(pg_class.reltuples * pg_stats.null_frac)` and self-declares
 *     `pending_record_links_approximate: true`. `null_frac` is an ANALYZE
 *     sample statistic quantized to multiples of 1/sample_size, so at prod's
 *     ~3.5M rows its smallest non-zero estimate is ~118 records: a genuine
 *     backlog of 1 reads as 0 in most ANALYZE epochs — and as ~118 in the
 *     epochs whose sample happens to catch the row.
 *     `resolveUnlinkedBacklog` reconciles it against the LIMIT-1 probes (which
 *     are exact existence tests) so the alert can never again claim
 *     "backlog 0" while reporting a stuck record.
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

/**
 * Minimum unlinked backlog for condition B to escalate on AGE (2026-08 alert
 * storm).
 *
 * Condition B originally fired on the age of the oldest unlinked record with no
 * magnitude qualifier at all. On 2026-08-17 prod held 3,538,743 public records,
 * 3,538,742 of them linked and exactly ONE unlinked. That single orphan was
 * ~388h old, which maps to the `t168h` bucket, which returns `fatal` — so a
 * monitor on a ~30-minute cadence emitted a FATAL Sentry event every half hour
 * for ~16 days (~670 events) over one row. A stuck row is an operational
 * nuisance with a per-row remedy; it is not the pipeline-integrity outage this
 * dead-man exists to catch.
 *
 * Why 500 specifically:
 *
 *  - **Lower bound — the floor must clear the estimator's SMALLEST EXPRESSIBLE
 *    non-zero value, with headroom.** `unlinked_total` comes from
 *    `pipeline_dashboard_cache`, whose `refresh_cache_pipeline_stats()`
 *    computes `round(pg_class.reltuples * pg_stats.null_frac)`. `null_frac` is
 *    an ANALYZE sample statistic (~30k rows at the default statistics target),
 *    so it is QUANTIZED to multiples of 1/sample_size: at prod's ~3.5M rows,
 *    ONE sampled stuck row estimates round(3.5M / 30k) ≈ 118 — the estimator
 *    can emit 0 or ~118, never anything in between. The floor's first value
 *    (100) sat BELOW that quantum, so in the ~1% of ANALYZE cycles whose
 *    sample happened to catch the single stuck row, the cache read ≈118 ≥ 100
 *    and the fatal storm re-armed for that ANALYZE epoch. The quantum also
 *    grows linearly with the table (rows / sample), so the floor needs growth
 *    headroom: 500 stays above one quantum until ~15M rows (~4x today's
 *    table).
 *  - **Upper bound — a real stall crosses it immediately.** The nightly flush
 *    moves ~10,000 anchors per drain, so one missed linker cycle leaves 20x
 *    this floor. The motivating 2026-07 incident was 259,000 — 500x. The floor
 *    therefore costs no sensitivity for the incident class the monitor was
 *    built for.
 *  - **It stays honest for a small tenant.** A floor at batch scale (10,000)
 *    would blind the monitor to a pipeline whose entire daily volume is a few
 *    hundred records. 500 clears the estimator's quantum with headroom while
 *    staying an order of magnitude under one drain.
 *
 * Below the floor the finding is NOT discarded — it degrades to a warn-level
 * structured log (see `runPipelineThroughputMonitor`). Sentry is the paging
 * channel; a sub-floor stuck row belongs in the ops log, not on a pager.
 */
export const DEFAULT_LINKER_STALL_MIN_BACKLOG = 500;

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * `warning` is the sub-floor condition-B verdict: a real finding that is
 * deliberately routed to a structured log instead of a Sentry page.
 */
export type AlertSeverity = 'info' | 'warning' | 'error' | 'fatal';

// ─── Sustained-failure escalation (SCRUM-3050) ───────────────────────────────
//
// This monitor detected the 70h anchoring outage correctly and fired every
// ~30 minutes for 70+ hours with an accurate diagnosis. Nobody saw it. Every
// re-fire carried ONE stable fingerprint, so ~140 events collapsed into a
// single Sentry issue that was created once and then aged silently — a
// dead-man switch that gets QUIETER the longer the outage runs.
//
// The fix keeps the anti-flood property (a stall does not mint an issue every
// 30 minutes) while restoring escalation: the fingerprint carries a duration
// BUCKET, so crossing 24h / 48h / 72h / 1w opens a genuinely new Sentry issue
// and re-triggers any FirstSeenEventCondition rule, and the level escalates
// error -> fatal so a separate, louder rule can key on the sustained case.
//
// The duration is derived purely from inputs already measured — no state
// table, no migration, preserving the DB-stateless design.

export type SustainedBucket = 't0' | 't24h' | 't48h' | 't72h' | 't168h';

/** Bucket lower bounds in hours, widest last. */
export const SUSTAINED_BUCKET_HOURS: ReadonlyArray<readonly [SustainedBucket, number]> = [
  ['t168h', 168],
  ['t72h', 72],
  ['t48h', 48],
  ['t24h', 24],
] as const;

/**
 * Map a failure duration in hours onto an escalating bucket.
 *
 * `null` means the duration is UNBOUNDED (e.g. no anchor has ever secured, so
 * "how long has securing been dead" has no measurable start). That is the
 * worst case, so it escalates to the TOP bucket. Resolving an unknown duration
 * to the mildest bucket would be the classic "no data therefore healthy" bug —
 * the same failure mode `ce-key-expiry-alert.ts` guards with its SENTINEL path.
 */
export function sustainedBucketFor(hours: number | null): SustainedBucket {
  if (hours === null) return 't168h';
  for (const [bucket, lowerBound] of SUSTAINED_BUCKET_HOURS) {
    if (hours >= lowerBound) return bucket;
  }
  return 't0';
}

/**
 * Level for a bucket. Past 72h — three full nightly flush cycles — a stall is
 * no longer "degraded", it is an outage, and the level must clear a stricter
 * alert-rule gate than the routine error stream.
 */
export function severityForSustainedBucket(bucket: SustainedBucket): 'error' | 'fatal' {
  return bucket === 't72h' || bucket === 't168h' ? 'fatal' : 'error';
}

export interface ThroughputAlertInput {
  /** Age in hours of the NEWEST unlinked public record; null when none/unparseable. */
  latest_unlinked_age_hours: number | null;
  /** Age in hours of the OLDEST unlinked public record; null when none/unparseable. */
  oldest_unlinked_age_hours: number | null;
  /** Age in hours of the most recent SECURED chain_timestamp; null when none/unparseable. */
  last_secured_age_hours: number | null;
  /** Total unlinked backlog from pipeline_dashboard_cache; null when unavailable. */
  unlinked_total: number | null;
  /**
   * True when `unlinked_total` is a sampled ESTIMATE rather than a count — the
   * deployed `refresh_cache_pipeline_stats()` sets
   * `pending_record_links_approximate: true` alongside the figure. Drives the
   * `~` marker in the reason string so an estimate is never reported as a
   * measurement (§1.5). Defaults to false when the cache row does not say.
   */
  unlinked_total_approximate?: boolean;
  window_hours: number;
  linker_stall_threshold_hours: number;
  /**
   * Minimum backlog for condition B to escalate on age alone. Defaults to
   * `DEFAULT_LINKER_STALL_MIN_BACKLOG`.
   */
  linker_stall_min_backlog?: number;
}

export interface ThroughputAlertDecision {
  should_fire: boolean;
  severity: AlertSeverity;
  reason: string;
  /**
   * How long the firing condition has held, in hours. `null` when unbounded
   * (nothing has ever secured) or when not firing.
   */
  sustained_hours: number | null;
  /** Escalation bucket; appended to the Sentry fingerprint. */
  sustained_bucket: SustainedBucket;
  /**
   * True when condition B held but the measured backlog is below
   * `linker_stall_min_backlog`. Such a finding is logged, never paged.
   */
  below_backlog_floor: boolean;
}

/** What is actually KNOWN about the unlinked backlog for this evaluation. */
export interface UnlinkedBacklogView {
  /**
   * Best available figure, already reconciled against the live probe; `null`
   * when the cache is unavailable and nothing can honestly be claimed.
   */
  value: number | null;
  /** True when a LIMIT-1 probe actually found an unlinked record. */
  live_unlinked_observed: boolean;
  /** True when the cached figure claims 0 while the live probe found a row. */
  cache_contradicted: boolean;
  /** Carried through from the cache row's self-declared approximation flag. */
  approximate: boolean;
}

/**
 * Reconcile the cache-backed backlog figure against the live LIMIT-1 probes.
 *
 * The cached `pending_record_links` is `round(reltuples * null_frac)` — a
 * sampled estimate with a resolution floor of roughly (rows / sample size).
 * At prod scale that is ~118 rows, so a genuine backlog of 1 reads as 0. The
 * probes, meanwhile, are exact existence tests: if `oldest_unlinked_age_hours`
 * is non-null, a row was returned, so the true backlog is at least 1. When the
 * two disagree the probe wins and the disagreement is reported, because the
 * alternative is the alert text that started this: "oldest unlinked public
 * record is 388h old ... (total unlinked backlog 0)".
 */
export function resolveUnlinkedBacklog(input: ThroughputAlertInput): UnlinkedBacklogView {
  const liveUnlinkedObserved =
    input.oldest_unlinked_age_hours !== null || input.latest_unlinked_age_hours !== null;
  const approximate = input.unlinked_total_approximate === true;

  if (input.unlinked_total === null) {
    return {
      value: null,
      live_unlinked_observed: liveUnlinkedObserved,
      cache_contradicted: false,
      approximate,
    };
  }

  const cacheContradicted = liveUnlinkedObserved && input.unlinked_total < 1;
  return {
    value: cacheContradicted ? 1 : input.unlinked_total,
    live_unlinked_observed: liveUnlinkedObserved,
    cache_contradicted: cacheContradicted,
    approximate,
  };
}

/**
 * Reason-string suffix describing the backlog. Never asserts a figure the
 * evidence does not support: unavailable stays "unavailable", a contradicted
 * zero becomes the probe-proven lower bound, and a sampled estimate is marked
 * with `~` rather than presented as a count.
 */
function describeUnlinkedBacklog(view: UnlinkedBacklogView): string {
  if (view.value === null) return ' (total unlinked backlog unavailable)';
  if (view.cache_contradicted) {
    return (
      ' (total unlinked backlog at least 1 — the cached figure read 0, which the live probe ' +
      'contradicts: pending_record_links is a sampled estimate, not a count)'
    );
  }
  return ` (total unlinked backlog ${view.approximate ? '~' : ''}${view.value})`;
}

/**
 * Pure decision function — no I/O. Condition A (total securing death) takes
 * precedence over condition B (linker stall) when both hold. Counts-free,
 * aggregate-age reason strings (PII-safe by construction).
 */
export function decidePipelineThroughputAlert(
  input: ThroughputAlertInput,
): ThroughputAlertDecision {
  const backlog = resolveUnlinkedBacklog(input);
  const totalSuffix = describeUnlinkedBacklog(backlog);

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
    // Duration of the silent failure = time since the last securing event.
    // Null (nothing ever secured) is unbounded -> top bucket.
    const sustainedHours = input.last_secured_age_hours;
    const bucket = sustainedBucketFor(sustainedHours);
    return {
      should_fire: true,
      severity: severityForSustainedBucket(bucket),
      sustained_hours: sustainedHours,
      sustained_bucket: bucket,
      // The count floor gates condition B only. Condition A means NOTHING
      // secured network-wide inside the window while feeders demonstrably
      // produced a record — an outage regardless of how many records wait.
      below_backlog_floor: false,
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
    // Duration of the stall = how long the oldest unlinked record has waited.
    const sustainedHours = input.oldest_unlinked_age_hours;
    const bucket = sustainedBucketFor(sustainedHours);
    const minBacklog = input.linker_stall_min_backlog ?? DEFAULT_LINKER_STALL_MIN_BACKLOG;

    // Count floor. A KNOWN-small backlog cannot escalate on age alone — that is
    // the 2026-08 alert storm (one 388h-old orphan paging fatal every 30
    // minutes for 16 days). An UNKNOWN backlog (cache unavailable, value null)
    // deliberately does NOT take this branch: resolving "no data" to "small"
    // would be the same fail-quiet bug `sustainedBucketFor` already refuses for
    // an unbounded duration.
    if (backlog.value !== null && backlog.value < minBacklog) {
      return {
        should_fire: true,
        severity: 'warning',
        sustained_hours: sustainedHours,
        sustained_bucket: bucket,
        below_backlog_floor: true,
        reason:
          `Pipeline linker stall (sub-threshold backlog): oldest unlinked public record is ` +
          `${input.oldest_unlinked_age_hours}h old, exceeds ` +
          `${input.linker_stall_threshold_hours}h threshold${totalSuffix} — below the ` +
          `${minBacklog}-record escalation floor, so this is a stuck-record nuisance to clear ` +
          'by hand, not a pipeline stall to page on',
      };
    }

    return {
      should_fire: true,
      severity: severityForSustainedBucket(bucket),
      sustained_hours: sustainedHours,
      sustained_bucket: bucket,
      below_backlog_floor: false,
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
      sustained_hours: null,
      sustained_bucket: 't0',
      below_backlog_floor: false,
      reason:
        'No unlinked public records — nothing to convert (feeder-death monitoring is ' +
        'SCRUM-2900, not this monitor)',
    };
  }

  return {
    should_fire: false,
    severity: 'info',
    sustained_hours: null,
    sustained_bucket: 't0',
    below_backlog_floor: false,
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
  /**
   * True only when a Sentry alert was actually emitted. A sub-floor condition-B
   * finding is `healthy: false, alertFired: false` — a real finding that was
   * deliberately logged rather than paged.
   */
  alertFired: boolean;
  windowHours: number;
  linkerStallThresholdHours: number;
  /** Minimum backlog for condition B to escalate on age (2026-08 alert storm). */
  linkerStallMinBacklog: number;
  /** True when condition B held but the backlog is below the escalation floor. */
  belowBacklogFloor: boolean;
  /** Age in hours of the newest unlinked public record; null when none. */
  latestUnlinkedAgeHours: number | null;
  /** Age in hours of the oldest unlinked public record; null when none. */
  oldestUnlinkedAgeHours: number | null;
  /** Age in hours of the most recent SECURED chain_timestamp; null when none. */
  lastSecuredAgeHours: number | null;
  /** Cache-backed total unlinked backlog (pipeline_stats.pending_record_links); null when unavailable. */
  unlinkedTotal: number | null;
  /**
   * True when the cache row self-declares `pending_record_links_approximate`.
   * The deployed fast-stats refresh derives the figure from
   * `reltuples * null_frac`, so it is a sampled estimate — reported as such
   * rather than as a count (§1.5 measured vs asserted).
   */
  unlinkedTotalApproximate: boolean;
  /** Cache-backed anchors-by-status counts (anchor_status_counts); null when unavailable. */
  batchProgress: Record<string, number> | null;
  reason: string;
  /** Hours the firing condition has held; null when unbounded or not firing. */
  sustainedHours: number | null;
  /** Escalation bucket carried into the Sentry fingerprint (SCRUM-3050). */
  sustainedBucket: SustainedBucket;
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

/**
 * Whether the cached backlog figure is a sampled ESTIMATE.
 *
 * The deployed `refresh_cache_pipeline_stats()` (SCRUM-1708 fast stats) writes
 * `pending_record_links_approximate: true` next to a value it derived from
 * `round(pg_class.reltuples * pg_stats.null_frac)`. Older refresh variants
 * wrote a real `count(*)` and no flag, so absence means "exact" and the marker
 * is only claimed when the cache row asserts it.
 */
function parseUnlinkedTotalApproximate(cacheValue: Record<string, unknown> | null): boolean {
  return cacheValue?.pending_record_links_approximate === true;
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
    capturePipelineThroughputAlert(
      decision.reason,
      {
        source: 'pipeline-throughput-monitor',
        story: 'SCRUM-2901',
        latest_unlinked_age_hours: input.latest_unlinked_age_hours,
        oldest_unlinked_age_hours: input.oldest_unlinked_age_hours,
        last_secured_age_hours: input.last_secured_age_hours,
        unlinked_total: input.unlinked_total,
        window_hours: input.window_hours,
        linker_stall_threshold_hours: input.linker_stall_threshold_hours,
        sustained_hours: decision.sustained_hours,
        sustained_bucket: decision.sustained_bucket,
      },
      {
        sustainedBucket: decision.sustained_bucket,
        level: severityForSustainedBucket(decision.sustained_bucket),
      },
    );
  } catch (err) {
    logger.error({ error: err }, 'Pipeline throughput monitor: failed to emit Sentry alert');
  }
}

/**
 * End-to-end cron entry point. Runs the three LIMIT-1 timestamp probes plus
 * best-effort cache context, evaluates both dead-man conditions, and:
 *
 *   - fires the stable-fingerprint Sentry alert + an error log on a real stall;
 *   - logs at WARN and fires nothing when condition B held but the backlog is
 *     below `linkerStallMinBacklog` (the 2026-08 alert storm — see
 *     `DEFAULT_LINKER_STALL_MIN_BACKLOG`);
 *   - logs at INFO when converting normally.
 *
 * Throws on a broken core probe (route → 500 → Scheduler retry).
 */
export async function runPipelineThroughputMonitor(
  db: SupabaseDb,
  overrides: {
    windowHours?: number;
    linkerStallThresholdHours?: number;
    linkerStallMinBacklog?: number;
    now?: Date;
  } = {},
): Promise<PipelineThroughputResult> {
  const now = overrides.now ?? new Date();
  const windowHours = overrides.windowHours ?? DEFAULT_THROUGHPUT_WINDOW_HOURS;
  const linkerStallThresholdHours =
    overrides.linkerStallThresholdHours ?? DEFAULT_LINKER_STALL_THRESHOLD_HOURS;
  const linkerStallMinBacklog =
    overrides.linkerStallMinBacklog ?? DEFAULT_LINKER_STALL_MIN_BACKLOG;

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
  const unlinkedTotalApproximate = parseUnlinkedTotalApproximate(pipelineStatsCache);
  const batchProgress = parseBatchProgress(statusCountsCache);

  const input: ThroughputAlertInput = {
    latest_unlinked_age_hours: latestUnlinkedAgeHours,
    oldest_unlinked_age_hours: oldestUnlinkedAgeHours,
    last_secured_age_hours: lastSecuredAgeHours,
    unlinked_total: unlinkedTotal,
    unlinked_total_approximate: unlinkedTotalApproximate,
    window_hours: windowHours,
    linker_stall_threshold_hours: linkerStallThresholdHours,
    linker_stall_min_backlog: linkerStallMinBacklog,
  };
  const decision = decidePipelineThroughputAlert(input);

  const result: PipelineThroughputResult = {
    healthy: !decision.should_fire,
    alertFired: false,
    windowHours,
    linkerStallThresholdHours,
    linkerStallMinBacklog,
    belowBacklogFloor: decision.below_backlog_floor,
    latestUnlinkedAgeHours,
    oldestUnlinkedAgeHours,
    lastSecuredAgeHours,
    unlinkedTotal,
    unlinkedTotalApproximate,
    batchProgress,
    reason: decision.reason,
    sustainedHours: decision.sustained_hours,
    sustainedBucket: decision.sustained_bucket,
    checkedAt: now.toISOString(),
  };

  const logContext = {
    latestUnlinkedAgeHours,
    oldestUnlinkedAgeHours,
    lastSecuredAgeHours,
    unlinkedTotal,
    unlinkedTotalApproximate,
    windowHours,
    linkerStallThresholdHours,
    linkerStallMinBacklog,
  };

  if (decision.below_backlog_floor) {
    // Visible, not paged. Sentry is the paging channel and a sub-floor stuck
    // row has a per-row remedy, so it lands in Cloud Logging at warn level with
    // a stable marker a log-based metric can key on without a code change.
    logger.warn(
      { ...logContext, belowBacklogFloor: true, pipelineStuckRecordSubFloor: true },
      `Pipeline throughput monitor: ${decision.reason}`,
    );
  } else if (decision.should_fire) {
    logger.error(logContext, `Pipeline throughput monitor: ${decision.reason}`);
    emitThroughputAlert(decision, input);
    result.alertFired = true;
  } else {
    logger.info(logContext, `Pipeline throughput monitor: ${decision.reason}`);
  }

  return result;
}
