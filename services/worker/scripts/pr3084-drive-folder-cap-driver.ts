#!/usr/bin/env tsx
/**
 * PR #3084 drive-folder-cap-three admission driver
 * (`fix/drive-folder-cap-three`, head `fc6d2750e`, T2).
 *
 * WHY THIS DRIVER EXISTS, NOT THE PR-1408 DEFAULT
 * ------------------------------------------------
 * `scripts/staging/provision-isolated-rig.sh` defaults `driver_path` to
 * `pr1408-chain-resilience-driver.ts` (chain retry/backoff/duplicate-tx
 * semantics). That drives ZERO of what #3084 changed. Set
 * `STAGING_DRIVER_PATH=services/worker/scripts/pr3084-drive-folder-cap-driver.ts`
 * before provisioning.
 *
 * WHAT #3084 CHANGES
 * -------------------
 * `services/worker/src/rules/schemas.ts`'s `TriggerConfigWorkspaceFileModified`
 * bounds a rule's `drive_folders[]` array to `DRIVE_FOLDER_BINDING_CAP = 3`
 * (was 20) — but the real fix is the new `superRefine` branch, which bounds
 * the TOTAL across BOTH binding shapes: the legacy singular `type`/`folder_id`
 * PLUS the `drive_folders[]` array. Every consumer of these bindings
 * (`driveFolderIds()`, `readDriveFolderBindings()`) merges the two shapes, so
 * bounding only the array's `.max()` left the effective limit one higher for
 * any caller that also set the legacy singular fields — reachable only
 * through a direct API call, since the UI (`DriveFolderPicker.tsx`) never
 * writes the singular shape.
 *
 * THE FOUR ASSERTIONS — how each is measured and how each can FAIL
 * -------------------------------------------------------------------
 *  1. EXACTLY_THREE_ACCEPTED — a rule save with exactly 3 `drive_folders`
 *     entries (array shape only) succeeds (HTTP 201/200). FAILS if the
 *     server rejects a legitimately-at-cap save — the cap must be inclusive.
 *  2. FOUR_REJECTED — a rule save with 4 `drive_folders` entries is rejected
 *     (HTTP 400). FAILS if it is accepted — the array-only regression this
 *     PR's `.max()` alone would already catch, kept here as the baseline.
 *  3. COMBINED_SHAPE_REJECTED — THE ACTUAL DEFECT THIS PR CLOSES: a rule save
 *     with the legacy `{type:'drive_folder', folder_id}` PLUS 3
 *     `drive_folders` entries (4 bound folders total) is rejected (HTTP 400).
 *     FAILS if it is accepted — which is exactly what an array-only `.max(3)`
 *     bound (with no `superRefine` merging the two shapes) would let through,
 *     since the array's OWN length is still only 3.
 *  4. COMBINED_SHAPE_AT_CAP_ACCEPTED — the legacy `folder_id` PLUS 2
 *     `drive_folders` entries (3 bound folders total) succeeds. FAILS if
 *     rejected — proving the fix bounds the TOTAL rather than banning the
 *     legacy shape outright (a regression that would silently break any
 *     rule still using the singular shape at or under the real cap).
 *
 * Every assertion is driven through the REAL rules API over real HTTP
 * (`POST /admin/rules`, per the task's explicit instruction) — never by
 * importing `TriggerConfig`/`superRefine` directly. A direct Zod import would
 * prove the schema is internally consistent; it would NOT prove that a direct
 * API caller (the actor this cap exists to stop) is actually bound by it once
 * routed through `handleCreateRule` → `CreateOrgRuleInput` → `validateRuleConfigs`.
 *
 * NON-CONNECTOR FIXTURE RULES ON PURPOSE. This driver's rules use
 * `action_type: 'AUTO_ANCHOR'` with a bare `{}` config (no `tag` field), so
 * `isConnectorManagedActionConfig` / `shouldMirrorDriveFoldersForRule` (PR
 * #3086, an unrelated, later-landed change) never fire for these fixture
 * rules and the create-time connector adopt-vs-create race check never
 * triggers. This driver is scoped to the CAP, not the mirror.
 *
 * Self-test mode is local validation only: rows are `evidenceForSoak=false`
 * and must never be cited as T2 soak evidence.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CHANGED_BEHAVIOR =
  "PR #3084: a rule may bind at most 3 Google Drive folders TOTAL, counting BOTH the legacy singular "
  + "type/folder_id shape and the drive_folders[] array together (rules/schemas.ts's superRefine). "
  + "Bounding only the array's own .max() (the pre-fix state) left the effective cap one higher for a "
  + 'direct API caller who also sets the legacy singular fields — a path the rule-builder UI never '
  + 'exercises, which is why the gap was invisible through the dashboard.';

export const ASSERTION = {
  EXACTLY_THREE_ACCEPTED: 'exactly_three_drive_folders_accepted',
  FOUR_REJECTED: 'four_drive_folders_rejected',
  COMBINED_SHAPE_REJECTED: 'combined_legacy_plus_array_four_total_rejected',
  COMBINED_SHAPE_AT_CAP_ACCEPTED: 'combined_legacy_plus_array_three_total_accepted',
} as const;

export const DRIVE_FOLDER_BINDING_CAP = 3;

/** Fixture prefix so every row/user this driver creates is identifiable and reapable. */
export const FIXTURE_PREFIX = 'pr3084-soak';

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
  pr: 3084;
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

/** What this driver needs back from a `POST /admin/rules` attempt. */
export interface RuleSaveAttempt {
  httpStatus: number;
  body: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Pure classifiers — unit-testable without a network or a database.
// ---------------------------------------------------------------------------

function probe(name: string, ok: boolean, detail: string): ProbeResult {
  return { name, status: ok ? 'pass' : 'fail', detail };
}

/** Assertion 1. The cap must be INCLUSIVE — exactly at the cap must succeed. */
export function classifyExactlyThreeAccepted(attempt: RuleSaveAttempt): ProbeResult {
  const accepted = attempt.httpStatus === 200 || attempt.httpStatus === 201;
  return probe(
    ASSERTION.EXACTLY_THREE_ACCEPTED,
    accepted,
    `httpStatus=${attempt.httpStatus} for exactly 3 drive_folders (expected 200/201 — a rule AT the `
      + `cap must be accepted, not just under it): ${JSON.stringify(attempt.body)}`,
  );
}

/** Assertion 2. The baseline array-length regression. */
export function classifyFourRejected(attempt: RuleSaveAttempt): ProbeResult {
  if (attempt.httpStatus === 200 || attempt.httpStatus === 201) {
    return probe(
      ASSERTION.FOUR_REJECTED,
      false,
      'a rule with 4 drive_folders (array shape only) was ACCEPTED — the basic per-array bound regressed',
    );
  }
  return probe(
    ASSERTION.FOUR_REJECTED,
    attempt.httpStatus === 400,
    `httpStatus=${attempt.httpStatus} for 4 drive_folders (expected 400): ${JSON.stringify(attempt.body)}`,
  );
}

/**
 * Assertion 3 — THE ACTUAL DEFECT. `folder_id` (legacy) + 3 `drive_folders`
 * (array) = 4 bound folders total. An array-only `.max(3)` bound never sees
 * this: the array itself has only 3 entries. Only the superRefine's merged
 * count catches it.
 */
export function classifyCombinedShapeRejected(attempt: RuleSaveAttempt): ProbeResult {
  if (attempt.httpStatus === 200 || attempt.httpStatus === 201) {
    return probe(
      ASSERTION.COMBINED_SHAPE_REJECTED,
      false,
      'legacy folder_id + 3 drive_folders (4 bound total) was ACCEPTED — this is the exact pre-fix '
        + "defect: bounding only the array's .max() misses the legacy shape entirely, so a direct API "
        + 'caller reaches 4 bound folders while the array itself still reads 3',
    );
  }
  return probe(
    ASSERTION.COMBINED_SHAPE_REJECTED,
    attempt.httpStatus === 400,
    `httpStatus=${attempt.httpStatus} for folder_id + 3 drive_folders, 4 total (expected 400): `
      + `${JSON.stringify(attempt.body)}`,
  );
}

/** Assertion 4. The fix must bound the TOTAL, not ban the legacy shape outright. */
export function classifyCombinedShapeAtCapAccepted(attempt: RuleSaveAttempt): ProbeResult {
  if (attempt.httpStatus === 400) {
    return probe(
      ASSERTION.COMBINED_SHAPE_AT_CAP_ACCEPTED,
      false,
      'legacy folder_id + 2 drive_folders (3 bound total, AT the cap) was REJECTED — the fix over-shot '
        + 'and banned the legacy shape outright instead of bounding the combined total',
    );
  }
  return probe(
    ASSERTION.COMBINED_SHAPE_AT_CAP_ACCEPTED,
    attempt.httpStatus === 200 || attempt.httpStatus === 201,
    `httpStatus=${attempt.httpStatus} for folder_id + 2 drive_folders, 3 total (expected 200/201): `
      + `${JSON.stringify(attempt.body)}`,
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
// Fixture helpers — build valid trigger_config payloads for each scenario.
// ---------------------------------------------------------------------------

export function driveFolderEntry(folderId: string): { type: 'drive_folder'; folder_id: string } {
  return { type: 'drive_folder', folder_id: folderId };
}

export function buildTriggerConfig(args: {
  driveFoldersCount: number;
  includeLegacySingular: boolean;
  suffix: string;
}): Record<string, unknown> {
  const config: Record<string, unknown> = {
    vendors: ['google_drive'],
    drive_folders: Array.from(
      { length: args.driveFoldersCount },
      (_, i) => driveFolderEntry(`${FIXTURE_PREFIX}-folder-${args.suffix}-arr${i}`),
    ),
  };
  if (args.includeLegacySingular) {
    config.type = 'drive_folder';
    config.folder_id = `${FIXTURE_PREFIX}-folder-${args.suffix}-legacy`;
  }
  return config;
}

// ---------------------------------------------------------------------------
// Self-test — no network, no database. Proves the classifiers, not the rig.
// ---------------------------------------------------------------------------

export function runSelfTest(): ProbeResult[] {
  return [
    classifyExactlyThreeAccepted({ httpStatus: 201, body: { id: 'r1' } }),
    probe(
      `${ASSERTION.EXACTLY_THREE_ACCEPTED}_selftest_rejects_400_at_cap`,
      classifyExactlyThreeAccepted({ httpStatus: 400, body: {} }).status === 'fail',
      'a 400 for a rule exactly AT the cap must fail — the cap must be inclusive',
    ),
    classifyFourRejected({ httpStatus: 400, body: { error: 'too many' } }),
    probe(
      `${ASSERTION.FOUR_REJECTED}_selftest_rejects_acceptance`,
      classifyFourRejected({ httpStatus: 201, body: { id: 'r2' } }).status === 'fail',
      'a 201 for 4 array-shape drive_folders must fail — the basic per-array bound regressed',
    ),
    classifyCombinedShapeRejected({ httpStatus: 400, body: { error: 'too many' } }),
    probe(
      `${ASSERTION.COMBINED_SHAPE_REJECTED}_selftest_rejects_the_actual_defect`,
      classifyCombinedShapeRejected({ httpStatus: 201, body: { id: 'r3' } }).status === 'fail',
      'a 201 for legacy folder_id + 3 array entries (4 total) must fail — this is the defect the PR closes',
    ),
    classifyCombinedShapeAtCapAccepted({ httpStatus: 201, body: { id: 'r4' } }),
    probe(
      `${ASSERTION.COMBINED_SHAPE_AT_CAP_ACCEPTED}_selftest_rejects_overshoot`,
      classifyCombinedShapeAtCapAccepted({ httpStatus: 400, body: {} }).status === 'fail',
      'a 400 for legacy folder_id + 2 array entries (3 total, at cap) must fail — the fix must not '
        + 'ban the legacy shape outright',
    ),
    probe('aggregate_selftest', aggregate([probe('x', true, ''), probe('y', false, '')]) === 'fail',
      'one failed probe fails the whole cycle'),
    probe(
      'buildTriggerConfig_selftest_counts_total_correctly',
      (() => {
        const cfg = buildTriggerConfig({ driveFoldersCount: 2, includeLegacySingular: true, suffix: 'x' });
        const arr = cfg.drive_folders as unknown[];
        const total = arr.length + (cfg.folder_id ? 1 : 0);
        return total === 3;
      })(),
      'fixture builder must produce the exact total the scenario name claims',
    ),
  ];
}

// ---------------------------------------------------------------------------
// Live fixtures + probes
// ---------------------------------------------------------------------------

interface FixtureIdentity {
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

/** One org, one org-admin owner (`org_members.role='owner'`, per `isCallerOrgAdmin`). */
async function ensureFixtureIdentity(db: SupabaseClient): Promise<FixtureIdentity> {
  const ownerEmail = `${FIXTURE_PREFIX}-owner@arkova-soak.invalid`;
  const orgDisplayName = `${FIXTURE_PREFIX}-org`;
  const password = `Pr3084Soak-${Buffer.from(ownerEmail).toString('hex').slice(0, 24)}-Aa1!`;

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

async function attemptRuleSave(
  targetUrl: string,
  bearerToken: string,
  orgId: string,
  triggerConfig: Record<string, unknown>,
  suffix: string,
): Promise<RuleSaveAttempt> {
  const res = await fetch(`${targetUrl.replace(/\/+$/, '')}/admin/rules`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearerToken}` },
    body: JSON.stringify({
      org_id: orgId,
      name: `${FIXTURE_PREFIX}-rule-${suffix}`.slice(0, 100),
      trigger_type: 'WORKSPACE_FILE_MODIFIED',
      trigger_config: triggerConfig,
      // Bare AUTO_ANCHOR, no `tag` — deliberately NOT connector-managed (see file header).
      action_type: 'AUTO_ANCHOR',
      action_config: {},
      enabled: false,
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { httpStatus: res.status, body: body as Record<string, unknown> };
}

/** One full pass over all four assertions, each against its OWN freshly-created rule. */
async function runCycle(
  targetUrl: string,
  fx: FixtureIdentity,
  bearerToken: string,
  cycle: number,
): Promise<ProbeResult[]> {
  const suffix = `${Date.now()}-${cycle}`;
  const probes: ProbeResult[] = [];

  const exactlyThree = await attemptRuleSave(
    targetUrl, bearerToken, fx.orgId,
    buildTriggerConfig({ driveFoldersCount: 3, includeLegacySingular: false, suffix: `${suffix}-a` }),
    `${suffix}-a`,
  );
  probes.push(classifyExactlyThreeAccepted(exactlyThree));

  const four = await attemptRuleSave(
    targetUrl, bearerToken, fx.orgId,
    buildTriggerConfig({ driveFoldersCount: 4, includeLegacySingular: false, suffix: `${suffix}-b` }),
    `${suffix}-b`,
  );
  probes.push(classifyFourRejected(four));

  const combinedFour = await attemptRuleSave(
    targetUrl, bearerToken, fx.orgId,
    buildTriggerConfig({ driveFoldersCount: 3, includeLegacySingular: true, suffix: `${suffix}-c` }),
    `${suffix}-c`,
  );
  probes.push(classifyCombinedShapeRejected(combinedFour));

  const combinedThree = await attemptRuleSave(
    targetUrl, bearerToken, fx.orgId,
    buildTriggerConfig({ driveFoldersCount: 2, includeLegacySingular: true, suffix: `${suffix}-d` }),
    `${suffix}-d`,
  );
  probes.push(classifyCombinedShapeAtCapAccepted(combinedThree));

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
    const probes = runSelfTest();
    emit({
      utc: new Date().toISOString(),
      pr: 3084,
      tier: 'T2',
      mode: 'self-test',
      evidenceForSoak: false,
      changedBehavior: CHANGED_BEHAVIOR,
      status: aggregate(probes),
      cycle: 0,
      counts: tally(probes),
      probes,
      blockers: ['self-test mode — local validation only, NOT T2 soak evidence'],
    }, args.evidenceJsonl);
    process.exitCode = aggregate(probes) === 'pass' ? 0 : 1;
    return;
  }

  if (!args.targetUrl) throw new Error('--live requires --target-url');
  const { url, serviceRoleKey, anonKey } = resolveCredentials();
  const db = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const fx = await ensureFixtureIdentity(db);

  const startedAt = Date.now();
  const deadline = startedAt + args.durationMin * 60_000;
  let cycle = 0;
  let anyCycleFailed = false;

  do {
    cycle += 1;
    let probes: ProbeResult[];
    try {
      // Fresh sign-in EVERY cycle rather than one token captured before the
      // loop — see pr3083's driver for the incident this avoids: a token
      // minted once with autoRefreshToken:false expires mid-soak and every
      // later cycle 401s.
      const bearerToken = await signInFixtureUser(url, anonKey, fx.orgAdminEmail, fx.orgAdminPassword);
      probes = await runCycle(args.targetUrl, fx, bearerToken, cycle);
    } catch (error) {
      probes = [probe('cycle_error', false, error instanceof Error ? error.message : 'unknown')];
    }

    if (aggregate(probes) === 'fail') anyCycleFailed = true;

    emit({
      utc: new Date().toISOString(),
      pr: 3084,
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

const invokedDirectly = process.argv[1]?.includes('pr3084-drive-folder-cap-driver');
if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'driver failed'}\n`);
    process.exitCode = 1;
  });
}
