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
 * Drive currently exposes no document-fetch helper here; were one added, it
 * MUST construct this error with status + message only (no detail).
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
}): Promise<{ resourceId: string; expiration: string }> {
  const fetchImpl = args.deps?.fetchImpl ?? fetch;
  // Drive requires a startPageToken to watch changes.
  const startRes = await fetchImpl(`${DRIVE_API_BASE}/changes/startPageToken`, {
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

  const res = await fetchImpl(
    `${DRIVE_API_BASE}/changes/watch?pageToken=${encodeURIComponent(startJson.startPageToken)}`,
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
  return { resourceId: json.resourceId, expiration: expirationIso };
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
