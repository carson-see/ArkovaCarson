#!/usr/bin/env tsx
/**
 * PR #3086 mirror-connected-drive-folders admission driver
 * (`feat/mirror-connected-drive-folders`, head `3156a1e28`, T2).
 *
 * WHY THIS DRIVER EXISTS, NOT THE PR-1408 DEFAULT
 * ------------------------------------------------
 * `scripts/staging/provision-isolated-rig.sh` defaults `driver_path` to
 * `pr1408-chain-resilience-driver.ts` (chain retry/backoff/duplicate-tx
 * semantics). That drives ZERO of what #3086 changed. Set
 * `STAGING_DRIVER_PATH=services/worker/scripts/pr3086-drive-folder-mirror-driver.ts`
 * before provisioning.
 *
 * WHAT #3086 CHANGES
 * -------------------
 * Migration 0462 already mirrors a connector-sourced Drive folder into
 * `public.folders`, but LAZILY — only the first time a document from that
 * folder is actually anchored. `services/worker/src/integrations/connectors/
 * drive-folder-mirror.ts` (new, this PR) adds the EAGER half: the moment an
 * org saves a Google-Drive-connector-managed rule (`POST`/`PATCH
 * /admin/rules`, wired via `mirrorDriveFoldersForRuleWrite` in
 * `api/rules-crud.ts`), every folder in `trigger_config.drive_folders[]` gets
 * its own ORG-scoped `public.folders` row immediately, fire-and-forget
 * (`void mirrorConnectedDriveFolders(...).catch(...)`) so it never gates the
 * save response. It reuses 0462's exact unique index
 * (`idx_folders_connector_destination_unique`) so the eager and lazy paths
 * can never create two rows for the same connected folder. The PR's own
 * review pass added per-folder isolation inside `mirrorConnectedDriveFolders`
 * itself: a genuine thrown JS exception mirroring ONE folder must not abort
 * the loop and silently skip every folder after it.
 *
 * THE FOUR ASSERTIONS — how each is measured and how each can FAIL
 * -------------------------------------------------------------------
 *  1. TWO_FOLDERS_MIRRORED — saving a connector-managed Drive rule with 2
 *     `drive_folders` entries eventually produces exactly 2 `public.folders`
 *     rows (`owner_scope='ORG'`, `connector_provider='google_drive'`,
 *     `connector_source_id` = each Drive folder id), polled after the save
 *     since mirroring is fire-and-forget. FAILS if 0, 1, or >2 rows appear —
 *     0/1 means the eager mirror never ran (or ran for only one folder); >2
 *     means a duplicate was created instead of the unique index being reused.
 *  2. IDEMPOTENT_RESAVE_NO_DUPLICATES — re-saving the SAME rule with the SAME
 *     `drive_folders` (a PATCH carrying `trigger_config` again) must create
 *     NO additional folder rows and must not change the existing rows'
 *     `id`s. FAILS if the folder count grows, or if any id changed (both mean
 *     `upsertOne`'s find-existing-or-insert path stopped reusing the row).
 *  3. TENANT_ISOLATION_NO_COLLISION — the SAME `connector_source_id` (Drive
 *     folder id) connected under a SECOND, independent org must mirror into
 *     its OWN, DISTINCT `public.folders` row — never the first org's row.
 *     FAILS if both orgs end up pointing at the same `folders.id` — the
 *     dedupe index is `(owner_scope, org_id, connector_provider,
 *     connector_source_id)`, so a collision here would mean org scoping was
 *     dropped somewhere between the rule save and the mirror write.
 *  4. PARTIAL_FAILURE_DOES_NOT_SUPPRESS_OTHERS — the review-added per-item
 *     isolation. See the SCOPING NOTE below: this drives the REAL, production
 *     `mirrorConnectedDriveFolders` (vendored — see below), fault-injected
 *     via its own `DriveFolderMirrorDeps.db`, not a local reimplementation.
 *
 * SCOPING NOTE ON ASSERTION 4 (read before citing it as live-rig evidence)
 * ---------------------------------------------------------------------------
 * `mirrorConnectedDriveFolders`'s per-folder try/catch (in
 * `services/worker/src/integrations/connectors/drive-folder-mirror.ts`, on
 * PR #3086's own branch, `feat/mirror-connected-drive-folders`) exists
 * specifically for a genuine JS exception — "a dropped connection, a client
 * library throw, anything that isn't a Supabase `{data,error}` response"
 * (the module's own header comment). Every ordinary DB-layer failure
 * (`upsertOne`'s `{error}` branches, including the unique-violation retry) is
 * ALREADY converted to a returned `outcome: 'error'` and cannot demonstrate
 * this fix — that path existed before the review finding. Forcing an actual
 * uncaught throw through the REAL Supabase client from OUTSIDE the worker
 * (over HTTP, as assertions 1–3 do) is not reliably reachable: there is no
 * black-box lever to make the Supabase client itself throw for exactly one
 * row in a batch while behaving normally for the others.
 *
 * THIS DRIVER FILE LIVES ON `feat/t2-soak-drivers`. PR #3086
 * (`feat/mirror-connected-drive-folders`) is still open and unmerged, so
 * `services/worker/src/integrations/connectors/drive-folder-mirror.ts` does
 * not exist on this branch's own `src/` tree — importing it from there would
 * fail both `tsc --noEmit` and actual `tsx` invocation.
 *
 * FIX (independent review finding on this driver): rather than
 * reimplementing the loop shape locally — which can silently drift from what
 * actually ships and stop being evidence of anything — the real file is
 * VENDORED byte-for-byte into `services/worker/scripts/vendor/
 * pr3086-drive-folder-mirror.ts` (see that file's own header for provenance,
 * the exact source commit, and the re-sync procedure). Assertion 4 imports
 * `mirrorConnectedDriveFolders` from THAT vendored copy and fault-injects it
 * via a fake `DriveFolderMirrorDb` (`buildFaultInjectingMirrorDb`, below)
 * whose `folders` insert throws a genuine JS exception for exactly one
 * folder id — the same fault class the module's own header describes. This
 * is the REAL function's REAL per-iteration try/catch under test, driven
 * through its own injected dependency seam, not a parallel reimplementation.
 * When PR #3086 merges, delete the vendor file and import the real path
 * directly instead (see that file's header).
 *
 * This is deterministic, requires neither network nor a database, and is
 * therefore run in BOTH self-test AND live mode identically — but it is NOT
 * live-rig evidence that the actually-deployed code on the isolated rig
 * matches the vendored copy exactly (see the vendor file's KEEP IN SYNC
 * note), and this driver says so plainly rather than padding its count with
 * a probe that can never independently fail against the deployed rig.
 *
 * Self-test mode overall is local validation only for assertions 1–3: those
 * rows are `evidenceForSoak=false` and must never be cited as T2 soak
 * evidence. Assertion 4 does not depend on the rig either way — see above.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  mirrorConnectedDriveFolders,
  type DriveFolderMirrorDb,
  type DriveFolderToMirror,
} from './vendor/pr3086-drive-folder-mirror.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CHANGED_BEHAVIOR =
  'PR #3086: saving a connector-managed Google Drive rule (POST/PATCH /admin/rules with '
  + "action_config.tag='connector-google_drive') eagerly mirrors every trigger_config.drive_folders[] "
  + "entry into its own ORG-scoped public.folders row, fire-and-forget, reusing migration 0462's exact "
  + 'unique index so it can never collide with the lazy anchor-time mirror. Per-folder isolation (review '
  + 'finding) means a genuine thrown exception mirroring one folder must not suppress the others.';

export const ASSERTION = {
  TWO_FOLDERS_MIRRORED: 'two_drive_folders_mirrored_on_save',
  IDEMPOTENT_RESAVE_NO_DUPLICATES: 'idempotent_resave_creates_no_additional_folders',
  TENANT_ISOLATION_NO_COLLISION: 'tenant_isolation_same_source_id_no_collision',
  PARTIAL_FAILURE_ISOLATION: 'partial_failure_does_not_suppress_other_folders',
} as const;

/** Fixture prefix so every row/user this driver creates is identifiable and reapable. */
export const FIXTURE_PREFIX = 'pr3086-soak';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DriverMode = 'self-test' | 'live';

export interface DriverArgs {
  mode: DriverMode;
  targetUrl?: string;
  admissionJson?: string;
  evidenceJsonl?: string;
  durationMin: number;
  intervalSec: number;
}

export interface ProbeResult {
  name: string;
  status: 'pass' | 'fail';
  detail: string;
}

export interface DriverRow {
  utc: string;
  pr: 3086;
  tier: 'T2';
  mode: DriverMode;
  evidenceForSoak: boolean;
  changedBehavior: string;
  status: 'pass' | 'fail';
  cycle: number;
  counts: Record<string, number | boolean>;
  probes: ProbeResult[];
  admission?: Record<string, unknown>;
  blockers?: string[];
}

/** Minimal shape this driver reads back off a `folders` row. */
export interface MirrorFolderFacts {
  id: string;
  org_id: string;
  connector_source_id: string;
}

// ---------------------------------------------------------------------------
// Pure classifiers — unit-testable without a network or a database.
// ---------------------------------------------------------------------------

function probe(name: string, ok: boolean, detail: string): ProbeResult {
  return { name, status: ok ? 'pass' : 'fail', detail };
}

/** Assertion 1. */
export function classifyTwoFoldersMirrored(rows: MirrorFolderFacts[]): ProbeResult {
  const ids = rows.map((r) => r.id);
  const distinct = new Set(ids).size === ids.length;
  return probe(
    ASSERTION.TWO_FOLDERS_MIRRORED,
    rows.length === 2 && distinct && ids.every((id) => id.length > 0),
    `found ${rows.length} mirror folder row(s) (ids=[${ids.join(', ')}]) after saving a rule with 2 `
      + 'drive_folders (expected exactly 2 distinct, non-empty rows)',
  );
}

/** Assertion 2. Re-saving must reuse the SAME rows — no growth, no id churn. */
export function classifyIdempotentResave(args: {
  idsBeforeResave: string[];
  idsAfterResave: string[];
}): ProbeResult {
  const beforeSet = new Set(args.idsBeforeResave);
  const afterSet = new Set(args.idsAfterResave);
  const sameCount = beforeSet.size === afterSet.size;
  const sameIds = [...beforeSet].every((id) => afterSet.has(id));
  return probe(
    ASSERTION.IDEMPOTENT_RESAVE_NO_DUPLICATES,
    sameCount && sameIds && beforeSet.size > 0,
    `ids before=[${[...beforeSet].join(', ')}], after=[${[...afterSet].join(', ')}] (expected identical `
      + 'sets — a re-save must find-and-reuse via the unique index, never insert a duplicate)',
  );
}

/** Assertion 3. THE ACTUAL DEFECT SURFACE: same source id, two orgs, must never collide. */
export function classifyTenantIsolationNoCollision(args: {
  org1FolderId: string;
  org2FolderId: string;
}): ProbeResult {
  if (!args.org1FolderId || !args.org2FolderId) {
    return probe(
      ASSERTION.TENANT_ISOLATION_NO_COLLISION,
      false,
      `one or both orgs produced no mirror folder at all (org1=${args.org1FolderId || '(none)'}, `
        + `org2=${args.org2FolderId || '(none)'}) — cannot assert isolation without both existing`,
    );
  }
  if (args.org1FolderId === args.org2FolderId) {
    return probe(
      ASSERTION.TENANT_ISOLATION_NO_COLLISION,
      false,
      `both orgs resolved to the SAME folders.id (${args.org1FolderId}) for the same connector_source_id `
        + '— org scoping was dropped somewhere between the rule save and the mirror write',
    );
  }
  return probe(
    ASSERTION.TENANT_ISOLATION_NO_COLLISION,
    true,
    `org1 folder=${args.org1FolderId}, org2 folder=${args.org2FolderId} — distinct rows for the same `
      + 'connector_source_id under two different orgs',
  );
}

/**
 * Assertion 4 — see the SCOPING NOTE in the file header. Runs the LOCAL
 * REIMPLEMENTATION of the reviewed per-item isolation loop
 * (`driverMirrorFolders`, below) against a fault that throws a genuine JS
 * exception for exactly one folder id.
 */
export function classifyPartialFailureIsolation(
  results: Array<{ driveFolderId: string; outcome: string }>,
  faultInjectedFolderId: string,
): ProbeResult {
  const faulty = results.find((r) => r.driveFolderId === faultInjectedFolderId);
  const others = results.filter((r) => r.driveFolderId !== faultInjectedFolderId);
  if (results.length !== 3) {
    return probe(
      ASSERTION.PARTIAL_FAILURE_ISOLATION,
      false,
      `expected exactly 3 results (one per folder), got ${results.length} — a thrown exception on one `
        + 'folder unwound the loop and suppressed the others entirely (the pre-review-fix defect)',
    );
  }
  const faultyIsError = faulty?.outcome === 'error';
  const othersSucceeded = others.every((r) => r.outcome === 'created' || r.outcome === 'existing');
  return probe(
    ASSERTION.PARTIAL_FAILURE_ISOLATION,
    faultyIsError && othersSucceeded,
    `faulty folder outcome=${faulty?.outcome ?? '(missing)'} (expected error), other outcomes=`
      + `[${others.map((r) => `${r.driveFolderId}:${r.outcome}`).join(', ')}] (expected all `
      + 'created/existing — one exception must never suppress mirroring of the rest)',
  );
}

/** A cycle passes only if every probe in it passed. One failure fails the row. */
export function aggregate(probes: ProbeResult[]): 'pass' | 'fail' {
  return probes.some((p) => p.status === 'fail') ? 'fail' : 'pass';
}

/** Per-assertion counters, so a reviewer can count coverage without re-reading probes. */
export function tally(probes: ProbeResult[]): Record<string, number | boolean> {
  const counts: Record<string, number | boolean> = {};
  for (const name of Object.values(ASSERTION)) {
    const inFamily = probes.filter((p) => p.name === name);
    counts[`${name}_ran`] = inFamily.length > 0;
    counts[`${name}_passed`] = inFamily.length > 0 && inFamily.every((p) => p.status === 'pass');
  }
  counts.probes_total = probes.length;
  counts.probes_failed = probes.filter((p) => p.status === 'fail').length;
  return counts;
}

// ---------------------------------------------------------------------------
// Assertion 4 — fault-injects the REAL, vendored `mirrorConnectedDriveFolders`
// (see the SCOPING NOTE in the file header) via its own injected
// `DriveFolderMirrorDb`. No reimplementation of its loop body lives here.
// ---------------------------------------------------------------------------

interface FaultInjectingDbArgs {
  connectionId: string;
  faultFolderId: string;
}

/**
 * A minimal fake `DriveFolderMirrorDb` — real injected DEPS, not a stub of
 * the algorithm under test. `.from('org_integrations')` resolves an active
 * connection; `.from('folders')` reports no pre-existing mirror for any
 * folder (so every folder takes the INSERT path), and the insert itself
 * throws a genuine JS exception (never a returned `{data,error}`) for
 * exactly `faultFolderId` — "a dropped connection, a client library throw,
 * anything that isn't a Supabase `{data,error}` response", the exact fault
 * class `mirrorConnectedDriveFolders`'s own header describes its per-
 * iteration try/catch as guarding against. Every other folder resolves
 * normally.
 */
function buildFaultInjectingMirrorDb(args: FaultInjectingDbArgs): DriveFolderMirrorDb {
  return {
    from(table: string) {
      let insertPayload: Record<string, unknown> | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        order: () => chain,
        limit: () => chain,
        update: () => chain,
        insert: (payload: Record<string, unknown>) => {
          insertPayload = payload;
          return chain;
        },
        maybeSingle: async () => {
          if (table === 'org_integrations') {
            return { data: { id: args.connectionId }, error: null };
          }
          // `folders` existing-mirror lookup — nothing pre-exists for any folder.
          return { data: null, error: null };
        },
        single: async () => {
          const driveFolderId = insertPayload?.connector_source_id as string | undefined;
          if (driveFolderId === args.faultFolderId) {
            throw new Error(`simulated client-library throw mirroring folder ${driveFolderId}`);
          }
          return { data: { id: `mirror-${driveFolderId ?? 'unknown'}` }, error: null };
        },
      };
      return chain;
    },
  };
}

/**
 * Calls the REAL, vendored `mirrorConnectedDriveFolders` with a fault-
 * injecting fake db. Rig-independent — safe to call in both self-test and
 * live mode; see the file header's SCOPING NOTE for what this does and does
 * not prove.
 */
export async function runPartialFailureIsolationProbe(): Promise<ProbeResult> {
  const faultInjectedFolderId = `${FIXTURE_PREFIX}-fault-folder`;
  const folders: DriveFolderToMirror[] = [
    { folderId: `${FIXTURE_PREFIX}-ok-folder-1`, folderName: null },
    { folderId: faultInjectedFolderId, folderName: null },
    { folderId: `${FIXTURE_PREFIX}-ok-folder-2`, folderName: null },
  ];
  const db = buildFaultInjectingMirrorDb({
    connectionId: `${FIXTURE_PREFIX}-connection`,
    faultFolderId: faultInjectedFolderId,
  });
  const results = await mirrorConnectedDriveFolders(
    { db },
    { orgId: `${FIXTURE_PREFIX}-org`, actorUserId: `${FIXTURE_PREFIX}-actor`, folders },
  );
  return classifyPartialFailureIsolation(
    results.map((r) => ({ driveFolderId: r.driveFolderId, outcome: r.outcome })),
    faultInjectedFolderId,
  );
}

// ---------------------------------------------------------------------------
// Self-test — no network, no database. Proves classifiers 1–3 and runs the
// local reimplementation of the reviewed loop shape for assertion 4 (see file header).
// ---------------------------------------------------------------------------

export async function runSelfTest(): Promise<ProbeResult[]> {
  const partialFailureProbe = await runPartialFailureIsolationProbe();
  return [
    classifyTwoFoldersMirrored([
      { id: 'f1', org_id: 'org-a', connector_source_id: 'drive-1' },
      { id: 'f2', org_id: 'org-a', connector_source_id: 'drive-2' },
    ]),
    probe(
      `${ASSERTION.TWO_FOLDERS_MIRRORED}_selftest_rejects_missing_folder`,
      classifyTwoFoldersMirrored([{ id: 'f1', org_id: 'org-a', connector_source_id: 'drive-1' }]).status === 'fail',
      'only 1 of 2 expected mirror rows must fail — the eager mirror ran for only one folder',
    ),
    probe(
      `${ASSERTION.TWO_FOLDERS_MIRRORED}_selftest_rejects_duplicate`,
      classifyTwoFoldersMirrored([
        { id: 'f1', org_id: 'org-a', connector_source_id: 'drive-1' },
        { id: 'f2', org_id: 'org-a', connector_source_id: 'drive-1' },
        { id: 'f3', org_id: 'org-a', connector_source_id: 'drive-2' },
      ]).status === 'fail',
      '3 rows for 2 folders must fail — a duplicate was created instead of the unique index being reused',
    ),
    classifyIdempotentResave({ idsBeforeResave: ['f1', 'f2'], idsAfterResave: ['f1', 'f2'] }),
    probe(
      `${ASSERTION.IDEMPOTENT_RESAVE_NO_DUPLICATES}_selftest_rejects_growth`,
      classifyIdempotentResave({ idsBeforeResave: ['f1', 'f2'], idsAfterResave: ['f1', 'f2', 'f3'] }).status === 'fail',
      'a re-save that grows the folder count must fail — that is a duplicate insert, not a reuse',
    ),
    probe(
      `${ASSERTION.IDEMPOTENT_RESAVE_NO_DUPLICATES}_selftest_rejects_id_churn`,
      classifyIdempotentResave({ idsBeforeResave: ['f1', 'f2'], idsAfterResave: ['f1', 'f3'] }).status === 'fail',
      'a re-save that swaps which row backs a folder must fail even if the count stayed the same',
    ),
    classifyTenantIsolationNoCollision({ org1FolderId: 'f-org1', org2FolderId: 'f-org2' }),
    probe(
      `${ASSERTION.TENANT_ISOLATION_NO_COLLISION}_selftest_rejects_collision`,
      classifyTenantIsolationNoCollision({ org1FolderId: 'f-shared', org2FolderId: 'f-shared' }).status === 'fail',
      'the same folders.id row backing two different orgs must fail — that is a cross-tenant collision',
    ),
    probe(
      `${ASSERTION.TENANT_ISOLATION_NO_COLLISION}_selftest_rejects_missing_mirror`,
      classifyTenantIsolationNoCollision({ org1FolderId: 'f-org1', org2FolderId: '' }).status === 'fail',
      'a missing mirror for either org must fail rather than vacuously pass on "not equal to empty string"',
    ),
    partialFailureProbe,
    probe(
      `${ASSERTION.PARTIAL_FAILURE_ISOLATION}_selftest_rejects_loop_abort`,
      classifyPartialFailureIsolation(
        [{ driveFolderId: 'ok1', outcome: 'created' }],
        'faulty',
      ).status === 'fail',
      'only 1 of 3 expected results (the pre-review-fix shape: an uncaught throw unwound the whole '
        + 'loop) must fail, not be silently treated as "nothing to report"',
    ),
    probe(
      `${ASSERTION.PARTIAL_FAILURE_ISOLATION}_selftest_rejects_faulty_folder_not_marked_error`,
      classifyPartialFailureIsolation(
        [
          { driveFolderId: 'ok1', outcome: 'created' },
          { driveFolderId: 'faulty', outcome: 'skipped_no_connection' },
          { driveFolderId: 'ok2', outcome: 'created' },
        ],
        'faulty',
      ).status === 'fail',
      "the faulty folder's own result must specifically be 'error', not any other outcome",
    ),
    probe(
      `${ASSERTION.PARTIAL_FAILURE_ISOLATION}_selftest_fault_injection_is_real`,
      await (async () => {
        const faultFolderId = `${FIXTURE_PREFIX}-injection-sanity-fault`;
        const db = buildFaultInjectingMirrorDb({ connectionId: 'conn-sanity', faultFolderId });
        try {
          await db.from('folders').insert({ connector_source_id: faultFolderId }).select('id').single();
          return false; // it must throw — if it didn't, the injection is a no-op that always passes
        } catch {
          return true;
        }
      })(),
      'the fault-injecting fake db must itself throw for the fault folder id on insert — proves the '
        + "injection is real, not a no-op that always happens to pass (and that assertion 4's pass "
        + 'above is not vacuous)',
    ),
    probe('aggregate_selftest', aggregate([probe('x', true, ''), probe('y', false, '')]) === 'fail',
      'one failed probe fails the whole cycle'),
  ];
}

// ---------------------------------------------------------------------------
// Live fixtures + probes
// ---------------------------------------------------------------------------

interface OrgFixture {
  orgId: string;
  orgAdminEmail: string;
  orgAdminPassword: string;
}

async function ensureFixtureUser(db: SupabaseClient, email: string, password: string): Promise<string> {
  const { data: existing } = await db.from('profiles').select('id').eq('email', email).maybeSingle();
  if (existing && (existing as { id?: string }).id) return (existing as { id: string }).id;

  const { data: created, error: createError } = await db.auth.admin.createUser({
    email,
    email_confirm: true,
    password,
  });
  if (createError || !created?.user) {
    throw new Error(`could not create fixture auth user ${email}: ${createError?.message ?? 'unknown'}`);
  }
  return created.user.id;
}

/**
 * One org, one org-admin owner, PLUS a seeded `org_integrations` row
 * (provider=google_drive, revoked_at=null) — `mirrorConnectedDriveFolders`
 * skips entirely with `outcome: 'skipped_no_connection'` when no active
 * connection exists, and standing up a real OAuth round trip is out of scope
 * for a fixture. Seeding the row directly is the same idiom PR #3087's
 * driver used to bypass an unrelated RPC path (see that file's own
 * `seedPriorAnchor` comment) — this module's own header explains it reads
 * `org_integrations` for existence only, never the encrypted token payload.
 */
async function ensureOrgFixture(db: SupabaseClient, orgSuffix: string): Promise<OrgFixture> {
  const ownerEmail = `${FIXTURE_PREFIX}-owner-${orgSuffix}@arkova-soak.invalid`;
  const orgDisplayName = `${FIXTURE_PREFIX}-org-${orgSuffix}`;
  const password = `Pr3086Soak-${Buffer.from(ownerEmail).toString('hex').slice(0, 24)}-Aa1!`;

  const { data: existingOrg } = await db
    .from('organizations')
    .select('id')
    .eq('display_name', orgDisplayName)
    .maybeSingle();

  const orgAdminUserId = await ensureFixtureUser(db, ownerEmail, password);

  let orgId = (existingOrg as { id?: string } | null)?.id ?? null;
  if (!orgId) {
    const { data: org, error: orgError } = await db
      .from('organizations')
      .insert({ legal_name: orgDisplayName, display_name: orgDisplayName, verification_status: 'VERIFIED' })
      .select('id')
      .single();
    if (orgError || !org) throw new Error(`could not create fixture organization: ${orgError?.message}`);
    orgId = (org as { id: string }).id;
  }

  await db.from('profiles').upsert(
    { id: orgAdminUserId, email: ownerEmail, role: 'ORG_ADMIN', org_id: orgId },
    { onConflict: 'id' },
  );
  await db.from('org_members').upsert(
    { user_id: orgAdminUserId, org_id: orgId, role: 'owner' },
    { onConflict: 'user_id,org_id' },
  );

  const { data: existingConnection } = await db
    .from('org_integrations')
    .select('id')
    .eq('org_id', orgId)
    .eq('provider', 'google_drive')
    .is('revoked_at', null)
    .maybeSingle();
  if (!(existingConnection as { id?: string } | null)?.id) {
    const { error: connError } = await db.from('org_integrations').insert({
      org_id: orgId,
      provider: 'google_drive',
      account_label: `${FIXTURE_PREFIX}-drive-account`,
      scope: 'https://www.googleapis.com/auth/drive.readonly',
    });
    if (connError) throw new Error(`could not seed org_integrations fixture: ${connError.message}`);
  }

  return { orgId, orgAdminEmail: ownerEmail, orgAdminPassword: password };
}

async function signInFixtureUser(
  supabaseUrl: string,
  anonKey: string,
  email: string,
  password: string,
): Promise<string> {
  const anon = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await anon.auth.signInWithPassword({ email, password });
  if (error || !data.session?.access_token) {
    throw new Error(`fixture sign-in failed for ${email}: ${error?.message ?? 'no session returned'}`);
  }
  return data.session.access_token;
}

interface RuleSaveResult {
  httpStatus: number;
  body: Record<string, unknown>;
}

async function saveConnectorRule(
  targetUrl: string,
  bearerToken: string,
  orgId: string,
  driveFolderIds: string[],
  ruleId: string | null,
  suffix: string,
): Promise<RuleSaveResult> {
  const triggerConfig = {
    vendors: ['google_drive'],
    drive_folders: driveFolderIds.map((folderId) => ({ type: 'drive_folder', folder_id: folderId })),
  };
  const path = ruleId ? `/admin/rules/${ruleId}` : '/admin/rules';
  const method = ruleId ? 'PATCH' : 'POST';
  const body = ruleId
    ? { trigger_config: triggerConfig }
    : {
      org_id: orgId,
      name: `${FIXTURE_PREFIX}-rule-${suffix}`.slice(0, 100),
      trigger_type: 'WORKSPACE_FILE_MODIFIED',
      trigger_config: triggerConfig,
      action_type: 'AUTO_ANCHOR',
      action_config: { tag: 'connector-google_drive' },
      enabled: false,
    };
  const res = await fetch(`${targetUrl.replace(/\/+$/, '')}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearerToken}` },
    body: JSON.stringify(body),
  });
  const responseBody = await res.json().catch(() => ({}));
  return { httpStatus: res.status, body: responseBody as Record<string, unknown> };
}

async function pollMirrorFolders(
  db: SupabaseClient,
  orgId: string,
  driveFolderIds: string[],
  attempts: number,
  delayMs: number,
): Promise<MirrorFolderFacts[]> {
  let last: MirrorFolderFacts[] = [];
  for (let i = 0; i < attempts; i += 1) {
    const { data, error } = await db
      .from('folders')
      .select('id, org_id, connector_source_id')
      .eq('org_id', orgId)
      .eq('owner_scope', 'ORG')
      .eq('connector_provider', 'google_drive')
      .in('connector_source_id', driveFolderIds);
    if (error) throw new Error(`folders lookup failed: ${error.message}`);
    last = (data ?? []) as MirrorFolderFacts[];
    if (last.length >= driveFolderIds.length) return last;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return last;
}

/** One full pass over all four assertions. */
async function runCycle(
  db: SupabaseClient,
  targetUrl: string,
  org1: OrgFixture,
  org2: OrgFixture,
  bearerToken1: string,
  bearerToken2: string,
  cycle: number,
): Promise<ProbeResult[]> {
  const suffix = `${Date.now()}-${cycle}`;
  const probes: ProbeResult[] = [];

  // ── Assertions 1 & 2: 2 drive_folders on a fresh rule, then a re-save ──
  const folderA = `${FIXTURE_PREFIX}-folder-a-${suffix}`;
  const folderB = `${FIXTURE_PREFIX}-folder-b-${suffix}`;
  const createRes = await saveConnectorRule(targetUrl, bearerToken1, org1.orgId, [folderA, folderB], null, suffix);
  const ruleId = createRes.body.id as string | undefined;
  if (createRes.httpStatus !== 201 || !ruleId) {
    return [probe('cycle_setup_rule_create', false, `rule create failed: httpStatus=${createRes.httpStatus}, body=${JSON.stringify(createRes.body)}`)];
  }

  const afterCreate = await pollMirrorFolders(db, org1.orgId, [folderA, folderB], 6, 3000);
  probes.push(classifyTwoFoldersMirrored(afterCreate));
  const idsBeforeResave = afterCreate.map((r) => r.id);

  const resaveRes = await saveConnectorRule(targetUrl, bearerToken1, org1.orgId, [folderA, folderB], ruleId, suffix);
  // A rejected PATCH (4xx/5xx) trivially satisfies "the folder set is
  // unchanged" — nothing ran. Require the re-save to have actually applied
  // before treating an unchanged mirror set as evidence of idempotent reuse.
  if (resaveRes.httpStatus !== 200) {
    return [...probes, probe(
      'cycle_setup_resave_call',
      false,
      `rule re-save PATCH failed: httpStatus=${resaveRes.httpStatus}, body=${JSON.stringify(resaveRes.body)} — `
        + 'cannot assert idempotent reuse from a request that was itself rejected',
    )];
  }
  await new Promise((r) => setTimeout(r, 3000));
  const afterResave = await pollMirrorFolders(db, org1.orgId, [folderA, folderB], 6, 3000);
  probes.push(classifyIdempotentResave({
    idsBeforeResave,
    idsAfterResave: afterResave.map((r) => r.id),
  }));

  // ── Assertion 3: SAME connector_source_id, a SECOND independent org ──
  const sharedFolder = `${FIXTURE_PREFIX}-shared-folder-${suffix}`;
  const org1SharedRes = await saveConnectorRule(targetUrl, bearerToken1, org1.orgId, [sharedFolder], null, `${suffix}-shared1`);
  const org2SharedRes = await saveConnectorRule(targetUrl, bearerToken2, org2.orgId, [sharedFolder], null, `${suffix}-shared2`);
  if (org1SharedRes.httpStatus !== 201 || org2SharedRes.httpStatus !== 201) {
    return [...probes, probe('cycle_setup_tenant_isolation_rule_create', false, `httpStatus1=${org1SharedRes.httpStatus}, httpStatus2=${org2SharedRes.httpStatus}`)];
  }
  const org1Mirror = await pollMirrorFolders(db, org1.orgId, [sharedFolder], 6, 3000);
  const org2Mirror = await pollMirrorFolders(db, org2.orgId, [sharedFolder], 6, 3000);
  probes.push(classifyTenantIsolationNoCollision({
    org1FolderId: org1Mirror[0]?.id ?? '',
    org2FolderId: org2Mirror[0]?.id ?? '',
  }));

  // ── Assertion 4: rig-independent, real mirrorConnectedDriveFolders + fault-injecting db ──
  probes.push(await runPartialFailureIsolationProbe());

  return probes;
}

// ---------------------------------------------------------------------------
// CLI + runner
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): DriverArgs {
  const args: DriverArgs = { mode: 'self-test', durationMin: 0, intervalSec: 900 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--self-test':
        args.mode = 'self-test';
        break;
      case '--live':
        args.mode = 'live';
        break;
      case '--target-url':
        args.targetUrl = argv[++i];
        break;
      case '--admission-json':
        args.admissionJson = argv[++i];
        break;
      case '--evidence-jsonl':
        args.evidenceJsonl = argv[++i];
        break;
      case '--duration-min':
        args.durationMin = Number.parseInt(argv[++i] ?? '0', 10);
        break;
      case '--interval-sec':
        args.intervalSec = Number.parseInt(argv[++i] ?? '900', 10);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function emit(row: DriverRow, evidenceJsonl?: string): void {
  const line = `${JSON.stringify(row)}\n`;
  if (evidenceJsonl) appendFileSync(evidenceJsonl, line);
  process.stdout.write(line);
}

function resolveCredentials(): { url: string; serviceRoleKey: string; anonKey: string } {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !serviceRoleKey || !anonKey) {
    throw new Error('live mode requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY');
  }
  return { url, serviceRoleKey, anonKey };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const admission = args.admissionJson
    ? (JSON.parse(readFileSync(args.admissionJson, 'utf8')) as Record<string, unknown>)
    : undefined;

  if (args.mode === 'self-test') {
    const probes = await runSelfTest();
    emit({
      utc: new Date().toISOString(),
      pr: 3086,
      tier: 'T2',
      mode: 'self-test',
      evidenceForSoak: false,
      changedBehavior: CHANGED_BEHAVIOR,
      status: aggregate(probes),
      cycle: 0,
      counts: tally(probes),
      probes,
      blockers: [
        'self-test mode — local validation only for assertions 1-3, NOT T2 soak evidence. '
        + 'Assertion 4 (partial_failure_does_not_suppress_other_folders) IS real evidence even here — '
        + 'see the SCOPING NOTE in this file\'s header.',
      ],
    }, args.evidenceJsonl);
    process.exitCode = aggregate(probes) === 'pass' ? 0 : 1;
    return;
  }

  if (!args.targetUrl) throw new Error('--live requires --target-url');
  const { url, serviceRoleKey, anonKey } = resolveCredentials();
  const db = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const org1 = await ensureOrgFixture(db, 'a');
  const org2 = await ensureOrgFixture(db, 'b');

  const startedAt = Date.now();
  const deadline = startedAt + args.durationMin * 60_000;
  let cycle = 0;
  let anyCycleFailed = false;

  do {
    cycle += 1;
    let probes: ProbeResult[];
    try {
      // Fresh sign-in EVERY cycle for BOTH orgs rather than one token per org
      // captured before the loop — see pr3083's driver for the incident this
      // avoids: a token minted once with autoRefreshToken:false expires
      // mid-soak and every later cycle 401s.
      const bearerToken1 = await signInFixtureUser(url, anonKey, org1.orgAdminEmail, org1.orgAdminPassword);
      const bearerToken2 = await signInFixtureUser(url, anonKey, org2.orgAdminEmail, org2.orgAdminPassword);
      probes = await runCycle(db, args.targetUrl, org1, org2, bearerToken1, bearerToken2, cycle);
    } catch (error) {
      probes = [probe('cycle_error', false, error instanceof Error ? error.message : 'unknown')];
    }

    if (aggregate(probes) === 'fail') anyCycleFailed = true;

    emit({
      utc: new Date().toISOString(),
      pr: 3086,
      tier: 'T2',
      mode: 'live',
      evidenceForSoak: true,
      changedBehavior: CHANGED_BEHAVIOR,
      status: aggregate(probes),
      cycle,
      counts: tally(probes),
      probes,
      admission,
    }, args.evidenceJsonl);

    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, args.intervalSec * 1000));
  } while (Date.now() < deadline);

  // A failed probe anywhere in the run must fail the process — see pr3083's
  // driver for the same fix and why the CLI must not exit 0 on a red run.
  process.exitCode = anyCycleFailed ? 1 : 0;
}

const invokedDirectly = process.argv[1]?.includes('pr3086-drive-folder-mirror-driver');
if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'driver failed'}\n`);
    process.exitCode = 1;
  });
}
