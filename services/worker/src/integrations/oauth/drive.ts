/**
 * Google Drive OAuth + push notifications (SCRUM-1099)
 *
 * Minimal, dependency-free client for the two Drive APIs Arkova needs:
 *
 *   1. OAuth token exchange (authorization_code + refresh flows)
 *   2. files.watch / changes.watch push notifications (7-day channel)
 *   3. channels.stop + token revoke for disconnect cleanup
 *   4. files.get(parents, name) for the folder-path resolver
 *
 * Every function takes a fetch impl so tests stub without touching the
 * real network. Scopes are intentionally limited to Drive file access plus
 * Drive Activity read-only visibility; refresh tokens are stored by the
 * connector service in Secret Manager, not Postgres.
 *
 * Constitution refs:
 *   - 1.4: no hardcoded secrets; client ID + secret from env.
 *   - 1.4: access tokens never logged.
 */
import { z } from 'zod';
import { boundedErrorDetail } from '../../utils/byte-safety.js';

const DRIVE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_OAUTH_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';

export const DRIVE_DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.activity.readonly',
];

const OAuthTokenResponse = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

export interface DriveClientDeps {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

export class DriveConfigError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'DriveConfigError';
  }
}

/**
 * Google Drive API error.
 *
 * SCRUM-2492 (§1.6A): never carries a raw response BODY — it has NO `body`
 * field, so a raw (potentially document-bearing) Drive response can never be
 * captured on the error and leak through a logger / Sentry / `last_error`.
 *
 * The optional `detail` is a BOUNDED, byte-safe, PII-scrubbed string built BY
 * CONSTRUCTION via {@link boundedErrorDetail} — capped at ~500 chars, byte-runs
 * and binary containers collapse to a redaction token, and email/UUID/JWT/token
 * PII is scrubbed. It restores connector-ops debuggability on the NON-document
 * Drive paths (token exchange/refresh, startPageToken, changes.watch,
 * channels.stop, token revoke, files.get metadata, changes.list) whose error
 * body is safe Google API error JSON (e.g. `{ "error": { "message": "..." } }`).
 * The ONE document-fetch helper — {@link fetchDriveFileBytes} (SCRUM-2903) —
 * constructs this error with status + message only (NO detail), because its
 * error body can itself carry document bytes.
 */
export class DriveApiError extends Error {
  status: number;
  /** Bounded (~500 char), byte-safe, PII-scrubbed; never a raw document-fetch body. */
  detail?: string;
  constructor(msg: string, status: number, detail?: string) {
    super(msg);
    this.name = 'DriveApiError';
    this.status = status;
    if (detail !== undefined) this.detail = detail;
  }
}

/**
 * Hard ceiling on a single connector-fetched Drive document.
 *
 * 64 MiB is ~13x the repo's 5 MiB `safe-fetch` default, chosen to comfortably
 * clear real credential documents (scanned multi-page PDFs, Docs exported to
 * DOCX) while staying an order of magnitude below the worker's 2 GiB container
 * so a handful of concurrent jobs cannot collectively exhaust it.
 */
export const MAX_DRIVE_DOCUMENT_BYTES = 64 * 1024 * 1024;

/**
 * A watched-folder document exceeded MAX_DRIVE_DOCUMENT_BYTES.
 *
 * Carries ONLY a byte count — never a body, a buffer, or a filename (§1.6A).
 * Distinct from DriveApiError so the job layer can dead-letter it as a
 * permanent, non-retryable outcome: retrying cannot make the file smaller.
 */
export class DriveDocumentTooLargeError extends Error {
  readonly byteLength: number;
  readonly limit = MAX_DRIVE_DOCUMENT_BYTES;
  constructor(byteLength: number) {
    super(
      `Drive document exceeds the ${MAX_DRIVE_DOCUMENT_BYTES}-byte connector limit`,
    );
    this.name = 'DriveDocumentTooLargeError';
    this.byteLength = byteLength;
  }
}

function requireClient(env: NodeJS.ProcessEnv): { clientId: string; clientSecret: string } {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new DriveConfigError(
      'GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET not set — provision in Secret Manager before connecting Drive.',
    );
  }
  return { clientId, clientSecret };
}

/**
 * Build the consent URL that Arkova redirects to. The admin approves the
 * scopes in Google's UI and is redirected back to `redirectUri` with a
 * `code` parameter that the callback handler exchanges for tokens.
 */
export function buildAuthorizationUrl(args: {
  redirectUri: string;
  state: string;
  scopes?: string[];
  env?: NodeJS.ProcessEnv;
}): string {
  const env = args.env ?? process.env;
  const { clientId } = requireClient(env);
  const scopes = (args.scopes ?? DRIVE_DEFAULT_SCOPES).join(' ');
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: args.redirectUri,
    response_type: 'code',
    scope: scopes,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: args.state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/** Exchange an authorization_code for tokens. */
export async function exchangeCode(args: {
  code: string;
  redirectUri: string;
  deps?: DriveClientDeps;
}): Promise<z.infer<typeof OAuthTokenResponse>> {
  const env = args.deps?.env ?? process.env;
  const fetchImpl = args.deps?.fetchImpl ?? fetch;
  const { clientId, clientSecret } = requireClient(env);

  const body = new URLSearchParams({
    code: args.code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: args.redirectUri,
    grant_type: 'authorization_code',
  });

  const res = await fetchImpl(DRIVE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    // Non-document path: Google token endpoint returns safe OAuth error JSON.
    throw new DriveApiError('Drive token exchange failed', res.status, boundedErrorDetail(json));
  }
  return OAuthTokenResponse.parse(json);
}

/** Refresh an access token using a long-lived refresh_token. */
export async function refreshAccessToken(args: {
  refreshToken: string;
  deps?: DriveClientDeps;
}): Promise<z.infer<typeof OAuthTokenResponse>> {
  const env = args.deps?.env ?? process.env;
  const fetchImpl = args.deps?.fetchImpl ?? fetch;
  const { clientId, clientSecret } = requireClient(env);

  const body = new URLSearchParams({
    refresh_token: args.refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
  });

  const res = await fetchImpl(DRIVE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    // Non-document path: Google token refresh returns safe OAuth error JSON.
    throw new DriveApiError('Drive token refresh failed', res.status, boundedErrorDetail(json));
  }
  return OAuthTokenResponse.parse(json);
}

/**
 * Register a Drive push-notification channel. Drive will POST file-change
 * events to `address`. Channels expire after 7 days; renew before then via
 * the integration-subscription-renewal cron.
 */
export async function createChangesWatch(args: {
  accessToken: string;
  channelId: string;
  address: string;
  token?: string;
  deps?: DriveClientDeps;
  // DRIVE-02 (SCRUM-2367): the folder id being watched, so a shared-drive folder
  // scopes its changes.watch to the correct corpus. Optional to preserve the
  // existing My-Drive callers' behavior.
  driveId?: string;
}): Promise<{ resourceId: string; expiration: string; startPageToken: string }> {
  const fetchImpl = args.deps?.fetchImpl ?? fetch;
  // Drive requires a startPageToken to watch changes. For a shared-drive corpus
  // the token must be scoped to that drive.
  const startTokenQuery = args.driveId
    ? `?driveId=${encodeURIComponent(args.driveId)}&supportsAllDrives=true`
    : '';
  const startRes = await fetchImpl(`${DRIVE_API_BASE}/changes/startPageToken${startTokenQuery}`, {
    headers: { Authorization: `Bearer ${args.accessToken}` },
  });
  const startJson = (await startRes.json().catch(() => null)) as { startPageToken?: string } | null;
  if (!startRes.ok || !startJson?.startPageToken) {
    // Non-document path: changes/startPageToken returns small API JSON.
    throw new DriveApiError('Drive startPageToken failed', startRes.status, boundedErrorDetail(startJson));
  }

  const watchBody = {
    id: args.channelId,
    type: 'web_hook',
    address: args.address,
    token: args.token,
  };

  const watchQuery = args.driveId
    ? `&driveId=${encodeURIComponent(args.driveId)}&supportsAllDrives=true&includeItemsFromAllDrives=true`
    : '';
  const res = await fetchImpl(
    `${DRIVE_API_BASE}/changes/watch?pageToken=${encodeURIComponent(startJson.startPageToken)}${watchQuery}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(watchBody),
    },
  );
  const json = (await res.json().catch(() => null)) as {
    resourceId?: string;
    expiration?: string;
  } | null;
  if (!res.ok || !json?.resourceId) {
    // Non-document path: changes.watch returns small channel/API JSON.
    throw new DriveApiError('Drive changes.watch failed', res.status, boundedErrorDetail(json));
  }
  // Drive expiration is a Unix ms string — normalise to ISO for Postgres.
  const expirationIso = json.expiration
    ? new Date(Number(json.expiration)).toISOString()
    : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  // DRIVE-02: expose the startPageToken so the bootstrap can persist it as the
  // watch's initial_page_token (the durable resume anchor).
  return { resourceId: json.resourceId, expiration: expirationIso, startPageToken: startJson.startPageToken };
}

/** Stop an active Drive push-notification channel during renewal/disconnect. */
export async function stopDriveChannel(args: {
  accessToken: string;
  channelId: string;
  resourceId: string;
  deps?: DriveClientDeps;
}): Promise<void> {
  const fetchImpl = args.deps?.fetchImpl ?? fetch;
  const res = await fetchImpl(`${DRIVE_API_BASE}/channels/stop`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      id: args.channelId,
      resourceId: args.resourceId,
    }),
  });
  if (!res.ok) {
    // Non-document path: channels.stop error body is safe Google API JSON.
    const json = await res.json().catch(() => null);
    throw new DriveApiError('Drive channels.stop failed', res.status, boundedErrorDetail(json));
  }
}

/** Revoke an OAuth access or refresh token when an admin disconnects Drive. */
export async function revokeOAuthToken(args: {
  token: string;
  deps?: DriveClientDeps;
}): Promise<void> {
  const fetchImpl = args.deps?.fetchImpl ?? fetch;
  const body = new URLSearchParams({ token: args.token });
  const res = await fetchImpl(DRIVE_OAUTH_REVOKE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    // Non-document path: token revoke error body is safe OAuth API JSON.
    const json = await res.json().catch(() => null);
    throw new DriveApiError('Drive token revoke failed', res.status, boundedErrorDetail(json));
  }
}

/** Fetch a Drive file's metadata (name + parents). Used by the folder resolver. */
export async function getFileMetadata(args: {
  fileId: string;
  accessToken: string;
  deps?: DriveClientDeps;
}): Promise<{ id: string; name: string; parents: string[]; driveId?: string }> {
  const fetchImpl = args.deps?.fetchImpl ?? fetch;
  const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(args.fileId)}?fields=id,name,parents,driveId&supportsAllDrives=true`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${args.accessToken}` },
  });
  const json = (await res.json().catch(() => null)) as {
    id?: string;
    name?: string;
    parents?: string[];
    driveId?: string;
  } | null;
  if (!res.ok || !json?.id || !json.name) {
    // Non-document path: files.get returns metadata-only JSON (fields mask =
    // id,name,parents,driveId) — no document content; bounded+scrubbed detail.
    throw new DriveApiError('Drive files.get failed', res.status, boundedErrorDetail(json));
  }
  return {
    id: json.id,
    name: json.name,
    parents: json.parents ?? [],
    driveId: json.driveId,
  };
}

// SCRUM-1650 GD-03: changes.list page response. Subset of fields actually
// consumed by the processor — kept narrow so a Drive API change in unrelated
// keys doesn't ripple into our Zod parse failures.
const ChangesListEntry = z.object({
  fileId: z.string().optional(),
  removed: z.boolean().optional(),
  changeType: z.string().optional(),
  time: z.string().optional(),
  file: z
    .object({
      id: z.string().optional(),
      name: z.string().optional(),
      parents: z.array(z.string()).optional(),
      driveId: z.string().optional(),
      modifiedTime: z.string().optional(),
      headRevisionId: z.string().optional(),
      lastModifyingUser: z
        .object({ emailAddress: z.string().optional(), displayName: z.string().optional() })
        .optional(),
      mimeType: z.string().optional(),
      trashed: z.boolean().optional(),
    })
    .optional(),
});

const ChangesListResponse = z.object({
  changes: z.array(ChangesListEntry).default([]),
  newStartPageToken: z.string().optional(),
  nextPageToken: z.string().optional(),
});

export type DriveChangesListEntry = z.infer<typeof ChangesListEntry>;
export type DriveChangesListResponseT = z.infer<typeof ChangesListResponse>;

/**
 * Walk the Drive changes feed from `pageToken` forward.
 *
 * Drive returns at most ~50 changes per page in our usage (we use the default
 * `pageSize`). Caller iterates page tokens until `nextPageToken` is absent —
 * the response then carries `newStartPageToken` which becomes the persisted
 * cursor for the next webhook delivery. This is the canonical pattern from
 * https://developers.google.com/drive/api/v3/reference/changes/list.
 *
 * The selected `fields` mask intentionally pulls only what the processor
 * needs (file id/parents/revision/actor); body bytes never traverse this
 * path per CLAUDE.md §1.6.
 */
export async function listChanges(args: {
  accessToken: string;
  pageToken: string;
  deps?: DriveClientDeps;
}): Promise<DriveChangesListResponseT> {
  const fetchImpl = args.deps?.fetchImpl ?? fetch;
  const params = new URLSearchParams({
    pageToken: args.pageToken,
    includeRemoved: 'true',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
    fields: [
      'newStartPageToken',
      'nextPageToken',
      'changes(fileId,removed,changeType,time,',
      'file(id,name,parents,driveId,modifiedTime,headRevisionId,trashed,mimeType,',
      'lastModifyingUser(emailAddress,displayName)))',
    ].join(''),
  });
  const url = `${DRIVE_API_BASE}/changes?${params.toString()}`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${args.accessToken}` },
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    // Non-document path: changes.list returns a metadata-only feed (fields mask
    // pulls file id/parents/revision/actor — no bytes); bounded+scrubbed detail.
    throw new DriveApiError('Drive changes.list failed', res.status, boundedErrorDetail(json));
  }
  return ChangesListResponse.parse(json);
}

/**
 * Google Workspace-native mime types (Docs / Sheets / Slides / …). These files
 * have NO downloadable binary of their own — `files.get?alt=media` returns 403
 * `fileNotDownloadable`. They must be pulled through `files.export`, which
 * renders the doc to a concrete export mime type (e.g. PDF). SCRUM-2903 GD-PROD.
 */
const GOOGLE_APPS_MIME_PREFIX = 'application/vnd.google-apps.';

/**
 * Default export mime types for the Google-native doc families. PDF is the
 * lossless, universally-exportable rendering for Docs/Slides/Drawings; Sheets
 * exports to PDF too (a CSV export would silently drop every tab but the first,
 * so PDF is the safe fingerprint surface). Anything not listed falls back to
 * PDF. The chosen export mime is recorded in the artifact metadata so the
 * fingerprint is reproducible.
 */
const GOOGLE_APPS_EXPORT_MIME: Record<string, string> = {
  'application/vnd.google-apps.document': 'application/pdf',
  'application/vnd.google-apps.spreadsheet': 'application/pdf',
  'application/vnd.google-apps.presentation': 'application/pdf',
  'application/vnd.google-apps.drawing': 'application/pdf',
};

/** Is this a Google Workspace-native doc (export-only, no raw binary)? */
export function isGoogleAppsMimeType(mimeType: string | null | undefined): boolean {
  return typeof mimeType === 'string' && mimeType.startsWith(GOOGLE_APPS_MIME_PREFIX);
}

/** Resolve the export mime type for a Google-native doc (defaults to PDF). */
export function resolveDriveExportMimeType(sourceMimeType: string): string {
  return GOOGLE_APPS_EXPORT_MIME[sourceMimeType] ?? 'application/pdf';
}

/**
 * Fetch a Drive file's raw bytes for server-side fingerprinting (SCRUM-2903
 * GD-PROD / §1.6A).
 *
 * This is the ONE document-bearing Drive helper. Per §1.6A the returned bytes
 * MUST be SHA-256'd in memory and then discarded by the caller — never logged,
 * persisted, attached to an Error, written to `job_queue.last_error`, or spooled
 * to a temp file. Two transport modes:
 *
 *   - Binary files (PDF, DOCX, images, …): `files.get?alt=media` streams the
 *     stored bytes verbatim.
 *   - Google Workspace-native docs (Docs/Sheets/Slides/Drawings): those have no
 *     stored binary, so we render via `files.export?mimeType=…`. The export mime
 *     is surfaced in the return so the caller records it (reproducible digest).
 *
 * §1.6A error discipline (mirrors `fetchDocusignCombinedDocument`): on a non-OK
 * response we do NOT read/attach the body — an error body on the media/export
 * path can itself carry document bytes. Status + message only; NO `detail`.
 */
export async function fetchDriveFileBytes(args: {
  fileId: string;
  accessToken: string;
  /** Source mime type from changes.list; selects media vs export transport. */
  mimeType?: string | null;
  deps?: DriveClientDeps;
}): Promise<{ bytes: Buffer; contentType: string | null; exportMimeType: string | null }> {
  const fetchImpl = args.deps?.fetchImpl ?? fetch;
  const fileId = encodeURIComponent(args.fileId);

  let url: string;
  let exportMimeType: string | null = null;
  if (isGoogleAppsMimeType(args.mimeType)) {
    exportMimeType = resolveDriveExportMimeType(args.mimeType as string);
    url = `${DRIVE_API_BASE}/files/${fileId}/export?mimeType=${encodeURIComponent(exportMimeType)}`;
  } else {
    url = `${DRIVE_API_BASE}/files/${fileId}?alt=media&supportsAllDrives=true`;
  }

  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${args.accessToken}` },
  });
  if (!res.ok) {
    // §1.6A: do NOT read/attach the response body on the document-fetch path —
    // an error response here can carry document bytes. Status + message only,
    // and deliberately NO bounded `detail` (see DriveApiError doc comment).
    throw new DriveApiError('Drive file bytes fetch failed', res.status);
  }

  // Size cap. The trigger for this fetch is "any file changed in a watched
  // folder", so the byte count is chosen by whoever can write to that folder,
  // while the worker runs in a 2 GiB Cloud Run container shared with anchoring,
  // confirmation and billing crons. An uncapped Buffer here lets one large
  // upload OOM-kill every in-flight job. Drive files go to 5 TB.
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_DRIVE_DOCUMENT_BYTES) {
    // Cheap path: reject before reading a single byte.
    throw new DriveDocumentTooLargeError(declared);
  }

  const bytes = await readCappedBody(res);
  return { bytes, contentType: res.headers.get('content-type'), exportMimeType };
}

/**
 * Read a response body, aborting as soon as it exceeds MAX_DRIVE_DOCUMENT_BYTES.
 *
 * Streams when the runtime gives us a body stream (real `fetch`), so an
 * oversized file is abandoned mid-flight and never fully materializes. Falls
 * back to `arrayBuffer()` for injected test doubles, which return small fixtures
 * and have no `body`. Either way the returned Buffer is <= the cap.
 */
async function readCappedBody(res: {
  body?: unknown;
  arrayBuffer: () => Promise<ArrayBuffer>;
}): Promise<Buffer> {
  const body = res.body as AsyncIterable<Uint8Array> | undefined;
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_DRIVE_DOCUMENT_BYTES) {
      throw new DriveDocumentTooLargeError(buf.byteLength);
    }
    return buf;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > MAX_DRIVE_DOCUMENT_BYTES) {
      // Stop pulling. Drop what we already hold so the oversized document is not
      // sitting in memory while the error propagates (§1.6A: bytes are
      // discarded, and the error below carries only a length).
      chunks.length = 0;
      throw new DriveDocumentTooLargeError(total);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

/** Get a shared drive's display name. Falls back to the ID on failure. */
export async function getSharedDriveName(args: {
  driveId: string;
  accessToken: string;
  deps?: DriveClientDeps;
}): Promise<string> {
  const fetchImpl = args.deps?.fetchImpl ?? fetch;
  const url = `${DRIVE_API_BASE}/drives/${encodeURIComponent(args.driveId)}?fields=name`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${args.accessToken}` },
  });
  const json = (await res.json().catch(() => null)) as { name?: string } | null;
  if (!res.ok || !json?.name) return args.driveId;
  return json.name;
}
