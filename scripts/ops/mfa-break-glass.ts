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
 *   env CONFIRM_MFA_BREAK_GLASS=<email> equal to the resolved email
 *   (and, for --all, ALSO CONFIRM_MFA_BREAK_GLASS_ALL=<email> — a
 *   second-tier ack, same shape as provision-isolated-rig.sh's
 *   CONFIRM_REAL_CONFIG, since "every factor this person has" is a much
 *   larger blast radius than one factor id) -> write an audit_events
 *   INTENT row BEFORE deleting anything -> deleteFactor per selected id
 *   -> write a COMPLETION row -> any audit write failure is loud and
 *   exits non-zero.
 *
 * GoTrue rule this tool depends on (CTO plan Amendment A3): deleting a
 * VERIFIED factor invalidates every session of that user with AAL below
 * aal2 — i.e. this logs the user out everywhere. That is expected, not a
 * bug. At this head (before SCRUM-3167's enforcement gate ships — see
 * branch security/mfa-enforcement-3167), the user simply signs back in
 * with their password and re-enrolls from Settings; once that PR is
 * live, they may instead be routed through a mandatory re-enrollment
 * screen depending on their role and the enforcement date. Either way
 * this tool's job ends at "the factor is gone" — see the runbook for
 * what the user experiences next.
 *
 * Dry run is the default and writes NOTHING: it resolves the user, lists
 * every factor, validates a selection if one was given, and prints the
 * plan. Only `--apply` plus the matching CONFIRM env var(s) performs a
 * delete.
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
 * requires ALLOW_PROD_BREAK_GLASS=1 — for ANY run, dry run included —
 * printed as a red banner. See the runbook's "never" list before ever
 * setting that.
 *
 * Exit codes:
 *   0 — dry run completed, or apply completed with every selected
 *       factor deleted and both audit rows recorded.
 *   1 — validation / precondition failure. NOTHING was written: bad
 *       args, duplicated flags, user not found, --factor-id doesn't
 *       belong to the resolved user, missing/mismatched CONFIRM env
 *       var(s), or a prod host was denied without
 *       ALLOW_PROD_BREAK_GLASS=1.
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
import { realpathSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
// Self-contained (no further imports) — safe to reuse across the frontend/
// scripts tsconfig boundary. Canonical fix for the 2026-08-17 poison-record
// incident (docs/staging/fullsoak-2026-08/prod-repair-poison-record-2026-08-17.md):
// `String.prototype.slice` cuts at UTF-16 code-unit boundaries, which can
// leave a lone surrogate that PostgREST rejects as invalid JSON. Reusing the
// one canonical helper here instead of re-deriving the same fix locally.
import { truncateUtf16Safe } from '../../services/worker/src/utils/utf16-truncate.js';

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

/** SCREAMING_SNAKE to match the dominant event_type casing convention in
 * this codebase (the EMERGENCY_ACCESS_* family is the closest precedent for
 * "an operator did a privileged, auditable thing to someone else's
 * account"). */
const EVENT_TYPE_REQUESTED = 'MFA_BREAK_GLASS_REQUESTED';
const EVENT_TYPE_COMPLETED = 'MFA_BREAK_GLASS_COMPLETED';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

/**
 * Only `SCRUM-1234` or this exact Jira browse URL shape — NOT any http(s)
 * URL. An arbitrary URL (a Google Doc, a Slack thread) isn't a ticket
 * reference this tool can rely on existing or staying reachable; the Jira
 * link is the one external reference this repo treats as durable.
 */
function isValidTicketRef(ticket: string): boolean {
  if (/^SCRUM-\d+$/i.test(ticket)) return true;
  return /^https:\/\/arkova\.atlassian\.net\/browse\/SCRUM-\d+\/?$/i.test(ticket);
}

const ArgsSchema = z
  .object({
    email: z.string().trim().email('--email must be a valid email address'),
    factorId: z.string().trim().min(1).optional(),
    all: z.boolean().default(false),
    reason: z
      .string()
      .trim()
      .min(1, '--reason is required')
      .max(2000, '--reason must be 2000 characters or fewer'),
    ticket: z
      .string()
      .trim()
      .min(1, '--ticket is required')
      .max(300, '--ticket must be 300 characters or fewer')
      .refine(isValidTicketRef, {
        message: '--ticket must look like SCRUM-1234 or https://arkova.atlassian.net/browse/SCRUM-1234',
      }),
    operator: z
      .string()
      .trim()
      .min(1, '--operator (name/email) is required')
      .max(200, '--operator must be 200 characters or fewer'),
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
  const cliTokens = argv.slice(2);

  // parseArgs runs FIRST and every option is declared `multiple: true`.
  // `parseArgs` rejects an option whose value token itself looks like
  // another flag (e.g. `--reason --ticket ...`, where `--reason` never got
  // a real value) with ERR_PARSE_ARGS_INVALID_OPTION_VALUE naming the flag
  // that's actually missing its argument — see review finding #4
  // (SCRUM-3584 PR #2635). `multiple: true` makes parseArgs itself collect
  // EVERY occurrence of a flag instead of silently keeping only the last
  // (`--email a --email b` used to resolve to `b` with no signal that
  // anything was dropped) — a repeated flag then shows up here as an array
  // of length > 1, which `parseCliArgs` treats as a duplicate below. This
  // replaces the separate `findDuplicateFlags` pre-scan (review finding B,
  // simplify pass): one parseArgs call now does both jobs.
  const { values } = parseArgs({
    args: cliTokens,
    options: {
      email: { type: 'string', multiple: true },
      'factor-id': { type: 'string', multiple: true },
      all: { type: 'boolean', multiple: true, default: [false] },
      reason: { type: 'string', multiple: true },
      ticket: { type: 'string', multiple: true },
      operator: { type: 'string', multiple: true },
      apply: { type: 'boolean', multiple: true, default: [false] },
    },
  });

  const duplicates = Object.entries(values)
    .filter(([, v]) => Array.isArray(v) && v.length > 1)
    .map(([name]) => name);
  if (duplicates.length > 0) {
    throw new Error(`each flag may be given once; repeated: ${duplicates.map((d) => `--${d}`).join(', ')}`);
  }

  const result = ArgsSchema.safeParse({
    email: values.email?.[0],
    factorId: values['factor-id']?.[0],
    all: values.all?.[0],
    reason: values.reason?.[0],
    ticket: values.ticket?.[0],
    operator: values.operator?.[0],
    apply: values.apply?.[0],
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
  /** Matches auth-js `Factor.friendly_name?: string` — optional, never `null` on the wire. */
  friendly_name?: string | null;
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

/**
 * `data` mirrors `auth-js` `GoTrueAdminApi.listUsers` exactly: on success it
 * is `{ users, nextPage, lastPage, total }` (never `null`); on failure it is
 * `{ users: [] }` with `error` set. There is no "no data" shape to defend
 * against — `nextPage` is `null` once the Link header carries no further
 * page, which is the real pagination-termination signal (a short `users`
 * array is NOT — the last page can happen to be full).
 */
interface ListUsersData {
  users: AdminUserRow[];
  nextPage?: number | null;
}

export interface SupabaseAdminLike {
  auth: {
    admin: {
      listUsers(params: { page: number; perPage: number }): Promise<{
        data: ListUsersData;
        error: SupabaseErrorLike | null;
      }>;
      getUserById(id: string): Promise<{
        data: { user: AdminUserRow | null };
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

interface ResolvedUser {
  id: string;
  email: string;
  /**
   * Known eagerly (a string, or `null` for a profile with no org) when
   * resolution folded `org_id` into the fast-path profiles SELECT —
   * `undefined` when resolution came from the `listUsers` scan instead,
   * which doesn't carry `org_id` and needs the separate `lookupOrgId` call
   * in `runBreakGlass` (review finding F, SCRUM-3584 PR #2635 simplify
   * pass: one profiles query instead of two on the common fast-path hit).
   */
  org_id?: string | null;
}

interface FactorDeleteResult {
  id: string;
  friendly_name: string | null;
  status: 'deleted' | 'failed';
  error?: string;
}

interface BreakGlassSummary {
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

interface BreakGlassOutcome {
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
  /** process.env.CONFIRM_MFA_BREAK_GLASS_ALL — required in addition, only for --all --apply. */
  confirmAllEnv?: string;
  /** process.env.ALLOW_PROD_BREAK_GLASS */
  allowProdBreakGlass?: string;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Non-Error rejections happen (a re-thrown postgrest-js error, a plain
 * `{message}` object) — falling through to `String(err)` on those produces
 * the useless `"[object Object]"` in exactly the exit-3 "insert this row
 * manually" message where operators most need a real reason.
 */
function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null) {
    const maybeMessage = (err as { message?: unknown }).message;
    if (typeof maybeMessage === 'string') return maybeMessage;
  }
  return String(err);
}

/**
 * One canonical email-comparison normalizer, used everywhere this script
 * compares two emails (resolution target, CONFIRM env vars). NFKC folds
 * compatibility variants before lowercasing so equivalent-looking inputs
 * compare equal consistently across every call site — this does not claim
 * full Unicode case-folding correctness (e.g. the Turkish dotted-İ problem
 * has no locale-free general solution), only that this tool applies the
 * SAME normalization everywhere instead of ad hoc `.toLowerCase()` calls
 * that could drift out of sync with each other.
 */
export function normalizeEmail(value: string): string {
  return value.trim().normalize('NFKC').toLowerCase();
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

/**
 * Shared by both prod-deny sites — `main()` (before the service-role client
 * is even constructed) and `runBreakGlass()`'s defence-in-depth repeat of
 * the same check for any caller that skips `main()`. Message text unchanged
 * from before this helper existed (review finding C, SCRUM-3584 PR #2635
 * simplify pass) — `url` is accepted for symmetry with the other prod-deny
 * call site and to keep this the one place that would need to change if the
 * message ever needs to name the host, but the wording itself has never
 * included it (`redBanner` above is what prints the host).
 */
function prodDenyMessage(url: string): string {
  void url;
  return `SUPABASE_URL targets production (${PROD_SUPABASE_REF}). Refusing without ALLOW_PROD_BREAK_GLASS=1 — see docs/runbooks/mfa-break-glass.md.`;
}

const LIST_USERS_PAGE_SIZE = 200;
/**
 * Safety cap on the number of listUsers REQUESTS, not a real pagination
 * limit — real termination is `nextPage` going null. This exists only so a
 * broken/malicious backend that always returns a truthy `nextPage` can't
 * spin this into an infinite loop.
 */
const LIST_USERS_MAX_PAGES = 200;

/**
 * Fast path: `profiles.email` is populated by the DB trigger
 * `enforce_lowercase_email()` (baseline migration), which ONLY lowercases —
 * it does not NFKC-normalize. Querying with that exact same
 * transformation (`email.trim().toLowerCase()`, no NFKC — same precedent as
 * services/worker/src/api/invitations.ts's own profiles-by-email lookup) is
 * what actually matches what the trigger persisted; an input whose NFKC
 * form diverges from its plain trim+lowercase form (e.g. a fullwidth or
 * ligature character) simply won't hit this fast path and falls through to
 * the `auth.admin.listUsers()` scan below, which normalizes fully via
 * `normalizeEmail()` on both sides and will still find the user — slower,
 * but correct. `org_id` is folded into the same SELECT (review finding F,
 * SCRUM-3584 PR #2635 simplify pass) so a fast-path hit costs exactly one
 * profiles query instead of a second one later for `lookupOrgId`. The
 * profiles row is only a CANDIDATE — `auth.admin.getUserById()` confirms
 * the auth user still exists before trusting it, since a profile can
 * outlive an auth-side deletion, and the LIVE auth email (not the profiles
 * row's email) is what gets returned. Returns `null` (never throws) on any
 * inconclusive outcome — including the profiles lookup itself failing — so
 * the caller always has a safe, slower fallback.
 */
async function tryResolveViaProfilesFastPath(
  client: SupabaseAdminLike,
  email: string,
): Promise<ResolvedUser | null> {
  try {
    const target = email.trim().toLowerCase();
    const { data, error } = await client.from('profiles').select('id,email,org_id').eq('email', target).maybeSingle();
    const row = data as { id?: unknown; org_id?: unknown } | null;
    if (error || typeof row?.id !== 'string' || row.id.length === 0) return null;

    const { data: userData, error: getErr } = await client.auth.admin.getUserById(row.id);
    const authUser = userData?.user;
    if (getErr || !authUser) return null;

    return {
      id: authUser.id,
      email: authUser.email ?? normalizeEmail(email),
      org_id: typeof row.org_id === 'string' ? row.org_id : null,
    };
  } catch {
    return null;
  }
}

/**
 * Fallback: paginate `auth.admin.listUsers()` until `nextPage` is null (real
 * termination signal — a short `users` array does NOT mean "last page") or
 * the runaway-loop guard trips. Used when the user has no `profiles` row
 * (e.g. an auth user mid-signup) or the fast path above was inconclusive.
 */
async function resolveUserByEmailScan(client: SupabaseAdminLike, target: string): Promise<ResolvedUser | null> {
  let page: number | null = 1;
  for (let i = 0; i < LIST_USERS_MAX_PAGES && page !== null; i += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: LIST_USERS_PAGE_SIZE });
    if (error) throw new Error(error.message);
    const users = data?.users ?? [];
    const found = users.find((u) => normalizeEmail(u.email ?? '') === target);
    if (found) return { id: found.id, email: found.email ?? target };
    page = data?.nextPage ?? null;
  }
  if (page !== null) {
    throw new Error(
      `exceeded ${LIST_USERS_MAX_PAGES} pages of auth.admin.listUsers while scanning for "${target}" — the user ` +
        'may still exist; this is a runaway-loop guard, not proof of absence. Investigate pagination or check auth.users directly.',
    );
  }
  return null;
}

async function resolveUserByEmail(client: SupabaseAdminLike, email: string): Promise<ResolvedUser | null> {
  const viaProfiles = await tryResolveViaProfilesFastPath(client, email);
  if (viaProfiles) return viaProfiles;
  const target = normalizeEmail(email);
  return resolveUserByEmailScan(client, target);
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
 * Keeps `details` under the audit_events CHECK (<=10000 chars). NEVER slices
 * the SERIALIZED JSON string — that is exactly the bug class
 * scripts/ci/feedback-rules/surrogate-safe-truncate.ts exists to catch: a
 * cut landing inside a `\uXXXX` escape or a UTF-16 surrogate pair produces
 * either invalid JSON or a lone surrogate that PostgREST rejects wholesale
 * (the 2026-08-17 incident). Instead this only ever shortens the `reason`
 * field VALUE with `truncateUtf16Safe` (surrogate-safe) and re-serializes,
 * shrinking further in a small bounded loop until it fits — so the result
 * is always valid JSON, by construction, never by hoping the cut point was
 * safe.
 */
export function boundedDetailsJson(details: Record<string, unknown>): string {
  const full = JSON.stringify(details);
  if (full.length <= AUDIT_DETAILS_MAX) return full;

  const reason = typeof details.reason === 'string' ? details.reason : '';
  const overBy = full.length - AUDIT_DETAILS_MAX;
  let truncatedReason = truncateUtf16Safe(reason, Math.max(0, reason.length - overBy - 40));
  let candidate = JSON.stringify({ ...details, reason: truncatedReason, _truncated: true });

  let guard = 0;
  while (candidate.length > AUDIT_DETAILS_MAX && truncatedReason.length > 0 && guard < 20) {
    truncatedReason = truncateUtf16Safe(truncatedReason, Math.floor(truncatedReason.length / 2));
    candidate = JSON.stringify({ ...details, reason: truncatedReason, _truncated: true });
    guard += 1;
  }
  if (candidate.length <= AUDIT_DETAILS_MAX) return candidate;

  // Reason alone can't make it fit — astronomically unlikely given the Zod
  // caps (reason <=2000, operator <=200, ticket <=300) — so drop
  // friendly_names too before falling back to the identifying fields only.
  const withoutFriendlyNames = JSON.stringify({ ...details, reason: '', friendly_names: [], _truncated: true });
  if (withoutFriendlyNames.length <= AUDIT_DETAILS_MAX) return withoutFriendlyNames;

  // Absolute last resort. `factor_ids` and `user_id`/`ticket` are NOT
  // Zod-capped the way `reason`/`operator`/`ticket` (the CLI-args ones) are —
  // `factor_ids` in particular is server/GoTrue-controlled, not CLI input —
  // so this function must stay bounded even if a future caller hands it an
  // unreasonably large id list. Every remaining field gets its OWN
  // surrogate-safe cap rather than assuming any of them is inherently small.
  const userId = typeof details.user_id === 'string' ? truncateUtf16Safe(details.user_id, 100) : null;
  const ticket = typeof details.ticket === 'string' ? truncateUtf16Safe(details.ticket, 100) : null;
  const factorIdsJoined = Array.isArray(details.factor_ids) ? details.factor_ids.join(',') : '';
  const factorIdsCapped = truncateUtf16Safe(factorIdsJoined, 9000);

  return JSON.stringify({
    user_id: userId,
    factor_ids: factorIdsCapped,
    ticket,
    _truncated: true,
    _truncated_hard: true,
  });
}

/** Builds the two audit rows this tool writes — same 7-field shape, different event_type/details. */
function buildAuditRow(
  eventType: string,
  targetId: string,
  orgId: string | null,
  details: Record<string, unknown>,
): Record<string, unknown> {
  return {
    event_type: eventType,
    event_category: 'SECURITY',
    actor_id: null,
    target_type: 'mfa_factor',
    target_id: targetId,
    org_id: orgId,
    details: boundedDetailsJson(details),
  };
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

/**
 * Shared by both CONFIRM_* gates (CONFIRM_MFA_BREAK_GLASS and
 * CONFIRM_MFA_BREAK_GLASS_ALL) — review finding D, SCRUM-3584 PR #2635
 * simplify pass. Returns `null` when `value` is set and normalize-equal to
 * `expectedEmail`, otherwise the exact failure message text each of the two
 * call sites has always used (kept verbatim, not unified into one generic
 * sentence, since they differ in whether the gate is the first or second
 * ack and existing operators/runbook readers know these exact strings).
 */
function checkConfirmEnv(value: string | undefined, expectedEmail: string, envName: string): string | null {
  if (value && normalizeEmail(value) === normalizeEmail(expectedEmail)) return null;
  const got = value ? JSON.stringify(value) : '<unset>';
  if (envName === 'CONFIRM_MFA_BREAK_GLASS') {
    return `CONFIRM_MFA_BREAK_GLASS must equal the resolved user's email ("${expectedEmail}") to apply. Got ${got}.`;
  }
  return `--all also requires CONFIRM_MFA_BREAK_GLASS_ALL to equal the resolved user's email ("${expectedEmail}"). Got ${got}.`;
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

  // 0. Prod hard-deny — defence in depth. `main()` already checks this
  // BEFORE constructing a client with real credentials (so a prod client is
  // never even built without the flag); this repeats the check for any
  // caller that invokes runBreakGlass() directly with a client already in
  // hand (tests, or a future entrypoint) rather than relying on main()'s
  // earlier gate.
  if (isProdHost(deps.supabaseUrl)) {
    if (deps.allowProdBreakGlass !== '1') {
      return fail(prodDenyMessage(deps.supabaseUrl));
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

  // 2. List every factor, and look up org_id UNLESS the fast-path
  // resolution above already folded it into its own profiles SELECT
  // (review finding F, SCRUM-3584 PR #2635 simplify pass) — `org_id` is
  // present (a string or `null`) when it's already known, `undefined` only
  // when resolution came from the listUsers scan instead, which requires
  // this separate profiles-by-id lookup. Print the table always (dry run
  // and apply).
  let factors: MfaFactorRow[];
  let orgId: string | null;
  try {
    if (user.org_id !== undefined) {
      factors = await listFactorsForUser(deps.client, user.id);
      orgId = user.org_id;
    } else {
      [factors, orgId] = await Promise.all([
        listFactorsForUser(deps.client, user.id),
        lookupOrgId(deps.client, user.id, warn),
      ]);
    }
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
  const selectedIds = selected.map((f) => f.id);

  const baseSummary: BreakGlassSummary = {
    mode: args.apply ? 'apply' : 'dry-run',
    user_id: user.id,
    email: user.email,
    org_id: orgId,
    factors_found: factors.length,
    factors_selected: selectedIds,
  };

  if (!args.apply) {
    log(JSON.stringify(baseSummary, null, 2));
    return { exitCode: EXIT_SUCCESS, summary: baseSummary };
  }

  // Args validation guarantees factorId or all was given when apply=true,
  // and the factorId branch above already returned on a non-match. This IS
  // still reachable, though — not a logic bug: `--all --apply` on a user
  // with zero enrolled factors reaches here with `selected = []`. Fail
  // safely with a clear message rather than silently "succeeding" at
  // deleting nothing.
  if (selectedIds.length === 0) {
    return fail('no factors selected for --apply — this user has no MFA factors to remove');
  }

  // 4. CONFIRM_MFA_BREAK_GLASS must equal the RESOLVED email.
  const confirmError = checkConfirmEnv(deps.confirmEnv, user.email, 'CONFIRM_MFA_BREAK_GLASS');
  if (confirmError) return fail(confirmError);

  // 4b. --all is a strictly larger blast radius than one --factor-id — every
  // factor this person has, in one command. Require a SECOND, distinct ack
  // (same two-tier shape as provision-isolated-rig.sh's CONFIRM_REAL_CONFIG
  // guarding a real-credentials profile) so `--all --apply` can never fire
  // off of a single copy-pasted CONFIRM_MFA_BREAK_GLASS value alone.
  if (args.all) {
    const confirmAllError = checkConfirmEnv(deps.confirmAllEnv, user.email, 'CONFIRM_MFA_BREAK_GLASS_ALL');
    if (confirmAllError) return fail(confirmAllError);
  }

  const detailsBase = {
    // Identifying fields FIRST, so they survive even if boundedDetailsJson
    // ever has to truncate — reason (the most likely field to be long, and
    // the least essential for identifying WHAT was deleted) goes last.
    user_id: user.id,
    factor_ids: selectedIds,
    statuses: selected.map((f) => f.status),
    ticket: args.ticket,
    operator: args.operator,
    host: safeHost(deps.supabaseUrl),
    friendly_names: selected.map((f) => f.friendly_name ?? null),
    reason: args.reason,
  };
  const targetId = selectedIds.join(',');

  // 5. INTENT audit row — BEFORE any delete. Failure aborts with nothing touched.
  const intentRow = buildAuditRow(EVENT_TYPE_REQUESTED, targetId, orgId, detailsBase);

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
  // loop — every selected factor gets one attempt, and every outcome
  // (success or failure) is recorded in the COMPLETION row below.
  const results: FactorDeleteResult[] = [];
  for (const factor of selected) {
    try {
      const { error } = await deps.client.auth.admin.mfa.deleteFactor({ id: factor.id, userId: user.id });
      results.push(
        error
          ? { id: factor.id, friendly_name: factor.friendly_name ?? null, status: 'failed', error: error.message }
          : { id: factor.id, friendly_name: factor.friendly_name ?? null, status: 'deleted' },
      );
    } catch (err) {
      results.push({ id: factor.id, friendly_name: factor.friendly_name ?? null, status: 'failed', error: errMessage(err) });
    }
  }
  const anyFailed = results.some((r) => r.status === 'failed');

  // 7. COMPLETION audit row — always attempted, success or failure alike.
  const completionRow = buildAuditRow(EVENT_TYPE_COMPLETED, targetId, orgId, { ...detailsBase, results });

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
// Entrypoint-detection helper
// ---------------------------------------------------------------------------

/** Injectable for tests only — production always uses the real `realpathSync` + stderr. */
export interface IsDirectEntrypointDeps {
  realpath?: (path: string) => string;
  warn?: (line: string) => void;
}

function defaultEntrypointWarn(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * Decides whether this module was invoked directly (`node script.js`,
 * `npx tsx script.ts`) vs merely imported. The naive
 * `fileURLToPath(import.meta.url) === process.argv[1]` comparison is a
 * STRING equality check on two paths that can each be spelled multiple
 * ways for the same file: `process.argv[1]` may be relative
 * (`npx tsx scripts/ops/mfa-break-glass.ts` from the repo root) and either
 * side may cross a symlink (macOS aliases `/tmp` to `/private/tmp`, so a
 * script run from a `/tmp/...` path never string-matches its own
 * `import.meta.url`, which Node resolves to the `/private/tmp/...` real
 * path). Both failure modes make `main()` silently never run — exit 0, no
 * output, no error — which is a much worse failure mode for an ops tool
 * than a loud crash. `realpathSync` on both sides after resolving argv1 to
 * an absolute path closes both gaps.
 *
 * A `realpathSync` failure (argv1 doesn't exist, a permissions error, a
 * transient FS issue) used to be swallowed into a blanket "not the
 * entrypoint" — silently exit 0 with `main()` never invoked, the same
 * silent no-op this function exists to prevent in the first place (review
 * finding #5, SCRUM-3584 PR #2635). Instead, a realpath failure now falls
 * back to comparing the UNRESOLVED path strings (argv1 normalized via
 * `path.resolve`, the module URL normalized via `fileURLToPath`) — weaker
 * (it won't catch a symlink pointing at the same file under a different
 * name) but it means this can still correctly say "yes, run main()" for
 * the ordinary non-symlinked case, and it writes one line to stderr naming
 * why the fallback triggered so the fallback is never silent. No secrets
 * are involved in either the paths or the underlying fs error message.
 */
export function isDirectEntrypoint(
  argv1: string | undefined,
  moduleUrl: string,
  deps: IsDirectEntrypointDeps = {},
): boolean {
  if (!argv1) return false;
  const realpath = deps.realpath ?? realpathSync;
  const warn = deps.warn ?? defaultEntrypointWarn;

  let invokedResolved: string;
  let thisFileRaw: string;
  try {
    invokedResolved = resolvePath(argv1);
    thisFileRaw = fileURLToPath(moduleUrl);
  } catch {
    // Can't even build the two paths to compare (e.g. a malformed module
    // URL) — no sane fallback exists either.
    return false;
  }

  try {
    return realpath(invokedResolved) === realpath(thisFileRaw);
  } catch (err) {
    warn(
      `isDirectEntrypoint: realpath failed (${errMessage(err)}) — falling back to unresolved path string ` +
        'comparison. A symlinked invocation of a DIFFERENT real file may no longer be detected as a match.',
    );
    return invokedResolved === thisFileRaw;
  }
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

interface EnvConfig {
  url: string;
  serviceRoleKey: string;
  confirmEnv?: string;
  confirmAllEnv?: string;
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
    confirmAllEnv: env.CONFIRM_MFA_BREAK_GLASS_ALL,
    allowProdBreakGlass: env.ALLOW_PROD_BREAK_GLASS,
  };
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv);
  const cfg = loadEnvConfig(process.env);

  // Prod-host hard-deny BEFORE constructing a client with real prod
  // credentials — never build a service-role client pointed at prod without
  // the flag, even one that ends up unused. runBreakGlass() re-checks this
  // (see its own step 0) for any caller that skips main(); that duplicate
  // check does not re-print this banner.
  if (isProdHost(cfg.url) && cfg.allowProdBreakGlass !== '1') {
    // eslint-disable-next-line no-console
    console.error(prodDenyMessage(cfg.url));
    process.exitCode = EXIT_VALIDATION;
    return;
  }

  const client = createClient(cfg.url, cfg.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  }) as unknown as SupabaseAdminLike;

  const outcome = await runBreakGlass(
    {
      client,
      supabaseUrl: cfg.url,
      confirmEnv: cfg.confirmEnv,
      confirmAllEnv: cfg.confirmAllEnv,
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

if (isDirectEntrypoint(process.argv[1], import.meta.url)) {
  main().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(errMessage(err));
    process.exitCode = EXIT_VALIDATION;
  });
}
