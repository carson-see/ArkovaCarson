/**
 * Eager Drive-folder → Arkova-folder mirroring at connect/rule-save time
 * (founder spec: "duplicate connected folders in Arkova automatically upon
 * setup... so users don't have to sort their own shit").
 *
 * THE GAP THIS CLOSES
 * -------------------
 * Migration 0462 already mirrors a connector-sourced Drive folder into
 * `public.folders` — but LAZILY, inside `resolve_connector_destination_folder`,
 * fired only the first time a document from that Drive folder is actually
 * materialized as an anchor (`trg_00_route_connector_anchor_to_folder` /
 * `trg_route_materialized_connector_anchor_to_folder`). If zero documents are
 * ever anchored from a connected folder, no Arkova folder ever appears — which
 * contradicts "upon setup". This module adds the EAGER half: mirror the
 * folder the moment an org connects/saves a Drive-folder watch rule
 * (`POST`/`PATCH /api/rules`, wired in `api/rules-crud.ts`).
 *
 * NO NEW MIGRATION. This reuses the exact `public.folders` row shape and the
 * SAME unique index the lazy SQL path already uses:
 * `idx_folders_connector_destination_unique` (migration 0462, already on
 * `origin/main`), a partial index on
 * `(owner_scope, coalesce(user_id, '00000000-...'), coalesce(org_id,
 * '00000000-...'), coalesce(context_org_id, '00000000-...'),
 * connector_provider, connector_source_id) WHERE connector_provider IS NOT
 * NULL`. It is NOT filtered to `owner_scope='ORG'` — it also covers
 * USER-scoped rows via the `coalesce(user_id, ...)` column — and it DOES key
 * on `context_org_id` in addition to `org_id`. This module only ever writes
 * `owner_scope='ORG'` rows and never sets `context_org_id`, so in practice
 * its own dedupe key is the narrower `(owner_scope='ORG', org_id,
 * connector_provider, connector_source_id)` slice of that index — but that
 * is this module's usage of the index, not the index's own definition; the
 * two paths can never create two rows for the same connected folder because
 * both hit the SAME underlying constraint, whichever runs first wins, the
 * other finds-and-reuses it.
 *
 * WHY NOT `folder_api_create` / `folder_api_update` (also shipped in 0462)
 * -------------------------------------------------------------------------
 * Those RPCs re-derive caller authorization inside Postgres via
 * `folder_api_administers_org()`, which checks ONLY `org_members` — it has
 * none of the "owner linked only via `profiles.org_id`" fallback that
 * `rules-crud.ts`'s own `requireOrgAdmin()` (and
 * `api/v1/integrations/drive-folders.ts`'s `isCallerOrgAdminResult`) already
 * correctly implement. By the time this module runs, `rules-crud.ts` has
 * ALREADY authorized the caller with the correct check — routing back through
 * a narrower one would silently drop mirroring for exactly the org-owner
 * accounts that landmine already burned once. Instead this module writes
 * directly against `public.folders` via the worker's service-role client,
 * the SAME idiom `rules-crud.ts` already uses for `organization_rules`
 * (explicit `.eq('org_id', orgId)` scoping instead of relying on RLS, which
 * service_role bypasses — see that file's own "cross-tenant guard" comments).
 *
 * NESTING (decision, flagged for founder/product sign-off — see agents.md)
 * -------------------------------------------------------------------------
 * `trigger_config.drive_folders[]` (SPEC-CONNECTORS / `DriveFolderPicker.tsx`)
 * carries only `{folder_id, folder_name}` today — no ancestor path. The
 * mirror folder created here is therefore FLAT (`parent_folder_id = NULL`),
 * one per connected Drive folder, named after that folder's own display
 * name. This matches the granularity the lazy 0462 path already has for a
 * file living directly inside the watched folder (both key off the SAME
 * Drive folder id in that case). A deeply nested Drive tree mirroring as a
 * matching nested Arkova tree is out of scope — punted, not invented.
 *
 * §1.6 / §1.6A: this module NEVER touches document bytes, only ids and
 * display names already resolved by the Drive folder picker endpoint.
 */
import { createHash } from 'node:crypto';
import { parseDriveFolderBindings } from './drive-folder-bindings.js';
import { GOOGLE_DRIVE_VENDOR } from '../../constants/connectors.js';

export interface DriveFolderToMirror {
  folderId: string;
  folderName: string | null;
}

export type MirrorOutcome = 'created' | 'existing' | 'skipped_no_connection' | 'error';

export interface MirrorConnectedDriveFolderResult {
  /** `public.folders.id` — empty string when nothing was created/found (error/skip). */
  folderId: string;
  driveFolderId: string;
  outcome: MirrorOutcome;
  error?: string;
}

// Loosely-typed on purpose (mirrors the pattern in
// `api/v1/integrations/drive-folders.ts`'s `DriveFoldersRouterDeps.db`): a real
// SupabaseClient satisfies this structurally, and a test double doesn't need
// every generic overload of `.from()` to match.
export interface DriveFolderMirrorDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from: (table: string) => any;
}

export interface DriveFolderMirrorDeps {
  db: DriveFolderMirrorDb;
  logger?: {
    warn: (...a: unknown[]) => void;
    error: (...a: unknown[]) => void;
  };
}

const FOLDER_NAME_MAX = 88;
const UNIQUE_VIOLATION = '23505';
export const DRIVE_FOLDER_MIRROR_FAILED_EVENT = 'drive_folder_mirror_failed';
export const DRIVE_FOLDER_MIRROR_RECOVERED_EVENT = 'drive_folder_mirror_recovered';

/**
 * Extracts `{folder_id, folder_name}` pairs from a rule's `trigger_config`,
 * tolerant of the picker's current shape and defensive against a malformed
 * or absent `drive_folders` array (e.g. any non-Drive `trigger_config`,
 * which returns `[]` — those rules are entirely unaffected by this module).
 * De-dupes by folder id. Array selections are authoritative because they carry
 * the user-visible folder name; the legacy singular binding is appended only
 * when it is genuinely a `drive_folder` and not already selected.
 */
export function extractDriveFoldersToMirror(
  triggerConfig: Record<string, unknown> | null | undefined,
): DriveFolderToMirror[] {
  return parseDriveFolderBindings(triggerConfig).map(({ folderId, folderName }) => ({
    folderId,
    folderName: folderName ?? null,
  }));
}

const CONNECTOR_TAG_RE = /^connector-([a-z0-9_]+)$/;

/**
 * Scopes mirroring to the Connectors page's OWN Drive rule
 * (`action_config.tag === 'connector-google_drive'`, the same marker
 * `rules-crud.ts`'s `isConnectorManagedActionConfig` already recognizes) —
 * never an arbitrary `WORKSPACE_FILE_MODIFIED` rule a RulesPage/RuleBuilderPage
 * admin builds by hand with a differently-shaped `trigger_config`.
 */
export function shouldMirrorDriveFoldersForRule(triggerType: string, actionConfig: unknown): boolean {
  if (triggerType !== 'WORKSPACE_FILE_MODIFIED') return false;
  if (!actionConfig || typeof actionConfig !== 'object') return false;
  const tag = (actionConfig as Record<string, unknown>).tag;
  if (typeof tag !== 'string') return false;
  const match = CONNECTOR_TAG_RE.exec(tag);
  return match?.[1] === GOOGLE_DRIVE_VENDOR;
}

/** Same naming convention as `resolve_connector_destination_folder` (0462): a
 * short id-hash suffix keeps a system-managed mirror from colliding with, or
 * being confused with, a folder a user made by hand with the same plain name. */
function deriveMirrorFolderName(driveFolderId: string, folderName: string | null): string {
  const base = (folderName && folderName.trim().length > 0 ? folderName.trim() : 'Google Drive').slice(0, FOLDER_NAME_MAX);
  const suffix = createHash('md5').update(driveFolderId).digest('hex').slice(0, 8).toUpperCase();
  return `${base} · ${suffix}`;
}

/**
 * A genuine DB error looking up the active connection (network blip,
 * transient outage) must never be conflated with "this org has never
 * connected Drive" — the first is retryable (the next rule save, or a
 * future durable-retry path, should try again), the second is a legitimate
 * terminal state (nothing to retry until the org actually connects).
 * Review P2 (feat/mirror-connected-drive-folders).
 */
export type ActiveConnectionLookup =
  | { kind: 'found'; connection: { id: string } }
  | { kind: 'none' }
  | { kind: 'error'; error: unknown };

/**
 * Exported (DRIVE-BACKFILL, founder directive 2026-09-29): the initial-sync
 * trigger (`drive-initial-sync-trigger.ts`) needs the SAME "which Drive
 * connection is currently active for this org" answer this module already
 * resolves for the folder mirror — reusing it means the two features can
 * never silently disagree about which connection backs a rule's folders.
 */
export async function loadActiveDriveConnection(db: DriveFolderMirrorDb, orgId: string): Promise<ActiveConnectionLookup> {
  const { data, error } = await db
    .from('org_integrations')
    .select('id')
    .eq('org_id', orgId)
    .eq('provider', GOOGLE_DRIVE_VENDOR)
    .is('revoked_at', null)
    .order('connected_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return { kind: 'error', error };
  if (!data) return { kind: 'none' };
  return { kind: 'found', connection: data as { id: string } };
}

async function findExistingMirror(
  db: DriveFolderMirrorDb,
  orgId: string,
  driveFolderId: string,
): Promise<{ data: { id: string; connector_connection_id: string | null } | null; error: unknown }> {
  return db
    .from('folders')
    .select('id, connector_connection_id')
    .eq('owner_scope', 'ORG')
    .eq('org_id', orgId)
    .eq('connector_provider', GOOGLE_DRIVE_VENDOR)
    .eq('connector_source_id', driveFolderId)
    .maybeSingle();
}

async function refreshConnectionIfStale(
  db: DriveFolderMirrorDb,
  orgId: string,
  folderId: string,
  currentConnectionId: string | null,
  connectionId: string,
  logger: DriveFolderMirrorDeps['logger'],
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  if (currentConnectionId === connectionId) return { ok: true };
  const { error, count } = await db
    .from('folders')
    .update({ connector_connection_id: connectionId }, { count: 'exact' })
    .eq('id', folderId)
    .eq('org_id', orgId);
  if (error || count !== 1) {
    const failure = error ?? new Error(`connection refresh affected ${String(count)} rows`);
    logger?.warn?.({ error: failure, orgId, folderId }, 'drive-folder-mirror: connection refresh failed');
    return { ok: false, error: failure };
  }
  return { ok: true };
}

function mirrorErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/** Finds or creates the ORG-scoped Arkova mirror folder for ONE connected Drive
 * folder. Idempotent under contention: a concurrent insert (two saves racing)
 * is caught as a Postgres unique_violation (23505) and resolved by
 * re-selecting the winner's row rather than erroring. */
async function upsertOne(
  db: DriveFolderMirrorDb,
  args: { orgId: string; actorUserId: string | null; connectionId: string; folder: DriveFolderToMirror },
  logger: DriveFolderMirrorDeps['logger'],
): Promise<MirrorConnectedDriveFolderResult> {
  const { orgId, actorUserId, connectionId, folder } = args;

  const { data: existing, error: selectError } = await findExistingMirror(db, orgId, folder.folderId);
  if (selectError) {
    logger?.error?.({ error: selectError, orgId, driveFolderId: folder.folderId }, 'drive-folder-mirror: lookup failed');
    return { folderId: '', driveFolderId: folder.folderId, outcome: 'error', error: String(selectError) };
  }
  if (existing?.id) {
    const refresh = await refreshConnectionIfStale(
      db, orgId, existing.id, existing.connector_connection_id, connectionId, logger,
    );
    if (!refresh.ok) {
      return {
        folderId: existing.id,
        driveFolderId: folder.folderId,
        outcome: 'error',
        error: mirrorErrorText(refresh.error),
      };
    }
    return { folderId: existing.id, driveFolderId: folder.folderId, outcome: 'existing' };
  }

  const { data: created, error: insertError } = await db
    .from('folders')
    .insert({
      owner_scope: 'ORG',
      org_id: orgId,
      name: deriveMirrorFolderName(folder.folderId, folder.folderName),
      created_by: actorUserId,
      connector_provider: GOOGLE_DRIVE_VENDOR,
      connector_source_id: folder.folderId,
      connector_connection_id: connectionId,
      is_system_managed: true,
    })
    .select('id')
    .single();

  if (insertError) {
    const code = (insertError as { code?: string }).code;
    if (code === UNIQUE_VIOLATION) {
      const { data: winner, error: reselectError } = await findExistingMirror(db, orgId, folder.folderId);
      if (!reselectError && winner?.id) {
        const refresh = await refreshConnectionIfStale(
          db, orgId, winner.id, winner.connector_connection_id, connectionId, logger,
        );
        if (!refresh.ok) {
          return { folderId: winner.id, driveFolderId: folder.folderId, outcome: 'error', error: mirrorErrorText(refresh.error) };
        }
        return { folderId: winner.id, driveFolderId: folder.folderId, outcome: 'existing' };
      }
    }
    logger?.error?.({ error: insertError, orgId, driveFolderId: folder.folderId }, 'drive-folder-mirror: create failed');
    return { folderId: '', driveFolderId: folder.folderId, outcome: 'error', error: String(insertError) };
  }

  return { folderId: (created as { id: string }).id, driveFolderId: folder.folderId, outcome: 'created' };
}

/**
 * Mirrors every connected Drive folder for one org into its own ORG-scoped
 * `public.folders` row, idempotently. Non-fatal by design (mirrors
 * `emitRuleAudit`'s fire-and-forget contract in `rules-crud.ts`): every
 * failure mode returns a result entry rather than throwing, so a caller can
 * `void` this without risking an unhandled rejection or blocking the rule
 * save response.
 *
 * Touches NEITHER table when `folders` is empty (a non-Drive rule, or a
 * Drive rule not yet naming any folders) — nothing to mirror, nothing to do.
 */
export async function mirrorConnectedDriveFolders(
  deps: DriveFolderMirrorDeps,
  args: { orgId: string; actorUserId: string | null; ruleId?: string; folders: DriveFolderToMirror[] },
): Promise<MirrorConnectedDriveFolderResult[]> {
  const { orgId, actorUserId, folders } = args;
  if (folders.length === 0) return [];

  const lookup = await loadActiveDriveConnection(deps.db, orgId);
  if (lookup.kind === 'error') {
    // Retryable: a DB blip here says nothing about whether the org has a
    // connection — it says the lookup itself didn't complete. Surfacing
    // 'error' (not 'skipped_no_connection') lets a caller distinguish "try
    // again" from "nothing to do until the org connects Drive".
    deps.logger?.error?.({ error: lookup.error, orgId }, 'drive-folder-mirror: active-connection lookup failed (retryable)');
    const results = folders.map((f) => ({ folderId: '', driveFolderId: f.folderId, outcome: 'error' as const, error: String(lookup.error) }));
    // Preserve the original lookup failure as the returned result even when
    // the best-effort durable health marker is itself unavailable.
    if (args.ruleId) await recordDriveFolderMirrorState(deps, args.orgId, args.ruleId, results);
    return results;
  }
  if (lookup.kind === 'none') {
    deps.logger?.warn?.({ orgId }, 'drive-folder-mirror: no active Drive connection — skipping mirror');
    return folders.map((f) => ({ folderId: '', driveFolderId: f.folderId, outcome: 'skipped_no_connection' as const }));
  }
  const connection = lookup.connection;

  // Per-folder isolation (review finding, feat/mirror-connected-drive-folders):
  // `upsertOne` already converts DB-layer `{data,error}` failures into a
  // returned `outcome: 'error'`, but that conversion can only happen for a
  // call that actually returns. A genuine JS exception — a dropped
  // connection, a client library throw, anything that isn't a Supabase
  // `{data,error}` response — is a different failure mode, and without a
  // try/catch AROUND each iteration it unwinds this whole `for` loop: every
  // folder after the one that threw is silently never attempted, and the
  // caller (`rules-crud.ts`'s fire-and-forget `.catch`) only ever sees one
  // generic 'drive-folder-mirror wiring failed' warning with no per-folder
  // detail. Isolating each iteration means one folder's exception can never
  // suppress the others, and the exception itself is logged with the
  // specific `driveFolderId` that caused it.
  //
  // This is a diagnosability/completeness fix, not a data-integrity one: the
  // migration-0462 lazy mirror path is the backstop for any folder that
  // still has no mirror row, and re-saving the rule re-runs this whole
  // function, so a partial mirror always self-repairs on the next save.
  const results: MirrorConnectedDriveFolderResult[] = [];
  for (const folder of folders) {
    try {
      results.push(await upsertOne(deps.db, { orgId, actorUserId, connectionId: connection.id, folder }, deps.logger));
    } catch (error) {
      deps.logger?.error?.(
        { error, orgId, driveFolderId: folder.folderId },
        'drive-folder-mirror: unexpected exception mirroring one folder — continuing with remaining folders',
      );
      results.push({ folderId: '', driveFolderId: folder.folderId, outcome: 'error', error: String(error) });
    }
  }
  if (args.ruleId && !(await recordDriveFolderMirrorState(deps, args.orgId, args.ruleId, results))) {
    results.push({ folderId: '', driveFolderId: '', outcome: 'error', error: 'mirror_health_state_write_failed' });
  }
  return results;
}

export async function recordDriveFolderMirrorState(
  deps: DriveFolderMirrorDeps,
  orgId: string,
  ruleId: string,
  results: MirrorConnectedDriveFolderResult[],
): Promise<boolean> {
  const failed = results.some(({ outcome }) => outcome === 'error');
  const completed = results.length > 0 && results.every(({ outcome }) => outcome === 'created' || outcome === 'existing');
  if (!failed && !completed) return true;
  const eventType = failed ? DRIVE_FOLDER_MIRROR_FAILED_EVENT : DRIVE_FOLDER_MIRROR_RECOVERED_EVENT;
  try {
    const latest = await deps.db.from('audit_events')
      .select('event_type').eq('org_id', orgId).eq('target_type', 'organization_rules').eq('target_id', ruleId)
      .in('event_type', [DRIVE_FOLDER_MIRROR_FAILED_EVENT, DRIVE_FOLDER_MIRROR_RECOVERED_EVENT])
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (latest.error) throw latest.error;
    if ((latest.data as { event_type?: unknown } | null)?.event_type === eventType) return true;
    const inserted = await deps.db.from('audit_events').insert({
      event_type: eventType,
      event_category: 'WEBHOOK',
      org_id: orgId,
      target_type: 'organization_rules',
      target_id: ruleId,
      details: { reason: failed ? 'folder_mirror_failed' : 'folder_mirror_recovered' },
    });
    if (inserted.error) throw inserted.error;
    return true;
  } catch (error) {
    deps.logger?.error?.({ error, orgId, ruleId, eventType }, 'drive-folder-mirror: durable health-state write failed');
    return false;
  }
}
