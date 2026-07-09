/**
 * DRIVE-02 (SCRUM-2367) — Google Drive folder-watch bootstrap.
 *
 * Bootstraps a per-integration folder watch and persists its state into
 * `drive_watch_state` (migration 0351) via the `upsert_drive_watch_state` RPC:
 *   - initial page token (from changes.startPageToken)
 *   - watched folder id
 *   - push channel id + resource id + expiry
 *   - owner scope: my_drive vs shared_drive (+ shared drive id)
 *   - lifecycle status: active | permission_denied | failed
 *
 * Folder-permission failures are handled gracefully: the watch is NOT
 * registered and the row lands as `status='permission_denied'` — the caller
 * never sees a throw and no raw Drive body escapes.
 *
 * SENSITIVE METADATA (§1.6A-adjacent): `folder_path` and `owner_email` describe
 * the customer's private Drive hierarchy and the acting user. They are persisted
 * ONLY into the org-scoped, RLS-protected row and are NEVER passed to a logger,
 * Sentry, an Error, or `job_queue.last_error`. All ops logging keys off bounded,
 * non-sensitive identifiers (org id, integration id, status) only.
 */
import { randomUUID } from 'crypto';
import {
  getFileMetadata,
  createChangesWatch,
  DriveApiError,
} from '../oauth/drive.js';
import { boundedErrorDetail } from '../../utils/byte-safety.js';

export type DriveWatchStatus = 'active' | 'permission_denied' | 'failed';

export interface DriveBootstrapWatchRow {
  p_org_id: string;
  p_integration_id: string;
  p_watched_folder_id: string;
  p_initial_page_token: string;
  p_channel_id: string;
  p_channel_resource_id: string | null;
  p_owner_scope: 'my_drive' | 'shared_drive';
  p_drive_id: string | null;
  p_channel_expires_at: string | null;
  p_status: DriveWatchStatus;
  p_owner_user_id: string | null;
  p_owner_email: string | null;
  p_folder_path: string | null;
  p_created_by: string | null;
  p_last_renewal_error?: string | null;
}

export interface DriveBootstrapDb {
  /**
   * Idempotent upsert into drive_watch_state (ON CONFLICT (integration, folder)).
   * Wraps the `upsert_drive_watch_state` RPC. `error:true` on DB failure.
   */
  upsertWatchState(row: DriveBootstrapWatchRow): Promise<{ id: string | null; error: boolean }>;
}

interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface DriveBootstrapDeps {
  getFileMetadata?: typeof getFileMetadata;
  createChangesWatch?: typeof createChangesWatch;
  now?: () => Date;
}

export interface BootstrapDriveWatchResult {
  ok: boolean;
  status: DriveWatchStatus;
  watchStateId: string | null;
}

/**
 * Bootstrap (or re-bootstrap) a folder watch. Never throws for expected
 * failure modes (permission denial, watch-registration error, folder mismatch);
 * each maps to a persisted lifecycle status so the ops surface (DRIVE-06) can
 * reason about it.
 */
export async function bootstrapDriveWatch(args: {
  orgId: string;
  integrationId: string;
  userId: string;
  userEmail: string | null;
  folderId: string;
  accessToken: string;
  webhookAddress: string;
  channelToken: string;
  db: DriveBootstrapDb;
  logger?: Logger;
  deps?: DriveBootstrapDeps;
}): Promise<BootstrapDriveWatchResult> {
  const metaFn = args.deps?.getFileMetadata ?? getFileMetadata;
  const watchFn = args.deps?.createChangesWatch ?? createChangesWatch;
  const log = args.logger;

  // 1. Resolve folder metadata (name + parents + optional shared driveId).
  //    A permission failure (403/404) is an expected outcome, not an error to
  //    surface — record permission_denied and stop.
  let meta: { id: string; name: string; parents: string[]; driveId?: string };
  try {
    meta = await metaFn({ fileId: args.folderId, accessToken: args.accessToken });
  } catch (err) {
    if (err instanceof DriveApiError && (err.status === 403 || err.status === 404)) {
      log?.warn?.(
        { orgId: args.orgId, integrationId: args.integrationId, status: err.status },
        'drive watch bootstrap: folder permission denied',
      );
      return persist(args, {
        status: 'permission_denied',
        driveId: null,
        ownerScope: 'my_drive',
        initialPageToken: '',
        channelId: randomUUID(),
        resourceId: null,
        expiresAt: null,
        folderName: null,
        lastError: 'folder permission denied at bootstrap',
      });
    }
    // Unexpected non-permission error → failed status with a bounded detail.
    log?.error?.(
      { orgId: args.orgId, integrationId: args.integrationId },
      'drive watch bootstrap: folder metadata lookup failed',
    );
    return persist(args, {
      status: 'failed',
      driveId: null,
      ownerScope: 'my_drive',
      initialPageToken: '',
      channelId: randomUUID(),
      resourceId: null,
      expiresAt: null,
      folderName: null,
      lastError: boundedErrorDetail(err instanceof Error ? err.message : String(err)) ?? 'folder metadata lookup failed',
    });
  }

  // 2. Scope-mismatch guard: Drive must return the SAME folder id we asked to
  //    watch. A divergent id is a spoofed/proxied metadata response — do not
  //    register a watch on it.
  if (meta.id !== args.folderId) {
    log?.error?.(
      { orgId: args.orgId, integrationId: args.integrationId },
      'drive watch bootstrap: folder id mismatch — refusing to watch',
    );
    return persist(args, {
      status: 'failed',
      driveId: null,
      ownerScope: 'my_drive',
      initialPageToken: '',
      channelId: randomUUID(),
      resourceId: null,
      expiresAt: null,
      folderName: null,
      lastError: 'folder id mismatch',
    });
  }

  const ownerScope: 'my_drive' | 'shared_drive' = meta.driveId ? 'shared_drive' : 'my_drive';
  const channelId = randomUUID();

  // 3. Register the push-notification watch channel + start page token.
  let watch: { resourceId: string; expiration: string; startPageToken: string };
  try {
    watch = await watchFn({
      accessToken: args.accessToken,
      channelId,
      address: args.webhookAddress,
      token: args.channelToken,
      driveId: meta.driveId,
    });
  } catch (err) {
    log?.warn?.(
      { orgId: args.orgId, integrationId: args.integrationId },
      'drive watch bootstrap: changes.watch registration failed',
    );
    return persist(args, {
      status: 'failed',
      driveId: meta.driveId ?? null,
      ownerScope,
      initialPageToken: '',
      channelId,
      resourceId: null,
      expiresAt: null,
      folderName: meta.name,
      lastError: err instanceof DriveApiError
        ? `changes.watch failed (${err.status})`
        : boundedErrorDetail(err instanceof Error ? err.message : String(err)) ?? 'changes.watch failed',
    });
  }

  log?.info?.(
    { orgId: args.orgId, integrationId: args.integrationId, ownerScope, status: 'active' },
    'drive watch bootstrap: active',
  );
  return persist(args, {
    status: 'active',
    driveId: meta.driveId ?? null,
    ownerScope,
    initialPageToken: watch.startPageToken,
    channelId,
    resourceId: watch.resourceId,
    expiresAt: watch.expiration,
    folderName: meta.name,
    lastError: null,
  });
}

/** Persist the watch-state row via the upsert RPC. Sensitive fields go ONLY here. */
async function persist(
  args: {
    orgId: string;
    integrationId: string;
    userId: string;
    userEmail: string | null;
    folderId: string;
    db: DriveBootstrapDb;
    logger?: Logger;
  },
  s: {
    status: DriveWatchStatus;
    driveId: string | null;
    ownerScope: 'my_drive' | 'shared_drive';
    initialPageToken: string;
    channelId: string;
    resourceId: string | null;
    expiresAt: string | null;
    folderName: string | null;
    lastError: string | null;
  },
): Promise<BootstrapDriveWatchResult> {
  const { id, error } = await args.db.upsertWatchState({
    p_org_id: args.orgId,
    p_integration_id: args.integrationId,
    p_watched_folder_id: args.folderId,
    p_initial_page_token: s.initialPageToken,
    p_channel_id: s.channelId,
    p_channel_resource_id: s.resourceId,
    p_owner_scope: s.ownerScope,
    p_drive_id: s.driveId,
    p_channel_expires_at: s.expiresAt,
    p_status: s.status,
    p_owner_user_id: args.userId,
    // Sensitive: owner email + folder path live ONLY in the RLS row, never logged.
    p_owner_email: args.userEmail,
    p_folder_path: s.folderName,
    p_created_by: args.userId,
    p_last_renewal_error: s.lastError,
  });

  if (error) {
    args.logger?.error?.(
      { orgId: args.orgId, integrationId: args.integrationId, status: s.status },
      'drive watch bootstrap: watch-state upsert failed',
    );
  }
  return { ok: !error, status: s.status, watchStateId: id };
}
