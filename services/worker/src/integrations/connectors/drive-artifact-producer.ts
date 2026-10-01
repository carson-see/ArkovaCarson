/**
 * Google Drive connector-artifact producer (SCRUM-2903 / GD-PROD).
 *
 * THE GAP THIS CLOSES
 * -------------------
 * Until now the Google Drive integration only *detected* changes: a webhook
 * push woke `drive-changes-runner.ts`, which walked `changes.list` and enqueued
 * a fingerprint-LESS `WORKSPACE_FILE_MODIFIED` rule event. That rule event feeds
 * the rules engine, but it never fetched the document, never computed a
 * fingerprint, and never wrote a `connector_artifact` row — so a Drive document
 * had NO path to anchoring. Drive was change-aware but anchor-blind.
 *
 * This module is the missing producer bridge, the Drive analog of
 * `processDocusignEnvelopeCompletedJob`:
 *
 *   Drive change → fetch bytes (connector-authorized, §1.6A) → SHA-256 in
 *   memory → DISCARD bytes → enqueue a `connector_artifact` row (source
 *   'google_drive') carrying only the fingerprint + PII-scrubbed metadata, for
 *   the existing drain (`connector-artifact-drain.ts`) to materialize + anchor.
 *
 * §1.6A DISCIPLINE (the governing rule — VOID if any clause is broken)
 * -------------------------------------------------------------------
 * Connector-fetched bytes are the narrow server-side-fingerprint carve-out to
 * §1.6, permitted ONLY because the document originates from a third-party cloud
 * the org already authorized and there is no client device in the loop. The
 * bytes are fetched → hashed → discarded in one synchronous scope. They are
 * NEVER persisted to Postgres, written to logs, sent to Sentry, stored in
 * `job_queue.last_error`, embedded in an Error, or spooled to a temp file. Only
 * `fingerprint_sha256` + `byte_length` + bounded, PII-scrubbed metadata leave
 * this module.
 *
 * Pure orchestrator: the access-token resolver, the byte-fetch, and the artifact
 * sink are all injected so tests prove the byte-discard invariant without any
 * real network, KMS, or DB.
 */
import { z } from 'zod';
import { dbUuid } from '../../utils/db-row-validation.js';

import { GOOGLE_DRIVE_VENDOR } from '../../constants/connectors.js';

/**
 * job_queue `type` for the Drive file-changed job. Single source of truth —
 * both the producer side (`drive-changes-runner.ts`, which enqueues via
 * `submitJob`) and the consumer side (`jobs/drive-file-changed.ts`, which
 * drains via `processNextJob`) import this constant rather than each owning
 * their own string literal, so the two ends can never drift apart.
 */
export const DRIVE_FILE_CHANGED_JOB_TYPE = 'google_drive.file_changed' as const;

/**
 * Payload of a `google_drive.file_changed` job — the durable hand-off the Drive
 * changes runner writes once a change matches a watched folder. Carries only
 * connector-native identifiers + PII-safe context; NEVER document bytes.
 *
 * `revision_id` is the Drive `headRevisionId` at detection time; it becomes the
 * artifact's `external_revision` so a re-edit of the same file enqueues a fresh
 * artifact while a redelivery of the SAME revision dedupes (0343 RPC idempotency
 * key = org_id / source / external_ref / COALESCE(external_revision,'')).
 */
/**
 * SCRUM-4507: which token `revision_id` actually IS, for this change.
 *
 * `revision_id` is NOT always a Drive revision. Workspace-native files
 * (Docs/Sheets/Slides) expose no `headRevisionId`, so the changes processor
 * falls back to a synthetic `mtime:<modifiedTime>` token, and a change with
 * neither falls back again to `evt:<time>:<fileId>`. Both fallbacks are
 * load-bearing for the 0343 dedupe key and must not change — but a surface
 * that renders the value has to know which of the three it is holding, or it
 * will label a modification time as a document revision (§1.5: state what was
 * actually measured).
 *
 * ONE vocabulary, declared here because this module already owns the job
 * payload contract. The processor imports the TYPE from here and the record
 * page switches on the value, so a new fallback branch has to land in this
 * array before anything downstream can emit it.
 */
export const DRIVE_REVISION_KINDS = ['head_revision', 'modified_time', 'event_time'] as const;

export type DriveRevisionKind = (typeof DRIVE_REVISION_KINDS)[number];

export const DriveFileChangedJobPayload = z.object({
  org_id: dbUuid('org_id'),
  integration_id: dbUuid('integration_id'),
  file_id: z.string().min(1),
  // Drive headRevisionId at detection. Optional: some change entries (e.g. a
  // shortcut) have no head revision — the artifact then dedupes on file_id alone.
  revision_id: z.string().min(1).optional(),
  // Source mime type from changes.list — selects media vs export transport and
  // is recorded in metadata. Optional (older enqueuers may omit it).
  mime_type: z.string().min(1).optional(),
  // Drive-reported modification time → connector_artifact.source_timestamp.
  modified_time: z.string().datetime().optional(),
  // The rule event that produced this job, for audit cross-reference.
  rule_event_id: z.string().min(1).optional(),
  // ── SCRUM-4507 source link-back ───────────────────────────────────────────
  // All four are `.optional()` ON PURPOSE, and that is not cosmetic: jobs
  // enqueued before this change are already sitting in `job_queue` with a
  // payload that has none of them. A required field here would fail `parse` on
  // every one of those rows' next attempt and stall the Drive fetch pipeline
  // behind a backlog it could never drain.
  //
  // Shared-drive id for a file that lives on a Shared Drive (`change.file.driveId`);
  // absent for My Drive. Already fetched by `listChanges`' field mask — it was
  // parsed and then dropped before this change.
  shared_drive_id: z.string().min(1).optional(),
  // The file's FIRST parent folder id — the same array the watched-folder
  // match runs over.
  folder_id: z.string().min(1).optional(),
  // Human folder path resolved by drive-folder-resolver.ts (e.g. `/HR/2026-Q2`).
  // Present only when a resolver was wired and the walk succeeded.
  folder_path: z.string().min(1).optional(),
  revision_kind: z.enum(DRIVE_REVISION_KINDS).optional(),
  // BUG-2026-09-29: the Drive file's human name (`changes.list` `file.name`),
  // already resolved by the changes processor and forwarded to
  // `enqueueRuleEvent`'s `filename` — this job payload dropped it, so the
  // eventual anchor's display name fell back to the synthetic
  // `google_drive:<fileId>` label (jobs/connector-artifact-drain.ts). An
  // opaque display label, not PII — no email/account identifier.
  // `.optional()` for the same backward-compat reason as the four fields
  // above: jobs enqueued before this change have no `filename` key.
  filename: z.string().min(1).optional(),
});

export type DriveFileChangedJobPayloadT = z.infer<typeof DriveFileChangedJobPayload>;

export function parseDriveFileChangedJobPayload(payload: unknown): DriveFileChangedJobPayloadT {
  return DriveFileChangedJobPayload.parse(payload);
}

/**
 * Bytes fetched from Drive plus the transport metadata. `bytes` lives only for
 * the synchronous span between fetch and hash — the sink hashes and drops it.
 */
export interface DriveFetchedDocument {
  bytes: Buffer;
  contentType: string | null;
  /** Non-null when the source was a Google-native doc rendered via export. */
  exportMimeType: string | null;
}

export interface DriveArtifactSinkResult {
  /** connector_artifact.id (stable across redelivery via 0343 dedupe). */
  artifactId: string;
}

export interface DriveArtifactProducerDeps {
  /**
   * Resolve a live Drive access token for the integration. Production wires this
   * to `loadDriveAccessToken` (decrypt → refresh → persist); tests stub it.
   */
  resolveAccessToken: (args: {
    orgId: string;
    integrationId: string;
  }) => Promise<{ accessToken: string }>;
  /**
   * Fetch the document bytes. Production wires this to `fetchDriveFileBytes`.
   * §1.6A: the returned bytes are hashed then discarded by the sink.
   */
  fetchDocument: (args: {
    fileId: string;
    accessToken: string;
    mimeType?: string | null;
  }) => Promise<DriveFetchedDocument>;
  /**
   * Persist the fingerprint + PII-scrubbed metadata as a connector_artifact.
   * Production wires this to the SHA-256 + `enqueue_connector_artifact` sink in
   * `jobs/drive-file-changed.ts`. It receives the raw bytes so the digest is
   * computed at the last possible moment, inside the sink, and never re-exposed.
   */
  enqueueArtifact: (input: {
    orgId: string;
    integrationId: string;
    fileId: string;
    revisionId: string | null;
    documentBytes: Buffer;
    contentType: string | null;
    exportMimeType: string | null;
    mimeType: string | null;
    sourceTimestamp: string | null;
    ruleEventId: string | null;
    /**
     * SCRUM-4507 source link-back. REQUIRED and `| null` rather than optional:
     * the sink writes each of these as an explicit `null` when absent, so an
     * omitted key here would become a silently missing metadata key instead of
     * a recorded "not available". `processDriveFileChangedJob` is the only
     * production caller and always supplies all four.
     */
    sharedDriveId: string | null;
    folderId: string | null;
    folderPath: string | null;
    revisionKind: DriveRevisionKind | null;
    /**
     * BUG-2026-09-29: the Drive file's human name. REQUIRED and `| null`,
     * same convention as the four fields above — `processDriveFileChangedJob`
     * is the only production caller and always supplies it (`?? null`).
     */
    filename: string | null;
  }) => Promise<DriveArtifactSinkResult>;
  /**
   * Whether the connector-artifact enqueue is enabled
   * (`ENABLE_CONNECTOR_ARTIFACT_ENQUEUE`). Optional so existing test doubles
   * keep working — when absent the sink's own guard still applies. Supplying it
   * lets the producer skip the token resolve + byte fetch entirely.
   */
  isEnqueueEnabled?: () => boolean;
  logger?: {
    info: (...a: unknown[]) => void;
    warn: (...a: unknown[]) => void;
    error: (...a: unknown[]) => void;
  };
}

/**
 * Sentinel artifact id returned when the enqueue is flag-disabled. Lives here
 * (the lower-level module) so the producer and the job wiring cannot drift.
 */
export const CONNECTOR_ARTIFACT_ENQUEUE_DISABLED_ID = 'connector_artifact_enqueue_disabled';

/**
 * Process one Drive file-changed job: resolve token → fetch bytes → hand to the
 * artifact sink (which hashes + enqueues). The bytes never escape this call.
 *
 * The vendor constant is asserted here so a copy-paste into another connector
 * can't silently mislabel the artifact source.
 */
export async function processDriveFileChangedJob(
  payload: unknown,
  deps: DriveArtifactProducerDeps,
): Promise<DriveArtifactSinkResult> {
  const parsed = parseDriveFileChangedJobPayload(payload);

  // Flag check BEFORE any token resolve or byte fetch. The sink also checks it
  // (it owns the write), but checking only there meant a disabled connector
  // still: decrypted a KMS-wrapped token, called the Drive API, and buffered the
  // whole document into a 2 GiB container — every 5 minutes, for every changed
  // file — purely to throw the bytes away. Short-circuiting here spends nothing.
  //
  // KNOWN LIMITATION (unchanged by this fix, flagged for a product decision):
  // the job is still marked complete and the drive_revision_ledger row still
  // stands, so a change skipped while the flag is off is NOT replayed when the
  // flag is turned on — there is no backlog to drain. If the intent is
  // "accumulate while disabled, drain on enable", the job must be left pending
  // (or re-scheduled) rather than completed.
  if (deps.isEnqueueEnabled?.() === false) {
    deps.logger?.info?.(
      { integrationId: parsed.integration_id },
      'Drive file-changed skipped before fetch — ENABLE_CONNECTOR_ARTIFACT_ENQUEUE disabled',
    );
    return { artifactId: CONNECTOR_ARTIFACT_ENQUEUE_DISABLED_ID };
  }

  const { accessToken } = await deps.resolveAccessToken({
    orgId: parsed.org_id,
    integrationId: parsed.integration_id,
  });

  const document = await deps.fetchDocument({
    fileId: parsed.file_id,
    accessToken,
    mimeType: parsed.mime_type ?? null,
  });

  // Hand the bytes straight to the sink. We deliberately do NOT log the byte
  // length or any digest here — the sink owns the single point where the digest
  // is computed and the metadata is shaped, so there is exactly one place bytes
  // are touched (§1.6A: minimize the byte-handling surface).
  return deps.enqueueArtifact({
    orgId: parsed.org_id,
    integrationId: parsed.integration_id,
    fileId: parsed.file_id,
    revisionId: parsed.revision_id ?? null,
    documentBytes: document.bytes,
    contentType: document.contentType,
    exportMimeType: document.exportMimeType,
    mimeType: parsed.mime_type ?? null,
    sourceTimestamp: parsed.modified_time ?? null,
    ruleEventId: parsed.rule_event_id ?? null,
    // SCRUM-4507: undefined -> null at this one boundary, matching how every
    // other optional payload field above crosses into the sink.
    sharedDriveId: parsed.shared_drive_id ?? null,
    folderId: parsed.folder_id ?? null,
    folderPath: parsed.folder_path ?? null,
    revisionKind: parsed.revision_kind ?? null,
    // BUG-2026-09-29: undefined -> null at this same boundary.
    filename: parsed.filename ?? null,
  });
}

/** Exported for the job wiring so the source label has one owner. */
export const DRIVE_ARTIFACT_SOURCE = GOOGLE_DRIVE_VENDOR;
