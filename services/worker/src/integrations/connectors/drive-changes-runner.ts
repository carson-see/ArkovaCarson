/**
 * Drive changes-feed runner — webhook ↔ processor glue (SCRUM-1661 [Verify]).
 *
 * The webhook handler at `services/worker/src/api/v1/webhooks/drive.ts`
 * receives a per-channel push notification but Drive's payload is headers-
 * only. Real "what changed" work is the responsibility of `changes.list`,
 * which `processDriveChanges` orchestrates. This module bridges the two:
 *
 *   1. Resolve a fresh OAuth access token from the KMS-encrypted blob on
 *      `org_integrations.encrypted_tokens` — refreshing when expired and
 *      writing the new tokens back so subsequent calls don't repeat the
 *      refresh round-trip.
 *
 *   2. Compute the integration's `watched_folder_ids` set as the union of
 *      every enabled `WORKSPACE_FILE_MODIFIED` rule's folder bindings on
 *      the same org_id. Both the legacy single-binding shape
 *      (`trigger_config.folder_id`) and the multi-binding shape
 *      (`trigger_config.drive_folders[].folder_id`) are supported per
 *      `services/worker/src/rules/schemas.ts`.
 *
 *   3. Adapt the processor's `DriveProcessorDb` interface to actual
 *      Postgres calls — `drive_revision_ledger` upsert/delete, page-token
 *      advance on `org_integrations`, and `enqueue_rule_event` RPC.
 *
 *   4. Run `processDriveChanges` and return its summary so the webhook
 *      handler can log it.
 *
 * Pure orchestrator — every external dependency is injected so tests can
 * stub Drive HTTP, KMS, and the DB without touching production.
 */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { dbUuid } from '../../utils/db-row-validation.js';
import {
  refreshAccessToken,
  isDriveLegacyGrant,
  resolveDriveClientGeneration,
  DriveApiError,
  DRIVE_OAUTH_CLIENT_MISMATCH_ERROR_CODES,
  DRIVE_OAUTH_CLIENT_MISMATCH_ERROR_PREFIX,
  type DriveClientDeps,
} from '../oauth/drive.js';
import {
  parseDriveAccountLabel,
  stringifyDriveAccountLabel,
} from './drive-account-label.js';
import {
  decryptTokens,
  encryptTokens,
  type KmsClient,
  type OAuthTokens,
} from '../oauth/crypto.js';
import {
  processDriveChanges,
  type DriveProcessorDb,
  type ProcessChangesResult,
} from './drive-changes-processor.js';
import {
  DRIVE_FILE_CHANGED_JOB_TYPE,
  DriveFileChangedJobPayload,
} from './drive-artifact-producer.js';
import { submitJob } from '../../utils/jobQueue.js';
import {
  resolveDriveFolderPath,
  type FolderPathCacheStore,
} from './drive-folder-resolver.js';
import { reportDriveProcessingFailure } from './drive-connect-health.js';
import { driveFolderIds } from './drive-folder-bindings.js';
import {
  withRunLease,
  stillHoldsRunLease,
  markRunLeaseDirty,
  checkAndClearRunLeaseDirty,
  type RunLeaseSpec,
} from '../../jobs/run-lease.js';
import { recordAuditEvent } from '../../utils/auditEvent.js';

// Adapter-boundary Zod schemas (CodeRabbit ASSERTIVE on PR #696).
// CLAUDE.md §1.4 mandates Zod on every write path; the processor → adapter
// edge is the last line where a malformed value can be caught before it hits
// Postgres / the enqueue_rule_event RPC. Schemas mirror DriveProcessorDb
// types in drive-changes-processor.ts — kept loose on file/revision/parent
// ids (Drive file ids are not UUIDs) and UUID-shaped on (org_id,
// integration_id) which are always Postgres UUIDs.
//
// BUG-2026-08-12-003 / FD-15: those two are read out of `org_integrations`
// before they get here, so they are checked with `dbUuid` (shape-only) rather
// than Zod's strict RFC-9562 `.uuid()`. Postgres `uuid` is looser than RFC
// 9562, so the strict check could reject an id the database legitimately
// holds — validating our own stored data more harshly than the column that
// stores it can only cause false rejection. Drive-supplied values on this
// edge are unaffected; they were never UUID-validated.
const RevisionLedgerRowSchema = z.object({
  integration_id: dbUuid('integration_id'),
  org_id: dbUuid('org_id'),
  file_id: z.string().min(1),
  revision_id: z.string().min(1),
  parent_ids: z.array(z.string().min(1)),
  modified_time: z.string().nullable(),
  actor_email: z.string().nullable(),
  outcome: z.enum(['queued', 'parent_mismatch', 'unrelated_change']),
  rule_event_id: dbUuid('rule_event_id').nullable(),
});

const AdvancePageTokenArgsSchema = z.object({
  integration_id: dbUuid('integration_id'),
  new_page_token: z.string().min(1),
  // Fix-round item 4A: the CAS anchor — the UPDATE only lands
  // WHERE last_page_token = expected_page_token.
  expected_page_token: z.string().min(1),
});

const EnqueueRuleEventPayloadSchema = z.object({
  org_id: dbUuid('org_id'),
  file_id: z.string().min(1),
  parent_ids: z.array(z.string().min(1)),
  actor_email: z.string().nullable(),
  revision_id: z.string().min(1),
  integration_id: dbUuid('integration_id'),
  filename: z.string().nullable(),
  // SCRUM-1837 (GH #1837): optional so a caller that predates folder_path
  // resolution (e.g. an existing test double) still validates — `.optional()`
  // rather than requiring the key lets `validated.folder_path` come back
  // `undefined`, which the adapter below normalizes to `null` (never `''`,
  // which would make a `folder_path_starts_with` rule match everything).
  folder_path: z.string().nullable().optional(),
});

const ACCESS_TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;

/**
 * Per-integration single-flight guard (orchestrator first-run-flood review,
 * SCRUM-2903/3661 follow-up; upgraded to `withRunLease` + CAS in the
 * fix-round after an independent TLA pass found a real counterexample —
 * see `machines/driveChangesCursor.machine.ts`'s header).
 *
 * Without this, a burst of Drive push notifications for the SAME
 * integration (Drive can and does deliver bursts — the flagged prod org
 * receives ~115 pushes/day) can land on multiple Cloud Run instances
 * concurrently, each independently decrypting/refreshing the OAuth token and
 * walking the SAME changes.list backlog. The revision ledger's
 * UNIQUE(integration, file, revision) constraint already stops that from
 * double-enqueueing a rule event or a file-changed job (a losing writer's
 * insert 23505s and is counted as a duplicate) — so that half was never a
 * correctness bug. `advancePageToken`'s cursor write is a SEPARATE risk, now
 * closed by making it a compare-and-swap keyed on the token this run
 * started from (see `DriveProcessorDb.advancePageToken`'s doc comment in
 * drive-changes-processor.ts) rather than trusting the lease alone.
 *
 * Reuses the SAME cross-instance TTL-lease primitive `jobs/run-lease.ts`
 * already uses for the singleton anchor-pipeline crons (SCRUM-3031) — a
 * `job_queue` row claimed via compare-and-set, deliberately NOT a Postgres
 * advisory lock (see that module's doc comment: this webhook path also goes
 * through PostgREST's pooled backends, where an advisory lock's release can
 * land on a different backend than its acquire and silently no-op). The
 * difference from every OTHER registered lease is that this one is
 * DYNAMICALLY keyed per integration (`leaseId = integration.id`, already a
 * `job_queue`-compatible UUID) rather than a fixed module-level constant —
 * `job_queue` has no uniqueness constraint tying `leaseId` to a single
 * logical lease, so a distinct row per integration is exactly as safe as the
 * fixed-id case the other specs use.
 *
 * HEARTBEAT + maxRunMs (fix-round item 4A — corrected from a plain
 * acquire/release with no renewal, which an independent TLA pass proved
 * unsafe: a healthy-but-slow walk — SAFE_PAGE_LIMIT=25 pages, each
 * potentially paying folder-path-resolution latency, on a first-run
 * backlog — can run tens of seconds to low minutes, comfortably able to
 * outlive a flat un-renewed 10-minute TTL under load, at which point a
 * SECOND push could acquire the "expired" lease and walk the same pages
 * concurrently). Routed through `withRunLease`, the SAME heartbeat+deadline
 * primitive every other lease here uses — renews at ttl/3 for as long as
 * the walk is actually alive. `ttlMs` stays 10 min (a webhook-triggered
 * pass has no fixed cadence to floor against, and is expected to finish in
 * seconds to low minutes even with renewal); `maxRunMs` is now a REAL
 * abandonment bound, not a dead field — 2× `ttlMs` (20 min), the same
 * multiplier `PUBLIC_RECORD_ANCHOR_RUN_LEASE` uses, comfortably under the
 * 60-minute Cloud Run request timeout (`CLOUD_RUN_REQUEST_TIMEOUT_MS`) so a
 * genuinely hung walk is abandoned and its lease freed well before the
 * request itself would be killed.
 *
 * BELT AND SUSPENDERS: heartbeat renewal alone cannot stop an in-flight
 * walk that already lost the lease (a definitively-lost renewal only logs
 * and lets the run continue — see `RunLeaseContext`'s doc comment in
 * run-lease.ts). `processDriveChanges` therefore independently re-verifies
 * ownership via `stillHoldsRunLease` before every page and aborts without
 * advancing if it cannot.
 */
const DRIVE_CHANGES_RUN_LEASE_TTL_MS = 10 * 60_000;
const DRIVE_CHANGES_RUN_LEASE_MAX_RUN_MS = 2 * DRIVE_CHANGES_RUN_LEASE_TTL_MS;

export function driveChangesRunLeaseSpec(integrationId: string): RunLeaseSpec {
  return {
    leaseId: integrationId,
    leaseType: 'drive-changes:lease',
    ttlMs: DRIVE_CHANGES_RUN_LEASE_TTL_MS,
    label: `Drive changes (integration ${integrationId})`,
    // Not cron-scheduled — there is no fixed cadence to floor against, and
    // this spec is never registered in `RUN_LEASE_SPECS` (whose shared test
    // asserts `ttlMs > slowestRecordedCadenceMs` for every entry there).
    slowestRecordedCadenceMs: 0,
    maxRunMs: DRIVE_CHANGES_RUN_LEASE_MAX_RUN_MS,
  };
}

export interface DriveChangesRunnerDeps {
  db: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from: (table: string) => any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rpc: (...args: unknown[]) => any;
  };
  kms: KmsClient;
  drive?: DriveClientDeps;
  env?: NodeJS.ProcessEnv;
  logger?: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
  now?: () => Date;
}

export interface DriveIntegrationRow {
  id: string;
  org_id: string;
  encrypted_tokens: Buffer | string | null;
  token_kms_key_id: string | null;
  last_page_token: string | null;
  /**
   * Orchestrator fix-round item 2 (gap visibility): read BEFORE this run's
   * `processDriveChanges` call so a 410/404 re-bootstrap can record the
   * PRE-reset value as the gap's start — `advancePageToken` overwrites this
   * column to "now" unconditionally on every successful advance, including
   * a reset, so the caller (`webhooks/drive.ts`'s row lookup) must capture
   * it before that happens. `null` for a never-advanced cursor.
   *
   * OPTIONAL (`?:`) rather than required: `jobs/drive-file-changed.ts`
   * builds a `DriveIntegrationRow` purely to resolve an access token for
   * the file-fetch job — it never runs `processDriveChanges` and has no
   * reason to select this column. Every call site that DOES feed
   * `runDriveChanges` (the webhook, the reconciliation sweep) sets it;
   * `runDriveChanges` treats `undefined` the same as `null`.
   */
  last_token_advanced_at?: string | null;
}

export class DriveRunnerError extends Error {
  code: string;
  constructor(code: string, msg: string) {
    super(msg);
    this.code = code;
    this.name = 'DriveRunnerError';
  }
}

function bytea(b: Buffer | string | null): Buffer | null {
  if (b == null) return null;
  if (Buffer.isBuffer(b)) return b;
  // Postgres returns bytea as `\x...` hex by default through PostgREST.
  return Buffer.from(b.replace(/^\\x/, ''), 'hex');
}

function isExpired(tokens: OAuthTokens, now: Date): boolean {
  if (!tokens.expires_at) return true;
  const t = Date.parse(tokens.expires_at);
  if (!Number.isFinite(t)) return true;
  return t - now.getTime() <= ACCESS_TOKEN_REFRESH_WINDOW_MS;
}

/**
 * SCRUM-5287 follow-up (2026-09-22 fix-round, CRITICAL finding): resolve
 * which OAuth client GENERATION to refresh a row's token against.
 *
 * AUTHORITATIVE path: `storedClientId` (from `account_label.oauth_client_id`,
 * written at connect time — see `drive-oauth.ts`'s callback) is matched
 * against the CURRENTLY CONFIGURED pairs via `resolveDriveClientGeneration`.
 * A match is definitive — no guessing.
 *
 * FALLBACK path (only when `storedClientId` is absent — a pre-cutover row
 * connected before this field existed — or present but matches neither
 * configured pair, e.g. after a client rotation): the scope-string
 * heuristic (`isDriveLegacyGrant`). Every fallback is logged (bounded — only
 * the integration id, never a token or scope value) so the fallback rate is
 * visible and shrinks to zero as rows self-heal (see `loadDriveAccessToken`).
 */
function resolveDriveRefreshGeneration(args: {
  storedClientId: string | null;
  storedScope: string | null | undefined;
  env: NodeJS.ProcessEnv;
  integrationId: string;
  logger?: DriveChangesRunnerDeps['logger'];
}): { generation: DriveOAuthClientGenerationLike; authoritative: boolean } {
  if (args.storedClientId) {
    const matched = resolveDriveClientGeneration(args.storedClientId, args.env);
    if (matched) return { generation: matched, authoritative: true };
    args.logger?.warn?.(
      { integrationId: args.integrationId },
      'loadDriveAccessToken: stored oauth_client_id matches neither configured Drive OAuth client — falling back to scope-string heuristic',
    );
  } else {
    args.logger?.info?.(
      { integrationId: args.integrationId },
      'loadDriveAccessToken: no stored oauth_client_id — falling back to scope-string heuristic',
    );
  }
  return {
    generation: isDriveLegacyGrant(args.storedScope) ? 'legacy' : 'current',
    authoritative: false,
  };
}

// Local alias — `DriveOAuthClientGeneration` itself is not exported from
// oauth/drive.ts (module-internal type); the two values are stable and
// public through `resolveDriveClientGeneration`'s return type.
type DriveOAuthClientGenerationLike = 'current' | 'legacy';

/**
 * Decrypt → optionally refresh → re-encrypt+persist. Returns the access
 * token usable against the Drive API. The caller does NOT need to know
 * whether a refresh happened.
 */
export async function loadDriveAccessToken(
  integration: DriveIntegrationRow,
  deps: Pick<DriveChangesRunnerDeps, 'db' | 'kms' | 'drive' | 'env' | 'now' | 'logger'>,
): Promise<{ accessToken: string; refreshed: boolean }> {
  if (!integration.encrypted_tokens || !integration.token_kms_key_id) {
    throw new DriveRunnerError(
      'no_encrypted_tokens',
      `integration ${integration.id} has no encrypted OAuth tokens — re-run the OAuth consent flow`,
    );
  }
  const ciphertext = bytea(integration.encrypted_tokens);
  if (!ciphertext) {
    throw new DriveRunnerError('no_encrypted_tokens', 'encrypted_tokens decoded to empty buffer');
  }
  const tokens = await decryptTokens(ciphertext, {
    kms: deps.kms,
    keyName: integration.token_kms_key_id,
  });
  const now = deps.now?.() ?? new Date();
  if (!isExpired(tokens, now) && tokens.access_token) {
    return { accessToken: tokens.access_token, refreshed: false };
  }
  if (!tokens.refresh_token) {
    throw new DriveRunnerError(
      'no_refresh_token',
      'token refresh required but stored tokens contain no refresh_token',
    );
  }
  // Snapshot the pre-refresh ciphertext as a compare-and-swap guard.
  // CodeRabbit ASSERTIVE flagged the original write as racy: two
  // concurrent webhooks could both observe an expired access_token,
  // both call refreshAccessToken (Google rotates the refresh_token in
  // the response), and the loser's UPDATE would clobber the winner's
  // new refresh_token — leaving the integration with a refresh_token
  // Google has already invalidated. Avoid that by conditioning the
  // UPDATE on `encrypted_tokens = $prevCiphertext`.
  const prevCiphertextHex = `\\x${ciphertext.toString('hex')}`;
  const env = deps.env ?? process.env;

  // SCRUM-5287 follow-up (2026-09-22 fix-round, CRITICAL finding): resolve
  // which client to refresh against — authoritatively from the stored
  // client_id when present, else the scope heuristic. One extra, small SELECT
  // — only on this already-comparatively-rare refresh path (every OTHER
  // caller of loadDriveAccessToken is unaffected; DriveIntegrationRow itself
  // is not widened, so no other query needs to change).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, arkova/missing-org-filter -- scoped by integration.id
  const { data: labelRow, error: labelReadError } = await (deps.db as any)
    .from('org_integrations')
    .select('account_label')
    .eq('id', integration.id)
    .maybeSingle();
  // Independently-reviewed P1: this SELECT's error was previously discarded,
  // so a transient read failure (network blip, pooler hiccup) looked
  // IDENTICAL to "row exists with no label" (data: null/undefined,
  // error: null) — the pre-cutover-row case the fallback below is meant
  // for. That made `authoritative` come back false and fed the self-heal
  // write below, which unconditionally spreads `storedLabel ?? { email:
  // null, channel_token: null, resource_id: null }` — nulling out a
  // legitimate email/channel_token/resource_id that this SELECT merely
  // failed to read, not one that was actually absent. The webhook receiver
  // (`api/v1/webhooks/drive.ts`) then rejects the now-null channel_token
  // with 401 `integration_missing_channel_token` on every subsequent
  // delivery — a transient read failure becoming a permanent notification
  // failure. Abort BEFORE the refresh/write path on a real read error;
  // this is retryable (the caller's job/webhook retry will simply try
  // again), unlike "no label" which is a legitimate, common steady state.
  if (labelReadError) {
    throw new DriveRunnerError(
      'account_label_read_failed',
      `failed to read account_label for integration ${integration.id} before refresh: ${(labelReadError as { message?: string }).message ?? 'unknown'}`,
    );
  }
  const rawLabelValue = (labelRow as { account_label?: string | null } | null)?.account_label ?? null;
  const storedLabel = parseDriveAccountLabel(rawLabelValue);
  const { generation: resolvedGeneration, authoritative } = resolveDriveRefreshGeneration({
    storedClientId: storedLabel?.oauth_client_id ?? null,
    storedScope: tokens.scope,
    env,
    integrationId: integration.id,
    logger: deps.logger,
  });

  let refreshed: Awaited<ReturnType<typeof refreshAccessToken>>;
  try {
    refreshed = await refreshAccessToken({
      refreshToken: tokens.refresh_token,
      clientGeneration: resolvedGeneration,
      deps: deps.drive,
    });
  } catch (err) {
    // Defense-in-depth retry (independent review, CRITICAL finding): a
    // refresh attempted as 'current' that Google rejects with a
    // client-mismatch code (invalid_grant/unauthorized_client/invalid_client)
    // may mean this row's token was actually issued by the OLD (legacy)
    // client before the new pair existed (R-hybrid/R-broad/R-32/R-null).
    // Retry ONCE with 'legacy'. NEVER the other direction (legacy ->
    // current): a token genuinely issued by the new client cannot predate
    // the new client's own existence, so that misclassification cannot
    // happen — nothing to retry for.
    //
    // SECURITY FRAMING (independent review, accepted as stated): this is
    // NOT a confidentiality concern. Both OAuth clients are Arkova's own;
    // the token endpoint is the same trusted Google party regardless of
    // which client_id is presented. The risk this retry closes is
    // availability/lockout — a legitimate integration silently failing to
    // refresh with no actionable cause — not disclosure.
    const canRetryAsLegacy = resolvedGeneration === 'current'
      && err instanceof DriveApiError
      && typeof err.oauthError === 'string'
      && DRIVE_OAUTH_CLIENT_MISMATCH_ERROR_CODES.has(err.oauthError);
    if (!canRetryAsLegacy) {
      throw err;
    }
    try {
      refreshed = await refreshAccessToken({
        refreshToken: tokens.refresh_token,
        clientGeneration: 'legacy',
        deps: deps.drive,
      });
      deps.logger?.warn?.(
        { integrationId: integration.id },
        'loadDriveAccessToken: refresh under "current" failed with an OAuth client-mismatch error; retry under "legacy" succeeded',
      );
    } catch (retryErr) {
      // Both generations failed. Surface a DISTINCT, durable signal
      // (§1.6A-safe: no token, no scope, no raw body — a fixed prefix plus
      // the OAuth error CODE, a short Google-documented string) so an admin
      // sees the actual cause instead of a generic cursor_stale 6h later.
      const oauthErrorCode = retryErr instanceof DriveApiError ? retryErr.oauthError : undefined;
      const mismatchMessage = `${DRIVE_OAUTH_CLIENT_MISMATCH_ERROR_PREFIX}: refresh failed under both configured OAuth clients`
        + (oauthErrorCode ? ` (${oauthErrorCode})` : '')
        + ' — reconnect required';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, arkova/missing-org-filter -- scoped by integration.id
      const { error: signalWriteError } = await (deps.db as any)
        .from('org_integrations')
        .update({ last_renewal_error: mismatchMessage, updated_at: now.toISOString() })
        .eq('id', integration.id);
      if (signalWriteError) {
        deps.logger?.warn?.(
          { integrationId: integration.id, error: signalWriteError },
          'loadDriveAccessToken: failed to persist the oauth_client_mismatch signal',
        );
      }
      throw new DriveRunnerError('oauth_client_mismatch', mismatchMessage);
    }
  }

  const merged: OAuthTokens = {
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token ?? tokens.refresh_token,
    token_type: refreshed.token_type ?? tokens.token_type,
    scope: refreshed.scope ?? tokens.scope,
    expires_at: new Date(now.getTime() + refreshed.expires_in * 1000).toISOString(),
  };
  // Re-encrypt under the SAME key version we decrypted with — preserves
  // rotation auditability (each org_integrations row keeps a stable
  // token_kms_key_id until the operator triggers a re-encrypt sweep).
  const reencrypted = await encryptTokens(merged, {
    kms: deps.kms,
    keyName: integration.token_kms_key_id,
    env: deps.env,
  });
  // SCRUM-5287 follow-up: SELF-HEAL. `refreshed.clientId` is the client that
  // just, demonstrably, successfully issued a fresh access token for this
  // row — authoritative by construction. Persist it whenever it is NEW
  // information (the resolution above was not already authoritative, i.e.
  // came from the heuristic or a rotation-mismatch fallback) so the NEXT
  // refresh for this row skips the heuristic entirely, folded into the SAME
  // CAS write below (no extra round trip).
  const accountLabelUpdate = !authoritative
    ? { account_label: stringifyDriveAccountLabel({ ...(storedLabel ?? { email: null, channel_token: null, resource_id: null }), oauth_client_id: refreshed.clientId }) }
    : {};
  const willWriteAccountLabel = Object.prototype.hasOwnProperty.call(accountLabelUpdate, 'account_label');
  // CAS write — only succeeds if no other concurrent refresh has
  // already mutated `encrypted_tokens` since we read it.
  // CodeRabbit ASSERTIVE on PR #696 (8ea5dc40): distinguish DB error
  // from CAS miss. A failed write that fell through to "another
  // refresher won" would silently return the stale pre-refresh token
  // as if the refresh succeeded, turning a persistence/read failure
  // into a silent auth bug.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, arkova/missing-org-filter -- CAS update scoped by integration.id
  let casUpdate = (deps.db as any)
    .from('org_integrations')
    .update({
      encrypted_tokens: `\\x${reencrypted.ciphertext.toString('hex')}`,
      token_kms_key_id: reencrypted.keyId,
      updated_at: now.toISOString(),
      ...accountLabelUpdate,
    })
    .eq('id', integration.id)
    .eq('encrypted_tokens', prevCiphertextHex);
  // P2 fix (independently reviewed, same review pass as the P1 above):
  // refresh (here) and watch-renewal (`drive-subscription-renewal.ts`) both
  // independently serialize the WHOLE `account_label` JSON blob. Refresh's
  // CAS previously guarded ONLY `encrypted_tokens`, so a renewal write that
  // lands between this function's account_label SELECT (above) and this
  // UPDATE could already have replaced the row's channel_token/resource_id
  // with a fresh credential; the unconditioned write below would then
  // clobber that fresh credential with the stale copy this call read.
  // Guard the write on account_label being BYTE-IDENTICAL to what we read —
  // any concurrent account_label writer (renewal, or another refresher)
  // invalidates the predicate and this call falls into the existing
  // "CAS lost" path below instead of overwriting a label it never actually
  // observed. Only applied when we're actually writing account_label (the
  // self-heal path) — the authoritative path never touches the column, so
  // it has nothing to guard.
  if (willWriteAccountLabel) {
    casUpdate = rawLabelValue === null
      ? casUpdate.is('account_label', null)
      : casUpdate.eq('account_label', rawLabelValue);
  }
  const { data: persistedRow, error: writeError } = await casUpdate
    .select('id')
    .maybeSingle();

  if (writeError) {
    throw new DriveRunnerError(
      'token_persist_failed',
      `failed to persist refreshed Drive tokens for integration ${integration.id}: ${(writeError as { message?: string }).message ?? 'unknown'}`,
    );
  }

  if (persistedRow) {
    return { accessToken: merged.access_token, refreshed: true };
  }

  // CAS lost — another concurrent refresh wrote first. Re-decrypt the
  // current row to get the winner's access token. We don't burn a
  // second Google refresh (which would itself rotate the refresh_token
  // again and create a chain of races); we trust the winner.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, arkova/missing-org-filter -- CAS update scoped by integration.id
  const { data: latest, error: readError } = await (deps.db as any)
    .from('org_integrations')
    .select('encrypted_tokens, token_kms_key_id')
    .eq('id', integration.id)
    .maybeSingle();
  if (readError) {
    throw new DriveRunnerError(
      'token_read_failed',
      `CAS lost on integration ${integration.id} and follow-up read errored: ${(readError as { message?: string }).message ?? 'unknown'}`,
    );
  }
  if (!latest?.encrypted_tokens || !latest.token_kms_key_id) {
    throw new DriveRunnerError(
      'concurrent_refresh_race',
      `CAS lost on integration ${integration.id} but follow-up read returned no encrypted_tokens — race + revoke?`,
    );
  }
  const latestCiphertext = bytea(latest.encrypted_tokens);
  if (!latestCiphertext) {
    throw new DriveRunnerError('concurrent_refresh_race', 'follow-up read returned empty buffer');
  }
  const winner = await decryptTokens(latestCiphertext, {
    kms: deps.kms,
    keyName: latest.token_kms_key_id,
  });
  return { accessToken: winner.access_token, refreshed: true };
}

/**
 * SELECT distinct folder ids from organization_rules where the rule fires
 * on Drive changes for the given org. Combines the legacy single-folder
 * shape and the newer drive_folders[] array shape.
 */
export async function loadWatchedFolderIds(
  orgId: string,
  deps: Pick<DriveChangesRunnerDeps, 'db' | 'logger'>,
): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (deps.db as any)
    .from('organization_rules')
    .select('trigger_config')
    .eq('org_id', orgId)
    .eq('trigger_type', 'WORKSPACE_FILE_MODIFIED')
    .eq('enabled', true);
  if (error) {
    // Fail loud — collapsing transient rule-lookup failures into the
    // empty-array path turns a DB outage into "no watched folders" and
    // silently skips processing, leaving pending Drive changes stranded
    // until the next webhook happens to wake the runner. The caller in
    // drive.ts already wraps runDriveChanges in try/catch + 200-ack +
    // Sentry log, which is the correct escalation path. CodeRabbit
    // ASSERTIVE on PR #696.
    deps.logger?.error?.({ error, orgId }, 'loadWatchedFolderIds: rule lookup failed — propagating');
    const runnerError = new Error(`loadWatchedFolderIds: organization_rules query failed for org ${orgId}: ${(error as { message?: string }).message ?? 'unknown error'}`);
    // P0-2: reported HERE (richest context available: this is an org-level
    // rule-lookup failure, before any integration/file/revision context
    // exists) rather than left to the webhook's outer catch-all.
    reportDriveProcessingFailure(runnerError, { stage: 'watched_folder_lookup', orgId });
    throw runnerError;
  }
  const ids = new Set<string>();
  for (const row of (data ?? []) as Array<{ trigger_config?: Record<string, unknown> | null }>) {
    for (const folderId of driveFolderIds(row.trigger_config)) ids.add(folderId);
  }
  return [...ids];
}

/**
 * Build a `DriveProcessorDb` adapter that maps the processor's narrow
 * interface onto real Supabase calls. Kept here (vs inside the processor)
 * because the processor unit tests inject a fake — production wiring is
 * a separate concern.
 */
export function createProcessorDbAdapter(deps: Pick<DriveChangesRunnerDeps, 'db' | 'logger'>): DriveProcessorDb {
  const log = deps.logger;

  // Helper: log a Zod issue list with actor_email scrubbed (PII §1.4).
  // Validation paths bypass the unused-var prefix convention because the
  // destructured key is genuinely discarded — that's the whole point of
  // the scrub.
  function logScrubbedValidation(
    rawRow: { actor_email?: unknown } & Record<string, unknown>,
    issues: z.ZodIssue[],
    label: string,
  ) {
    const { actor_email: _scrubbed, ...safe } = rawRow;
    log?.error?.({ issues, row: safe }, label);
  }

  return {
    async insertRevisionLedger(row) {
      const parsed = RevisionLedgerRowSchema.safeParse(row);
      if (!parsed.success) {
        logScrubbedValidation(row, parsed.error.issues, 'drive_revision_ledger insert: schema validation failed');
        throw new DriveRunnerError(
          'invalid_revision_ledger_row',
          `insertRevisionLedger payload failed Zod validation: ${parsed.error.issues.map((i) => i.path.join('.') + ':' + i.message).join('; ')}`,
        );
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (deps.db as any)
        .from('drive_revision_ledger')
        .insert(parsed.data);
      if (!error) return { inserted: true, conflict: false };
      // 23505 unique_violation = duplicate (integration, file, revision)
      if ((error as { code?: string }).code === '23505') {
        return { inserted: false, conflict: true };
      }
      // Scrub PII before logging — `row.actor_email` is the Google
      // signed-in user's email and must not appear in worker logs /
      // Sentry per CLAUDE.md §1.4 (PII scrubbing). CodeRabbit ASSERTIVE
      // on PR #696 flagged this leak.
      const { actor_email: _actorEmailIns, ...safeRow } = row;
      log?.error?.({ error, row: safeRow }, 'drive_revision_ledger insert failed');
      throw error;
    },
    async deleteRevisionLedgerEntry(key) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (deps.db as any)
        .from('drive_revision_ledger')
        .delete()
        .eq('integration_id', key.integration_id)
        .eq('file_id', key.file_id)
        .eq('revision_id', key.revision_id);
      if (error) {
        // CodeRabbit ASSERTIVE on PR #696: surface delete failures.
        // Earlier revisions only logged a warning here, but the
        // processor calls this as a *compensating* rollback after an
        // enqueue_rule_event failure. If the delete silently fails the
        // ledger row stays put, future passes treat the revision as
        // already-processed (UNIQUE conflict on insert), and the change
        // is lost forever. Throwing aborts the page so the caller's
        // try/catch in webhooks/drive.ts escalates via Sentry; Drive
        // will retry on the next push notification.
        log?.error?.({ error, key }, 'drive_revision_ledger compensating delete failed — aborting page');
        throw new DriveRunnerError(
          'revision_ledger_rollback_failed',
          `deleteRevisionLedgerEntry failed for (${key.integration_id}, ${key.file_id}, ${key.revision_id}): ${(error as { message?: string }).message ?? 'unknown'}`,
        );
      }
    },
    async advancePageToken(args) {
      const parsed = AdvancePageTokenArgsSchema.safeParse(args);
      if (!parsed.success) {
        log?.error?.(
          { issues: parsed.error.issues, args },
          'advancePageToken: schema validation failed',
        );
        throw new DriveRunnerError(
          'invalid_advance_page_token_args',
          `advancePageToken payload failed Zod validation: ${parsed.error.issues.map((i) => i.path.join('.') + ':' + i.message).join('; ')}`,
        );
      }
      // Fix-round item 4A: COMPARE-AND-SWAP, not an unconditional write —
      // same read-back-after-CAS pattern `loadDriveAccessToken` above uses
      // for the token-refresh race. The UPDATE only lands
      // `WHERE id = integration_id AND last_page_token = expected_page_token`;
      // a zero-row match (another run already advanced past this run's
      // starting point) is an EXPECTED, non-error outcome — `{advanced:
      // false}` — never a rewind. `.select('id').maybeSingle()` reads back
      // whether OUR write actually landed, mirroring the CAS-lost handling
      // in `loadDriveAccessToken`.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, arkova/missing-org-filter -- CAS update scoped by integration.id
      const { data: persistedRow, error } = await (deps.db as any)
        .from('org_integrations')
        .update({
          last_page_token: parsed.data.new_page_token,
          last_token_advanced_at: new Date().toISOString(),
        })
        .eq('id', parsed.data.integration_id)
        .eq('last_page_token', parsed.data.expected_page_token)
        .select('id')
        .maybeSingle();
      if (error) throw error;
      return { advanced: Boolean(persistedRow) };
    },
    async enqueueRuleEvent(payload) {
      const parsed = EnqueueRuleEventPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        logScrubbedValidation(payload, parsed.error.issues, 'enqueue_rule_event: schema validation failed');
        // Return null (rather than throw) to match the contract: the
        // processor compensates a null return by rolling back the ledger
        // and continuing to the next change — exactly what we want for a
        // single malformed payload.
        return null;
      }
      const validated = parsed.data;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (deps.db.rpc as any)('enqueue_rule_event', {
        p_org_id: validated.org_id,
        p_trigger_type: 'WORKSPACE_FILE_MODIFIED',
        p_vendor: 'google_drive',
        p_external_file_id: validated.file_id,
        p_filename: validated.filename ?? null,
        // SCRUM-1837 (GH #1837): was hardcoded null, so folder_path_starts_with
        // rules could never fire. `?? null` (not `?? ''`) — the resolver's own
        // contract is "unresolvable stays null", never an empty string that
        // would make startsWith match every rule.
        p_folder_path: validated.folder_path ?? null,
        p_sender_email: validated.actor_email,
        p_subject: null,
        p_payload: {
          source: 'google_drive',
          file_id: validated.file_id,
          parent_ids: validated.parent_ids,
          revision_id: validated.revision_id,
          integration_id: validated.integration_id,
          actor_email: validated.actor_email,
        },
      });
      if (error) {
        // Scrub PII before logging — payload.actor_email is the Google
        // signed-in user's email. CodeRabbit ASSERTIVE on PR #696
        // flagged this as a CLAUDE.md §1.4 PII leak (and §1.4 +
        // anchor-pre-signing.ts already follow the no-actor_email-in-logs
        // pattern for audit_events).
        const { actor_email: _actorEmailRpc, ...safePayload } = payload;
        log?.error?.({ error, payload: safePayload }, 'enqueue_rule_event RPC failed');
        return null;
      }
      return data ? String(data) : null;
    },
    // SCRUM-2903 (GD-PROD): Drive twin of the DocuSign webhook's
    // enqueueFetchJob — writes the durable `google_drive.file_changed`
    // job_queue row that jobs/drive-file-changed.ts drains to fetch the
    // document, SHA-256 it (§1.6A), and enqueue a connector_artifact for the
    // existing drain (connector-artifact-drain.ts) to anchor. No document
    // bytes flow through this call — connector-native ids + a mime/timestamp
    // hint only, matching DriveFileChangedJobPayload exactly (the same
    // schema jobs/drive-file-changed.ts parses on the consumer side).
    async enqueueFileChangedJob(payload) {
      // DriveFileChangedJobPayload declares revision_id/mime_type/
      // modified_time/rule_event_id as `.optional()` (accepts `undefined`,
      // NOT `null`) — the processor's DriveProcessorDb contract is typed
      // `string | null` so it can express "no value" without importing Zod.
      // Convert null -> undefined at this one adapter boundary before
      // validating against the shared schema.
      const candidate = {
        org_id: payload.org_id,
        integration_id: payload.integration_id,
        file_id: payload.file_id,
        revision_id: payload.revision_id ?? undefined,
        mime_type: payload.mime_type ?? undefined,
        modified_time: payload.modified_time ?? undefined,
        rule_event_id: payload.rule_event_id ?? undefined,
        // SCRUM-4507 source link-back — same null -> undefined conversion as
        // every field above. `revision_kind` is never null (the processor
        // always resolves one) so it passes through unchanged; it still goes
        // through safeParse, which fails CLOSED on an unrecognised value
        // rather than enqueueing a job the record page cannot render.
        shared_drive_id: payload.shared_drive_id ?? undefined,
        folder_id: payload.folder_id ?? undefined,
        folder_path: payload.folder_path ?? undefined,
        revision_kind: payload.revision_kind,
      };
      const parsed = DriveFileChangedJobPayload.safeParse(candidate);
      if (!parsed.success) {
        log?.error?.(
          { issues: parsed.error.issues, integrationId: payload.integration_id },
          'google_drive.file_changed enqueue: schema validation failed',
        );
        return null;
      }
      const jobId = await submitJob({
        type: DRIVE_FILE_CHANGED_JOB_TYPE,
        max_attempts: 5,
        priority: 10,
        payload: parsed.data,
      });
      if (!jobId) {
        log?.error?.(
          { integrationId: payload.integration_id },
          'google_drive.file_changed job enqueue failed',
        );
        return null;
      }
      return jobId;
    },
    // Orchestrator fix-round item 2 (gap visibility). `audit_events` — no
    // migration: an append-only "notable thing happened" table that already
    // exists, chosen over `org_integrations.last_renewal_error` because that
    // column is semantically channel-RENEWAL-only (see connectors/agents.md
    // — reusing it for a DIFFERENT failure class already backfired once in
    // this same incident's connector-health fix) and would in any case be
    // overwritten by the very `advancePageToken` write the gap is about.
    // NEVER throws — `recordAuditEvent` already never rejects; this adapter
    // additionally logs on `!ok` so a lost gap record is itself visible in
    // Cloud Run logs even though it cannot fail the recovery (see the
    // processor's own doc comment on this method).
    async recordCursorGap(args) {
      const result = await recordAuditEvent({
        event_type: 'drive_changes_cursor_gap',
        event_category: 'WEBHOOK',
        org_id: args.org_id,
        target_type: 'org_integrations',
        target_id: args.integration_id,
        details: JSON.stringify({
          gap_start: args.gap_start,
          gap_end: args.gap_end,
          reason: 'pageTokenInvalid',
        }),
      });
      if (!result.ok) {
        log?.error?.(
          { integrationId: args.integration_id, orgId: args.org_id, gapStart: args.gap_start, gapEnd: args.gap_end },
          'drive changes cursor gap: audit_events write failed — gap happened but is NOT durably recorded',
        );
      }
    },
  };
}

/**
 * SCRUM-1837 (GH #1837): Postgres-backed `FolderPathCacheStore` over
 * `drive_folder_path_cache` (org_id, file_id PK). `resolveDriveFolderPath`
 * checks this before spending a `files.get` round-trip per parent, and the
 * resolver enforces its own 15-minute TTL on top of `cached_at` — this
 * adapter is a plain read/upsert, no TTL logic here. The cache is
 * best-effort: a write failure is logged and swallowed rather than failing
 * the whole changes pass — losing the cache costs an extra Drive API call
 * on the next event for this file, not correctness.
 */
export function createFolderPathCache(
  deps: Pick<DriveChangesRunnerDeps, 'db' | 'logger'>,
): FolderPathCacheStore {
  return {
    async get({ orgId, fileId }) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (deps.db as any)
        .from('drive_folder_path_cache')
        .select('folder_path, cached_at')
        .eq('org_id', orgId)
        .eq('file_id', fileId)
        .maybeSingle();
      if (error || !data) return null;
      return { folder_path: data.folder_path ?? null, cached_at: data.cached_at };
    },
    async put({ orgId, fileId, folderPath }) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (deps.db as any)
        .from('drive_folder_path_cache')
        .upsert(
          { org_id: orgId, file_id: fileId, folder_path: folderPath, cached_at: new Date().toISOString() },
          { onConflict: 'org_id,file_id' },
        );
      if (error) {
        deps.logger?.warn?.(
          { error, orgId, fileId },
          'drive_folder_path_cache write failed — best-effort, next lookup re-resolves',
        );
      }
    },
  };
}

// Dirty / rerun-requested marker (fix-round item 3) lives in jobs/run-lease.ts
// as `markRunLeaseDirty` / `checkAndClearRunLeaseDirty` — it is a lease-row
// primitive, and run-lease.ts is the allow-listed owner of lease-row access
// (scripts/ci/check-job-queue-parity.ts rule 4). See its doc comment there.

/**
 * Top-level runner. Webhook handler calls this with the resolved
 * integration row; everything else is dependency-injected.
 */
export async function runDriveChanges(
  integration: DriveIntegrationRow,
  deps: DriveChangesRunnerDeps,
): Promise<ProcessChangesResult | { skipped: 'no_page_token' | 'no_watched_folders' | 'locked' }> {
  // Bootstrap guard — Drive integrations created BEFORE migration 0288 may
  // have last_page_token=null. Without it the processor can't even call
  // changes.list. Fail soft (skip + log).
  //
  // Recovery path (corrected, BUG 2026-09-13): the hourly
  // `drive-subscription-renewal.ts` sweep bootstraps a NULL cursor from the
  // startPageToken of the watch it registers, in the same write as the
  // channel swap — so a connection that lands here recovers on the next
  // renewal pass that reaches it (within the 24h pre-expiry horizon, or
  // immediately for a row with no channel at all). Before that fix, renewal
  // discarded the startPageToken unconditionally and this comment's promise
  // was false: a null cursor was never bootstrapped by anything, and every
  // push for that connection was dropped here forever.
  if (!integration.last_page_token) {
    deps.logger?.warn?.(
      { integrationId: integration.id, orgId: integration.org_id },
      'drive runner: integration has no last_page_token — skipping (will recover on next watch renewal)',
    );
    return { skipped: 'no_page_token' };
  }

  // Pre-resolve watched folders. If the integration's org has zero enabled
  // Drive rules, there's literally nothing to enqueue — skipping avoids a
  // wasted access-token refresh + Drive API call. Reads from the rule layer,
  // not the integration layer, because folder bindings live on rules.
  const watched = await loadWatchedFolderIds(integration.org_id, deps);
  if (watched.length === 0) {
    deps.logger?.info?.(
      { integrationId: integration.id, orgId: integration.org_id },
      'drive runner: org has no enabled WORKSPACE_FILE_MODIFIED rules with folder bindings — skipping',
    );
    return { skipped: 'no_watched_folders' };
  }

  // Single-flight guard — see the doc comment on driveChangesRunLeaseSpec.
  // Acquired AFTER the cheap skip checks above (no point burning a lease
  // round-trip on a pass that would immediately no-op) and BEFORE the token
  // refresh + changes.list work this guards. `withRunLease` (fix-round item
  // 4A) heartbeat-renews for the whole body and bounds abandonment at
  // `maxRunMs` — see driveChangesRunLeaseSpec's doc comment.
  const leaseClient = deps.db as unknown as SupabaseClient;
  const leaseSpec = driveChangesRunLeaseSpec(integration.id);
  const nonNullLastPageToken = integration.last_page_token;

  const outcome = await withRunLease({ ...leaseSpec, client: leaseClient }, async ({ holder }) => {
    const { accessToken } = await loadDriveAccessToken(integration, deps);
    const db = createProcessorDbAdapter(deps);
    // SCRUM-1837 (GH #1837): wire the folder-path resolver so
    // folder_path_starts_with rules can finally match. Bound once per run
    // (not per change) over the real drive_folder_path_cache-backed store.
    const folderPathCache = createFolderPathCache(deps);
    const resolveFolderPath = (args: { orgId: string; fileId: string; accessToken: string }) =>
      resolveDriveFolderPath({
        orgId: args.orgId,
        fileId: args.fileId,
        accessToken: args.accessToken,
        cache: folderPathCache,
        // PR #1944 review follow-up: without a logger, every resolution
        // failure was a completely silent swallow-to-null — pass one through
        // so a real failure (permission loss, an unexpected bug) actually
        // produces a log line instead of just quietly degrading rule matching.
        deps: { fetchImpl: deps.drive?.fetchImpl, logger: deps.logger },
      });
    // Fix-round item 4A: on-demand ownership re-check the processor calls
    // before every page — belt-and-suspenders alongside the heartbeat (see
    // driveChangesRunLeaseSpec's doc comment for why the heartbeat alone
    // cannot stop an in-flight walk that already lost the lease).
    const stillHoldsLease = () => stillHoldsRunLease(leaseClient, leaseSpec, holder);

    let result = await processDriveChanges({
      integration: {
        id: integration.id,
        org_id: integration.org_id,
        last_page_token: nonNullLastPageToken,
        watched_folder_ids: watched,
        last_token_advanced_at: integration.last_token_advanced_at ?? null,
      },
      accessToken,
      db,
      deps: { logger: deps.logger, resolveFolderPath, stillHoldsLease },
    });

    // Fix-round item 3: a push that arrived WHILE this run held the lease
    // must not be dropped. Bounded — exactly ONE extra pass, never a loop —
    // using the cursor THIS pass itself just committed (or, if that pass
    // itself lost the lease/CAS race, the ORIGINAL starting token — a
    // no-op re-run is harmless and cheap; it is not this pass's job to
    // resolve a race it already lost).
    const dirty = await checkAndClearRunLeaseDirty(leaseClient, leaseSpec);
    if (dirty) {
      const resumeToken = result.newPageToken ?? nonNullLastPageToken;
      deps.logger?.info?.(
        { integrationId: integration.id, orgId: integration.org_id, resumeToken },
        'drive runner: a push arrived while this run held the lease — running one more bounded pass before releasing',
      );
      const secondResult = await processDriveChanges({
        integration: {
          id: integration.id,
          org_id: integration.org_id,
          last_page_token: resumeToken,
          watched_folder_ids: watched,
          last_token_advanced_at: new Date().toISOString(),
        },
        accessToken,
        db,
        deps: { logger: deps.logger, resolveFolderPath, stillHoldsLease },
      });
      // Merge, do NOT replace. `result = secondResult` threw away pass 1's
      // work — and it did so in exactly the case this bounded second pass
      // exists to serve, so a run under-reported itself precisely when a
      // push landed mid-run. Counters are summed because they describe the
      // WHOLE run; `newPageToken` and the pass-2 flags come from the later
      // pass via the spread, because the cursor must never rewind.
      //
      // `cursorReset`, `leaseLost` and `cursorAdvanceLost` are declared
      // `?: true` and each documents a thing that HAPPENED during a pass —
      // "recovered from a 410/404", "detected it no longer holds the lease",
      // "the CAS reported advanced: false". They are history, not
      // current-state predicates, so a pass-1 occurrence must survive a
      // pass-2 that did not repeat it. OR them; never let the spread erase
      // one.
      result = {
        ...secondResult,
        changesProcessed: result.changesProcessed + secondResult.changesProcessed,
        queued: result.queued + secondResult.queued,
        parentMismatch: result.parentMismatch + secondResult.parentMismatch,
        duplicates: result.duplicates + secondResult.duplicates,
        pagesProcessed: result.pagesProcessed + secondResult.pagesProcessed,
        ...(result.cursorReset || secondResult.cursorReset ? { cursorReset: true as const } : {}),
        ...(result.leaseLost || secondResult.leaseLost ? { leaseLost: true as const } : {}),
        ...(result.cursorAdvanceLost || secondResult.cursorAdvanceLost
          ? { cursorAdvanceLost: true as const }
          : {}),
      };
    }

    return result;
  });

  if (!outcome.acquired) {
    // Fix-round item 3: mark the CURRENT holder dirty rather than dropping
    // this push — see markRunLeaseDirty's doc comment in run-lease.ts.
    await markRunLeaseDirty(leaseClient, leaseSpec, deps.logger);
    deps.logger?.info?.(
      { integrationId: integration.id, orgId: integration.org_id },
      'drive runner: another run already holds the per-integration lease — marked dirty for one more pass, skipping (single-flight)',
    );
    return { skipped: 'locked' };
  }
  return outcome.result;
}

/**
 * Periodic RECONCILIATION sweep (fix-round item 3, second half). A webhook
 * proves DELIVERY, not COMPLETENESS — a push can be dropped (a locked lease
 * whose dirty-mark write also failed, a Cloud Run instance recycled
 * mid-request, Drive itself failing to deliver). Called from the existing
 * hourly `drive-subscription-renewal.ts` sweep (see that file), this is the
 * backstop: for every connected `google_drive` integration whose cursor has
 * not advanced in over `staleForMs`, invoke `runDriveChanges`. Respects the
 * SAME single-flight lease and `SAFE_PAGE_LIMIT` as every other caller —
 * this is not a bypass, it is just another (bounded-count) source of
 * `beginRun` attempts. An org with zero enabled Drive rules is a cheap
 * no-op via `runDriveChanges`'s own existing `no_watched_folders` skip, so
 * this function does not need to duplicate that filter.
 */
export async function runDriveReconciliationSweep(
  deps: DriveChangesRunnerDeps & { staleForMs?: number; maxIntegrations?: number },
): Promise<{ scanned: number; ran: number; skipped: number; errored: number }> {
  const staleForMs = deps.staleForMs ?? 30 * 60_000;
  const maxIntegrations = deps.maxIntegrations ?? 25;
  const cutoff = new Date(Date.now() - staleForMs).toISOString();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any, arkova/missing-org-filter -- cross-org sweep by design (a cron, not a request)
  const { data, error } = await (deps.db as any)
    .from('org_integrations')
    .select('id, org_id, encrypted_tokens, token_kms_key_id, last_page_token, last_token_advanced_at')
    .eq('provider', 'google_drive')
    .is('revoked_at', null)
    .not('last_page_token', 'is', null)
    .or(`last_token_advanced_at.lt.${cutoff},last_token_advanced_at.is.null`)
    .limit(maxIntegrations);

  if (error) {
    deps.logger?.error?.({ error }, 'drive reconciliation sweep: integration scan failed');
    return { scanned: 0, ran: 0, skipped: 0, errored: 1 };
  }

  const rows = (data ?? []) as DriveIntegrationRow[];
  let ran = 0;
  let skipped = 0;
  let errored = 0;
  for (const row of rows) {
    try {
      const result = await runDriveChanges(row, deps);
      if ('skipped' in result) skipped += 1;
      else ran += 1;
    } catch (err) {
      errored += 1;
      deps.logger?.error?.(
        { err, integrationId: row.id, orgId: row.org_id },
        'drive reconciliation sweep: runDriveChanges failed for one integration — continuing with the rest',
      );
      reportDriveProcessingFailure(err, {
        stage: 'webhook_run_changes',
        orgId: row.org_id,
        integrationId: row.id,
      });
    }
  }
  return { scanned: rows.length, ran, skipped, errored };
}
