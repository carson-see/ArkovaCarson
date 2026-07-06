/**
 * OPS-03 SLO Dashboard Stats — Arkova Internal Only (SCRUM-2401)
 *
 * GET /api/admin/ops-slo-stats
 *
 * Read-only rollup over four existing SLO signals, computed LIVE on every
 * request rather than persisted anywhere new (no migration — see agents.md
 * for why: this story is scoped non-migration, T2). Every surface is
 * independently fail-open: one surface's read failing sets that surface's
 * `available: false` and never blanks the other three (mirrors
 * `admin-pipeline-stats.ts` / `PipelineAdminPage`'s per-field null pattern).
 *
 * Surfaces:
 *  - anchorSecuredRate — reads the EXISTING `get_anchor_status_counts_fast()`
 *    RPC (migration 0324; backed by the `pipeline_dashboard_cache` cron
 *    refresh). No new query added.
 *  - connectorQueue — `connector_artifact` (migration 0343) grouped by
 *    status. depth = drainable (pending|queued) + materialized-awaiting-
 *    confirmation rows (mirrors `connector-artifact-drain.ts` WORK_STATUSES).
 *  - creditConservation — calls the SAME `org_credit_ledger_divergence` RPC
 *    the `credit-conservation-reconciler.ts` cron already calls (service_role
 *    EXECUTE only — the RPC has no `authenticated` grant, so this worker
 *    endpoint is the only way a browser can see conservation state). Output
 *    is PII-safe by construction: identity + count only, NEVER raw
 *    balance/divergence numbers (mirrors the reconciler's Sentry alert
 *    shape — see `bucketDivergence` in credit-conservation-reconciler.ts).
 *  - webhookDelivery — `webhook_delivery_logs` (existing table) over a
 *    rolling 24h window, success vs (failed|pending>backoff) rate.
 *
 * §1.4: gated on `is_platform_admin` via the shared `isPlatformAdmin` helper,
 * same as every other `/api/admin/*` handler. service_role db client
 * bypasses RLS by design (this is a cross-org operational view).
 */

import type { Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import { db } from '../utils/db.js';
import { isPlatformAdmin } from '../utils/platformAdmin.js';
import { callRpc } from '../utils/rpc.js';

/** Rolling window for the webhook delivery success-rate surface. */
const WEBHOOK_WINDOW_HOURS = 24;

/** Rolling window for the verification-API error-rate surface. */
const API_ERROR_WINDOW_HOURS = 24;

/** SLO breach thresholds. Conservative, ops-tunable constants (not user copy). */
const ANCHOR_SECURED_RATE_BREACH_BELOW = 0.9;
const WEBHOOK_SUCCESS_RATE_BREACH_BELOW = 0.9;
/** A connector queue depth above this is a breach signal (backlog building). */
const CONNECTOR_QUEUE_DEPTH_BREACH_ABOVE = 500;
/** API error-rate breach: STRICTLY above this fraction of `result='error'`. */
const API_ERROR_RATE_BREACH_ABOVE = 0.05;

export interface AnchorSecuredRateSurface {
  available: boolean;
  securedCount: number | null;
  totalCount: number | null;
  ratePct: number | null;
  cacheUpdatedAt: string | null;
  breach: boolean;
  error: string | null;
}

export interface ConnectorQueueSurface {
  available: boolean;
  /** Drainable (pending|queued) + materialized-awaiting-confirmation rows. */
  depth: number | null;
  anchored: number | null;
  failed: number | null;
  breach: boolean;
  error: string | null;
}

export interface CreditConservationSurface {
  available: boolean;
  orgsChecked: number | null;
  divergedCount: number | null;
  /** Identity only (org_id) — never a raw balance/divergence value (§1.4/PII). */
  divergedOrgIds: string[];
  breach: boolean;
  error: string | null;
}

export interface WebhookDeliverySurface {
  available: boolean;
  successCount: number | null;
  totalCount: number | null;
  ratePct: number | null;
  windowHours: number;
  breach: boolean;
  error: string | null;
}

export interface ApiErrorsSurface {
  available: boolean;
  /** verification_events rows with result='error' in the window. */
  errorCount: number | null;
  totalCount: number | null;
  errorRatePct: number | null;
  windowHours: number;
  breach: boolean;
  error: string | null;
}

export interface OpsSloStatsResponse {
  anchorSecuredRate: AnchorSecuredRateSurface;
  connectorQueue: ConnectorQueueSurface;
  creditConservation: CreditConservationSurface;
  webhookDelivery: WebhookDeliverySurface;
  apiErrors: ApiErrorsSurface;
  overallBreach: boolean;
  checkedAt: string;
}

function toNonNegativeCount(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** The -1 sentinel means the backing cache hasn't been populated yet (SCRUM-2189). */
function isSentinelUnavailable(value: unknown): boolean {
  return typeof value === 'number' && value < 0;
}

async function readAnchorSecuredRate(): Promise<AnchorSecuredRateSurface> {
  const unavailable = (error: string): AnchorSecuredRateSurface => ({
    available: false,
    securedCount: null,
    totalCount: null,
    ratePct: null,
    cacheUpdatedAt: null,
    breach: false,
    error,
  });

  try {
    const { data, error } = await callRpc<Record<string, unknown>>(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db as any,
      'get_anchor_status_counts_fast',
    );
    if (error) return unavailable(error.message);
    if (!data || typeof data !== 'object') return unavailable('malformed response');

    const total = data.total;
    const secured = data.SECURED;
    if (isSentinelUnavailable(total) || isSentinelUnavailable(secured)) {
      return unavailable('cache not yet populated (sentinel)');
    }

    const totalCount = toNonNegativeCount(total);
    const securedCount = toNonNegativeCount(secured);
    if (totalCount === null || securedCount === null) return unavailable('malformed counts');

    const ratePct = totalCount === 0 ? null : (securedCount / totalCount) * 100;
    const breach = totalCount > 0 && ratePct !== null && ratePct / 100 < ANCHOR_SECURED_RATE_BREACH_BELOW;

    return {
      available: true,
      securedCount,
      totalCount,
      ratePct,
      cacheUpdatedAt: null,
      breach,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'anchor status counts read failed';
    logger.warn({ error: err }, 'ops-slo-stats: anchor secured rate read failed');
    return unavailable(message);
  }
}

/** Statuses that mean a connector_artifact row still has work outstanding
 * (mirrors `connector-artifact-drain.ts` WORK_STATUSES + in-flight `processing`). */
const CONNECTOR_WORK_STATUSES = ['pending', 'queued', 'processing', 'materialized'] as const;

/** Shape of a PostgREST head-count response (`{ count: 'exact', head: true }`). */
interface CountResult {
  count: number | null;
  error: { message?: string } | null;
}

async function readConnectorQueue(): Promise<ConnectorQueueSurface> {
  const unavailable = (error: string): ConnectorQueueSurface => ({
    available: false,
    depth: null,
    anchored: null,
    failed: null,
    breach: false,
    error,
  });

  try {
    // Server-side status counts — never a row sample. An unordered/limited row
    // scan of a table that can hold millions returns an ARBITRARY subset, so a
    // 500k backlog could read as "healthy" if the sample happened to be mostly
    // terminal rows — inverting the dashboard's purpose. We use ESTIMATED
    // (planner-based) counts, not `exact`: an exact count is a full index scan
    // on every 30s poll (the R0-8 / SCRUM-1254 exact-count perf guard), and a
    // health gauge only needs "roughly how deep" against a coarse breach
    // threshold — the planner estimate over the (org_id, status) index from
    // migration 0343 answers that cheaply (no rows transferred, no full scan).
    // `connector_artifact` isn't in the generated database.types.ts yet (same
    // escape hatch as connector-artifact-drain.ts).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const table = () => (db as any).from('connector_artifact');
    const [workRes, anchoredRes, failedRes] = (await Promise.all([
      table().select('*', { count: 'estimated', head: true }).in('status', [...CONNECTOR_WORK_STATUSES]),
      table().select('*', { count: 'estimated', head: true }).eq('status', 'anchored'),
      table().select('*', { count: 'estimated', head: true }).eq('status', 'failed'),
    ])) as [CountResult, CountResult, CountResult];

    for (const res of [workRes, anchoredRes, failedRes]) {
      if (res.error) return unavailable(res.error.message ?? 'connector_artifact count failed');
      if (typeof res.count !== 'number') return unavailable('connector_artifact count missing');
    }

    const depth = workRes.count as number;
    const anchored = anchoredRes.count as number;
    const failed = failedRes.count as number;
    const breach = depth > CONNECTOR_QUEUE_DEPTH_BREACH_ABOVE;

    return { available: true, depth, anchored, failed, breach, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'connector_artifact read failed';
    logger.warn({ error: err }, 'ops-slo-stats: connector queue read failed');
    return unavailable(message);
  }
}

interface DivergenceRow {
  org_id: string;
  diverged: boolean;
}

/** Cap the identity list carried in the response — aggregate count is always exact. */
const MAX_DIVERGED_ORG_IDS = 50;

async function readCreditConservation(): Promise<CreditConservationSurface> {
  const unavailable = (error: string): CreditConservationSurface => ({
    available: false,
    orgsChecked: null,
    divergedCount: null,
    divergedOrgIds: [],
    breach: false,
    error,
  });

  try {
    // Same RPC + all-orgs sweep as `runCreditConservationReconciler` — this
    // handler does NOT read any persisted reconciler output (the reconciler
    // is read-only and writes nothing); it re-runs the identical live query.
    const { data, error } = await callRpc<DivergenceRow[]>(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db as any,
      'org_credit_ledger_divergence',
    );
    if (error) return unavailable(error.message);
    if (!Array.isArray(data)) return unavailable('malformed response');

    const orgsChecked = data.length;
    const divergedOrgIds = data.filter((r) => r.diverged === true).map((r) => r.org_id);
    const divergedCount = divergedOrgIds.length;
    const breach = divergedCount > 0;

    return {
      available: true,
      orgsChecked,
      divergedCount,
      // Identity only, capped — never a raw balance/divergence value (§1.4).
      divergedOrgIds: divergedOrgIds.slice(0, MAX_DIVERGED_ORG_IDS),
      breach,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'credit ledger divergence read failed';
    logger.warn({ error: err }, 'ops-slo-stats: credit conservation read failed');
    return unavailable(message);
  }
}

async function readWebhookDelivery(): Promise<WebhookDeliverySurface> {
  const unavailable = (error: string): WebhookDeliverySurface => ({
    available: false,
    successCount: null,
    totalCount: null,
    ratePct: null,
    windowHours: WEBHOOK_WINDOW_HOURS,
    breach: false,
    error,
  });

  try {
    const sinceIso = new Date(Date.now() - WEBHOOK_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
    const { data, error } = await db
      .from('webhook_delivery_logs')
      .select('status')
      .gte('created_at', sinceIso)
      .limit(50_000);

    if (error) return unavailable((error as { message?: string }).message ?? 'webhook_delivery_logs select failed');
    if (!Array.isArray(data)) return unavailable('malformed webhook_delivery_logs response');

    let successCount = 0;
    const totalCount = data.length;
    for (const row of data as Array<{ status?: string }>) {
      if (row.status === 'success') successCount += 1;
    }

    const ratePct = totalCount === 0 ? null : (successCount / totalCount) * 100;
    const breach = totalCount > 0 && ratePct !== null && ratePct / 100 < WEBHOOK_SUCCESS_RATE_BREACH_BELOW;

    return {
      available: true,
      successCount,
      totalCount,
      ratePct,
      windowHours: WEBHOOK_WINDOW_HOURS,
      breach,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'webhook delivery read failed';
    logger.warn({ error: err }, 'ops-slo-stats: webhook delivery read failed');
    return unavailable(message);
  }
}

/**
 * Verification-API error rate over a rolling window, read from the EXISTING
 * `verification_events` table (baseline schema; `result` is CHECK-constrained
 * to verified|revoked|not_found|error). `error` = the API failed to serve the
 * request; verified/revoked/not_found are all successfully-served outcomes.
 * This is the persisted API request-outcome log — the worker keeps no other
 * durable per-request error metric (rate-limit + query stats are in-memory).
 */
async function readApiErrors(): Promise<ApiErrorsSurface> {
  const unavailable = (error: string): ApiErrorsSurface => ({
    available: false,
    errorCount: null,
    totalCount: null,
    errorRatePct: null,
    windowHours: API_ERROR_WINDOW_HOURS,
    breach: false,
    error,
  });

  try {
    const sinceIso = new Date(Date.now() - API_ERROR_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
    const { data, error } = await db
      .from('verification_events')
      .select('result')
      .gte('created_at', sinceIso)
      .limit(50_000);

    if (error) return unavailable((error as { message?: string }).message ?? 'verification_events select failed');
    if (!Array.isArray(data)) return unavailable('malformed verification_events response');

    let errorCount = 0;
    const totalCount = data.length;
    for (const row of data as Array<{ result?: string }>) {
      if (row.result === 'error') errorCount += 1;
    }

    const errorRatePct = totalCount === 0 ? null : (errorCount / totalCount) * 100;
    const breach = totalCount > 0 && errorRatePct !== null && errorRatePct / 100 > API_ERROR_RATE_BREACH_ABOVE;

    return {
      available: true,
      errorCount,
      totalCount,
      errorRatePct,
      windowHours: API_ERROR_WINDOW_HOURS,
      breach,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'verification events read failed';
    logger.warn({ error: err }, 'ops-slo-stats: api error-rate read failed');
    return unavailable(message);
  }
}

export async function handleOpsSloStats(
  userId: string,
  _req: Request,
  res: Response,
): Promise<void> {
  // Fail-closed: any error here throws before data reads fire (the route
  // wrapper's catch answers 500; no SLO query runs for an unverified caller).
  const isAdmin = await isPlatformAdmin(userId);
  if (!isAdmin) {
    res.status(403).json({ error: 'Forbidden — platform admin access required' });
    return;
  }

  const [anchorSecuredRate, connectorQueue, creditConservation, webhookDelivery, apiErrors] = await Promise.all([
    readAnchorSecuredRate(),
    readConnectorQueue(),
    readCreditConservation(),
    readWebhookDelivery(),
    readApiErrors(),
  ]);

  const overallBreach =
    anchorSecuredRate.breach || connectorQueue.breach || creditConservation.breach
    || webhookDelivery.breach || apiErrors.breach;

  res.json({
    anchorSecuredRate,
    connectorQueue,
    creditConservation,
    webhookDelivery,
    apiErrors,
    overallBreach,
    checkedAt: new Date().toISOString(),
  } satisfies OpsSloStatsResponse);
}
