/**
 * DRIVE-BACKFILL (founder directive 2026-09-29) — initial sync processor tests.
 *
 * Product decision: when a Drive folder is connected/watched, every file
 * ALREADY in that folder is secured automatically, with no confirmation
 * prompt. `processDriveInitialSyncJob` is the pure orchestrator that
 * enumerates one folder's direct children (via the injected `listFolderFiles`
 * boundary) and feeds each one into the EXISTING `google_drive.file_changed`
 * pipeline (via the injected `enqueueFileChangedJob` boundary) — never a
 * parallel one. These tests prove: pagination, the per-run cap +
 * continuation, idempotent re-run (a folder already fully synced enqueues
 * nothing), tenant isolation (every DB/Drive call is scoped to the payload's
 * own org/integration), and Drive 403/404/429 handling.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  processDriveInitialSyncJob,
  DriveInitialSyncJobPayload,
  DRIVE_INITIAL_SYNC_JOB_TYPE,
  DRIVE_INITIAL_SYNC_MAX_FILES_PER_RUN,
  driveInitialSyncRunLeaseSpec,
  type DriveInitialSyncDeps,
} from './drive-initial-sync.js';
import { DriveApiError } from '../oauth/drive.js';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '99999999-9999-4999-8999-999999999999';
const INTEGRATION = '22222222-2222-4222-8222-222222222222';
const FOLDER = 'folder-abc';

function makeFile(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    name: `${id}.pdf`,
    mimeType: 'application/pdf',
    modifiedTime: '2026-01-01T00:00:00.000Z',
    headRevisionId: `rev-${id}`,
    parents: [FOLDER],
    ...overrides,
  };
}

function makeDeps(overrides: Partial<DriveInitialSyncDeps> = {}): {
  deps: DriveInitialSyncDeps;
  listFolderFiles: ReturnType<typeof vi.fn>;
  resolveAccessToken: ReturnType<typeof vi.fn>;
  enqueueFileChangedJob: ReturnType<typeof vi.fn>;
  scheduleContinuation: ReturnType<typeof vi.fn>;
  loadSyncState: ReturnType<typeof vi.fn>;
  upsertSyncStateInProgress: ReturnType<typeof vi.fn>;
  updateSyncStateProgress: ReturnType<typeof vi.fn>;
  completeSyncState: ReturnType<typeof vi.fn>;
  failSyncState: ReturnType<typeof vi.fn>;
  recordAuditEvent: ReturnType<typeof vi.fn>;
} {
  const listFolderFiles = vi.fn(async () => ({ files: [] as ReturnType<typeof makeFile>[] }));
  const resolveAccessToken = vi.fn(async () => ({ accessToken: 'live-token' }));
  const enqueueFileChangedJob = vi.fn(async () => 'job-1');
  const scheduleContinuation = vi.fn(async () => 'job-continuation');
  const loadSyncState = vi.fn(async () => null);
  const upsertSyncStateInProgress = vi.fn(async () => {});
  const updateSyncStateProgress = vi.fn(async () => {});
  const completeSyncState = vi.fn(async () => {});
  const failSyncState = vi.fn(async () => {});
  const recordAuditEvent = vi.fn(async () => ({ ok: true }));
  const deps: DriveInitialSyncDeps = {
    resolveAccessToken,
    listFolderFiles,
    enqueueFileChangedJob,
    scheduleContinuation,
    loadSyncState,
    upsertSyncStateInProgress,
    updateSyncStateProgress,
    completeSyncState,
    failSyncState,
    recordAuditEvent,
    ...overrides,
  };
  return {
    deps,
    listFolderFiles,
    resolveAccessToken,
    enqueueFileChangedJob,
    scheduleContinuation,
    loadSyncState,
    upsertSyncStateInProgress,
    updateSyncStateProgress,
    completeSyncState,
    failSyncState,
    recordAuditEvent,
  };
}

function basePayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    org_id: ORG_A,
    integration_id: INTEGRATION,
    folder_id: FOLDER,
    ...overrides,
  };
}

describe('DriveInitialSyncJobPayload', () => {
  it('parses a minimal payload with defaults', () => {
    const parsed = DriveInitialSyncJobPayload.parse(basePayload());
    expect(parsed.files_synced_so_far).toBe(0);
    expect(parsed.page_token).toBeUndefined();
  });

  it('rejects a non-uuid org_id', () => {
    expect(() => DriveInitialSyncJobPayload.parse(basePayload({ org_id: 'not-a-uuid' }))).toThrow();
  });
});

describe('DRIVE_INITIAL_SYNC_JOB_TYPE', () => {
  it('is the stable job_queue type string', () => {
    expect(DRIVE_INITIAL_SYNC_JOB_TYPE).toBe('google_drive.initial_sync');
  });
});

describe('driveInitialSyncRunLeaseSpec', () => {
  it('keys the lease by org id (per-org concurrency of 1)', () => {
    const spec = driveInitialSyncRunLeaseSpec(ORG_A);
    expect(spec.leaseId).toBe(ORG_A);
    expect(spec.leaseType).toBe('drive-initial-sync:lease');
    expect(spec.ttlMs).toBeGreaterThan(0);
    expect(spec.maxRunMs).toBeGreaterThanOrEqual(spec.ttlMs);
  });
});

describe('processDriveInitialSyncJob', () => {
  it('enumerates one page, enqueues one file-changed job per file, and marks the sync completed', async () => {
    const { deps, enqueueFileChangedJob, upsertSyncStateInProgress, completeSyncState, recordAuditEvent } =
      makeDeps({
        listFolderFiles: vi.fn(async () => ({ files: [makeFile('f1'), makeFile('f2')] })),
      });

    const result = await processDriveInitialSyncJob(basePayload(), deps);

    expect(upsertSyncStateInProgress).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_A, integrationId: INTEGRATION, folderId: FOLDER }),
    );
    expect(enqueueFileChangedJob).toHaveBeenCalledTimes(2);
    expect(enqueueFileChangedJob).toHaveBeenCalledWith(
      expect.objectContaining({
        org_id: ORG_A,
        integration_id: INTEGRATION,
        file_id: 'f1',
        revision_id: 'rev-f1',
        revision_kind: 'head_revision',
        folder_id: FOLDER,
      }),
    );
    expect(completeSyncState).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_A, folderId: FOLDER }));
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'drive_folder_initial_sync_started' }),
    );
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'drive_folder_initial_sync_completed' }),
    );
    expect(result).toEqual({ outcome: 'completed', filesSynced: 2 });
  });

  it('paginates across multiple pages before completing', async () => {
    const listFolderFiles = vi
      .fn()
      .mockResolvedValueOnce({ files: [makeFile('p1')], nextPageToken: 'page-2' })
      .mockResolvedValueOnce({ files: [makeFile('p2')] });
    const { deps, enqueueFileChangedJob, completeSyncState } = makeDeps({ listFolderFiles });

    const result = await processDriveInitialSyncJob(basePayload(), deps);

    expect(listFolderFiles).toHaveBeenCalledTimes(2);
    expect(listFolderFiles.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ folderId: FOLDER, pageToken: undefined }),
    );
    expect(listFolderFiles.mock.calls[1]![0]).toEqual(
      expect.objectContaining({ folderId: FOLDER, pageToken: 'page-2' }),
    );
    expect(enqueueFileChangedJob).toHaveBeenCalledTimes(2);
    expect(completeSyncState).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ outcome: 'completed', filesSynced: 2 });
  });

  it('falls back to modified_time revision kind for a Workspace-native file with no headRevisionId', async () => {
    const { deps, enqueueFileChangedJob } = makeDeps({
      listFolderFiles: vi.fn(async () => ({
        files: [makeFile('doc1', { headRevisionId: undefined })],
      })),
    });
    await processDriveInitialSyncJob(basePayload(), deps);
    expect(enqueueFileChangedJob).toHaveBeenCalledWith(
      expect.objectContaining({ revision_id: 'mtime:2026-01-01T00:00:00.000Z', revision_kind: 'modified_time' }),
    );
  });

  it('skips a folder-mimeType entry defensively even if Drive returns one', async () => {
    const { deps, enqueueFileChangedJob } = makeDeps({
      listFolderFiles: vi.fn(async () => ({
        files: [
          makeFile('sub1', { mimeType: 'application/vnd.google-apps.folder' }),
          makeFile('f1'),
        ],
      })),
    });
    await processDriveInitialSyncJob(basePayload(), deps);
    expect(enqueueFileChangedJob).toHaveBeenCalledTimes(1);
    expect(enqueueFileChangedJob).toHaveBeenCalledWith(expect.objectContaining({ file_id: 'f1' }));
  });

  it('stops at the per-run cap and schedules a continuation job instead of dropping the remainder', async () => {
    const bigPage = { files: Array.from({ length: DRIVE_INITIAL_SYNC_MAX_FILES_PER_RUN }, (_, i) => makeFile(`f${i}`)), nextPageToken: 'more' };
    const { deps, scheduleContinuation, completeSyncState } = makeDeps({
      listFolderFiles: vi.fn(async () => bigPage),
    });

    const result = await processDriveInitialSyncJob(basePayload(), deps);

    expect(scheduleContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        org_id: ORG_A,
        integration_id: INTEGRATION,
        folder_id: FOLDER,
        page_token: 'more',
        files_synced_so_far: DRIVE_INITIAL_SYNC_MAX_FILES_PER_RUN,
        files_enqueued_so_far: DRIVE_INITIAL_SYNC_MAX_FILES_PER_RUN,
      }),
    );
    expect(completeSyncState).not.toHaveBeenCalled();
    expect(result.outcome).toBe('continued');
  });

  it('carries files_enqueued_so_far across a continuation so the persisted count never regresses', async () => {
    const firstPage = { files: Array.from({ length: DRIVE_INITIAL_SYNC_MAX_FILES_PER_RUN }, (_, i) => makeFile(`f${i}`)), nextPageToken: 'more' };
    const { deps, scheduleContinuation } = makeDeps({ listFolderFiles: vi.fn(async () => firstPage) });
    await processDriveInitialSyncJob(basePayload(), deps);
    const continuationPayload = scheduleContinuation.mock.calls[0]![0];

    // Second job invocation: a continuation carrying the prior run's totals.
    const secondPage = { files: [makeFile('fLast')] };
    const { deps: deps2, updateSyncStateProgress, completeSyncState } = makeDeps({
      listFolderFiles: vi.fn(async () => secondPage),
    });
    await processDriveInitialSyncJob(continuationPayload, deps2);

    // The final progress write must show a MONOTONICALLY INCREASING total —
    // never a reset to this run's own local count.
    const lastCall = updateSyncStateProgress.mock.calls.at(-1)![0];
    expect(lastCall.filesEnqueuedTotal).toBe(DRIVE_INITIAL_SYNC_MAX_FILES_PER_RUN + 1);
    expect(lastCall.filesSeenTotal).toBe(DRIVE_INITIAL_SYNC_MAX_FILES_PER_RUN + 1);
    expect(completeSyncState).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: a fresh (non-continuation) trigger for an already-completed folder enqueues nothing', async () => {
    const { deps, listFolderFiles, enqueueFileChangedJob, upsertSyncStateInProgress } = makeDeps({
      loadSyncState: vi.fn(async () => ({ status: 'completed' as const })),
    });

    const result = await processDriveInitialSyncJob(basePayload(), deps);

    expect(listFolderFiles).not.toHaveBeenCalled();
    expect(enqueueFileChangedJob).not.toHaveBeenCalled();
    expect(upsertSyncStateInProgress).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: 'already_completed' });
  });

  it('a continuation job (page_token set) does NOT re-check already_completed / does not re-mark in_progress', async () => {
    const { deps, upsertSyncStateInProgress, recordAuditEvent } = makeDeps({
      listFolderFiles: vi.fn(async () => ({ files: [makeFile('f1')] })),
    });
    await processDriveInitialSyncJob(basePayload({ page_token: 'resume-here', files_synced_so_far: 500 }), deps);
    expect(upsertSyncStateInProgress).not.toHaveBeenCalled();
    expect(recordAuditEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'drive_folder_initial_sync_started' }),
    );
  });

  it('treats a 403 as terminal: marks the folder failed, audits, and does not throw (no wasted retries)', async () => {
    const { deps, failSyncState, recordAuditEvent } = makeDeps({
      listFolderFiles: vi.fn(async () => {
        throw new DriveApiError('forbidden', 403, 'no detail');
      }),
    });
    const result = await processDriveInitialSyncJob(basePayload(), deps);
    expect(failSyncState).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_A, folderId: FOLDER }),
    );
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'drive_folder_initial_sync_failed' }),
    );
    expect(result).toEqual({ outcome: 'failed', reason: 'permission_denied' });
  });

  it('treats a 404 as terminal: marks the folder failed and does not throw', async () => {
    const { deps, failSyncState } = makeDeps({
      listFolderFiles: vi.fn(async () => {
        throw new DriveApiError('not found', 404);
      }),
    });
    const result = await processDriveInitialSyncJob(basePayload(), deps);
    expect(failSyncState).toHaveBeenCalled();
    expect(result).toEqual({ outcome: 'failed', reason: 'folder_not_found' });
  });

  it('rethrows a 429 so job_queue\'s own exponential backoff retries it (transient)', async () => {
    const { deps, failSyncState } = makeDeps({
      listFolderFiles: vi.fn(async () => {
        throw new DriveApiError('rate limited', 429);
      }),
    });
    await expect(processDriveInitialSyncJob(basePayload(), deps)).rejects.toThrow(DriveApiError);
    expect(failSyncState).not.toHaveBeenCalled();
  });

  it('rethrows an unexpected 5xx/network error for job_queue retry/dead-letter', async () => {
    const { deps, failSyncState } = makeDeps({
      listFolderFiles: vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    });
    await expect(processDriveInitialSyncJob(basePayload(), deps)).rejects.toThrow('ECONNRESET');
    expect(failSyncState).not.toHaveBeenCalled();
  });

  it('is disabled by the kill switch and never calls Drive or enqueues anything', async () => {
    const { deps, listFolderFiles, enqueueFileChangedJob, loadSyncState } = makeDeps({
      isEnabled: () => false,
    });
    const result = await processDriveInitialSyncJob(basePayload(), deps);
    expect(listFolderFiles).not.toHaveBeenCalled();
    expect(enqueueFileChangedJob).not.toHaveBeenCalled();
    expect(loadSyncState).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: 'disabled' });
  });

  describe('tenant isolation', () => {
    it('every call the processor makes is scoped to the payload\'s own org — never a different org', async () => {
      const { deps, resolveAccessToken, enqueueFileChangedJob, loadSyncState } = makeDeps({
        listFolderFiles: vi.fn(async () => ({ files: [makeFile('f1')] })),
      });
      await processDriveInitialSyncJob(basePayload({ org_id: ORG_A }), deps);

      expect(loadSyncState.mock.calls[0]![0]).toEqual(expect.objectContaining({ orgId: ORG_A }));
      expect(resolveAccessToken).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_A, integrationId: INTEGRATION }));
      for (const call of enqueueFileChangedJob.mock.calls) {
        expect(call[0]).toEqual(expect.objectContaining({ org_id: ORG_A, integration_id: INTEGRATION }));
        expect(call[0].org_id).not.toBe(ORG_B);
      }
    });
  });
});
