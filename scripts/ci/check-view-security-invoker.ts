#!/usr/bin/env -S npx tsx
/**
 * SCRUM-1276 (R3-3) — block bare CREATE [OR REPLACE] VIEW in migrations.
 *
 * PG15+ views default to security_definer. A CREATE VIEW without
 * `WITH (security_invoker = true)` runs as the view owner (typically a
 * superuser or migration runner) — bypassing RLS for the view's caller.
 *
 * Allowed forms:
 *   1. `CREATE [OR REPLACE] VIEW ... WITH (security_invoker = true) AS ...`
 *   2. `CREATE [OR REPLACE] VIEW ... AS ...` immediately followed within
 *      the same file by `ALTER VIEW ... SET (security_invoker = true)`.
 *   3. `CREATE [OR REPLACE] VIEW ...` preceded by a
 *      `-- DELIBERATE: definer-rights view` comment with rationale.
 *
 * Programmatic creation inside a `DO $$ ... $$` string (e.g. the 0112
 * one-shot loop) is ignored — the linter only flags top-level statements.
 *
 * Override label (when the rule misfires): `view-security-invoker-approved`
 * on the PR. Override is enforced at the workflow level, not here.
 */

import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const REPO = process.env.VIEW_SECURITY_INVOKER_REPO_ROOT
  ?? resolve(import.meta.dirname, '..', '..');
const MIGRATIONS_DIR = join(REPO, 'supabase', 'migrations');
const BASELINE_PATH = join(REPO, 'scripts', 'ci', 'snapshots', 'view-security-invoker-baseline.json');

interface Baseline {
  /** Migration filenames that pre-date the lint and are exempt. */
  grandfathered: string[];
}

interface Violation {
  file: string;
  viewName: string;
  lineHint: number;
}

/**
 * Strip dollar-quoted blocks (`$$ ... $$` and `$tag$ ... $tag$`) so the
 * scanner doesn't treat CREATE VIEW templates inside DO blocks as
 * top-level statements.
 */
function stripDollarQuoted(sql: string): string {
  // Match $tag$...$tag$ where tag is empty or [a-zA-Z_][a-zA-Z0-9_]*.
  // Replace with newline-preserving blank so subsequent line-counting stays correct.
  return sql.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)?\$[\s\S]*?\$\1\$/g, (m) => {
    return m.replace(/[^\n]/g, ' ');
  });
}

function loadBaseline(): Set<string> {
  if (!existsSync(BASELINE_PATH)) return new Set();
  const raw = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline;
  return new Set(raw.grandfathered);
}

function findViolations(file: string, sql: string): Violation[] {
  const out: Violation[] = [];
  const stripped = stripDollarQuoted(sql);
  const lines = stripped.split('\n');

  // Find every CREATE [OR REPLACE] VIEW. Capture the view name (next non-AS token).
  // Allow optional schema qualification + multi-line break before AS.
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+([^\s(]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const viewIdent = m[1];
    const offset = m.index;
    const lineHint = stripped.slice(0, offset).split('\n').length;

    // Read up to ~400 chars after match to check for WITH (security_invoker = true)
    // OR an AS clause that didn't close before the next statement.
    const window = stripped.slice(offset, offset + 800);
    const hasInvokerInline = /WITH\s*\(\s*security_invoker\s*=\s*true\s*\)/i.test(window);
    if (hasInvokerInline) continue;

    // Look for a sibling ALTER VIEW <same name> SET (security_invoker = true) anywhere
    // in the rest of the file. Allow schema-qualified or bare names.
    const bareName = viewIdent.replace(/^public\./i, '').replace(/^"|"$/g, '');
    const alterPattern = new RegExp(
      `ALTER\\s+VIEW\\s+(?:IF\\s+EXISTS\\s+)?(?:public\\.)?\"?${bareName}\"?\\s+SET\\s*\\(\\s*security_invoker\\s*=\\s*true\\s*\\)`,
      'i',
    );
    if (alterPattern.test(stripped.slice(offset))) continue;

    // Look for the deliberate-definer override comment within the 5 lines
    // immediately preceding the CREATE statement.
    const startLine = Math.max(0, lineHint - 6);
    const preceding = lines.slice(startLine, lineHint - 1).join('\n');
    if (/--\s*DELIBERATE:\s*definer-rights view/i.test(preceding)) continue;

    out.push({ file, viewName: viewIdent, lineHint });
  }
  return out;
}

function main(): void {
  if (!existsSync(MIGRATIONS_DIR)) {
    console.log(`No migrations directory at ${MIGRATIONS_DIR} — skipping.`);
    return;
  }

  const grandfathered = loadBaseline();
  const violations: Violation[] = [];

  for (const file of readdirSync(MIGRATIONS_DIR).sort()) {
    if (!file.endsWith('.sql')) continue;
    if (file.startsWith('_')) continue;
    if (grandfathered.has(file)) continue;
    const full = join(MIGRATIONS_DIR, file);
    const sql = readFileSync(full, 'utf8');
    violations.push(...findViolations(file, sql));
  }

  if (violations.length === 0) {
    console.log(
      `OK — No bare CREATE VIEW found ` +
        `(${grandfathered.size} grandfathered migrations skipped).`,
    );
    return;
  }

  console.error(
    `::error::SCRUM-1276: ${violations.length} CREATE VIEW statement(s) ` +
      `without security_invoker = true:`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.lineHint}  CREATE VIEW ${v.viewName}`);
  }
  console.error('');
  console.error('Add WITH (security_invoker = true) to the CREATE VIEW, OR follow the');
  console.error('CREATE with ALTER VIEW <name> SET (security_invoker = true) in the same');
  console.error('migration, OR add a `-- DELIBERATE: definer-rights view` comment with');
  console.error('rationale immediately above the CREATE statement.');
  process.exit(1);
}

main();
