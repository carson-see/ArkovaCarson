/**
 * GoogleDriveAdapter — the ConnectorAdapter contract implemented over the
 * existing, shipped `oauth/drive.ts` functions (PR-1 of the connector-adapter
 * template series; see `connector-adapter.ts`'s module doc comment for the
 * series scope).
 *
 * ZERO BEHAVIOR CHANGE: this is a thin translation layer. Every method below
 * delegates to the real Drive function production already calls
 * (`drive-changes-runner.ts`, `drive-changes-processor.ts`, the OAuth routes,
 * the subscription-renewal cron) — this file introduces no new HTTP call, no
 * new retry/timeout policy, and no new Drive query shape. Nothing in the
 * codebase is rewired to USE this adapter yet; it exists to be proven correct
 * against Drive before a second provider (OneDrive) has to satisfy the same
 * interface.
 *
 * MISMATCHES FOUND WHILE VALIDATING THE CONTRACT AGAINST REAL DRIVE CALL
 * SITES, AND HOW THEY WERE RESOLVED (interface shape was NOT changed for any
 * of these — every resolution lives inside this adapter):
 *
 *   1. `OAuthTokenSet` is camelCase; Drive's token endpoints (and this repo's
 *      `oauth/drive.ts` return type) are snake_case
 *      (`access_token`/`refresh_token`/`expires_in`/`token_type`). Resolved
 *      with `toOAuthTokenSet()` below — a pure field-rename, no logic change.
 *
 *   2. `createWatch`/`stopWatch` take/return ONE `subscriptionId`, but Drive's
 *      real `channels.stop` needs TWO ids together: a CLIENT-generated
 *      `channelId` (production always mints this via `randomUUID()` at the
 *      call site — see `drive-oauth.ts`'s callback handler and
 *      `drive-subscription-renewal-deps.ts`'s `createChannel` — `oauth/drive.ts`
 *      never generates one itself) and the SERVER-issued `resourceId` that
 *      `changes.watch` returns. Resolved by generating `channelId` inside
 *      `createWatch` (encapsulating a Drive-specific mechanic the interface
 *      should not need to know about) and encoding both ids into the opaque
 *      `subscriptionId` this adapter returns: `` `${channelId}:${resourceId}` ``.
 *      `stopWatch` splits on the FIRST `:` to recover both — safe because
 *      `channelId` is always OUR OWN generated UUID (hyphens only, never a
 *      colon), so the split point is unambiguous regardless of what
 *      `resourceId` itself contains. The orchestrator never needs to know
 *      this encoding exists; it only ever round-trips the string opaquely,
 *      exactly as the interface promises.
 *
 *      OPEN GAP, not solved here: real Drive watch registration ALSO takes a
 *      caller-supplied `channelToken` (a high-entropy secret, persisted and
 *      later compared constant-time against the inbound `X-Goog-Channel-Token`
 *      header — see `drive-oauth.ts`'s `generateChannelToken()` /
 *      `api/v1/webhooks/drive.ts`). Because `oauth/drive.ts`'s `token` param
 *      is optional, this adapter's `createWatch` omits it — this is safe ONLY
 *      because nothing consumes this adapter's watches yet. A future PR that
 *      actually wires a webhook receiver to an adapter-created watch MUST
 *      extend this contract (or add a dedicated method) to thread a
 *      verification secret through and expose it back to the caller; shipping
 *      that plumbing without a consumer to prove it against would be the same
 *      premature generalization this PR is scoped to avoid elsewhere.
 *
 *   3. `revoke()` is a faithful wrapper over `revokeOAuthToken` — but note
 *      production DELIBERATELY NEVER CALLS Google's real revoke endpoint
 *      today (SCRUM-1237 / AUDIT-0424-12): a Drive refresh token is scoped to
 *      (Google account, OAuth client), not per Arkova org, so revoking it for
 *      one org's disconnect could yank access for a sibling org sharing the
 *      same Google identity. This adapter does not encode that policy — it
 *      exposes the raw vendor capability, matching the interface's promise —
 *      but any future caller of `ConnectorAdapter.revoke()` across vendors
 *      must independently re-derive whether THAT vendor's tokens are
 *      similarly org-scoped before calling it unconditionally.
 *
 *   4. `getFreshCursor`'s `resourceScope` maps directly to
 *      `getStartPageToken`'s optional `driveId` — no resolution needed, but
 *      confirmed no real call site (my-Drive or shared-Drive) currently sets
 *      it, so `createWatch`'s parallel `resourceScope` → `driveId` mapping is
 *      exercised by this adapter's tests, not yet by production traffic.
 *
 *   5. `listChanges` needed to reproduce Drive's exact revision fallback
 *      chain (`headRevisionId` → `mtime:` → `evt:`) to fill in
 *      `SourceVersionRef`. Rather than duplicate that logic (and risk it
 *      drifting from the processor's copy — those prefixes are load-bearing
 *      for the 0343 dedupe key), `resolveRevision`/`ResolvedDriveRevision`
 *      were exported from `drive-changes-processor.ts` (see that file's doc
 *      comment) and are reused verbatim here. A changes-feed entry this
 *      function cannot identify at all (no `file.id`/`fileId` AND no
 *      resolvable revision) is dropped, mirroring
 *      `drive-changes-processor.ts`'s `classifyPage`'s `onSkip` behavior —
 *      never surfaced as a `SourceChangeEvent` with a guessed identity.
 *
 *   6. `fetchBytes`/`classifyFetchError` map directly onto
 *      `fetchDriveFileBytes` and its three real error types
 *      (`DriveFileAccessError`, `DriveExportSizeLimitError`,
 *      `DriveDocumentTooLargeError`) — no resolution needed. §1.6A: this
 *      adapter adds NO catch block around `fetchBytes` (see the doc comment
 *      on that method below) — it has nothing to log and nothing to wrap, so
 *      there is no additional surface for bytes to leak through beyond what
 *      `oauth/drive.ts` itself already guarantees.
 */
import { randomUUID } from 'node:crypto';

import {
  buildAuthorizationUrl,
  exchangeCode,
  refreshAccessToken,
  revokeOAuthToken,
  createChangesWatch,
  stopDriveChannel,
  getStartPageToken,
  listChanges,
  fetchDriveFileBytes,
  DriveApiError,
  DriveFileAccessError,
  DriveExportSizeLimitError,
  DriveDocumentTooLargeError,
  type DriveClientDeps,
  type DriveChangesListEntry,
} from '../oauth/drive.js';
import { resolveRevision } from './drive-changes-processor.js';
import { GOOGLE_DRIVE_VENDOR } from '../../constants/connectors.js';
import type { ConnectorAdapter, OAuthTokenSet, SourceChangeEvent } from './connector-adapter.js';

/** Separator between the client-generated channelId and Drive's resourceId
 * inside the opaque `subscriptionId` this adapter hands back. `channelId` is
 * always our own `randomUUID()` (hyphens only), so splitting on the FIRST
 * occurrence is unambiguous no matter what `resourceId` itself contains. */
const SUBSCRIPTION_ID_SEPARATOR = ':';

function toOAuthTokenSet(tokens: {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
}): OAuthTokenSet {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresInSec: tokens.expires_in,
    scope: tokens.scope,
    tokenType: tokens.token_type,
  };
}

/**
 * Map one Drive `changes.list` entry to the vendor-neutral `SourceChangeEvent`.
 * Returns `null` when the entry cannot be identified at all (see mismatch #5
 * in this file's module doc comment) — the caller filters these out.
 */
function mapChangeToEvent(entry: DriveChangesListEntry): SourceChangeEvent | null {
  const externalRef = entry.file?.id ?? entry.fileId ?? null;
  const revision = resolveRevision(entry);
  if (!externalRef || !revision) return null;

  return {
    version: {
      externalRef,
      externalRevision: revision.revisionId,
      revisionKind: revision.kind,
    },
    parentIds: entry.file?.parents ?? [],
    mimeType: entry.file?.mimeType ?? null,
    modifiedTime: entry.file?.modifiedTime ?? null,
    actorEmail: entry.file?.lastModifyingUser?.emailAddress ?? null,
    removed: entry.removed === true,
    trashed: entry.file?.trashed === true,
  };
}

export class GoogleDriveAdapter implements ConnectorAdapter {
  readonly vendor = GOOGLE_DRIVE_VENDOR;

  /** `deps` mirrors `oauth/drive.ts`'s own `DriveClientDeps` (fetchImpl/env
   * injection for tests); production callers construct with no args. */
  constructor(private readonly deps: DriveClientDeps = {}) {}

  buildAuthorizationUrl(args: { redirectUri: string; state: string }): string {
    // No `scopes` override — matches every real caller (drive-oauth.ts never
    // passes one either), so the effective default-scope behavior is unchanged.
    return buildAuthorizationUrl({
      redirectUri: args.redirectUri,
      state: args.state,
      env: this.deps.env,
    });
  }

  async exchangeCode(args: { code: string; redirectUri: string }): Promise<OAuthTokenSet> {
    const tokens = await exchangeCode({
      code: args.code,
      redirectUri: args.redirectUri,
      deps: this.deps,
    });
    return toOAuthTokenSet(tokens);
  }

  async refreshToken(args: { refreshToken: string }): Promise<OAuthTokenSet> {
    const tokens = await refreshAccessToken({
      refreshToken: args.refreshToken,
      deps: this.deps,
    });
    return toOAuthTokenSet(tokens);
  }

  /** See mismatch #3 in this file's module doc comment — a faithful wrapper
   * over the raw vendor capability; production has its own reasons not to
   * call Google's real revoke endpoint today, which this method does not
   * encode. */
  async revoke(args: { token: string }): Promise<void> {
    await revokeOAuthToken({ token: args.token, deps: this.deps });
  }

  async createWatch(args: {
    accessToken: string;
    address: string;
    resourceScope?: string;
  }): Promise<{ subscriptionId: string; expiresAt: string; cursor: string }> {
    // See mismatch #2: Drive requires a CLIENT-generated channelId that
    // `oauth/drive.ts` never generates itself — production always mints one
    // at the call site via randomUUID(), so this adapter does the same.
    const channelId = randomUUID();
    const created = await createChangesWatch({
      accessToken: args.accessToken,
      channelId,
      address: args.address,
      driveId: args.resourceScope,
      deps: this.deps,
    });
    return {
      // Encode BOTH ids — stopWatch needs channelId (ours) AND resourceId
      // (Drive's) together for channels.stop. See mismatch #2.
      subscriptionId: `${channelId}${SUBSCRIPTION_ID_SEPARATOR}${created.resourceId}`,
      expiresAt: created.expiration,
      cursor: created.startPageToken,
    };
  }

  async stopWatch(args: { accessToken: string; subscriptionId: string }): Promise<void> {
    const separatorIndex = args.subscriptionId.indexOf(SUBSCRIPTION_ID_SEPARATOR);
    if (separatorIndex === -1) {
      // Fail loud rather than call Drive's channels.stop with a malformed
      // half-id — a subscriptionId this adapter did not itself mint (or one
      // corrupted in transit) must never silently no-op.
      throw new Error(
        `GoogleDriveAdapter.stopWatch: malformed subscriptionId (expected "channelId${SUBSCRIPTION_ID_SEPARATOR}resourceId")`,
      );
    }
    const channelId = args.subscriptionId.slice(0, separatorIndex);
    const resourceId = args.subscriptionId.slice(separatorIndex + 1);
    await stopDriveChannel({
      accessToken: args.accessToken,
      channelId,
      resourceId,
      deps: this.deps,
    });
  }

  async getFreshCursor(args: { accessToken: string; resourceScope?: string }): Promise<string> {
    return getStartPageToken({
      accessToken: args.accessToken,
      driveId: args.resourceScope,
      deps: this.deps,
    });
  }

  async listChanges(args: {
    accessToken: string;
    cursor: string;
  }): Promise<{ changes: SourceChangeEvent[]; nextCursor: string | null; newCursor: string | null }> {
    const response = await listChanges({
      accessToken: args.accessToken,
      pageToken: args.cursor,
      deps: this.deps,
    });
    const changes = response.changes
      .map(mapChangeToEvent)
      .filter((event): event is SourceChangeEvent => event !== null);
    return {
      changes,
      nextCursor: response.nextPageToken ?? null,
      newCursor: response.newStartPageToken ?? null,
    };
  }

  isCursorInvalidError(err: unknown): boolean {
    return err instanceof DriveApiError && err.pageTokenInvalid === true;
  }

  /**
   * §1.6A: no try/catch here on purpose. `fetchDriveFileBytes` already
   * throws byte-safe errors (no raw body attached on the document-fetch
   * path — see `oauth/drive.ts`'s `DriveApiError`/`DriveFileAccessError`/
   * `DriveExportSizeLimitError`/`DriveDocumentTooLargeError` doc comments),
   * and this method neither logs nor re-wraps the result, so there is no
   * additional place for the fetched bytes (or a failure referencing them)
   * to leak through.
   */
  async fetchBytes(args: {
    externalRef: string;
    accessToken: string;
    mimeType?: string | null;
  }): Promise<{ bytes: Buffer; contentType: string | null; exportMimeType: string | null }> {
    return fetchDriveFileBytes({
      fileId: args.externalRef,
      accessToken: args.accessToken,
      mimeType: args.mimeType,
      deps: this.deps,
    });
  }

  classifyFetchError(err: unknown): 'permanent_access_denied' | 'permanent_too_large' | 'retryable' {
    if (err instanceof DriveFileAccessError) return 'permanent_access_denied';
    if (err instanceof DriveExportSizeLimitError || err instanceof DriveDocumentTooLargeError) {
      return 'permanent_too_large';
    }
    // Fail OPEN to retryable for everything else, including an error shape
    // this adapter does not recognize — see the interface doc comment.
    return 'retryable';
  }
}
