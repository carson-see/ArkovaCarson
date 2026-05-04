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
import {
  refreshAccessToken,
  type DriveClientDeps,
} from '../oauth/drive.js';
import {
  decryptTokens,
  encryptTokens,
  type KmsClient,
  type OAuthTokens,
} from '../oauth/crypto.js';
import {
  processDriveChanges,
  type DriveProcessorDb,
  type DriveProcessorIntegration,
  type ProcessChangesResult,
} from './drive-changes-processor.js';

const ACCESS_TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;

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
 * Decrypt → optionally refresh → re-encrypt+persist. Returns the access
 * token usable against the Drive API. The caller does NOT need to know
 * whether a refresh happened.
 */
export async function loadDriveAccessToken(
  integration: DriveIntegrationRow,
  deps: Pick<DriveChangesRunnerDeps, 'db' | 'kms' | 'drive' | 'env' | 'now'>,
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

  const refreshed = await refreshAccessToken({
    refreshToken: tokens.refresh_token,
    deps: deps.drive,
  });
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
  // CAS write — only succeeds if no other concurrent refresh has
  // already mutated `encrypted_tokens` since we read it.
  // CodeRabbit ASSERTIVE on PR #696 (8ea5dc40): distinguish DB error
  // from CAS miss. A failed write that fell through to "another
  // refresher won" would silently return the stale pre-refresh token
  // as if the refresh succeeded, turning a persistence/read failure
  // into a silent auth bug.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: persistedRow, error: writeError } = await (deps.db as any)
    .from('org_integrations')
    .update({
      encrypted_tokens: `\\x${reencrypted.ciphertext.toString('hex')}`,
      token_kms_key_id: reencrypted.keyId,
      updated_at: now.toISOString(),
    })
    .eq('id', integration.id)
    .eq('encrypted_tokens', prevCiphertextHex)
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    deps.logger?.warn?.({ error, orgId }, 'loadWatchedFolderIds: rule lookup failed');
    return [];
  }
  const ids = new Set<string>();
  for (const row of (data ?? []) as Array<{ trigger_config?: Record<string, unknown> | null }>) {
    const cfg = row.trigger_config ?? {};
    if (typeof cfg.folder_id === 'string' && cfg.folder_id.length > 0) {
      ids.add(cfg.folder_id);
    }
    const arr = (cfg.drive_folders ?? []) as Array<{ folder_id?: unknown }>;
    if (Array.isArray(arr)) {
      for (const entry of arr) {
        if (entry && typeof entry.folder_id === 'string' && entry.folder_id.length > 0) {
          ids.add(entry.folder_id);
        }
      }
    }
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
  return {
    async insertRevisionLedger(row) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (deps.db as any)
        .from('drive_revision_ledger')
        .insert(row);
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
        // Compensating delete — log but don't throw; the next pass will
        // see this revision as already-processed (correct from a dedupe
        // standpoint) and the queue will simply lack an event for it.
        log?.warn?.({ error, key }, 'drive_revision_ledger compensating delete failed');
      }
    },
    async advancePageToken({ integration_id, new_page_token }) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (deps.db as any)
        .from('org_integrations')
        .update({
          last_page_token: new_page_token,
          last_token_advanced_at: new Date().toISOString(),
        })
        .eq('id', integration_id);
      if (error) throw error;
    },
    async enqueueRuleEvent(payload) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (deps.db.rpc as any)('enqueue_rule_event', {
        p_org_id: payload.org_id,
        p_trigger_type: 'WORKSPACE_FILE_MODIFIED',
        p_vendor: 'google_drive',
        p_external_file_id: payload.file_id,
        p_filename: payload.filename ?? null,
        p_folder_path: null,
        p_sender_email: payload.actor_email,
        p_subject: null,
        p_payload: {
          source: 'google_drive',
          file_id: payload.file_id,
          parent_ids: payload.parent_ids,
          revision_id: payload.revision_id,
          integration_id: payload.integration_id,
          actor_email: payload.actor_email,
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
  };
}

/**
 * Top-level runner. Webhook handler calls this with the resolved
 * integration row; everything else is dependency-injected.
 */
export async function runDriveChanges(
  integration: DriveIntegrationRow,
  deps: DriveChangesRunnerDeps,
): Promise<ProcessChangesResult | { skipped: 'no_page_token' | 'no_watched_folders' }> {
  // Bootstrap guard — Drive integrations created BEFORE migration 0288 may
  // have last_page_token=null. Without it the processor can't even call
  // changes.list. Fail soft (skip + log); the watch-renewal monitor will
  // re-bootstrap on next renewal pass per createChangesWatch().
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

  const { accessToken } = await loadDriveAccessToken(integration, deps);
  const procIntegration: DriveProcessorIntegration = {
    id: integration.id,
    org_id: integration.org_id,
    last_page_token: integration.last_page_token,
    watched_folder_ids: watched,
  };
  const db = createProcessorDbAdapter(deps);
  return processDriveChanges({
    integration: procIntegration,
    accessToken,
    db,
    deps: { logger: deps.logger },
  });
}
