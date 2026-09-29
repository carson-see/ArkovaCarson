/**
 * Google Drive initial-sync processor (DRIVE-BACKFILL, founder directive
 * 2026-09-29).
 *
 * THE GAP THIS CLOSES
 * -------------------
 * Ingestion has only ever relied on `changes.list` from a cursor seeded at
 * CONNECT time (`drive-oauth.ts`'s callback, `createChangesWatch` in
 * `oauth/drive.ts`) — so a file that already existed in a folder BEFORE it
 * was connected/watched was never seen by anything. Founder decision: when a
 * Drive folder is connected/watched, EVERY file already in it is secured
 * automatically, with no confirmation prompt.
 *
 * THIS MODULE DOES NOT BUILD A SECOND PIPELINE. It enumerates one folder's
 * DIRECT children (`listFolderFiles`, `oauth/drive.ts`) and, for each file,
 * enqueues the SAME `google_drive.file_changed` job the live changes feed
 * enqueues for a matched change (`drive-artifact-producer.ts` /
 * `jobs/drive-file-changed.ts`) — same payload shape, same
 * revision-kind resolution (`resolveRevision`, reused verbatim from
 * `drive-changes-processor.ts` so the `mtime:`/`evt:` fallback tokens — part
 * of the 0343 `connector_artifact` dedupe key — can never drift between the
 * two producers). Dedupe against a file already secured at the same revision
 * therefore happens for free, in the SAME place it already happens for the
 * live feed: the `enqueue_connector_artifact` RPC's
 * `(org_id, source, external_ref, COALESCE(external_revision,''))` unique
 * key. This processor never touches `drive_revision_ledger` — that table's
 * dedupe is specific to the changes-FEED walk (which change events it has
 * already SEEN), a different question from "has this file already been
 * secured", which the artifact key alone already answers.
 *
 * RULE EVALUATION IS DELIBERATELY BYPASSED. The live pipeline's
 * `enqueueRuleEvent` feeds the RULES ENGINE (notifications, review-queue
 * routing, non-anchoring actions) for something that genuinely CHANGED. A
 * pre-existing file did not change — there is nothing for a rule to react to
 * — so this producer calls `enqueueFileChangedJob` directly. `google_drive.
 * file_changed` -> `connector_artifact` -> `connector-artifact-drain.ts`'s
 * materialization-and-anchor step is action-agnostic: it runs for every
 * connector_artifact row regardless of which rule (if any) is watching the
 * folder, which is exactly what makes "every file gets secured" correct here
 * without re-deriving or duplicating the live rule dispatch.
 *
 * SCOPE, STATED HONESTLY: `folder_path` is NOT resolved for an initial-sync
 * file (unlike a live matched change, which resolves it via
 * `drive-folder-resolver.ts` when a rule needs `folder_path_starts_with`).
 * Resolving it here would mean one extra parent-chain Drive walk PER FILE in
 * a potentially large backfill, for a field the record page already renders
 * as "not available" when absent (`_drive_folder_path: null`) — the same
 * value a change would carry before SCRUM-1837 wired the resolver. This is a
 * deliberate scope decision, not a bug: the folder id itself (the field the
 * founder directive actually cares about — "which watched folder") is always
 * carried.
 *
 * PER-RUN BOUNDS: `DRIVE_INITIAL_SYNC_MAX_FILES_PER_RUN` caps how many files
 * one job invocation processes; hitting the cap schedules a CONTINUATION job
 * carrying the Drive `nextPageToken` and the running `files_synced_so_far`
 * count rather than silently dropping the remainder — a 50,000-file folder is
 * drained across many bounded job runs, not one unbounded one.
 *
 * §1.6A: this module fetches NO document bytes — only ids/names/mime types/
 * revision tokens from `files.list`, the same metadata-only shape
 * `listChanges` already returns. The byte fetch + SHA-256 + discard still
 * happens exactly once, downstream, in `jobs/drive-file-changed.ts`.
 *
 * Pure orchestrator, like `drive-artifact-producer.ts` /
 * `drive-changes-processor.ts`: the Drive HTTP boundary, the job_queue
 * boundary, the sync-state DB boundary, and the audit boundary are all
 * injected so tests prove pagination / cap+continuation / idempotency /
 * tenant isolation / 403+404+429 handling without any real Drive or Postgres.
 */
import { z } from 'zod';
import { dbUuid } from '../../utils/db-row-validation.js';
import { DriveApiError } from '../oauth/drive.js';
import { resolveRevision } from './drive-changes-processor.js';
import type { DriveRevisionKind } from './drive-artifact-producer.js';
import type { RunLeaseSpec } from '../../jobs/run-lease.js';

/** job_queue `type` for the Drive initial-sync job. */
export const DRIVE_INITIAL_SYNC_JOB_TYPE = 'google_drive.initial_sync' as const;

/** Files.list page size for one Drive round-trip during a sync run. */
export const DRIVE_INITIAL_SYNC_PAGE_SIZE = 100;

/**
 * Hard cap on files processed by ONE job invocation. Chosen so a single run
 * stays well inside Cloud Run's request budget even for a large folder;
 * hitting it schedules a continuation job rather than dropping the
 * remainder — see the module doc comment.
 */
export const DRIVE_INITIAL_SYNC_MAX_FILES_PER_RUN = 1000;

/** Drive's own folder MIME type — a defense-in-depth skip inside the loop, on
 *  top of `listFolderFiles`'s own query-level exclusion (belt-and-suspenders,
 *  same idiom as `drive-changes-processor.ts`'s `parentMatches`). */
const DRIVE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

export const DriveInitialSyncJobPayload = z.object({
  org_id: dbUuid('org_id'),
  integration_id: dbUuid('integration_id'),
  // Drive folder id (opaque string, not a UUID) — the watched folder this run
  // enumerates the direct children of.
  folder_id: z.string().min(1),
  // The organization_rules.id that named this folder, for audit cross-
  // reference only. Optional: a reconnect-triggered sync may cover a folder
  // named by more than one rule historically; the state row is keyed by
  // (org_id, folder_id), never by rule.
  rule_id: z.string().min(1).optional(),
  // Drive `files.list` nextPageToken to resume enumeration from. Absent on
  // the FIRST job of a run (also the signal that this is not a continuation —
  // see the idempotent-re-run guard in `processDriveInitialSyncJob`).
  page_token: z.string().min(1).optional(),
  // Running counts carried across continuation jobs so the per-run cap is
  // enforced against the WHOLE folder (not reset every continuation) and the
  // persisted `files_enqueued_count` never regresses across a continuation.
  files_synced_so_far: z.number().int().min(0).default(0),
  files_enqueued_so_far: z.number().int().min(0).default(0),
});

export type DriveInitialSyncJobPayloadT = z.infer<typeof DriveInitialSyncJobPayload>;

export function parseDriveInitialSyncJobPayload(payload: unknown): DriveInitialSyncJobPayloadT {
  return DriveInitialSyncJobPayload.parse(payload);
}

/** Narrow shape of a `files.list` entry this module actually reads. */
export interface DriveInitialSyncFileEntry {
  id: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  headRevisionId?: string;
  parents?: string[];
  driveId?: string;
}

export interface DriveInitialSyncListPageResult {
  files: DriveInitialSyncFileEntry[];
  nextPageToken?: string;
}

/** Persisted per-(org, folder) sync state — see `drive-initial-sync-runner.ts`
 *  for the real `drive_initial_sync_state` table adapter. */
export interface DriveInitialSyncStateRow {
  status: 'in_progress' | 'completed' | 'failed';
}

export interface DriveInitialSyncFileChangedPayload {
  org_id: string;
  integration_id: string;
  file_id: string;
  revision_id?: string;
  mime_type?: string;
  modified_time?: string;
  shared_drive_id?: string;
  folder_id?: string;
  revision_kind?: DriveRevisionKind;
}

export interface DriveInitialSyncDeps {
  /** Resolve a live Drive access token for the integration. Production wires
   *  this to `loadDriveAccessToken`, exactly like `drive-artifact-producer.ts`. */
  resolveAccessToken: (args: { orgId: string; integrationId: string }) => Promise<{ accessToken: string }>;
  /** Network boundary: `listFolderFiles` from `oauth/drive.ts` by default. */
  listFolderFiles: (args: {
    accessToken: string;
    folderId: string;
    pageToken?: string;
  }) => Promise<DriveInitialSyncListPageResult>;
  /** Enqueue the EXISTING `google_drive.file_changed` job — production wires
   *  this to `submitJob` validated against `DriveFileChangedJobPayload`
   *  (the SAME schema the live changes runner enqueues against). Returns the
   *  new job id, or `null` on failure (logged by the adapter; a single
   *  file's enqueue failure must not abort the rest of the page). */
  enqueueFileChangedJob: (payload: DriveInitialSyncFileChangedPayload) => Promise<string | null>;
  /** Submit a follow-up `google_drive.initial_sync` job carrying the Drive
   *  `nextPageToken` + running count, when this run hit the per-run cap. */
  scheduleContinuation: (payload: DriveInitialSyncJobPayloadT) => Promise<string | null>;
  /** Read the current sync state for (org, folder), or `null` if never started. */
  loadSyncState: (args: { orgId: string; folderId: string }) => Promise<DriveInitialSyncStateRow | null>;
  /** Mark (org, folder) `in_progress` — called once, on the FIRST job of a run
   *  (never on a continuation, which is already `in_progress`). */
  upsertSyncStateInProgress: (args: {
    orgId: string;
    integrationId: string;
    folderId: string;
    ruleId: string | null;
  }) => Promise<void>;
  /**
   * Record resumable progress after each page: the token to resume from, and
   * the ABSOLUTE running totals for this run (not deltas) — the processor
   * already tracks these across pages AND across continuation jobs
   * (`files_synced_so_far` on the payload), so the DB adapter can do a plain
   * UPDATE rather than a read-modify-write. Safe against concurrent writers
   * by construction: the per-org run lease (`driveInitialSyncRunLeaseSpec`)
   * plus one-folder-per-job-invocation means exactly one writer ever touches
   * a given (org, folder) row at a time.
   */
  updateSyncStateProgress: (args: {
    orgId: string;
    folderId: string;
    pageToken: string | null;
    filesSeenTotal: number;
    filesEnqueuedTotal: number;
  }) => Promise<void>;
  /** Mark (org, folder) `completed` — enumeration finished, no more pages. */
  completeSyncState: (args: { orgId: string; folderId: string }) => Promise<void>;
  /** Mark (org, folder) `failed` — a terminal Drive error (403/404). Does
   *  NOT throw; the job completes normally so job_queue does not burn retry
   *  attempts on a condition retrying cannot fix. */
  failSyncState: (args: { orgId: string; folderId: string; reason: string }) => Promise<void>;
  /** Durable start/complete/failed audit — counts only, no file names (§1.6A
   *  adjacent discipline: this module never has file names to begin with
   *  beyond what `listFolderFiles` already returned, and never logs them). */
  recordAuditEvent: (args: {
    orgId: string;
    integrationId: string;
    folderId: string;
    eventType:
      | 'drive_folder_initial_sync_started'
      | 'drive_folder_initial_sync_completed'
      | 'drive_folder_initial_sync_failed';
    details: Record<string, unknown>;
  }) => Promise<{ ok: boolean }>;
  /** Kill switch (`ENABLE_DRIVE_INITIAL_SYNC`). Optional so existing test
   *  doubles keep working; omitted means enabled. */
  isEnabled?: () => boolean;
  logger?: {
    info: (...a: unknown[]) => void;
    warn: (...a: unknown[]) => void;
    error: (...a: unknown[]) => void;
  };
}

export type DriveInitialSyncRunResult =
  | { outcome: 'disabled' }
  | { outcome: 'already_completed' }
  | { outcome: 'completed'; filesSynced: number }
  | { outcome: 'continued'; filesSynced: number; continuationJobId: string | null }
  | { outcome: 'failed'; reason: 'permission_denied' | 'folder_not_found' };

/**
 * Cross-instance TTL lease keyed by ORG id — "per-org concurrency of 1 for
 * initial sync" (a large org with several watched folders processes them one
 * at a time, never in parallel, bounding Drive API load per org). Reuses
 * `jobs/run-lease.ts`'s existing primitive exactly like
 * `drive-changes-runner.ts`'s `driveChangesRunLeaseSpec` — see that spec's
 * doc comment for why a TTL lease (not a session advisory lock) is the right
 * primitive through PostgREST's pooled backends.
 */
const DRIVE_INITIAL_SYNC_RUN_LEASE_TTL_MS = 10 * 60_000;

export function driveInitialSyncRunLeaseSpec(orgId: string): RunLeaseSpec {
  return {
    leaseId: orgId,
    leaseType: 'drive-initial-sync:lease',
    ttlMs: DRIVE_INITIAL_SYNC_RUN_LEASE_TTL_MS,
    label: `Drive initial sync (org ${orgId})`,
    // Not cron-scheduled — job-queue driven, like driveChangesRunLeaseSpec.
    slowestRecordedCadenceMs: 0,
    maxRunMs: 2 * DRIVE_INITIAL_SYNC_RUN_LEASE_TTL_MS,
  };
}

function resolveFileRevision(file: DriveInitialSyncFileEntry): { revisionId: string; kind: DriveRevisionKind } | null {
  // Reuse the changes-processor's exact fallback chain by constructing the
  // same shape it expects — see the module doc comment for why this MUST
  // stay byte-for-byte identical to the live feed's resolution.
  return resolveRevision({
    fileId: file.id,
    time: file.modifiedTime,
    file: { headRevisionId: file.headRevisionId, modifiedTime: file.modifiedTime },
  });
}

/**
 * Process one initial-sync job: enumerate up to the per-run cap, enqueueing
 * one `google_drive.file_changed` job per file, then either complete (no more
 * pages), continue (cap hit, more pages remain), or fail terminally (403/404).
 */
export async function processDriveInitialSyncJob(
  payload: unknown,
  deps: DriveInitialSyncDeps,
): Promise<DriveInitialSyncRunResult> {
  const parsed = parseDriveInitialSyncJobPayload(payload);
  const { org_id: orgId, integration_id: integrationId, folder_id: folderId } = parsed;
  const isContinuation = Boolean(parsed.page_token);

  if (deps.isEnabled?.() === false) {
    deps.logger?.info?.({ orgId, folderId }, 'Drive initial sync skipped — ENABLE_DRIVE_INITIAL_SYNC disabled');
    return { outcome: 'disabled' };
  }

  // Idempotent re-run guard: a FRESH (non-continuation) trigger for a folder
  // that is already fully synced is a no-op — never re-enumerate, never
  // re-enqueue. A continuation job (page_token set) is already mid-run by
  // definition and skips this check entirely.
  if (!isContinuation) {
    const existing = await deps.loadSyncState({ orgId, folderId });
    if (existing?.status === 'completed') {
      deps.logger?.info?.({ orgId, folderId }, 'drive initial sync: folder already fully synced — skipping');
      return { outcome: 'already_completed' };
    }
    await deps.upsertSyncStateInProgress({ orgId, integrationId, folderId, ruleId: parsed.rule_id ?? null });
    await deps.recordAuditEvent({
      orgId,
      integrationId,
      folderId,
      eventType: 'drive_folder_initial_sync_started',
      details: { folder_id: folderId },
    });
  }

  const { accessToken } = await deps.resolveAccessToken({ orgId, integrationId });

  let pageToken = parsed.page_token;
  let totalSynced = parsed.files_synced_so_far;
  let totalEnqueued = parsed.files_enqueued_so_far;

  for (;;) {
    let page: DriveInitialSyncListPageResult;
    try {
      page = await deps.listFolderFiles({ accessToken, folderId, pageToken });
    } catch (err) {
      if (err instanceof DriveApiError && (err.status === 403 || err.status === 404)) {
        const reason = err.status === 403 ? 'permission_denied' as const : 'folder_not_found' as const;
        await deps.failSyncState({ orgId, folderId, reason: `drive_${err.status}` });
        await deps.recordAuditEvent({
          orgId,
          integrationId,
          folderId,
          eventType: 'drive_folder_initial_sync_failed',
          details: { reason },
        });
        deps.logger?.warn?.(
          { orgId, folderId, status: err.status },
          'drive initial sync: terminal Drive error — folder marked failed, not retrying',
        );
        return { outcome: 'failed', reason };
      }
      // 429 / 5xx / network / anything else: rethrow so job_queue's own
      // exponential backoff (services/worker/src/utils/jobQueue.ts `failJob`)
      // retries it — this is transient, retrying CAN help.
      deps.logger?.error?.({ error: err, orgId, folderId }, 'drive initial sync: listFolderFiles failed');
      throw err;
    }

    let enqueuedThisPage = 0;
    for (const file of page.files) {
      // Defense in depth — listFolderFiles already excludes folders at the
      // query level; this guards against Drive returning one anyway.
      if (file.mimeType === DRIVE_FOLDER_MIME_TYPE) continue;
      const revision = resolveFileRevision(file);
      const jobId = await deps.enqueueFileChangedJob({
        org_id: orgId,
        integration_id: integrationId,
        file_id: file.id,
        revision_id: revision?.revisionId,
        mime_type: file.mimeType,
        modified_time: file.modifiedTime,
        shared_drive_id: file.driveId,
        folder_id: folderId,
        revision_kind: revision?.kind,
      });
      if (jobId) enqueuedThisPage += 1;
    }
    totalEnqueued += enqueuedThisPage;
    totalSynced += page.files.length;
    pageToken = page.nextPageToken;

    await deps.updateSyncStateProgress({
      orgId,
      folderId,
      pageToken: pageToken ?? null,
      filesSeenTotal: totalSynced,
      filesEnqueuedTotal: totalEnqueued,
    });

    if (!pageToken) {
      await deps.completeSyncState({ orgId, folderId });
      await deps.recordAuditEvent({
        orgId,
        integrationId,
        folderId,
        eventType: 'drive_folder_initial_sync_completed',
        details: { files_synced: totalSynced, files_enqueued: totalEnqueued },
      });
      return { outcome: 'completed', filesSynced: totalSynced };
    }

    if (totalSynced >= DRIVE_INITIAL_SYNC_MAX_FILES_PER_RUN) {
      const continuationJobId = await deps.scheduleContinuation({
        org_id: orgId,
        integration_id: integrationId,
        folder_id: folderId,
        rule_id: parsed.rule_id,
        page_token: pageToken,
        files_synced_so_far: totalSynced,
        files_enqueued_so_far: totalEnqueued,
      });
      deps.logger?.info?.(
        { orgId, folderId, totalSynced, continuationJobId },
        'drive initial sync: per-run cap reached — continuing via a follow-up job',
      );
      return { outcome: 'continued', filesSynced: totalSynced, continuationJobId };
    }
  }
}
