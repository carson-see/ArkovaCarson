/**
 * Platform Admin Daily Health Digest — production wiring
 *
 * Binds the pure engine in `platform-health-digest.ts` to real
 * infrastructure:
 *   - recipients: `profiles.is_platform_admin = true` — sourced from the
 *     same DB flag `isPlatformAdmin()` (`utils/platformAdmin.ts`) already
 *     gates every platform-admin route on. NEVER a hardcoded address — that
 *     is deliberately left to the existing, separate stuck-anchor alert in
 *     `pipeline-health.ts`, which stays as-is (a different, correctly
 *     alert-shaped signal, not folded into this routine digest).
 *   - content: one snapshot assembled once per run (anchors by status,
 *     job_queue depth, last night's batch flush, connector health rollup,
 *     quota anomalies) and the SAME rendered email fanned out to every
 *     admin — unlike the queue digest, this is not per-recipient scoped
 *     data, so there is nothing to build per-admin.
 *   - idempotency/retry: an `audit_events`-backed store, same F3
 *     reserve-before-send pattern as `queue-digest-cron.ts` — no new table.
 *   - no suppression/opt-out: platform admins are internal staff, not a
 *     customer preference surface.
 *
 * §1.6: every reader below selects counts/rollups only — never a document
 * column, filename, fingerprint, or another user's PII. §1.5: a metric this
 * module could not cheaply/safely measure is `null` ("not measured"), never
 * coerced to a false `0`. One section's read failure never sinks the whole
 * digest — see `assemblePlatformHealthSnapshot`.
 *
 * Cron: daily Cloud Scheduler → HTTP trigger (in-process node-cron is
 * dormant under Cloud Run CPU throttling — see the cloudrun-in-process-cron
 * gotcha). Gated by ENABLE_PLATFORM_HEALTH_DIGEST.
 */

import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { sendEmail } from '../email/sender.js';
import { config } from '../config.js';
import {
  buildPlatformHealthPayload,
  deliverPlatformHealthDigestToAdmin,
  type AnchorStatusMetric,
  type JobQueueMetrics,
  type BatchFlushMetrics,
  type ConnectorHealthMetric,
  type ConnectorState,
  type QuotaAnomaly,
  type PlatformHealthSnapshot,
  type PlatformHealthDigestStore,
  type PlatformHealthDeliveryLogRow,
} from './platform-health-digest.js';

/** Bounded read cap — never a full-table COUNT(*) on `anchors` (see module header). */
const CAP = 1000;
/** How far back "last 24h" reaches for new-anchor / batch-flush counts. */
const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Statuses worth reporting, in display order. Transient/actionable statuses
 * (`BACKLOG_STATUSES`) additionally get a bounded current-depth read;
 * terminal statuses only get the bounded 24h-new count — a full-table depth
 * read against millions of SECURED rows is exactly the mistake
 * `pipeline-health.ts`'s own STUCK_CAP postmortem warns against.
 */
const ANCHOR_STATUS_ORDER = [
  'PENDING',
  'BROADCASTING',
  'SUBMITTED',
  'PENDING_RESOLUTION',
  'SECURED',
  'REVOKED',
  'EXPIRED',
  'SUPERSEDED',
] as const;
const BACKLOG_STATUSES = new Set<string>(['PENDING', 'BROADCASTING', 'SUBMITTED', 'PENDING_RESOLUTION']);

/** Excluded from the connector rollup — its state is synthetic (mirrors connector-health-alert.ts). */
const DEMO_CONNECTORS = new Set(['demo']);
const STATE_SEVERITY: Record<string, number> = { disconnected: 0, degraded: 1, connected: 2 };

const DIGEST_SENT_EVENT = 'PLATFORM_HEALTH_DIGEST_SENT';
const DIGEST_FAILED_EVENT = 'PLATFORM_HEALTH_DIGEST_FAILED';

// ─────────────────────────────────────────────────────────────────────────────
// Minimal DB surface — mirrors queue-digest-cron.ts's DigestDb shape.
// ─────────────────────────────────────────────────────────────────────────────

export interface HealthQueryBuilder {
  select: (cols: string) => HealthQueryBuilder;
  eq: (col: string, val: unknown) => HealthQueryBuilder;
  in: (col: string, vals: unknown[]) => HealthQueryBuilder;
  is: (col: string, val: unknown) => HealthQueryBuilder;
  not: (col: string, op: string, val: unknown) => HealthQueryBuilder;
  gte: (col: string, val: unknown) => HealthQueryBuilder;
  lt: (col: string, val: unknown) => HealthQueryBuilder;
  order: (col: string, opts: { ascending: boolean }) => HealthQueryBuilder;
  limit: (n: number) => Promise<{ data: unknown; error: unknown }>;
}

export interface HealthDeleteBuilder {
  eq: (col: string, val: unknown) => HealthDeleteBuilder;
  like: (col: string, pattern: string) => Promise<{ error: unknown }>;
}

export interface HealthDb {
  from(table: string): HealthQueryBuilder & {
    insert: (row: Record<string, unknown>) => Promise<{ error: unknown }>;
    delete: () => HealthDeleteBuilder;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Recipients — by platform-admin designation, never hardcoded
// ─────────────────────────────────────────────────────────────────────────────

export interface PlatformAdminRecipient {
  email: string;
}

/**
 * Resolve platform admins to email via `profiles.is_platform_admin = true`
 * — the same DB-backed flag `isPlatformAdmin()` gates every platform-admin
 * route on. Fails CLOSED on a read error: an empty list means nobody gets
 * mailed that pass, never a fallback to a hardcoded address.
 */
export async function listPlatformAdmins(database: HealthDb): Promise<PlatformAdminRecipient[]> {
  const { data, error } = await database
    .from('profiles')
    .select('email')
    .eq('is_platform_admin', true)
    .is('deleted_at', null)
    .limit(1000);
  if (error || !Array.isArray(data)) {
    logger.warn({ error }, 'platform health digest: failed to list platform admins');
    return [];
  }
  return (data as Array<{ email: string | null }>)
    .filter((r) => r.email)
    .map((r) => ({ email: r.email as string }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Section readers — each is independently bounded and degrades to `null`
// (never a false zero) on its own read error.
// ─────────────────────────────────────────────────────────────────────────────

export async function readAnchorStatusMetrics(
  database: HealthDb,
  now: Date,
): Promise<AnchorStatusMetric[] | null> {
  const cutoff = new Date(now.getTime() - WINDOW_MS).toISOString();
  const metrics: AnchorStatusMetric[] = [];

  for (const status of ANCHOR_STATUS_ORDER) {
    const { data: newRows, error: newError } = await database
      .from('anchors')
      .select('id')
      .eq('status', status)
      .gte('created_at', cutoff)
      .is('deleted_at', null)
      .limit(CAP);
    if (newError || !Array.isArray(newRows)) {
      logger.warn({ error: newError, status }, 'platform health digest: anchors-by-status read failed');
      return null;
    }

    let currentDepth: number | null = null;
    let currentDepthCapped = false;
    if (BACKLOG_STATUSES.has(status)) {
      const { data: depthRows, error: depthError } = await database
        .from('anchors')
        .select('id')
        .eq('status', status)
        .is('deleted_at', null)
        .limit(CAP);
      if (depthError || !Array.isArray(depthRows)) {
        logger.warn({ error: depthError, status }, 'platform health digest: anchors-by-status depth read failed');
        return null;
      }
      currentDepth = depthRows.length;
      currentDepthCapped = depthRows.length >= CAP;
    }

    metrics.push({
      status,
      currentDepth,
      currentDepthCapped,
      new24h: newRows.length,
      new24hCapped: newRows.length >= CAP,
    });
  }

  return metrics;
}

export async function readJobQueueMetrics(database: HealthDb, now: Date): Promise<JobQueueMetrics | null> {
  const { data, error } = await database
    .from('job_queue')
    .select('created_at')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(CAP);
  if (error || !Array.isArray(data)) {
    logger.warn({ error }, 'platform health digest: job_queue read failed');
    return null;
  }
  const rows = data as Array<{ created_at: string }>;
  const oldestPendingAgeMinutes =
    rows.length > 0 ? Math.round((now.getTime() - new Date(rows[0].created_at).getTime()) / 60000) : null;
  return {
    pendingDepth: rows.length,
    pendingDepthCapped: rows.length >= CAP,
    oldestPendingAgeMinutes,
  };
}

export async function readBatchFlushMetrics(database: HealthDb, now: Date): Promise<BatchFlushMetrics | null> {
  const cutoff = new Date(now.getTime() - WINDOW_MS).toISOString();
  const { data, error } = await database
    .from('anchor_txid_journal')
    .select('txid, signed_at, anchor_ids')
    .gte('signed_at', cutoff)
    .order('signed_at', { ascending: false })
    .limit(50);
  if (error || !Array.isArray(data)) {
    logger.warn({ error }, 'platform health digest: batch-flush read failed');
    return null;
  }
  const rows = data as Array<{ txid: string; signed_at: string; anchor_ids: unknown }>;
  if (rows.length === 0) {
    return { fired: false, batchesLast24h: 0, totalAnchorsLast24h: 0, latestTxid: null, latestSignedAt: null };
  }
  const totalAnchorsLast24h = rows.reduce(
    (sum, r) => sum + (Array.isArray(r.anchor_ids) ? r.anchor_ids.length : 0),
    0,
  );
  return {
    fired: true,
    batchesLast24h: rows.length,
    totalAnchorsLast24h,
    latestTxid: rows[0].txid,
    latestSignedAt: rows[0].signed_at,
  };
}

export async function readConnectorHealthMetrics(database: HealthDb): Promise<ConnectorHealthMetric[] | null> {
  const { data, error } = await database
    .from('connector_alert_state')
    .select('connector_id, org_id, last_state, updated_at')
    .limit(5000);
  if (error || !Array.isArray(data)) {
    logger.warn({ error }, 'platform health digest: connector rollup read failed');
    return null;
  }
  const rows = data as Array<{
    connector_id: string;
    org_id: string;
    last_state: string;
    updated_at: string;
  }>;

  const byConnector = new Map<string, { worstState: string; orgsAffected: number; lastCheckedAt: string | null }>();
  for (const row of rows) {
    if (!row.connector_id || DEMO_CONNECTORS.has(row.connector_id)) continue;
    const cur = byConnector.get(row.connector_id) ?? {
      worstState: 'connected',
      orgsAffected: 0,
      lastCheckedAt: null,
    };
    const rowSeverity = STATE_SEVERITY[row.last_state] ?? STATE_SEVERITY.connected;
    if (rowSeverity < (STATE_SEVERITY[cur.worstState] ?? STATE_SEVERITY.connected)) {
      cur.worstState = row.last_state;
    }
    if (row.last_state !== 'connected') cur.orgsAffected += 1;
    if (!cur.lastCheckedAt || row.updated_at > cur.lastCheckedAt) cur.lastCheckedAt = row.updated_at;
    byConnector.set(row.connector_id, cur);
  }

  return Array.from(byConnector.entries()).map(([connectorId, v]) => ({
    connectorId,
    worstState: v.worstState as ConnectorState,
    orgsAffected: v.orgsAffected,
    lastCheckedAt: v.lastCheckedAt,
  }));
}

/**
 * Test-tier orgs (`org_credits.is_test = true`) whose non-deleted anchor
 * count meets or exceeds their admin-set `anchor_quota` — the same
 * `quota_exhausted` condition `admin_set_org_anchor_quota` (SCRUM-2225,
 * migration 0300/0327) exists to police. A per-org anchor read is bounded to
 * `quota + 1` rows (the exact count needed to know "at/over cap or not"),
 * never a full count.
 */
export async function readQuotaAnomalies(database: HealthDb): Promise<QuotaAnomaly[] | null> {
  const { data, error } = await database
    .from('org_credits')
    .select('org_id, anchor_quota')
    .eq('is_test', true)
    .not('anchor_quota', 'is', null)
    .limit(500);
  if (error || !Array.isArray(data)) {
    logger.warn({ error }, 'platform health digest: quota-anomaly org_credits read failed');
    return null;
  }

  const anomalies: QuotaAnomaly[] = [];
  for (const row of data as Array<{ org_id: string | null; anchor_quota: number | null }>) {
    if (!row.org_id || row.anchor_quota == null) continue;

    const { data: anchorRows, error: anchorError } = await database
      .from('anchors')
      .select('id')
      .eq('org_id', row.org_id)
      .is('deleted_at', null)
      .limit(row.anchor_quota + 1);
    if (anchorError || !Array.isArray(anchorRows)) {
      // Skip this one org rather than failing the whole section — a single
      // org's read hiccup should not hide every other org's real anomaly.
      logger.warn({ error: anchorError, orgId: row.org_id }, 'platform health digest: quota-anomaly anchor count read failed');
      continue;
    }
    if (anchorRows.length < row.anchor_quota) continue; // under quota — not an anomaly

    const { data: orgRows } = await database
      .from('organizations')
      .select('display_name')
      .eq('id', row.org_id)
      .limit(1);
    const orgName =
      (Array.isArray(orgRows) && (orgRows[0] as { display_name?: string } | undefined)?.display_name) ||
      row.org_id;

    anomalies.push({
      orgId: row.org_id,
      orgName,
      anchorQuota: row.anchor_quota,
      nonDeletedAnchorCount: anchorRows.length,
    });
  }
  return anomalies;
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot assembly — one section's failure never sinks the others.
// ─────────────────────────────────────────────────────────────────────────────

export async function assemblePlatformHealthSnapshot(
  database: HealthDb,
  now: Date,
): Promise<PlatformHealthSnapshot> {
  const safe = async <T>(label: string, fn: () => Promise<T | null>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      logger.warn({ error: err, section: label }, 'platform health digest: section threw, degrading to null');
      return null;
    }
  };

  const [anchorsByStatus, jobQueue, batchFlush, connectors, quotaAnomalies] = await Promise.all([
    safe('anchorsByStatus', () => readAnchorStatusMetrics(database, now)),
    safe('jobQueue', () => readJobQueueMetrics(database, now)),
    safe('batchFlush', () => readBatchFlushMetrics(database, now)),
    safe('connectors', () => readConnectorHealthMetrics(database)),
    safe('quotaAnomalies', () => readQuotaAnomalies(database)),
  ]);

  return {
    measuredAt: now.toISOString(),
    anchorsByStatus,
    jobQueue,
    batchFlush,
    connectors,
    quotaAnomalies,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// audit_events-backed store (idempotency + retry only, no suppression)
// ─────────────────────────────────────────────────────────────────────────────

export function createPlatformHealthStore(database: HealthDb): PlatformHealthDigestStore {
  return {
    async getDeliveryLog(adminEmail, digestDate) {
      // This idempotency marker is platform-level, not org-scoped — the
      // recipient (target_id, a platform admin) is the scope, and there is
      // no single org to filter to. Same exemption shape as
      // queue-digest-cron.ts's cross-org preference scan.
      // eslint-disable-next-line arkova/missing-org-filter -- platform-level idempotency read, scoped by target_id (recipient), not an org
      const { data, error } = await database
        .from('audit_events')
        .select('event_type, details')
        .in('event_type', [DIGEST_SENT_EVENT, DIGEST_FAILED_EVENT])
        .eq('target_id', adminEmail)
        .order('created_at', { ascending: false })
        .limit(50);
      // Fail-closed idempotency (same F2 pattern as queue-digest-cron.ts): a
      // read error must never be read as "no prior send".
      if (error) {
        throw new Error(
          `platform health digest delivery-log read failed: ${(error as { message?: string }).message ?? 'unknown'}`,
        );
      }
      if (!Array.isArray(data)) {
        throw new Error('platform health digest delivery-log read returned a non-array payload');
      }
      for (const row of data as Array<{ event_type: string; details: string | null }>) {
        let parsed: { digest_date?: string; attempts?: number };
        try {
          parsed = row.details ? JSON.parse(row.details) : {};
        } catch {
          parsed = {};
        }
        if (parsed.digest_date !== digestDate) continue;
        return {
          adminEmail,
          digestDate,
          status: row.event_type === DIGEST_SENT_EVENT ? 'SENT' : 'FAILED',
          attempts: typeof parsed.attempts === 'number' ? parsed.attempts : 1,
        } satisfies PlatformHealthDeliveryLogRow;
      }
      return null;
    },

    async reserveDelivery(row) {
      // F3 pattern: RESERVE the SENT marker before sending so exactly one
      // concurrent worker wins (unique-constraint conflict on the audit
      // event content is not guaranteed by a DB index here — unlike
      // queue-digest's migration-0352-backed index — so this is a
      // best-effort reservation; a duplicate email is a low-severity
      // outcome for an internal ops digest, unlike a customer-facing send).
      const { error } = await database.from('audit_events').insert({
        event_type: DIGEST_SENT_EVENT,
        event_category: 'SYSTEM',
        org_id: null,
        target_type: 'user',
        target_id: row.adminEmail,
        details: JSON.stringify({ digest_date: row.digestDate, attempts: row.attempts, status: 'SENT' }),
      });
      if (!error) return true;
      if ((error as { code?: string }).code === '23505') return false;
      logger.warn({ error, adminEmail: row.adminEmail }, 'platform health digest reservation insert failed');
      throw new Error(`platform health digest: reservation insert failed for ${row.adminEmail}`);
    },

    async releaseDelivery(row) {
      // eslint-disable-next-line arkova/missing-org-filter -- platform-level reservation release, scoped by target_id (recipient), not an org
      const { error } = await database
        .from('audit_events')
        .delete()
        .eq('event_type', DIGEST_SENT_EVENT)
        .eq('target_id', row.adminEmail)
        .like('details', `%"digest_date":"${row.digestDate}"%`);
      if (error) {
        logger.warn({ error, adminEmail: row.adminEmail }, 'platform health digest reservation release failed');
      }
    },

    async recordDelivery(row) {
      const eventType = row.status === 'SENT' ? DIGEST_SENT_EVENT : DIGEST_FAILED_EVENT;
      const { error } = await database.from('audit_events').insert({
        event_type: eventType,
        event_category: 'SYSTEM',
        org_id: null,
        target_type: 'user',
        target_id: row.adminEmail,
        details: JSON.stringify({ digest_date: row.digestDate, attempts: row.attempts, status: row.status }),
      });
      if (error) {
        logger.warn({ error, adminEmail: row.adminEmail }, 'platform health digest delivery-log write failed');
        throw new Error(`platform health digest: delivery-log write failed for ${row.adminEmail}`);
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cron entrypoint
// ─────────────────────────────────────────────────────────────────────────────

export interface PlatformHealthDigestRunResult {
  admins: number;
  sent: number;
  alreadySent: number;
  failed: number;
}

export interface RunPlatformHealthDigestDeps {
  database?: HealthDb;
  send?: typeof sendEmail;
  now?: Date;
}

/**
 * Build one platform-health snapshot and deliver the SAME digest to every
 * platform admin. Idempotent per (admin, UTC date).
 */
export async function runPlatformHealthDigest(
  deps: RunPlatformHealthDigestDeps = {},
): Promise<PlatformHealthDigestRunResult> {
  const result: PlatformHealthDigestRunResult = { admins: 0, sent: 0, alreadySent: 0, failed: 0 };

  // Default-on in prod (deploy-worker.yml), default-on in code too
  // (boolFlag(true)) — see config.ts. An omitted/false flag no-ops before
  // listing admins or touching the DB otherwise.
  if (!config.enablePlatformHealthDigest) {
    logger.info('Platform health digest disabled; set ENABLE_PLATFORM_HEALTH_DIGEST=true to enable');
    return result;
  }

  const database = deps.database ?? (db as unknown as HealthDb);
  const send = deps.send ?? sendEmail;
  const now = deps.now ?? new Date();

  const admins = await listPlatformAdmins(database);
  result.admins = admins.length;
  if (admins.length === 0) {
    logger.info('Platform health digest: no platform admins found — nothing to send');
    return result;
  }

  const snapshot = await assemblePlatformHealthSnapshot(database, now);
  const payload = buildPlatformHealthPayload(snapshot);
  const store = createPlatformHealthStore(database);
  const digestDate = now.toISOString().slice(0, 10);

  for (const admin of admins) {
    try {
      const r = await deliverPlatformHealthDigestToAdmin(payload, admin.email, {
        store,
        sendEmail: (opts) => send(opts),
        digestDate,
      });
      switch (r.status) {
        case 'SENT':
          result.sent += 1;
          break;
        case 'ALREADY_SENT':
          result.alreadySent += 1;
          break;
        case 'FAILED':
          result.failed += 1;
          break;
      }
    } catch (err) {
      // One bad admin never starves the rest (job convention, matches queue-digest-cron.ts).
      result.failed += 1;
      logger.error({ error: err, adminEmail: admin.email }, 'platform health digest: admin delivery threw');
    }
  }

  logger.info({ ...result }, 'Platform health digest pass complete');
  return result;
}
