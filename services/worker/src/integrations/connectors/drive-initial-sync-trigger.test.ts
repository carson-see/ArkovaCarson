/**
 * DRIVE-BACKFILL (founder directive 2026-09-29) — initial-sync trigger tests.
 *
 * `triggerDriveInitialSyncForFolders` is the thin, non-throwing entry point
 * both call sites use (rule create/update in `rules-crud.ts`, and Drive
 * (re)connect in `drive-oauth.ts`): it resolves the org's active Drive
 * connection ONCE, then enqueues at most ONE `google_drive.initial_sync` job
 * per (org, folder) that is not already completed/in-progress, and never
 * throws — mirroring `mirrorConnectedDriveFolders`'s non-throwing contract
 * (same folder, same founder directive era, same "a mirror/sync failure must
 * never turn an otherwise-successful rule save/OAuth callback into a 500"
 * reasoning).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  triggerDriveInitialSyncForFolders,
  loadConnectorDriveFoldersForOrg,
  makeDriveInitialSyncTriggerDbDeps,
  type DriveInitialSyncTriggerDeps,
} from './drive-initial-sync-trigger.js';
import { DRIVE_INITIAL_SYNC_JOB_TYPE } from './drive-initial-sync.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const ORG_B = '99999999-9999-4999-8999-999999999999';
const INTEGRATION = '22222222-2222-4222-8222-222222222222';

function makeDeps(overrides: Partial<DriveInitialSyncTriggerDeps> = {}): {
  deps: DriveInitialSyncTriggerDeps;
  loadSyncStatus: ReturnType<typeof vi.fn>;
  submitInitialSyncJob: ReturnType<typeof vi.fn>;
  resolveActiveIntegrationId: ReturnType<typeof vi.fn>;
} {
  const loadSyncStatus = vi.fn(async () => null);
  const submitInitialSyncJob = vi.fn(async () => 'job-1');
  const resolveActiveIntegrationId = vi.fn(async () => INTEGRATION);
  const deps: DriveInitialSyncTriggerDeps = {
    loadSyncStatus,
    submitInitialSyncJob,
    resolveActiveIntegrationId,
    isEnabled: () => true,
    ...overrides,
  };
  return { deps, loadSyncStatus, submitInitialSyncJob, resolveActiveIntegrationId };
}

describe('triggerDriveInitialSyncForFolders', () => {
  it('enqueues a fresh initial-sync job for a folder with no prior sync state', async () => {
    const { deps, submitInitialSyncJob } = makeDeps();
    const results = await triggerDriveInitialSyncForFolders(deps, {
      orgId: ORG,
      ruleId: 'rule-1',
      folders: [{ folderId: 'folder-a', folderName: 'A' }],
    });
    expect(submitInitialSyncJob).toHaveBeenCalledWith(
      expect.objectContaining({ org_id: ORG, integration_id: INTEGRATION, folder_id: 'folder-a', rule_id: 'rule-1' }),
    );
    expect(results).toEqual([{ folderId: 'folder-a', outcome: 'enqueued', jobId: 'job-1' }]);
  });

  it('skips a folder already completed — idempotent, enqueues nothing new', async () => {
    const { deps, submitInitialSyncJob } = makeDeps({
      loadSyncStatus: vi.fn(async () => 'completed' as const),
    });
    const results = await triggerDriveInitialSyncForFolders(deps, {
      orgId: ORG,
      ruleId: null,
      folders: [{ folderId: 'folder-a', folderName: null }],
    });
    expect(submitInitialSyncJob).not.toHaveBeenCalled();
    expect(results).toEqual([{ folderId: 'folder-a', outcome: 'already_synced' }]);
  });

  it('skips a folder already in progress — avoids a duplicate concurrent enumeration', async () => {
    const { deps, submitInitialSyncJob } = makeDeps({
      loadSyncStatus: vi.fn(async () => 'in_progress' as const),
    });
    const results = await triggerDriveInitialSyncForFolders(deps, {
      orgId: ORG,
      ruleId: null,
      folders: [{ folderId: 'folder-a', folderName: null }],
    });
    expect(submitInitialSyncJob).not.toHaveBeenCalled();
    expect(results).toEqual([{ folderId: 'folder-a', outcome: 'sync_in_progress' }]);
  });

  it('re-triggers a folder previously marked failed', async () => {
    const { deps, submitInitialSyncJob } = makeDeps({
      loadSyncStatus: vi.fn(async () => 'failed' as const),
    });
    await triggerDriveInitialSyncForFolders(deps, {
      orgId: ORG,
      ruleId: null,
      folders: [{ folderId: 'folder-a', folderName: null }],
    });
    expect(submitInitialSyncJob).toHaveBeenCalledTimes(1);
  });

  it('processes each folder independently — one lookup failure does not block the others', async () => {
    const loadSyncStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error('db blip'))
      .mockResolvedValueOnce(null);
    const { deps, submitInitialSyncJob } = makeDeps({ loadSyncStatus });
    const results = await triggerDriveInitialSyncForFolders(deps, {
      orgId: ORG,
      ruleId: null,
      folders: [
        { folderId: 'folder-bad', folderName: null },
        { folderId: 'folder-ok', folderName: null },
      ],
    });
    expect(results).toEqual([
      { folderId: 'folder-bad', outcome: 'error', error: expect.any(String) },
      { folderId: 'folder-ok', outcome: 'enqueued', jobId: 'job-1' },
    ]);
    expect(submitInitialSyncJob).toHaveBeenCalledTimes(1);
  });

  it('is disabled by the kill switch and never resolves a connection, reads state, or enqueues', async () => {
    const { deps, loadSyncStatus, submitInitialSyncJob, resolveActiveIntegrationId } = makeDeps({ isEnabled: () => false });
    const results = await triggerDriveInitialSyncForFolders(deps, {
      orgId: ORG,
      ruleId: null,
      folders: [{ folderId: 'folder-a', folderName: null }],
    });
    expect(resolveActiveIntegrationId).not.toHaveBeenCalled();
    expect(loadSyncStatus).not.toHaveBeenCalled();
    expect(submitInitialSyncJob).not.toHaveBeenCalled();
    expect(results).toEqual([{ folderId: 'folder-a', outcome: 'skipped_disabled' }]);
  });

  it('skips every folder as skipped_no_connection when the org has no active Drive connection', async () => {
    const { deps, submitInitialSyncJob } = makeDeps({
      resolveActiveIntegrationId: vi.fn(async () => null),
    });
    const results = await triggerDriveInitialSyncForFolders(deps, {
      orgId: ORG,
      ruleId: null,
      folders: [
        { folderId: 'folder-a', folderName: null },
        { folderId: 'folder-b', folderName: null },
      ],
    });
    expect(submitInitialSyncJob).not.toHaveBeenCalled();
    expect(results).toEqual([
      { folderId: 'folder-a', outcome: 'skipped_no_connection' },
      { folderId: 'folder-b', outcome: 'skipped_no_connection' },
    ]);
  });

  it('resolves the active connection ONCE per call, not once per folder', async () => {
    const { deps, resolveActiveIntegrationId } = makeDeps();
    await triggerDriveInitialSyncForFolders(deps, {
      orgId: ORG,
      ruleId: null,
      folders: [
        { folderId: 'folder-a', folderName: null },
        { folderId: 'folder-b', folderName: null },
        { folderId: 'folder-c', folderName: null },
      ],
    });
    expect(resolveActiveIntegrationId).toHaveBeenCalledTimes(1);
  });

  it('returns [] for an empty folder list without calling anything', async () => {
    const { deps, loadSyncStatus, submitInitialSyncJob, resolveActiveIntegrationId } = makeDeps();
    const results = await triggerDriveInitialSyncForFolders(deps, {
      orgId: ORG,
      ruleId: null,
      folders: [],
    });
    expect(results).toEqual([]);
    expect(resolveActiveIntegrationId).not.toHaveBeenCalled();
    expect(loadSyncStatus).not.toHaveBeenCalled();
    expect(submitInitialSyncJob).not.toHaveBeenCalled();
  });

  it('never throws even when submitInitialSyncJob rejects', async () => {
    const { deps } = makeDeps({ submitInitialSyncJob: vi.fn(async () => { throw new Error('queue down'); }) });
    const results = await triggerDriveInitialSyncForFolders(deps, {
      orgId: ORG,
      ruleId: null,
      folders: [{ folderId: 'folder-a', folderName: null }],
    });
    expect(results).toEqual([{ folderId: 'folder-a', outcome: 'error', error: expect.any(String) }]);
  });

  describe('tenant isolation', () => {
    it('every connection resolution, state lookup, and job submission is scoped to the caller\'s own org', async () => {
      const { deps, loadSyncStatus, submitInitialSyncJob, resolveActiveIntegrationId } = makeDeps();
      await triggerDriveInitialSyncForFolders(deps, {
        orgId: ORG,
        ruleId: null,
        folders: [{ folderId: 'folder-a', folderName: null }],
      });
      expect(resolveActiveIntegrationId).toHaveBeenCalledWith(ORG);
      expect(resolveActiveIntegrationId).not.toHaveBeenCalledWith(ORG_B);
      expect(loadSyncStatus).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, folderId: 'folder-a' }));
      expect(submitInitialSyncJob).toHaveBeenCalledWith(expect.objectContaining({ org_id: ORG }));
    });
  });
});

describe('loadConnectorDriveFoldersForOrg', () => {
  it('extracts folders only from connector-managed WORKSPACE_FILE_MODIFIED rules, scoped to the given org', async () => {
    const rows = [
      {
        id: 'rule-1',
        trigger_type: 'WORKSPACE_FILE_MODIFIED',
        trigger_config: { drive_folders: [{ folder_id: 'folder-a', folder_name: 'A' }] },
        action_config: { tag: 'connector-google_drive' },
      },
      {
        // Not connector-managed — must be ignored.
        id: 'rule-2',
        trigger_type: 'WORKSPACE_FILE_MODIFIED',
        trigger_config: { drive_folders: [{ folder_id: 'folder-b', folder_name: 'B' }] },
        action_config: { tag: 'manual' },
      },
      {
        // Different trigger type — must be ignored.
        id: 'rule-3',
        trigger_type: 'ESIGN_COMPLETED',
        trigger_config: {},
        action_config: { tag: 'connector-google_drive' },
      },
    ];
    let capturedOrgId: string | undefined;
    let capturedTriggerType: string | undefined;
    const db = {
      from: (table: string) => {
        expect(table).toBe('organization_rules');
        return {
          select: () => ({
            eq: (col: string, val: string) => {
              if (col === 'org_id') capturedOrgId = val;
              if (col === 'trigger_type') capturedTriggerType = val;
              return {
                eq: (col2: string, val2: string) => {
                  if (col2 === 'trigger_type') capturedTriggerType = val2;
                  return Promise.resolve({ data: rows, error: null });
                },
              };
            },
          }),
        };
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await loadConnectorDriveFoldersForOrg(db as any, ORG);
    expect(capturedOrgId).toBe(ORG);
    expect(capturedTriggerType).toBe('WORKSPACE_FILE_MODIFIED');
    expect(result).toEqual([
      { ruleId: 'rule-1', folders: [{ folderId: 'folder-a', folderName: 'A' }] },
    ]);
  });

  it('returns [] on a query error rather than throwing', async () => {
    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => Promise.resolve({ data: null, error: { message: 'boom' } }),
          }),
        }),
      }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await loadConnectorDriveFoldersForOrg(db as any, ORG);
    expect(result).toEqual([]);
  });
});

describe('makeDriveInitialSyncTriggerDbDeps', () => {
  function makeFakeDb(row: { status?: string } | null, error: unknown = null) {
    const maybeSingle = vi.fn(async () => ({ data: row, error }));
    const eqFolder = vi.fn(() => ({ maybeSingle }));
    const eqOrg = vi.fn(() => ({ eq: eqFolder }));
    const select = vi.fn(() => ({ eq: eqOrg }));
    const from = vi.fn(() => ({ select }));
    return { db: { from }, from, select, eqOrg, eqFolder, maybeSingle };
  }

  it('loadSyncStatus reads status scoped to (org_id, folder_id)', async () => {
    const { db, from, eqOrg, eqFolder } = makeFakeDb({ status: 'completed' });
    const submitJob = vi.fn(async () => 'job-x');
    const deps = makeDriveInitialSyncTriggerDbDeps({ db: db as never, submitJob });
    const status = await deps.loadSyncStatus({ orgId: ORG, folderId: 'folder-a' });
    expect(status).toBe('completed');
    expect(from).toHaveBeenCalledWith('drive_initial_sync_state');
    expect(eqOrg).toHaveBeenCalledWith('org_id', ORG);
    expect(eqFolder).toHaveBeenCalledWith('folder_id', 'folder-a');
  });

  it('loadSyncStatus returns null when no row exists', async () => {
    const { db } = makeFakeDb(null);
    const submitJob = vi.fn(async () => 'job-x');
    const deps = makeDriveInitialSyncTriggerDbDeps({ db: db as never, submitJob });
    expect(await deps.loadSyncStatus({ orgId: ORG, folderId: 'folder-a' })).toBeNull();
  });

  it('loadSyncStatus fails closed (treats a DB read error as "no state")', async () => {
    const { db } = makeFakeDb(null, { message: 'db blip' });
    const submitJob = vi.fn(async () => 'job-x');
    const deps = makeDriveInitialSyncTriggerDbDeps({ db: db as never, submitJob });
    expect(await deps.loadSyncStatus({ orgId: ORG, folderId: 'folder-a' })).toBeNull();
  });

  it('submitInitialSyncJob submits the google_drive.initial_sync job type with the given payload', async () => {
    const submitJob = vi.fn(async () => 'job-42');
    const deps = makeDriveInitialSyncTriggerDbDeps({ db: {} as never, submitJob });
    const jobId = await deps.submitInitialSyncJob({
      org_id: ORG,
      integration_id: INTEGRATION,
      folder_id: 'folder-a',
      files_synced_so_far: 0,
      files_enqueued_so_far: 0,
    });
    expect(jobId).toBe('job-42');
    expect(submitJob).toHaveBeenCalledWith(
      expect.objectContaining({
        type: DRIVE_INITIAL_SYNC_JOB_TYPE,
        payload: expect.objectContaining({ org_id: ORG, folder_id: 'folder-a' }),
      }),
    );
  });

  it('resolveActiveIntegrationId resolves via the SAME org_integrations lookup the folder mirror uses', async () => {
    const orgIntegrationsMaybeSingle = vi.fn(async () => ({ data: { id: INTEGRATION }, error: null }));
    const chain = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      is: vi.fn(() => chain),
      order: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      maybeSingle: orgIntegrationsMaybeSingle,
    };
    const from = vi.fn(() => chain);
    const submitJob = vi.fn(async () => 'job-x');
    const deps = makeDriveInitialSyncTriggerDbDeps({ db: { from } as never, submitJob });
    const integrationId = await deps.resolveActiveIntegrationId(ORG);
    expect(integrationId).toBe(INTEGRATION);
    expect(from).toHaveBeenCalledWith('org_integrations');
  });

  it('resolveActiveIntegrationId returns null when the org has no active connection', async () => {
    const chain = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      is: vi.fn(() => chain),
      order: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      maybeSingle: vi.fn(async () => ({ data: null, error: null })),
    };
    const from = vi.fn(() => chain);
    const submitJob = vi.fn(async () => 'job-x');
    const deps = makeDriveInitialSyncTriggerDbDeps({ db: { from } as never, submitJob });
    expect(await deps.resolveActiveIntegrationId(ORG)).toBeNull();
  });
});
