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
 * WHY SAME-FILE
 *   The functions use CREATE OR REPLACE, which RE-TRIGGERS default privileges
 *   on every replay. A revoke living in some later migration closes the hole
 *   once but re-opens it on the next replay of the defining migration. The
 *   revoke has to be adjacent to the definition.
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
 * Every `public` SECURITY DEFINER function DEFINED in this SQL text.
 *
 * Each CREATE FUNCTION is sliced up to the next CREATE FUNCTION so a
 * `SECURITY DEFINER` can only be attributed to the declaration it follows.
 */
export function parseSecurityDefinerFunctions(file: string, rawSql: string): SecdefFunction[] {
  const sql = normalize(rawSql);

  const starts: { index: number; target: string }[] = [];
  for (const m of sql.matchAll(CREATE_FN)) {
    starts.push({ index: m.index, target: m[1] });
  }

  const out: SecdefFunction[] = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i].index;
    const to = i + 1 < starts.length ? starts[i + 1].index : sql.length;
    // Strip the body so `SECURITY DEFINER` inside a string/body cannot match.
    const decl = stripDollarQuoted(sql.slice(from, to));
    if (!/\bSECURITY DEFINER\b/i.test(decl)) continue;

    const parts = starts[i].target.split('.');
    const name = unquote(parts[parts.length - 1]);
    const schema = parts.length > 1 ? unquote(parts[parts.length - 2]) : 'public';
    if (schema !== 'public') continue;

    out.push({ file, schema, name, key: `${file}::${schema}.${name}` });
  }
  return out;
}

/**
 * True when this SQL contains a REVOKE on the named function that strips BOTH
 * `anon` and `authenticated` by name. `FROM PUBLIC` alone does not count —
 * that is precisely the defect.
 */
export function hasExplicitRevoke(rawSql: string, schema: string, name: string): boolean {
  const sql = stripDollarQuoted(normalize(rawSql));
  const qualified = `${schema}.${name}`;

  for (const stmt of sql.matchAll(/\bREVOKE\b[^;]*;/gi)) {
    const text = stmt[0];
    if (!/\bON FUNCTION\b/i.test(text)) continue;
    // Must target this function specifically.
    const targetsFn =
      text.includes(qualified) || new RegExp(`\\b${escapeRegExp(name)} ?\\(`, 'i').test(text);
    if (!targetsFn) continue;
    if (/\banon\b/i.test(text) && /\bauthenticated\b/i.test(text)) return true;
  }
  return false;
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

  if (fresh.length === 0) {
    return {
      ok: true,
      message:
        `✅ secdef_function_grants: no new SECURITY DEFINER function is missing its ` +
        `anon/authenticated REVOKE (${baseline.size} grandfathered, burn-down list in ` +
        `scripts/ci/feedback-rules/secdef-grants-baseline.json).`,
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
