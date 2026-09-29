/**
 * recordDisplay.ts
 *
 * Plain-language display helpers for the Record Detail page (and any other
 * surface that renders a record's title/type/size/source-modification-time).
 *
 * Founder report (2026-09-29): a Google Drive record's title rendered the raw
 * internal id (`google_drive:1IxoLk_vWeuU-BB-2Qkmvs8QmV1qi_GKnGxZF8YheIu8`),
 * the subtitle showed "0 B" for an unknown size and the raw MIME string
 * ("application/vnd.google-apps.spreadsheet") instead of a plain-language
 * type, and the Drive "Source modification time" row rendered the raw
 * `mtime:2026-09-29T20:47:10.002Z` token with its internal prefix still
 * attached. These are pure functions so the readability fixes are unit-tested
 * directly, independent of AssetDetailView's rendering.
 *
 * @see src/components/anchor/AssetDetailView.tsx
 */

import { DOCUMENT_TYPE_LABELS, RECORD_DETAIL_LABELS, CONNECTOR_SOURCE_LABELS } from './copy';

// ─── Title ────────────────────────────────────────────────────────────────

// An opaque connector id: `<provider>:<opaque-token>`, no whitespace or
// periods. A real human filename virtually always has a space or an
// extension; this shape is what the worker connector pipeline writes into
// `anchors.filename` for a record it fetched by internal id rather than by
// a chosen name (e.g. Google Drive's own file id).
const CONNECTOR_INTERNAL_ID_RE = /^([a-z][a-z0-9_]*):([A-Za-z0-9_-]+)$/;

/**
 * True when `filename` looks like a connector-internal opaque id rather than
 * a human-chosen file name. When `connectorSource` is provided (e.g. from
 * `metadata.connector_source`), the id's own prefix must match it exactly —
 * a mismatch means the shape is coincidental, not a known connector's id.
 */
export function looksLikeConnectorInternalId(
  filename: string | null | undefined,
  connectorSource?: string | null,
): boolean {
  if (!filename) return false;
  const trimmed = filename.trim();
  if (!trimmed || /\s/.test(filename)) return false;
  const match = CONNECTOR_INTERNAL_ID_RE.exec(trimmed);
  if (!match) return false;
  if (connectorSource && match[1] !== connectorSource) return false;
  return true;
}

function lastPathSegment(path: string): string | null {
  const trimmed = path.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  const segments = trimmed.split('/').filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : null;
}

/**
 * Derive a human-readable title for a record.
 *
 * Non-connector filenames pass through completely unchanged — this function
 * must never regress the common case. Only a filename that
 * `looksLikeConnectorInternalId` is ever replaced, and only with either the
 * last segment of the Drive folder path (which, per the connector pipeline,
 * ends in the file's real name) or — when no path is available — a generic
 * label. The raw id is never returned.
 */
export function deriveDisplayTitle(
  filename: string,
  metadata: Record<string, unknown> | null | undefined,
): string {
  const connectorSource = typeof metadata?.connector_source === 'string' ? metadata.connector_source : undefined;
  if (!looksLikeConnectorInternalId(filename, connectorSource)) return filename;

  const folderPath = metadata?._drive_folder_path;
  if (typeof folderPath === 'string') {
    const segment = lastPathSegment(folderPath);
    if (segment) return segment;
  }
  return RECORD_DETAIL_LABELS.UNTITLED_DOCUMENT_TITLE;
}

// ─── Type ─────────────────────────────────────────────────────────────────

type DocumentTypeKey = keyof typeof DOCUMENT_TYPE_LABELS;

const MIME_TYPE_MAP: Readonly<Record<string, DocumentTypeKey>> = {
  'application/pdf': 'PDF',
  'application/vnd.google-apps.spreadsheet': 'SPREADSHEET',
  'text/csv': 'SPREADSHEET',
  'application/vnd.ms-excel': 'SPREADSHEET',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'SPREADSHEET',
  'application/vnd.google-apps.document': 'DOCUMENT',
  'application/msword': 'DOCUMENT',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCUMENT',
  'application/vnd.oasis.opendocument.text': 'DOCUMENT',
  'application/vnd.google-apps.presentation': 'PRESENTATION',
  'application/vnd.ms-powerpoint': 'PRESENTATION',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PRESENTATION',
  'text/plain': 'TEXT',
};

/**
 * Map a MIME type to a plain-language document type (Spreadsheet/Document/
 * PDF/...). Falls back to `metadata.content_type` / `metadata.export_mime_type`
 * when `fileMime` itself is absent, and returns `null` — never a guess — for
 * anything unrecognized, so the caller can fall back to the raw MIME string.
 */
export function deriveDisplayType(
  fileMime: string | null | undefined,
  metadata?: Record<string, unknown> | null,
): string | null {
  const candidates = [fileMime, metadata?.content_type, metadata?.export_mime_type].filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );

  for (const candidate of candidates) {
    const normalized = candidate.split(';')[0].trim().toLowerCase();
    if (normalized.startsWith('image/')) return DOCUMENT_TYPE_LABELS.IMAGE;
    const key = MIME_TYPE_MAP[normalized];
    if (key) return DOCUMENT_TYPE_LABELS[key];
  }
  return null;
}

// ─── Size ─────────────────────────────────────────────────────────────────

/**
 * Format a byte count for display, or `null` when the size is unknown.
 * A record whose size was never recorded stores `0` (or omits the column
 * entirely) — showing "0 B" states something false (the file is not zero
 * bytes; the size simply was not captured), so this returns `null` and the
 * caller omits the size from the subtitle rather than printing it.
 */
export function formatDisplayFileSize(bytes: number | null | undefined): string | null {
  if (!bytes || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Connector internal metadata (shared denylist) ─────────────────────────
//
// Founder report (2026-09-29, dashboard follow-up): a connector record's
// CARD on `/dashboard` / `/records` rendered every one of these ten raw
// identifiers, because the card's metadata filter was an allow-everything
// list (deny only a handful of unrelated keys) rather than naming the
// connector fields explicitly. This is the SINGLE list every list/card
// surface filters against — `src/components/records/RecordsList.tsx` and any
// sibling list — so a new connector cannot reintroduce the same leak in a
// second place with a slightly different set.
export const CONNECTOR_INTERNAL_METADATA_KEYS: readonly string[] = [
  'file_id',
  'mime_type',
  'revision_id',
  'content_type',
  'external_ref',
  'rule_event_id',
  'integration_id',
  'connector_source',
  'export_mime_type',
  'connector_artifact_id',
];

/** Plain-language label for a known connector source marker, or `null`. */
export function deriveConnectorSourceLabel(connectorSource: unknown): string | null {
  if (typeof connectorSource !== 'string') return null;
  return (CONNECTOR_SOURCE_LABELS as Record<string, string>)[connectorSource] ?? null;
}

// ─── Source modification time ──────────────────────────────────────────────

const TIME_TOKEN_PREFIX_RE = /^(mtime|evt):/;
// The leading ISO-8601 portion of a token — an `evt:` token carries a
// trailing `:<id>` suffix after the timestamp, which is not part of the time.
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/;

/** Strip a known internal time-token prefix (`mtime:`/`evt:`). Anything else is returned unchanged. */
export function stripSourceModifiedTimePrefix(raw: string): string {
  return raw.replace(TIME_TOKEN_PREFIX_RE, '');
}

/**
 * Format a Drive "source modification time" value (e.g.
 * `mtime:2026-09-29T20:47:10.002Z`) as a locale date/time string, with the
 * internal prefix removed.
 *
 * §1.5 — if the stripped value does not parse as an ISO-8601 timestamp, it is
 * NOT reformatted or claimed to be a time; the stripped (prefix-removed) text
 * is returned as-is, so the page never presents an invented date.
 */
export function formatSourceModifiedTime(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const stripped = stripSourceModifiedTimePrefix(raw.trim());
  if (!stripped) return null;

  const isoMatch = ISO_DATETIME_RE.exec(stripped);
  if (isoMatch) {
    const parsed = new Date(isoMatch[0]);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toLocaleString();
    }
  }
  return stripped;
}
