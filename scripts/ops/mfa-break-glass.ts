#!/usr/bin/env -S npx tsx
/**
 * scripts/ops/mfa-break-glass.ts (SCRUM-3584)
 *
 * Break-glass MFA factor removal for a locked-out user (lost device, no
 * backup codes, no in-app self-service path by design). Service-role
 * only. See docs/runbooks/mfa-break-glass.md for the full procedure —
 * prerequisites (ticket, operator identity, second-person notification
 * of Carson before touching prod), how to fetch SUPABASE_URL /
 * SUPABASE_SERVICE_ROLE_KEY from Secret Manager without printing them,
 * and the verification query for the audit rows this script writes.
 *
 * SAFETY SEQUENCE (CTO plan Amendment A4 ruling 5 — BINDING):
 *   resolve user by email -> print ALL factors (id/friendly_name/status/
 *   created) -> require explicit --factor-id <id> or --all -> require
 *   env CONFIRM_MFA_BREAK_GLASS=<email> equal to the resolved email ->
 *   write an audit_events INTENT row BEFORE deleting anything ->
 *   deleteFactor per selected id -> write a COMPLETION row -> any audit
 *   write failure is loud and exits non-zero.
 *
 * GoTrue rule this tool depends on (CTO plan Amendment A3): deleting a
 * VERIFIED factor invalidates every session of that user with AAL below
 * aal2 — i.e. this logs the user out everywhere. That is expected, not a
 * bug: the user signs back in and re-enrolls under whatever grace/
 * enforcement policy currently applies (src/lib/mfaPolicy.ts).
 *
 * Dry run is the default and writes NOTHING: it resolves the user, lists
 * every factor, validates a selection if one was given, and prints the
 * plan. Only `--apply` plus a matching `CONFIRM_MFA_BREAK_GLASS` env var
 * performs a delete.
 *
 * Usage (dry run — always do this first):
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     npx tsx scripts/ops/mfa-break-glass.ts \
 *       --email user@example.com --factor-id <id> \
 *       --reason "lost phone, no backup codes" --ticket SCRUM-1234 \
 *       --operator carson@arkova.io
 *
 * Usage (apply — actually deletes):
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   CONFIRM_MFA_BREAK_GLASS=user@example.com \
 *     npx tsx scripts/ops/mfa-break-glass.ts \
 *       --email user@example.com --factor-id <id> \
 *       --reason "lost phone, no backup codes" --ticket SCRUM-1234 \
 *       --operator carson@arkova.io --apply
 *
 * Against prod (SUPABASE_URL host containing vzwyaatejekddvltxyye) also
 * requires ALLOW_PROD_BREAK_GLASS=1, printed as a red banner — see the
 * runbook's "never" list before ever setting that.
 *
 * Exit codes:
 *   0 — dry run completed, or apply completed with every selected
 *       factor deleted and both audit rows recorded.
 *   1 — validation / precondition failure. NOTHING was written: bad
 *       args, user not found, --factor-id doesn't belong to the
 *       resolved user, missing/mismatched CONFIRM_MFA_BREAK_GLASS, or a
 *       prod host denied without ALLOW_PROD_BREAK_GLASS=1.
 *   2 — the INTENT audit row failed to insert. Aborted BEFORE any
 *       delete — no factor was touched.
 *   3 — one or more deletes were attempted, but the COMPLETION audit
 *       row failed to insert. The row that must be inserted manually is
 *       printed to stderr. This is the loudest failure mode: a delete
 *       may have succeeded with no audit trail recording it.
 *   4 — the COMPLETION audit row WAS recorded, but it records that one
 *       or more factor deletions failed. Investigate and re-run for the
 *       remaining factor(s).
 *
 * Never logs secrets: SUPABASE_SERVICE_ROLE_KEY is read from env and
 * never printed; the final summary carries no keys.
 */

import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Exit codes (see file header for the full table).
// ---------------------------------------------------------------------------
export const EXIT_SUCCESS = 0;
export const EXIT_VALIDATION = 1;
export const EXIT_INTENT_AUDIT_FAILED = 2;
export const EXIT_COMPLETION_AUDIT_FAILED = 3;
export const EXIT_PARTIAL_FAILURE = 4;

/** Prod ref — CLAUDE.md / reference_gcp_project docs. Hard-denied by default. */
const PROD_SUPABASE_REF = 'vzwyaatejekddvltxyye';

/** audit_events.details CHECK: char_length(details) <= 10000. */
const AUDIT_DETAILS_MAX = 10000;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function isValidTicketRef(ticket: string): boolean {
  if (/^SCRUM-\d+$/i.test(ticket)) return true;
  try {
    const url = new URL(ticket);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

const ArgsSchema = z
  .object({
    email: z.string().trim().email('--email must be a valid email address'),
    factorId: z.string().trim().min(1).optional(),
    all: z.boolean().default(false),
    reason: z.string().trim().min(1, '--reason is required'),
    ticket: z
      .string()
      .trim()
      .min(1, '--ticket is required')
      .refine(isValidTicketRef, { message: '--ticket must look like SCRUM-1234 or a URL' }),
    operator: z.string().trim().min(1, '--operator (name/email) is required'),
    apply: z.boolean().default(false),
  })
  .refine((v) => !(v.factorId && v.all), {
    message: 'provide exactly one of --factor-id or --all, not both',
  })
  .refine((v) => v.apply === false || Boolean(v.factorId) || v.all, {
    message: '--apply requires --factor-id <id> or --all',
  });

export type BreakGlassArgs = z.infer<typeof ArgsSchema>;

/** Parses `process.argv`-shaped input (argv[0]/argv[1] are node/script path). */
export function parseCliArgs(argv: string[]): BreakGlassArgs {
  const { values } = parseArgs({
    args: argv.slice(2),
    options: {
      email: { type: 'string' },
      'factor-id': { type: 'string' },
      all: { type: 'boolean', default: false },
      reason: { type: 'string' },
      ticket: { type: 'string' },
      operator: { type: 'string' },
      apply: { type: 'boolean', default: false },
    },
  });

  const result = ArgsSchema.safeParse({
    email: values.email,
    factorId: values['factor-id'],
    all: values.all,
    reason: values.reason,
    ticket: values.ticket,
    operator: values.operator,
    apply: values.apply,
  });

  if (!result.success) {
    throw new Error(result.error.issues.map((issue) => issue.message).join('; '));
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Minimal Supabase admin client surface this script needs. Structurally
// compatible with `@supabase/supabase-js`'s `SupabaseClient` (see `main()`,
// which casts the real client into this shape) — kept minimal on purpose so
// tests can supply a hand-rolled fake with no real network.
// ---------------------------------------------------------------------------

export interface MfaFactorRow {
  id: string;
  factor_type: string;
  friendly_name: string | null;
  status: string;
  created_at: string;
}

interface AdminUserRow {
  id: string;
  email?: string | null;
}

interface SupabaseErrorLike {
  message: string;
}

interface PostgrestMaybeSingleLike {
  maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: SupabaseErrorLike | null }>;
}

interface PostgrestFilterBuilderLike {
  eq(column: string, value: string): PostgrestMaybeSingleLike;
}

interface PostgrestQueryBuilderLike {
  select(columns: string): PostgrestFilterBuilderLike;
  insert(row: Record<string, unknown>): PromiseLike<{ error: SupabaseErrorLike | null }>;
}

export interface SupabaseAdminLike {
  auth: {
    admin: {
      listUsers(params: { page: number; perPage: number }): Promise<{
        data: { users: AdminUserRow[] } | null;
        error: SupabaseErrorLike | null;
      }>;
      mfa: {
        listFactors(params: { userId: string }): Promise<{
          data: { factors: MfaFactorRow[] } | null;
          error: SupabaseErrorLike | null;
        }>;
        deleteFactor(params: { id: string; userId: string }): Promise<{
          data: unknown;
          error: SupabaseErrorLike | null;
        }>;
      };
    };
  };
  from(table: string): PostgrestQueryBuilderLike;
}

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export interface ResolvedUser {
  id: string;
  email: string;
}

export interface FactorDeleteResult {
  id: string;
  friendly_name: string | null;
  status: 'deleted' | 'failed';
  error?: string;
}

export interface BreakGlassSummary {
  mode: 'dry-run' | 'apply';
  user_id: string;
  email: string;
  org_id: string | null;
  factors_found: number;
  factors_selected: string[];
  results?: FactorDeleteResult[];
  intent_audit_recorded?: boolean;
  completion_audit_recorded?: boolean;
}

export interface BreakGlassOutcome {
  exitCode: number;
  summary: BreakGlassSummary | null;
  message?: string;
}

export interface BreakGlassDeps {
  client: SupabaseAdminLike;
  /** The exact SUPABASE_URL used to build `client` — for the prod-host check. */
  supabaseUrl: string;
  /** process.env.CONFIRM_MFA_BREAK_GLASS */
  confirmEnv?: string;
  /** process.env.ALLOW_PROD_BREAK_GLASS */
  allowProdBreakGlass?: string;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function safeHost(supabaseUrl: string): string {
  try {
    return new URL(supabaseUrl).host;
  } catch {
    return supabaseUrl;
  }
}

/** Exported for direct unit testing of the prod-deny predicate. */
export function isProdHost(supabaseUrl: string): boolean {
  return safeHost(supabaseUrl).includes(PROD_SUPABASE_REF) || supabaseUrl.includes(PROD_SUPABASE_REF);
}

function redBanner(supabaseUrl: string): string {
  const bar = '!'.repeat(78);
  return [
    '',
    bar,
    '!! ALLOW_PROD_BREAK_GLASS=1 — TARGETING PRODUCTION SUPABASE PROJECT',
    `!! host: ${safeHost(supabaseUrl)}`,
    '!! A second person (Carson) must be aware this is running. See',
    '!! docs/runbooks/mfa-break-glass.md before proceeding.',
    bar,
    '',
  ].join('\n');
}

const LIST_USERS_PAGE_SIZE = 200;
/** Safety cap so a bug can never spin this into an infinite page loop. */
const LIST_USERS_MAX_PAGES = 200;

async function resolveUserByEmail(client: SupabaseAdminLike, email: string): Promise<ResolvedUser | null> {
  const target = email.trim().toLowerCase();
  for (let page = 1; page <= LIST_USERS_MAX_PAGES; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: LIST_USERS_PAGE_SIZE });
    if (error) throw new Error(error.message);
    const users = data?.users ?? [];
    const found = users.find((u) => (u.email ?? '').toLowerCase() === target);
    if (found) {
      return { id: found.id, email: found.email ?? email };
    }
    if (users.length < LIST_USERS_PAGE_SIZE) {
      return null;
    }
  }
  throw new Error(
    `exceeded ${LIST_USERS_MAX_PAGES} pages of auth.admin.listUsers without finding "${email}" or exhausting results`,
  );
}

async function listFactorsForUser(client: SupabaseAdminLike, userId: string): Promise<MfaFactorRow[]> {
  const { data, error } = await client.auth.admin.mfa.listFactors({ userId });
  if (error) throw new Error(error.message);
  return data?.factors ?? [];
}

async function lookupOrgId(
  client: SupabaseAdminLike,
  userId: string,
  warn: (line: string) => void,
): Promise<string | null> {
  try {
    const { data, error } = await client.from('profiles').select('org_id').eq('id', userId).maybeSingle();
    if (error) {
      warn(`profiles.org_id lookup failed (continuing with org_id=null): ${error.message}`);
      return null;
    }
    const orgId = data?.org_id;
    return typeof orgId === 'string' ? orgId : null;
  } catch (err) {
    warn(`profiles.org_id lookup threw (continuing with org_id=null): ${errMessage(err)}`);
    return null;
  }
}

async function insertAuditEvent(
  client: SupabaseAdminLike,
  row: Record<string, unknown>,
): Promise<{ error: SupabaseErrorLike | null }> {
  try {
    const { error } = await client.from('audit_events').insert(row);
    return { error: error ?? null };
  } catch (err) {
    return { error: { message: errMessage(err) } };
  }
}

/**
 * Keeps `details` under the audit_events CHECK (<=10000 chars) rather than
 * fail the insert outright. Drops the most verbose, least essential field
 * first; a manual DB read of `target_id` + `user_id` still identifies the
 * factor(s) even if this ever has to truncate.
 */
function boundedDetailsJson(details: Record<string, unknown>): string {
  const full = JSON.stringify(details);
  if (full.length <= AUDIT_DETAILS_MAX) return full;

  const withoutFriendlyNames = JSON.stringify({ ...details, friendly_names: '<truncated>', _truncated: true });
  if (withoutFriendlyNames.length <= AUDIT_DETAILS_MAX) return withoutFriendlyNames;

  return `${full.slice(0, AUDIT_DETAILS_MAX - 40)}..."_truncated_hard":true}`;
}

function padEndSafe(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

export function formatFactorTable(factors: MfaFactorRow[]): string {
  if (factors.length === 0) return 'No MFA factors found for this user.';
  const header = ['id', 'factor_type', 'friendly_name', 'status', 'created_at'];
  const rows = factors.map((f) => [f.id, f.factor_type, f.friendly_name ?? '', f.status, f.created_at]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (cells: string[]) => cells.map((c, i) => padEndSafe(c, widths[i])).join('  ');
  return [fmt(header), fmt(widths.map((w) => '-'.repeat(w))), ...rows.map(fmt)].join('\n');
}

function fail(message: string): BreakGlassOutcome {
  return { exitCode: EXIT_VALIDATION, summary: null, message };
}

// ---------------------------------------------------------------------------
// Core sequence
// ---------------------------------------------------------------------------

/**
 * Runs the full break-glass sequence per the BINDING safety ordering (CTO
 * plan Amendment A4 ruling 5). Never throws — every failure path returns a
 * `BreakGlassOutcome` with the exit code documented in the file header.
 */
export async function runBreakGlass(deps: BreakGlassDeps, args: BreakGlassArgs): Promise<BreakGlassOutcome> {
  const log = deps.log ?? (() => {});
  const warn = deps.warn ?? (() => {});

  // 0. Prod hard-deny — before touching the client at all.
  if (isProdHost(deps.supabaseUrl)) {
    if (deps.allowProdBreakGlass !== '1') {
      return fail(
        `SUPABASE_URL targets production (${PROD_SUPABASE_REF}). Refusing without ALLOW_PROD_BREAK_GLASS=1 — ` +
          'see docs/runbooks/mfa-break-glass.md.',
      );
    }
    warn(redBanner(deps.supabaseUrl));
  }

  // 1. Resolve user by email.
  let user: ResolvedUser | null;
  try {
    user = await resolveUserByEmail(deps.client, args.email);
  } catch (err) {
    return fail(`failed to resolve user by email: ${errMessage(err)}`);
  }
  if (!user) {
    return fail(`no user found for email "${args.email}"`);
  }

  // 2. List every factor, print the table (always — dry run and apply).
  let factors: MfaFactorRow[];
  try {
    factors = await listFactorsForUser(deps.client, user.id);
  } catch (err) {
    return fail(`failed to list MFA factors for ${user.email}: ${errMessage(err)}`);
  }
  log(formatFactorTable(factors));

  // 3. Validate selection — factor ids must belong to this user.
  let selected: MfaFactorRow[];
  if (args.all) {
    selected = factors;
  } else if (args.factorId) {
    const match = factors.find((f) => f.id === args.factorId);
    if (!match) {
      const known = factors.map((f) => f.id).join(', ') || 'none';
      return fail(`--factor-id ${args.factorId} does not belong to ${user.email} (this user has: ${known})`);
    }
    selected = [match];
  } else {
    // Neither --factor-id nor --all: informational dry run only. Args
    // validation already forbids this combination when --apply is set.
    selected = [];
  }

  const orgId = await lookupOrgId(deps.client, user.id, warn);

  const baseSummary: BreakGlassSummary = {
    mode: args.apply ? 'apply' : 'dry-run',
    user_id: user.id,
    email: user.email,
    org_id: orgId,
    factors_found: factors.length,
    factors_selected: selected.map((f) => f.id),
  };

  if (!args.apply) {
    log(JSON.stringify(baseSummary, null, 2));
    return { exitCode: EXIT_SUCCESS, summary: baseSummary };
  }

  // Args validation guarantees factorId or all was given when apply=true,
  // and the factorId branch above already returned on a non-match — so
  // reaching apply mode with an empty selection would be a logic bug, not a
  // user error. Guard it anyway rather than silently no-op deleting nothing.
  if (selected.length === 0) {
    return fail('no factors selected for --apply — pass --factor-id <id> or --all');
  }

  // 4. CONFIRM_MFA_BREAK_GLASS must equal the RESOLVED email, case-insensitive.
  if (!deps.confirmEnv || deps.confirmEnv.trim().toLowerCase() !== user.email.toLowerCase()) {
    const got = deps.confirmEnv ? JSON.stringify(deps.confirmEnv) : '<unset>';
    return fail(
      `CONFIRM_MFA_BREAK_GLASS must equal the resolved user's email ("${user.email}") to apply. Got ${got}.`,
    );
  }

  const detailsBase = {
    operator: args.operator,
    reason: args.reason,
    ticket: args.ticket,
    user_id: user.id,
    factor_ids: selected.map((f) => f.id),
    friendly_names: selected.map((f) => f.friendly_name),
    statuses: selected.map((f) => f.status),
    host: safeHost(deps.supabaseUrl),
  };
  const targetId = selected.map((f) => f.id).join(',');

  // 5. INTENT audit row — BEFORE any delete. Failure aborts with nothing touched.
  const intentRow = {
    event_type: 'mfa_break_glass_requested',
    event_category: 'SECURITY',
    actor_id: null,
    target_type: 'mfa_factor',
    target_id: targetId,
    org_id: orgId,
    details: boundedDetailsJson(detailsBase),
  };

  const intentResult = await insertAuditEvent(deps.client, intentRow);
  if (intentResult.error) {
    warn('INTENT audit row failed to insert — ABORTING before any factor was deleted.');
    warn(`Row that failed to insert: ${JSON.stringify(intentRow)}`);
    return {
      exitCode: EXIT_INTENT_AUDIT_FAILED,
      summary: { ...baseSummary, intent_audit_recorded: false },
      message: `intent audit insert failed: ${intentResult.error.message}`,
    };
  }

  // 6. Delete each selected factor. A per-factor failure does not stop the
  // loop — every selected factor gets one attempt, and every outcome (success
  // or failure) is recorded in the COMPLETION row below.
  const results: FactorDeleteResult[] = [];
  for (const factor of selected) {
    try {
      const { error } = await deps.client.auth.admin.mfa.deleteFactor({ id: factor.id, userId: user.id });
      results.push(
        error
          ? { id: factor.id, friendly_name: factor.friendly_name, status: 'failed', error: error.message }
          : { id: factor.id, friendly_name: factor.friendly_name, status: 'deleted' },
      );
    } catch (err) {
      results.push({ id: factor.id, friendly_name: factor.friendly_name, status: 'failed', error: errMessage(err) });
    }
  }
  const anyFailed = results.some((r) => r.status === 'failed');

  // 7. COMPLETION audit row — always attempted, success or failure alike.
  const completionRow = {
    event_type: 'mfa_break_glass_completed',
    event_category: 'SECURITY',
    actor_id: null,
    target_type: 'mfa_factor',
    target_id: targetId,
    org_id: orgId,
    details: boundedDetailsJson({ ...detailsBase, results }),
  };

  const completionResult = await insertAuditEvent(deps.client, completionRow);
  if (completionResult.error) {
    warn('COMPLETION audit row failed to insert. The delete(s) above already ran (or were attempted).');
    warn('INSERT THIS ROW MANUALLY as soon as possible:');
    warn(JSON.stringify(completionRow, null, 2));
    return {
      exitCode: EXIT_COMPLETION_AUDIT_FAILED,
      summary: { ...baseSummary, results, intent_audit_recorded: true, completion_audit_recorded: false },
      message: `completion audit insert failed: ${completionResult.error.message}`,
    };
  }

  const finalSummary: BreakGlassSummary = {
    ...baseSummary,
    results,
    intent_audit_recorded: true,
    completion_audit_recorded: true,
  };
  log(JSON.stringify(finalSummary, null, 2));

  if (anyFailed) {
    return {
      exitCode: EXIT_PARTIAL_FAILURE,
      summary: finalSummary,
      message: 'one or more factor deletions failed — see results[]. Audit trail is intact; investigate and re-run for the remaining factor(s).',
    };
  }

  return { exitCode: EXIT_SUCCESS, summary: finalSummary };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

interface EnvConfig {
  url: string;
  serviceRoleKey: string;
  confirmEnv?: string;
  allowProdBreakGlass?: string;
}

function loadEnvConfig(env: NodeJS.ProcessEnv): EnvConfig {
  const url = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error(
      'Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. See docs/runbooks/mfa-break-glass.md for how ' +
        'to fetch them from GCP Secret Manager without printing them.',
    );
  }
  return {
    url,
    serviceRoleKey,
    confirmEnv: env.CONFIRM_MFA_BREAK_GLASS,
    allowProdBreakGlass: env.ALLOW_PROD_BREAK_GLASS,
  };
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv);
  const cfg = loadEnvConfig(process.env);
  const client = createClient(cfg.url, cfg.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  }) as unknown as SupabaseAdminLike;

  const outcome = await runBreakGlass(
    {
      client,
      supabaseUrl: cfg.url,
      confirmEnv: cfg.confirmEnv,
      allowProdBreakGlass: cfg.allowProdBreakGlass,
      // eslint-disable-next-line no-console
      log: (line) => console.log(line),
      // eslint-disable-next-line no-console
      warn: (line) => console.error(line),
    },
    args,
  );

  if (outcome.message) {
    // eslint-disable-next-line no-console
    console.error(outcome.message);
  }
  process.exitCode = outcome.exitCode;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = EXIT_VALIDATION;
  });
}
