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
/**
 * Anchor statuses that represent a Review Queue item awaiting org action.
 * This MUST mirror what the Review Queue itself counts: `/api/queue/pending`
 * (`api/queue-resolution.ts`) selects `status = 'PENDING_RESOLUTION'`. The
 * plain `PENDING` status is the ordinary anchoring backlog, NOT review work —
 * counting it would email orgs with routine pending anchors while silently
 * skipping orgs that actually have unresolved review items.
 */
const OPEN_REVIEW_STATUSES = ['PENDING_RESOLUTION'] as const;

const DIGEST_SENT_EVENT = 'QUEUE_DIGEST_SENT';
const DIGEST_FAILED_EVENT = 'QUEUE_DIGEST_FAILED';
const DIGEST_SUPPRESSED_EVENT = 'QUEUE_DIGEST_SUPPRESSED';
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
export interface DigestQueryBuilder {
  select: (cols: string) => DigestQueryBuilder;
  eq: (col: string, val: unknown) => DigestQueryBuilder;
  in: (col: string, vals: unknown[]) => DigestQueryBuilder;
  is: (col: string, val: unknown) => DigestQueryBuilder;
  not: (col: string, op: string, val: unknown) => DigestQueryBuilder;
  order: (col: string, opts: { ascending: boolean }) => DigestQueryBuilder;
  limit: (n: number) => Promise<{ data: unknown; error: unknown }>;
}

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
      // F2 (fail-closed idempotency): a READ ERROR means we cannot verify whether
      // today's digest already went out. Returning null here reads as "no prior
      // send" and re-sends on every transient audit_events failure. Throw so the
      // per-admin caller (cron loop) skips the send and retries next run — never a
      // duplicate email off an unverified idempotency marker.
      if (error) {
        throw new Error(
          `digest delivery-log read failed: ${(error as { message?: string }).message ?? 'unknown'}`,
        );
      }
      if (!Array.isArray(data)) {
        throw new Error('digest delivery-log read returned a non-array payload');
      }

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
      // SUPPRESSED is a delivery-skip marker, NOT an opt-out. `isSuppressed`
      // fails CLOSED on a read error, so mapping SUPPRESSED →
      // QUEUE_DIGEST_UNSUBSCRIBED would let a transient read failure forge a
      // permanent unsubscribe row. Only a genuine opt-out writes UNSUBSCRIBED.
      const eventType =
        row.status === 'SENT'
          ? DIGEST_SENT_EVENT
          : row.status === 'SUPPRESSED'
            ? DIGEST_SUPPRESSED_EVENT
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
        // The delivery-log row IS the idempotency marker. If it fails to
        // persist after a successful send, we must NOT report SENT — a later
        // pass would otherwise re-send the same daily digest. Throw so the
        // orchestrator/cron loop counts this admin as failed (and retries).
        logger.warn({ error, orgId: row.adminOrgId }, 'digest delivery-log write failed');
        throw new Error(`digest: delivery-log write failed for org ${row.adminOrgId}`);
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
 * Per-org QUEUE_DIGEST opt-in: the set of org ids that have an ENABLED
 * `organization_rules` row with `trigger_type = 'QUEUE_DIGEST'`. This is the
 * SAME contract the existing scheduler uses (see `queue-reminders.ts`'s
 * `.from('organization_rules').eq('enabled', true).in('trigger_type', [...,
 * 'QUEUE_DIGEST'])`) — an enabled QUEUE_DIGEST rule IS the org's opt-in record
 * (documented in `queue-digest.ts`). The global ENABLE_QUEUE_DIGEST flag only
 * gates whether the JOB runs; this gates WHICH orgs may be emailed, so an org
 * that never opted in is never enumerated, never metered, never mailed.
 *
 * Fails CLOSED: on a read error or non-array result, returns an empty set so we
 * never email orgs we could not confirm opted in.
 */
/**
 * F4 (per-rule cadence): the daily digest cron runs once a day, but a
 * QUEUE_DIGEST rule may carry a `trigger_config.cron` (+ optional `timezone`)
 * expressing a coarser cadence (weekly, monthly, weekdays-only). The digest is
 * DAY-granular — the global schedule owns time-of-day — so we match only the
 * cron's DATE fields (day-of-month, month, day-of-week) against "today" in the
 * rule's timezone. A rule with no cron keeps the legacy daily behavior.
 *
 * Supports wildcard, comma lists, ranges (a-b), and step syntax (slash-n) per field.
 * Exported for direct unit testing.
 */
export function isDigestRuleDueToday(
  triggerConfig: unknown,
  now: Date,
): boolean {
  const cfg = (triggerConfig ?? {}) as { cron?: unknown; timezone?: unknown };
  const cron = typeof cfg.cron === 'string' ? cfg.cron.trim() : '';
  if (!cron) return true; // no cadence configured → daily default (backward compatible)

  const fields = cron.split(/\s+/);
  // Standard 5-field cron: min hour dom month dow. Anything else → fail safe to due.
  if (fields.length !== 5) return true;
  const [, , domF, monthF, dowF] = fields;

  const tz = typeof cfg.timezone === 'string' && cfg.timezone ? cfg.timezone : 'UTC';
  let dom: number, month: number, dow: number;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      day: 'numeric',
      month: 'numeric',
      weekday: 'short',
    }).formatToParts(now);
    dom = Number(parts.find((p) => p.type === 'day')?.value);
    month = Number(parts.find((p) => p.type === 'month')?.value);
    const wk = parts.find((p) => p.type === 'weekday')?.value ?? '';
    dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wk);
  } catch {
    return true; // bad timezone → don't silently drop the org; fail safe to due
  }

  const matches = (field: string, value: number, min: number, max: number): boolean => {
    if (field === '*') return true;
    return field.split(',').some((part) => {
      const [rangePart, stepPart] = part.split('/');
      const step = stepPart ? Number(stepPart) : 1;
      if (!Number.isFinite(step) || step <= 0) return false;
      let lo: number, hi: number;
      if (rangePart === '*') { lo = min; hi = max; }
      else if (rangePart.includes('-')) {
        const [a, b] = rangePart.split('-').map(Number);
        lo = a; hi = b;
      } else { lo = Number(rangePart); hi = lo; }
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return false;
      if (value < lo || value > hi) return false;
      return (value - lo) % step === 0;
    });
  };

  // dow: cron allows 0 or 7 for Sunday. Normalize a `7` in the field to `0`.
  const dowField = dowF.replace(/\b7\b/g, '0');
  return (
    matches(domF, dom, 1, 31) &&
    matches(monthF, month, 1, 12) &&
    matches(dowField, dow, 0, 6)
  );
}

export async function listDigestOptedInOrgIds(
  database: DigestDb,
  now: Date = new Date(),
): Promise<Set<string>> {
  // Intentional cross-org discovery: this is the daily-digest opt-in scan over
  // ALL orgs' QUEUE_DIGEST rules, run on the service-role client. There is no
  // single caller org to filter to — and the result is used only to RESTRICT
  // (fail-closed) which orgs may be emailed, never to widen access. Same
  // exemption the sibling cron jobs use (queue-reminders.ts:155,
  // rule-action-dispatcher.ts:126) — only the missing-org-filter half applies
  // here since this query uses the typed `DigestDb`, not a `db as any` cast.
  // eslint-disable-next-line arkova/missing-org-filter -- service-role admin query
  const { data, error } = await database
    .from('organization_rules')
    .select('org_id, trigger_config')
    .eq('enabled', true)
    .eq('trigger_type', 'QUEUE_DIGEST')
    .limit(10000);
  if (error || !Array.isArray(data)) {
    logger.warn({ error }, 'digest: failed to list QUEUE_DIGEST opt-in orgs — treating as none opted in');
    return new Set<string>();
  }
  const ids = new Set<string>();
  for (const row of data as Array<{ org_id: string | null; trigger_config: unknown }>) {
    // F4: only enumerate an org whose QUEUE_DIGEST rule cadence is due today
    // (per-rule cron/timezone; daily by default). A weekly/custom rule that is
    // not due today is skipped instead of emailed every day.
    if (row.org_id && isDigestRuleDueToday(row.trigger_config, now)) ids.add(row.org_id);
  }
  return ids;
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
  // A scope-read error must FAIL the admin (caught by the per-admin loop →
  // counted failed → retried next pass), never silently fall back to the
  // admin org alone: that would send a digest missing owned sub-org counts.
  if (error || !Array.isArray(data)) {
    throw new Error(`digest: failed to resolve sub-org scope for org ${adminOrgId}`);
  }
  for (const row of data as Array<{ id: string }>) {
    if (row.id && row.id !== adminOrgId) ids.push(row.id);
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
  // Fail the run on a read error rather than silently reporting a quiet queue.
  const { data: openRows, error: openError } = await database
    .from('anchors')
    .select('created_at')
    .eq('org_id', orgId)
    .in('status', OPEN_REVIEW_STATUSES as unknown as string[])
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(CAP);
  if (openError || !Array.isArray(openRows)) {
    throw new Error(`digest: failed to read open queue metrics for org ${orgId}`);
  }
  const open = openRows;
  const openCount = open.length;
  const agedCount = open.filter(
    (r) => (r as { created_at: string }).created_at < agedCutoff,
  ).length;

  // Failed-connector items: connector_alert_state rows for this org whose
  // last_state is degraded/disconnected. The predicate is pushed into the
  // query so HEALTHY connectors (last_state='connected', the default the
  // health check upserts) are never counted as issues — otherwise a quiet
  // org would still receive a digest claiming connector problems.
  const { data: connRows, error: connError } = await database
    .from('connector_alert_state')
    .select('connector_id')
    .eq('org_id', orgId)
    .in('last_state', ['degraded', 'disconnected'])
    .limit(CAP);
  if (connError || !Array.isArray(connRows)) {
    throw new Error(`digest: failed to read connector metrics for org ${orgId}`);
  }
  const failedConnectorCount = connRows.length;

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

  // Default-off: this production email job sends ONLY when explicitly enabled
  // via ENABLE_QUEUE_DIGEST=true (config.enableQueueDigest, boolFlag(false)).
  // An omitted/false flag no-ops before enumerating admins or sending mail.
  if (!config.enableQueueDigest) {
    logger.info('Daily queue digest disabled; set ENABLE_QUEUE_DIGEST=true to enable');
    return result;
  }

  const database = deps.database ?? (db as unknown as DigestDb);
  const urls = deps.urls ?? buildDigestUrls(config.frontendUrl);
  const send = deps.send ?? sendEmail;
  const now = deps.now ?? new Date();

  const store = createAuditBackedStore(database);

  // Per-org opt-in gate: only orgs with an ENABLED `organization_rules`
  // QUEUE_DIGEST rule may be emailed. An admin in a non-opted-in org is never
  // enumerated, never has metrics built, and never receives mail — even when
  // its queue is non-empty and the global flag is on.
  const optedInOrgIds = await listDigestOptedInOrgIds(database, now);
  const allAdmins = await listOrgAdmins(database);
  const admins = allAdmins.filter((a) => optedInOrgIds.has(a.adminOrgId));
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
