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
 * real network. Scopes are intentionally limited to Drive file access,
 * Drive Activity read-only visibility, and the non-sensitive userinfo.email
 * identity scope (see DRIVE_DEFAULT_SCOPES); the consent URL never sets
 * `include_granted_scopes`, so a connect cannot inherit unrelated scopes
 * previously granted to the OAuth client. Refresh tokens are stored by the
 * connector service in Secret Manager, not Postgres.
 *
 * Constitution refs:
 *   - 1.4: no hardcoded secrets; client ID + secret from env.
 *   - 1.4: access tokens never logged.
 */
import { z } from 'zod';
import { boundedErrorDetail } from '../../utils/byte-safety.js';
import { BodyReadTimeoutError, readJsonBounded } from '../../utils/body-read-timeout.js';

const DRIVE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_OAUTH_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';

/**
 * SECURITY — complete Google scope allowlist (FULLSOAK 2026-08 finding,
 * shared-resource register #9). Scope ↔ runtime consumer:
 *
 *   - drive.file: files.get / files.export / changes.* / channels.stop —
 *     every Drive API call in this module.
 *   - drive.activity.readonly: Drive Activity read-only visibility (the
 *     connector's declared surface; no direct Activity API caller yet).
 *   - drive.metadata.readonly (Connectors page — SPEC-CONNECTORS §2.1,
 *     "Option A"): metadata-only, cannot read file bytes. Minimum scope that
 *     makes `listChildFolders()` below return anything for an org connecting
 *     for the first time — `drive.file` alone cannot enumerate pre-existing
 *     folders (it only sees files the app created or the user handed it via
 *     the Google Picker). This is the security review that constant's own
 *     comment asks for — reviewed by the release session's /codereview pass
 *     on this PR. Widening a scope does NOT widen an existing refresh
 *     token — every connection made BEFORE this change must re-consent
 *     before the folder picker will work for it; the endpoint in
 *     `api/v1/integrations/drive-folders.ts` fails closed
 *     (`insufficient_drive_scope`) rather than silently returning `[]` for a
 *     stale grant. CTO verified on prod (read-only, 2026-09-13) that the
 *     Arkova org's own google_drive grant already includes
 *     `auth/drive` + `drive.file`, so the picker works for that org today;
 *     every OTHER org's existing connection needs the re-consent above.
 *
 *     CORRECTION (2026-09-21, independent review, SCRUM-2903 fields-mask PR
 *     follow-up — read this before trusting the paragraph above for a NEW
 *     connection): `drive.file` per-file access is granted ONLY for a file
 *     the app itself created, OR a file the user explicitly selected through
 *     Google's REAL Picker UI
 *     (https://developers.google.com/workspace/drive/picker/guides/overview)
 *     — NOT merely "a file listed via drive.metadata.readonly." Arkova's
 *     Connectors-page folder browser (`DriveFolderPicker` /
 *     `api/v1/integrations/drive-folders.ts`, this scope's actual
 *     consumer) is a CUSTOM component built on `files.list` over
 *     `drive.metadata.readonly` — it is not, and does not load, Google's
 *     Picker widget. Selecting a folder through it does NOT grant
 *     `drive.file` per-file access to that folder's contents. Practical
 *     effect: for a newly-connected org whose only grant is this scope set,
 *     `fetchDriveFileBytes()` (the byte-fetch this scope was believed to
 *     cover) will 403 (`appNotAuthorizedToFile` / `insufficientFilePermissions`
 *     / similar) on an ordinary file the folder browser showed as watchable.
 *     The Arkova org's own grant working today (verified 2026-09-13, cited
 *     above) is because that grant ALSO includes the broad `auth/drive`
 *     scope from an earlier, wider consent — not because this scope set is
 *     sufficient on its own. This PR makes that 403 LOUD and specific (see
 *     `fetchDriveFileBytes`'s doc comment and `connector-health.ts`'s
 *     `file_access_not_granted` reason) rather than fixing the scope here —
 *     the scope decision (real Picker integration vs. widening
 *     `DRIVE_DEFAULT_SCOPES`) is being made separately.
 *   - userinfo.email: the callback's account-identity lookup
 *     (drive-oauth.ts fetchGoogleIdentity → oauth2/v3/userinfo). Without an
 *     identity scope that endpoint 401s and account_id degrades to a
 *     constant, collapsing the org_integrations (org_id, provider,
 *     account_id) upsert key. Non-sensitive; returns sub + email only.
 *
 * Do NOT add scopes here without a security review — this list is exactly
 * what a leaked refresh token can reach.
 */
export const DRIVE_DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.activity.readonly',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
];

/**
 * Scopes Google may bundle onto an identity-scoped consent WITHOUT it being
 * an over-grant — `openid` carries no Drive/Gmail/Contacts data access on
 * its own, it is Google's own OIDC bookkeeping. Every OTHER scope beyond
 * `DRIVE_DEFAULT_SCOPES` is treated as excess.
 */
const DRIVE_GRANT_ALWAYS_ALLOWED_EXTRA_SCOPES = new Set(['openid']);

/**
 * SCRUM-5287 (P1 security, FULLSOAK 2026-08 register #9 follow-up): the
 * shared OAuth client this connector uses can carry scopes from an
 * UNRELATED prior consent — prod holds a 32-scope grant (full `drive`,
 * `gmail.modify`, `contacts`, …) for the one connected org today, persisted
 * because the OAuth callback wrote whatever Google returned without
 * checking it against what was actually requested. `include_granted_scopes`
 * is already never sent (see `buildAuthorizationUrl`'s doc comment), which
 * stops a NEW consent from inheriting old scopes going forward — this is
 * the other half: verifying the grant Google actually returned doesn't
 * exceed `DRIVE_DEFAULT_SCOPES` before persisting it at all.
 *
 * Returns the excess scope NAMES (empty array = grant is within bounds).
 * Never logs/returns anything else from the scope string — scope names are
 * public OAuth constants, not secrets, but the token itself never flows
 * through this function.
 */
/**
 * Google's token-exchange response echoes SOME well-known OIDC scopes back
 * as short aliases rather than the full URI that was requested (observed:
 * `email` for `.../auth/userinfo.email`; `profile` for
 * `.../auth/userinfo.profile`) — this is Google's own response shape, not
 * an over-grant. Normalize before comparing against `DRIVE_DEFAULT_SCOPES`,
 * which is always written in full-URI form.
 */
const DRIVE_GRANT_SCOPE_ALIASES: Record<string, string> = {
  email: 'https://www.googleapis.com/auth/userinfo.email',
  profile: 'https://www.googleapis.com/auth/userinfo.profile',
};

export function driveGrantExcessScopes(grantedScope: string | null | undefined): string[] {
  if (!grantedScope) return [];
  const requested = new Set(DRIVE_DEFAULT_SCOPES);
  return grantedScope
    .split(/\s+/)
    .filter(Boolean)
    .map((scope) => DRIVE_GRANT_SCOPE_ALIASES[scope] ?? scope)
    .filter((scope) => !requested.has(scope) && !DRIVE_GRANT_ALWAYS_ALLOWED_EXTRA_SCOPES.has(scope));
}

/**
 * Scopes that make `GET /api/v1/integrations/google_drive/folders` listable.
 * `drive.file` is deliberately NOT in this set — it cannot enumerate a user's
 * pre-existing folders, so a connection carrying only that scope must be
 * reported as `insufficient_drive_scope`, never silently return `[]`.
 */
export const DRIVE_FOLDER_LISTING_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
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
  /** Google's `Retry-After` response header, when present (429/5xx). */
  retryAfter?: string;
  /**
   * True when this failure is Google's "the pageToken is no longer valid"
   * signal — 410/404 always, OR a 400 whose parsed error body carries an
   * explicit `invalidPageToken`-shaped reason/message (see
   * `isInvalidPageTokenError` below; Google's issue tracker 196413673
   * documents `changes.list` returning 400 for this condition on some
   * accounts, not only 410). Computed once, at throw time, by the ONE call
   * site (`listChanges`) that still has the parsed JSON body in hand — the
   * processor's 410/404 re-bootstrap recovery reads this flag instead of
   * re-deriving Google's error shape itself. Deliberately undefined/false
   * on every OTHER DriveApiError throw site in this file; a bare 400 with no
   * matching reason (e.g. this incident's own fields-mask defect) must
   * NEVER read as an invalid-pageToken signal — see the doc comment on
   * `isInvalidPageTokenError`.
   */
  pageTokenInvalid?: true;
  constructor(msg: string, status: number, detail?: string, pageTokenInvalid?: true) {
    super(msg);
    this.name = 'DriveApiError';
    this.status = status;
    if (detail !== undefined) this.detail = detail;
    if (pageTokenInvalid) this.pageTokenInvalid = true;
  }
}

/** One entry of Google's standard `error.errors[]` array (handle-errors guide). */
interface GoogleApiErrorEntry {
  reason?: string;
  message?: string;
  location?: string;
  locationType?: string;
}

/** Google's standard JSON error envelope: `{ error: { code, message, errors: [...] } }`. */
interface GoogleApiErrorBody {
  error?: {
    code?: number;
    message?: string;
    errors?: GoogleApiErrorEntry[];
  };
}

/**
 * Does this parsed Google error body signal "the pageToken is invalid /
 * expired"? Google's own docs
 * (developers.google.com/drive/api/guides/handle-errors) confirm the
 * `error.errors[]` shape (`reason`, `message`, `location`,
 * `locationType`) but do not enumerate a token-specific reason string;
 * Google's issue tracker 196413673 reports `changes.list` returning
 * `400 invalidPageToken` for some accounts where the documented behavior
 * (`developers.google.com/drive/api/guides/manage-changes`) is a 410. This
 * SEPARATE, narrow detector recognizes that 400 shape — 410/404 are handled
 * unconditionally by the caller's own status check and never reach this
 * function.
 *
 * DELIBERATELY NARROW: must match either an explicit `invalidPageToken`
 * reason/message, or a `reason` containing "invalid" WHOSE `location` is
 * literally `pageToken`. A bare 400 with an unrelated `reason`/`location` —
 * e.g. this incident's OWN fields-mask bug, whose Google error names the
 * `fields` parameter, not `pageToken` — must NEVER match here. Matching too
 * broadly would silently convert a genuine, still-fixable bug into a
 * cursor-discarding "recovery," which is the exact failure mode this
 * detector exists to prevent, not reintroduce.
 */
export function isInvalidPageTokenError(json: unknown): boolean {
  if (json === null || typeof json !== 'object') return false;
  const err = (json as GoogleApiErrorBody).error;
  if (!err) return false;
  const topMessage = (err.message ?? '').toLowerCase();
  if (topMessage.includes('invalidpagetoken')) return true;
  const entries = Array.isArray(err.errors) ? err.errors : [];
  return entries.some((entry) => {
    const reason = (entry?.reason ?? '').toLowerCase();
    const message = (entry?.message ?? '').toLowerCase();
    const location = (entry?.location ?? '').toLowerCase();
    if (reason === 'invalidpagetoken') return true;
    if (message.includes('invalidpagetoken')) return true;
    if (reason.includes('invalid') && location === 'pagetoken') return true;
    return false;
  });
}

/**
 * Deadline for every Drive API response-body read (F-D0-5,
 * memory/feedback_bounded_body_reads.md). Matches the Adobe Sign connector.
 *
 * `AbortSignal.timeout(...)` on the REQUEST does not cover the body read that
 * follows — that is a separate await with no timer, and undici's default
 * `bodyTimeout` fires only on total silence, so a Google endpoint that sends
 * headers and then trickles parks the caller indefinitely. Two Drive readers
 * here (`refreshAccessToken`, `listChanges`) run inside `withRunLease`-held
 * cron runs, which is the exact shape that disabled SUBMITTED→SECURED
 * promotion for every tenant for 35+ minutes on 2026-08-12.
 */
export const DRIVE_BODY_READ_TIMEOUT_MS = 10_000;

/**
 * `await res.json()` with a deadline, in the shape every Drive caller wants.
 *
 * Replaces the file's former `await res.json().catch(() => null)`:
 *   - a PARKED body becomes a distinct {@link DriveApiError} 408 — bounded,
 *     and visibly different from a slow-but-alive Drive,
 *   - a malformed / non-JSON body still degrades to `null`, preserving the
 *     previous behavior at every call site (the caller's own `!res.ok` /
 *     missing-field check is what then produces the real error).
 *
 * §1.6A / §1.4: `label` is a stable OPERATION name, never a Drive URL. The
 * bounded reader embeds its `url` argument verbatim in the message it throws,
 * and that text flows to logs, Sentry and `job_queue.last_error` — a Drive URL
 * carries fileIds, driveIds and (on some paths) query-bound identifiers. The
 * 408 is likewise constructed with status + message only and NO `detail`,
 * because a parked body has by definition not been read.
 */
async function readDriveJson(
  res: { json(): Promise<unknown>; body?: { cancel?: (reason?: unknown) => Promise<unknown> } | null },
  label: string,
): Promise<unknown> {
  try {
    return await readJsonBounded(res, label, DRIVE_BODY_READ_TIMEOUT_MS);
  } catch (error) {
    if (error instanceof BodyReadTimeoutError) {
      throw new DriveApiError(`${label} response body timed out`, 408);
    }
    // Malformed / empty / non-JSON body — same degradation as the previous
    // `.catch(() => null)`.
    return null;
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

/**
 * Fix-round item 6: the SCOPE reality — `drive.file` grants per-file access
 * ONLY for a file the app created, or one selected through Google's REAL
 * Picker widget (see `DRIVE_DEFAULT_SCOPES`'s doc comment, "CORRECTION"
 * paragraph). Arkova's Connectors-page folder browser is a custom
 * `files.list` component over `drive.metadata.readonly`, NOT the Picker —
 * so for a newly-connected org, an ordinary file in a watched folder will
 * 403 here. Before this fix that landed as a bare `DriveApiError(403)`,
 * indistinguishable from any other failure and visible only in
 * `job_queue.last_error`. This class makes it a DISTINCT, recognizable
 * outcome the caller can surface loudly (`connector-health.ts`'s
 * `file_access_not_granted` reason).
 *
 * `reason` is ALWAYS one of `KNOWN_DRIVE_FILE_ACCESS_DENIED_REASONS` — a
 * short, Google-documented code — or the literal `'unknown'`. Never free
 * text from the error body: §1.6A's "never let anything from this
 * document-bearing path carry unbounded content into a log/Error" is
 * upheld even though a REASON CODE (not the body itself) is read to
 * produce it — see `extractDriveFileErrorReason`'s doc comment for why
 * that narrow read is safe.
 */
export class DriveFileAccessError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Drive file access denied: ${reason}`);
    this.name = 'DriveFileAccessError';
    this.reason = reason;
  }
}

/**
 * Fix-round item 6: `files.export` refuses to render a Workspace-native
 * document above Google's own export size limit (documented reason
 * `exportSizeLimitExceeded`, typically on a 403). Distinct from
 * `DriveDocumentTooLargeError` (Arkova's OWN `MAX_DRIVE_DOCUMENT_BYTES`
 * cap, checked via `content-length` on a SUCCESSFUL response) — this is
 * Google refusing to even START the export. Both are permanent,
 * non-retryable dead-letter outcomes for the same underlying reason ("this
 * artifact will never fit through this pipeline"), so callers should treat
 * them the same way: fail the ONE artifact, do not retry.
 */
export class DriveExportSizeLimitError extends Error {
  constructor() {
    super("Drive file export exceeds Google's export size limit");
    this.name = 'DriveExportSizeLimitError';
  }
}

/**
 * Google-documented `error.errors[].reason` codes this connector
 * distinguishes as "the grant does not cover this file" (as opposed to a
 * transient/auth/quota failure, which stays a generic `DriveApiError`).
 * https://developers.google.com/drive/api/guides/handle-errors and Drive
 * API v3 error responses observed for `files.get?alt=media` /
 * `files.export` on a file outside the app's `drive.file` grant.
 */
const KNOWN_DRIVE_FILE_ACCESS_DENIED_REASONS = new Set([
  'appNotAuthorizedToFile',
  'insufficientFilePermissions',
  'insufficientPermissions',
  'forbidden',
  'cannotDownloadAbusiveFile',
]);

/**
 * Bounded, narrow read of a `files.get`/`files.export` non-2xx response —
 * fix-round item 6. §1.6A's existing discipline for this file ("do NOT
 * read/attach the body on the document-fetch error path — it can carry
 * document bytes") is upheld by what this function DOES NOT return: it
 * extracts ONLY `error.errors[].reason`, a short Google-documented code
 * (e.g. `appNotAuthorizedToFile`), and discards everything else the moment
 * it is parsed — no `message`, no other body content ever escapes this
 * function. A 4xx on these endpoints is Google's own small JSON error
 * envelope (never partial document content — that only ever rides a 2xx),
 * but this reads no more of it than the one classification field needs,
 * bounded by the same `DRIVE_BODY_READ_TIMEOUT_MS` deadline every other
 * Drive JSON read in this file uses. Returns `null` on ANY failure to
 * parse/classify (timeout, malformed body, no matching field) — the caller
 * falls back to the pre-existing generic `DriveApiError(status)` with no
 * detail, exactly as before this fix-round.
 */
async function extractDriveFileErrorReason(res: {
  json(): Promise<unknown>;
  body?: { cancel?: (reason?: unknown) => Promise<unknown> } | null;
}): Promise<string | null> {
  try {
    const json = await readJsonBounded(res, 'Drive file bytes fetch (error classification)', DRIVE_BODY_READ_TIMEOUT_MS);
    const errors = (json as GoogleApiErrorBody | null)?.error?.errors;
    if (Array.isArray(errors)) {
      for (const entry of errors) {
        if (typeof entry?.reason === 'string') return entry.reason;
      }
    }
    return null;
  } catch {
    return null;
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
  // SECURITY: never send `include_granted_scopes` (FULLSOAK 2026-08,
  // shared-resource register #9). With it set to true, Google folds EVERY
  // scope the OAuth client was ever granted by this Google account into the
  // new grant — on the shared client a single Drive connect was observed
  // minting a 33-scope token (full drive, gmail.modify, calendar, contacts,
  // classroom.*, chat.*). Absent, the parameter defaults to false and the
  // grant is limited to the `scope` list above.
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: args.redirectUri,
    response_type: 'code',
    scope: scopes,
    access_type: 'offline',
    prompt: 'consent',
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
  const json = await readDriveJson(res, 'Drive token exchange');
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
  const json = await readDriveJson(res, 'Drive token refresh');
  if (!res.ok) {
    // Non-document path: Google token refresh returns safe OAuth error JSON.
    throw new DriveApiError('Drive token refresh failed', res.status, boundedErrorDetail(json));
  }
  return OAuthTokenResponse.parse(json);
}

/**
 * Fetch a fresh `changes.getStartPageToken` — the cursor to begin (or
 * RESTART) walking the changes feed from "now" forward. Extracted from
 * `createChangesWatch` (which calls this as its first step) so the SAME
 * logic is reusable by the 410/404 "pageToken invalid/expired" recovery path
 * in `drive-changes-processor.ts` — Google's documented recovery for an
 * expired page token is exactly this call, never a retry of `changes.list`
 * with the same stale token.
 */
export async function getStartPageToken(args: {
  accessToken: string;
  // DRIVE-02 (SCRUM-2367): scope to a shared-drive corpus when watching one.
  driveId?: string;
  deps?: DriveClientDeps;
}): Promise<string> {
  const fetchImpl = args.deps?.fetchImpl ?? fetch;
  // Fix-round item D (simplify): built with URLSearchParams, matching every
  // other query-string builder in this file — no hand-assembled `?a=b&c=d`
  // template literal to keep separately correct.
  const startTokenParams = args.driveId
    ? new URLSearchParams({ driveId: args.driveId, supportsAllDrives: 'true' })
    : undefined;
  const startTokenQuery = startTokenParams ? `?${startTokenParams.toString()}` : '';
  const startRes = await fetchImpl(`${DRIVE_API_BASE}/changes/startPageToken${startTokenQuery}`, {
    headers: { Authorization: `Bearer ${args.accessToken}` },
  });
  const startJson = (await readDriveJson(startRes, 'Drive changes.startPageToken')) as {
    startPageToken?: string;
  } | null;
  if (!startRes.ok || !startJson?.startPageToken) {
    // Non-document path: changes/startPageToken returns small API JSON.
    throw new DriveApiError('Drive startPageToken failed', startRes.status, boundedErrorDetail(startJson));
  }
  return startJson.startPageToken;
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
  const startPageToken = await getStartPageToken({
    accessToken: args.accessToken,
    driveId: args.driveId,
    deps: args.deps,
  });

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
    `${DRIVE_API_BASE}/changes/watch?pageToken=${encodeURIComponent(startPageToken)}${watchQuery}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(watchBody),
    },
  );
  const json = (await readDriveJson(res, 'Drive changes.watch')) as {
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
  return { resourceId: json.resourceId, expiration: expirationIso, startPageToken };
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
    const json = await readDriveJson(res, 'Drive channels.stop');
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
    const json = await readDriveJson(res, 'Drive token revoke');
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
  const json = (await readDriveJson(res, 'Drive files.get')) as {
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

/** One folder row returned by {@link listChildFolders}. Metadata-only. */
export interface DriveFolderEntry {
  id: string;
  name: string;
  /** Always `null` in v1 — see {@link listChildFolders} doc comment. */
  driveId: string | null;
}

export interface ListChildFoldersResult {
  folders: DriveFolderEntry[];
  nextPageToken?: string;
}

/**
 * Escape a value for embedding inside a Drive API `q` query-string literal.
 *
 * This is NOT URL-encoding (the caller still passes the assembled `q` through
 * `URLSearchParams`, which handles that). It is Drive's OWN query-language
 * escaping: a single quote or backslash inside `parent` could otherwise
 * terminate the `'<parent>' in parents` clause early and splice attacker-
 * controlled query syntax after it. Per
 * https://developers.google.com/drive/api/guides/ref-search-terms, `\` and
 * `'` are the two characters that need escaping inside a quoted literal.
 */
function escapeDriveQueryLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * List the immediate child folders of `parent` in **My Drive only**
 * (Connectors page folder picker — SPEC-CONNECTORS §2.2).
 *
 * Metadata-only: the `fields` mask pulls `id,name,driveId` — never file
 * content, never a path, never an owner email. `includeItemsFromAllDrives`
 * is hard-coded `false` (D2 — shared drives are out of v1: neither
 * `drive-changes-runner.ts` nor `drive-changes-processor.ts` registers a
 * per-shared-drive watch, so a shared-drive folder selected here would be
 * silently unmatched forever). `supportsAllDrives=true` is set only for
 * forward compatibility with the parameter Google requires when
 * `includeItemsFromAllDrives` is present at all.
 *
 * One page per call (`pageSize=100`); the caller passes `pageToken` back for
 * "Load more". `hasChildren` is not computable without a probe query per row
 * (100 rows = 101 Drive calls), so it is not part of this return shape at
 * all — the API layer renders every folder as expandable and reports "no
 * subfolders" on an empty child page instead.
 */
export async function listChildFolders(args: {
  accessToken: string;
  parent: string;
  pageToken?: string;
  deps?: DriveClientDeps;
}): Promise<ListChildFoldersResult> {
  const fetchImpl = args.deps?.fetchImpl ?? fetch;
  const q = `'${escapeDriveQueryLiteral(args.parent)}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const params = new URLSearchParams({
    q,
    fields: 'nextPageToken,files(id,name,driveId)',
    pageSize: '100',
    orderBy: 'name',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'false',
  });
  if (args.pageToken) params.set('pageToken', args.pageToken);
  const url = `${DRIVE_API_BASE}/files?${params.toString()}`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${args.accessToken}` },
  });
  const json = (await readDriveJson(res, 'Drive files.list folders')) as {
    files?: Array<{ id?: string; name?: string; driveId?: string }>;
    nextPageToken?: string;
  } | null;
  if (!res.ok) {
    // Non-document path: files.list (folders) fields mask = id,name,driveId —
    // metadata only, no bytes. Bounded+scrubbed detail per DriveApiError doc.
    const err = new DriveApiError('Drive files.list (folders) failed', res.status, boundedErrorDetail(json));
    const retryAfterHeader = res.headers.get('retry-after');
    if (retryAfterHeader) err.retryAfter = retryAfterHeader;
    throw err;
  }
  const folders: DriveFolderEntry[] = (json?.files ?? [])
    .filter((f): f is { id: string; name: string; driveId?: string } => Boolean(f.id && f.name))
    .map((f) => ({ id: f.id, name: f.name, driveId: f.driveId ?? null }));
  return json?.nextPageToken
    ? { folders, nextPageToken: json.nextPageToken }
    : { folders };
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
/**
 * SCRUM-2903 / SCRUM-3661 / SCRUM-5094 / SCRUM-2330 incident fix: this used
 * to be built as `[ 'newStartPageToken', 'nextPageToken', 'changes(...',
 * 'file(...', 'lastModifyingUser(...)))' ].join('')` — an EMPTY-STRING join,
 * so the first two top-level entries and the start of `changes(...)` fused
 * together with no separating commas
 * (`newStartPageTokennextPageTokenchanges(...`). Google rejected every call
 * with HTTP 400 `Invalid field selection newStartPageTokennextP...` — every
 * Drive change notification failed, silently (200-acked so Drive would not
 * retry-storm), since the 2026-05-04 commit that introduced it.
 *
 * Built as ONE template literal — unambiguous, and its top-level entries are
 * explicitly comma-separated so there is no join-separator to get wrong a
 * second time. Structure mirrors `getFileMetadata`'s and `listChildFolders`'
 * flat `fields` masks: this one is just nested, per
 * https://developers.google.com/drive/api/guides/fields-parameter.
 */
const CHANGES_LIST_FIELDS =
  'newStartPageToken,nextPageToken,changes(fileId,removed,changeType,time,' +
  'file(id,name,parents,driveId,modifiedTime,headRevisionId,trashed,mimeType,' +
  'lastModifyingUser(emailAddress,displayName)))';

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
    fields: CHANGES_LIST_FIELDS,
  });
  const url = `${DRIVE_API_BASE}/changes?${params.toString()}`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${args.accessToken}` },
  });
  const json = await readDriveJson(res, 'Drive changes.list');
  if (!res.ok) {
    // Non-document path: changes.list returns a metadata-only feed (fields mask
    // pulls file id/parents/revision/actor — no bytes); bounded+scrubbed detail.
    //
    // pageTokenInvalid: 410/404 are Google's unconditional "token no longer
    // valid" statuses; a 400 additionally qualifies ONLY when the parsed
    // error body itself names pageToken as invalid (isInvalidPageTokenError)
    // — never on a bare/generic 400, which must keep failing loud (see that
    // function's doc comment for why, including this incident's own
    // fields-mask 400 as the concrete counter-example).
    const pageTokenInvalid = res.status === 410
      || res.status === 404
      || (res.status === 400 && isInvalidPageTokenError(json));
    throw new DriveApiError(
      'Drive changes.list failed',
      res.status,
      boundedErrorDetail(json),
      pageTokenInvalid ? true : undefined,
    );
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
    // Fix-round item 6: classify a 403 into a specific, LOUD outcome before
    // falling back to the generic DriveApiError §1.6A discipline below
    // (status + message only, no detail) — see `extractDriveFileErrorReason`'s
    // doc comment for why this narrow, reason-code-only read does not
    // reopen the "an error body here can carry document bytes" concern.
    if (res.status === 403) {
      const reason = await extractDriveFileErrorReason(res);
      if (reason === 'exportSizeLimitExceeded') {
        throw new DriveExportSizeLimitError();
      }
      if (reason && KNOWN_DRIVE_FILE_ACCESS_DENIED_REASONS.has(reason)) {
        throw new DriveFileAccessError(reason);
      }
      // Deliberately NOT a blanket "every 403 is access-denied": Drive also
      // returns 403 for `rateLimitExceeded` / `userRateLimitExceeded` /
      // `dailyLimitExceeded` / `quotaExceeded` — genuinely retryable, unlike
      // a permissions denial. An unrecognized (or unclassifiable — `reason`
      // is `null` when the body didn't parse or carried no `errors[]`)
      // reason falls through to the generic, retryable `DriveApiError`
      // below rather than being mis-labeled as a permanent access denial.
    }
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
  // Documented contract: fall back to the ID on ANY failure — including a
  // body-read timeout, which readDriveJson surfaces as a 408. A shared-drive
  // display name is cosmetic; it must never fail (or park) a connector flow.
  let json: { name?: string } | null;
  try {
    json = (await readDriveJson(res, 'Drive drives.get')) as { name?: string } | null;
  } catch {
    return args.driveId;
  }
  if (!res.ok || !json?.name) return args.driveId;
  return json.name;
}
