/**
 * DRIVE-03 (SCRUM-2368) — Drive change classification, revision dedupe key, and
 * bounded/scrubbed audit payloads.
 *
 * A focused, pure companion to `drive-changes-processor.ts`. The processor owns
 * the page-walk + ledger reserve/enqueue orchestration; THIS module owns the
 * decision "does this individual change queue, and under what identity does it
 * dedupe?" plus the safe audit projection. Keeping it pure makes the S2
 * hardening cases (unsupported MIME, trashed, removed, dedupe identity, audit
 * scrubbing) exhaustively unit-testable.
 *
 * Dedupe: each (file_id, revision) queues at most once. The revision is the
 * Drive headRevisionId (binary files) or a modifiedTime surrogate (native
 * Workspace files). Retry with the same key is idempotent — the caller relies on
 * the `drive_revision_ledger` UNIQUE(integration, file, revision) to reject a
 * second enqueue.
 *
 * Audit: payloads carry ONLY bounded, non-sensitive, PII-scrubbed fields — never
 * the raw actor email, the filename, or the folder path.
 */
import { scrubString } from '../../utils/pii-scrub.js';

/** Minimal shape of a Drive changes.list entry this module reasons over. */
export interface DriveChangeLike {
  fileId?: string | null;
  time?: string | null;
  removed?: boolean;
  file?: {
    id?: string;
    name?: string;
    mimeType?: string;
    trashed?: boolean;
    parents?: string[];
    headRevisionId?: string;
    modifiedTime?: string;
    lastModifyingUser?: { emailAddress?: string };
  };
}

export type DriveChangeReason =
  | 'queued'
  | 'parent_mismatch'
  | 'removed'
  | 'trashed'
  | 'unsupported_mime'
  | 'unresolvable';

export interface DriveChangeClassification {
  action: 'queue' | 'ignore';
  reason: DriveChangeReason;
  revisionKey: string | null;
}

/**
 * Supported MIME prefixes. Binary document types (application/pdf, images,
 * office docs) and exportable native Workspace docs/sheets/slides are
 * fingerprintable; folders, shortcuts, and Drive-internal types are not.
 */
export const SUPPORTED_MIME_PREFIXES: readonly string[] = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument',
  'application/msword',
  'application/vnd.ms-',
  'text/',
  'image/',
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
];

/** MIME types that are explicitly NOT fingerprintable content. */
const UNSUPPORTED_GOOGLE_APPS = new Set<string>([
  'application/vnd.google-apps.folder',
  'application/vnd.google-apps.shortcut',
  'application/vnd.google-apps.drive-sdk',
  'application/vnd.google-apps.form',
  'application/vnd.google-apps.map',
  'application/vnd.google-apps.site',
]);

const AUDIT_FIELD_CAP = 256;

function isSupportedMime(mimeType: string | undefined): boolean {
  if (!mimeType) return false;
  if (UNSUPPORTED_GOOGLE_APPS.has(mimeType)) return false;
  return SUPPORTED_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix));
}

function parentMatches(parents: string[], watched: string[]): boolean {
  if (parents.length === 0 || watched.length === 0) return false;
  const w = new Set(watched);
  return parents.some((p) => w.has(p));
}

/**
 * The dedupe identity for a change: `${fileId}::${revision}`.
 *
 * Revision precedence: headRevisionId → `mtime:<modifiedTime>` → `evt:<time>`
 * (transient removed events). Null when nothing discriminates the revision.
 */
export function revisionKey(change: DriveChangeLike): string | null {
  const fileId = change.file?.id ?? change.fileId ?? null;
  const headRev = change.file?.headRevisionId;
  const mtime = change.file?.modifiedTime;
  let rev: string | null = null;
  if (headRev) rev = headRev;
  else if (mtime) rev = `mtime:${mtime}`;
  else if (change.time && fileId) rev = `evt:${change.time}`;
  if (!fileId || !rev) return null;
  return `${fileId}::${rev}`;
}

/**
 * Classify a single Drive change into a queue/ignore decision + dedupe key.
 * Order matters: removed/trashed are checked before MIME (a removed change may
 * have no file object at all).
 */
export function classifyDriveChange(
  change: DriveChangeLike,
  watchedFolderIds: string[],
): DriveChangeClassification {
  const key = revisionKey(change);

  if (change.removed === true) {
    return { action: 'ignore', reason: 'removed', revisionKey: key };
  }
  if (change.file?.trashed === true) {
    return { action: 'ignore', reason: 'trashed', revisionKey: key };
  }
  if (key === null) {
    return { action: 'ignore', reason: 'unresolvable', revisionKey: null };
  }
  if (!isSupportedMime(change.file?.mimeType)) {
    return { action: 'ignore', reason: 'unsupported_mime', revisionKey: key };
  }
  const parents = change.file?.parents ?? [];
  if (!parentMatches(parents, watchedFolderIds)) {
    return { action: 'ignore', reason: 'parent_mismatch', revisionKey: key };
  }
  return { action: 'queue', reason: 'queued', revisionKey: key };
}

export interface DriveChangeAudit {
  reason: DriveChangeReason;
  file_id: string | null;
  revision_id: string | null;
  mime_type: string | null;
  parent_match: boolean;
  /** PII-scrubbed actor signal (email is stripped by scrubString). */
  actor: string | null;
}

/**
 * Build a bounded, PII-scrubbed audit projection of a change. NEVER copies the
 * raw actor email, filename, or folder path verbatim — the actor email is run
 * through `scrubString` (which redacts emails) and every string field is capped.
 */
export function buildDriveChangeAudit(
  change: DriveChangeLike,
  ctx: { reason: DriveChangeReason; watched: string[] },
): DriveChangeAudit {
  const cap = (s: string | null | undefined): string | null =>
    s == null ? null : s.length > AUDIT_FIELD_CAP ? s.slice(0, AUDIT_FIELD_CAP) : s;

  const rawActor = change.file?.lastModifyingUser?.emailAddress;
  const scrubbedActor = rawActor ? cap(scrubString(rawActor)) : null;
  const key = revisionKey(change);
  const revId = key ? key.split('::').slice(1).join('::') : null;

  return {
    reason: ctx.reason,
    file_id: cap(change.file?.id ?? change.fileId ?? null),
    revision_id: cap(revId),
    mime_type: cap(change.file?.mimeType ?? null),
    parent_match: parentMatches(change.file?.parents ?? [], ctx.watched),
    actor: scrubbedActor,
  };
}
