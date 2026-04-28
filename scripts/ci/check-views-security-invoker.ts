#!/usr/bin/env -S npx tsx
/**
 * SCRUM-1276 (R3-3) — block bare `CREATE VIEW` in supabase/migrations.
 *
 * Postgres views default to `security_definer` semantics — they execute
 * with the view-owner's privileges, bypassing the RLS of the *caller*.
 * That's a tenant-isolation hazard. Every view in this repo must be
 * declared `WITH (security_invoker = true)` so the underlying table's
 * RLS applies to whoever queries the view.
 *
 * Override: PR labeled `view-security-definer-intentional` (rare; usually
 * a public-read aggregation that legitimately needs definer semantics).
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const OVERRIDE_LABEL = 'view-security-definer-intentional';
const REPO = process.env.VIEWS_LINT_REPO_ROOT ?? resolve(import.meta.dirname, '..', '..');
const BASELINE_PATH = join(REPO, 'scripts', 'ci', 'snapshots', 'views-security-invoker-baseline.json');
const prLabels = (process.env.PR_LABELS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

function loadBaseline(): Set<string> {
  if (!existsSync(BASELINE_PATH)) return new Set();
  const raw = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as { grandfathered: string[] };
  return new Set(raw.grandfathered);
}

// Match `CREATE [OR REPLACE] [...] VIEW <name>` not immediately followed by
// `WITH (security_invoker = true)` within ~200 chars (to allow column lists).
// Also: skip MATERIALIZED VIEW (different semantics; tracked separately).
const VIEW_REGEX = /CREATE\s+(?:OR\s+REPLACE\s+)?(?!MATERIALIZED\s+)VIEW\s+(?:public\.)?(\w+)/gi;

interface Finding {
  file: string;
  view: string;
  line: number;
}

function lineNumber(text: string, idx: number): number {
  return text.slice(0, idx).split('\n').length;
}

function scan(): Finding[] {
  const files = execSync('git ls-files supabase/migrations', { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter((p) => p.endsWith('.sql'));

  const findings: Finding[] = [];
  for (const file of files) {
    const body = readFileSync(resolve(REPO, file), 'utf8');
    let match: RegExpExecArray | null;
    VIEW_REGEX.lastIndex = 0;
    while ((match = VIEW_REGEX.exec(body)) !== null) {
      // Look ahead 250 chars from the match for `security_invoker`.
      const window = body.slice(match.index, match.index + 250);
      if (/security_invoker\s*=\s*(?:true|on)/i.test(window)) continue;
      findings.push({
        file,
        view: match[1],
        line: lineNumber(body, match.index),
      });
    }
  }
  return findings;
}

function main(): void {
  const baseline = loadBaseline();
  const all = scan();
  const novel = all.filter((f) => !baseline.has(f.view));

  if (novel.length === 0) {
    console.log(
      `✅ No new bare CREATE VIEW (all new views declare security_invoker; ` +
        `${baseline.size} grandfathered).`,
    );
    return;
  }

  if (prLabels.includes(OVERRIDE_LABEL)) {
    console.log(`⚠️  PR labeled \`${OVERRIDE_LABEL}\` — allowing ${novel.length} bare view(s).`);
    for (const f of novel) console.log(`  ${f.file}:${f.line} → CREATE VIEW ${f.view}`);
    return;
  }

  console.error(`::error::SCRUM-1276: ${novel.length} new CREATE VIEW without security_invoker:`);
  for (const f of novel) {
    console.error(`  ${f.file}:${f.line} → CREATE VIEW ${f.view}`);
  }
  console.error('');
  console.error('Add `WITH (security_invoker = true)` to the view definition so the underlying');
  console.error('table\'s RLS applies to the caller, not the view owner.');
  console.error(`If a definer view is genuinely required, label the PR with \`${OVERRIDE_LABEL}\`.`);
  process.exit(1);
}

main();
