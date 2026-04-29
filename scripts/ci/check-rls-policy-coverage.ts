#!/usr/bin/env -S npx tsx
/**
 * SCRUM-1275 (R3-2) — block new ENABLE+FORCE RLS without a policy.
 *
 * Postgres lets a table have RLS enabled with no policy, which is silent
 * deny-all (BYPASSRLS roles excluded). That is fragile (BYPASSRLS can be
 * rotated) and a defense-in-depth gap. Migration 0282 backfilled the last
 * three tables in this state; this lint catches new occurrences at PR time.
 *
 * Rule: a migration that contains `ALTER TABLE <name> ENABLE ROW LEVEL
 * SECURITY` (or `FORCE ROW LEVEL SECURITY`) for table X must also create
 * at least one policy on X — either in the same migration or in a sibling
 * migration in the same PR. As a safety valve, a `COMMENT ON TABLE X IS
 * 'Deny-all by design ...'` comment qualifies as a documented intent.
 *
 * Override: PR labeled `rls-no-policy-intentional` (rare; usually a
 * legacy/quarantined table that nothing should touch).
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const OVERRIDE_LABEL = 'rls-no-policy-intentional';
const REPO = process.env.RLS_POLICY_REPO_ROOT ?? resolve(import.meta.dirname, '..', '..');
const BASELINE_PATH = join(REPO, 'scripts', 'ci', 'snapshots', 'rls-policy-coverage-baseline.json');
const prLabels = (process.env.PR_LABELS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

function loadMissingInProd(): Set<string> {
  if (!existsSync(BASELINE_PATH)) return new Set();
  const raw = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as { missing_in_prod?: string[] };
  return new Set(raw.missing_in_prod ?? []);
}

const ENABLE_RE = /ALTER\s+TABLE\s+(?:public\.)?(\w+)\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi;
// Policy names may be unquoted (\w+) or quoted ("...") with arbitrary chars.
const POLICY_RE = /CREATE\s+POLICY\s+(?:"[^"]+"|\w+)\s+ON\s+(?:public\.)?(\w+)/gi;
const DENY_ALL_RE = /COMMENT\s+ON\s+TABLE\s+(?:public\.)?(\w+)\s+IS\s+'[^']*[Dd]eny-?all\s+by\s+design/gi;

interface Finding {
  table: string;
  enabledIn: string[];
  policyOrCommentIn: string[];
}

function scan(): Finding[] {
  const files = execSync('git ls-files supabase/migrations', { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter((p) => p.endsWith('.sql'));

  const missingInProd = loadMissingInProd();
  const enables = new Map<string, string[]>();
  const policies = new Map<string, string[]>();

  for (const file of files) {
    const body = readFileSync(resolve(REPO, file), 'utf8');

    for (const m of body.matchAll(ENABLE_RE)) {
      const t = m[1];
      const arr = enables.get(t) ?? [];
      arr.push(file);
      enables.set(t, arr);
    }
    for (const m of body.matchAll(POLICY_RE)) {
      const t = m[1];
      const arr = policies.get(t) ?? [];
      arr.push(file);
      policies.set(t, arr);
    }
    for (const m of body.matchAll(DENY_ALL_RE)) {
      const t = m[1];
      const arr = policies.get(t) ?? [];
      arr.push(`${file} (deny-all comment)`);
      policies.set(t, arr);
    }
  }

  const findings: Finding[] = [];
  for (const [table, files] of enables.entries()) {
    if (missingInProd.has(table)) continue;
    if (!policies.has(table)) {
      findings.push({ table, enabledIn: files, policyOrCommentIn: [] });
    }
  }
  return findings;
}

function main(): void {
  const findings = scan();
  if (findings.length === 0) {
    console.log('✅ Every RLS-enabled table has at least one policy or a deny-all comment.');
    return;
  }

  if (prLabels.includes(OVERRIDE_LABEL)) {
    console.log(`⚠️  PR labeled \`${OVERRIDE_LABEL}\` — allowing ${findings.length} unsealed table(s).`);
    for (const f of findings) console.log(`  ${f.table} (enabled in: ${f.enabledIn.join(', ')})`);
    return;
  }

  console.error(`::error::SCRUM-1275: ${findings.length} table(s) with ENABLE RLS but no policy:`);
  for (const f of findings) {
    console.error(`  ${f.table}`);
    console.error(`    enabled in: ${f.enabledIn.join(', ')}`);
  }
  console.error('');
  console.error('Add either an explicit `CREATE POLICY` or a `COMMENT ON TABLE ... \'Deny-all by design');
  console.error('(R3-2). See SCRUM-XXX.\'` line in the same migration. service_role has BYPASSRLS, so');
  console.error('callers work today, but that is fragile coupling — a defense-in-depth gap flagged by');
  console.error('the SCRUM-1208 ultrareview.');
  console.error(`Override label (rare): \`${OVERRIDE_LABEL}\`.`);
  process.exit(1);
}

main();
