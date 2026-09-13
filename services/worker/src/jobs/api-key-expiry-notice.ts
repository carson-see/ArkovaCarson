/**
 * SCRUM-5023 — daily API-key expiry notice.
 *
 * WHAT THIS FIXES. Key expiry was write-once and entirely silent. Prod
 * (read-only, 2026-09-12) held 19 keys, 13 of them `is_active = true` with an
 * expiry already past. HakiChain's two keys were created 2026-06-01 with a
 * 30-day expiry, lapsed 2026-07-01, and the partner's first signal was a 401
 * in their own logs. `middleware/apiKeyAuth.ts` had been correctly refusing
 * those keys the whole time — the defect was never in enforcement, it was that
 * enforcement was the ONLY place the expiry was visible.
 *
 * THE DEDUPE LEDGER IS `audit_events`, ON PURPOSE. There is no
 * `last_notified_at` column and this story adds no migration, so a notice
 * writes an `api_key.expiry_notice` row (target_id = key id, details.kind and
 * details.expires_at) and a key carrying a matching row is skipped. The job's
 * only trigger is Cloud Scheduler — there is no in-process schedule for it —
 * but Scheduler re-drives a failed attempt, and without the ledger every daily
 * run would re-mail every key still inside the notice window.
 *
 * THE LEDGER KEY IS (kind, expires_at), NOT (kind, this week). A time-boxed
 * horizon is the wrong shape twice over. A key that lapsed in July stays
 * lapsed, so a 7-day horizon re-mails its "expired" notice every week forever;
 * and an "expiring" notice keyed to a calendar window re-fires at the seam.
 * Keying on the expiry VALUE says the true thing: one notice per kind per
 * expiry. Extend the key and the value changes, so the next approach earns a
 * fresh warning — which is exactly the behaviour an owner expects.
 *
 * A LEDGER ROW IS WRITTEN ONLY AFTER A SUCCESSFUL SEND, AND THE WRITE IS
 * CHECKED. Recording on a failed send would mark the key notified and
 * permanently swallow the one warning it had coming. Recording WITHOUT
 * checking is the same defect pointing the other way: `recordAuditEvent` never
 * rejects, so an `await` that ignores its result proves only that the attempt
 * finished, and a silently lost row re-mails every admin daily until the
 * insert starts working. The write reports `{ ok }` and a false counts as a
 * per-key failure.
 *
 * CONSTITUTION 1.4 / 1.6: the notice carries the key PREFIX and NAME. Never
 * the key (unrecoverable anyway — only the HMAC is stored), never the hash.
 * The only personal datum involved is the admin's own email address, which is
 * the address the mail is being sent to.
 */

import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { recordAuditEvent } from '../utils/auditEvent.js';
import { sendApiKeyExpiryEmail, type ApiKeyExpiryKind } from '../emails/api-key-expiry.js';
import { expiresInDays, isExpiredAt } from '../api/v1/keyExpiryStatus.js';
import { listOrgAdminRecipients } from '../utils/orgAdminRecipients.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far ahead an upcoming expiry is announced. */
export const NOTICE_LEAD_DAYS = 7;

/** The audit event type that doubles as the dedupe ledger. */
export const EXPIRY_NOTICE_EVENT = 'api_key.expiry_notice';

/** The columns this job reads off `api_keys`. Deliberately excludes key_hash. */
export interface ExpiringKeyRow {
  id: string;
  org_id: string;
  name: string;
  key_prefix: string;
  expires_at: string;
}

/** One prior notice, as the ledger recorded it. */
export interface PriorNotice {
  kind: string;
  /** The `expires_at` the notice was about. Absent on a row that predates it. */
  expiresAt: string | null;
}

export interface ExpiryNoticePayload {
  to: string;
  orgId: string;
  keyName: string;
  keyPrefix: string;
  kind: ApiKeyExpiryKind;
  expiresAt: string;
  daysRemaining: number | null;
}

export interface ApiKeyExpiryNoticeDeps {
  /** False when no email provider is configured — the run then no-ops. */
  emailConfigured: boolean;
  now?: Date;
  /**
   * Every live key whose expiry is at or before `windowEnd`. NO LOWER BOUND —
   * see `runApiKeyExpiryNotice`.
   */
  listKeysInWindow(windowEnd: string): Promise<ExpiringKeyRow[]>;
  /** Every notice already recorded for this key, unbounded in time. */
  listPriorNotices(keyId: string): Promise<PriorNotice[]>;
  listOrgAdminEmails(orgId: string): Promise<string[]>;
  sendNotice(payload: ExpiryNoticePayload): Promise<{ success: boolean }>;
  /** @throws when the ledger row did not land — the caller must not count a send. */
  recordNotice(args: {
    keyId: string;
    orgId: string;
    kind: ApiKeyExpiryKind;
    expiresAt: string;
  }): Promise<void>;
}

export interface ApiKeyExpiryNoticeResult {
  skipped: boolean;
  reason?: string;
  scanned: number;
  notified: number;
  deduped: number;
  noRecipients: number;
  failed: number;
}

/**
 * Run one sweep. Pure with respect to I/O — every external effect is injected,
 * which is what lets the dedupe and the unconfigured-provider skip be tested
 * without a database or a mail account.
 */
export async function runApiKeyExpiryNotice(
  deps: ApiKeyExpiryNoticeDeps,
): Promise<ApiKeyExpiryNoticeResult> {
  const empty: ApiKeyExpiryNoticeResult = {
    skipped: false, scanned: 0, notified: 0, deduped: 0, noRecipients: 0, failed: 0,
  };

  // Safe when the provider is unconfigured: log, skip, write NOTHING. In
  // particular no ledger row, so a correctly-configured environment still
  // delivers the notice on its next run rather than finding it "already sent".
  if (!deps.emailConfigured) {
    logger.warn('api-key-expiry-notice skipped — no email provider configured');
    return { ...empty, skipped: true, reason: 'email_not_configured' };
  }

  const now = deps.now ?? new Date();
  const windowEnd = new Date(now.getTime() + NOTICE_LEAD_DAYS * DAY_MS).toISOString();

  // NO LOWER BOUND. A 24h lookback matched the cron period exactly, so a key
  // was eligible for its lapse notice for one run and one run only: a single
  // missed or failed execution lost it permanently, and the 13 keys already
  // lapsed when this job shipped could never be told at all — including
  // HakiChain's two, the pair this story was written for. The (kind,
  // expires_at) ledger is what makes an open-ended lower bound safe: each key
  // is still mailed exactly once per expiry value, whenever the job first
  // manages to reach it.
  const keys = await deps.listKeysInWindow(windowEnd);
  const result: ApiKeyExpiryNoticeResult = { ...empty, scanned: keys.length };

  for (const key of keys) {
    try {
      // Same rule the list route renders — including the fail-closed handling
      // of an unparseable timestamp, which a local `<=` comparison would get
      // backwards (`new Date('x') <= now` is false).
      const kind: ApiKeyExpiryKind = isExpiredAt(key.expires_at, now) ? 'expired' : 'expiring';

      const prior = await deps.listPriorNotices(key.id);
      if (prior.some((notice) => notice.kind === kind && notice.expiresAt === key.expires_at)) {
        result.deduped += 1;
        continue;
      }

      const recipients = await deps.listOrgAdminEmails(key.org_id);
      if (recipients.length === 0) {
        // Not a failure of this job — an org with no admin has nobody to tell.
        // Counted so the condition is visible in the run result rather than
        // silently indistinguishable from "nothing was due".
        logger.warn({ orgId: key.org_id, keyId: key.id }, 'API key expiry notice has no ORG_ADMIN recipient');
        result.noRecipients += 1;
        continue;
      }

      const daysRemaining = expiresInDays(key.expires_at, now);
      let delivered = false;
      for (const to of recipients) {
        const sent = await deps.sendNotice({
          to,
          orgId: key.org_id,
          keyName: key.name,
          keyPrefix: key.key_prefix,
          kind,
          expiresAt: key.expires_at,
          daysRemaining,
        });
        if (sent.success) delivered = true;
      }

      if (!delivered) {
        result.failed += 1;
        continue;
      }

      // Throws when the row did not land; the catch below counts it as a
      // failure so the next run retries rather than silently re-mailing.
      await deps.recordNotice({ keyId: key.id, orgId: key.org_id, kind, expiresAt: key.expires_at });
      result.notified += 1;
    } catch (error) {
      // One malformed row, one org lookup that blows up, must not stop the
      // sweep — the remaining keys are the ones still owed a warning.
      logger.error({ error, keyId: key.id }, 'API key expiry notice failed for one key');
      result.failed += 1;
    }
  }

  logger.info(result, 'api-key-expiry-notice complete');
  return result;
}

/** Wire the real database, mailer, and audit writer. */
export function makeApiKeyExpiryNoticeDeps(): ApiKeyExpiryNoticeDeps {
  return {
    emailConfigured: Boolean(config.resendApiKey),

    async listKeysInWindow(windowEnd) {
      // eslint-disable-next-line arkova/missing-org-filter -- cross-org by design: a daily sweep over EVERY org's keys. Tenant scope is applied per row below, where `key.org_id` selects that org's admins and nothing leaves this process except an email to those admins about their own key.
      const { data, error } = await db.from('api_keys')
        .select('id, org_id, name, key_prefix, expires_at')
        .eq('is_active', true)
        .is('revoked_at', null)
        .not('expires_at', 'is', null)
        .lte('expires_at', windowEnd);

      if (error) throw new Error(`api_keys expiry window query failed: ${error.message}`);
      return (data ?? []) as ExpiringKeyRow[];
    },

    async listPriorNotices(keyId) {
      // eslint-disable-next-line arkova/missing-org-filter -- scoped by target_id (the key's own uuid), which is strictly narrower than an org filter: it addresses one row-owner's notices. Only `kind` and `expires_at` are read back.
      const { data, error } = await db.from('audit_events')
        .select('details')
        .eq('event_type', EXPIRY_NOTICE_EVENT)
        .eq('target_type', 'api_key')
        .eq('target_id', keyId);

      // A dedupe lookup that FAILS must not be read as "no prior notice" —
      // that would re-send on every run for as long as the error persists.
      if (error) throw new Error(`expiry-notice dedupe lookup failed: ${error.message}`);

      return (data ?? []).flatMap((row): PriorNotice[] => {
        try {
          const parsed = JSON.parse(String((row as { details?: unknown }).details ?? '{}'));
          if (typeof parsed?.kind !== 'string') return [];
          return [{
            kind: parsed.kind,
            expiresAt: typeof parsed.expires_at === 'string' ? parsed.expires_at : null,
          }];
        } catch {
          // A row whose details will not parse cannot prove WHICH notice was
          // sent. Ignoring it risks one duplicate email; treating it as a
          // match risks swallowing the notice entirely.
          return [];
        }
      });
    },

    listOrgAdminEmails(orgId) {
      // Union of `profiles.role = 'ORG_ADMIN'` and `org_members` owner/admin —
      // see utils/orgAdminRecipients.ts for the prod row that made a
      // profiles-only lookup lose an org's only administrator.
      return listOrgAdminRecipients(db, orgId);
    },

    async sendNotice(payload) {
      const { success } = await sendApiKeyExpiryEmail({
        recipientEmail: payload.to,
        keyName: payload.keyName,
        keyPrefix: payload.keyPrefix,
        kind: payload.kind,
        expiresAt: payload.expiresAt,
        daysRemaining: payload.daysRemaining,
        manageKeysUrl: `${config.frontendUrl}/settings/api-keys`,
        orgId: payload.orgId,
      });
      return { success };
    },

    async recordNotice({ keyId, orgId, kind, expiresAt }) {
      // AWAITED **and CHECKED**, unlike the fire-and-forget lifecycle events in
      // keys.ts: this row IS the dedupe state. `recordAuditEvent` never
      // rejects, so an unchecked `await` would report success on a lost write
      // and re-mail this admin every day until the insert started working.
      const { ok } = await recordAuditEvent({
        org_id: orgId,
        event_type: EXPIRY_NOTICE_EVENT,
        event_category: 'API',
        target_type: 'api_key',
        target_id: keyId,
        details: JSON.stringify({ kind, expires_at: expiresAt }),
      });

      if (!ok) {
        throw new Error(`expiry-notice ledger write failed for key ${keyId}`);
      }
    },
  };
}

/** Entry point for the cron route. */
export async function runApiKeyExpiryNoticeJob(): Promise<ApiKeyExpiryNoticeResult> {
  return runApiKeyExpiryNotice(makeApiKeyExpiryNoticeDeps());
}
