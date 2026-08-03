/**
 * GH #1835 — Google Drive `changes.watch` channel renewal.
 *
 * Every Drive `org_integrations` connection carries exactly ONE live push
 * channel, tracked directly on the row: `subscription_id` (our channel id),
 * `subscription_expires_at` (Drive caps this at ~7 days), and (inside the
 * `account_label` JSON blob) `channel_token` + `resource_id`. Nothing
 * renewed this before GH #1835 — `drive-oauth.ts`'s OAuth callback registers
 * the FIRST channel at connect time and nothing ever re-registers it, so
 * every Drive connection goes silent within a week of connecting with no
 * error, no alert, and no signal beyond the org dashboard still showing
 * "connected".
 *
 * This is a DIFFERENT (and, as of GH #1835, the only LIVE) watch-tracking
 * surface from `drive-channel-renewal.ts` (DRIVE-02/06, SCRUM-2367/2371),
 * which renews rows in the folder-scoped `drive_watch_state` table. That
 * table has a fully-built bootstrap + renewal pipeline but zero production
 * callers as of this fix — nothing ever writes a `drive_watch_state` row, so
 * wiring ITS renewal sweep into a cron would find nothing to renew. The
 * `org_integrations` columns below are what `webhooks/drive.ts` and
 * `drive-oauth.ts` actually read and write in prod today. Reconciling the two
 * systems is tracked as follow-up architecture debt, not solved here.
 *
 * Pure orchestrator — no cron here either. Invoked by the Lane-2 Cloud
 * Scheduler → HTTP `/jobs/*` path (node-cron does not fire on a throttled
 * Cloud Run instance — see the Cloud Run in-process-cron gotcha in
 * jobs/agents.md). Production wiring (real Supabase + real Drive API calls)
 * lives in `jobs/drive-subscription-renewal-deps.ts`; the cron route is
 * `POST /jobs/drive-subscription-renewal` in `routes/cron.ts`.
 *
 * Idempotent by construction: each pass only ever UPDATEs an existing
 * `org_integrations` row by `id`. Re-running converges to a single active
 * channel per connection.
 *
 * GH #1836 pairing: every successful renewal mints a FRESH random
 * `channel_token` (never reuses the org id), so a renewal sweep is also the
 * rotation mechanism that upgrades a legacy org-id-token connection to a real
 * secret without requiring the user to reconnect.
 *
 * CRITICAL invariant: renewal NEVER touches `last_page_token`. That column is
 * the live changes-feed cursor, advanced independently by
 * `drive-changes-processor.ts`'s `advancePageToken`. `createChangesWatch`
 * always calls Drive's `changes.getStartPageToken` internally and returns a
 * fresh token — if a renewal persisted that value it would silently reset
 * the cursor and DROP every unprocessed change between the last successful
 * advance and the renewal. We deliberately discard the returned
 * `startPageToken` (mirrors the DRIVE-06 `drive-channel-renewal.ts` sweep,
 * which has the identical rule for its own `initial_page_token` field).
 */
import { randomBytes, randomUUID } from 'crypto';

export interface DriveSubscriptionRow {
  id: string;
  org_id: string;
  subscription_id: string | null;
  subscription_expires_at: string | null;
  /** JSON string: `{ email, channel_token, resource_id }` (or null/legacy). */
  account_label: string | null;
  watch_renewal_failure_count: number;
}

export interface DriveSubscriptionRenewalDb {
  /**
   * Rows for entitled, non-revoked google_drive connections whose channel is
   * within the pre-expiry window, already expired, or was never registered
   * (`subscription_id IS NULL` — a prior bootstrap failure). Bounded LIMIT is
   * the DB adapter's concern; this sweep processes whatever it is handed.
   */
  listRenewableConnections(args: { now: string; horizonMs: number }): Promise<DriveSubscriptionRow[]>;
  /** Update an existing org_integrations row by id. `error: true` on DB failure. */
  updateConnection(update: {
    id: string;
    subscription_id: string | null;
    subscription_expires_at: string | null;
    account_label: string | null;
    last_renewal_error: string | null;
    last_renewal_at: string;
    watch_renewal_failure_count: number;
  }): Promise<{ error: boolean }>;
}

export interface DriveSubscriptionRenewalClient {
  /**
   * Resolve a fresh access token for the connection. `revoked: true` means
   * the OAuth grant was revoked at Google (refresh failed with an
   * auth-shaped error) — degrade + alert, recoverable once the org
   * reconnects. Any other resolution failure should throw (treated the same
   * as a renewal failure below).
   */
  getAccessToken(conn: DriveSubscriptionRow): Promise<{ accessToken: string | null; revoked: boolean }>;
  /** Best-effort stop of the OLD push channel. Failure must not abort renewal. */
  stopChannel(args: { accessToken: string; channelId: string; resourceId: string | null }): Promise<void>;
  /** Register a fresh push channel under a NEW random channel token. */
  createChannel(args: {
    accessToken: string;
    channelId: string;
    channelToken: string;
  }): Promise<{ resourceId: string; expiration: string }>;
}

export type DriveSubscriptionRenewalAlert = (event: {
  integrationId: string;
  orgId: string;
  kind: 'token_revoked' | 'renewal_failed';
  reason: string;
}) => void;

export interface DriveSubscriptionRenewalSummary {
  scanned: number;
  renewed: number;
  degraded: number;
  failed: number;
}

/** Default: renew channels expiring within the next 24h (well inside Drive's ~7-day cap). */
const DEFAULT_HORIZON_MS = 24 * 60 * 60 * 1000;
const REASON_CAP = 500;

function boundedReason(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.length > REASON_CAP ? raw.slice(0, REASON_CAP) : raw;
}

function parseAccountLabel(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function tryStop(
  client: DriveSubscriptionRenewalClient,
  args: { accessToken: string; channelId: string | null; resourceId: string | null },
): Promise<void> {
  if (!args.channelId) return;
  try {
    await client.stopChannel({
      accessToken: args.accessToken,
      channelId: args.channelId,
      resourceId: args.resourceId,
    });
  } catch {
    // Old channel may already be gone (expired / already stopped) — a stop
    // failure must never block renewal of the new one.
  }
}

export async function renewDriveSubscriptions(args: {
  db: DriveSubscriptionRenewalDb;
  client: DriveSubscriptionRenewalClient;
  alert: DriveSubscriptionRenewalAlert;
  now?: () => Date;
  horizonMs?: number;
  /** Injected for deterministic tests; defaults to crypto.randomUUID. */
  channelIdFactory?: () => string;
  /** Injected for deterministic tests; defaults to a random base64url secret. */
  channelTokenFactory?: () => string;
}): Promise<DriveSubscriptionRenewalSummary> {
  const now = args.now?.() ?? new Date();
  const horizonMs = args.horizonMs ?? DEFAULT_HORIZON_MS;
  const rows = await args.db.listRenewableConnections({ now: now.toISOString(), horizonMs });

  const summary: DriveSubscriptionRenewalSummary = {
    scanned: rows.length,
    renewed: 0,
    degraded: 0,
    failed: 0,
  };

  for (const conn of rows) {
    // 1. Resolve a fresh access token.
    let auth: { accessToken: string | null; revoked: boolean };
    try {
      auth = await args.client.getAccessToken(conn);
    } catch (err) {
      summary.failed += 1;
      const reason = boundedReason(err);
      args.alert({ integrationId: conn.id, orgId: conn.org_id, kind: 'renewal_failed', reason });
      await args.db.updateConnection({
        id: conn.id,
        subscription_id: conn.subscription_id,
        subscription_expires_at: conn.subscription_expires_at,
        account_label: conn.account_label,
        last_renewal_error: reason,
        last_renewal_at: now.toISOString(),
        watch_renewal_failure_count: conn.watch_renewal_failure_count + 1,
      });
      continue;
    }

    if (auth.revoked || !auth.accessToken) {
      summary.degraded += 1;
      const reason = 'oauth grant revoked — reconnect required';
      args.alert({ integrationId: conn.id, orgId: conn.org_id, kind: 'token_revoked', reason });
      await args.db.updateConnection({
        id: conn.id,
        subscription_id: conn.subscription_id,
        subscription_expires_at: conn.subscription_expires_at,
        account_label: conn.account_label,
        last_renewal_error: reason,
        last_renewal_at: now.toISOString(),
        watch_renewal_failure_count: conn.watch_renewal_failure_count + 1,
      });
      continue;
    }

    // 2. Best-effort stop of the OLD channel (only if one was ever registered).
    const label = parseAccountLabel(conn.account_label);
    const oldResourceId = typeof label.resource_id === 'string' ? label.resource_id : null;
    await tryStop(args.client, {
      accessToken: auth.accessToken,
      channelId: conn.subscription_id,
      resourceId: oldResourceId,
    });

    // 3. Register the fresh channel under a NEW random channel token (GH
    //    #1836 rotation) — never the org id.
    const newChannelId = (args.channelIdFactory ?? defaultChannelIdFactory)();
    const newChannelToken = (args.channelTokenFactory ?? defaultChannelTokenFactory)();
    try {
      const created = await args.client.createChannel({
        accessToken: auth.accessToken,
        channelId: newChannelId,
        channelToken: newChannelToken,
      });
      const newLabel = JSON.stringify({
        ...label,
        channel_token: newChannelToken,
        resource_id: created.resourceId,
      });
      const res = await args.db.updateConnection({
        id: conn.id,
        subscription_id: newChannelId,
        subscription_expires_at: created.expiration,
        account_label: newLabel,
        // NOTE: last_page_token is intentionally absent from this update —
        // see the module doc comment. Never touched by renewal.
        last_renewal_error: null,
        last_renewal_at: now.toISOString(),
        watch_renewal_failure_count: 0,
      });
      if (res.error) {
        summary.failed += 1;
        args.alert({
          integrationId: conn.id,
          orgId: conn.org_id,
          kind: 'renewal_failed',
          reason: 'watch-state update failed',
        });
      } else {
        summary.renewed += 1;
      }
    } catch (err) {
      summary.failed += 1;
      const reason = boundedReason(err);
      args.alert({ integrationId: conn.id, orgId: conn.org_id, kind: 'renewal_failed', reason });
      await args.db.updateConnection({
        id: conn.id,
        subscription_id: conn.subscription_id,
        subscription_expires_at: conn.subscription_expires_at,
        account_label: conn.account_label,
        last_renewal_error: reason,
        last_renewal_at: now.toISOString(),
        watch_renewal_failure_count: conn.watch_renewal_failure_count + 1,
      });
    }
  }

  return summary;
}

function defaultChannelIdFactory(): string {
  return randomUUID();
}

function defaultChannelTokenFactory(): string {
  return randomBytes(32).toString('base64url');
}
