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
 * A view is considered safe if either:
 *   - The most recent `CREATE [OR REPLACE] VIEW <name>` includes
 *     `WITH (security_invoker = true)` within the next ~250 chars, OR
 *   - A later migration applies `ALTER VIEW <name> SET (security_invoker = true)`.
 *
 * Migration order is determined by sorted file name (the `NNNN_` prefix).
 *
 * Override: PR labeled `view-security-definer-intentional` (rare; usually
 * a public-read aggregation that legitimately needs definer semantics).
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OVERRIDE_LABEL = 'view-security-definer-intentional';
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = process.env.VIEWS_LINT_REPO_ROOT ?? resolve(MODULE_DIR, '..', '..');
const BASELINE_PATH = join(REPO, 'scripts', 'ci', 'snapshots', 'views-security-invoker-baseline.json');
const prLabels = (process.env.PR_LABELS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

function loadBaseline(): Set<string> {
  if (!existsSync(BASELINE_PATH)) return new Set();
  const raw = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as { grandfathered: string[] };
  return new Set(raw.grandfathered);
}

// Match `CREATE [OR REPLACE] [...] VIEW <name>`. Skip MATERIALIZED VIEW
// (different semantics; tracked separately).
//
// Postgres lets identifiers be either bare (`my_view`) or double-quoted
// (`"My View"`, which preserves case + allows non-word chars). We accept
// both forms so a future migration that uses quoted identifiers cannot
// silently slip past the linter. The schema qualifier mirrors that:
// `public.x`, `"public".x`, `public."x"`, or `"public"."x"`.
const SCHEMA_PREFIX = '(?:(?:"public"|public)\\.)?';
const VIEW_NAME = '(?:"[^"]+"|\\w+)';
const CREATE_VIEW_REGEX = new RegExp(
  `CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?!MATERIALIZED\\s+)VIEW\\s+${SCHEMA_PREFIX}(${VIEW_NAME})`,
  'gi',
);

// Match `ALTER VIEW <name> SET (security_invoker = true|on)`. The optional
// `IF EXISTS` and schema-qualifier mirror Postgres' actual ALTER VIEW grammar.
const ALTER_FIX_REGEX = new RegExp(
  `ALTER\\s+VIEW\\s+(?:IF\\s+EXISTS\\s+)?${SCHEMA_PREFIX}(${VIEW_NAME})\\s+SET\\s*\\([^)]*\\bsecurity_invoker\\s*=\\s*(?:true|on)\\b[^)]*\\)`,
  'gi',
);
const ALTER_UNFIX_REGEX = new RegExp(
  `ALTER\\s+VIEW\\s+(?:IF\\s+EXISTS\\s+)?${SCHEMA_PREFIX}(${VIEW_NAME})\\s+(?:SET\\s*\\([^)]*\\bsecurity_invoker\\s*=\\s*(?:false|off)\\b[^)]*\\)|RESET\\s*\\([^)]*\\bsecurity_invoker\\b[^)]*\\))`,
  'gi',
);
const SECURITY_INVOKER_WITH_REGEX = /\bWITH\s*\([^)]*\bsecurity_invoker\s*=\s*(?:true|on)\b[^)]*\)/i;

// Postgres treats `"foo"` and `foo` as the same identifier when the inner
// text is lower-case alphanumeric. Strip surrounding quotes so the Map key
// is consistent across quoted vs unquoted occurrences of the same view.
function normalizeViewName(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1);
  }
  return raw;
}

interface Finding {
  file: string;
  view: string;
  line: number;
}

function lineNumber(text: string, idx: number): number {
  return text.slice(0, idx).split('\n').length;
}

interface ScanResult {
  bareCreates: Finding[];
  fixedAfter: Set<string>;
}

type ViewSecurityEvent =
  | { index: number; kind: 'create'; view: string; isFixed: boolean }
  | { index: number; kind: 'alter'; view: string }
  | { index: number; kind: 'unfix'; view: string };

function createViewHeader(text: string, idx: number): string {
  const tail = text.slice(idx);
  const asMatch = /\bAS\b/i.exec(tail);
  return asMatch ? tail.slice(0, asMatch.index) : tail;
}

export function scanFiles(files: ReadonlyArray<{ name: string; body: string }>): ScanResult {
  // Process in migration order so a later ALTER/REPLACE overrides an earlier
  // bare CREATE. Caller is responsible for sorting (we sort by file path here
  // for safety — supabase migrations are NNNN_-prefixed which sorts correctly).
  const ordered = [...files].sort((a, b) => a.name.localeCompare(b.name));

  // For each view name, track its latest state: 'bare' or 'fixed'.
  // 'bare' = most-recent CREATE without security_invoker AND no later ALTER fix.
  // 'fixed' = most-recent migration converted the view OR later ALTER pinned it.
  const latestState = new Map<string, 'bare' | 'fixed'>();
  const latestFinding = new Map<string, Finding>();

  for (const { name, body } of ordered) {
    const events: ViewSecurityEvent[] = [];

    CREATE_VIEW_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CREATE_VIEW_REGEX.exec(body)) !== null) {
      const view = normalizeViewName(m[1]);
      const isFixed = SECURITY_INVOKER_WITH_REGEX.test(createViewHeader(body, m.index));
      events.push({ index: m.index, kind: 'create', view, isFixed });
    }

    ALTER_FIX_REGEX.lastIndex = 0;
    while ((m = ALTER_FIX_REGEX.exec(body)) !== null) {
      events.push({ index: m.index, kind: 'alter', view: normalizeViewName(m[1]) });
    }

    ALTER_UNFIX_REGEX.lastIndex = 0;
    while ((m = ALTER_UNFIX_REGEX.exec(body)) !== null) {
      events.push({ index: m.index, kind: 'unfix', view: normalizeViewName(m[1]) });
    }

    events.sort((a, b) => a.index - b.index);

    for (const event of events) {
      if (event.kind === 'create') {
        latestState.set(event.view, event.isFixed ? 'fixed' : 'bare');
        if (!event.isFixed) {
          latestFinding.set(event.view, {
            file: name,
            view: event.view,
            line: lineNumber(body, event.index),
          });
        } else {
          latestFinding.delete(event.view);
        }
      } else {
        if (event.kind === 'alter') {
          latestState.set(event.view, 'fixed');
          latestFinding.delete(event.view);
        } else {
          latestState.set(event.view, 'bare');
          latestFinding.set(event.view, {
            file: name,
            view: event.view,
            line: lineNumber(body, event.index),
          });
        }
      }
    }
  }

  const bareCreates: Finding[] = [];
  const fixedAfter = new Set<string>();
  for (const [view, state] of latestState) {
    if (state === 'bare') {
      const f = latestFinding.get(view);
      if (f) bareCreates.push(f);
    } else {
      fixedAfter.add(view);
    }
  }
  return { bareCreates, fixedAfter };
}

function readMigrations(): Array<{ name: string; body: string }> {
  const files = execSync('git ls-files supabase/migrations', { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter((p) => p.endsWith('.sql'));
  return files.map((name) => ({ name, body: readFileSync(resolve(REPO, name), 'utf8') }));
}

function main(): void {
  const baseline = loadBaseline();
  const { bareCreates } = scanFiles(readMigrations());
  const novel = bareCreates.filter((f) => !baseline.has(f.view));

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
  console.error(`Or land a follow-up migration with`);
  console.error(`  ALTER VIEW <name> SET (security_invoker = true);`);
  console.error(`If a definer view is genuinely required, label the PR with \`${OVERRIDE_LABEL}\`.`);
  process.exit(1);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) main();
