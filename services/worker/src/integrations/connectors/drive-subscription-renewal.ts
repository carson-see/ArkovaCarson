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
 * Pure orchestrator — no cron here either, and no cross-instance run-lease
 * here either (that needs a raw Supabase client, which this module
 * deliberately never touches — see `jobs/drive-subscription-renewal-deps.ts`'s
 * `runDriveSubscriptionRenewal()`, the lease-guarded entry point BOTH the
 * Cloud Scheduler HTTP route and the in-process backup call). Invoked by the
 * Lane-2 Cloud Scheduler → HTTP `/jobs/*` path (node-cron does not fire on a
 * throttled Cloud Run instance — see the Cloud Run in-process-cron gotcha in
 * jobs/agents.md).
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
 *
 * PR #1944 review round 3 (perf + reuse):
 *   - Connections are independent (different orgs/channels), so they are
 *     processed in BOUNDED CONCURRENT chunks rather than one at a time —
 *     `RENEWAL_CONCURRENCY` (5) mirrors `workspace-subscription-renewal.ts`'s
 *     own reasoning for the identical shape of problem: unbounded fan-out
 *     across ~100 orgs' worth of KMS decrypts + Drive round trips would
 *     saturate the Cloud Run instance's socket pool and look like an outage,
 *     but one at a time means one slow org blocks every connection behind it
 *     for the whole sweep.
 *   - `boundedReason` routes every persisted/alerted failure string through
 *     the canonical `boundedErrorDetail()` (`utils/byte-safety.ts`) instead
 *     of a hand-rolled length cap — `last_renewal_error` and the Sentry
 *     `extra.reason` are both externally-observable sinks, and a raw Google
 *     API error body can carry an account email or a token fragment.
 *   - `parseDriveAccountLabel` / `stringifyDriveAccountLabel`
 *     (`drive-account-label.ts`) replace an inline JSON.parse idiom that was
 *     the 3rd of 5 near-duplicate copies across the connector.
 */
import { randomBytes, randomUUID } from 'crypto';
import { boundedErrorDetail } from '../../utils/byte-safety.js';
import { parseDriveAccountLabel, stringifyDriveAccountLabel } from './drive-account-label.js';

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

/**
 * Bounded fan-out per sweep pass. Matches
 * `workspace-subscription-renewal.ts`'s `RENEWAL_CONCURRENCY` — same problem
 * shape (independent per-org vendor renewals), same reasoning: high enough
 * that one slow/throttled org doesn't serialize the whole batch behind it,
 * low enough that a `RENEWAL_BATCH_SIZE`-sized batch (100) cannot open 100
 * simultaneous KMS decrypts + Drive API calls.
 */
const RENEWAL_CONCURRENCY = 5;

/**
 * The ONE way a failure string becomes safe to persist (`last_renewal_error`)
 * or alert on (Sentry `extra.reason`) — bounded, byte-safe, AND PII-scrubbed.
 * `boundedErrorDetail` is the canonical helper (`utils/byte-safety.ts`,
 * documented in `utils/agents.md`) that every other connector error path
 * routes through; a hand-rolled length-only cap here would leave an account
 * email or token fragment from a raw Google API error body unredacted in
 * both sinks. Mirrors `connector-artifact-drain.ts`'s identical
 * `boundedReason` wrapper.
 */
function boundedReason(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return boundedErrorDetail(raw) ?? 'drive subscription renewal failed';
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
  /** Injected for deterministic concurrency tests; defaults to RENEWAL_CONCURRENCY. */
  concurrency?: number;
}): Promise<DriveSubscriptionRenewalSummary> {
  const now = args.now?.() ?? new Date();
  const horizonMs = args.horizonMs ?? DEFAULT_HORIZON_MS;
  const rows = await args.db.listRenewableConnections({ now: now.toISOString(), horizonMs });
  const concurrency = Math.max(1, args.concurrency ?? RENEWAL_CONCURRENCY);

  const summary: DriveSubscriptionRenewalSummary = {
    scanned: rows.length,
    renewed: 0,
    degraded: 0,
    failed: 0,
  };

  /**
   * PR #1944 review round 3 (reuse): the getAccessToken-throw, revoked, and
   * createChannel-throw branches used to each rebuild the identical 7-field
   * `updateConnection` payload by hand, differing only in alert `kind`, the
   * persisted `reason`, and which summary counter bumps — three copies a
   * future added field could silently land on only two of. One function now
   * owns all of it: the counter bump, the alert, and the persisted write.
   */
  async function recordSetback(
    conn: DriveSubscriptionRow,
    setback: { kind: 'token_revoked' | 'renewal_failed'; reason: string; summaryField: 'failed' | 'degraded' },
  ): Promise<void> {
    summary[setback.summaryField] += 1;
    args.alert({ integrationId: conn.id, orgId: conn.org_id, kind: setback.kind, reason: setback.reason });
    await args.db.updateConnection({
      id: conn.id,
      subscription_id: conn.subscription_id,
      subscription_expires_at: conn.subscription_expires_at,
      account_label: conn.account_label,
      last_renewal_error: setback.reason,
      last_renewal_at: now.toISOString(),
      watch_renewal_failure_count: conn.watch_renewal_failure_count + 1,
    });
  }

  /**
   * One connection's full renewal attempt. Never rejects — every expected
   * failure mode resolves via `recordSetback`, and the outer try/catch is a
   * defensive backstop (e.g. `updateConnection` itself throwing instead of
   * returning `{error:true}`) so a single connection can NEVER reject the
   * `Promise.all` for its chunk-mates and abort the rest of the sweep.
   */
  async function processOne(conn: DriveSubscriptionRow): Promise<void> {
    try {
      // 1. Resolve a fresh access token.
      let auth: { accessToken: string | null; revoked: boolean };
      try {
        auth = await args.client.getAccessToken(conn);
      } catch (err) {
        await recordSetback(conn, { kind: 'renewal_failed', reason: boundedReason(err), summaryField: 'failed' });
        return;
      }

      if (auth.revoked || !auth.accessToken) {
        await recordSetback(conn, {
          kind: 'token_revoked',
          reason: 'oauth grant revoked — reconnect required',
          summaryField: 'degraded',
        });
        return;
      }

      // 2. Register the fresh channel under a NEW random channel token (GH
      //    #1836 rotation) — never the org id. CREATE FIRST, stop the old
      //    one LAST (PR #1944 review, CRITICAL fix): Google's changes.watch
      //    explicitly supports multiple simultaneous channels on one
      //    resource, so there is no need to tear down the old channel before
      //    the new one exists. The old ordering (stop-then-create) meant a
      //    createChannel failure — realistic on a first deploy before
      //    WORKER_PUBLIC_URL is configured, or any transient Google 5xx —
      //    left the row pointing at a channel we had ALREADY stopped: zero
      //    live channels, and the persisted row lying that the old one is
      //    still active, on a connection that may have had hours or days of
      //    validity left. This renewal job would have reproduced GH #1835's
      //    exact silent-outage symptom on HEALTHY connections. The old
      //    channel is now stopped ONLY after the new one is both live at
      //    Google AND successfully persisted — the two moments where it is
      //    actually safe to retire it.
      const label = parseDriveAccountLabel(conn.account_label);
      const newChannelId = (args.channelIdFactory ?? defaultChannelIdFactory)();
      const newChannelToken = (args.channelTokenFactory ?? defaultChannelTokenFactory)();
      try {
        const created = await args.client.createChannel({
          accessToken: auth.accessToken,
          channelId: newChannelId,
          channelToken: newChannelToken,
        });
        const newLabel = stringifyDriveAccountLabel({
          email: label?.email ?? null,
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
          // The new channel exists at Google but we could not persist it —
          // the OLD channel (still in the DB, still live at Google, since we
          // have not touched it) remains the source of truth. Do NOT stop
          // it: doing so here would reproduce the exact bug this reordering
          // fixes, just on the write-failure path instead of the throw path.
          // The orphaned new channel is harmless (nothing in the DB
          // references its id, so a push through it 200-acks as "unknown
          // channel" — see webhooks/drive.ts) and expires on its own.
          summary.failed += 1;
          args.alert({
            integrationId: conn.id,
            orgId: conn.org_id,
            kind: 'renewal_failed',
            reason: 'watch-state update failed',
          });
        } else {
          summary.renewed += 1;
          // 3. ONLY NOW — new channel live AND persisted — best-effort stop
          //    the old one. A stop failure just means it expires naturally
          //    in ~7 days, which is fine: the NEW channel is already the one
          //    of record.
          await tryStop(args.client, {
            accessToken: auth.accessToken,
            channelId: conn.subscription_id,
            resourceId: label?.resource_id ?? null,
          });
        }
      } catch (err) {
        // createChannel itself failed. The old channel was NEVER touched —
        // persisting the connection's existing (unchanged) subscription
        // state via recordSetback is therefore accurate, not a lie.
        await recordSetback(conn, { kind: 'renewal_failed', reason: boundedReason(err), summaryField: 'failed' });
      }
    } catch (err) {
      // Defensive backstop — see the function doc comment. Every expected
      // path above already returns before reaching here.
      summary.failed += 1;
      args.alert({ integrationId: conn.id, orgId: conn.org_id, kind: 'renewal_failed', reason: boundedReason(err) });
    }
  }

  // FINDING 2 (PR #1944 review round 3, perf): sequential across chunks,
  // CONCURRENT within one. Connections are independent (different
  // orgs/channels) so there is no ordering requirement between them — only
  // the socket-pool / vendor-throttling ceiling `RENEWAL_CONCURRENCY` bounds
  // how many run at once.
  for (let i = 0; i < rows.length; i += concurrency) {
    const chunk = rows.slice(i, i + concurrency);
    await Promise.all(chunk.map((conn) => processOne(conn)));
  }

  return summary;
}

function defaultChannelIdFactory(): string {
  return randomUUID();
}

function defaultChannelTokenFactory(): string {
  return randomBytes(32).toString('base64url');
}
