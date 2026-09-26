#!/usr/bin/env -S npx tsx
/**
 * SCRUM-1278 (R3-5) — block NEW bare `auth.uid()` in RLS policies.
 *
 * Migration 0280 wrapped every existing bare occurrence in production.
 * This lint catches new ones at PR time. Per-row `auth.uid()` evaluation
 * is what scaled the 2026-04-25 1.4M-row anchors scan to 60s+; wrapping
 * with `(SELECT auth.uid())` lets the planner cache the value as an
 * initplan.
 *
 * WHAT THIS LINT IS ABOUT, AND THEREFORE WHAT IT MUST NOT FLAG
 * ------------------------------------------------------------
 * The defect is *per-row re-evaluation*. That only happens where the call
 * sits in an expression Postgres evaluates once per candidate row: a policy
 * `USING` / `WITH CHECK` predicate, or an expression inlined into one. Three
 * shapes were being reported that cannot re-evaluate per row, and they were
 * reported because the scan was a bare regex over the whole file rather than
 * over SQL code:
 *
 *   1. Trailing comments. The old skip was `/^\s*--/` against the whole line,
 *      so it only caught comments that START a line. A line like
 *      `v_caller uuid := p_caller_user_id;   -- 0430: was auth.uid()` was
 *      flagged for text inside its own comment.
 *   2. String literals. `COMMENT ON FUNCTION ... IS '... because auth.uid()
 *      is NULL under the worker service_role client ...'` was flagged for
 *      prose inside a quoted string.
 *   3. PL/pgSQL assignment. `v_caller uuid := auth.uid();` in a DECLARE block
 *      runs ONCE per function call, not once per row — it is the hoist this
 *      lint exists to encourage, so flagging it inverted the rule.
 *
 * PR #2572 hit all three: 16 findings across migrations 0429–0432, which
 * between them contain zero `CREATE POLICY` statements. A lint that reports
 * "bare auth.uid() in RLS policies" against files with no policies is
 * reporting on text, not on policies.
 *
 * The fix keeps the scan broad — it still covers policy predicates and any
 * inline expression, not just `CREATE POLICY` blocks, so a call reachable
 * per-row through a helper is still caught — and narrows only by removing
 * what is definitionally not a per-row expression: comments, string literals,
 * and assignment right-hand sides.
 *
 * Override: PR labeled `rls-auth-uid-bare-intentional` (rare; deliberately
 * per-row checks have specific use cases — document the why in code).
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasLabel } from './lib/ciContext.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

const OVERRIDE_LABEL = 'rls-auth-uid-bare-intentional';
const REPO = process.env.RLS_AUTH_UID_REPO_ROOT ?? resolve(MODULE_DIR, '..', '..');

// Match `auth.uid()` not preceded by "SELECT " (case-insensitive).
// JS regex doesn't support lookbehind on all runtimes but Node 20+ does.
const BARE_REGEX = /(?<!SELECT\s)auth\.uid\(\)/gi;

export interface Finding {
  file: string;
  line: number;
  context: string;
}

export interface SqlFile {
  name: string;
  body: string;
}

/**
 * Blank out every span that is not SQL *code* — `--` line comments, `/* *\/`
 * block comments (nested, per the SQL spec), and single-quoted string
 * literals (with `''` doubling and backslash escapes) — replacing each
 * character with a space so byte offsets and line numbers are preserved and
 * the caller can still slice context out of the ORIGINAL text.
 *
 * Dollar-quoted bodies (`$function$ … $function$`) are deliberately NOT
 * blanked: that is where policy helper expressions live, and blanking them
 * would delete the coverage this lint exists for. Their delimiters contain no
 * quote characters, so walking straight through them is correct.
 */
export function maskNonCode(sql: string): string {
  const out = sql.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };

  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);

    if (two === '--') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }

    if (two === '/*') {
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql.slice(j, j + 2) === '/*') { depth++; j += 2; continue; }
        if (sql.slice(j, j + 2) === '*/') { depth--; j += 2; continue; }
        j++;
      }
      blank(i, j);
      i = j;
      continue;
    }

    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '\\') { j += 2; continue; }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; } // '' escape
          j += 1;
          break;
        }
        j++;
      }
      blank(i, j);
      i = j;
      continue;
    }

    // Dollar-quoted opener: consume the delimiter only, keep the body as code.
    const dollar = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
    if (dollar) { i += dollar[0].length; continue; }

    i++;
  }

  return out.join('');
}

function lineNumber(text: string, idx: number): number {
  return text.slice(0, idx).split('\n').length;
}

function lineStart(text: string, idx: number): number {
  return text.lastIndexOf('\n', idx) + 1;
}

function lineContext(text: string, idx: number): string {
  const start = lineStart(text, idx);
  const end = text.indexOf('\n', idx);
  return text.slice(start, end === -1 ? text.length : end).trim().slice(0, 120);
}

/**
 * True when the occurrence is the right-hand side of a PL/pgSQL assignment
 * (`v_caller uuid := auth.uid();`, or a later `v_caller := auth.uid();`).
 * Evaluated once per function call, never per row — this is the hoist the
 * lint wants, so reporting it would invert the rule.
 */
export function isAssignmentRhs(maskedCode: string, idx: number): boolean {
  const start = lineStart(maskedCode, idx);
  return maskedCode.slice(start, idx).includes(':=');
}

// Migrations numbered < 0280 are historical — their CREATE POLICY text still
// contains bare `auth.uid()` but those policies were rewritten in-place by
// migration 0280's DO block (regex_replace over pg_policies.qual/with_check).
// Migrations are immutable per the constitution, so we cannot edit the
// historical files. Only NEW migrations (>= 0280) are scanned.
export const FIRST_ENFORCED_PREFIX = 280;

export const SKIPPED_FILES = new Set([
  // Skip the wrap migration itself — its DO block contains the bare form
  // inside the regex_replace pattern string.
  'supabase/migrations/0280_rls_auth_uid_subquery_wrap.sql',
  // Skip the SCRUM-1668 Path C baseline file. It's a byte-faithful pg_dump
  // of prod's schema-as-of-cutover (literal historical state), not a new
  // policy. The bare auth.uid() occurrences inside it were rewritten in
  // prod by migration 0280's DO block at runtime; the immutable file text
  // remains historical artifact.
  'supabase/migrations/00000000000000_baseline_at_main_HEAD.sql',
  // Same shape as the two exemptions above, happening in real time instead
  // of historically: 0398 reproduced resolve_anchor_queue/supersede_anchor's
  // bodies verbatim via pg_get_functiondef (to eliminate transcription risk
  // on the actual bug it was fixing — a dropped audit_events column), which
  // carried over 9 pre-existing bare auth.uid() calls from the live baseline
  // definitions. 0399 (same PR) CREATE OR REPLACEs the same three functions
  // with every occurrence wrapped — fixed at runtime, exactly like 0280 did.
  'supabase/migrations/0398_fix_audit_events_actor_email_dropped_column.sql',
  // 0481 (PR #3033, UAT-14 profile media) shipped five bare auth.uid() calls
  // in its policies and was applied to prod as-is on 2026-09-20 — before the
  // PR merged, so the file text must stay byte-identical to what prod ran
  // (CLAUDE.md §1.2: never modify an existing migration). The PR merged on
  // 2026-09-26 under `rls-auth-uid-bare-intentional`; this scanner reads the
  // whole tree rather than the PR diff, so without this entry every later PR
  // and merge-queue train reds on a file none of them touched. The initplan
  // wrap lands as a compensating migration (DROP/CREATE POLICY with
  // `(SELECT auth.uid())`), tracked as a follow-up to #3033.
  'supabase/migrations/0481_uat14_profile_brand_media.sql',
]);

export function migrationPrefix(file: string): number | null {
  const m = file.match(/migrations\/0?(\d{3,4})_/);
  if (!m) return null;
  return Number.parseInt(m[1], 10);
}

export function scanFiles(files: SqlFile[]): Finding[] {
  const findings: Finding[] = [];

  for (const { name, body } of files) {
    if (SKIPPED_FILES.has(name)) continue;

    const prefix = migrationPrefix(name);
    if (prefix !== null && prefix < FIRST_ENFORCED_PREFIX) continue;

    const code = maskNonCode(body);

    let match: RegExpExecArray | null;
    BARE_REGEX.lastIndex = 0;
    while ((match = BARE_REGEX.exec(code)) !== null) {
      if (isAssignmentRhs(code, match.index)) continue;
      findings.push({
        file: name,
        line: lineNumber(body, match.index),
        // Context comes from the ORIGINAL text so the report is readable.
        context: lineContext(body, match.index),
      });
    }
  }

  return findings;
}

function scan(): Finding[] {
  const files = execSync('git ls-files supabase/migrations', { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter((p) => p.endsWith('.sql'))
    .map((name) => ({ name, body: readFileSync(resolve(REPO, name), 'utf8') }));

  return scanFiles(files);
}

function main(): void {
  const findings = scan();
  if (findings.length === 0) {
    console.log('✅ No bare auth.uid() in RLS policies (all wrapped with (SELECT auth.uid())).');
    return;
  }

  if (hasLabel(OVERRIDE_LABEL)) {
    console.log(`⚠️  PR labeled \`${OVERRIDE_LABEL}\` — allowing ${findings.length} bare occurrence(s).`);
    for (const f of findings) console.log(`  ${f.file}:${f.line} → ${f.context}`);
    return;
  }

  console.error(`::error::SCRUM-1278: ${findings.length} bare auth.uid() in RLS policies:`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}`);
    console.error(`    ${f.context}`);
  }
  console.error('');
  console.error('Wrap with `(SELECT auth.uid())` so Postgres caches the JWT lookup as an initplan');
  console.error('instead of re-evaluating per row. Per-row evaluation on the 1.4M-row anchors table');
  console.error('contributed to the 2026-04-25 outage (R0-1 retro).');
  process.exit(1);
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) main();
