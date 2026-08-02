/**
 * Google Drive file-changed job runner (SCRUM-2903 / GD-PROD).
 *
 * Drains the `google_drive.file_changed` job_queue type — the durable hand-off
 * the Drive changes runner writes when a change matches a watched folder — and
 * produces exactly one `connector_artifact` (source 'google_drive') per
 * (org, file, revision). This is the Drive twin of
 * `jobs/docusign-envelope-completed.ts`.
 *
 * §1.6A: the sink below is the ONE place Drive document bytes are touched. Bytes
 * are SHA-256'd in memory then dropped. Only `fingerprint_sha256` + `byte_length`
 * + a fixed, ids-only, PII-free metadata object reach Postgres. No bytes reach a
 * logger, Sentry, an Error, `job_queue.last_error`, or a temp file.
 */
import { createHash } from 'node:crypto';

import { db as defaultDb } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { processNextJob } from '../utils/jobQueue.js';
import {
  processDriveFileChangedJob,
  DRIVE_ARTIFACT_SOURCE,
  DRIVE_FILE_CHANGED_JOB_TYPE,
  CONNECTOR_ARTIFACT_ENQUEUE_DISABLED_ID,
  type DriveArtifactProducerDeps,
  type DriveArtifactSinkResult,
} from '../integrations/connectors/drive-artifact-producer.js';
import {
  loadDriveAccessToken,
  type DriveIntegrationRow,
} from '../integrations/connectors/drive-changes-runner.js';
import { fetchDriveFileBytes } from '../integrations/oauth/drive.js';
import { createDefaultKmsClient } from '../integrations/oauth/crypto.js';

// Re-exported for back-compat with existing importers — the job type is now
// owned by drive-artifact-producer.ts (see DRIVE_FILE_CHANGED_JOB_TYPE there
// for why: it must be importable from drive-changes-runner.ts too, and that
// module cannot depend on this one without creating a cycle).
export { DRIVE_FILE_CHANGED_JOB_TYPE };
const DEFAULT_DRIVE_FILE_JOB_LIMIT = 10;
const MAX_DRIVE_FILE_JOB_LIMIT = 100;
// CONNECTOR_ARTIFACT_ENQUEUE_DISABLED_ID is imported from the producer module —
// both the pre-fetch short-circuit and the sink guard return it, so it has one
// definition. No consumer reads artifactId on the disabled branch.

const QUEUE_STATUS_COUNTERS = {
  completed: 'completed',
  failed: 'failed',
  dead: 'dead',
  update_failed: 'updateFailed',
} as const;
type QueueStatus = keyof typeof QUEUE_STATUS_COUNTERS;

interface DbQueryResult<T> {
  data: T | null;
  error: unknown;
}

// Narrow view of the 0343 enqueue RPC (see docusign-envelope-completed.ts).
interface EnqueueConnectorArtifactArgs {
  p_org_id: string;
  p_source: typeof DRIVE_ARTIFACT_SOURCE;
  p_external_ref: string;
  p_external_revision: string | null;
  p_fingerprint_sha256: string;
  p_byte_length: number | null;
  p_source_timestamp: string | null;
  p_metadata: Record<string, unknown>;
}

interface ConnectorArtifactRpcClient {
  rpc(fn: 'enqueue_connector_artifact', args: EnqueueConnectorArtifactArgs): Promise<DbQueryResult<string>>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export interface DriveFileChangedJobRuntimeDeps {
  db?: AnyDb;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  // Overrides ENABLE_CONNECTOR_ARTIFACT_ENQUEUE for tests. When unset the env
  // flag (default off in prod until the drain is fully wired) decides.
  enableConnectorArtifactEnqueue?: boolean;
  // Inject a KMS client in tests; production builds the default GCP KMS client.
  kmsFactory?: () => Promise<Parameters<typeof loadDriveAccessToken>[1]['kms']>;
}

export interface DriveFileChangedJobRunOptions extends DriveFileChangedJobRuntimeDeps {
  limit?: number;
  jobDeps?: DriveArtifactProducerDeps;
}

export interface DriveFileChangedJobRunResult {
  claimed: number;
  completed: number;
  failed: number;
  dead: number;
  updateFailed: number;
  jobIds: string[];
}

function normalizeLimit(rawLimit: number | undefined): number {
  if (rawLimit === undefined || !Number.isFinite(rawLimit)) {
    return DEFAULT_DRIVE_FILE_JOB_LIMIT;
  }
  return Math.min(MAX_DRIVE_FILE_JOB_LIMIT, Math.max(1, Math.trunc(rawLimit)));
}

/**
 * Build the injected producer deps: token resolver, byte-fetch, and artifact
 * sink. The sink is the §1.6A-critical span.
 */
export function makeDriveFileChangedJobDeps(
  deps: DriveFileChangedJobRuntimeDeps = {},
): DriveArtifactProducerDeps {
  const db = deps.db ?? (defaultDb as unknown as AnyDb);
  const env = deps.env ?? process.env;
  const connectorArtifactEnqueueEnabled =
    deps.enableConnectorArtifactEnqueue ?? env.ENABLE_CONNECTOR_ARTIFACT_ENQUEUE === 'true';
  const driveDeps = { fetchImpl: deps.fetchImpl, env };

  // ONE KMS client per deps instance, not one per job. `createDefaultKmsClient`
  // constructs a KeyManagementServiceClient, which opens a gRPC channel that is
  // never closed. resolveAccessToken runs inside the drain loop (up to
  // MAX_DRIVE_FILE_JOB_LIMIT = 100 iterations per cron pass), so building it
  // per job leaked up to 100 channels every 5 minutes. Every other caller in the
  // repo is one-shot per HTTP request; this is the first in a tight loop.
  // Memoized on the promise so concurrent callers share one construction.
  let kmsClientPromise: Promise<Awaited<ReturnType<typeof createDefaultKmsClient>>> | null = null;
  const getKmsClient = () => {
    kmsClientPromise ??= deps.kmsFactory ? deps.kmsFactory() : createDefaultKmsClient();
    return kmsClientPromise;
  };

  return {
    isEnqueueEnabled: () => connectorArtifactEnqueueEnabled,

    async resolveAccessToken({ orgId, integrationId }) {
      // Load the Drive integration row (encrypted tokens + KMS key + page token)
      // so loadDriveAccessToken can decrypt → refresh → persist. Scoped by BOTH
      // integration id AND org id — never resolve a token cross-tenant.
      const { data, error } = await db
        .from('org_integrations')
        .select('id, org_id, encrypted_tokens, token_kms_key_id, last_page_token')
        .eq('id', integrationId)
        .eq('org_id', orgId)
        .eq('provider', DRIVE_ARTIFACT_SOURCE)
        .is('revoked_at', null)
        .maybeSingle();
      if (error) {
        logger.error({ error, integrationId }, 'drive file-changed: integration lookup failed');
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

    async fetchDocument({ fileId, accessToken, mimeType }) {
      // §1.6A document-bearing fetch. The helper attaches no body on error.
      const { bytes, contentType, exportMimeType } = await fetchDriveFileBytes({
        fileId,
        accessToken,
        mimeType,
        deps: driveDeps,
      });
      return { bytes, contentType, exportMimeType };
    },

    async enqueueArtifact(input): Promise<DriveArtifactSinkResult> {
      // Feature-flag guard (mirrors DocuSign DS-03): when the connector-artifact
      // enqueue is disabled, do NOT hash or write a row — nothing would anchor
      // it, so a `pending` pile-up would accrue. Graceful no-op: skip BEFORE
      // hashing, write nothing, throw nothing. The breadcrumb carries operational
      // ids only — never bytes or a digest (§1.6A).
      if (!connectorArtifactEnqueueEnabled) {
        logger.info(
          { integrationId: input.integrationId },
          'Drive connector-artifact enqueue skipped — ENABLE_CONNECTOR_ARTIFACT_ENQUEUE disabled',
        );
        return { artifactId: CONNECTOR_ARTIFACT_ENQUEUE_DISABLED_ID };
      }

      // §1.6A: server-side SHA-256 over the fetched bytes, computed in memory.
      // The bytes are never logged, persisted, attached to an Error, or written
      // to job_queue.last_error. Only the digest + byteLength leave this scope.
      const fingerprint = createHash('sha256').update(input.documentBytes).digest('hex');
      const byteLength = input.documentBytes.byteLength;

      // Durable, idempotent artifact via the 0343 RPC. Exactly one row per
      // (org, 'google_drive', fileId, revisionId): a redelivered change dedupes
      // (ON CONFLICT DO NOTHING) and the RPC returns the existing id. Metadata is
      // a FIXED ids-only shape — no bytes, no digest-of-bytes beyond the
      // fingerprint column, and NO actor email / PII (§1.4 + §1.6A).
      const { data: artifactId, error: artifactError } = await (
        db as unknown as ConnectorArtifactRpcClient
      ).rpc('enqueue_connector_artifact', {
        p_org_id: input.orgId,
        p_source: DRIVE_ARTIFACT_SOURCE,
        p_external_ref: input.fileId,
        p_external_revision: input.revisionId,
        p_fingerprint_sha256: fingerprint,
        p_byte_length: byteLength,
        p_source_timestamp: input.sourceTimestamp,
        p_metadata: {
          file_id: input.fileId,
          revision_id: input.revisionId,
          integration_id: input.integrationId,
          rule_event_id: input.ruleEventId,
          mime_type: input.mimeType,
          export_mime_type: input.exportMimeType,
          content_type: input.contentType,
        },
      });

      if (artifactError || !artifactId) {
        logger.error(
          { error: artifactError, integrationId: input.integrationId },
          'Drive connector-artifact enqueue failed',
        );
        throw new Error('drive_connector_artifact_enqueue_failed');
      }

      // Audit breadcrumb — carries the artifact id + byte_length but NEVER the
      // fingerprint or bytes (§1.6A). Fail-closed so a broken audit path is
      // visible rather than silently swallowed.
      const { error: auditError } = await db
        .from('integration_events')
        .insert({
          org_id: input.orgId,
          integration_id: input.integrationId,
          provider: DRIVE_ARTIFACT_SOURCE,
          event_type: 'drive_document_fetched',
          status: 'success',
          details: {
            file_id: input.fileId,
            revision_id: input.revisionId,
            rule_event_id: input.ruleEventId,
            mime_type: input.mimeType,
            export_mime_type: input.exportMimeType,
            content_type: input.contentType,
            byte_length: byteLength,
            connector_artifact_id: artifactId,
          },
        })
        .select('id')
        .single();

      if (auditError) {
        logger.error(
          { error: auditError, integrationId: input.integrationId },
          'Drive document-fetched audit sink failed',
        );
        throw new Error('drive_document_sink_failed');
      }

      return { artifactId: String(artifactId) };
    },

    logger,
  };
}

function recordProcessedJob(
  result: DriveFileChangedJobRunResult,
  processed: { status: string; jobId?: string },
): void {
  result.claimed += 1;
  if (processed.jobId) result.jobIds.push(processed.jobId);
  const counterKey = QUEUE_STATUS_COUNTERS[processed.status as QueueStatus];
  if (counterKey) result[counterKey] += 1;
}

export async function runDriveFileChangedJobs(
  options: DriveFileChangedJobRunOptions = {},
): Promise<DriveFileChangedJobRunResult> {
  const limit = normalizeLimit(options.limit);
  const jobDeps = options.jobDeps ?? makeDriveFileChangedJobDeps(options);
  const result: DriveFileChangedJobRunResult = {
    claimed: 0,
    completed: 0,
    failed: 0,
    dead: 0,
    updateFailed: 0,
    jobIds: [],
  };

  for (let i = 0; i < limit; i++) {
    const processed = await processNextJob(DRIVE_FILE_CHANGED_JOB_TYPE, async (job) => {
      await processDriveFileChangedJob(job.payload, jobDeps);
    });
    if (!processed.claimed) break;
    recordProcessedJob(result, processed);
  }

  return result;
}
