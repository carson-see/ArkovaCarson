/**
 * Google Drive initial-sync job runner (DRIVE-BACKFILL, founder directive
 * 2026-09-29).
 *
 * Real DB/Drive/job_queue wiring for `processDriveInitialSyncJob`
 * (`integrations/connectors/drive-initial-sync.ts`) — the Drive twin of
 * `jobs/drive-file-changed.ts` relative to `drive-artifact-producer.ts`.
 * Drains the `google_drive.initial_sync` job_queue type under a per-org run
 * lease (`driveInitialSyncRunLeaseSpec` — see that spec's doc comment for why
 * concurrency is bounded to 1 run per org).
 *
 * §1.6A: this module fetches NO document bytes — `listFolderFiles` is
 * metadata-only, exactly like `listChanges`. Byte handling stays confined to
 * `jobs/drive-file-changed.ts`'s sink, unchanged by this feature.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { db as defaultDb } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { processNextJob, submitJob } from '../utils/jobQueue.js';
import { recordAuditEvent } from '../utils/auditEvent.js';
import { withRunLease } from './run-lease.js';
import {
  processDriveInitialSyncJob,
  driveInitialSyncRunLeaseSpec,
  DRIVE_INITIAL_SYNC_JOB_TYPE,
  type DriveInitialSyncDeps,
  type DriveInitialSyncJobPayloadT,
} from '../integrations/connectors/drive-initial-sync.js';
import {
  loadDriveAccessToken,
  type DriveIntegrationRow,
} from '../integrations/connectors/drive-changes-runner.js';
import { listFolderFiles as driveListFolderFiles } from '../integrations/oauth/drive.js';
import { createDefaultKmsClient } from '../integrations/oauth/crypto.js';
import { DriveFileChangedJobPayload, DRIVE_FILE_CHANGED_JOB_TYPE } from '../integrations/connectors/drive-artifact-producer.js';

export { DRIVE_INITIAL_SYNC_JOB_TYPE };

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 25;
const DRIVE_PROVIDER = 'google_drive';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export interface DriveInitialSyncRunnerRuntimeDeps {
  db?: AnyDb;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  // Overrides ENABLE_DRIVE_INITIAL_SYNC for tests. Unset reads config.
  enableDriveInitialSync?: boolean;
  kmsFactory?: () => Promise<Parameters<typeof loadDriveAccessToken>[1]['kms']>;
}

export interface DriveInitialSyncRunOptions extends DriveInitialSyncRunnerRuntimeDeps {
  limit?: number;
  jobDeps?: DriveInitialSyncDeps;
}

export interface DriveInitialSyncRunResultSummary {
  claimed: number;
  completed: number;
  failed: number;
  dead: number;
  updateFailed: number;
  jobIds: string[];
}

function normalizeLimit(rawLimit: number | undefined): number {
  if (rawLimit === undefined || !Number.isFinite(rawLimit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(rawLimit)));
}

/**
 * Build the real `DriveInitialSyncDeps` — DB/Drive/job_queue adapter.
 */
export function makeDriveInitialSyncJobDeps(
  deps: DriveInitialSyncRunnerRuntimeDeps = {},
): DriveInitialSyncDeps {
  const db = deps.db ?? (defaultDb as unknown as AnyDb);
  const env = deps.env ?? process.env;
  const enabled = deps.enableDriveInitialSync ?? config.enableDriveInitialSync;
  const driveDeps = { fetchImpl: deps.fetchImpl, env };

  // ONE KMS client per deps instance — same reasoning as
  // `jobs/drive-file-changed.ts`'s `makeDriveFileChangedJobDeps`: avoid
  // opening a fresh gRPC channel per job in a tight drain loop.
  let kmsClientPromise: Promise<Awaited<ReturnType<typeof createDefaultKmsClient>>> | null = null;
  const getKmsClient = () => {
    kmsClientPromise ??= deps.kmsFactory ? deps.kmsFactory() : createDefaultKmsClient();
    return kmsClientPromise;
  };

  return {
    isEnabled: () => enabled,

    async resolveAccessToken({ orgId, integrationId }) {
      // Scoped by BOTH integration id AND org id — never resolve a token
      // cross-tenant. Mirrors jobs/drive-file-changed.ts's identical guard.
      const { data, error } = await db
        .from('org_integrations')
        .select('id, org_id, encrypted_tokens, token_kms_key_id, last_page_token')
        .eq('id', integrationId)
        .eq('org_id', orgId)
        .eq('provider', DRIVE_PROVIDER)
        .is('revoked_at', null)
        .maybeSingle();
      if (error) {
        logger.error({ error, integrationId, orgId }, 'drive initial sync: integration lookup failed');
        throw new Error('drive_integration_lookup_failed');
      }
      if (!data) {
        throw new Error('drive_integration_not_found');
      }
      const integrationRow: DriveIntegrationRow = {
        id: data.id,
        org_id: data.org_id,
        encrypted_tokens: data.encrypted_tokens,
        token_kms_key_id: data.token_kms_key_id,
        last_page_token: data.last_page_token,
      };
      const kms = await getKmsClient();
      const { accessToken } = await loadDriveAccessToken(integrationRow, {
        db,
        kms,
        drive: driveDeps,
        env,
        now: deps.now,
      });
      return { accessToken };
    },

    async listFolderFiles({ accessToken, folderId, pageToken }) {
      return driveListFolderFiles({ accessToken, folderId, pageToken, deps: driveDeps });
    },

    async enqueueFileChangedJob(payload) {
      // Validate against the SAME schema the live changes runner enqueues
      // against (`drive-changes-runner.ts`'s `enqueueFileChangedJob`) — one
      // schema, two producers, zero drift risk.
      const parsed = DriveFileChangedJobPayload.safeParse(payload);
      if (!parsed.success) {
        logger.error(
          { issues: parsed.error.issues, integrationId: payload.integration_id },
          'drive initial sync: google_drive.file_changed enqueue failed schema validation',
        );
        return null;
      }
      const jobId = await submitJob({
        type: DRIVE_FILE_CHANGED_JOB_TYPE,
        max_attempts: 5,
        priority: 10,
        payload: parsed.data,
      });
      if (!jobId) {
        logger.error({ integrationId: payload.integration_id }, 'drive initial sync: file-changed job enqueue failed');
        return null;
      }
      return jobId;
    },

    async scheduleContinuation(payload: DriveInitialSyncJobPayloadT) {
      const jobId = await submitJob({
        type: DRIVE_INITIAL_SYNC_JOB_TYPE,
        // Lower priority than live file-changed jobs (10) so a large backfill
        // never starves ongoing change processing for the same org.
        priority: 5,
        max_attempts: 5,
        payload,
      });
      if (!jobId) {
        logger.error({ orgId: payload.org_id, folderId: payload.folder_id }, 'drive initial sync: continuation enqueue failed');
      }
      return jobId;
    },

    async loadSyncState({ orgId, folderId }) {
      const { data, error } = await db
        .from('drive_initial_sync_state')
        .select('status')
        .eq('org_id', orgId)
        .eq('folder_id', folderId)
        .maybeSingle();
      if (error) {
        // A failed read is NOT "never started": returning null here would let
        // a fresh trigger fall through the already-completed guard, reset a
        // finished folder to in_progress and re-enumerate it. Throw so the
        // job fails and jobQueue's backoff retries it once the DB recovers.
        logger.error({ error, orgId, folderId }, 'drive initial sync: state read failed');
        throw new Error('drive_initial_sync_state_read_failed');
      }
      if (!data) return null;
      return { status: (data as { status: 'in_progress' | 'completed' | 'failed' }).status };
    },

    async upsertSyncStateInProgress({ orgId, integrationId, folderId, ruleId }) {
      const nowIso = (deps.now?.() ?? new Date()).toISOString();
      const { error } = await db
        .from('drive_initial_sync_state')
        .upsert(
          {
            org_id: orgId,
            integration_id: integrationId,
            folder_id: folderId,
            rule_id: ruleId,
            status: 'in_progress',
            page_token: null,
            files_seen_count: 0,
            files_enqueued_count: 0,
            last_error: null,
            started_at: nowIso,
            completed_at: null,
            last_synced_at: nowIso,
          },
          { onConflict: 'org_id,folder_id' },
        );
      if (error) {
        logger.error({ error, orgId, folderId }, 'drive initial sync: state upsert (in_progress) failed');
        throw new Error('drive_initial_sync_state_upsert_failed');
      }
    },

    async updateSyncStateProgress({ orgId, folderId, pageToken, filesSeenTotal, filesEnqueuedTotal }) {
      const nowIso = (deps.now?.() ?? new Date()).toISOString();
      const { error } = await db
        .from('drive_initial_sync_state')
        .update({
          page_token: pageToken,
          files_seen_count: filesSeenTotal,
          files_enqueued_count: filesEnqueuedTotal,
          last_synced_at: nowIso,
        })
        .eq('org_id', orgId)
        .eq('folder_id', folderId);
      if (error) {
        // Non-fatal: the run's OWN in-memory counters are still correct for
        // this pass, and a lost progress write only costs re-walking from an
        // earlier page on a future retry — never a lost or double-counted file
        // (the connector_artifact dedupe key is what actually prevents
        // double-securing, not this bookkeeping row).
        logger.error({ error, orgId, folderId }, 'drive initial sync: state progress update failed');
      }
    },

    async completeSyncState({ orgId, folderId }) {
      const nowIso = (deps.now?.() ?? new Date()).toISOString();
      const { error } = await db
        .from('drive_initial_sync_state')
        .update({ status: 'completed', completed_at: nowIso, last_synced_at: nowIso, page_token: null })
        .eq('org_id', orgId)
        .eq('folder_id', folderId);
      if (error) logger.error({ error, orgId, folderId }, 'drive initial sync: state complete update failed');
    },

    async failSyncState({ orgId, folderId, reason }) {
      const nowIso = (deps.now?.() ?? new Date()).toISOString();
      const { error } = await db
        .from('drive_initial_sync_state')
        .update({ status: 'failed', last_error: reason, last_synced_at: nowIso })
        .eq('org_id', orgId)
        .eq('folder_id', folderId);
      if (error) logger.error({ error, orgId, folderId }, 'drive initial sync: state fail update failed');
    },

    async recordAuditEvent({ orgId, integrationId, folderId, eventType, details }) {
      // Counts only, no file names — folder_id is the only Drive identifier
      // carried, matching every other Drive audit write in this codebase.
      return recordAuditEvent({
        event_type: eventType,
        event_category: 'WEBHOOK',
        org_id: orgId,
        target_type: 'org_integrations',
        target_id: integrationId,
        details: { folder_id: folderId, ...details },
      });
    },

    logger,
  };
}

/**
 * Drain the `google_drive.initial_sync` job_queue type. Each job runs under
 * the per-org lease (`driveInitialSyncRunLeaseSpec`) — a lease miss (another
 * job for the same org is already running) throws so job_queue's own
 * exponential backoff retries it later, rather than silently dropping the
 * run or busy-looping.
 */
export async function runDriveInitialSyncJobs(
  options: DriveInitialSyncRunOptions = {},
): Promise<DriveInitialSyncRunResultSummary> {
  const limit = normalizeLimit(options.limit);
  const jobDeps = options.jobDeps ?? makeDriveInitialSyncJobDeps(options);
  const leaseClient = (options.db ?? defaultDb) as unknown as SupabaseClient;
  const result: DriveInitialSyncRunResultSummary = {
    claimed: 0,
    completed: 0,
    failed: 0,
    dead: 0,
    updateFailed: 0,
    jobIds: [],
  };

  for (let i = 0; i < limit; i++) {
    const processed = await processNextJob<DriveInitialSyncJobPayloadT>(DRIVE_INITIAL_SYNC_JOB_TYPE, async (job) => {
      const orgId = (job.payload as { org_id?: string })?.org_id;
      if (!orgId) {
        // A malformed/pre-schema payload with no org id can never be leased
        // per-org — let processDriveInitialSyncJob's own Zod parse reject it
        // (and job_queue dead-letter it) rather than crashing the lease call.
        await processDriveInitialSyncJob(job.payload, jobDeps);
        return;
      }
      const leaseSpec = driveInitialSyncRunLeaseSpec(orgId);
      const outcome = await withRunLease({ ...leaseSpec, client: leaseClient }, () =>
        processDriveInitialSyncJob(job.payload, jobDeps),
      );
      if (!outcome.acquired) {
        // Retryable: per-org concurrency of 1 — another initial-sync job for
        // this org is already running. job_queue's exponential backoff
        // (services/worker/src/utils/jobQueue.ts) retries later.
        throw new Error('drive_initial_sync_locked');
      }
    });
    if (!processed.claimed) break;
    result.claimed += 1;
    if (processed.jobId) result.jobIds.push(processed.jobId);
    if (processed.status === 'completed') result.completed += 1;
    else if (processed.status === 'failed') result.failed += 1;
    else if (processed.status === 'dead') result.dead += 1;
    else if (processed.status === 'update_failed') result.updateFailed += 1;
  }

  return result;
}
