/**
 * DRIVE-06 (SCRUM-2371) — Google Drive folder-watch channel renewal.
 *
 * Drive push-notification channels expire (~7 days). This module renews them
 * BEFORE expiry, recovers already-expired channels idempotently, alerts on
 * failure + records a bounded ops reason, and respects entitlement (a watch
 * whose org lost its paid/verified entitlement is STOPPED, not renewed).
 *
 * NO CRON HERE. `renewDriveWatchChannels` is a pure orchestrator invoked by the
 * Lane-2 Cloud Scheduler → HTTP `/jobs/*` path — in-process node-cron timers do
 * NOT fire on a throttled Cloud Run instance (see the Cloud Run in-process-cron
 * gotcha). The renewal CADENCE is a HANDOFF to Lane 2's scheduler; this module
 * only performs one renewal sweep when called.
 *
 * Idempotent by construction: the sweep only ever UPDATEs an existing watch row
 * by `id`. Re-running converges to a single active channel per watch; no
 * duplicate watch rows are ever created.
 */

export interface DriveRenewableWatch {
  id: string;
  org_id: string;
  integration_id: string;
  watched_folder_id: string;
  channel_id: string;
  channel_resource_id: string | null;
  channel_expires_at: string | null;
  owner_scope: 'my_drive' | 'shared_drive';
  drive_id: string | null;
  status: string;
}

export interface DriveRenewalDb {
  /**
   * Rows whose channel is within the pre-expiry window OR already expired, for
   * an entitled + non-revoked integration. Bounded LIMIT is the DB's concern;
   * this sweep processes whatever it is handed. The DB filters to renewal-due +
   * active/expired/degraded statuses (never 'stopped').
   */
  listRenewableWatches(args: { now: string; horizonMs: number }): Promise<DriveRenewableWatch[]>;
  /** Update an existing watch row by id. `error:true` on DB failure. */
  updateWatchState(update: {
    id: string;
    channel_id?: string;
    channel_resource_id?: string | null;
    channel_expires_at?: string | null;
    status: 'active' | 'degraded' | 'stopped' | 'expired';
    last_renewal_error: string | null;
  }): Promise<{ error: boolean }>;
}

export interface DriveRenewalClient {
  /**
   * Resolve a fresh access token for the watch's integration. `entitled:false`
   * means the org no longer holds the paid/verified entitlement (→ stop the
   * watch). `accessToken:null` with `entitled:true` means the OAuth grant was
   * revoked (→ degrade + alert).
   */
  getAccessToken(watch: DriveRenewableWatch): Promise<{ accessToken: string | null; entitled: boolean }>;
  /** Best-effort stop of the old push channel. Failure must not abort renewal. */
  stopChannel(args: { accessToken: string; channelId: string; resourceId: string | null }): Promise<void>;
  /** Register a fresh push channel + start page token. */
  createChannel(watch: DriveRenewableWatch, accessToken: string): Promise<{
    channelId: string;
    resourceId: string;
    expiration: string;
    startPageToken: string;
  }>;
}

/** Fired on any renewal failure so ops can act. Kept side-effect-free here. */
export type DriveRenewalAlert = (event: {
  watchId: string;
  orgId: string;
  integrationId: string;
  kind: 'token_revoked' | 'renewal_failed';
  reason: string;
}) => void;

export interface DriveRenewalSummary {
  scanned: number;
  renewed: number;
  failed: number;
  stopped: number;
}

/** Default: renew channels expiring within the next 24h. */
const DEFAULT_HORIZON_MS = 24 * 60 * 60 * 1000;
const REASON_CAP = 500;

function boundedReason(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.length > REASON_CAP ? raw.slice(0, REASON_CAP) : raw;
}

export async function renewDriveWatchChannels(args: {
  db: DriveRenewalDb;
  client: DriveRenewalClient;
  now?: () => Date;
  alert: DriveRenewalAlert;
  horizonMs?: number;
}): Promise<DriveRenewalSummary> {
  const now = (args.now?.() ?? new Date());
  const horizonMs = args.horizonMs ?? DEFAULT_HORIZON_MS;
  const rows = await args.db.listRenewableWatches({ now: now.toISOString(), horizonMs });

  const summary: DriveRenewalSummary = {
    scanned: rows.length,
    renewed: 0,
    failed: 0,
    stopped: 0,
  };

  for (const watch of rows) {
    // 1. Entitlement / token check.
    let auth: { accessToken: string | null; entitled: boolean };
    try {
      auth = await args.client.getAccessToken(watch);
    } catch (err) {
      summary.failed += 1;
      const reason = boundedReason(err);
      args.alert({ watchId: watch.id, orgId: watch.org_id, integrationId: watch.integration_id, kind: 'renewal_failed', reason });
      await args.db.updateWatchState({ id: watch.id, status: 'degraded', last_renewal_error: reason });
      continue;
    }

    // Entitlement lost → STOP the watch (do not renew). Best-effort remote stop.
    if (!auth.entitled) {
      await tryStop(args.client, watch, auth.accessToken);
      const res = await args.db.updateWatchState({
        id: watch.id,
        status: 'stopped',
        channel_id: watch.channel_id,
        channel_resource_id: watch.channel_resource_id,
        channel_expires_at: watch.channel_expires_at,
        last_renewal_error: 'entitlement lost — watch stopped',
      });
      if (!res.error) summary.stopped += 1;
      continue;
    }

    // Entitled but no token → OAuth grant revoked. Degrade + alert (recoverable
    // once the user reconnects).
    if (!auth.accessToken) {
      summary.failed += 1;
      const reason = 'oauth grant revoked — reconnect required';
      args.alert({ watchId: watch.id, orgId: watch.org_id, integrationId: watch.integration_id, kind: 'token_revoked', reason });
      await args.db.updateWatchState({ id: watch.id, status: 'degraded', last_renewal_error: reason });
      continue;
    }

    // 2. Best-effort stop of the OLD channel (skip for an already-expired one:
    //    Drive has already dropped it; a stop 404s harmlessly). Never fail the
    //    renewal on a stop error.
    if (watch.status !== 'expired' && watch.channel_resource_id) {
      await tryStop(args.client, watch, auth.accessToken);
    }

    // 3. Create the fresh channel.
    try {
      const created = await args.client.createChannel(watch, auth.accessToken);
      const res = await args.db.updateWatchState({
        id: watch.id,
        channel_id: created.channelId,
        channel_resource_id: created.resourceId,
        channel_expires_at: created.expiration,
        status: 'active',
        last_renewal_error: null,
      });
      if (res.error) {
        summary.failed += 1;
        args.alert({ watchId: watch.id, orgId: watch.org_id, integrationId: watch.integration_id, kind: 'renewal_failed', reason: 'watch-state update failed' });
      } else {
        summary.renewed += 1;
      }
    } catch (err) {
      summary.failed += 1;
      const reason = boundedReason(err);
      args.alert({ watchId: watch.id, orgId: watch.org_id, integrationId: watch.integration_id, kind: 'renewal_failed', reason });
      await args.db.updateWatchState({ id: watch.id, status: 'degraded', last_renewal_error: reason });
    }
  }

  return summary;
}

/** Best-effort channel stop — swallow errors so renewal proceeds. */
async function tryStop(
  client: DriveRenewalClient,
  watch: DriveRenewableWatch,
  accessToken: string | null,
): Promise<void> {
  if (!accessToken || !watch.channel_resource_id) return;
  try {
    await client.stopChannel({
      accessToken,
      channelId: watch.channel_id,
      resourceId: watch.channel_resource_id,
    });
  } catch {
    // Old channel may already be gone — a stop failure never blocks renewal.
  }
}
