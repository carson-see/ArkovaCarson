#!/usr/bin/env -S npx tsx
/**
 * FD-17 (third instance) — RELATION-level replay-parity ratchet.
 *
 * THE DEFECT CLASS
 *   The squashed baseline carries
 *   `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON
 *   TABLES TO anon / authenticated` (baseline:15105-15106). Every table, view,
 *   materialised view and sequence created on the replay path therefore hands
 *   `anon` and `authenticated` the FULL relation privilege set at CREATE time,
 *   directly — not through PUBLIC. Only an explicit `REVOKE ... FROM anon`
 *   takes it back; a `GRANT ... TO service_role` next to the definition looks
 *   authoritative but is purely additive and removes nothing.
 *
 *   When the closing REVOKE lives somewhere the replay never runs — the
 *   `docs/migrations-archive/` tree, or an operator script under `scripts/ops/`
 *   — prod ends up MORE locked down than any environment rebuilt from
 *   `supabase/migrations/`. Every soak rig then produces evidence against a
 *   weaker security posture than the prod it stands in for. That is FD-17.
 *
 * WHY A SECOND RULE RATHER THAN AN EXTENSION OF THE SECDEF ONE
 *   `secdef-function-grants.ts` guards the same defect class on the FUNCTION
 *   axis: it parses `CREATE FUNCTION`, reasons about `has_function_privilege`,
 *   and burns keys down from `secdef-grants-baseline.json`. Every one of those
 *   moving parts is function-shaped. A view has no `SECURITY DEFINER` marker to
 *   parse and never had a key in that burn-down list to burn.
 *
 *   That blind spot is not hypothetical: it is why `public.v_slow_queries`
 *   survived BOTH 0414 (which replayed sixteen archive-only EXECUTE revokes)
 *   and 0418 (which replayed four operator-script-only EXECUTE revokes) while
 *   still sitting anon-readable in every rebuilt environment. 0419 closes the
 *   database side; this rule is what stops it reopening.
 *
 * WHAT IT CHECKS
 *   For each pinned relation, whether an ordered replay of
 *   `supabase/migrations/` ENDS with the relation revoked from `anon` (and
 *   `authenticated` unless the pin is anon-axis-only). Terminal state is the
 *   whole question, exactly as in `hasReplayPathRevoke` on the function side.
 *
 * ADDING AN ENTRY IS A SECURITY DECISION
 *   It needs the live prod ACL checked with
 *   `has_table_privilege('anon', '<schema>.<rel>', 'SELECT')` and a migration
 *   that actually carries the revoke. Pin what prod already does; do not invent
 *   a posture here.
 *
 * ENFORCEMENT
 *   Runs in the `Policy Lints` job via the feedback-rules orchestrator, which
 *   auto-discovers every `<name>.ts` in this directory. `Policy Lints` is not a
 *   Mergify merge condition, so the binding gate is the companion
 *   `relation-anon-grants.test.ts` — `vitest.config.ts` includes
 *   `scripts/**\/*.test.ts`, so it runs in `Tests`, which IS gated. Deleting
 *   0419 fails that test.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, '..', '..', '..');
const MIGRATIONS_DIR = resolve(REPO_ROOT, 'supabase/migrations');

export interface PinnedRelation {
  /** `<schema>.<relname>`. */
  relation: string;
  /** Where the closing revoke lives, and why the pin exists. */
  why: string;
  /**
   * True when prod deliberately KEEPS `authenticated` and only `anon` must be
   * closed. Mirrors `DELIBERATELY_AUTHENTICATED` on the function side: an
   * over-revoke would reverse a decision prod already made.
   */
  anonAxisOnly?: boolean;
}

/**
 * RELATION REPLAY-PARITY REVOKES — relations whose closing REVOKE necessarily
 * lives in a LATER migration than their definition, pinned so it cannot be
 * deleted without failing CI.
 */
export const REPLAY_PARITY_REVOKES: PinnedRelation[] = [
  {
    // 0419 — the pg_stat_statements diagnostic view. Defined by the squashed
    // baseline (baseline:9502) with a service_role grant (baseline:15050) and
    // no revoke; its real revoke is archive-only
    // (docs/migrations-archive/0192_enable_pg_stat_statements.sql:33). Prod ACL
    // verified 2026-08-22 against vzwyaatejekddvltxyye:
    // `postgres=arwdDxtm/postgres service_role=arwdDxtm/postgres`, with
    // has_table_privilege('anon'|'authenticated', ..., 'SELECT') both false. A
    // container replay of the baseline shape left anon and authenticated
    // holding all eight relation privileges.
    relation: 'public.v_slow_queries',
    why: 'revoke lives in 0419 (defined by the squashed baseline)',
  },
];

export interface FileSql {
  file: string;
  sql: string;
}

/**
 * Strip SQL comments and dollar-quoted bodies before matching.
 *
 * Mandatory, not cosmetic. Migration headers in this repo quote their own
 * ROLLBACK statements verbatim, so 0419's header contains the literal line
 * `GRANT ALL ON TABLE public.v_slow_queries TO anon, authenticated;`. Read as
 * live SQL that is a re-grant, and the rule would flag the very migration that
 * fixes the problem. Line comments go first, then block comments, then
 * dollar-quoted bodies (function bodies can embed either).
 */
export function normalize(rawSql: string): string {
  return rawSql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1?\$/g, ' ');
}

/**
 * Match `<schema>.<name>` or bare `<name>` as a whole identifier.
 *
 * The trailing guard is what stops `v_slow_queries` matching
 * `v_slow_queries_archive` — the same prefix-collision bug that made 0378's
 * revoke of `get_anchor_status_counts_fast` read as closing the un-suffixed
 * function. Either identifier may be double-quoted, since the squashed
 * baseline emits `"public"."v_slow_queries"`.
 */
function relationPattern(schema: string, name: string): RegExp {
  const s = escapeRegExp(schema);
  const n = escapeRegExp(name);
  return new RegExp(String.raw`(?:"?${s}"? ?\. ?)?"?${n}"?(?![\w$"])`, 'i');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Does this statement act on the relation (as opposed to a function of the
 * same name)? `ON FUNCTION` is excluded outright; `ON TABLE` / `ON SEQUENCE` /
 * a bare `ON <rel>` all count.
 */
function statementTargetsRelation(text: string, schema: string, name: string): boolean {
  if (/\bON\s+FUNCTION\b/i.test(text)) return false;
  if (!/\bON\b/i.test(text)) return false;
  return relationPattern(schema, name).test(text);
}

/** Does this normalized SQL define the relation? */
export function definesRelation(sql: string, schema: string, name: string): boolean {
  const re = new RegExp(
    String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:GLOBAL\s+|LOCAL\s+|TEMP\w*\s+|UNLOGGED\s+)?` +
      String.raw`(?:MATERIALIZED\s+)?(?:TABLE|VIEW|SEQUENCE)\s+(?:IF\s+NOT\s+EXISTS\s+)?` +
      relationPattern(schema, name).source,
    'i',
  );
  return re.test(sql);
}

/** Does this normalized SQL revoke the relation from the roles the pin requires closed? */
export function revokesRequiredRoles(
  sql: string,
  schema: string,
  name: string,
  anonAxisOnly: boolean,
): boolean {
  for (const stmt of sql.matchAll(/\bREVOKE\b[^;]*;/gi)) {
    const text = stmt[0];
    if (!statementTargetsRelation(text, schema, name)) continue;
    if (!/\banon\b/i.test(text)) continue;
    if (anonAxisOnly || /\bauthenticated\b/i.test(text)) return true;
  }
  return false;
}

/** Does this normalized SQL grant the relation back to a role that must stay closed? */
export function grantsBlockedRole(
  sql: string,
  schema: string,
  name: string,
  anonAxisOnly: boolean,
): boolean {
  for (const stmt of sql.matchAll(/\bGRANT\b[^;]*;/gi)) {
    const text = stmt[0];
    if (!statementTargetsRelation(text, schema, name)) continue;
    if (/\banon\b/i.test(text)) return true;
    if (!anonAxisOnly && /\bauthenticated\b/i.test(text)) return true;
  }
  return false;
}

/**
 * True when an ordered replay of `files` ENDS with the relation closed.
 *
 * Conservative on re-definition: the revoke must sit at or after the LAST file
 * that defines the relation. Measured Postgres behaviour is narrower than that
 * — `CREATE OR REPLACE` of an existing object PRESERVES its ACL, and only a
 * genuinely fresh create (or DROP + CREATE) re-applies ALTER DEFAULT
 * PRIVILEGES — but "fresh" is not decidable from static SQL, and demanding a
 * revoke alongside any later re-definition is the safe direction to be wrong
 * in. This matches the stance `hasReplayPathRevoke` takes on the function side.
 */
export function hasTerminalRelationRevoke(
  files: FileSql[],
  schema: string,
  name: string,
  anonAxisOnly = false,
): boolean {
  let lastDefine = -1;
  let lastRevoke = -1;
  let lastRegrant = -1;

  for (let i = 0; i < files.length; i++) {
    const sql = normalize(files[i].sql);
    if (definesRelation(sql, schema, name)) lastDefine = i;
    if (revokesRequiredRoles(sql, schema, name, anonAxisOnly)) lastRevoke = i;
    if (grantsBlockedRole(sql, schema, name, anonAxisOnly)) lastRegrant = i;
  }

  if (lastRevoke < 0) return false;
  if (lastRevoke < lastDefine) return false;
  return lastRegrant < lastRevoke;
}

export interface RelationViolation {
  relation: string;
  reason: string;
}

/** Every pinned relation an ordered replay would leave open to anon. */
export function findMissingRelationRevokes(
  files: FileSql[],
  pinned: PinnedRelation[] = REPLAY_PARITY_REVOKES,
): RelationViolation[] {
  const out: RelationViolation[] = [];
  for (const pin of pinned) {
    const [schema, name] = pin.relation.split('.');
    if (hasTerminalRelationRevoke(files, schema, name, pin.anonAxisOnly ?? false)) continue;
    out.push({
      relation: pin.relation,
      reason:
        `${pin.relation} is pinned in REPLAY_PARITY_REVOKES (${pin.why}) but no migration ` +
        `leaves it revoked from anon${pin.anonAxisOnly ? '' : ' and authenticated'} at the end ` +
        `of an ordered replay. A rebuilt environment would carry this relation readable by ` +
        `anon while prod does not.`,
    });
  }
  return out;
}

/** All migration files, oldest first. */
export function realMigrations(): FileSql[] {
  if (!existsSync(MIGRATIONS_DIR)) return [];
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ file: f, sql: readFileSync(resolve(MIGRATIONS_DIR, f), 'utf8') }));
}

export function run(): { ok: boolean; message: string } {
  const files = realMigrations();
  const missing = findMissingRelationRevokes(files);

  if (missing.length === 0) {
    return {
      ok: true,
      message:
        `✅ relation_anon_grants: all ${REPLAY_PARITY_REVOKES.length} pinned relation ` +
        `replay-parity revoke(s) survive an ordered replay of supabase/migrations/.`,
    };
  }

  const lines = missing.map((m) => `  - ${m.reason}`).join('\n');
  return {
    ok: false,
    message:
      `relation_anon_grants: ${missing.length} pinned relation replay-parity REVOKE(s) ` +
      `missing from supabase/migrations/:\n${lines}\n\n` +
      `These relations are defined in a file that cannot be edited (the squashed baseline,\n` +
      `or an already-merged migration), so their revoke lives in a later compensating\n` +
      `migration. Restore it, or remove the entry from REPLAY_PARITY_REVOKES — silently\n` +
      `dropping it reopens an anon-readable relation in every rebuilt environment while\n` +
      `prod stays closed, which is the FD-17 divergence this rule exists to prevent.\n`,
  };
}
