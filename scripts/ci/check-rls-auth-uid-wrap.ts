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
 * Override: PR labeled `rls-auth-uid-bare-intentional` (rare; deliberately
 * per-row checks have specific use cases — document the why in code).
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const OVERRIDE_LABEL = 'rls-auth-uid-bare-intentional';
const REPO = process.env.RLS_AUTH_UID_REPO_ROOT ?? resolve(import.meta.dirname, '..', '..');
const prLabels = (process.env.PR_LABELS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

// Match `auth.uid()` not preceded by "SELECT " (case-insensitive).
// JS regex doesn't support lookbehind on all runtimes but Node 20+ does.
const BARE_REGEX = /(?<!SELECT\s)auth\.uid\(\)/gi;

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

// Migrations numbered < 0280 are historical — their CREATE POLICY text still
// contains bare `auth.uid()` but those policies were rewritten in-place by
// migration 0280's DO block (regex_replace over pg_policies.qual/with_check).
// Migrations are immutable per the constitution, so we cannot edit the
// historical files. Only NEW migrations (>= 0280) are scanned.
const FIRST_ENFORCED_PREFIX = 280;

function migrationPrefix(file: string): number | null {
  const m = file.match(/migrations\/0?(\d{3,4})_/);
  if (!m) return null;
  return Number.parseInt(m[1], 10);
}

function scan(): Finding[] {
  const files = execSync('git ls-files supabase/migrations', { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter((p) => p.endsWith('.sql'));

  const findings: Finding[] = [];
  for (const file of files) {
    // Skip the wrap migration itself — its DO block contains the bare form
    // inside the regex_replace pattern string.
    if (file.endsWith('0280_rls_auth_uid_subquery_wrap.sql')) continue;

    // Skip historical migrations (< 0280). Their bare occurrences were
    // rewritten at runtime by 0280; the immutable migration text is benign.
    const prefix = migrationPrefix(file);
    if (prefix !== null && prefix < FIRST_ENFORCED_PREFIX) continue;

    const body = readFileSync(resolve(REPO, file), 'utf8');
    let match: RegExpExecArray | null;
    BARE_REGEX.lastIndex = 0;
    while ((match = BARE_REGEX.exec(body)) !== null) {
      // Skip if the match is in a SQL comment line (-- ... auth.uid() ...).
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
    console.log('✅ No bare auth.uid() in RLS policies (all wrapped with (SELECT auth.uid())).');
    return;
  }

  if (prLabels.includes(OVERRIDE_LABEL)) {
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

main();
