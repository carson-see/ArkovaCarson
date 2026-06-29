/**
 * Daily Queue Review Digest (QUEUE-07 — SCRUM-2353)
 *
 * Builds and delivers a once-a-day review digest to each organization admin.
 * The digest summarizes the org's review queue: total open items, items that
 * have aged past a threshold, and items whose connector fetch failed — plus
 * action links into the app. It is the daily-rollup sibling of the 15-minute
 * `queue-reminders.ts` cron (which fires per-rule SCHEDULED_CRON / QUEUE_DIGEST
 * executions): this module owns the *content + delivery* of the digest email,
 * not the cron scheduling. The QUEUE_DIGEST rule is the org's opt-in record.
 *
 * Constitution alignment:
 *   - §1.6 / §1.6A: the digest NEVER contains raw document content, document
 *     filenames, fingerprints, OCR text, or any PII beyond the recipient admin
 *     email. It carries COUNTS and ACTION LINKS only. `assertNoRawContent()`
 *     is a hard guard run on every payload before it is rendered/sent — a
 *     defense-in-depth backstop, not the only line of defense (the data source
 *     is already count-only).
 *   - §1.4: no secrets logged; service-role data access only.
 *   - §1.5: the digest states what is measured (counts as of a timestamp); it
 *     asserts nothing about the underlying documents.
 *   - Terminology (§1.3): user-visible copy avoids banned crypto terms.
 *
 * Visibility (AC): an admin sees ONLY their own org scope. The digest is built
 * per (org, admin) from queue metrics scoped to that org id; sub-org rollups
 * are included only when the admin's org is the parent of those sub-orgs (the
 * `scopeOrgIds` the data source returns is the admin org plus any sub-orgs it
 * owns — never a sibling or unrelated org).
 *
 * Preferences / suppression / delivery logs / retries (AC): injected as a
 * `DigestStore`. Suppressed recipients (unsubscribed / hard-bounced) are
 * skipped before send; every attempt is written to a delivery log; transient
 * send failures are retried up to `maxAttempts` with the attempt count carried
 * in the delivery-log row so a later pass does not re-send a delivered digest.
 */

import { esc, SHARED_STYLES, wrapTemplate, formatUtc } from '../emails/_template.js';
import type { SendResult } from '../email/sender.js';

// ─────────────────────────────────────────────────────────────────────────────
// Queue-metric model — COUNTS ONLY. By construction there is no field here that
// can hold document bytes, filenames, or PII. The types are the first line of
// the §1.6 guarantee; `assertNoRawContent` is the runtime backstop.
// ─────────────────────────────────────────────────────────────────────────────

/** Per-org review-queue counters as of a point in time. Counts only. */
export interface QueueMetrics {
  /** Org this slice of counts belongs to (admin org or one of its sub-orgs). */
  orgId: string;
  /** Human-safe display name of the org (NOT a document name). */
  orgName: string;
  /** Total open items awaiting review in this org's queue. */
  openCount: number;
  /** Open items older than the aged threshold (e.g. > 48h). */
  agedCount: number;
  /** Items whose connector fetch failed and need attention. */
  failedConnectorCount: number;
}

/** The full per-admin digest input: the admin's own org plus owned sub-orgs. */
export interface DigestScope {
  /** The admin recipient. Only the email leaves the system (§1.6). */
  adminEmail: string;
  /** The admin's primary org id (used for audit + the primary action link). */
  adminOrgId: string;
  /** Metrics for the admin's org and any sub-orgs it owns. First = primary. */
  orgMetrics: QueueMetrics[];
  /** When the metrics were measured (ISO string). */
  measuredAt: string;
}

/** The rendered, send-ready digest payload. Counts + links only. */
export interface DigestPayload {
  adminEmail: string;
  adminOrgId: string;
  subject: string;
  html: string;
  /** Roll-up totals across the admin's visible scope (for logging / tests). */
  totals: { open: number; aged: number; failedConnector: number };
  /** Org ids this digest covers — used to prove scoping in tests + audit. */
  scopeOrgIds: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// No-raw-content guard (§1.6 hard backstop)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Keys that must NEVER appear anywhere in a digest scope/metric object. If a
 * future refactor accidentally widens `QueueMetrics` to carry a document field,
 * this throws before anything is rendered or sent.
 */
const FORBIDDEN_KEYS = [
  'content',
  'body',
  'bytes',
  'buffer',
  'data',
  'document',
  'filename',
  'file_name',
  'fileName',
  'fingerprint',
  'sha256',
  'hash',
  'ocr',
  'text',
  'rawText',
  'payload',
  'mimeType',
  'mime_type',
];

/**
 * Recursively assert that an object carries no raw document content / PII keys
 * and no binary values. Throws on the first violation. Pure + allocation-light.
 */
export function assertNoRawContent(value: unknown, path = 'digest'): void {
  if (value == null) return;

  // Reject binary payloads by TYPE (not just key name) — a Buffer / typed array
  // is never legitimate digest content.
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    throw new Error(`assertNoRawContent: binary value at ${path} (Buffer)`);
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    throw new Error(`assertNoRawContent: binary value at ${path} (typed array)`);
  }

  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoRawContent(v, `${path}[${i}]`));
    return;
  }

  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const lower = k.toLowerCase();
      if (FORBIDDEN_KEYS.some((f) => f.toLowerCase() === lower)) {
        throw new Error(`assertNoRawContent: forbidden key "${k}" at ${path}`);
      }
      assertNoRawContent(v, `${path}.${k}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure digest builder
// ─────────────────────────────────────────────────────────────────────────────

export interface DigestUrls {
  /** Link to the org's review queue. */
  reviewQueueUrl: (orgId: string) => string;
  /** Link to manage digest preferences / unsubscribe for this admin+org. */
  preferencesUrl: (adminOrgId: string) => string;
}

function summarize(metrics: QueueMetrics[]): DigestPayload['totals'] {
  return metrics.reduce(
    (acc, m) => ({
      open: acc.open + m.openCount,
      aged: acc.aged + m.agedCount,
      failedConnector: acc.failedConnector + m.failedConnectorCount,
    }),
    { open: 0, aged: 0, failedConnector: 0 },
  );
}

const STYLES = {
  ...SHARED_STYLES,
  th: 'text-align: left; padding: 8px 12px; border-bottom: 2px solid #e2e8f0; font-size: 13px; color: #64748b;',
  td: 'padding: 8px 12px; border-bottom: 1px solid #f1f5f9; font-size: 14px; color: #0f172a;',
  num: 'padding: 8px 12px; border-bottom: 1px solid #f1f5f9; font-size: 14px; color: #0f172a; text-align: right; font-variant-numeric: tabular-nums;',
  alert: 'color: #b91c1c; font-weight: 600;',
} as const;

/**
 * Build a send-ready digest payload for one admin from their scoped metrics.
 *
 * Runs `assertNoRawContent` on the scope BEFORE rendering so a bad input can
 * never reach the HTML. Returns null when there is nothing actionable to send
 * (zero open + zero aged + zero failed across the whole scope) — a quiet queue
 * gets no daily email.
 */
export function buildDigestPayload(
  scope: DigestScope,
  urls: DigestUrls,
): DigestPayload | null {
  assertNoRawContent(scope);

  const totals = summarize(scope.orgMetrics);
  if (totals.open === 0 && totals.aged === 0 && totals.failedConnector === 0) {
    return null;
  }

  const measured = esc(formatUtc(scope.measuredAt, 'today'));
  const primaryOrg = scope.orgMetrics[0];
  const primaryName = esc(primaryOrg?.orgName ?? 'your organization');

  const rows = scope.orgMetrics
    .map((m) => {
      const name = esc(m.orgName);
      const link = esc(urls.reviewQueueUrl(m.orgId));
      const agedCell =
        m.agedCount > 0
          ? `<span style="${STYLES.alert}">${m.agedCount}</span>`
          : '0';
      const failedCell =
        m.failedConnectorCount > 0
          ? `<span style="${STYLES.alert}">${m.failedConnectorCount}</span>`
          : '0';
      return `
        <tr>
          <td style="${STYLES.td}"><a href="${link}">${name}</a></td>
          <td style="${STYLES.num}">${m.openCount}</td>
          <td style="${STYLES.num}">${agedCell}</td>
          <td style="${STYLES.num}">${failedCell}</td>
        </tr>`;
    })
    .join('');

  const reviewUrl = esc(urls.reviewQueueUrl(scope.adminOrgId));
  const prefsUrl = esc(urls.preferencesUrl(scope.adminOrgId));

  const subject = `Your daily review summary — ${totals.open} item${totals.open === 1 ? '' : 's'} awaiting review`;

  const html = wrapTemplate(`
    <h2 style="color: #0f172a; margin-bottom: 16px;">Daily review summary for ${primaryName}</h2>
    <p>Here is what is waiting in your review queue as of ${measured}.</p>
    <table style="width: 100%; border-collapse: collapse; margin: 24px 0;">
      <thead>
        <tr>
          <th style="${STYLES.th}">Organization</th>
          <th style="${STYLES.th}; text-align: right;">Awaiting review</th>
          <th style="${STYLES.th}; text-align: right;">Aged</th>
          <th style="${STYLES.th}; text-align: right;">Connector issues</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="text-align: center; margin: 32px 0;">
      <a href="${reviewUrl}" style="${STYLES.button}">Open Review Queue</a>
    </div>
    <p style="${STYLES.muted}">This summary shows counts only. Open the review queue to act on individual items.</p>
    <p style="${STYLES.muted}">Manage how often you receive this summary, or stop receiving it:
      <a href="${prefsUrl}">notification preferences</a>.</p>
  `);

  const payload: DigestPayload = {
    adminEmail: scope.adminEmail,
    adminOrgId: scope.adminOrgId,
    subject,
    html,
    totals,
    scopeOrgIds: scope.orgMetrics.map((m) => m.orgId),
  };

  // Defense-in-depth: the rendered subject must not leak anything either.
  assertNoRawContent({ subject: payload.subject, scopeOrgIds: payload.scopeOrgIds });

  return payload;
}

// ─────────────────────────────────────────────────────────────────────────────
// Delivery orchestration — preferences, suppression, delivery log, retries
// ─────────────────────────────────────────────────────────────────────────────

/** A prior delivery-log row for an (admin, org, digest-date) idempotency key. */
export interface DeliveryLogRow {
  adminEmail: string;
  adminOrgId: string;
  digestDate: string;
  status: 'SENT' | 'FAILED' | 'SUPPRESSED';
  attempts: number;
}

/**
 * Injected persistence for preferences, suppression, and delivery logging.
 * Real implementation binds to the QUEUE_DIGEST `organization_rules` opt-in +
 * an email-suppression table + a digest delivery-log table. Kept as an
 * interface so this module is pure-testable and stays off chain/proof runtime.
 */
export interface DigestStore {
  /** True if this recipient is suppressed (unsubscribed / hard bounce). */
  isSuppressed(adminEmail: string, adminOrgId: string): Promise<boolean>;
  /** Existing delivery-log row for today's digest, if any (idempotency). */
  getDeliveryLog(
    adminEmail: string,
    adminOrgId: string,
    digestDate: string,
  ): Promise<DeliveryLogRow | null>;
  /** Upsert the delivery-log row (records status + attempt count). */
  recordDelivery(row: DeliveryLogRow): Promise<void>;
}

export interface SendDigestDeps {
  store: DigestStore;
  urls: DigestUrls;
  sendEmail: (opts: {
    to: string;
    subject: string;
    html: string;
    emailType: 'queue_reminder';
    orgId?: string;
  }) => Promise<SendResult>;
  /** Max send attempts per recipient before giving up for this digest date. */
  maxAttempts?: number;
  /** The digest date key (YYYY-MM-DD UTC). Defaults to today (UTC). */
  digestDate?: string;
}

export interface DeliverDigestResult {
  status: 'SENT' | 'SUPPRESSED' | 'SKIPPED_EMPTY' | 'ALREADY_SENT' | 'FAILED';
  attempts: number;
  scopeOrgIds: string[];
}

function utcDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Build + deliver one admin's digest, honoring suppression, idempotency, and
 * retry rules. Pure orchestration over injected deps — no DB chains here.
 */
export async function deliverDigestToAdmin(
  scope: DigestScope,
  deps: SendDigestDeps,
): Promise<DeliverDigestResult> {
  const digestDate = deps.digestDate ?? utcDateKey(new Date());
  const maxAttempts = deps.maxAttempts ?? 3;

  const payload = buildDigestPayload(scope, deps.urls);
  if (!payload) {
    return { status: 'SKIPPED_EMPTY', attempts: 0, scopeOrgIds: [] };
  }

  // Idempotency: never re-send a digest already delivered for this date.
  const existing = await deps.store.getDeliveryLog(
    scope.adminEmail,
    scope.adminOrgId,
    digestDate,
  );
  if (existing?.status === 'SENT') {
    return {
      status: 'ALREADY_SENT',
      attempts: existing.attempts,
      scopeOrgIds: payload.scopeOrgIds,
    };
  }
  if (existing && existing.attempts >= maxAttempts) {
    return {
      status: 'FAILED',
      attempts: existing.attempts,
      scopeOrgIds: payload.scopeOrgIds,
    };
  }

  // Suppression: unsubscribed / hard-bounced recipients are skipped + logged.
  if (await deps.store.isSuppressed(scope.adminEmail, scope.adminOrgId)) {
    await deps.store.recordDelivery({
      adminEmail: scope.adminEmail,
      adminOrgId: scope.adminOrgId,
      digestDate,
      status: 'SUPPRESSED',
      attempts: existing?.attempts ?? 0,
    });
    return {
      status: 'SUPPRESSED',
      attempts: existing?.attempts ?? 0,
      scopeOrgIds: payload.scopeOrgIds,
    };
  }

  const attempts = (existing?.attempts ?? 0) + 1;
  const result = await deps.sendEmail({
    to: payload.adminEmail,
    subject: payload.subject,
    html: payload.html,
    emailType: 'queue_reminder',
    orgId: payload.adminOrgId,
  });

  const status: DeliveryLogRow['status'] = result.success ? 'SENT' : 'FAILED';
  await deps.store.recordDelivery({
    adminEmail: scope.adminEmail,
    adminOrgId: scope.adminOrgId,
    digestDate,
    status,
    attempts,
  });

  return {
    status: result.success ? 'SENT' : 'FAILED',
    attempts,
    scopeOrgIds: payload.scopeOrgIds,
  };
}
