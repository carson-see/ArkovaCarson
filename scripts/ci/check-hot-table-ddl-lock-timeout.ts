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
 * ## Deferred bodies: the BUG-019 gap (2026-08 soak)
 *
 * A migration is not a flat list of statements. A `CREATE FUNCTION` body is
 * *stored* at apply time and *executed* later, from some other session — a cron
 * hit, an RPC call. So a `SET LOCAL lock_timeout` earlier in the FILE guards the
 * `CREATE FUNCTION` statement and nothing the function will ever do. Until this
 * was fixed the linter counted it anyway, which is how
 * `cleanup_expired_data()` — SECURITY DEFINER, `POST /cron/cleanup-retention`,
 * `DROP TRIGGER` -> `DELETE` -> `CREATE TRIGGER` on `audit_events` with no
 * bounded timeout anywhere — sat in the tree with a green lint. Same mechanism
 * as the P0, one level down from where the linter was looking.
 *
 * So statements are now classified:
 *
 *   - **top-level** (including `DO $$ ... $$`, which runs during the migration,
 *     in the migration's own transaction): a file-level guard genuinely covers
 *     it. Checked against `HOT_TABLES`, unchanged.
 *   - **function-body** (inside a `CREATE [OR REPLACE] FUNCTION|PROCEDURE`
 *     body): the guard must be *inside that same body*, or on the routine's own
 *     `SET lock_timeout TO '<non-zero>'` clause. Checked against the wider
 *     `RUNTIME_DDL_TABLES`.
 *
 * Guards do not cross the boundary in either direction: an in-body `SET LOCAL`
 * cannot protect a later top-level statement (the body never ran), and a
 * file-level `SET LOCAL` cannot protect a body (the file is long gone).
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

/**
 * Tables checked for DDL that a stored routine will run at RUNTIME.
 *
 * `audit_events` is here but deliberately NOT in `HOT_TABLES`. Three merged
 * migrations (0295 / 0309 / 0404) do one-shot top-level DDL on it, applied once
 * under operator supervision; widening the top-level set would buy nothing but
 * three new baseline entries, which the baseline file explicitly forbids. DDL
 * that a cron re-runs forever against a table every write path appends to is a
 * different risk, and the one BUG-019 is about.
 */
export const RUNTIME_DDL_TABLES = [...HOT_TABLES, 'audit_events'] as const;
const RUNTIME_DDL = new Set<string>(RUNTIME_DDL_TABLES);

export interface MigrationFile {
  name: string;
  body: string;
}

/** Where the statement executes — decides both the guard rule and the table set. */
export type DdlContext = 'top-level' | 'function-body';

export interface Violation {
  file: string;
  table: string;
  kind: string;
  line: number;
  statement: string;
  context: DdlContext;
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

function guardedAt(events: GuardEvent[], index: number, initiallyActive = false): boolean {
  let active = initiallyActive;
  for (const e of events) {
    if (e.index >= index) break;
    active = e.active;
  }
  return active;
}

/** A dollar-quoted block: `$$ ... $$` or `$tag$ ... $tag$`. */
interface DollarSpan {
  /** Index of the first character of the statement the block belongs to. */
  statementStart: number;
  /** Index of the first character INSIDE the block. */
  bodyStart: number;
  /** Index of the first character of the closing delimiter. */
  bodyEnd: number;
  /** Index just past the closing delimiter. */
  closeEnd: number;
  /**
   * True for `CREATE [OR REPLACE] FUNCTION|PROCEDURE ... AS $$...$$` — stored
   * now, executed later. False for `DO $$...$$` (runs during the migration) and
   * for dollar-quoted string literals in e.g. `COMMENT ON ... IS $$...$$`.
   */
  deferred: boolean;
  /** The routine's own `SET lock_timeout` clause, if it carries a bounded one. */
  headerGuard: boolean;
}

const DOLLAR_DELIM_RE = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/g;
const CREATE_ROUTINE_RE = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b/i;
const ROUTINE_SET_LOCK_TIMEOUT_RE = /\bSET\s+lock_timeout\s*(?:=|\bTO\b)\s*('[^']*'|[^\s;]+)/i;

/**
 * Locate every dollar-quoted block, in source order, without recursing into one
 * that is already open — the scan jumps past a block's closing delimiter, so a
 * `$$` sitting inside a `$fn$ ... $fn$` body is never mistaken for a delimiter.
 */
export function dollarSpans(sql: string): DollarSpan[] {
  const spans: DollarSpan[] = [];
  let cursor = 0;
  DOLLAR_DELIM_RE.lastIndex = 0;
  for (let m = DOLLAR_DELIM_RE.exec(sql); m !== null; m = DOLLAR_DELIM_RE.exec(sql)) {
    const delim = m[0];
    const openStart = m.index;
    const bodyStart = openStart + delim.length;
    const closeIdx = sql.indexOf(delim, bodyStart);
    // Unterminated block: everything after it is one opaque region. Bail rather
    // than guess — a truncated file should not silently disable the check.
    if (closeIdx === -1) break;

    // The statement this block belongs to starts after the previous `;` that is
    // outside any block. `cursor` already sits past the previous block, so a
    // semicolon inside an earlier function body can never be picked up here.
    const preceding = sql.slice(cursor, openStart);
    const statementStart = cursor + preceding.lastIndexOf(';') + 1;
    const head = sql.slice(statementStart, openStart);
    const routineSet = ROUTINE_SET_LOCK_TIMEOUT_RE.exec(head);

    spans.push({
      statementStart,
      bodyStart,
      bodyEnd: closeIdx,
      closeEnd: closeIdx + delim.length,
      deferred: CREATE_ROUTINE_RE.test(head),
      headerGuard: routineSet !== null && isBoundedTimeout(routineSet[1]),
    });

    cursor = closeIdx + delim.length;
    DOLLAR_DELIM_RE.lastIndex = cursor;
  }
  return spans;
}

function deferredSpanAt(spans: DollarSpan[], index: number): DollarSpan | undefined {
  return spans.find((s) => s.deferred && index >= s.bodyStart && index < s.bodyEnd);
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
  // Adding a FOREIGN KEY takes ShareRowExclusiveLock on the REFERENCED table
  // (Postgres installs the FK's internal validation triggers on both sides).
  // So `CREATE TABLE cold_t (... REFERENCES organizations ...)` — or an
  // `ALTER TABLE cold_t ADD CONSTRAINT ... REFERENCES organizations` — queues
  // on the HOT table's FIFO lock queue exactly like DDL on the hot table
  // itself, even though the statement's target relation is cold. Every other
  // pattern in this table looks at the statement's target; this one looks at
  // the referenced side. Gap found live: migration 0410 (PR #2219) carried TWO
  // FKs to public.organizations with zero lock_timeout and passed this gate
  // green.
  ['REFERENCES', new RegExp(`\\bREFERENCES\\s+${QUALIFIED}`, 'gi')],
];

export function scanFiles(files: MigrationFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const f of files) {
    const sql = stripComments(f.body);
    const spans = dollarSpans(sql);
    const allEvents = guardEvents(sql);

    // A deferred routine's whole `CREATE FUNCTION ... AS $$ ... $$` statement is
    // invisible to the migration's own timeline: neither its `SET` clause nor
    // anything in its body executes at apply time. Drop those events from the
    // top-level stream so they cannot fake a guard for a later statement.
    const topLevelEvents = allEvents.filter(
      (e) => !spans.some((s) => s.deferred && e.index >= s.statementStart && e.index < s.closeEnd),
    );

    const found: Violation[] = [];
    for (const [kind, pattern] of STATEMENT_PATTERNS) {
      const re = new RegExp(pattern.source, pattern.flags);
      for (let m = re.exec(sql); m !== null; m = re.exec(sql)) {
        const table = unquote(m[1]);
        const span = deferredSpanAt(spans, m.index);

        if (span) {
          if (!RUNTIME_DDL.has(table)) continue;
          // Only guards set inside this body count, seeded by the routine's own
          // `SET lock_timeout` clause when it carries a bounded value.
          const bodyEvents = allEvents.filter(
            (e) => e.index >= span.bodyStart && e.index < span.bodyEnd,
          );
          if (guardedAt(bodyEvents, m.index, span.headerGuard)) continue;
        } else {
          if (!HOT.has(table)) continue;
          if (guardedAt(topLevelEvents, m.index)) continue;
        }

        found.push({
          file: f.name,
          table,
          kind,
          line: sql.slice(0, m.index).split('\n').length,
          statement: m[0].replace(/\s+/g, ' ').trim().slice(0, 120),
          context: span ? 'function-body' : 'top-level',
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

  console.error('\nBarrier-forming DDL with no bounded lock_timeout:\n');
  for (const v of live) {
    console.error(`  ${v.file}:${v.line}  ${v.kind} on public.${v.table}  [${v.context}]`);
    console.error(`      ${v.statement}`);
  }
  console.error(
    '\nFix (top-level): add a bounded timeout before the statement, inside the migration\n' +
      'transaction:\n' +
      "\n    SET LOCAL lock_timeout = '5s';\n" +
      '\nFix (function-body): the guard must be INSIDE the routine — a file-level SET does not\n' +
      'survive to the cron session that calls it. Either add the SET LOCAL as the first\n' +
      'statement of the body, or put it on the routine itself:\n' +
      "\n    CREATE OR REPLACE FUNCTION ... SET lock_timeout TO '5s' AS $$ ... $$;\n" +
      '\nWhy: Postgres lock queues are FIFO. An unbounded DDL request that blocks on a long\n' +
      'reader becomes a barrier in front of EVERY later lock request, including PostgREST\n' +
      'schema-cache introspection — which is how the 2026-08-11 P0 took /api/v1/verify down\n' +
      'for 11m39s. With a bounded timeout the statement fails fast and nothing queues behind\n' +
      'it. A stored routine re-runs that risk on every cron tick, unsupervised.\n' +
      `\nDeliberate exception? Label the PR "${OVERRIDE_LABEL}".\n`,
  );
  process.exit(1);
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
