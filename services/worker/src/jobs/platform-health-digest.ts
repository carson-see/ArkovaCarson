/**
 * Platform Admin Daily Health Digest (pure engine)
 *
 * The capability audit (email/auth/admin session, 2026-08) found only a
 * conditional stuck-anchor ALERT hardcoded to `carson@arkova.ai`
 * (`pipeline-health.ts`) and a pull-only JSON dashboard endpoint
 * (`api/admin-health.ts`) — no routine "here is today's platform state" push
 * existed in any form. This is that digest: one daily summary email to every
 * platform admin (sourced from `profiles.is_platform_admin = true`, never a
 * hardcoded address), independent of and additional to the existing
 * stuck-anchor alert, which stays exactly as it is (a different, correctly
 * alert-shaped signal — this is a routine digest, not a threshold alarm).
 *
 * Sections: anchors by status (bounded backlog depth + 24h-new counts),
 * job_queue depth/oldest, last night's batch flush result, connector health
 * rollup (aggregate across orgs — never a per-org detail), and quota
 * anomalies (test-tier orgs at/over their `org_credits.anchor_quota` cap).
 * A Sentry-reported error count was scoped in the original ask but is
 * DELIBERATELY OMITTED: no existing table stores it, and adding a live
 * Sentry API dependency to a daily cron was explicitly ruled out.
 *
 * §1.6: every field here is an aggregate count or a platform-wide rollup —
 * never a document, filename, fingerprint, or another user's PII beyond the
 * platform admin's own recipient email. `assertNoRawContent` (imported from
 * the sibling `queue-digest.ts` guard — same guarantee, one implementation)
 * is the runtime backstop. §1.3: user-visible copy avoids banned crypto
 * terms — internal field names like `connectorId`/`latestTxid` are code, not
 * copy, and never surface as literal labels in the rendered text.
 *
 * §1.5: a metric that could not be safely/cheaply measured is represented as
 * `null`, rendered as "not measured" — never coerced to `0`, which would be
 * a false assertion of health. See `platform-health-digest-cron.ts` for
 * which reads use bounded/capped counts (never a full-table COUNT(*) on the
 * `anchors` table — see the STUCK_CAP precedent + its own postmortem in
 * `pipeline-health.ts`) and which degrade to null on a read error.
 *
 * Delivery is plain-text-first (per CTO instruction): the entire report body
 * is one escaped, line-oriented text block inside a single `<pre>`, wrapped
 * by the SAME `wrapTemplate`/`esc`/`formatUtc` helpers every other Arkova
 * email uses — no new template mechanism, no HTML table.
 */

import { esc, SHARED_STYLES, wrapTemplate, formatUtc } from '../emails/_template.js';
import { assertNoRawContent } from './queue-digest.js';
import type { SendResult } from '../email/sender.js';

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot model — aggregate counts + rollups ONLY.
// ─────────────────────────────────────────────────────────────────────────────

/** One anchor status's backlog depth (bounded) and 24h-new count (bounded). */
export interface AnchorStatusMetric {
  status: string;
  /** Bounded current backlog depth. `null` when deliberately not measured
   * for this status (terminal/huge statuses — see module header). */
  currentDepth: number | null;
  /** True when `currentDepth` hit its read cap (true depth may be higher). */
  currentDepthCapped: boolean;
  /** Anchors that reached `created_at` within the last 24h in this status (bounded). */
  new24h: number;
  new24hCapped: boolean;
}

export interface JobQueueMetrics {
  pendingDepth: number;
  pendingDepthCapped: boolean;
  /** Age of the oldest pending job, in minutes. `null` when the queue is empty. */
  oldestPendingAgeMinutes: number | null;
}

/** Last night's (or today's) batch-flush activity in the last 24h. */
export interface BatchFlushMetrics {
  fired: boolean;
  batchesLast24h: number;
  totalAnchorsLast24h: number;
  latestTxid: string | null;
  latestSignedAt: string | null;
}

export type ConnectorState = 'connected' | 'degraded' | 'disconnected';

/** Platform-wide rollup for one connector type — never a per-org breakdown. */
export interface ConnectorHealthMetric {
  connectorId: string;
  worstState: ConnectorState;
  /** Count of orgs currently degraded/disconnected for this connector. */
  orgsAffected: number;
  /** Most recent health-state update across all orgs for this connector. */
  lastCheckedAt: string | null;
}

/** A test-tier org at or over its admin-set anchor quota cap. */
export interface QuotaAnomaly {
  orgId: string;
  orgName: string;
  anchorQuota: number;
  nonDeletedAnchorCount: number;
}

export interface PlatformHealthSnapshot {
  measuredAt: string;
  /** `null` when the anchors-by-status read failed entirely. */
  anchorsByStatus: AnchorStatusMetric[] | null;
  jobQueue: JobQueueMetrics | null;
  batchFlush: BatchFlushMetrics | null;
  connectors: ConnectorHealthMetric[] | null;
  quotaAnomalies: QuotaAnomaly[] | null;
}

export interface PlatformHealthPayload {
  subject: string;
  html: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure content assembly
// ─────────────────────────────────────────────────────────────────────────────

function fmtCapped(n: number, capped: boolean): string {
  return `${n}${capped ? '+' : ''}`;
}

function renderAnchorsSection(metrics: AnchorStatusMetric[] | null): string {
  if (metrics === null) return 'ANCHORS BY STATUS: not measured (read error)';
  if (metrics.length === 0) return 'ANCHORS BY STATUS: no data';
  const lines = metrics.map((m) => {
    const depth =
      m.currentDepth === null
        ? 'backlog not measured'
        : `backlog ${fmtCapped(m.currentDepth, m.currentDepthCapped)}`;
    return `  ${m.status}: ${depth}, new in last 24h ${fmtCapped(m.new24h, m.new24hCapped)}`;
  });
  return ['ANCHORS BY STATUS (backlog depth, new in last 24h):', ...lines].join('\n');
}

function renderJobQueueSection(jq: JobQueueMetrics | null): string {
  if (jq === null) return 'JOB QUEUE: not measured (read error)';
  if (jq.pendingDepth === 0) return 'JOB QUEUE: no pending jobs';
  const oldest =
    jq.oldestPendingAgeMinutes === null
      ? ''
      : `, oldest pending ${jq.oldestPendingAgeMinutes} min`;
  return `JOB QUEUE: ${fmtCapped(jq.pendingDepth, jq.pendingDepthCapped)} pending${oldest}`;
}

function renderBatchFlushSection(bf: BatchFlushMetrics | null): string {
  if (bf === null) return 'BATCH FLUSH (last 24h): not measured (read error)';
  if (!bf.fired) return 'BATCH FLUSH (last 24h): no batch flush fired — the queue did not drain';
  const latest =
    bf.latestTxid && bf.latestSignedAt
      ? `\n  Latest: ${bf.latestTxid} at ${formatUtc(bf.latestSignedAt, 'unknown time')}`
      : '';
  return [
    `BATCH FLUSH (last 24h): fired — ${bf.batchesLast24h} batch${bf.batchesLast24h === 1 ? '' : 'es'}, ${bf.totalAnchorsLast24h} anchors flushed`,
    latest,
  ]
    .filter(Boolean)
    .join('');
}

function renderConnectorsSection(connectors: ConnectorHealthMetric[] | null): string {
  if (connectors === null) return 'CONNECTOR HEALTH: not measured (read error)';
  if (connectors.length === 0) return 'CONNECTOR HEALTH: no data';
  const severity: Record<ConnectorState, number> = { disconnected: 0, degraded: 1, connected: 2 };
  const sorted = [...connectors].sort(
    (a, b) => severity[a.worstState] - severity[b.worstState] || a.connectorId.localeCompare(b.connectorId),
  );
  const lines = sorted.map((c) => {
    const checked = c.lastCheckedAt ? `, last checked ${formatUtc(c.lastCheckedAt, 'unknown time')}` : '';
    const affected = c.worstState === 'connected' ? '' : `, ${c.orgsAffected} org${c.orgsAffected === 1 ? '' : 's'} affected`;
    return `  ${c.connectorId}: ${c.worstState}${affected}${checked}`;
  });
  return ['CONNECTOR HEALTH (platform-wide rollup):', ...lines].join('\n');
}

function renderQuotaSection(anomalies: QuotaAnomaly[] | null): string {
  if (anomalies === null) return 'QUOTA ANOMALIES: not measured (read error)';
  if (anomalies.length === 0) return 'QUOTA ANOMALIES: no quota anomalies';
  const lines = anomalies.map(
    (a) => `  ${a.orgName}: ${a.nonDeletedAnchorCount}/${a.anchorQuota} anchors used`,
  );
  return ['QUOTA ANOMALIES (test-tier orgs at/over cap):', ...lines].join('\n');
}

/**
 * Build the send-ready digest payload from a platform snapshot. Runs
 * `assertNoRawContent` on the snapshot BEFORE rendering so a bad input can
 * never reach the HTML. Unlike the queue digest, this ALWAYS produces a
 * payload — a platform health report has no "quiet" state worth suppressing
 * (an all-healthy day is itself the useful signal), so there is no
 * SKIPPED_EMPTY equivalent here.
 */
export function buildPlatformHealthPayload(snapshot: PlatformHealthSnapshot): PlatformHealthPayload {
  assertNoRawContent(snapshot);

  const measured = esc(formatUtc(snapshot.measuredAt, 'today'));
  const measuredDateOnly = snapshot.measuredAt.slice(0, 10);

  const sections = [
    renderAnchorsSection(snapshot.anchorsByStatus),
    renderJobQueueSection(snapshot.jobQueue),
    renderBatchFlushSection(snapshot.batchFlush),
    renderConnectorsSection(snapshot.connectors),
    renderQuotaSection(snapshot.quotaAnomalies),
  ];

  const bodyText = sections.join('\n\n');

  const html = wrapTemplate(`
    <h2 style="color: #0f172a; margin-bottom: 16px;">Platform health digest</h2>
    <p>Measured at ${measured}.</p>
    <pre style="${SHARED_STYLES.muted} white-space: pre-wrap; font-family: 'SF Mono', Consolas, monospace; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; line-height: 1.5;">${esc(bodyText)}</pre>
  `);

  const payload: PlatformHealthPayload = {
    subject: `Arkova platform health — ${measuredDateOnly}`,
    html,
  };

  // Defense-in-depth: the rendered output must not leak anything either.
  assertNoRawContent({ subject: payload.subject });

  return payload;
}

// ─────────────────────────────────────────────────────────────────────────────
// Delivery — idempotency + retry only. No suppression/opt-out: platform
// admins are internal staff, not a customer-facing preference surface.
// ─────────────────────────────────────────────────────────────────────────────

/** A prior delivery-log row for an (admin, digest-date) idempotency key. */
export interface PlatformHealthDeliveryLogRow {
  adminEmail: string;
  digestDate: string;
  status: 'SENT' | 'FAILED';
  attempts: number;
}

/**
 * Injected persistence for idempotency + delivery logging. Real
 * implementation binds to an `audit_events`-backed store — no new table.
 */
export interface PlatformHealthDigestStore {
  getDeliveryLog(adminEmail: string, digestDate: string): Promise<PlatformHealthDeliveryLogRow | null>;
  /** Atomically reserve today's SENT marker BEFORE sending (same F3 pattern
   * as queue-digest.ts): true if this worker won the reservation. */
  reserveDelivery(row: PlatformHealthDeliveryLogRow): Promise<boolean>;
  /** Release a reservation whose send failed, so a retry can re-reserve. */
  releaseDelivery(row: PlatformHealthDeliveryLogRow): Promise<void>;
  recordDelivery(row: PlatformHealthDeliveryLogRow): Promise<void>;
}

export interface DeliverPlatformHealthDigestDeps {
  store: PlatformHealthDigestStore;
  sendEmail: (opts: {
    to: string;
    subject: string;
    html: string;
    emailType: 'notification';
  }) => Promise<SendResult>;
  maxAttempts?: number;
  digestDate?: string;
}

export interface DeliverPlatformHealthResult {
  status: 'SENT' | 'ALREADY_SENT' | 'FAILED';
  attempts: number;
}

function utcDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Deliver the (already-built, identical for every recipient) digest payload
 * to one platform admin, honoring idempotency and retry rules. Pure
 * orchestration over injected deps.
 */
export async function deliverPlatformHealthDigestToAdmin(
  payload: PlatformHealthPayload,
  adminEmail: string,
  deps: DeliverPlatformHealthDigestDeps,
): Promise<DeliverPlatformHealthResult> {
  const digestDate = deps.digestDate ?? utcDateKey(new Date());
  const maxAttempts = deps.maxAttempts ?? 3;

  const existing = await deps.store.getDeliveryLog(adminEmail, digestDate);
  if (existing?.status === 'SENT') {
    return { status: 'ALREADY_SENT', attempts: existing.attempts };
  }
  if (existing && existing.attempts >= maxAttempts) {
    return { status: 'FAILED', attempts: existing.attempts };
  }

  const attempts = (existing?.attempts ?? 0) + 1;

  const reserved = await deps.store.reserveDelivery({
    adminEmail,
    digestDate,
    status: 'SENT',
    attempts,
  });
  if (!reserved) {
    // Another worker already holds today's reservation → do NOT send again.
    return { status: 'ALREADY_SENT', attempts };
  }

  const result = await deps.sendEmail({
    to: adminEmail,
    subject: payload.subject,
    html: payload.html,
    emailType: 'notification',
  });

  if (!result.success) {
    await deps.store.releaseDelivery({ adminEmail, digestDate, status: 'FAILED', attempts });
    await deps.store.recordDelivery({ adminEmail, digestDate, status: 'FAILED', attempts });
    return { status: 'FAILED', attempts };
  }

  return { status: 'SENT', attempts };
}
