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
export const DriveFileChangedJobPayload = z.object({
  org_id: z.string().uuid(),
  integration_id: z.string().uuid(),
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
  }) => Promise<DriveArtifactSinkResult>;
  logger?: {
    info: (...a: unknown[]) => void;
    warn: (...a: unknown[]) => void;
    error: (...a: unknown[]) => void;
  };
}

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
  });
}

/** Exported for the job wiring so the source label has one owner. */
export const DRIVE_ARTIFACT_SOURCE = GOOGLE_DRIVE_VENDOR;
