/**
 * DRIVE-BACKFILL (founder directive 2026-09-29) — initial-sync job runner
 * wiring tests.
 *
 * `makeDriveInitialSyncJobDeps` is the real DB/Drive/job_queue adapter for
 * `processDriveInitialSyncJob` (integrations/connectors/drive-initial-sync.ts).
 * `runDriveInitialSyncJobs` drains the `google_drive.initial_sync` job_queue
 * type under the per-org run lease. These tests prove the wiring — every
 * write is scoped to the CALLER's own org/integration (tenant isolation),
 * the file-changed enqueue reuses the exact schema the live changes runner
 * validates against, and a lease miss causes a retryable failure rather than
 * silently dropping the run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/db.js', () => ({ db: {} }));
vi.mock('../config.js', () => ({ config: { enableDriveInitialSync: true } }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../integrations/oauth/drive.js', () => ({
  listFolderFiles: vi.fn(async () => ({ files: [] })),
}));
vi.mock('../integrations/oauth/crypto.js', () => ({
  createDefaultKmsClient: vi.fn(async () => ({ kms: 'stub' })),
}));
vi.mock('../integrations/connectors/drive-changes-runner.js', () => ({
  loadDriveAccessToken: vi.fn(async () => ({ accessToken: 'live-token' })),
}));
vi.mock('../utils/auditEvent.js', () => ({
  recordAuditEvent: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../utils/jobQueue.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/jobQueue.js')>();
  return { ...actual, submitJob: vi.fn(async () => 'job-new'), processNextJob: vi.fn(async () => ({ claimed: false, status: 'idle' })) };
});
vi.mock('./run-lease.js', () => ({
  withRunLease: vi.fn(async (_spec: unknown, body: (ctx: { holder: string }) => Promise<unknown>) => ({
    acquired: true,
    result: await body({ holder: 'holder-1' }),
  })),
}));

import { listFolderFiles } from '../integrations/oauth/drive.js';
import { loadDriveAccessToken } from '../integrations/connectors/drive-changes-runner.js';
import { recordAuditEvent } from '../utils/auditEvent.js';
import { submitJob, processNextJob } from '../utils/jobQueue.js';
import { withRunLease } from './run-lease.js';
import {
  makeDriveInitialSyncJobDeps,
  runDriveInitialSyncJobs,
} from './drive-initial-sync-runner.js';
import { DRIVE_FILE_CHANGED_JOB_TYPE } from '../integrations/connectors/drive-artifact-producer.js';
import { DRIVE_INITIAL_SYNC_JOB_TYPE } from '../integrations/connectors/drive-initial-sync.js';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '99999999-9999-4999-8999-999999999999';
const INTEGRATION = '22222222-2222-4222-8222-222222222222';
const FOLDER = 'folder-abc';

function makeDb(overrides: {
  orgIntegrationsRow?: Record<string, unknown> | null;
  orgIntegrationsError?: unknown;
  syncStateRow?: Record<string, unknown> | null;
  syncStateError?: unknown;
  upsertError?: unknown;
  updateError?: unknown;
} = {}) {
  const orgIntegrationsRow = 'orgIntegrationsRow' in overrides
    ? overrides.orgIntegrationsRow
    : { id: INTEGRATION, org_id: ORG_A, encrypted_tokens: 'cipher', token_kms_key_id: 'key-1', last_page_token: null };
  const orgIntegrationsMaybeSingle = vi.fn(async () => ({
    data: orgIntegrationsRow,
    error: overrides.orgIntegrationsError ?? null,
  }));
  const syncStateMaybeSingle = vi.fn(async () => ({
    data: overrides.syncStateRow ?? null,
    error: overrides.syncStateError ?? null,
  }));

  const captured: { table: string; method: string; args: unknown[] }[] = [];

  const orgIntegrationsChain = {
    select: vi.fn(() => orgIntegrationsChain),
    eq: vi.fn((...args: unknown[]) => {
      captured.push({ table: 'org_integrations', method: 'eq', args });
      return orgIntegrationsChain;
    }),
    is: vi.fn(() => orgIntegrationsChain),
    maybeSingle: orgIntegrationsMaybeSingle,
  };

  const syncStateSelectChain = {
    select: vi.fn(() => syncStateSelectChain),
    eq: vi.fn((...args: unknown[]) => {
      captured.push({ table: 'drive_initial_sync_state', method: 'eq', args });
      return syncStateSelectChain;
    }),
    maybeSingle: syncStateMaybeSingle,
  };

  const upsertResult = { error: overrides.upsertError ?? null };
  // Chainable + thenable: production code calls `.update(...).eq(a).eq(b)`
  // (two filters) and awaits the result of the LAST `.eq()` call — this fake
  // supports any number of chained `.eq()` calls, resolving on await.
  function makeUpdateEqChain(): { eq: (...args: unknown[]) => unknown; then: Promise<{ error: unknown }>['then'] } {
    const resultPromise = Promise.resolve({ error: overrides.updateError ?? null });
    const chain = {
      eq: (...args: unknown[]) => {
        captured.push({ table: 'drive_initial_sync_state', method: 'update.eq', args });
        return chain;
      },
      then: resultPromise.then.bind(resultPromise),
    };
    return chain;
  }

  const from = vi.fn((table: string) => {
    if (table === 'org_integrations') return orgIntegrationsChain;
    if (table === 'drive_initial_sync_state') {
      return {
        select: syncStateSelectChain.select,
        upsert: vi.fn((...args: unknown[]) => {
          captured.push({ table: 'drive_initial_sync_state', method: 'upsert', args });
          return Promise.resolve(upsertResult);
        }),
        update: vi.fn((...args: unknown[]) => {
          captured.push({ table: 'drive_initial_sync_state', method: 'update', args });
          return makeUpdateEqChain();
        }),
      };
    }
    throw new Error(`unexpected table: ${table}`);
  });

  return { db: { from }, from, captured };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('makeDriveInitialSyncJobDeps', () => {
  it('resolveAccessToken scopes the org_integrations lookup to the caller\'s own org AND integration (tenant isolation)', async () => {
    const { db, captured } = makeDb();
    const deps = makeDriveInitialSyncJobDeps({ db: db as never });
    const { accessToken } = await deps.resolveAccessToken({ orgId: ORG_A, integrationId: INTEGRATION });
    expect(accessToken).toBe('live-token');
    const eqCalls = captured.filter((c) => c.table === 'org_integrations' && c.method === 'eq').map((c) => c.args);
    expect(eqCalls).toContainEqual(['id', INTEGRATION]);
    expect(eqCalls).toContainEqual(['org_id', ORG_A]);
    expect(eqCalls).toContainEqual(['provider', 'google_drive']);
    // Never leaks a different org's integration into the query.
    expect(eqCalls.flat()).not.toContain(ORG_B);
    expect(loadDriveAccessToken).toHaveBeenCalled();
  });

  it('resolveAccessToken throws when the integration row is not found (never silently proceeds with no token)', async () => {
    const { db } = makeDb({ orgIntegrationsRow: null });
    const deps = makeDriveInitialSyncJobDeps({ db: db as never });
    await expect(deps.resolveAccessToken({ orgId: ORG_A, integrationId: INTEGRATION })).rejects.toThrow();
  });

  it('listFolderFiles delegates to the oauth/drive.ts Drive client boundary', async () => {
    const { db } = makeDb();
    const deps = makeDriveInitialSyncJobDeps({ db: db as never });
    await deps.listFolderFiles({ accessToken: 'tok', folderId: FOLDER });
    expect(listFolderFiles).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'tok', folderId: FOLDER }));
  });

  it('enqueueFileChangedJob validates against the SAME schema the live changes runner uses and submits DRIVE_FILE_CHANGED_JOB_TYPE', async () => {
    const { db } = makeDb();
    const deps = makeDriveInitialSyncJobDeps({ db: db as never });
    const jobId = await deps.enqueueFileChangedJob({
      org_id: ORG_A,
      integration_id: INTEGRATION,
      file_id: 'file-1',
      revision_id: 'rev-1',
      mime_type: 'application/pdf',
      folder_id: FOLDER,
      revision_kind: 'head_revision',
    });
    expect(jobId).toBe('job-new');
    expect(submitJob).toHaveBeenCalledWith(
      expect.objectContaining({
        type: DRIVE_FILE_CHANGED_JOB_TYPE,
        payload: expect.objectContaining({ org_id: ORG_A, integration_id: INTEGRATION, file_id: 'file-1' }),
      }),
    );
  });

  it('enqueueFileChangedJob returns null (never throws) on an invalid payload shape', async () => {
    const { db } = makeDb();
    const deps = makeDriveInitialSyncJobDeps({ db: db as never });
    const jobId = await deps.enqueueFileChangedJob({
      org_id: 'not-a-uuid',
      integration_id: INTEGRATION,
      file_id: 'file-1',
    });
    expect(jobId).toBeNull();
    expect(submitJob).not.toHaveBeenCalled();
  });

  it('scheduleContinuation submits DRIVE_INITIAL_SYNC_JOB_TYPE', async () => {
    const { db } = makeDb();
    const deps = makeDriveInitialSyncJobDeps({ db: db as never });
    await deps.scheduleContinuation({
      org_id: ORG_A,
      integration_id: INTEGRATION,
      folder_id: FOLDER,
      files_synced_so_far: 1000,
      files_enqueued_so_far: 900,
    });
    expect(submitJob).toHaveBeenCalledWith(expect.objectContaining({ type: DRIVE_INITIAL_SYNC_JOB_TYPE }));
  });

  it('loadSyncState reads status scoped to (org_id, folder_id)', async () => {
    const { db, captured } = makeDb({ syncStateRow: { status: 'completed' } });
    const deps = makeDriveInitialSyncJobDeps({ db: db as never });
    const state = await deps.loadSyncState({ orgId: ORG_A, folderId: FOLDER });
    expect(state).toEqual({ status: 'completed' });
    const eqCalls = captured.filter((c) => c.table === 'drive_initial_sync_state' && c.method === 'eq').map((c) => c.args);
    expect(eqCalls).toContainEqual(['org_id', ORG_A]);
    expect(eqCalls).toContainEqual(['folder_id', FOLDER]);
  });

  it('upsertSyncStateInProgress upserts on (org_id, folder_id) with status in_progress', async () => {
    const { db, captured } = makeDb();
    const deps = makeDriveInitialSyncJobDeps({ db: db as never });
    await deps.upsertSyncStateInProgress({ orgId: ORG_A, integrationId: INTEGRATION, folderId: FOLDER, ruleId: 'rule-1' });
    const upsertCall = captured.find((c) => c.method === 'upsert');
    expect(upsertCall?.args[0]).toEqual(
      expect.objectContaining({ org_id: ORG_A, integration_id: INTEGRATION, folder_id: FOLDER, rule_id: 'rule-1', status: 'in_progress' }),
    );
  });

  it('upsertSyncStateInProgress throws on a DB error (must not silently proceed with no reservation)', async () => {
    const { db } = makeDb({ upsertError: { message: 'boom' } });
    const deps = makeDriveInitialSyncJobDeps({ db: db as never });
    await expect(
      deps.upsertSyncStateInProgress({ orgId: ORG_A, integrationId: INTEGRATION, folderId: FOLDER, ruleId: null }),
    ).rejects.toThrow();
  });

  it('completeSyncState / failSyncState scope their UPDATE to (org_id, folder_id)', async () => {
    const { db, captured } = makeDb();
    const deps = makeDriveInitialSyncJobDeps({ db: db as never });
    await deps.completeSyncState({ orgId: ORG_A, folderId: FOLDER });
    await deps.failSyncState({ orgId: ORG_A, folderId: FOLDER, reason: 'drive_403' });
    const updateEqCalls = captured.filter((c) => c.method === 'update.eq').map((c) => c.args);
    expect(updateEqCalls).toContainEqual(['org_id', ORG_A]);
    expect(updateEqCalls).toContainEqual(['folder_id', FOLDER]);
  });

  it('recordAuditEvent routes through the shared auditEvent writer with counts only, never file names', async () => {
    const { db } = makeDb();
    const deps = makeDriveInitialSyncJobDeps({ db: db as never });
    await deps.recordAuditEvent({
      orgId: ORG_A,
      integrationId: INTEGRATION,
      folderId: FOLDER,
      eventType: 'drive_folder_initial_sync_completed',
      details: { files_synced: 12 },
    });
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'drive_folder_initial_sync_completed', org_id: ORG_A }),
    );
    const call = (recordAuditEvent as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as Record<string, unknown>;
    expect(JSON.stringify(call)).not.toMatch(/\.pdf|\.docx/);
  });

  it('isEnabled reflects ENABLE_DRIVE_INITIAL_SYNC', () => {
    const { db } = makeDb();
    const deps = makeDriveInitialSyncJobDeps({ db: db as never, enableDriveInitialSync: false });
    expect(deps.isEnabled?.()).toBe(false);
  });
});

describe('runDriveInitialSyncJobs', () => {
  it('is a no-op when nothing is queued', async () => {
    (processNextJob as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ claimed: false, status: 'idle' });
    const result = await runDriveInitialSyncJobs();
    expect(result.claimed).toBe(0);
  });

  it('acquires the per-org lease before running the job body', async () => {
    const { db } = makeDb();
    (processNextJob as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_type: string, handler: (job: { id: string; payload: unknown; attempts: number; max_attempts: number }) => Promise<void>) => {
        await handler({ id: 'job-1', payload: { org_id: ORG_A, integration_id: INTEGRATION, folder_id: FOLDER }, attempts: 0, max_attempts: 5 });
        return { claimed: true, status: 'completed', jobId: 'job-1' };
      },
    ).mockResolvedValue({ claimed: false, status: 'idle' });

    await runDriveInitialSyncJobs({ db: db as never });
    expect(withRunLease).toHaveBeenCalledWith(
      expect.objectContaining({ leaseId: ORG_A, leaseType: 'drive-initial-sync:lease' }),
      expect.any(Function),
    );
  });

  it('throws (retryable) when the org lease could not be acquired, rather than silently dropping the job', async () => {
    (withRunLease as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ acquired: false });
    (processNextJob as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_type: string, handler: (job: { id: string; payload: unknown; attempts: number; max_attempts: number }) => Promise<void>) => {
        await expect(
          handler({ id: 'job-1', payload: { org_id: ORG_A, integration_id: INTEGRATION, folder_id: FOLDER }, attempts: 0, max_attempts: 5 }),
        ).rejects.toThrow();
        return { claimed: true, status: 'failed', jobId: 'job-1' };
      },
    ).mockResolvedValue({ claimed: false, status: 'idle' });

    await runDriveInitialSyncJobs();
    expect(processNextJob).toHaveBeenCalled();
  });
});
