/**
 * Daily Queue Digest — production wiring (QUEUE-07 / SCRUM-2353)
 *
 * Binds the pure digest engine in `queue-digest.ts` to real infrastructure:
 *   - recipients: org admins (profiles.role = 'ORG_ADMIN') per org
 *   - visibility scope: the admin's org + any sub-orgs it owns
 *     (organizations.parent_org_id), never a sibling org
 *   - metrics: counts-only queue rollup (open / aged / failed-connector)
 *   - preferences/suppression/delivery-log/retry: an `audit_events`-backed
 *     `DigestStore` — no new table/migration. `QUEUE_DIGEST_SENT` is the
 *     idempotency + delivery-log row; `QUEUE_DIGEST_UNSUBSCRIBED` is the
 *     suppression record. This keeps the change off the migration surface
 *     (T2, not a schema change) and off proof/chain/merkle runtime.
 *
 * §1.6: the metrics readers select COUNTS ONLY — never a document column,
 * filename, fingerprint, or body. `assertNoRawContent` in the engine is the
 * runtime backstop. §1.4: service-role db only; no secrets logged.
 *
 * Cron: intended for a daily Cloud Scheduler → HTTP trigger (in-process
 * node-cron is dormant under Cloud Run CPU throttling — see the
 * cloudrun-in-process-cron gotcha). Gated by ENABLE_QUEUE_DIGEST.
 */

import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { sendEmail } from '../email/sender.js';
import { config } from '../config.js';
import {
  deliverDigestToAdmin,
  type DigestScope,
  type DigestStore,
  type DigestUrls,
  type DeliveryLogRow,
  type QueueMetrics,
  type DeliverDigestResult,
} from './queue-digest.js';

/** Open review items older than this are "aged". */
const AGED_THRESHOLD_HOURS = 48;
/** Anchor statuses that represent an item still awaiting org review/action. */
const OPEN_REVIEW_STATUSES = ['PENDING'] as const;

const DIGEST_SENT_EVENT = 'QUEUE_DIGEST_SENT';
const DIGEST_FAILED_EVENT = 'QUEUE_DIGEST_FAILED';
const DIGEST_UNSUBSCRIBED_EVENT = 'QUEUE_DIGEST_UNSUBSCRIBED';

// ─────────────────────────────────────────────────────────────────────────────
// URL builders (action links) — scoped to the org id passed in.
// ─────────────────────────────────────────────────────────────────────────────

function stripTrailingSlash(s: string): string {
  let out = s;
  while (out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

export function buildDigestUrls(frontendUrl: string): DigestUrls {
  const base = stripTrailingSlash(frontendUrl);
  return {
    reviewQueueUrl: (orgId) => `${base}/org/${encodeURIComponent(orgId)}/review`,
    preferencesUrl: (orgId) =>
      `${base}/org/${encodeURIComponent(orgId)}/settings/notifications`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// audit_events-backed DigestStore (preferences / suppression / delivery log)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal DB surface this module needs — keeps it mockable + chain-agnostic.
 * `select` returns the loosely-typed PostgREST fluent builder; we only ever
 * read counts/timestamps/ids off it, never document columns (§1.6).
 */
export type DigestQueryBuilder = {
  select: (cols: string) => DigestQueryBuilder;
  eq: (col: string, val: unknown) => DigestQueryBuilder;
  in: (col: string, vals: unknown[]) => DigestQueryBuilder;
  is: (col: string, val: unknown) => DigestQueryBuilder;
  not: (col: string, op: string, val: unknown) => DigestQueryBuilder;
  order: (col: string, opts: { ascending: boolean }) => DigestQueryBuilder;
  limit: (n: number) => Promise<{ data: unknown; error: unknown }>;
};

export interface DigestDb {
  from(table: string): DigestQueryBuilder & {
    insert: (row: Record<string, unknown>) => Promise<{ error: unknown }>;
  };
}

export function createAuditBackedStore(database: DigestDb): DigestStore {
  return {
    async isSuppressed(adminEmail, adminOrgId) {
      // A QUEUE_DIGEST_UNSUBSCRIBED audit row for this (org, recipient) means
      // the admin opted out — never email them again until they re-subscribe.
      const { data, error } = await database
        .from('audit_events')
        .select('id')
        .eq('event_type', DIGEST_UNSUBSCRIBED_EVENT)
        .eq('org_id', adminOrgId)
        .eq('target_id', adminEmail)
        .limit(1);
      if (error) {
        // Fail OPEN on a read error would risk emailing an unsubscribed user;
        // fail CLOSED (treat as suppressed) so we never violate an opt-out.
        logger.warn({ error, adminOrgId }, 'digest suppression read failed — treating as suppressed');
        return true;
      }
      return Array.isArray(data) && data.length > 0;
    },

    async getDeliveryLog(adminEmail, adminOrgId, digestDate) {
      // Look for today's SENT/FAILED marker for idempotency + retry counting.
      const { data, error } = await database
        .from('audit_events')
        .select('event_type, details')
        .in('event_type', [DIGEST_SENT_EVENT, DIGEST_FAILED_EVENT])
        .eq('org_id', adminOrgId)
        .eq('target_id', adminEmail)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error || !Array.isArray(data)) return null;

      // Filter to this digest date (stored in details JSON) and take the latest.
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
          adminOrgId,
          digestDate,
          status: row.event_type === DIGEST_SENT_EVENT ? 'SENT' : 'FAILED',
          attempts: typeof parsed.attempts === 'number' ? parsed.attempts : 1,
        } satisfies DeliveryLogRow;
      }
      return null;
    },

    async recordDelivery(row: DeliveryLogRow) {
      const eventType =
        row.status === 'SENT'
          ? DIGEST_SENT_EVENT
          : row.status === 'SUPPRESSED'
            ? DIGEST_UNSUBSCRIBED_EVENT
            : DIGEST_FAILED_EVENT;
      // Counts-only details — no document data, no PII beyond the recipient.
      const { error } = await database.from('audit_events').insert({
        event_type: eventType,
        event_category: 'SYSTEM',
        org_id: row.adminOrgId,
        target_type: 'user',
        target_id: row.adminEmail,
        details: JSON.stringify({
          digest_date: row.digestDate,
          attempts: row.attempts,
          status: row.status,
        }),
      });
      if (error) {
        logger.warn({ error, orgId: row.adminOrgId }, 'digest delivery-log write failed');
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Recipient + scope + metrics readers (COUNTS ONLY)
// ─────────────────────────────────────────────────────────────────────────────

export interface AdminRecipient {
  adminEmail: string;
  adminOrgId: string;
}

/**
 * Resolve org admins to email. ORG_ADMIN role per the profiles `user_role`
 * enum. Only `email` + `org_id` leave the query (§1.6 — no other PII).
 */
export async function listOrgAdmins(database: DigestDb): Promise<AdminRecipient[]> {
  const { data, error } = await database
    .from('profiles')
    .select('email, org_id')
    .eq('role', 'ORG_ADMIN')
    .is('deleted_at', null)
    .not('org_id', 'is', null)
    .limit(10000);
  if (error || !Array.isArray(data)) {
    logger.warn({ error }, 'digest: failed to list org admins');
    return [];
  }
  return (data as Array<{ email: string; org_id: string | null }>)
    .filter((r) => r.email && r.org_id)
    .map((r) => ({ adminEmail: r.email, adminOrgId: r.org_id as string }));
}

/**
 * The visibility scope for an admin org = the org itself plus any sub-orgs
 * whose `parent_org_id` is this org. Sibling / unrelated orgs are never
 * included — this is the AC's per-scope isolation guarantee.
 */
export async function resolveScopeOrgIds(
  database: DigestDb,
  adminOrgId: string,
): Promise<string[]> {
  const ids = [adminOrgId];
  const { data, error } = await database
    .from('organizations')
    .select('id')
    .eq('parent_org_id', adminOrgId)
    .limit(1000);
  if (!error && Array.isArray(data)) {
    for (const row of data as Array<{ id: string }>) {
      if (row.id && row.id !== adminOrgId) ids.push(row.id);
    }
  }
  return ids;
}

/**
 * Count-only queue metrics for one org. Selects ONLY count-irrelevant
 * timestamp/id columns under a bounded scan; never a document column.
 */
export async function readOrgMetrics(
  database: DigestDb,
  orgId: string,
  orgName: string,
  now: Date,
): Promise<QueueMetrics> {
  const agedCutoff = new Date(now.getTime() - AGED_THRESHOLD_HOURS * 3600_000).toISOString();
  const CAP = 1000;

  // Open items awaiting review (counts via a bounded id/created_at scan).
  const { data: openRows } = await database
    .from('anchors')
    .select('created_at')
    .eq('org_id', orgId)
    .in('status', OPEN_REVIEW_STATUSES as unknown as string[])
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(CAP);
  const open = Array.isArray(openRows) ? openRows : [];
  const openCount = open.length;
  const agedCount = open.filter(
    (r) => (r as { created_at: string }).created_at < agedCutoff,
  ).length;

  // Failed-connector items: connector_alert_state degraded/disconnected rows
  // for this org (a count of connectors needing attention).
  let failedConnectorCount = 0;
  const { data: connRows } = await database
    .from('connector_alert_state')
    .select('connector_id')
    .eq('org_id', orgId)
    .limit(CAP);
  if (Array.isArray(connRows)) failedConnectorCount = connRows.length;

  return { orgId, orgName, openCount, agedCount, failedConnectorCount };
}

async function readOrgName(database: DigestDb, orgId: string): Promise<string> {
  const { data } = await database
    .from('organizations')
    .select('display_name')
    .eq('id', orgId)
    .limit(1);
  const row = Array.isArray(data) ? (data[0] as { display_name?: string }) : undefined;
  return row?.display_name ?? 'your organization';
}

// ─────────────────────────────────────────────────────────────────────────────
// Cron entrypoint
// ─────────────────────────────────────────────────────────────────────────────

export interface QueueDigestRunResult {
  admins: number;
  sent: number;
  suppressed: number;
  skippedEmpty: number;
  alreadySent: number;
  failed: number;
}

export interface RunQueueDigestDeps {
  database?: DigestDb;
  urls?: DigestUrls;
  send?: typeof sendEmail;
  now?: Date;
}

/**
 * Build + deliver the daily digest for every org admin. One row per admin;
 * each admin sees only their org scope. Idempotent per (admin, org, date).
 */
export async function runDailyQueueDigest(
  deps: RunQueueDigestDeps = {},
): Promise<QueueDigestRunResult> {
  const result: QueueDigestRunResult = {
    admins: 0,
    sent: 0,
    suppressed: 0,
    skippedEmpty: 0,
    alreadySent: 0,
    failed: 0,
  };

  if (process.env.ENABLE_QUEUE_DIGEST === 'false') {
    logger.info('Daily queue digest disabled via ENABLE_QUEUE_DIGEST=false');
    return result;
  }

  const database = deps.database ?? (db as unknown as DigestDb);
  const urls = deps.urls ?? buildDigestUrls(config.frontendUrl);
  const send = deps.send ?? sendEmail;
  const now = deps.now ?? new Date();

  const store = createAuditBackedStore(database);
  const admins = await listOrgAdmins(database);
  result.admins = admins.length;

  // Per-org-name memo so a multi-admin org reads its name once.
  const nameCache = new Map<string, string>();
  const getName = async (orgId: string): Promise<string> => {
    const hit = nameCache.get(orgId);
    if (hit !== undefined) return hit;
    const name = await readOrgName(database, orgId);
    nameCache.set(orgId, name);
    return name;
  };

  for (const admin of admins) {
    try {
      const scopeIds = await resolveScopeOrgIds(database, admin.adminOrgId);
      const orgMetrics: QueueMetrics[] = [];
      for (const orgId of scopeIds) {
        orgMetrics.push(await readOrgMetrics(database, orgId, await getName(orgId), now));
      }

      const scope: DigestScope = {
        adminEmail: admin.adminEmail,
        adminOrgId: admin.adminOrgId,
        orgMetrics,
        measuredAt: now.toISOString(),
      };

      const r: DeliverDigestResult = await deliverDigestToAdmin(scope, {
        store,
        urls,
        sendEmail: (opts) => send(opts),
      });

      switch (r.status) {
        case 'SENT':
          result.sent += 1;
          break;
        case 'SUPPRESSED':
          result.suppressed += 1;
          break;
        case 'SKIPPED_EMPTY':
          result.skippedEmpty += 1;
          break;
        case 'ALREADY_SENT':
          result.alreadySent += 1;
          break;
        case 'FAILED':
          result.failed += 1;
          break;
      }
    } catch (err) {
      // One bad admin never starves the rest (job convention).
      result.failed += 1;
      logger.error({ error: err, adminOrgId: admin.adminOrgId }, 'digest: admin delivery threw');
    }
  }

  logger.info({ ...result }, 'Daily queue digest pass complete');
  return result;
}
