/**
 * Google Drive Record Source Links (SCRUM-4507, frontend-targeted T2)
 *
 * Authenticated record-detail page ONLY — the public verification page and the
 * anonymous `GET /api/v1/verify/:publicId` response are explicitly out of
 * scope for this module and must never import it. A Drive identifier on an
 * anonymous surface would let any holder of a public record id probe the
 * source system for that object, and open it outright if the file is
 * link-shared. Those identifiers belong to the record owner, not to a
 * verifier.
 *
 * Turns the Drive identifiers already on an anchor's metadata (`file_id`, and
 * the server-stamped `_drive_folder_id` / `_drive_shared_drive_id`) into deep
 * links back into Drive, so a record owner can jump to the source file.
 *
 * SECURITY — the property this module leans on, and it is a different one from
 * `docusignLinks.ts`. DocuSign ids are UUIDs, so that module validates a
 * SHAPE. Drive ids are opaque URL-safe base64-ish tokens with no fixed length
 * or layout, so there is no shape to validate; what is validated instead is
 * the CHARACTER CLASS. `[A-Za-z0-9_-]` contains no `:`, no `/`, no `.`, no
 * `%`, no whitespace and no `?`/`#`. That single fact is what makes every
 * injection class unreachable BY CONSTRUCTION rather than by downstream
 * sanitization:
 *
 *   - `javascript:` / `data:` — need a colon.
 *   - `../` and `%2e%2e%2f` traversal — need a dot or a percent.
 *   - `https://evil.example.com` and protocol-relative `//evil` — need both.
 *   - query/fragment smuggling (`?redirect=`, `#`) — need `?` or `#`.
 *   - header/CRLF injection — needs a control character.
 *
 * A value that is not a Drive id NEVER reaches the template literal that
 * builds the URL: every builder calls {@link isDriveId} first and returns
 * `null` — never a partially-built or best-effort URL — the moment it fails.
 *
 * The two bases are fixed constants. Unlike DocuSign there is no `env`
 * parameter and no environment split: Drive has exactly one console, so a
 * selector here would be a knob with nothing behind it AND a second place a
 * metadata value could influence an origin. There is no code path from
 * metadata to a base URL in this module.
 *
 * NOT PROVIDED, deliberately: a revision deep link. The stored revision is not
 * always a Drive revision id — for Workspace-native files the producer stores
 * a synthetic `mtime:`/`evt:` token (see `_drive_revision_kind`) — and the URL
 * shape for a real Drive revision has not been verified against the live
 * product. A link that is right for some records and 404s for others is worse
 * than plain text, so the revision renders as text only.
 */

/**
 * The character class Drive uses for file, folder and shared-drive ids:
 * URL-safe base64 alphabet, no padding. Anchored at both ends — no partial
 * match, no leading or trailing whitespace.
 *
 * The 10-character floor is a sanity bound, not a security control (the
 * character class is the security control). Real Drive ids run ~19 characters
 * for a shared drive and ~33-44 for a file; 10 rejects obviously-wrong short
 * values without risking a false rejection of a legitimate id whose length
 * Google has never documented as fixed.
 */
const DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,}$/;

/** Fixed Drive origins. Never derived from metadata or any other input. */
const DRIVE_FILE_BASE = 'https://drive.google.com/file/d';
const DRIVE_FOLDER_BASE = 'https://drive.google.com/drive/folders';

/**
 * True only for a string matching {@link DRIVE_ID_RE} exactly. A TypeScript
 * type guard so callers narrow `unknown` metadata straight to `string`. Every
 * builder below calls this FIRST — the single choke point every candidate
 * value must pass through.
 */
export function isDriveId(value: unknown): value is string {
  return typeof value === 'string' && DRIVE_ID_RE.test(value);
}

/**
 * Deep link to a Drive file's viewer.
 * `null` when `fileId` is not a Drive id — the ONLY way this can fail.
 */
export function fileUrl(fileId: unknown): string | null {
  if (!isDriveId(fileId)) return null;
  // encodeURIComponent is defence-in-depth, not load-bearing: isDriveId has
  // already constrained the value to [A-Za-z0-9_-], none of which this
  // function alters. It stays so that a future widening of the character
  // class cannot silently become a URL-injection bug.
  return `${DRIVE_FILE_BASE}/${encodeURIComponent(fileId)}/view`;
}

/**
 * Deep link to a Drive folder.
 * `null` when `folderId` is not a Drive id.
 */
export function folderUrl(folderId: unknown): string | null {
  if (!isDriveId(folderId)) return null;
  return `${DRIVE_FOLDER_BASE}/${encodeURIComponent(folderId)}`;
}

/**
 * Deep link to a Shared Drive's root.
 *
 * Intentionally the SAME `/drive/folders/` base as {@link folderUrl}: Drive
 * addresses a shared drive's root by its drive id through that route, so a
 * separate base would be a second constant asserting the same fact. The
 * distinct function exists because the two ids come from different metadata
 * keys and are labelled differently in the UI, not because the URL differs.
 */
export function sharedDriveUrl(sharedDriveId: unknown): string | null {
  return folderUrl(sharedDriveId);
}
