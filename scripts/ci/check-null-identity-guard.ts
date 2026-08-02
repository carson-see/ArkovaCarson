#!/usr/bin/env -S npx tsx
/**
 * F-5b/F-5c — block NEW authorization guards that compare a parameter directly
 * against an identity function.
 *
 * THE BUG THIS PREVENTS:
 *   `IF p_user_id IS DISTINCT FROM auth.uid() THEN RAISE ... END IF;`
 *   looks airtight, but `IS DISTINCT FROM` returns FALSE when BOTH sides are
 *   NULL. For a caller with no identity (anon, or an authenticated user whose
 *   profiles.org_id IS NULL), the identity function evaluates to NULL — so a
 *   call passing an explicit NULL argument skips the RAISE entirely and falls
 *   through to the query, returning HTTP 200 with an empty/zero result instead
 *   of a 403.
 *
 *   It is not a data disclosure (`WHERE col = NULL` matches no row), but it
 *   makes an unauthorized call indistinguishable from an authorized empty
 *   result — the "silent success" shape this codebase has been removing.
 *
 *   Live instances found on 2026-08-02: get_org_anchor_stats and
 *   get_user_anchor_stats (both anon-executable; fixed by 0391), and
 *   get_user_monthly_anchor_count (not anon-executable, so latent; fixed by
 *   0392). This lint exists so a fourth one cannot be added silently.
 *
 * THE REQUIRED SHAPE:
 *   Resolve the identity into a local, reject NULL, THEN compare:
 *
 *     DECLARE v_caller_id uuid;
 *     BEGIN
 *       IF get_caller_role() IS DISTINCT FROM 'service_role' THEN
 *         v_caller_id := (SELECT auth.uid());
 *         IF v_caller_id IS NULL THEN
 *           RAISE EXCEPTION '...' USING ERRCODE = '42501';
 *         END IF;
 *         IF p_user_id IS DISTINCT FROM v_caller_id THEN
 *           RAISE EXCEPTION '...' USING ERRCODE = '42501';
 *         END IF;
 *       END IF;
 *
 *   Comparing against the LOCAL is what this lint checks for — that form is
 *   provably NULL-safe because the NULL case was rejected above it.
 *
 * DELIBERATELY NOT FLAGGED:
 *   - `col = auth.uid()` / `col = get_user_org_id()` inside an RLS
 *     USING/WITH CHECK qual. There a NULL identity simply matches no rows,
 *     which fails CLOSED. Only the IS DISTINCT FROM *guard* idiom fails open.
 *   - `EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND ...)`, which is
 *     NULL-safe by construction (no row -> FALSE -> denied).
 *
 * Override: PR labeled `null-identity-guard-intentional`. Use it only with a
 * comment in the SQL explaining why a NULL identity is safe at that call site.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GIT_BIN } from './lib/ciContext.js';

const OVERRIDE_LABEL = 'null-identity-guard-intentional';
const REPO = process.env.NULL_IDENTITY_REPO_ROOT ?? resolve(import.meta.dirname, '..', '..');
const prLabels = (process.env.PR_LABELS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

// `<something> IS DISTINCT FROM auth.uid() | (SELECT auth.uid()) | get_user_org_id()`
const GUARD_REGEX =
  /IS\s+DISTINCT\s+FROM\s*\(?\s*(?:SELECT\s+)?(?:auth\.uid\(\)|get_user_org_id\(\))/gi;

interface Finding {
  file: string;
  line: number;
  context: string;
}

function lineNumber(text: string, idx: number): number {
  return text.slice(0, idx).split('\n').length;
}

function lineContext(text: string, idx: number): string {
  const start = text.lastIndexOf('\n', idx) + 1;
  const end = text.indexOf('\n', idx);
  return text.slice(start, end === -1 ? text.length : end).trim().slice(0, 120);
}

// Only NEW migrations are scanned. Everything at or below this prefix is
// historical: the two anon-reachable instances are superseded at runtime by
// 0391 and the last one by 0392, but the immutable migration TEXT still
// contains the old idiom and cannot be edited (CLAUDE.md §1.2).
//
// This is the same grandfathering rationale as
// scripts/ci/check-rls-auth-uid-wrap.ts's FIRST_ENFORCED_PREFIX = 280.
//
// Set to 393 specifically so that migration 0380 (PR #1778, still open and
// already applied to prod ahead of merge) does not turn this gate red when it
// lands on main. 0380 genuinely contains the flagged idiom; 0391 supersedes it
// at runtime. Lowering this cutoff without first landing a compensating
// migration for every file between it and here will break in-flight PRs.
const FIRST_ENFORCED_PREFIX = 393;

function migrationPrefix(file: string): number | null {
  const m = file.match(/migrations\/0?(\d{3,4})_/);
  if (!m) return null;
  return Number.parseInt(m[1], 10);
}

export function scan(): Finding[] {
  const files = execFileSync(GIT_BIN, ['ls-files', 'supabase/migrations'], {
    cwd: REPO,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((p) => p.endsWith('.sql'));

  const findings: Finding[] = [];
  for (const file of files) {
    // The Path C baseline is a byte-faithful pg_dump of prod-as-of-cutover,
    // not new policy text. Its instances are superseded by 0391/0392.
    if (file === 'supabase/migrations/00000000000000_baseline_at_main_HEAD.sql') continue;

    const prefix = migrationPrefix(file);
    if (prefix !== null && prefix < FIRST_ENFORCED_PREFIX) continue;

    const body = readFileSync(resolve(REPO, file), 'utf8');
    let match: RegExpExecArray | null;
    GUARD_REGEX.lastIndex = 0;
    while ((match = GUARD_REGEX.exec(body)) !== null) {
      // Skip SQL comment lines — ROLLBACK blocks legitimately quote the old
      // body verbatim, and header prose describes the bug being fixed.
      const ctx = lineContext(body, match.index);
      if (/^\s*--/.test(ctx)) continue;
      findings.push({ file, line: lineNumber(body, match.index), context: ctx });
    }
  }
  return findings;
}

function main(): void {
  const findings = scan();
  if (findings.length === 0) {
    console.log(
      '✅ No parameter compared directly against an identity function in an authorization guard.',
    );
    return;
  }

  if (prLabels.includes(OVERRIDE_LABEL)) {
    console.log(`⚠️  PR labeled \`${OVERRIDE_LABEL}\` — allowing ${findings.length} occurrence(s).`);
    for (const f of findings) console.log(`  ${f.file}:${f.line} → ${f.context}`);
    return;
  }

  console.error(
    `::error::F-5b/F-5c: ${findings.length} authorization guard(s) comparing a parameter directly against an identity function:`,
  );
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}`);
    console.error(`    ${f.context}`);
  }
  console.error('');
  console.error('`IS DISTINCT FROM` returns FALSE when BOTH sides are NULL, so a caller with no');
  console.error('identity passing an explicit NULL argument skips the RAISE and gets a 200 with an');
  console.error('all-zero result instead of a 403.');
  console.error('');
  console.error('Resolve the identity into a local, reject NULL, then compare against the local:');
  console.error('  v_caller_id := (SELECT auth.uid());');
  console.error("  IF v_caller_id IS NULL THEN RAISE EXCEPTION ... USING ERRCODE = '42501'; END IF;");
  console.error('  IF p_user_id IS DISTINCT FROM v_caller_id THEN RAISE EXCEPTION ... END IF;');
  console.error('');
  console.error('See supabase/migrations/0392_f5c_monthly_anchor_count_null_identity_guard.sql.');
  process.exit(1);
}

// Only run when invoked directly, so tests can import `scan()`.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
