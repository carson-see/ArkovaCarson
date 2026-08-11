#!/usr/bin/env -S npx tsx
/**
 * Rule: every `public` SECURITY DEFINER function must explicitly REVOKE EXECUTE
 * from `anon` and `authenticated` in the migration that defines it.
 *
 * THE FAILURE MODE
 *   On Supabase, `ALTER DEFAULT PRIVILEGES` grants `anon` and `authenticated`
 *   EXECUTE **directly** at CREATE time. `REVOKE ALL ... FROM PUBLIC` removes
 *   the PUBLIC grant and nothing else — a direct role grant survives it. So the
 *   idiomatic-looking pair
 *
 *     REVOKE ALL ON FUNCTION public.f(int) FROM PUBLIC;
 *     GRANT EXECUTE ON FUNCTION public.f(int) TO service_role;
 *
 *   leaves the ACL as {postgres=X,anon=X,authenticated=X,service_role=X}. When
 *   the function is SECURITY DEFINER it also bypasses RLS, so the result is an
 *   RLS-bypassing RPC callable by anyone over PostgREST.
 *
 *   This has now happened five times — 0364, 0377, 0378, 0388, 0406 — which is
 *   why it is a detector and not a review checklist item. A careful reviewer
 *   missed it four times; a lint does not get tired.
 *
 * WHY SAME-FILE, AND WHY POSITION
 *   The functions use CREATE OR REPLACE, which RE-TRIGGERS default privileges
 *   on every replay. A revoke living in some later migration closes the hole
 *   once but re-opens it on the next replay of the defining migration. The
 *   revoke has to be adjacent to the definition.
 *
 *   Presence of a revoke is therefore NOT sufficient — the ACL is decided by
 *   the last statement to touch it. This rule requires the revoke to follow
 *   the function's LAST `CREATE OR REPLACE` (a revoke written above the
 *   definition is undone the instant the definition runs) and requires that no
 *   later `GRANT` hands EXECUTE back to `anon` or `authenticated`. Both holes
 *   passed the original presence-only check while shipping an anon-callable
 *   RLS-bypassing function.
 *
 * WHY `public` ONLY
 *   PostgREST exposes the `public` schema. A SECURITY DEFINER function in
 *   `private` (or any non-exposed schema) is not reachable by anon/authenticated
 *   over the API, and those schemas already carry a schema-level revoke.
 *
 * RATCHET, NOT A BIG BANG
 *   Pre-existing violations are pinned in `secdef-grants-baseline.json` as a
 *   burn-down list. Anything new fails. The baseline may only shrink — a stale
 *   entry (one that no longer violates) is itself a failure, so the list cannot
 *   quietly re-authorise a regression.
 *
 * ENFORCEMENT
 *   This module runs in the `Policy Lints` job via the feedback-rules
 *   orchestrator. Because `Policy Lints` is not a Mergify merge condition, the
 *   merge-time gate is `secdef-function-grants.test.ts`, which runs in `Tests`.
 *
 * Override: PR label `secdef-grants-skip`.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { hasLabel } from '../lib/ciContext.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const MIGRATIONS_DIR = resolve(REPO_ROOT, 'supabase/migrations');
const BASELINE_FILE = resolve(import.meta.dirname, 'secdef-grants-baseline.json');

/**
 * SECURITY DEFINER functions that are anon-callable ON PURPOSE — the public
 * verification surface. Adding to this set is a security decision: the function
 * must be safe to call unauthenticated and must do its own scoping.
 */
export const DELIBERATELY_PUBLIC = new Set([
  'public.get_public_anchor',
  'public.get_public_anchor_by_fingerprint',
  'public.search_public_credentials',
  'public.get_public_records_page',
]);

export interface SecdefFunction {
  file: string;
  schema: string;
  name: string;
  /** `<file>::<schema>.<name>` — the stable identity used by the baseline. */
  key: string;
}

export interface FileSql {
  file: string;
  sql: string;
}

/** Drop `--` comment lines so prose and ROLLBACK blocks never match. */
function stripComments(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

/**
 * Remove dollar-quoted bodies (`$$ ... $$`, `$tag$ ... $tag$`) so text inside a
 * function body cannot be mistaken for a declaration or a statement.
 */
function stripDollarQuoted(sql: string): string {
  return sql.replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1?\$/g, ' $BODY$ ');
}

function unquote(identifier: string): string {
  const t = identifier.trim();
  if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  return t.toLowerCase();
}

/** Escape a parsed identifier before it goes into a dynamic RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Comments stripped, then all whitespace collapsed to single spaces.
 *
 * Collapsing first keeps every pattern below free of repeated `\s+` groups.
 * That is deliberate: patterns combining several `\s+`/`\s*` metacharacters
 * trip Sonar's super-linear-runtime detector even when the real backtracking
 * risk is negligible, and `feedback_local_matches_prod.ts` already had to be
 * rewritten once for exactly that reason.
 */
function normalize(sql: string): string {
  return stripComments(sql).replace(/\s+/g, ' ');
}

const CREATE_FN = /CREATE (?:OR REPLACE )?FUNCTION ([^\s(]+) ?\(/gi;

/**
 * Comments stripped, whitespace collapsed, dollar-quoted bodies blanked.
 *
 * Every scan below shares this ONE representation so that character offsets
 * are comparable across them. That is what makes the ordering checks in
 * `hasExplicitRevoke` sound: an index from the CREATE scan and an index from
 * the REVOKE scan refer to the same string. Blanking bodies globally (rather
 * than per-declaration) also stops a `CREATE FUNCTION` mentioned inside a body
 * from shifting declaration boundaries.
 */
function prepare(rawSql: string): string {
  return stripDollarQuoted(normalize(rawSql));
}

/**
 * Every `public` SECURITY DEFINER function DEFINED in this SQL text.
 *
 * Each CREATE FUNCTION is sliced up to the next CREATE FUNCTION so a
 * `SECURITY DEFINER` can only be attributed to the declaration it follows.
 */
export function parseSecurityDefinerFunctions(file: string, rawSql: string): SecdefFunction[] {
  const sql = prepare(rawSql);

  const starts: { index: number; target: string }[] = [];
  for (const m of sql.matchAll(CREATE_FN)) {
    starts.push({ index: m.index, target: m[1] });
  }

  const seen = new Set<string>();
  const out: SecdefFunction[] = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i].index;
    const to = i + 1 < starts.length ? starts[i + 1].index : sql.length;
    // Bodies are already blanked by prepare(), so `SECURITY DEFINER` appearing
    // inside a body cannot promote a declaration.
    if (!/\bSECURITY DEFINER\b/i.test(sql.slice(from, to))) continue;

    const parts = starts[i].target.split('.');
    const name = unquote(parts[parts.length - 1]);
    const schema = parts.length > 1 ? unquote(parts[parts.length - 2]) : 'public';
    if (schema !== 'public') continue;

    // A file may CREATE OR REPLACE the same function more than once; it is one
    // function to report on, and `hasExplicitRevoke` judges it at its LAST
    // definition.
    const key = `${file}::${schema}.${name}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ file, schema, name, key });
  }
  return out;
}

/** True when a REVOKE/GRANT statement names this specific function. */
function statementTargets(text: string, schema: string, name: string): boolean {
  if (!/\bON FUNCTION\b/i.test(text)) return false;
  return (
    text.includes(`${schema}.${name}`) ||
    new RegExp(`\\b${escapeRegExp(name)} ?\\(`, 'i').test(text)
  );
}

/**
 * True when this SQL leaves the named function actually closed to `anon` and
 * `authenticated`. Three things must ALL hold, because the ACL is decided by
 * the LAST statement to touch it, not by the presence of a revoke somewhere:
 *
 *   1. a REVOKE on this function strips BOTH roles BY NAME — `FROM PUBLIC`
 *      alone does not count, since ALTER DEFAULT PRIVILEGES grants the two
 *      roles directly and a PUBLIC revoke never removes a direct grant;
 *   2. that REVOKE comes AFTER the function's LAST `CREATE OR REPLACE` —
 *      CREATE OR REPLACE re-runs ALTER DEFAULT PRIVILEGES, so a revoke written
 *      above the definition is undone the moment the definition runs, and a
 *      re-definition below a revoke re-opens what the revoke closed; and
 *   3. no later GRANT on this function hands EXECUTE back to either role.
 *
 * Checks 2 and 3 are why every scan runs over the same `prepare()` output:
 * ordering is only meaningful in a shared index space.
 */
export function hasExplicitRevoke(rawSql: string, schema: string, name: string): boolean {
  const sql = prepare(rawSql);
  const qualified = `${schema}.${name}`;

  // The definition the ACL ends up reflecting is the LAST one.
  let lastCreate = -1;
  for (const m of sql.matchAll(CREATE_FN)) {
    const target = m[1].toLowerCase();
    if (target === qualified || target === name) lastCreate = m.index;
  }

  let revokeAt = -1;
  for (const stmt of sql.matchAll(/\bREVOKE\b[^;]*;/gi)) {
    const text = stmt[0];
    if (!statementTargets(text, schema, name)) continue;
    if (!/\banon\b/i.test(text) || !/\bauthenticated\b/i.test(text)) continue;
    if (stmt.index < lastCreate) continue; // undone by the CREATE OR REPLACE below it
    revokeAt = stmt.index;
    break;
  }
  if (revokeAt < 0) return false;

  // A re-grant after the revoke puts the role straight back.
  for (const stmt of sql.matchAll(/\bGRANT\b[^;]*;/gi)) {
    const text = stmt[0];
    if (stmt.index < revokeAt) continue;
    if (!statementTargets(text, schema, name)) continue;
    if (/\banon\b/i.test(text) || /\bauthenticated\b/i.test(text)) return false;
  }
  return true;
}

export interface Violation extends SecdefFunction {
  reason: string;
}

export function findViolations(
  files: FileSql[],
  opts: { deliberatelyPublic?: Set<string> } = {},
): Violation[] {
  const allowed = opts.deliberatelyPublic ?? new Set<string>();
  const out: Violation[] = [];

  for (const { file, sql } of files) {
    for (const fn of parseSecurityDefinerFunctions(file, sql)) {
      if (allowed.has(`${fn.schema}.${fn.name}`)) continue;
      if (hasExplicitRevoke(sql, fn.schema, fn.name)) continue;
      out.push({
        ...fn,
        reason:
          `SECURITY DEFINER ${fn.schema}.${fn.name} has no ` +
          `\`REVOKE ... ON FUNCTION ${fn.schema}.${fn.name}(...) FROM PUBLIC, anon, authenticated;\` ` +
          `in ${file}`,
      });
    }
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

export function loadBaseline(): Set<string> {
  if (!existsSync(BASELINE_FILE)) return new Set();
  const parsed = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as {
    grandfathered?: string[];
  };
  return new Set(parsed.grandfathered ?? []);
}

export function run(): { ok: boolean; message: string } {
  if (hasLabel('secdef-grants-skip')) {
    return { ok: true, message: '🏷️  secdef_function_grants: skipped (label `secdef-grants-skip`).' };
  }

  const files = realMigrations();
  const baseline = loadBaseline();
  const all = findViolations(files, { deliberatelyPublic: DELIBERATELY_PUBLIC });
  const fresh = all.filter((v) => !baseline.has(v.key));

  // The baseline may only SHRINK. An entry that no longer violates is a
  // failure in its own right: left in place it silently re-authorises a
  // regression on that exact key. Enforced here as well as in the vitest file
  // so that running this rule directly — the obvious way to check your work —
  // cannot report a false all-clear on a rotted baseline.
  const live = new Set(all.map((v) => v.key));
  const stale = [...baseline].filter((k) => !live.has(k)).sort();

  if (fresh.length === 0 && stale.length === 0) {
    return {
      ok: true,
      message:
        `✅ secdef_function_grants: no new SECURITY DEFINER function is missing its ` +
        `anon/authenticated REVOKE (${baseline.size} grandfathered, burn-down list in ` +
        `scripts/ci/feedback-rules/secdef-grants-baseline.json).`,
    };
  }

  if (fresh.length === 0) {
    return {
      ok: false,
      message:
        `secdef_function_grants: ${stale.length} baseline entr(ies) no longer violate — ` +
        `delete them from scripts/ci/feedback-rules/secdef-grants-baseline.json so the ` +
        `burn-down list stays honest:\n${stale.map((k) => `  - ${k}`).join('\n')}`,
    };
  }

  const lines = fresh.map((v) => `  - ${v.key}\n      ${v.reason}`);
  return {
    ok: false,
    message:
      `secdef_function_grants: ${fresh.length} SECURITY DEFINER function(s) missing an ` +
      `explicit REVOKE from anon/authenticated:\n${lines.join('\n')}\n\n` +
      `On Supabase, ALTER DEFAULT PRIVILEGES grants anon and authenticated EXECUTE\n` +
      `DIRECTLY at CREATE time; \`REVOKE ... FROM PUBLIC\` does not remove a direct\n` +
      `role grant. Add, next to the definition:\n\n` +
      `  REVOKE ALL ON FUNCTION <schema>.<fn>(<args>) FROM PUBLIC, anon, authenticated;\n` +
      `  GRANT EXECUTE ON FUNCTION <schema>.<fn>(<args>) TO service_role;\n`,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = run();
  console.log(result.message);
  process.exit(result.ok ? 0 : 1);
}
