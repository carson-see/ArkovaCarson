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
 * writes an `api_key.expiry_notice` row (target_id = key id, details.kind) and
 * a key carrying a matching row inside the last 7 days is skipped. That is not
 * a workaround for a missing column — it is the property this job needs, since
 * it can run more than once a day in two independent ways: Cloud Scheduler
 * retrying a 500, and the in-process backup schedule, which on Cloud Run fires
 * on EVERY warm instance (prod runs minScale 2, so an in-process cron double-
 * runs by default). Without the ledger the first partner to reach T-7 receives
 * a fortnight of daily duplicates.
 *
 * A LEDGER ROW IS WRITTEN ONLY AFTER A SUCCESSFUL SEND. Recording on a failed
 * send would mark the key notified for 7 days and permanently swallow the one
 * warning it had coming — the same silence, now with an audit row asserting
 * otherwise.
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
import { expiresInDays } from '../api/v1/keyExpiryStatus.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far ahead an upcoming expiry is announced. */
export const NOTICE_LEAD_DAYS = 7;

/** How far back a lapse is still announced (one daily run's worth). */
export const NOTICE_LOOKBACK_HOURS = 24;

/** Dedupe horizon — one notice per key per kind per week. */
export const NOTICE_DEDUPE_DAYS = 7;

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
  listKeysInWindow(windowStart: string, windowEnd: string): Promise<ExpiringKeyRow[]>;
  listRecentNoticeKinds(keyId: string, since: string): Promise<string[]>;
  listOrgAdminEmails(orgId: string): Promise<string[]>;
  sendNotice(payload: ExpiryNoticePayload): Promise<{ success: boolean }>;
  recordNotice(args: { keyId: string; orgId: string; kind: ApiKeyExpiryKind }): Promise<void>;
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
  const windowStart = new Date(now.getTime() - NOTICE_LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
  const windowEnd = new Date(now.getTime() + NOTICE_LEAD_DAYS * DAY_MS).toISOString();
  const dedupeSince = new Date(now.getTime() - NOTICE_DEDUPE_DAYS * DAY_MS).toISOString();

  const keys = await deps.listKeysInWindow(windowStart, windowEnd);
  const result: ApiKeyExpiryNoticeResult = { ...empty, scanned: keys.length };

  for (const key of keys) {
    try {
      const expiresAtMs = new Date(key.expires_at).getTime();
      const kind: ApiKeyExpiryKind = expiresAtMs <= now.getTime() ? 'expired' : 'expiring';

      const priorKinds = await deps.listRecentNoticeKinds(key.id, dedupeSince);
      if (priorKinds.includes(kind)) {
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

      await deps.recordNotice({ keyId: key.id, orgId: key.org_id, kind });
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

    async listKeysInWindow(windowStart, windowEnd) {
      // eslint-disable-next-line arkova/missing-org-filter -- cross-org by design: a daily sweep over EVERY org's keys. Tenant scope is applied per row below, where `key.org_id` selects that org's ORG_ADMINs and nothing leaves this process except an email to those admins about their own key.
      const { data, error } = await db.from('api_keys')
        .select('id, org_id, name, key_prefix, expires_at')
        .eq('is_active', true)
        .is('revoked_at', null)
        .not('expires_at', 'is', null)
        .gte('expires_at', windowStart)
        .lte('expires_at', windowEnd);

      if (error) throw new Error(`api_keys expiry window query failed: ${error.message}`);
      return (data ?? []) as ExpiringKeyRow[];
    },

    async listRecentNoticeKinds(keyId, since) {
      // eslint-disable-next-line arkova/missing-org-filter -- scoped by target_id (the key's own uuid), which is strictly narrower than an org filter: it addresses one row-owner's notices. Only the `kind` string is read back.
      const { data, error } = await db.from('audit_events')
        .select('details')
        .eq('event_type', EXPIRY_NOTICE_EVENT)
        .eq('target_id', keyId)
        .gte('created_at', since);

      // A dedupe lookup that FAILS must not be read as "no prior notice" —
      // that would re-send on every run for as long as the error persists.
      if (error) throw new Error(`expiry-notice dedupe lookup failed: ${error.message}`);

      return (data ?? []).flatMap((row) => {
        try {
          const parsed = JSON.parse(String((row as { details?: unknown }).details ?? '{}'));
          return typeof parsed?.kind === 'string' ? [parsed.kind] : [];
        } catch {
          // A row whose details will not parse cannot prove a notice of a
          // given KIND was sent. Ignoring it risks one duplicate email;
          // treating it as a match risks swallowing the notice entirely.
          return [];
        }
      });
    },

    async listOrgAdminEmails(orgId) {
      const { data, error } = await db.from('profiles')
        .select('email')
        .eq('org_id', orgId)
        .eq('role', 'ORG_ADMIN');

      if (error) throw new Error(`ORG_ADMIN lookup failed: ${error.message}`);
      return (data ?? [])
        .map((row) => (row as { email?: string | null }).email)
        .filter((email): email is string => typeof email === 'string' && email.length > 0);
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

    async recordNotice({ keyId, orgId, kind }) {
      // AWAITED, unlike the fire-and-forget lifecycle events in keys.ts: this
      // row IS the dedupe state. A lost write means a duplicate email
      // tomorrow, so the caller needs to know it landed before counting the
      // key notified.
      await recordAuditEvent({
        org_id: orgId,
        event_type: EXPIRY_NOTICE_EVENT,
        event_category: 'API',
        target_type: 'api_key',
        target_id: keyId,
        details: JSON.stringify({ kind }),
      });
    },
  };
}

/** Entry point for the cron route. */
export async function runApiKeyExpiryNoticeJob(): Promise<ApiKeyExpiryNoticeResult> {
  return runApiKeyExpiryNotice(makeApiKeyExpiryNoticeDeps());
}
