#!/usr/bin/env -S npx tsx
/**
 * Block barrier-forming DDL on hot tables without a bounded `lock_timeout`.
 *
 * ## The incident this exists to prevent (2026-08-11 P0 — see HANDOFF.md)
 *
 * Two long census `SELECT`s held `AccessShareLock` on `public.organizations`
 * for ~50 minutes. An `ALTER TABLE public.organizations` was issued with no
 * `lock_timeout`, requested `AccessExclusiveLock`, and queued behind them.
 *
 * Postgres lock queues are **FIFO**. Once that ALTER was queued, every later
 * lock request queued behind it — including PostgREST's schema-cache
 * introspection, whose `AccessShareLock` was perfectly compatible with the
 * running reads and would otherwise have been granted instantly. Introspection
 * hit its ~10s `lock_timeout`, PostgREST entered a `PGRST002` retry loop, and
 * with no valid schema cache it serves nothing: `get_flag()` failed, the
 * `/api/v1` gate fail-closed, and `GET /api/v1/verify/{id}` returned
 * `service_unavailable` for 11m39s.
 *
 * The asymmetry that made it persist is the whole lesson: **the readers had a
 * `lock_timeout` and died repeatedly; the DDL session had none and camped the
 * queue for 15+ minutes.** A bounded `lock_timeout` converts "form a barrier in
 * front of the entire database" into "fail fast, retry when the table is quiet".
 * It costs one line.
 *
 * ## What counts as a guard
 *
 * `SET [LOCAL] lock_timeout = '<non-zero>'` appearing *before* the statement,
 * in real SQL (not in a comment), and not voided by an intervening
 * `RESET lock_timeout` / `SET lock_timeout = 0`. `0` is Postgres' "wait
 * forever" — it is the bug, not the fix, so it is rejected explicitly.
 *
 * ## What this linter cannot cover
 *
 * Ad-hoc DDL typed straight into the Supabase MCP / SQL editor never passes
 * through this repo, so no lint can see it. That path is covered by the rule
 * text in `CLAUDE.md` §1.2 and `supabase/migrations/agents.md`, which every
 * agent reads. This linter closes the file-based half; the directive closes the
 * ad-hoc half.
 *
 * ## Baseline
 *
 * Pre-existing migrations are grandfathered per-file in
 * `scripts/ci/snapshots/hot-table-ddl-lock-timeout-baseline.json`. Per-file
 * grandfathering is safe here precisely because merged migrations are
 * immutable (`supabase/migrations/agents.md` hard rule, hook-enforced), so a
 * new violation can never be smuggled into an already-listed file.
 *
 * Override: PR label `hot-table-ddl-lock-timeout-reviewed`.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OVERRIDE_LABEL = 'hot-table-ddl-lock-timeout-reviewed';
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = process.env.HOT_TABLE_DDL_LINT_REPO_ROOT ?? resolve(MODULE_DIR, '..', '..');
const MIGRATIONS_DIR = join(REPO, 'supabase', 'migrations');
const BASELINE_PATH = join(REPO, 'scripts', 'ci', 'snapshots', 'hot-table-ddl-lock-timeout-baseline.json');

/**
 * The tables whose lock queue is on the critical path for serving traffic.
 * `organizations` is read by the org/flag path, `anchors` by every verify, and
 * `profiles` by auth — a barrier on any of them stalls PostgREST introspection
 * and therefore the whole API.
 */
export const HOT_TABLES = ['organizations', 'anchors', 'profiles'] as const;
const HOT = new Set<string>(HOT_TABLES);

export interface MigrationFile {
  name: string;
  body: string;
}

export interface Violation {
  file: string;
  table: string;
  kind: string;
  line: number;
  statement: string;
}

// Postgres identifiers are bare (`anchors`) or double-quoted (`"anchors"`).
const ID = '(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)';
// Optional `public.` / `"public".` qualifier, capturing the object name.
const QUALIFIED = `(?:(?:"public"|public)\\s*\\.\\s*)?(${ID})`;

function unquote(id: string): string {
  return id.startsWith('"') && id.endsWith('"') ? id.slice(1, -1) : id;
}

/**
 * Blank out `--` line comments and `/* *\/` block comments, replacing them with
 * spaces of the SAME length so every downstream offset and line number still
 * points at the original file.
 *
 * This matters in both directions: a commented-out `ALTER TABLE` (every
 * `-- ROLLBACK:` header in this repo has one) must not be flagged, and a
 * `lock_timeout` mentioned only in prose (0359/0360 headers do exactly this)
 * must not be mistaken for an actual guard.
 */
export function stripComments(sql: string): string {
  const out = sql.split('');
  let i = 0;
  let inLine = false;
  let inBlock = 0;
  let inString: false | "'" | '"' = false;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (inLine) {
      if (c === '\n') inLine = false;
      else out[i] = ' ';
      i += 1;
      continue;
    }
    if (inBlock > 0) {
      if (c === '/' && next === '*') {
        inBlock += 1;
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
        continue;
      }
      if (c === '*' && next === '/') {
        inBlock -= 1;
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
        continue;
      }
      if (c !== '\n') out[i] = ' ';
      i += 1;
      continue;
    }
    if (inString) {
      // Doubled quote is an escape, not a terminator.
      if (c === inString && next === inString) {
        i += 2;
        continue;
      }
      if (c === inString) inString = false;
      i += 1;
      continue;
    }
    if (c === "'" || c === '"') {
      inString = c;
      i += 1;
      continue;
    }
    if (c === '-' && next === '-') {
      inLine = true;
      out[i] = ' ';
      i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlock = 1;
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

interface GuardEvent {
  index: number;
  active: boolean;
}

/** `0`, `'0'`, `0s`, `'0ms'` all mean "wait forever" — the defect, not the fix. */
function isBoundedTimeout(raw: string): boolean {
  const v = raw.trim().replace(/^'/, '').replace(/'$/, '').trim().toLowerCase();
  if (v === 'default') return false;
  const numeric = parseFloat(v);
  if (Number.isNaN(numeric)) return false;
  return numeric > 0;
}

function guardEvents(sql: string): GuardEvent[] {
  const events: GuardEvent[] = [];
  const setRe = /\bSET\s+(?:LOCAL\s+|SESSION\s+)?lock_timeout\s*(?:=|\bTO\b)\s*('[^']*'|[^\s;]+)/gi;
  for (let m = setRe.exec(sql); m !== null; m = setRe.exec(sql)) {
    events.push({ index: m.index, active: isBoundedTimeout(m[1]) });
  }
  const resetRe = /\bRESET\s+(?:lock_timeout|ALL)\b/gi;
  for (let m = resetRe.exec(sql); m !== null; m = resetRe.exec(sql)) {
    events.push({ index: m.index, active: false });
  }
  return events.sort((a, b) => a.index - b.index);
}

function guardedAt(events: GuardEvent[], index: number): boolean {
  let active = false;
  for (const e of events) {
    if (e.index >= index) break;
    active = e.active;
  }
  return active;
}

/**
 * Statement families that take a barrier-forming table-level lock. Each entry
 * captures the target relation name in group 1.
 *
 * `CREATE INDEX CONCURRENTLY` is deliberately absent — it is the *approved*
 * way to index a hot table (see `0366`) and takes no barrier-forming lock.
 * `DROP INDEX` is absent for a different reason: the statement names the index,
 * not the table, so it cannot be attributed to a hot table by text alone.
 */
const STATEMENT_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['ALTER TABLE', new RegExp(`\\bALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?${QUALIFIED}`, 'gi')],
  ['DROP TABLE', new RegExp(`\\bDROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?${QUALIFIED}`, 'gi')],
  ['TRUNCATE', new RegExp(`\\bTRUNCATE\\s+(?:TABLE\\s+)?(?:ONLY\\s+)?${QUALIFIED}`, 'gi')],
  [
    'CREATE INDEX',
    new RegExp(
      `\\bCREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?!CONCURRENTLY\\b)(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:${ID}\\s+)?ON\\s+${QUALIFIED}`,
      'gi',
    ),
  ],
  ['CREATE TRIGGER', new RegExp(`\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:CONSTRAINT\\s+)?TRIGGER\\b[^;]{0,400}?\\bON\\s+${QUALIFIED}`, 'gi')],
  ['DROP TRIGGER', new RegExp(`\\bDROP\\s+TRIGGER\\s+(?:IF\\s+EXISTS\\s+)?${ID}\\s+ON\\s+${QUALIFIED}`, 'gi')],
  ['CREATE POLICY', new RegExp(`\\bCREATE\\s+POLICY\\b[^;]{0,200}?\\bON\\s+${QUALIFIED}`, 'gi')],
  ['ALTER POLICY', new RegExp(`\\bALTER\\s+POLICY\\b[^;]{0,200}?\\bON\\s+${QUALIFIED}`, 'gi')],
  ['DROP POLICY', new RegExp(`\\bDROP\\s+POLICY\\b[^;]{0,200}?\\bON\\s+${QUALIFIED}`, 'gi')],
  // GRANT/REVOKE on a *table* takes a table-level lock that shares the same
  // FIFO queue. `ON FUNCTION ...` cannot false-positive here: the captured
  // identifier would be `FUNCTION`, which is not a hot table.
  ['GRANT/REVOKE', new RegExp(`\\b(?:GRANT|REVOKE)\\b[^;]{0,200}?\\bON\\s+(?:TABLE\\s+)?${QUALIFIED}\\b`, 'gi')],
];

export function scanFiles(files: MigrationFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const f of files) {
    const sql = stripComments(f.body);
    const events = guardEvents(sql);
    const found: Violation[] = [];
    for (const [kind, pattern] of STATEMENT_PATTERNS) {
      const re = new RegExp(pattern.source, pattern.flags);
      for (let m = re.exec(sql); m !== null; m = re.exec(sql)) {
        const table = unquote(m[1]);
        if (!HOT.has(table)) continue;
        if (guardedAt(events, m.index)) continue;
        found.push({
          file: f.name,
          table,
          kind,
          line: sql.slice(0, m.index).split('\n').length,
          statement: m[0].replace(/\s+/g, ' ').trim().slice(0, 120),
        });
      }
    }
    // Deterministic, human-readable order: source order within the file.
    found.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind));
    violations.push(...found);
  }
  return violations;
}

function loadBaseline(): Set<string> {
  if (!existsSync(BASELINE_PATH)) return new Set();
  const raw = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as { grandfathered: string[] };
  return new Set(raw.grandfathered);
}

function main(): void {
  const prLabels = (process.env.PR_LABELS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (prLabels.includes(OVERRIDE_LABEL)) {
    console.log(`[hot-table-ddl-lock-timeout] override label "${OVERRIDE_LABEL}" present — skipping.`);
    return;
  }
  if (!existsSync(MIGRATIONS_DIR)) {
    console.log('[hot-table-ddl-lock-timeout] no supabase/migrations directory — nothing to check.');
    return;
  }
  const baseline = loadBaseline();
  const files: MigrationFile[] = readdirSync(MIGRATIONS_DIR)
    .filter((n) => n.endsWith('.sql'))
    .sort()
    .map((n) => ({ name: `supabase/migrations/${n}`, body: readFileSync(join(MIGRATIONS_DIR, n), 'utf8') }));

  const all = scanFiles(files);
  const live = all.filter((v) => !baseline.has(v.file));

  if (live.length === 0) {
    console.log(
      `[hot-table-ddl-lock-timeout] OK — ${files.length} migrations scanned, ` +
        `${all.length} grandfathered violation(s) in ${baseline.size} baselined file(s), 0 new.`,
    );
    return;
  }

  console.error('\nBarrier-forming DDL on a hot table with no bounded lock_timeout:\n');
  for (const v of live) {
    console.error(`  ${v.file}:${v.line}  ${v.kind} on public.${v.table}`);
    console.error(`      ${v.statement}`);
  }
  console.error(
    '\nFix: add a bounded timeout before the statement, inside the migration transaction:\n' +
      "\n    SET LOCAL lock_timeout = '5s';\n" +
      '\nWhy: Postgres lock queues are FIFO. An unbounded DDL request that blocks on a long\n' +
      'reader becomes a barrier in front of EVERY later lock request, including PostgREST\n' +
      'schema-cache introspection — which is how the 2026-08-11 P0 took /api/v1/verify down\n' +
      'for 11m39s. With a bounded timeout the ALTER fails fast and nothing queues behind it.\n' +
      `\nDeliberate exception? Label the PR "${OVERRIDE_LABEL}".\n`,
  );
  process.exit(1);
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
