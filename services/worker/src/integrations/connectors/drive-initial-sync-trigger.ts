/**
 * Drive initial-sync trigger (DRIVE-BACKFILL, founder directive 2026-09-29).
 *
 * The cheap, DB-only half of the initial-sync feature: decides WHETHER a
 * (org, folder) pair needs a `google_drive.initial_sync` job submitted, and
 * submits it. Never calls Drive itself (that happens later, inside the job —
 * see `drive-initial-sync.ts`) — only a `drive_initial_sync_state` read and,
 * at most, one `job_queue` insert per folder. Safe to AWAIT from an HTTP
 * handler without risking latency on Drive.
 *
 * Two call sites, per the founder directive's two trigger points:
 *   1. `api/rules-crud.ts`, next to `mirrorDriveFoldersForRuleWrite` — a Drive
 *      rule created/updated with folders (all folders on create; only the
 *      NEWLY ADDED ones on a folder-adding update — the diff is computed by
 *      the caller, not here, since only the caller knows the rule's PREVIOUS
 *      folder list).
 *   2. `api/v1/integrations/drive-oauth.ts`'s OAuth callback — a
 *      (re)connection with one or more already-existing connector-managed
 *      Drive rules. `loadConnectorDriveFoldersForOrg` below is the shared
 *      query both `drive-folder-mirror.ts`'s scoping rules
 *      (`shouldMirrorDriveFoldersForRule` / `extractDriveFoldersToMirror`) are
 *      reused for, so "watched" means the exact same thing for the mirror and
 *      for initial sync — never two silently different definitions.
 *
 * Non-throwing by contract, same shape as `mirrorConnectedDriveFolders`: a
 * failure for one folder must never abort the others, and must never turn an
 * otherwise-successful rule save / OAuth callback into a 500.
 */
import {
  extractDriveFoldersToMirror,
  shouldMirrorDriveFoldersForRule,
  loadActiveDriveConnection,
  type DriveFolderToMirror,
} from './drive-folder-mirror.js';
import { DRIVE_INITIAL_SYNC_JOB_TYPE, type DriveInitialSyncJobPayloadT } from './drive-initial-sync.js';

export type DriveInitialSyncStatus = 'in_progress' | 'completed' | 'failed';

export type DriveInitialSyncTriggerOutcome =
  | 'enqueued'
  | 'already_synced'
  | 'sync_in_progress'
  | 'skipped_disabled'
  | 'skipped_no_connection'
  | 'error';

export interface DriveInitialSyncTriggerResult {
  folderId: string;
  outcome: DriveInitialSyncTriggerOutcome;
  jobId?: string | null;
  error?: string;
}

export interface DriveInitialSyncTriggerDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from: (table: string) => any;
}

export interface DriveInitialSyncTriggerDeps {
  /** Current sync status for (org, folder), or `null` if never started. */
  loadSyncStatus: (args: { orgId: string; folderId: string }) => Promise<DriveInitialSyncStatus | null>;
  /**
   * Resolve the org's currently active Drive `org_integrations.id`, or
   * `null` when the org has no active connection. Called ONCE per
   * `triggerDriveInitialSyncForFolders` call (not per folder) — every folder
   * in one call shares the same org, so it shares the same connection.
   * `null | 'error'` are collapsed to `null` here on purpose: unlike the
   * folder mirror (which distinguishes "no connection" from "lookup failed"
   * for its own retry semantics), a trigger failure here is best-effort —
   * the caller (a rule save / OAuth callback) must never 500 over it, and a
   * transient miss just means this particular save doesn't kick off a sync;
   * the NEXT rule save or reconnect tries again.
   */
  resolveActiveIntegrationId: (orgId: string) => Promise<string | null>;
  /** Submit the `google_drive.initial_sync` job. Production wires this to
   *  `submitJob({ type: DRIVE_INITIAL_SYNC_JOB_TYPE, payload, ... })`. */
  submitInitialSyncJob: (payload: DriveInitialSyncJobPayloadT) => Promise<string | null>;
  /** Kill switch (`ENABLE_DRIVE_INITIAL_SYNC`). Optional; omitted = enabled. */
  isEnabled?: () => boolean;
  logger?: {
    warn: (...a: unknown[]) => void;
    error: (...a: unknown[]) => void;
  };
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/**
 * Decide + submit the initial-sync job for one folder. Never throws.
 */
async function triggerOne(
  deps: DriveInitialSyncTriggerDeps,
  args: { orgId: string; integrationId: string; ruleId: string | null; folder: DriveFolderToMirror },
): Promise<DriveInitialSyncTriggerResult> {
  const { orgId, integrationId, ruleId, folder } = args;
  try {
    const status = await deps.loadSyncStatus({ orgId, folderId: folder.folderId });
    if (status === 'completed') {
      return { folderId: folder.folderId, outcome: 'already_synced' };
    }
    if (status === 'in_progress') {
      return { folderId: folder.folderId, outcome: 'sync_in_progress' };
    }
    // status is null (never started) or 'failed' (retry) — submit a fresh run.
    const jobId = await deps.submitInitialSyncJob({
      org_id: orgId,
      integration_id: integrationId,
      folder_id: folder.folderId,
      rule_id: ruleId ?? undefined,
      files_synced_so_far: 0,
      files_enqueued_so_far: 0,
    });
    if (!jobId) {
      deps.logger?.error?.({ orgId, folderId: folder.folderId }, 'drive initial sync: job submission returned no id');
      return { folderId: folder.folderId, outcome: 'error', error: 'submit_returned_no_id' };
    }
    return { folderId: folder.folderId, outcome: 'enqueued', jobId };
  } catch (error) {
    deps.logger?.error?.({ error, orgId, folderId: folder.folderId }, 'drive initial sync: trigger failed for one folder');
    return { folderId: folder.folderId, outcome: 'error', error: errorText(error) };
  }
}

/**
 * Triggers the initial sync for each folder in `folders`, one result per
 * folder, isolated (one folder's failure never blocks the others). Returns
 * `[]` immediately for an empty folder list — nothing to do. Resolves the
 * org's active Drive connection ONCE, up front (never per folder).
 */
export async function triggerDriveInitialSyncForFolders(
  deps: DriveInitialSyncTriggerDeps,
  args: { orgId: string; ruleId: string | null; folders: DriveFolderToMirror[] },
): Promise<DriveInitialSyncTriggerResult[]> {
  const { orgId, ruleId, folders } = args;
  if (folders.length === 0) return [];

  if (deps.isEnabled?.() === false) {
    return folders.map((f) => ({ folderId: f.folderId, outcome: 'skipped_disabled' as const }));
  }

  const integrationId = await deps.resolveActiveIntegrationId(orgId);
  if (!integrationId) {
    return folders.map((f) => ({ folderId: f.folderId, outcome: 'skipped_no_connection' as const }));
  }

  const results: DriveInitialSyncTriggerResult[] = [];
  for (const folder of folders) {
    results.push(await triggerOne(deps, { orgId, integrationId, ruleId, folder }));
  }
  return results;
}

/**
 * Every connector-managed (Connectors-page) Drive rule for an org, with its
 * bound folders — the SAME scoping `drive-folder-mirror.ts` uses
 * (`shouldMirrorDriveFoldersForRule` / `extractDriveFoldersToMirror`), so
 * "which folders are watched" can never silently diverge between the mirror
 * feature and initial sync. Used by the reconnect trigger point (a
 * (re)connect has no single "the folder(s) this callback is about" — it has
 * to discover every already-existing rule that names one).
 *
 * Fails soft (`[]`) on a query error rather than throwing — matches
 * `mirrorConnectedDriveFolders`'s own non-throwing contract, and the OAuth
 * callback this feeds must never 500 because a best-effort backfill trigger
 * could not read `organization_rules`.
 */
export async function loadConnectorDriveFoldersForOrg(
  db: DriveInitialSyncTriggerDb,
  orgId: string,
): Promise<Array<{ ruleId: string; folders: DriveFolderToMirror[] }>> {
  const { data, error } = await db
    .from('organization_rules')
    .select('id, trigger_type, trigger_config, action_config')
    .eq('org_id', orgId)
    .eq('trigger_type', 'WORKSPACE_FILE_MODIFIED');
  if (error || !data) return [];

  const out: Array<{ ruleId: string; folders: DriveFolderToMirror[] }> = [];
  for (const row of data as Array<{
    id: string;
    trigger_type: string;
    trigger_config: Record<string, unknown> | null;
    action_config: unknown;
  }>) {
    if (!shouldMirrorDriveFoldersForRule(row.trigger_type, row.action_config)) continue;
    const folders = extractDriveFoldersToMirror(row.trigger_config);
    if (folders.length === 0) continue;
    out.push({ ruleId: row.id, folders });
  }
  return out;
}

/** Re-exported so callers building a payload by hand share one type. */
export type { DriveFolderToMirror };
export { DRIVE_INITIAL_SYNC_JOB_TYPE };

type SubmitJobFn = (submission: { type: string; payload: unknown; priority?: number; max_attempts?: number }) => Promise<string | null>;

/**
 * Real `drive_initial_sync_state` + `job_queue` wiring for
 * `DriveInitialSyncTriggerDeps` — the only place `rules-crud.ts` and
 * `drive-oauth.ts` need to build the deps this module's `triggerDrive
 * InitialSyncForFolders` takes. `submitJob` is injected (not imported
 * directly) so this stays testable the same way every other DB-adjacent
 * module in this folder is (see `drive-folder-mirror.ts`'s `db` injection).
 */
export function makeDriveInitialSyncTriggerDbDeps(args: {
  db: DriveInitialSyncTriggerDb;
  submitJob: SubmitJobFn;
  isEnabled?: () => boolean;
  logger?: DriveInitialSyncTriggerDeps['logger'];
}): DriveInitialSyncTriggerDeps {
  const { db, submitJob, isEnabled, logger } = args;
  return {
    isEnabled,
    logger,
    async resolveActiveIntegrationId(orgId) {
      // Reuses the SAME "which connection is active" resolver the folder
      // mirror uses (`drive-folder-mirror.ts`'s `loadActiveDriveConnection`)
      // so the two features can never disagree about which connection backs
      // a rule's folders. A lookup ERROR collapses to `null` here (best
      // effort — see the doc comment on `resolveActiveIntegrationId`),
      // unlike the mirror's own 3-way result which a caller there uses for
      // retry semantics this trigger does not need.
      const lookup = await loadActiveDriveConnection(db, orgId);
      return lookup.kind === 'found' ? lookup.connection.id : null;
    },
    async loadSyncStatus({ orgId, folderId }) {
      const { data, error } = await db
        .from('drive_initial_sync_state')
        .select('status')
        .eq('org_id', orgId)
        .eq('folder_id', folderId)
        .maybeSingle();
      // Fail closed to "no state" rather than throwing: a transient read
      // failure here must not block a rule save / OAuth callback, and the
      // job's OWN idempotency guard (`processDriveInitialSyncJob`'s
      // `loadSyncState`) is the real, authoritative check — this lookup is
      // only a best-effort "don't bother enqueueing" short-circuit.
      if (error || !data) return null;
      return (data as { status?: string }).status as DriveInitialSyncStatus | null ?? null;
    },
    async submitInitialSyncJob(payload) {
      return submitJob({
        type: DRIVE_INITIAL_SYNC_JOB_TYPE,
        payload,
        // Lower priority than the live `google_drive.file_changed` jobs
        // (submitted at priority 10 — see `drive-changes-runner.ts`) so a
        // large backfill never starves ongoing, user-visible change
        // processing for the same org.
        priority: 5,
        max_attempts: 5,
      });
    },
  };
}
